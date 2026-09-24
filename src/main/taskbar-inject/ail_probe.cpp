// ail_probe.cpp —— 最小注入探针 DLL
//
// 目的：只回答一个问题 —— DLL 能不能被送进 ShellExperienceHost.exe（Low IL + AppContainer）。
//
// 特意做得极简：
//   · DllMain 只做 DisableThreadLibraryCalls，不建线程、不连管道、不阻塞
//     （上一个用 taskbarInject.dll 试的时候远端 LoadLibraryW 8 秒都没返回，
//       就是被它 DllMain 里的东西卡住了 —— 那样测不出"能不能加载"）
//   · 额外导出一个 AilProbePing，方便外部用 GetProcAddress 佐证模块真的在
//
// 编译（MinGW，必须 -static，否则会拖一堆 mingw 运行时 DLL）：
//   gcc -shared -static -O2 -o ail_probe.dll ail_probe.cpp -Wl,--kill-at
#include <windows.h>

extern "C" __declspec(dllexport) unsigned long __stdcall AilProbePing(void)
{
    return 0x414C494Cu;   // 'AILC'
}

BOOL WINAPI DllMain(HINSTANCE hinst, DWORD reason, LPVOID reserved)
{
    (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(hinst);
    }
    return TRUE;
}
