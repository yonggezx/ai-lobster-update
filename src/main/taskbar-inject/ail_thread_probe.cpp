// ail_thread_probe.cpp —— 判定 AppContainer 宿主里「DllMain 里起的线程到底跑不跑」
//
// 背景：把 aiLobsterTap.dll 注入 ShellExperienceHost 后，模块确实加载了
// （模块枚举能查到），但它的管道从来没出现、日志也一行没写。怀疑是
// "DllMain 里 CreateThread 出来的线程在这个宿主里根本没被调度"。
//
// 做法：DllMain 里同时做三件事，各自留下**独立可查的痕迹**：
//   1) 直接在 DllMain 里建一个命名管道  AilTP_main_p<pid>      → 外部枚举 \\.\pipe\ 就能看到
//   2) 直接在 DllMain 里写一个文件      dllmain.txt（DLL 同目录）
//   3) CreateThread 一个线程，线程里建管道 AilTP_thr_p<pid> + 写线程文件 thread.txt
// 于是四种结果都能区分：
//   · 两个管道都在 → 一切正常（那问题在别处）
//   · 只有 _main_p 在 → **线程没被调度**（这就是根因）
//   · 一个都没有    → 管道创建/文件写在 AppContainer 里被拒（换思路）
//
// 编译：gcc -shared -static -O2 -o ail_thread_probe.dll ail_thread_probe.cpp -Wl,--kill-at
#include <windows.h>

static HMODULE g_self = NULL;

static void WriteMarker(const wchar_t* name, const char* what)
{
    // 写到本 DLL 所在目录（客户端会把它放在包目录里，那是 AppContainer 读得到的地方）
    wchar_t path[MAX_PATH] = {0};
    GetModuleFileNameW(g_self, path, MAX_PATH);
    wchar_t* slash = wcsrchr(path, L'\\');
    if (slash) *(slash + 1) = 0;
    wcsncat(path, name, MAX_PATH - wcslen(path) - 1);

    HANDLE f = CreateFileW(path, GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                           NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (f == INVALID_HANDLE_VALUE) return;
    DWORD wrote = 0;
    WriteFile(f, what, (DWORD)lstrlenA(what), &wrote, NULL);
    CloseHandle(f);
}

static void MakePipe(const wchar_t* name, const char* tag)
{
    wchar_t full[256];
    wsprintfW(full, L"\\\\.\\pipe\\AilTP_%s_p%lu", name, (unsigned long)GetCurrentProcessId());
    HANDLE h = CreateNamedPipeW(full, PIPE_ACCESS_DUPLEX,
                               PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT,
                               2, 512, 512, 0, NULL);
    char buf[128];
    wsprintfA(buf, "%s pipe=%s err=%lu", tag,
              (h == INVALID_HANDLE_VALUE) ? "FAIL" : "OK", GetLastError());
    WriteMarker(L"ail_thread_probe.txt", buf);
}

static DWORD WINAPI Worker(LPVOID)
{
    WriteMarker(L"ail_probe_thread.txt", "thread ran");
    MakePipe(L"thr", "thread");
    return 0;
}

BOOL WINAPI DllMain(HINSTANCE hinst, DWORD reason, LPVOID)
{
    if (reason == DLL_PROCESS_ATTACH) {
        g_self = hinst;
        DisableThreadLibraryCalls(hinst);

        // ① DllMain 里直接做
        WriteMarker(L"ail_probe_dllmain.txt", "dllmain ran");
        MakePipe(L"main", "dllmain");

        // ② DllMain 里起线程（关键：这条线程在宿主里会不会被调度？）
        HANDLE t = CreateThread(NULL, 0, Worker, NULL, 0, NULL);
        if (t) {
            // 不 Wait、不 Close（避免在 loader lock 里做多余动作）
            WriteMarker(L"ail_probe_dllmain.txt", "thread created ok");
        } else {
            WriteMarker(L"ail_probe_dllmain.txt", "CreateThread FAILED");
        }
    }
    return TRUE;
}
