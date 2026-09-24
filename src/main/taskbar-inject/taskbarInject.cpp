/**
 * 任务栏外观 · Explorer 内工作模块（注入 explorer.exe）
 *
 * 设计原则（2026-09-12 重写）：
 *   1. 只做一件事 —— detour `user32!SetWindowCompositionAttribute`，在 shell **自己**给任务栏
 *      设置合成属性时改写参数。参考 TranslucentTB 的 ExplorerHooks/swcadetour.cpp。
 *      进程外调用实测会被 shell 重绘冲掉（见 .workbuddy/memory/2026-09-12.md），所以必须在进程内。
 *   2. **绝不** hook GDI/uxtheme 绘制函数（FillRect / BitBlt / DrawThemeBackground）——
 *      那是全局生效的，会把桌面、资源管理器窗口、菜单的绘制一起吞掉，制造黑块与花屏。
 *   3. **绝不**子类化任何窗口（包括误命中无关 UWP 窗口的 CoreWindow）。
 *   4. 不在 DllMain 里做重活（MinHook 初始化/建线程全部放到工作线程里，避开 loader lock）。
 *   5. 默认「观测模式」：只透传 + 统计 explorer 到底用什么参数画任务栏，不改变任何外观。
 *      必须显式发 `APPLY:<effect>` 才进入改写模式。
 *   6. 日志只写到 %TEMP%，且默认关闭（`OBSERVE:on` 才开），不再硬编码桌面路径。
 *
 * 命名管道协议（单行 ASCII，命令 → 单行响应）：
 *   PING                      → PONG
 *   GET                       → <effect>           当前生效效果（0=不改写）
 *   OBSERVE:on|off            → OK                 开/关观测统计
 *   RESET                     → OK                 清空统计
 *   LOG                       → OK / 若干行 <count>|<class>|<state>|<flags>|<color>|<cbData>
 *   APPLY:<0..5>[:<flags>[:<colorABGR>]] → OK      进入改写模式（0=恢复透传）
 *   UNINSTALL                 → OK                 摘掉 detour + 恢复系统默认外观（DLL 仍驻留）
 *   UNLOAD                    → BYE                MH_Uninitialize + FreeLibraryAndExitThread
 */

#include <windows.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <stdarg.h>
#include "MinHook.h"

// ============================================================
// 日志（仅写入 %TEMP%，且默认关闭）
// ============================================================
static volatile LONG g_logEnabled = 1;   // 默认开：日志只写 %TEMP%\ai_lobster_taskbar.log（钩子路径内已不做任何 I/O）
static char g_logPath[MAX_PATH] = {0};

static void LogInitPath() {
    char tmp[MAX_PATH] = {0};
    DWORD n = GetTempPathA(MAX_PATH, tmp);
    if (n > 0 && n < MAX_PATH) {
        snprintf(g_logPath, MAX_PATH, "%sai_lobster_taskbar.log", tmp);
    }
}

static void Log(const char* fmt, ...) {
    if (!g_logEnabled || !g_logPath[0]) return;
    FILE* f = fopen(g_logPath, "a");
    if (!f) return;
    SYSTEMTIME st;
    GetLocalTime(&st);
    fprintf(f, "[%02d:%02d:%02d.%03d][tid %lu] ", st.wHour, st.wMinute, st.wSecond,
            st.wMilliseconds, GetCurrentThreadId());
    va_list ap;
    va_start(ap, fmt);
    vfprintf(f, fmt, ap);
    va_end(ap);
    fputc('\n', f);
    fclose(f);
}

// ============================================================
// 未公开 API：SetWindowCompositionAttribute
// ============================================================
typedef struct _ACCENT_POLICY {
    DWORD AccentState;
    DWORD AccentFlags;
    DWORD GradientColor;   // ABGR: 0xAABBGGRR
    DWORD AnimationId;
} ACCENT_POLICY;

typedef struct _WINDOWCOMPOSITIONATTRIBDATA {
    DWORD Attrib;
    PVOID pvData;
    SIZE_T cbData;
} WINDOWCOMPOSITIONATTRIBDATA;

typedef BOOL(WINAPI* PFN_SCA)(HWND, const WINDOWCOMPOSITIONATTRIBDATA*);

#define WCA_ACCENT_POLICY 19

#define ACCENT_DISABLED               0
#define ACCENT_ENABLE_GRADIENT        1
#define ACCENT_ENABLE_TRANSPARENT     2
#define ACCENT_ENABLE_BLURBEHIND      3
#define ACCENT_ENABLE_ACRYLIC         4
#define ACCENT_ENABLE_HOSTBACKDROP    5

// ============================================================
// 全局状态
// ============================================================
static HMODULE g_hModule = NULL;
static PFN_SCA g_pOriginalSCA = NULL;
static HANDLE g_hWorker = NULL;
static volatile LONG g_running = FALSE;

static volatile LONG g_hookInstalled = 0;     // detour 是否已挂上
static volatile LONG g_observe = 0;           // 观测统计开关
static volatile LONG g_rewriteCount = 0;      // 已在 hook 内改写任务栏 accent 的次数（只计数，不做 I/O）
static volatile LONG g_wantUnload = 0;        // 请求卸载：命令处理器置位，工作线程收尾后再卸载

// 改写模式：0 = 透传（不改任何参数）；非 0 = 用下面这组参数覆盖任务栏的 accent
static volatile LONG g_applyEffect = 0;
static volatile LONG g_applyFlags = 2;
static volatile LONG g_applyColor = 0;        // ABGR

// 观测统计：按 (class,state,flags,color) 归类计数
#define MAX_SIG 48
struct Signature {
    char className[64];
    DWORD attrib;
    DWORD state;
    DWORD flags;
    DWORD color;
    DWORD cbData;
    LONG count;
    BOOL onTaskbar;
};
static Signature g_sigs[MAX_SIG];
static volatile LONG g_sigCount = 0;
static volatile LONG g_totalCalls = 0;

// ============================================================
// 工具
// ============================================================
static BOOL IsTaskbarWindow(HWND hwnd) {
    if (!hwnd) return FALSE;
    wchar_t cls[64] = {0};
    if (GetClassNameW(hwnd, cls, 63) == 0) return FALSE;
    return (wcscmp(cls, L"Shell_TrayWnd") == 0) || (wcscmp(cls, L"Shell_SecondaryTrayWnd") == 0);
}

static HWND FindTray() { return FindWindowW(L"Shell_TrayWnd", NULL); }

struct EnumCtx { HWND first; int count; };
static BOOL CALLBACK EnumSecondaryProc(HWND hwnd, LPARAM lp) {
    wchar_t cls[64] = {0};
    GetClassNameW(hwnd, cls, 63);
    if (wcscmp(cls, L"Shell_SecondaryTrayWnd") == 0) {
        EnumCtx* c = (EnumCtx*)lp;
        if (!c->first) c->first = hwnd;
        c->count++;
    }
    return TRUE;
}

// ============================================================
// 观测记录
// ============================================================
static void RecordSignature(HWND hwnd, const WINDOWCOMPOSITIONATTRIBDATA* d, BOOL onTaskbar) {
    if (!g_observe || !d) return;
    InterlockedIncrement(&g_totalCalls);

    const ACCENT_POLICY* p = NULL;
    DWORD state = 0, flags = 0, color = 0;
    if (d->Attrib == WCA_ACCENT_POLICY && d->pvData && d->cbData >= sizeof(ACCENT_POLICY)) {
        p = (const ACCENT_POLICY*)d->pvData;
        state = p->AccentState;
        flags = p->AccentFlags;
        color = p->GradientColor;
    }

    char cls[64] = {0};
    GetClassNameA(hwnd, cls, 63);
    if (!cls[0]) snprintf(cls, 64, "%s", "<none>");

    LONG n = g_sigCount;
    for (LONG i = 0; i < n && i < MAX_SIG; i++) {
        if (g_sigs[i].attrib == d->Attrib && g_sigs[i].state == state &&
            g_sigs[i].flags == flags && g_sigs[i].color == color &&
            g_sigs[i].cbData == (DWORD)d->cbData && strcmp(g_sigs[i].className, cls) == 0) {
            InterlockedIncrement(&g_sigs[i].count);
            return;
        }
    }
    LONG slot = InterlockedIncrement(&g_sigCount) - 1;
    if (slot >= MAX_SIG) return;   // 表满则只计数不新增
    snprintf(g_sigs[slot].className, 64, "%s", cls);
    g_sigs[slot].attrib = d->Attrib;
    g_sigs[slot].state = state;
    g_sigs[slot].flags = flags;
    g_sigs[slot].color = color;
    g_sigs[slot].cbData = (DWORD)d->cbData;
    g_sigs[slot].count = 1;
    g_sigs[slot].onTaskbar = onTaskbar;
}

// ============================================================
// detour：SetWindowCompositionAttribute
//   · 透传为默认；只有显式 APPLY 后才改写**任务栏窗口**上的 accent 参数
//   · 不改写调用方传入的 pvData（可能在只读段），改用线程局部缓冲
// ============================================================
static BOOL WINAPI HookedSCA(HWND hwnd, const WINDOWCOMPOSITIONATTRIBDATA* d) {
    if (!g_pOriginalSCA) return FALSE;
    if (!d) return g_pOriginalSCA(hwnd, d);

    BOOL onTaskbar = IsTaskbarWindow(hwnd);
    RecordSignature(hwnd, d, onTaskbar);

    LONG effect = g_applyEffect;
    if (effect == 0 || !onTaskbar) {
        return g_pOriginalSCA(hwnd, d);            // 透传
    }
    if (d->Attrib != WCA_ACCENT_POLICY || d->cbData != sizeof(ACCENT_POLICY) || !d->pvData) {
        return g_pOriginalSCA(hwnd, d);
    }

    // 用我们自己的策略覆盖 shell 本次的设置。
    // 注意：缓冲放**栈上**而不是 static/TLS —— 它只在下面这次同步调用期间需要有效，
    // 放栈上既无跨线程竞争，也不依赖 MinGW 的 __declspec(thread)（g++ 会忽略该属性）。
    ACCENT_POLICY policy;
    policy.AccentState = (DWORD)effect;
    policy.AccentFlags = (DWORD)g_applyFlags;
    policy.GradientColor = (DWORD)g_applyColor;
    policy.AnimationId = 0;

    WINDOWCOMPOSITIONATTRIBDATA nd = *d;
    nd.pvData = &policy;
    // 只计数，**绝不在这里写文件/打日志** —— 本函数运行在 shell 自己的线程（含 UI 线程）上，
    // 任何阻塞式 I/O 都可能造成重入/卡死。统计值由管道线程通过 LOG 命令取走。
    InterlockedIncrement(&g_rewriteCount);
    return g_pOriginalSCA(hwnd, &nd);
}

// ============================================================
// 安装 / 卸载 detour
// ============================================================
static BOOL InstallDetour() {
    if (InterlockedCompareExchange(&g_hookInstalled, 1, 0) == 1) return TRUE;

    MH_STATUS s = MH_Initialize();
    if (s != MH_OK && s != MH_ERROR_ALREADY_INITIALIZED) {
        Log("MH_Initialize 失败: %d", s);
        InterlockedExchange(&g_hookInstalled, 0);
        return FALSE;
    }

    HMODULE u32 = GetModuleHandleW(L"user32.dll");
    if (!u32) { Log("拿不到 user32.dll"); InterlockedExchange(&g_hookInstalled, 0); return FALSE; }

    FARPROC target = GetProcAddress(u32, "SetWindowCompositionAttribute");
    if (!target) {
        Log("user32!SetWindowCompositionAttribute 不存在");
        InterlockedExchange(&g_hookInstalled, 0);
        return FALSE;
    }

    s = MH_CreateHook((LPVOID)target, (LPVOID)&HookedSCA, (LPVOID*)&g_pOriginalSCA);
    if (s != MH_OK && s != MH_ERROR_ALREADY_CREATED) {
        Log("MH_CreateHook 失败: %d", s);
        InterlockedExchange(&g_hookInstalled, 0);
        return FALSE;
    }
    s = MH_EnableHook((LPVOID)target);
    if (s != MH_OK) {
        Log("MH_EnableHook 失败: %d", s);
        InterlockedExchange(&g_hookInstalled, 0);
        return FALSE;
    }
    Log("detour 已安装（SetWindowCompositionAttribute）");
    return TRUE;
}

static void RemoveDetour() {
    if (InterlockedCompareExchange(&g_hookInstalled, 0, 1) != 1) return;
    HMODULE u32 = GetModuleHandleW(L"user32.dll");
    if (u32) {
        FARPROC target = GetProcAddress(u32, "SetWindowCompositionAttribute");
        if (target) MH_DisableHook((LPVOID)target);
    }
    Log("detour 已摘除");
}

// ============================================================
// 用（原始）SCA 直接给任务栏设一次 —— 进入/退出改写模式时立刻见效
// ============================================================
// ============================================================
// 让 shell **自己**重新应用一次任务栏外观
//   · 我们绝不在自己的线程上直接调 SetWindowCompositionAttribute ——
//     实测从工作线程对别的线程的窗口调 SCA 会把工作线程卡死（见 memory/2026-09-12.md）。
//   · 正确做法（也是 TranslucentTB 的做法）：只改写 hook 里的参数，然后发消息让 shell
//     自己重新走一遍流程，由 shell 的线程去调 SCA，我们的 detour 在那里把参数换掉。
//   · 用 SendMessageTimeout + SMTO_ABORTIFHUNG，避免 shell 万一卡住时把我们自己拖死。
//     注意：WM_DWMCOMPOSITIONCHANGED(0x031E) 由 windows.h 提供，无需自定义。
// ============================================================
static void NudgeShell() {
    HWND t = FindTray();
    if (t) {
        SendMessageTimeoutW(t, WM_DWMCOMPOSITIONCHANGED, 1, 0,
                            SMTO_ABORTIFHUNG | SMTO_NORMAL, 1000, NULL);
    }
    EnumCtx c = {0, 0};
    EnumWindows(EnumSecondaryProc, (LPARAM)&c);
    if (c.first) {
        SendMessageTimeoutW(c.first, WM_DWMCOMPOSITIONCHANGED, 1, 0,
                            SMTO_ABORTIFHUNG | SMTO_NORMAL, 1000, NULL);
    }
}

static void RestoreTaskbar() {
    // 退出改写模式 → 再让 shell 重新应用一次，它就会回到系统默认外观
    InterlockedExchange(&g_applyEffect, 0);
    NudgeShell();
    Log("已恢复任务栏默认外观（透传）");
}

// ============================================================
// 命名管道
// ============================================================
// 管道名**每次装载都唯一**（前缀 + explorer pid + 装载时刻）。
// 理由：命名管道的实例数与安全属性都挂在**名字**上。一旦有历史遗留实例占着同名，
//   新实例可能直接建不出来（实测 err=5 ACCESS_DENIED），
//   或者客户端连到那个"僵尸实例"上永远等不到应答。
// 唯一化之后这两个坑都不存在；客户端靠枚举 \\.\pipe\ 下前缀来发现当前活着的那个。
#define PIPE_PREFIX "\\\\.\\pipe\\AI_Lobster_Taskbar_"
static char g_pipeName[160] = {0};

static BOOL CreatePipeSecured(HANDLE* out) {
    // 安全策略（踩坑记录）：
    //   · PIPE_REJECT_REMOTE_CLIENTS —— 只允许本机客户端，拒绝远程。
    //   · 安全描述符传 NULL —— 用进程令牌的**默认 DACL**（通常只含当前用户 + SYSTEM），
    //     本机同用户即可连接，正是我们要的效果。
    //   不要自己拼 SDDL：
    //     "OW" 是 Owner Rights(S-1-3-4)，任何令牌都不含该 SID；
    //     带 CO 的 DACL 在本机实测会让客户端 connect 直接失败 EPERM(5)。
    //   · FILE_FLAG_FIRST_PIPE_INSTANCE + 单实例 —— 保证全局只有一个实例，
    //     客户端连上去一定是我们这个服务端，不会出现"连到僵尸实例上干等"的抽签问题；
    //     若名字真被占用，CreateNamedPipe 会直接失败（日志可见），而不是悄悄踩坑。
    HANDLE h = CreateNamedPipeA(
        g_pipeName,
        PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
        PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
        1,
        4096, 4096, 1000, NULL);
    *out = h;
    return h != INVALID_HANDLE_VALUE;
}

static void WriteLine(HANDLE pipe, const char* s) {
    DWORD w = 0;
    WriteFile(pipe, s, (DWORD)strlen(s), &w, NULL);
}

// 返回 0 = 继续服务；1 = 请求卸载（由工作线程收尾后再 FreeLibraryAndExitThread）
static int HandleCommand(const char* cmd, HANDLE pipe) {
    if (strcmp(cmd, "PING") == 0) { WriteLine(pipe, "PONG"); return 0; }
    if (strcmp(cmd, "GET") == 0) {
        char b[32];
        snprintf(b, 32, "%ld", g_applyEffect);
        WriteLine(pipe, b);
        return 0;
    }
    if (strcmp(cmd, "OBSERVE:on") == 0) { InterlockedExchange(&g_observe, 1); InterlockedExchange(&g_logEnabled, 1); WriteLine(pipe, "OK"); return 0; }
    if (strcmp(cmd, "OBSERVE:off") == 0) { InterlockedExchange(&g_observe, 0); WriteLine(pipe, "OK"); return 0; }
    if (strcmp(cmd, "LOG:off") == 0) { InterlockedExchange(&g_logEnabled, 0); WriteLine(pipe, "OK"); return 0; }
    if (strcmp(cmd, "RESET") == 0) {
        for (int i = 0; i < g_sigCount && i < MAX_SIG; i++) g_sigs[i].count = 0;
        InterlockedExchange(&g_sigCount, 0);
        InterlockedExchange(&g_totalCalls, 0);
        WriteLine(pipe, "OK");
        return 0;
    }
    if (strcmp(cmd, "LOG") == 0) {
        char b[512];
        snprintf(b, 512, "TOTAL %ld", g_totalCalls);
        WriteLine(pipe, b);
        WriteLine(pipe, "\n");
        snprintf(b, 512, "REWRITES %ld", g_rewriteCount);
        WriteLine(pipe, b);
        WriteLine(pipe, "\n");
        LONG n = g_sigCount;
        for (LONG i = 0; i < n && i < MAX_SIG; i++) {
            if (g_sigs[i].count == 0 && g_sigs[i].className[0] == 0) continue;
            snprintf(b, 512, "%ld|%s|%lu|%lu|0x%08lx|%lu|%s",
                        g_sigs[i].count, g_sigs[i].className, g_sigs[i].state,
                        g_sigs[i].flags, g_sigs[i].color, g_sigs[i].cbData,
                        g_sigs[i].onTaskbar ? "TASKBAR" : "-");
            WriteLine(pipe, b);
            WriteLine(pipe, "\n");
        }
        return 0;
    }
    if (strncmp(cmd, "APPLY:", 6) == 0) {
        int v = atoi(cmd + 6);
        if (v < 0 || v > 5) { WriteLine(pipe, "ERR range"); return 0; }
        const char* p = strchr(cmd + 6, ':');
        LONG flags = 2, color = 0;
        if (p) {
            flags = atoi(p + 1);
            const char* q = strchr(p + 1, ':');
            if (q) color = (LONG)strtoul(q + 1, NULL, 0);
        }
        InterlockedExchange(&g_applyFlags, flags);
        InterlockedExchange(&g_applyColor, color);
        InterlockedExchange(&g_applyEffect, v);   // 先落参数，再戳 shell
        NudgeShell();
        Log("APPLY effect=%d flags=%ld color=0x%08lx", v, flags, color);
        WriteLine(pipe, "OK");
        return 0;
    }
    if (strcmp(cmd, "UNINSTALL") == 0) { RestoreTaskbar(); RemoveDetour(); WriteLine(pipe, "OK"); return 0; }
    if (strcmp(cmd, "UNLOAD") == 0) {
        // 只置标志；管道清理 + MH_Uninitialize + FreeLibraryAndExitThread 全部交给工作线程，
        // 确保先关掉管道句柄再卸载模块（否则泄漏的管道实例会占住名字）。
        RestoreTaskbar();
        RemoveDetour();
        WriteLine(pipe, "BYE");
        // 关键：写完先等一下再断开管道。
        // 否则紧接着 DisconnectNamedPipe/CloseHandle 会把客户端还没读走的数据丢掉，
        // 客户端那边只看到连接中断(EPIPE)，读不到 "BYE"。
        Sleep(200);
        InterlockedExchange(&g_wantUnload, 1);
        return 1;
    }
    WriteLine(pipe, "ERR unknown");
    return 0;
}

static DWORD WINAPI WorkerThread(LPVOID) {
    LogInitPath();

    // 唯一管道名：前缀 + pid + 装载时刻
    snprintf(g_pipeName, sizeof(g_pipeName), PIPE_PREFIX "p%lu_t%llu",
             (unsigned long)GetCurrentProcessId(), (unsigned long long)GetTickCount64());

    Log("worker 启动");
    Log("管道名: %s", g_pipeName);

    // 重活都在这里做，不在 DllMain 里
    if (!InstallDetour()) Log("detour 安装失败，DLL 为空转状态");

    while (g_running) {
        HANDLE pipe = INVALID_HANDLE_VALUE;
        if (!CreatePipeSecured(&pipe)) {
            static BOOL loggedFail = FALSE;
            if (!loggedFail) { Log("建管道失败 err=%lu", GetLastError()); loggedFail = TRUE; }
            Sleep(500);
            continue;
        }
        {
            static BOOL loggedOk = FALSE;
            if (!loggedOk) { Log("管道已就绪: %s", g_pipeName); loggedOk = TRUE; }
        }

        BOOL ok = ConnectNamedPipe(pipe, NULL) || GetLastError() == ERROR_PIPE_CONNECTED;
        if (ok) {
            char buf[512];
            DWORD read = 0;
            while (g_running && ReadFile(pipe, buf, sizeof(buf) - 1, &read, NULL)) {
                if (read == 0) continue;
                buf[read] = '\0';
                while (read > 0 && (buf[read - 1] == '\n' || buf[read - 1] == '\r')) buf[--read] = '\0';
                Log("命令: %s", buf);
                if (HandleCommand(buf, pipe) != 0) break;   // 请求卸载 → 先跳出读循环
            }
            FlushFileBuffers(pipe);
            DisconnectNamedPipe(pipe);
        }
        CloseHandle(pipe);                                  // 关键：先关掉管道，再卸载模块
        if (InterlockedCompareExchange(&g_wantUnload, 0, 0)) break;
    }

    Log("worker 退出");
    // 卸载路径：到这里管道已关闭、detour 已摘除，可以安全卸载自己
    if (InterlockedCompareExchange(&g_wantUnload, 0, 0)) {
        MH_Uninitialize();
        InterlockedExchange(&g_running, FALSE);
        HMODULE self = g_hModule;
        FreeLibraryAndExitThread(self, 0);
    }
    return 0;
}

// ============================================================
// DLL 入口 —— 只做最轻的事
// ============================================================
BOOL APIENTRY DllMain(HMODULE hModule, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        g_hModule = hModule;
        DisableThreadLibraryCalls(hModule);
        g_running = TRUE;
        g_hWorker = CreateThread(NULL, 0, WorkerThread, NULL, 0, NULL);
        if (!g_hWorker) {
            g_running = FALSE;
            return FALSE;
        }
    } else if (reason == DLL_PROCESS_DETACH) {
        // 进程正在退出：不做重活（loader lock），只把状态清掉
        g_running = FALSE;
        if (g_hWorker) { CloseHandle(g_hWorker); g_hWorker = NULL; }
    }
    return TRUE;
}
