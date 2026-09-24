/**
 * 任务栏外�?· XAML TAP 观测模块（Phase B / M1�? * 注入 explorer.exe，通过 XAML 诊断附着到视觉树�?*只记录、绝不修改任何外�?*�? *
 * 设计依据（TranslucentTB 上游源码逐字核对，见 docs/任务�?PhaseB-可行性报�?md）：
 *   1. `InitializeXamlDiagnosticsEx` 每个线程只能初始化一�?—�?重复调用只返�?S_OK 但什么都不做�? *      所以每次重�?*必须开新线�?*
 *   2. explorer �?XAML 可能还没起来，所以要 60 × 500ms 重试（最�?30s）�? *      这就�?注入后无需重启 explorer"的原因
 *   3. XAML 会加载本 DLL 作为 in-proc COM 服务器，调用 `DllGetClassObject(CLSID, IID_IClassFactory)`
 *      �?我们
 *      �?我们IClassFactory 造出 TapSite �?XAML �?`IObjectWithSite::SetSite(IXamlDiagnostics)`�? *      不需要注册表注册：XAML 直接拿到�?DLL 路径
 *   4. `AdviseVisualTreeChange` 必须从独立线程调用；回调会被 XAML 特地带到 UI 线程
 *   5. 加载的模块路径必须与传给 `InitializeXamlDiagnosticsEx` 的路径一致�? *
 * M1 安全措施�? *   · 不注册任�?hook，不调用 `SetWindowCompositionAttribute`，不碰任�?XAML 属性�? *   · 回调里只做字符串拷贝 + 计数�?*绝不写文�?*（回调跑�?XAML UI 线程上）�? *   · **不释�?XAML 交回
 * M1 安全措施�? *   · 不注册任�?hook，不调用 `SetWindowCompositionAttribute`，不碰任�?XAML 属性�? *   · 回调里只做字符串拷贝 + 计数�?*绝不写文�?*（回调跑�?XAML UI 线程上）�? *   · **不释�?XAML 交回BSTR**。上游用 `unique_bstr` 接管并释放，但那属于"信任上游"�? *     对我们而言"不释�?在两种所有权模型下都安全（最多是一次性短期观测的内存占用）�? *     �?M2 确认行为后再决定是否 `SysFreeString`�? *
 * 命名管道协议（单�?ASCII 命令 �?单行/多行响应）：
 *   PING      �?PONG
 *   STATUS    �?S|state|attempts|lastHr|adviseHr|advised|events|frames|fills|strokes|recs
 *               S2|frame|fill|stroke|frameSeen|qState|qHr|qTid|ops|cbDone|enqDone|origSaved
 *   LOG       �?�?E| 开头的若干行记录，最�?END
 *   RESET     �?OK
 *   UNINSTALL �?OK         摘除视觉树订阅（模块仍驻留但完全惰性）
 *   UNLOAD    �?BYE        UNINSTALL + 关管�?+ FreeLibraryAndExitThread（尽力而为�? *
 * M2（外观改写）新增命令，响应以 R| / T| / X| / S| / Q| 开头、END 收尾
 *   PROBE                 �?BackgroundFill �?Fill 属性索�?+ 当前画刷类型
 *   QI                    �?UI 线程上捕�?DispatcherQueue（之后可即时下发
 *   FILL <AARRGGBB>       �?BackgroundFill.Fill 换成该颜色的 SolidColorBrush
 *   RESTORE               还原成捕获到的原始画刷（没有�?ClearProperty�? *   以上任意一条都能加 `:now` 后缀 �?�?*当前管道线程**上直接执行，
 *   用于对比线程亲和性（预期返回 RPC_E_WRONG_THREAD 或直接失败，属诊断实验）�? *
 * 执行模型：管道线程只�?pending，真正执行发生在 XAML UI 线程上，两条路：
 *   �?DispatcherQueue::TryEnqueue（一�?QI 成功就能即时生效）；
 *   �?**视觉树回调兜�?* —�?回调本身就跑�?UI 线程上，所以下一次树事件会自动把改动补做掉
 *   path �?�?零新 API"的安全兜底，即便 DispatcherQueue 抓不到功能也不会丢�? *
 * ⚠️ 实测结论�?026-09-13，本�?build 26200）：
 *   **TAP 附着是「每�?explorer 生命周期只能一次」的一次性资源�?*
 *   一�?UnadviseVisualTreeChange + 释放 IXamlDiagnostics，之后再
 *   InitializeXamlDiagnosticsEx 会一律返�?0x80070490（HRESULT_FROM_WIN32(ERROR_NOT_FOUND)），
 *   连续 47 次重试全部失败。上�?TranslucentTB 从不拆除订阅，正好印证这一点�? *   �?正常流程**只附着、不拆除**；UNINSTALL/REATTACH 仅用于诊断，且要清楚它们不可逆�? *     �?explorer 进程（重�?explorer）后才能重新附着�? */

#define INITGUID
#include <windows.h>
#include <unknwn.h>
#include <inspectable.h>
#include <oleauto.h>
#include <ocidl.h>
#include <xamlom.h>

// ---- M2：把 XAML 操作搬回 UI 线程用的 DispatcherQueue ----
// MinGW 自带完整 ABI 声明（windows.system.h 里有 IDispatcherQueue /
// IDispatcherQueueStatics / IDispatcherQueueHandler 及其真实 IID），
// 导入库用 -lruntimeobject -lwindowsapp（已�?.workbuddy/bench/taskbar/dqprobe.cpp 实测链接+运行通过）
#include <roapi.h>
#include <winstring.h>
#include <windows.system.h>
#include <windows.foundation.h>

#include <stdio.h>
#include <stdarg.h>
#include <string.h>
#include <stdlib.h>
#include <stdint.h>

// ============================================================
// 本模块的 TAP CLSID（自定义，无需注册）
// {8F3C1A20-7B4D-4E91-9C6A-5D2E1F0A3B77}
// ============================================================
static const GUID CLSID_AILobsterTap =
    {0x8f3c1a20, 0x7b4d, 0x4e91, {0x9c, 0x6a, 0x5d, 0x2e, 0x1f, 0x0a, 0x3b, 0x77}};

using PFN_INITIALIZE_XAML_DIAGNOSTICS_EX =
    HRESULT(WINAPI*)(PCWSTR, DWORD, PCWSTR, PCWSTR, CLSID, PCWSTR);

// MinGW �?winerror.h 没有这个（上游用的是 C++/WinRT �?winrt::hresult_illegal_method_call）
#ifndef E_ILLEGAL_METHOD_CALL
#define E_ILLEGAL_METHOD_CALL ((HRESULT)0x8000000EL)
#endif

// MinGW 只把 IID_IUnknown 声明�?unknwnbase.h 里，**不提供定�?*（其
// MinGW 只把 IID_IUnknown 声明�?unknwnbase.h 里，**不提供定�?*（其IID 都走 DEFINE_GUID�）
// �?INITGUID 下就成了定义）。我们不链接 uuid 归档，所以这里自己补上，避免 undefined reference。
extern "C" const IID IID_IUnknown =
    {0x00000000, 0x0000, 0x0000, {0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46}};

// ============================================================
// M2 真改路径：手�?IShape ABI 接口
//   MinGW 只提�?windows.ui.xaml.h（IDependencyObject 等），没�?shapes.h�）
//   下面这个接口�?vtable 布局取自本机 Windows.UI.Xaml.winmd 实测（见 .workbuddy/bench/taskbar/winmd_iid.py）：
//     IUnknown(3) + IInspectable(3) = 基类 6 个方法，
//     之后�? get_Fill, 7 put_Fill, 8 get_Stroke, 9 put_Stroke, …（我们只声明到 put_Fill）�）
//   只声明到 put_Fill 即可——调用方只需 slot 7。IShape 的 IID：
//     {786F2B75-9AA0-454D-AE06-A2466E37C832}
// ============================================================
static const IID IID_IShapeAIL =
    {0x786f2b75, 0x9aa0, 0x454d, {0xae, 0x06, 0xa2, 0x46, 0x6e, 0x37, 0xc8, 0x32}};

struct IShapeAIL : public IInspectable {
    // 基类 IInspectable 已含 QI/AddRef/Release/GetIids/GetRuntimeClassName/GetTrustLevel（slot 0..5
    virtual HRESULT STDMETHODCALLTYPE get_Fill(IInspectable** value) = 0;   // slot 6
    virtual HRESULT STDMETHODCALLTYPE put_Fill(IInspectable* value) = 0;    // slot 7
};

// ============================================================
// IAcrylicBrush ABI 接口（实验用：调 TintOpacity 做亚克力淡出）
//
// ⚠️⚠️ 这一版是照**旧版 SDK**写的，和本机 Win11 的 winmd 对不上：
//   真 IID  = {79bbcf4e-cd66-4f1b-a8b6-cd6d2977c18d}（下面写的是 04560ddc…，是别的接口）
//   真布局  = slot 6/7 BackgroundSource, 8/9 TintColor, 10/11 TintOpacity,
//             12/13 TintTransitionDuration, 14/15 AlwaysUseFallback
//             —— **没有** TintLuminosityOpacity（Win10 时代才有）
//   现状后果：QI 用错 IID → 恒失败 → 这条路径整体空转（不会崩）。
//   **要修就必须 IID 和布局一起修**：只改 IID 会让 QI 成功、然后调错槽位 → 宿主崩溃。
//   真值来源：scripts/winmd_vtable.py Windows.UI.Xaml.Media.IAcrylicBrush
// ============================================================
static const IID IID_IAcrylicBrushAIL =
    {0x04560ddc, 0x5f73, 0x4d7b, {0x94, 0xb2, 0x63, 0x0b, 0x60, 0x74, 0x6e, 0x4b}};

struct IAcrylicBrushAIL : public IInspectable {
    virtual HRESULT STDMETHODCALLTYPE get_TintColor(/* Windows.UI.Color */ void** value) = 0;  // slot 6
    virtual HRESULT STDMETHODCALLTYPE put_TintColor(/* Windows.UI.Color */ void* value) = 0;   // slot 7
    virtual HRESULT STDMETHODCALLTYPE get_TintOpacity(double* value) = 0;                       // slot 8
    virtual HRESULT STDMETHODCALLTYPE put_TintOpacity(double value) = 0;                        // slot 9
    virtual HRESULT STDMETHODCALLTYPE get_TintLuminosityOpacity(double* value) = 0;              // slot 10
    virtual HRESULT STDMETHODCALLTYPE put_TintLuminosityOpacity(double value) = 0;               // slot 11
    virtual HRESULT STDMETHODCALLTYPE get_FallbackColor(/* Windows.UI.Color */ void** value) = 0; // slot 12
    virtual HRESULT STDMETHODCALLTYPE put_FallbackColor(/* Windows.UI.Color */ void* value) = 0;  // slot 13
};

// ============================================================
// ICustomPropertyProvider / ICustomProperty 接口（用于获取属性值）
// ============================================================
static const IID IID_ICustomPropertyProvider =
    {0x7c925755, 0x1e4d, 0x4218, {0x90, 0xf3, 0x5a, 0x20, 0x9a, 0xef, 0x02, 0xa3}};

struct ICustomProperty;

struct ICustomPropertyProvider : public IInspectable {
    virtual HRESULT STDMETHODCALLTYPE GetCustomProperty(HSTRING name, ICustomProperty** result) = 0;  // slot 6
    virtual HRESULT STDMETHODCALLTYPE GetIndexedProperty(HSTRING name, void* type, ICustomProperty** result) = 0;  // slot 7
    virtual HRESULT STDMETHODCALLTYPE GetType(void** result) = 0;  // slot 8 (可能有两个GetType，先声明一

};

static const IID IID_ICustomProperty =
    {0xf0e35dc9, 0x265a, 0x4604, {0xb9, 0xf5, 0x77, 0x19, 0xa1, 0x95, 0x31, 0x5a}};

struct ICustomProperty : public IInspectable {
    virtual HRESULT STDMETHODCALLTYPE get_Type(void** result) = 0;  // slot 6
    virtual HRESULT STDMETHODCALLTYPE get_Name(HSTRING* result) = 0;  // slot 7
    virtual HRESULT STDMETHODCALLTYPE GetValue(IInspectable* target, IInspectable** result) = 0;  // slot 8
    virtual HRESULT STDMETHODCALLTYPE SetValue(IInspectable* target, IInspectable* value) = 0;  // slot 9
    virtual HRESULT STDMETHODCALLTYPE GetIndexedValue(IInspectable* target, IInspectable* index, IInspectable** result) = 0;  // slot 10
    virtual HRESULT STDMETHODCALLTYPE SetIndexedValue(IInspectable* target, IInspectable* value, IInspectable* index) = 0;  // slot 11
};

// 简化的 IDispatch 接口（避免与系统头文件冲突）
struct MyIDispatch : public IUnknown {
    virtual HRESULT STDMETHODCALLTYPE GetTypeInfoCount(UINT* pctinfo) = 0;
    virtual HRESULT STDMETHODCALLTYPE GetTypeInfo(UINT iTInfo, LCID lcid, void** ppTInfo) = 0;
    virtual HRESULT STDMETHODCALLTYPE GetIDsOfNames(REFIID riid, LPOLESTR* rgszNames, UINT cNames, LCID lcid, DISPID* rgDispId) = 0;
    virtual HRESULT STDMETHODCALLTYPE Invoke(DISPID dispIdMember, REFIID riid, LCID lcid, WORD wFlags, DISPPARAMS* pDispParams, VARIANT* pVarResult, EXCEPINFO* pExcepInfo, UINT* puArgErr) = 0;
};

// IBorder 接口 - 用于直接获取 Background 属性
static const IID IID_IBorder =
    {0x797c4539, 0x45bd, 0x4633, {0xa0, 0x44, 0xbf, 0xb0, 0x2e, 0xf5, 0x17, 0x0f}};

struct IBorder : public IInspectable {
    // ⚠️ 真实顺序取自本机 Windows.UI.Xaml.winmd（scripts/winmd_vtable.py 实测）：
    //    旧的声明把 Background 放在 slot 6/7，**实际是 BorderBrush**，于是所有
    //    put_Background 调用其实都在改边框画刷 —— 返回 S_OK 但没有视觉效果，
    //    这正是「跳转列表一直改不动」的真凶。下面顺序已与 winmd 逐条核对。
    virtual HRESULT STDMETHODCALLTYPE get_BorderBrush(void** value) = 0;      // slot 6
    virtual HRESULT STDMETHODCALLTYPE put_BorderBrush(void* value) = 0;       // slot 7
    virtual HRESULT STDMETHODCALLTYPE get_BorderThickness(void* value) = 0;   // slot 8
    virtual HRESULT STDMETHODCALLTYPE put_BorderThickness(void* value) = 0;   // slot 9
    virtual HRESULT STDMETHODCALLTYPE get_Background(void** value) = 0;       // slot 10
    virtual HRESULT STDMETHODCALLTYPE put_Background(void* value) = 0;        // slot 11
    virtual HRESULT STDMETHODCALLTYPE get_CornerRadius(void* value) = 0;      // slot 12
    virtual HRESULT STDMETHODCALLTYPE put_CornerRadius(void* value) = 0;      // slot 13
    virtual HRESULT STDMETHODCALLTYPE get_Padding(void* value) = 0;           // slot 14
    virtual HRESULT STDMETHODCALLTYPE put_Padding(void* value) = 0;           // slot 15
    virtual HRESULT STDMETHODCALLTYPE get_Child(void** value) = 0;            // slot 16
    virtual HRESULT STDMETHODCALLTYPE put_Child(void* value) = 0;             // slot 17
    virtual HRESULT STDMETHODCALLTYPE get_ChildTransitions(void** value) = 0; // slot 18
    virtual HRESULT STDMETHODCALLTYPE put_ChildTransitions(void* value) = 0;  // slot 19
};

// IDependencyObject 接口
static const IID IID_IDependencyObject =
    {0x5f4a845a, 0x3e0a, 0x4780, {0x99, 0xc7, 0x63, 0x23, 0x98, 0x6f, 0x39, 0x51}};

struct IDependencyObject : public IInspectable {
    // 真实布局（winmd 实测，共 6 个方法）：
    //   下面旧声明在 slot 10/11 插了 Register/UnregisterPropertyChangedCallback
    //   ——那两个属于 IDependencyObject2，是**另一个 IID**。GetValue 在 slot 6 两边
    //   一致所以一直没暴露问题。
    virtual HRESULT STDMETHODCALLTYPE GetValue(void* dp, IInspectable** result) = 0;      // slot 6
    virtual HRESULT STDMETHODCALLTYPE SetValue(void* dp, IInspectable* value) = 0;       // slot 7
    virtual HRESULT STDMETHODCALLTYPE ClearValue(void* dp) = 0;                          // slot 8
    virtual HRESULT STDMETHODCALLTYPE ReadLocalValue(void* dp, IInspectable** result) = 0; // slot 9
    virtual HRESULT STDMETHODCALLTYPE GetAnimationBaseValue(void* dp, IInspectable** result) = 0; // slot 10
    virtual HRESULT STDMETHODCALLTYPE get_Dispatcher(void** result) = 0;                 // slot 11
};

// IBorderFactory 接口 - 用于获取静�?DependencyProperty
static const IID IID_IBorderFactory =
    {0x8765938d, 0x8b4a, 0x4f8a, {0x91, 0x5b, 0x69, 0x3b, 0x8e, 0x3e, 0x3c, 0x8e}};

struct IBorderFactory : public IInspectable {
    virtual HRESULT STDMETHODCALLTYPE get_BackgroundProperty(void** result) = 0;  // slot 6
    virtual HRESULT STDMETHODCALLTYPE get_BorderBrushProperty(void** result) = 0;  // slot 7
    virtual HRESULT STDMETHODCALLTYPE get_BorderThicknessProperty(void** result) = 0;  // slot 8
    virtual HRESULT STDMETHODCALLTYPE get_CornerRadiusProperty(void** result) = 0;  // slot 9
    virtual HRESULT STDMETHODCALLTYPE get_PaddingProperty(void** result) = 0;  // slot 10
    virtual HRESULT STDMETHODCALLTYPE get_ChildProperty(void** result) = 0;  // slot 11
};

// ICoreDispatcher 接口 - 用于�?UI 线程执行代码
static const IID IID_ICoreDispatcher =
    {0x60db2fa8, 0xb705, 0x4fde, {0xa7, 0xd6, 0xeb, 0xbb, 0x18, 0x91, 0xd3, 0x9e}};

struct ICoreDispatcher : public IInspectable {
    virtual HRESULT STDMETHODCALLTYPE get_HasThreadAccess(int* value) = 0;  // slot 6
    virtual HRESULT STDMETHODCALLTYPE get_CurrentPriority(void* value) = 0;  // slot 7
    virtual HRESULT STDMETHODCALLTYPE put_CurrentPriority(void* value) = 0;  // slot 8
    virtual HRESULT STDMETHODCALLTYPE RunAsync(void* priority, void* agileCallback, void** asyncAction) = 0;  // slot 9
    virtual HRESULT STDMETHODCALLTYPE RunIdleAsync(void* agileCallback, void** asyncAction) = 0;  // slot 10
    virtual HRESULT STDMETHODCALLTYPE ShouldYield(void* value) = 0;  // slot 11
    virtual HRESULT STDMETHODCALLTYPE ProcessEvents(void* options) = 0;  // slot 12
};

// ============================================================
// M3（纯透明）：真实对象改写用的两个接口
//   IUIElement::put_Opacity        —— 把元素自身不透明度设为 0（整块淡出，用于对照/调试）
//   IBorder / IPanel::put_Background —— 只换背景画刷为透明、保留子内容（真正的"纯透明"）
//   依据本机 Windows.UI.Xaml.winmd 实测（见 .workbuddy/bench/taskbar/winmd_iid.py）：
//     IUIElement  {676D0BE9-B65C-41C6-BA40-58CF87F201C1}
//        vtable: IUnknown(3)+IInspectable(3)=6; get_Opacity=slot9, put_Opacity=slot10
//     IPanel     {A50A4BBD-8361-469C-90DA-E9A40C7474DF}
//        vtable: get_Children=slot6, get_Background=slot7, put_Background=slot8
//   （IBorder 已在上文定义，put_Background=slot7）
// ============================================================
static const IID IID_IUIElementAIL =
    {0x676d0be9, 0xb65c, 0x41c6, {0xba, 0x40, 0x58, 0xcf, 0x87, 0xf2, 0x01, 0xc1}};

struct IUIElementAIL : public IInspectable {
    virtual HRESULT STDMETHODCALLTYPE get_Opacity(double* value) = 0;   // slot 9
    virtual HRESULT STDMETHODCALLTYPE put_Opacity(double value) = 0;    // slot 10
};

static const IID IID_IPanelAIL =
    {0xa50a4bbd, 0x8361, 0x469c, {0x90, 0xda, 0xe9, 0xa4, 0x0c, 0x74, 0x74, 0xdf}};

// IControl：Frame / ScrollViewer / ListView 这类 **Control 一族** 只有它有 Background，
// IBorder/IPanel 都 QI 不到 —— 跳转列表的背景板（JumpViewUI.TaskbarJumpListFrame）就是这种元素。
//
// ⚠️⚠️ 槽位**必须**从 winmd 取，不能按"接口方法从 slot 6 开始"想当然：
//    WinRT 接口的 vtable 确实各自从 slot 6 起算（IShape.put_Fill=7、IPanel.put_Background=8
//    已实证），但接口内部的方法是**按 winmd MethodDef 声明顺序**排的，不是字母序、
//    也不是"第一个属性在 slot 6"。IControl 共 41 个方法：
//      slot 6 get_FontSize … slot 36 get_Background、**slot 37 put_Background**
//    （我最初推测 slot 7，实际 slot 7 是 put_FontFamily —— 拿画刷调它会直接崩宿主。）
//    真值一律用 scripts/winmd_vtable.py 查，别猜。
static const IID IID_IControlAIL =
    {0xa8912263, 0x2951, 0x4f58, {0xa9, 0xc5, 0x5a, 0x13, 0x4e, 0xaa, 0x7f, 0x07}};

// 不声明 30 行占位纯虚函数（易数错），直接按下标取 vtable，槽位一眼可查。
struct IControlAIL : public IInspectable {};
typedef HRESULT (STDMETHODCALLTYPE* AilPutBrushFn)(void* pThis, void* value);

// 调用 IControl::put_Background（vtable 下标 37）
static HRESULT AilControlPutBackground(IControlAIL* c, void* brush) {
    if (!c) return E_POINTER;
    void** vt = *(void***)c;
    AilPutBrushFn put = (AilPutBrushFn)vt[37];
    return put(c, brush);
}

struct IPanelAIL : public IInspectable {
    virtual HRESULT STDMETHODCALLTYPE get_Children(void** value) = 0;        // slot 6
    virtual HRESULT STDMETHODCALLTYPE get_Background(void** value) = 0;      // slot 7
    virtual HRESULT STDMETHODCALLTYPE put_Background(void* value) = 0;       // slot 8
};

// ============================================================
// 日志（只�?%TEMP%，只在非回调线程调用�）
//   加锁：附着线程与管道线程会并发写同一个文件，Log 内部是多�?fprintf/fputc�）
//   不加锁会出现**行内撕裂**（实测日志里出现过半�?"CLSID"）�）
//   注意：绝不能在视觉树回调（XAML UI 线程）里调用 Log�）
// ============================================================
static volatile LONG g_logEnabled = 1;
static char g_logPath[MAX_PATH] = {0};
static char g_logPath2[MAX_PATH] = {0};    // 备选路径（DLL 所在目录）
static CRITICAL_SECTION g_logCs;

// 日志落盘位置。宿主是 AppContainer（ShellExperienceHost）时，%TEMP% 会被重定向到
// `...\Packages\<包>\...\AC\Temp\`，那个目录往往**不存在** → fopen 恒失败 →
// 整个模块"静默"（没有任何日志，看起来像线程没跑）。所以再备一条：DLL 自己所在目录，
// 也就是我们特意放进去的那个可被包 SID 读取的目录，那里一定写得进去。
static void LogInitPath() {
    char tmp[MAX_PATH] = {0};
    DWORD n = GetTempPathA(MAX_PATH, tmp);
    if (n > 0 && n < MAX_PATH) snprintf(g_logPath, MAX_PATH, "%sai_lobster_tap.log", tmp);
    // AppContainer 里 %TEMP% 会被重定向到一个通常**不存在**的 AC\Temp，
    // 于是 fopen/CreateFile 全失败、整个模块静默。备选：DLL 自己所在目录
    // ——那是我们特意放进去的、包 SID 有权限的目录，实测可写。
    wchar_t wdir[MAX_PATH] = {0};
    char mdir[MAX_PATH] = {0};
    HMODULE hm = NULL;
    if (GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                           GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                           (LPCWSTR)&LogInitPath, &hm) && hm &&
        GetModuleFileNameW(hm, wdir, MAX_PATH)) {
        char tmp2[MAX_PATH] = {0};
        WideCharToMultiByte(CP_ACP, 0, wdir, -1, tmp2, MAX_PATH, NULL, NULL);
        if (tmp2[0]) {
            char* slash = strrchr(tmp2, '\\');
            if (slash) {
                *(slash + 1) = 0;
                snprintf(mdir, MAX_PATH, "%s", tmp2);
            }
        }
    }
    if (mdir[0]) snprintf(g_logPath2, MAX_PATH, "%sai_lobster_tap.log", mdir);
}

static void Log(const char* fmt, ...) {
    if (!g_logEnabled || (!g_logPath[0] && !g_logPath2[0])) return;
    EnterCriticalSection(&g_logCs);

    // 用 Win32 API 而不是 CRT fopen：在 AppContainer 宿主里 fopen 会静默失败
    // （%TEMP% 被重定向到可能不存在的 AC\Temp），而 CreateFileW 实测是能写的。
    HANDLE hf = INVALID_HANDLE_VALUE;
    if (g_logPath[0]) {
        hf = CreateFileA(g_logPath, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE,
                         NULL, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    }
    if (hf == INVALID_HANDLE_VALUE && g_logPath2[0]) {
        hf = CreateFileA(g_logPath2, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE,
                         NULL, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    }
    if (hf == INVALID_HANDLE_VALUE) { LeaveCriticalSection(&g_logCs); return; }
    SYSTEMTIME st;
    GetLocalTime(&st);
    char line[1024];
    int pn = snprintf(line, sizeof(line), "[%02d:%02d:%02d.%03d][tid %lu] ",
                       st.wHour, st.wMinute, st.wSecond, st.wMilliseconds,
                       GetCurrentThreadId());
    va_list ap;
    va_start(ap, fmt);
    if (pn >= 0 && pn < (int)sizeof(line))
        vsnprintf(line + pn, sizeof(line) - pn, fmt, ap);
    va_end(ap);
    size_t len = strlen(line);
    if (len < sizeof(line) - 2) { line[len] = '\n'; line[len + 1] = 0; len++; }
    DWORD wrote = 0;
    WriteFile(hf, line, (DWORD)len, &wrote, NULL);
    CloseHandle(hf);
    LeaveCriticalSection(&g_logCs);
}

// ============================================================
// 观测记录（去重后的小表）
// ============================================================
#define MAX_REC 128

struct Rec {
    LONG kind;      // 0 = Add, 1 = Remove
    LONG count;
    LONG interesting;
    char type[128];
    char name[80];
    unsigned long long handle;
    unsigned long long parent;
};

static CRITICAL_SECTION g_cs;
static int g_csReady = 0;
static Rec g_recs[MAX_REC];
static volatile LONG g_recCount = 0;
static volatile LONG g_totalEvents = 0;
static volatile LONG g_frames = 0;      // "Taskbar.TaskbarFrame" 出现次数
static volatile LONG g_fills = 0;       // "BackgroundFill" 出现次数
static volatile LONG g_strokes = 0;     // "BackgroundStroke" 出现次数

static void NarrowCopy(char* dst, size_t dstLen, const wchar_t* src) {
    dst[0] = '\0';
    if (!src) return;
    WideCharToMultiByte(CP_UTF8, 0, src, -1, dst, (int)dstLen - 1, NULL, NULL);
    dst[dstLen - 1] = '\0';
}

static int IsInterestingType(const char* type) {
    if (!type || !type[0]) return 0;
    if (strstr(type, "Taskbar")) return 1;
    if (strstr(type, "DesktopWindowXamlSource")) return 1;
    return 0;
}

static int IsInterestingName(const char* name) {
    if (!name || !name[0]) return 0;
    if (strcmp(name, "BackgroundFill") == 0) return 1;
    if (strcmp(name, "BackgroundStroke") == 0) return 1;
    if (strstr(name, "Taskbar")) return 1;
    return 0;
}

// ============================================================
// 全局状�）
// ============================================================
static HMODULE g_hModule = NULL;
static volatile LONG g_running = FALSE;
static volatile LONG g_wantUnload = 0;
static HANDLE g_hPipeThread = NULL;
static HANDLE g_hAttachThread = NULL;

// TAP 附着状态
static volatile LONG g_attachState = 0;      // 0=未开�?1=进行�?2=成功 3=失败
static volatile LONG g_attachAttempts = 0;
static volatile LONG g_attachHr = 0;
// 连接序号跨多�?REATTACH 连续递增，保证每次用的连接名都不�）
// （XAML 诊断对每个线程只初始化一次，连接名也必须区别开
static volatile LONG g_connSeq = 0;

// XAML 对象
class TapSite;                               // 前置声明（定义在下面
static IXamlDiagnostics* g_diag = NULL;
static IVisualTreeService3* g_vts = NULL;
static IUnknown* g_watcherRaw = NULL;        // 我们�?watcher 的强引用
static TapSite* g_tapSite = NULL;            // 我们额外持一�?TapSite 引用，仅用于拆除时释�?m_site
static volatile LONG g_advised = 0;
static volatile LONG g_qiHr = 0;

// ============================================================
// M2：外观改写状�）
// ============================================================
// 目标元素句柄：在视觉树回调里记录（回调跑�?XAML UI 线程上）
static volatile LONG64 g_frameHandle = 0;    // Taskbar.TaskbarFrame
static volatile LONG64 g_fillHandle = 0;     // Rectangle "BackgroundFill" �?M2 的目标
static volatile LONG64 g_strokeHandle = 0;   // Rectangle "BackgroundStroke"（M4 用）
static volatile LONG g_frameSeen = 0;

// 开始菜�?通知中心背景元素（Border 类型）
static volatile LONG64 g_acrylicBorderHandle = 0;   // Border "AcrylicBorder"
static volatile LONG64 g_backgroundBorderHandle = 0; // Border "BackgroundBorder"
static volatile LONG64 g_acrylicOverlayHandle = 0;   // Border "AcrylicOverlay"
static volatile LONG64 g_origAcrylicBorderBrush = 0;  // 原始 AcrylicBorder 画刷
static volatile LONG64 g_origBackgroundBorderBrush = 0; // 原始 BackgroundBorder 画刷
static volatile LONG g_borderBrushSaved = 0;

// 视觉树元素枚举（用于调试：找到开始菜�?通知中心的背景元素）
#define MAX_ENUM_ELEMENTS 256
struct EnumElement {
    char type[128];
    char name[80];
    LONG64 handle;
    LONG mutationType; // 0=Add, 1=Remove
};
static volatile LONG g_enumCount = 0;
static EnumElement g_enumElements[MAX_ENUM_ELEMENTS];
static CRITICAL_SECTION g_enumCs;
static volatile LONG g_enumCsReady = 0;

// 待执行操作：管道线程�?pending，UI 线程执行
enum { OP_NONE = 0, OP_PROBE = 1, OP_FILL = 2, OP_RESTORE = 3, OP_QICAP = 4, OP_ACRYLIC = 5, OP_FILL_BORDER = 6, OP_FILL_ALL = 7, OP_SET_ACRYLIC_OPACITY = 8, OP_DIRECT_ACRYLIC = 9, OP_DUMP_PROPS = 10, OP_SETPROP = 11, OP_DUMPVALS = 12, OP_BGCLASS = 13, OP_PUTBG = 14, OP_ACRYLIC_KILL = 15, OP_ACRYLIC_KILL2 = 16, OP_OPACITY = 17, OP_FULL_TRANSPARENT = 18, OP_SETOPACITY_AT = 19, OP_OPACITYREAL = 20, OP_BGTRANSPARENT = 21, OP_BGSCAN = 22, OP_BGRESTORE = 23 };
// IPropertyValueStatics IID（Windows.Foundation.PropertyValue）
static const IID IID_IPVS =
    {0x629bdbc8, 0xd932, 0x4ff4, {0x96, 0xb9, 0x8d, 0x96, 0xc5, 0xc1, 0xe8, 0x58}};
static volatile LONG g_pendingOp = OP_NONE;
static volatile LONG g_pendingArgb = 0;
static volatile LONG g_pendingSeq = 0;
static volatile LONG g_dumpTarget = -1;
static volatile LONG g_setpropIdx = -1;
static char g_setOpName[96] = {0};   // OPACITYNAME: match by element name
static char g_dumpBuf[16384];
static volatile LONG g_doneSeq = 0;
static volatile LONG g_applying = 0;         // 同线程重入保
static volatile LONG g_opCount = 0;
static volatile LONG g_applyOnCallback = 0;  // �?下一次视觉树回调"完成的次
static volatile LONG g_applyViaEnqueue = 0;  // �?DispatcherQueue 完成的次�）

// 最近一次操作的结果（供管道线程读取；只�?UI 线程写）
static volatile LONG g_resOp = OP_NONE;
static volatile LONG g_resArgb = 0;
static volatile LONG g_resUiThread = 0;
static volatile LONG g_resHrIdx = 0;
static volatile LONG g_resHrGet = 0;
static volatile LONG g_resHrCreate = 0;
static volatile LONG g_resHrColor = 0;
static volatile LONG g_resHrSet = 0;
static volatile LONG g_resPropIndex = -1;
static volatile LONG64 g_resFillHandle = 0;
static volatile LONG64 g_resPrevBrush = 0;
static volatile LONG64 g_resNewBrush = 0;
static char g_resBrushClass[128] = {0};
static char g_resEnum[2048] = {0};          // PROBE 诊断：BackgroundFill 的属性名+index 枚举
static volatile LONG g_resHrChain = 0;
static volatile LONG g_fillChainIndex = -1;  // 属性链枚举出的 Fill 真实 index（GetPropertyIndex 失败时的兜底�）
// Border 操作调试
static volatile LONG g_resBorderCount = 0;   // 找到�?Border 数量
static volatile LONG g_resBorderBgIdx = -1;  // 找到�?Background 属性索
static char g_resBorderProps[1024] = {0};    // Border 属性列�）
// M2 真改路径（IShape::put_Fill）新增诊断
static volatile LONG g_resHrRect = 0;       // GetIInspectableFromHandle(fill) 结果
static volatile LONG g_resHrShape = 0;      // QI(IShapeAIL) 结果
static volatile LONG g_resHrBrush = 0;      // GetIInspectableFromHandle(brush) 结果
// BGTRANSPARENT 真实对象路径分步诊断（定位 RPC_E_WRONG_THREAD 根因）
static volatile LONG g_bgHrGet = (LONG)E_UNEXPECTED;  // GetIInspectableFromHandle(element)
static volatile LONG g_bgHrQI  = (LONG)E_UNEXPECTED;  // QueryInterface(IBorder)
static volatile LONG g_bgHrSet = (LONG)E_UNEXPECTED;  // put_Background 结果（线程亲和失败点）
// 自动透明（AUTOBG）：面板每次打开都会重建视觉树，在**回调里**就地改写。
// 这是唯一可靠的时机 —— 一次性命令在 AppContainer 宿主里不可靠：宿主在面板
// 不显示时会被内核冻结，命令线程根本不被调度（表现为命令超时）。
// 而视觉树回调是 XAML 亲自在 UI 线程上调的，此时对象一定可写。
static volatile LONG g_autoBgEnabled = 0;
#define AIL_AUTOBG_MAX 16
static char          g_autoBgNames[AIL_AUTOBG_MAX][64];
static volatile LONG g_autoBgCount = 0;
static volatile LONG g_autoBgApplied = 0;   // 累计改写成功次数
static volatile LONG g_autoBgLastHr = 0;
static IInspectable* g_clearBrush = NULL;   // 缓存的透明画刷（只造一次，用完不释放）

// 应用记录环：每次 AUTOBG 改写都记「类型|名字|走的接口|hr」，用 AUTOBG LOG 倒出来。
// 用途：通配符模式跑一遍，就知道它到底动了哪些元素 —— 再据此定默认名单。
// 注意：写入发生在 UI 线程回调里 → 只写内存、**不做任何 I/O**，下标用 Interlocked 推进。
#define AIL_AUTOBG_LOG_MAX 128
static char          g_autoBgLog[AIL_AUTOBG_LOG_MAX][96];
static volatile LONG g_autoBgLogN = 0;
// 最近一次 AilSetBackgroundTransparent 命中的接口：1=IBorder 2=IPanel 3=IControl 0=都没中
static volatile LONG g_bgWhich = 0;

// ── 宿主端性能诊断（2026-09-14）：换透明画刷的真实 UI 线程成本 ──────────────
// 通配符 AUTOBG 会不会拖慢面板打开，光看 JS 端命令往返时间看不出来 ——
// 真正的改写发生在宿主 UI 线程的视觉树回调里。这里累计三样东西，
// 通过 AUTOBG 状态行（bgCalls/bgCostMs/bgMaxMs）暴露给 JS 侧的诊断日志：
//   bgCalls   累计调用次数（含 AUTOBG 回调 + catchup 补改）
//   bgCostMs  累计耗时（毫秒）—— AUTOBG CLEAR 时清零 = 按启用周期计量
//   bgMaxMs   单次最贵调用的耗时
static volatile LONG64 g_bgCostUs = 0;
static volatile LONG64 g_bgMaxUs = 0;
static volatile LONG   g_bgCalls = 0;
// QPC 取微秒（freq 缓存一次；首次并发初始化最多重复赋同值，无副作用）
static LONG64 AilNowUs(void) {
    static LARGE_INTEGER f = {0};
    LARGE_INTEGER c;
    if (!f.QuadPart) QueryPerformanceFrequency(&f);
    QueryPerformanceCounter(&c);
    return c.QuadPart * 1000000LL / f.QuadPart;
}

// DispatcherQueue 分两步取，关键是**把重活挪�?UI 线程**�）
// EnsureQStatics()   取静态工�?—�?与线程无关，可在管道线程（MTA）上做（dqprobe 已实测通过）；
// CaptureOnUiThread() 只做 GetForCurrentThread() —�?必须�?UI 线程上，但极轻（线程局部查�?+ AddRef）�）
// 这样 UI 线程上不会出现任�?COM 激�?/ 模块加载，风险降到最低
static volatile LONG g_qStaticsState = 0;    // 0=未取 1=进行�?2=成功 3=失败
static ABI::Windows::System::IDispatcherQueueStatics* g_qStatics = NULL;
static volatile LONG g_qState = 0;           // 0=未尝�?1=进行�?2=成功 3=失败
static volatile LONG g_qHr = 0;
static volatile LONG g_qTid = 0;
static ABI::Windows::System::IDispatcherQueue* g_uiQueue = NULL;
// 1 = �?初始树转�?期间自动�?DispatcherQueue（那时回调天然跑�?UI 线程，不需要外部触发事件）
static volatile LONG g_autoQicap = 1;
static volatile LONG g_origBrushSaved = 0;
static volatile LONG64 g_origBrush = 0;      // 原始 Fill 画刷（RESTORE 用）
static volatile LONG g_origStrokeBrushSaved = 0;
static volatile LONG64 g_origStrokeBrush = 0;  // 原始 Stroke 画刷（RESTORE 用）

static void RunPendingOp(int allowLog);
// 自动透明：在视觉树回调里就地改写（定义见 M3 辅助函数区，那里才有 XAML 接口）
static void AutoApplyBgIfWanted(const char* name, LONG64 h, int isAdd, const char* type);
static void AutoBgCatchup(void);   // 补改：任何回调里重试名单里还没改成功的元素（定义见下方）
static void AutoBgCatchupFromRecs(void);   // 同上，但目标来自 g_recs（附着时树已建好的宿主）
static BOOL CatchupThrottled();            // 补改限流（定义见下方）
static void AutoBgTick();                  // 回调线程上的总入口：有还原请求就还原，否则补改
static void EnsureQStatics(int allowLog);
static void CaptureOnUiThread(int allowLog);

#ifdef AIL_TRAY_TARGET
// 托盘溢出区专用模块用独立管道前缀，避免和注入同一 explorer 的其它 TAP 模块（默认 AI_Lobster_Tap）抢管道/抢命令。
#define PIPE_PREFIX "\\\\.\\pipe\\AI_Lobster_Tray_"
#else
#define PIPE_PREFIX "\\\\.\\pipe\\AI_Lobster_Tap_"
#endif
static char g_pipeName[160] = {0};

static void WriteLine(HANDLE pipe, const char* s) {
    DWORD w = 0;
    WriteFile(pipe, s, (DWORD)strlen(s), &w, NULL);
    WriteFile(pipe, "\n", 1, &w, NULL);
}

// ============================================================
// 视觉树回�?—�?只记录，绝不修改
//   注意：本函数运行�?XAML �?UI 线程上，**绝不能写文件 / 不能阻塞**�）
// ============================================================
class VisualTreeWatcher : public IVisualTreeServiceCallback2 {
    volatile LONG m_ref;

public:
    VisualTreeWatcher() : m_ref(1) {}
    virtual ~VisualTreeWatcher() {}

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override {
        if (!ppv) return E_POINTER;
        if (IsEqualIID(riid, IID_IUnknown) ||
            IsEqualIID(riid, IID_IVisualTreeServiceCallback) ||
            IsEqualIID(riid, IID_IVisualTreeServiceCallback2)) {
            *ppv = static_cast<IVisualTreeServiceCallback2*>(this);
            AddRef();
            return S_OK;
        }
        *ppv = NULL;
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override {
        return (ULONG)InterlockedIncrement(&m_ref);
    }
    ULONG STDMETHODCALLTYPE Release() override {
        LONG r = InterlockedDecrement(&m_ref);
        if (r == 0) delete this;
        return (ULONG)r;
    }

    HRESULT STDMETHODCALLTYPE OnVisualTreeChange(ParentChildRelation relation,
                                                 VisualElement element,
                                                 VisualMutationType mutationType) override {
        InterlockedIncrement(&g_totalEvents);

        char type[128], name[80];
        NarrowCopy(type, sizeof(type), element.Type);
        NarrowCopy(name, sizeof(name), element.Name);

        // ---- M2：记录目标元素句�?----
        // 判据与上�?visualtreewatcher.cpp 一致：type=="Taskbar.TaskbarFrame"�）
        // 以及 type=="Windows.UI.Xaml.Shapes.Rectangle" �?name �?BackgroundFill / BackgroundStroke
        const LONG64 h = (LONG64)element.Handle;
        if (mutationType == Add) {
            if (strcmp(type, "Taskbar.TaskbarFrame") == 0) {
                InterlockedExchange64(&g_frameHandle, h);
                InterlockedExchange(&g_frameSeen, 1);
            } else if (strcmp(type, "Windows.UI.Xaml.Shapes.Rectangle") == 0) {
                if (strcmp(name, "BackgroundFill") == 0)        InterlockedExchange64(&g_fillHandle, h);
                else if (strcmp(name, "BackgroundStroke") == 0) InterlockedExchange64(&g_strokeHandle, h);
            } else if (strcmp(type, "Windows.UI.Xaml.Controls.Border") == 0) {
                // 开始菜�?通知中心的背景元
                if (strcmp(name, "AcrylicBorder") == 0)         InterlockedExchange64(&g_acrylicBorderHandle, h);
                else if (strcmp(name, "BackgroundBorder") == 0) InterlockedExchange64(&g_backgroundBorderHandle, h);
                else if (strcmp(name, "AcrylicOverlay") == 0)   InterlockedExchange64(&g_acrylicOverlayHandle, h);
            }
        } else {
            if (h == g_fillHandle)   InterlockedExchange64(&g_fillHandle, 0);
            if (h == g_strokeHandle) InterlockedExchange64(&g_strokeHandle, 0);
            if (h == g_frameHandle)  InterlockedExchange64(&g_frameHandle, 0);
            if (h == g_acrylicBorderHandle)    InterlockedExchange64(&g_acrylicBorderHandle, 0);
            if (h == g_backgroundBorderHandle) InterlockedExchange64(&g_backgroundBorderHandle, 0);
            if (h == g_acrylicOverlayHandle)   InterlockedExchange64(&g_acrylicOverlayHandle, 0);
            // 树重建（通知中心关闭再打开）时，把同名枚举项的陈旧句柄清零，
            // 等下次 Add 用新句柄回填 —— 否则 apply 会用陈旧句柄导致
            // E_NOINTERFACE / RPC_E_WRONG_THREAD（实测根因）
            if (g_enumCsReady) {
                EnterCriticalSection(&g_enumCs);
                for (LONG ei = 0; ei < g_enumCount && ei < MAX_ENUM_ELEMENTS; ei++) {
                    if (g_enumElements[ei].handle == h) {
                        g_enumElements[ei].handle = 0;
                        g_enumElements[ei].mutationType = 1; // Remove
                    }
                }
                LeaveCriticalSection(&g_enumCs);
            }
        }

        // ---- M2：趁"初始树转�?�?DispatcherQueue 抓到�?----
        // 本回调天然跑�?UI 线程上，而转储一定发生在附着之后（实�?417 条事件）�）
        // 所�?*不需要任何外部触�?*。之�?FILL/PROBE 就能即时下发，不必等下一次树事件�）
        // 抓取只做 GetForCurrentThread（轻量）；重活（静态工厂）已由管道线程�?MTA 上做掉
        if (g_autoQicap && !g_uiQueue && g_qStatics && g_qState == 0) {
            CaptureOnUiThread(0);
        }

        // ---- M2：有待执行的外观操作，就**就地**做掉 ----
        // 关键依据（上�?visualtreewatcher.cpp 注释）：
        //   "AdviseVisualTreeChange is special-cased to bring us to the UI thread for the callback."
        // 即本回调就在 XAML UI 线程上，�?XAML 对象是线程亲和的 �?在这里操�?XAML 是安全的�）
        // 这条也是"零新 API"的兜底路径：DispatcherQueue 抓不到时，下一次树事件仍会把改动做掉
        if (g_pendingOp != OP_NONE) {
            InterlockedIncrement(&g_applyOnCallback);
            RunPendingOp(0);      // allowLog=0：回调里**绝不做文�?I/O**（见文件头硬规则 ④）
        }

        // ---- AUTOBG 补改：面板树可能在注入前就建好（托盘溢出区实测如此），
        //      Add 回调永不再来 → 只能靠"任何回调都重试一遍"补上。
        //      必须在回调线程上（island 自己的线程）才改得动，见 AutoBgCatchup 注释。
        AutoBgCatchup();

        const int interesting = IsInterestingType(type) || IsInterestingName(name);

        if (strcmp(type, "Taskbar.TaskbarFrame") == 0) InterlockedIncrement(&g_frames);
        if (strcmp(name, "BackgroundFill") == 0)       InterlockedIncrement(&g_fills);
        if (strcmp(name, "BackgroundStroke") == 0)     InterlockedIncrement(&g_strokes);

        // 记录所有看到的元素（用于调试：找到开始菜�?通知中心的背景元素）
        // ★ 自愈式枚举：同名元素再次 Add（树重建 / 通知中心关闭再打开）时用最新句柄覆盖，
        //   保持索引稳定（apply 按索引 5/11/12 命中）。旧逻辑只要同名就跳过 → 句柄陈旧 → apply 失败。
        if (g_enumCsReady && mutationType == Add) {
            EnterCriticalSection(&g_enumCs);
            LONG n = g_enumCount;
            LONG slot = -1;
            for (LONG i = 0; i < n && i < MAX_ENUM_ELEMENTS; i++) {
                if (strcmp(g_enumElements[i].type, type) == 0 &&
                    strcmp(g_enumElements[i].name, name) == 0) {
                    slot = i;
                    break;
                }
            }
            if (slot >= 0) {
                if (g_enumElements[slot].handle != h) g_enumElements[slot].handle = h; // 刷新陈旧句柄
                g_enumElements[slot].mutationType = (LONG)mutationType;
            } else if (n < MAX_ENUM_ELEMENTS) {
                strncpy(g_enumElements[n].type, type, sizeof(g_enumElements[n].type) - 1);
                strncpy(g_enumElements[n].name, name, sizeof(g_enumElements[n].name) - 1);
                g_enumElements[n].handle = h;
                g_enumElements[n].mutationType = (LONG)mutationType;
                g_enumCount = n + 1;
            }
            LeaveCriticalSection(&g_enumCs);

            // ★ 自动透明：本回调就在 XAML UI 线程上，此时改对象是安全的。
            //   面板每次打开/重建都会重新 Add 整棵树 → 每次都自动生效。
            AutoApplyBgIfWanted(name, h, 1, type);
        }

        // ★ 补改（AUTOBG-CATCHUP）：任何一次视觉树回调都顺手重试一遍
        //   名单里"还没改成功"的元素。托盘溢出区这类面板视觉树在注入前
        //   就建好、打开只是复用 → Add 不触发；且它跑在自己 UI 线程上，
        //   跨线程一次性命令恒 RPC_E_WRONG_THREAD。本回调天然落在各 island
        //   线程上，只要有一次落在正确线程就补上。put_Background 幂等，重复无副作用。
        //   AutoBgTick 内部含限流：任务栏这种高频宿主下不必每次回调都全表扫。
        AutoBgTick();

        if (g_csReady) {
            EnterCriticalSection(&g_cs);
            LONG n = g_recCount;
            for (LONG i = 0; i < n && i < MAX_REC; i++) {
                if (g_recs[i].kind == (LONG)mutationType &&
                    strcmp(g_recs[i].type, type) == 0 &&
                    strcmp(g_recs[i].name, name) == 0) {
                    InterlockedIncrement(&g_recs[i].count);
                    LeaveCriticalSection(&g_cs);
                    return S_OK;
                }
            }
            LONG slot = InterlockedIncrement(&g_recCount) - 1;
            if (slot < MAX_REC) {
                Rec* r = &g_recs[slot];
                r->kind = (LONG)mutationType;
                r->count = 1;
                r->interesting = interesting;
                snprintf(r->type, sizeof(r->type), "%s", type);
                snprintf(r->name, sizeof(r->name), "%s", name);
                r->handle = (unsigned long long)element.Handle;
                r->parent = (unsigned long long)relation.Parent;
            }
            LeaveCriticalSection(&g_cs);
        }
        // 刻意不释�?element.Type / element.Name�）
        // 无论所有权在谁手上�?不释�?都不会造成 double-free（详见文件头说明）
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE OnElementStateChanged(InstanceHandle,
                                                    VisualElementState,
                                                    LPCWSTR) override {
        return S_OK;
    }
};

// ============================================================
// TAP 站点（XAML 通过 IObjectWithSite::SetSite 
// TAP 站点（XAML 通过 IObjectWithSite::SetSite IXamlDiagnostics 交给我们�）
// ============================================================
class TapSite : public IObjectWithSite {
    volatile LONG m_ref;
    IUnknown* m_site;

public:
    TapSite() : m_ref(1), m_site(NULL) {}
    virtual ~TapSite() {}

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override {
        if (!ppv) return E_POINTER;
        if (IsEqualIID(riid, IID_IUnknown) || IsEqualIID(riid, IID_IObjectWithSite)) {
            *ppv = static_cast<IObjectWithSite*>(this);
            AddRef();
            return S_OK;
        }
        *ppv = NULL;
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override {
        return (ULONG)InterlockedIncrement(&m_ref);
    }
    ULONG STDMETHODCALLTYPE Release() override {
        LONG r = InterlockedDecrement(&m_ref);
        if (r == 0) delete this;
        return (ULONG)r;
    }

    HRESULT STDMETHODCALLTYPE SetSite(IUnknown* pUnkSite) override;
    HRESULT STDMETHODCALLTYPE GetSite(REFIID riid, void** ppvSite) override {
        if (!ppvSite) return E_POINTER;
        if (!m_site) { *ppvSite = NULL; return E_FAIL; }
        return m_site->QueryInterface(riid, ppvSite);
    }

    // 拆除时释放我�?AddRef 过的 site。我们持有它的引用不放，会让 XAML �）
    // IXamlDiagnostics 一直活着（真 bug，不是可选项）
    void DetachSite() {
        if (m_site) { m_site->Release(); m_site = NULL; }
    }
};

// 独立线程里调�?AdviseVisualTreeChange（上游注释：这样能避开一次 hang）
static LONG SubmitOp(LONG op, unsigned long argb, int* enqueued);
static int WaitDone(LONG seq, DWORD ms);

// 全透明/还原涉及的元素名单（开始菜单白框元素 + 任务栏背景元素），供自动应用与命令共用
static const char* kFTNamesFile[] = {
    "AcrylicBorder", "StartDropShadow", "DropShadowDismissTarget",
    "MaxHeightEnforcer", "StartBlendedFlexFrame", "BackgroundBorder",
    "BorderElement", "MoreSuggestionsBackground", "BackgroundFill",
    "BackgroundStroke", "BackgroundControl"
};
static const int kFTNameCountFile = (int)(sizeof(kFTNamesFile) / sizeof(kFTNamesFile[0]));

// 统计当前枚举树中命中的元素数量（树是异步构建的，数量增长说明有新元素出现）
static LONG CountFTMatches() {
    LONG n = g_enumCount;
    LONG cnt = 0;
    for (LONG i = 0; i < n && i < MAX_ENUM_ELEMENTS; i++) {
        const char* nm = g_enumElements[i].name;
        if (!nm || !nm[0]) continue;
        for (int k = 0; k < kFTNameCountFile; k++) {
            if (strcmp(nm, kFTNamesFile[k]) == 0) { cnt++; break; }
        }
    }
    return cnt;
}

// 读取状态文件里的目标不透明度（0..1000；-1 = 文件缺失/无法解析）。
// ★ 必须在每次重放前重新读取。若 target 只在附着时读一次，用户中途切换过效果
//   （如 transparent → acrylic）之后，DLL 仍拿旧值重放，每次打开开始菜单都会把
//   外观打回上一个效果 —— 表现就是"切换到亚克力后打开菜单会闪烁"。
static long ReadTargetFromStateFile(const wchar_t* fn) {
    FILE* f = _wfopen(fn, L"rb");
    if (!f) return -1;
    char buf[64] = {0};
    size_t rd = fread(buf, 1, sizeof(buf) - 1, f);
    fclose(f);
    if (rd == 0) return -1;
    if (strstr(buf, "transparent")) return 0;
    if (strstr(buf, "normal"))      return 1000;
    if (strstr(buf, "blur"))        return 550;
    if (strstr(buf, "acrylic"))     return 400;
    return -1;
}

// 自动应用线程：宿主（重新）启动后，从状态文件读取期望效果并自动应用，
// 消除"每次打开先闪默认深色再变透明"的延迟（客户端轮询注入最快也要 ~1.5s）。
// 状态文件：%TEMP%\ai_startmenu_state.txt（开始菜单）/ %TEMP%\ai_taskbar_state.txt（任务栏）
// 内容：transparent / normal / blur / acrylic
static DWORD WINAPI AutoApplyThreadProc(LPVOID) {
    Log("AutoApply thread entered");
    wchar_t p[MAX_PATH] = {0};
    if (!GetTempPathW(MAX_PATH, p)) { Log("AutoApply GetTempPathW failed"); return 0; }
    wchar_t mod[MAX_PATH] = {0};
    GetModuleFileNameW(NULL, mod, MAX_PATH);
    const bool isStartMenu = (wcsstr(mod, L"StartMenuExperienceHost") != NULL);
    wchar_t fn[MAX_PATH];
    swprintf(fn, MAX_PATH, L"%lsai_%ls_state.txt", p, isStartMenu ? L"startmenu" : L"taskbar");
    Log("AutoApply tmp=%ls fn=%ls", p, fn);
    long target = ReadTargetFromStateFile(fn);
    if (target < 0) { Log("AutoApply no/bad statefile fn=%ls", fn); return 0; }
    Log("AutoApply target=%ld fn=%ls", target, fn);
    // 持续监听：菜单每次打开都会重建 AcrylicBorder/BackgroundFill 等元素（新句柄），
    // 一旦出现目标元素且管道空闲就应用，覆盖"每次打开先闪默认深色再变透明"的闪屏。
    LONG applied = 0;
    LONG lastMatch = 0;
    for (;;) {
        LONG mc = CountFTMatches();
        // 树是异步构建的：元素数量增长 → 有新的白框/背景元素出现 → 重放一次，
        // 直到所有元素都被覆盖（收敛后不再重放）。这样新宿主也不会漏掉后建的元素。
        if (mc > 0 && mc != lastMatch && g_pendingOp == OP_NONE && !g_applying) {
            // ★ 重放前重新读状态文件：用户可能刚切换过效果，沿用旧 target 重放会把外观
            //   打回上一个效果（"切亚克力后每次打开菜单闪一下"的根因）。
            long t2 = ReadTargetFromStateFile(fn);
            if (t2 >= 0 && t2 != target) {
                Log("AutoApply target refresh %ld -> %ld", target, t2);
                target = t2;
            }
            lastMatch = mc;
            int enq = 0;
            LONG seq = SubmitOp(OP_FULL_TRANSPARENT, (unsigned long)target, &enq);
            WaitDone(seq, 3000);
            applied++;
            Log("AutoApply %s seq=%ld enq=%d target=%ld match=%ld applied=%ld", isStartMenu ? "startmenu" : "taskbar", seq, enq, target, mc, applied);
        }
        Sleep(400);
    }
    return 0;
}
struct AdviseCtx { IUnknown* watcher; };

static DWORD WINAPI AdviseThreadProc(LPVOID p) {
    AdviseCtx* ctx = (AdviseCtx*)p;
    HRESULT hr = E_FAIL;
    if (g_vts && ctx->watcher) {
        IVisualTreeServiceCallback* cb = NULL;
        if (SUCCEEDED(ctx->watcher->QueryInterface(IID_IVisualTreeServiceCallback, (void**)&cb)) && cb) {
            hr = g_vts->AdviseVisualTreeChange(cb);
            cb->Release();
        }
    }
    InterlockedExchange(&g_qiHr, (LONG)hr);
    if (SUCCEEDED(hr)) {
        InterlockedExchange(&g_advised, 1);
        InterlockedExchange(&g_attachState, 2);
        HANDLE ha = CreateThread(NULL, 0, AutoApplyThreadProc, NULL, 0, NULL);
        Log("AutoApply spawn ha=%p err=%lu", (void*)ha, (unsigned long)GetLastError());
        if (ha) CloseHandle(ha);
    } else {
        InterlockedExchange(&g_attachState, 3);
    }
    Log("AdviseVisualTreeChange hr=0x%08lx advised=%ld", (unsigned long)hr, g_advised);
    delete ctx;
    return 0;
}

HRESULT STDMETHODCALLTYPE TapSite::SetSite(IUnknown* pUnkSite) {
    if (!pUnkSite) return S_OK;
    if (g_watcherRaw) return E_ILLEGAL_METHOD_CALL;   // 同时只允许一�?watcher

    m_site = pUnkSite;
    m_site->AddRef();
    Log("被调用");

    IUnknown* diagUnk = NULL;
    HRESULT hr = m_site->QueryInterface(IID_IXamlDiagnostics, (void**)&diagUnk);
    if (FAILED(hr) || !diagUnk) {
        Log("QI IXamlDiagnostics 失败 hr=0x%08lx", (unsigned long)hr);
        InterlockedExchange(&g_attachState, 3);
        return hr;
    }
    g_diag = (IXamlDiagnostics*)diagUnk;

    hr = g_diag->QueryInterface(IID_IVisualTreeService3, (void**)&g_vts);
    if (FAILED(hr) || !g_vts) {
        Log("QI IVisualTreeService3 失败 hr=0x%08lx", (unsigned long)hr);
        InterlockedExchange(&g_attachState, 3);
        return hr;
    }

    VisualTreeWatcher* w = new VisualTreeWatcher();
    if (!w) { InterlockedExchange(&g_attachState, 3); return E_OUTOFMEMORY; }
    g_watcherRaw = (IUnknown*)w;    // w 的引用计数初始为 1，我们持�?
    AdviseCtx* ctx = new AdviseCtx();
    ctx->watcher = g_watcherRaw;
    HANDLE h = CreateThread(NULL, 0, AdviseThreadProc, ctx, 0, NULL);
    if (h) CloseHandle(h);
    return S_OK;
}

// ============================================================
// 类工�?+ DllGetClassObject
// ============================================================
class TapClassFactory : public IClassFactory {
    volatile LONG m_ref;

public:
    TapClassFactory() : m_ref(1) {}
    virtual ~TapClassFactory() {}

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override {
        if (!ppv) return E_POINTER;
        if (IsEqualIID(riid, IID_IUnknown) || IsEqualIID(riid, IID_IClassFactory)) {
            *ppv = static_cast<IClassFactory*>(this);
            AddRef();
            return S_OK;
        }
        *ppv = NULL;
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override {
        return (ULONG)InterlockedIncrement(&m_ref);
    }
    ULONG STDMETHODCALLTYPE Release() override {
        LONG r = InterlockedDecrement(&m_ref);
        if (r == 0) delete this;
        return (ULONG)r;
    }

    HRESULT STDMETHODCALLTYPE CreateInstance(IUnknown* pUnkOuter, REFIID riid, void** ppv) override {
        if (!ppv) return E_POINTER;
        if (pUnkOuter) return CLASS_E_NOAGGREGATION;
        Log("IClassFactory::CreateInstance 被调用");
        TapSite* site = new TapSite();                    // ref = 1（我们的
        HRESULT hr = site->QueryInterface(riid, ppv);     // ref = 2：多出来的那份交给 *ppv（XAML 会 Release）
        if (SUCCEEDED(hr)) {
            if (g_tapSite) { g_tapSite->Release(); g_tapSite = NULL; }
            g_tapSite = site;                             // 我们�?1 份，便于以后 DetachSite
        } else {
            site->Release();                              // ref = 0，释
        }
        return hr;
    }
    HRESULT STDMETHODCALLTYPE LockServer(BOOL) override { return S_OK; }
};

extern "C" __declspec(dllexport) HRESULT WINAPI DllGetClassObject(REFCLSID rclsid,
                                                                  REFIID riid, void** ppv) {
    if (!ppv) return E_POINTER;
    if (!IsEqualCLSID(rclsid, CLSID_AILobsterTap)) {
        Log("DllGetClassObject: 未知 CLSID");
        return CLASS_E_CLASSNOTAVAILABLE;
    }
    Log("DllGetClassObject 命中我们CLSID");
    TapClassFactory* f = new TapClassFactory();
    if (!f) return E_OUTOFMEMORY;
    HRESULT hr = f->QueryInterface(riid, ppv);
    f->Release();
    return hr;
}

extern "C" __declspec(dllexport) HRESULT WINAPI DllCanUnloadNow(void) {
    return S_FALSE;   // 保持驻留；卸载走 UNLOAD 命令 + FreeLibraryAndExitThread
}

// ============================================================
// XAML 附着�?0 × 500ms，每次重试必须新开线程
// ============================================================
struct AttemptCtx {
    PFN_INITIALIZE_XAML_DIAGNOSTICS_EX ixde;
    wchar_t conn[64];
    wchar_t dllPath[MAX_PATH];
    DWORD pid;
    HRESULT hr;
};

static DWORD WINAPI AttemptProc(LPVOID p) {
    AttemptCtx* c = (AttemptCtx*)p;
    c->hr = c->ixde(c->conn, c->pid, NULL, c->dllPath, CLSID_AILobsterTap, NULL);
    return 0;
}

static DWORD WINAPI AttachThreadProc(LPVOID) {
    InterlockedExchange(&g_attachState, 1);
    Log("开�?XAML 附着");

    wchar_t dllPath[MAX_PATH] = {0};
    if (!GetModuleFileNameW(g_hModule, dllPath, MAX_PATH)) {
        Log("拿不到自�?DLL 路径 err=%lu", GetLastError());
        InterlockedExchange(&g_attachState, 3);
        return 0;
    }

    HMODULE wux = LoadLibraryExW(L"Windows.UI.Xaml.dll", NULL, LOAD_LIBRARY_SEARCH_SYSTEM32);
    if (!wux) {
        Log("LoadLibraryEx Windows.UI.Xaml.dll 失败 err=%lu", GetLastError());
        InterlockedExchange(&g_attachState, 3);
        return 0;
    }
    PFN_INITIALIZE_XAML_DIAGNOSTICS_EX ixde =
        (PFN_INITIALIZE_XAML_DIAGNOSTICS_EX)GetProcAddress(wux, "InitializeXamlDiagnosticsEx");
    if (!ixde) {
        Log("找不到导�?InitializeXamlDiagnosticsEx err=%lu", GetLastError());
        InterlockedExchange(&g_attachState, 3);
        return 0;
    }
    Log("已拿�?InitializeXamlDiagnosticsEx");

    const DWORD pid = GetCurrentProcessId();
    for (int attempt = 1; attempt <= 60 && g_running; ++attempt) {
        InterlockedExchange(&g_attachAttempts, attempt);

        AttemptCtx ctx;
        ZeroMemory(&ctx, sizeof(ctx));
        ctx.ixde = ixde;
        ctx.pid = pid;
        ctx.hr = E_FAIL;
        const LONG seq = InterlockedIncrement(&g_connSeq);
        swprintf(ctx.conn, 64, L"VisualDiagConnection%ld", (long)seq);
        memcpy(ctx.dllPath, dllPath, sizeof(dllPath));

        // 关键：每次尝试都�?*全新线程**�）
        // InitializeXamlDiagnosticsEx 每个线程只能初始化一次，同线程重复调用只返回 S_OK 却什么都不做
        HANDLE h = CreateThread(NULL, 0, AttemptProc, &ctx, 0, NULL);
        if (h) {
            WaitForSingleObject(h, 30000);
            CloseHandle(h);
        }

        InterlockedExchange(&g_attachHr, (LONG)ctx.hr);
        Log("�?%d 次附着 hr=0x%08lx", attempt, (unsigned long)ctx.hr);

        if (SUCCEEDED(ctx.hr)) {
            // 成功：SetSite 会（�?XAML 的线程上）把 g_attachState 推进�?2
            Log("附着成功（等待 SetSite）");
            return 0;
        }
        Sleep(500);
    }

    Log("附着失败�?0 次重试耗尽");
    InterlockedExchange(&g_attachState, 3);
    return 0;
}

// ============================================================
// M2：DispatcherQueue 捕获 + 外观改写
//
// 为什么需�?DispatcherQueue�）
//   XAML 对象�?*线程亲和**的。上�?taskbarappearanceservice.cpp �?UI 线程（构造期�）
//   �?DispatcherQueue::GetForCurrentThread()，之后用 wil::resume_foreground 把工作搬�?UI 线程�）
//   我们照做，但多一条兜底：视觉树回调本身就跑在 UI 线程上，所�?下次回调时再�?永远可行�）
//
// 免接口改写路径（MinGW 没有 windows.ui.xaml.media.h，也不需要）�）
//   GetPropertyIndex(fillHandle, L"Fill", &idx)                  �?Fill 的属性索�）
//   GetProperty(fillHandle, idx, &brushHandle)                   �?读当前画刷（顺带存原始画刷）
//   CreateInstance(L"Windows.UI.Xaml.Media.SolidColorBrush", L"#AARRGGBB", &brush)
//   SetProperty(fillHandle, brush, idx)                          �?换掉 Fill
// ============================================================

// IAgileObject：无方法的标记接口。handler 要跨线程�?UI 队列，声�?agile 可避免封送失败
static const GUID IID_IAgileObjectAIL =
    {0x94ea2b94, 0xe9cc, 0x49e0, {0xc0, 0xff, 0xee, 0x64, 0xca, 0x8f, 0x5b, 0x90}};

// DispatcherQueue �?handler（delegate）�）
// 注意：ABI �?delegate 派生自 **IUnknown**（不是 IInspectable）→ vtable = QI/AddRef/Release/Invoke�）
// 这与 MinGW windows.system.h 的声明一致（已用 .workbuddy/bench/taskbar/dqprobe.cpp 编译+运行验证）
class EnqueueHandler : public ABI::Windows::System::IDispatcherQueueHandler {
    volatile LONG m_ref;

public:
    EnqueueHandler() : m_ref(1) {}
    virtual ~EnqueueHandler() {}

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override {
        if (!ppv) return E_POINTER;
        if (IsEqualIID(riid, IID_IUnknown) || IsEqualIID(riid, IID_IAgileObjectAIL)) {
            *ppv = static_cast<IUnknown*>(this);
            AddRef();
            return S_OK;
        }
        *ppv = NULL;
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return (ULONG)InterlockedIncrement(&m_ref); }
    ULONG STDMETHODCALLTYPE Release() override {
        LONG r = InterlockedDecrement(&m_ref);
        if (r == 0) delete this;
        return (ULONG)r;
    }
    HRESULT STDMETHODCALLTYPE Invoke() override {
        RunPendingOp(0);      // �?DispatcherQueue 时同样在 XAML UI 线程上，不做文件 I/O
        return S_OK;
    }
};

// MinGW 没有这个常量（RoInitialize 在同一线程重复/不同模式初始化时的返回值，属正常）
#ifndef AIL_RPC_E_CHANGED_MODE
#define AIL_RPC_E_CHANGED_MODE ((HRESULT)0x80010106L)
#endif

// �?�?DispatcherQueue �?*静态工�?*。与线程无关，随便哪个线程都能做�）
//    管道线程（MTA）启动时先做掉，这样 UI 线程上只剩一个极轻的 GetForCurrentThread
static void EnsureQStatics(int allowLog) {
    if (g_qStatics) return;
    if (InterlockedCompareExchange(&g_qStaticsState, 1, 0) != 0) return;   // 只在 0�? 时真正执

    HRESULT hr = RoInitialize(RO_INIT_MULTITHREADED);
    if (FAILED(hr) && hr != AIL_RPC_E_CHANGED_MODE) {
        InterlockedExchange(&g_qStaticsState, 3);
        InterlockedExchange(&g_qHr, (LONG)hr);
        if (allowLog) Log("QD: RoInitialize hr=0x%08lx", (unsigned long)hr);
        return;
    }

    static const wchar_t* kClass = L"Windows.System.DispatcherQueue";
    HSTRING cls = NULL;
    hr = WindowsCreateString(kClass, (UINT32)wcslen(kClass), &cls);
    if (FAILED(hr) || !cls) {
        InterlockedExchange(&g_qStaticsState, 3);
        InterlockedExchange(&g_qHr, (LONG)hr);
        if (allowLog) Log("QD: WindowsCreateString hr=0x%08lx", (unsigned long)hr);
        return;
    }

    ABI::Windows::System::IDispatcherQueueStatics* st = NULL;
    hr = RoGetActivationFactory(cls, IID___x_ABI_CWindows_CSystem_CIDispatcherQueueStatics, (void**)&st);
    WindowsDeleteString(cls);
    if (FAILED(hr) || !st) {
        InterlockedExchange(&g_qStaticsState, 3);
        InterlockedExchange(&g_qHr, (LONG)hr);
        if (allowLog) Log("QD: RoGetActivationFactory hr=0x%08lx", (unsigned long)hr);
        return;
    }
    g_qStatics = st;
    InterlockedExchange(&g_qStaticsState, 2);
    if (allowLog) {
        Log("QD: 静态工厂就绪（tid=%lu，线程无关）�?UI 线程上只需 GetForCurrentThread",
            GetCurrentThreadId());
    }
}

// �?�?*当前线程**上取 DispatcherQueue —�?必须�?XAML UI 线程调用�）
// ⚠️ 实测（dqprobe.cpp）：�?UI 线程�?GetForCurrentThread 返回 **S_OK �?result=NULL**�）
//    所以判据必须是「hr 成功 && 指针非空」，只查 HRESULT 会误判成功
static void CaptureOnUiThread(int allowLog) {
    if (g_uiQueue) return;
    // 静态工厂没就绪就不�?UI 线程上硬�?COM 激活（那正是我们要避免的），留给下次机会
    if (!g_qStatics) return;
    if (InterlockedCompareExchange(&g_qState, 1, 0) != 0) return;

    ABI::Windows::System::IDispatcherQueue* q = NULL;
    const HRESULT hr = g_qStatics->GetForCurrentThread(&q);
    if (FAILED(hr) || !q) {
        InterlockedExchange(&g_qHr, (LONG)hr);
        InterlockedExchange(&g_qState, 3);
        if (allowLog) {
            Log("QD: GetForCurrentThread hr=0x%08lx q=%p（该线程没有 DispatcherQueue）",
                (unsigned long)hr, (void*)q);
        }
        return;
    }

    g_uiQueue = q;
    InterlockedExchange(&g_qTid, (LONG)GetCurrentThreadId());
    InterlockedExchange(&g_qHr, (LONG)hr);
    InterlockedExchange(&g_qState, 2);
    if (allowLog) Log("QD: 捕获成功 tid=%lu", GetCurrentThreadId());
}

// 把待执行操作排到 UI 线程。返�?1 = 已排入（异步完成）；0 = 排不进，调用方走回调兜底
static int TryEnqueueOp() {
    if (!g_uiQueue) return 0;
    EnqueueHandler* h = new EnqueueHandler();
    if (!h) return 0;
    boolean ok = FALSE;
    HRESULT hr = g_uiQueue->TryEnqueue(h, &ok);
    h->Release();
    if (FAILED(hr) || !ok) {
        Log("QD: TryEnqueue hr=0x%08lx ok=%d", (unsigned long)hr, (int)ok);
        return 0;
    }
    InterlockedIncrement(&g_applyViaEnqueue);
    return 1;
}

static LONG SubmitOp(LONG op, unsigned long argb, int* enqueued) {
    const LONG seq = InterlockedIncrement(&g_pendingSeq);
    InterlockedExchange(&g_pendingArgb, (LONG)argb);
    InterlockedExchange(&g_resArgb, (LONG)argb);
    InterlockedExchange(&g_pendingOp, op);
    *enqueued = TryEnqueueOp();
    return seq;
}

static int WaitDone(LONG seq, DWORD ms) {
    const DWORD t0 = GetTickCount();
    while (GetTickCount() - t0 < ms) {
        if (g_doneSeq == seq) return 1;
        Sleep(20);
    }
    return 0;
}

// ============================================================
// M3 真实对象改写辅助函数（必须跑在 UI 线程上，由 RunPendingOp 调用）
//   走"真实对象 + 真实接口"，绕开 VTS SetProperty 在通知中心元素上 E_FAIL 的坑
// ============================================================

// 造一个完全透明的 SolidColorBrush（#00000000 = A=0，画上去等于什么都不画）
static IInspectable* AilCreateTransparentBrush() {
    if (!g_vts) return NULL;
    BSTR tn = SysAllocString(L"Windows.UI.Xaml.Media.SolidColorBrush");
    BSTR vs = SysAllocString(L"#00000000");
    InstanceHandle br = 0;
    HRESULT hr = g_vts->CreateInstance(tn, vs, &br);
    SysFreeString(tn); SysFreeString(vs);
    if (FAILED(hr) || !br) return NULL;
    IInspectable* brush = NULL;
    if (FAILED(g_diag->GetIInspectableFromHandle(br, &brush)) || !brush) return NULL;
    return brush;   // 调用方用完需 Release
}

// 把 brush 应用到 obj 的 Background：IBorder → IPanel → IControl(slot37) 逐级兜底。
// 命中的接口写入 g_bgWhich，返回 put_ 结果。
static HRESULT AilApplyBrush(IInspectable* obj, IInspectable* brush) {
    if (!obj || !brush) return E_INVALIDARG;
    HRESULT hrSet = E_NOINTERFACE;
    InterlockedExchange(&g_bgWhich, 0);
    IBorder* b = NULL;
    if (SUCCEEDED(obj->QueryInterface(IID_IBorder, (void**)&b)) && b) {
        hrSet = b->put_Background((void*)brush);
        b->Release();
        if (SUCCEEDED(hrSet)) { InterlockedExchange(&g_bgWhich, 1); return hrSet; }
    }
    IPanelAIL* p = NULL;
    if (FAILED(hrSet) && SUCCEEDED(obj->QueryInterface(IID_IPanelAIL, (void**)&p)) && p) {
        hrSet = p->put_Background((void*)brush);
        p->Release();
        if (SUCCEEDED(hrSet)) { InterlockedExchange(&g_bgWhich, 2); return hrSet; }
    }
    // 第三层兜底：Control 一族（Frame / ScrollViewer / ListView …），slot 37。
    IControlAIL* c = NULL;
    if (FAILED(hrSet) && SUCCEEDED(obj->QueryInterface(IID_IControlAIL, (void**)&c)) && c) {
        hrSet = AilControlPutBackground(c, (void*)brush);
        c->Release();
        if (SUCCEEDED(hrSet)) { InterlockedExchange(&g_bgWhich, 3); return hrSet; }
    }
    return hrSet;
}

// ============================================================
// Background 原值保存 / 还原
//   AUTOBG 把 Background 换成透明画刷；要支持"关掉效果"就必须能把原画刷放回去
//   （否则用户取消勾选后面板还是一直透明，只能重启宿主 —— 不能这么交付）。
//   接口层与 put 一一对应，实测三个接口的 get_Background 都紧挨在 put 前面一格：
//     IBorder:  get=10 put=11   IPanel: get=7 put=8   IControl: get=36 put=37
//   ⚠️ 保存/还原都**只能在回调线程**上做：拿到的画刷是 STA 对象，
//      换线程调用会 RPC_E_WRONG_THREAD。所以还原走"设标志 + 回调线程执行"。
// ============================================================
#define AIL_BGSAVE_MAX 64
struct BgSave { LONG64 h; void* brush; LONG which; DWORD tid; };
static BgSave g_bgSaves[AIL_BGSAVE_MAX];
static volatile LONG g_bgSaveN = 0;
static CRITICAL_SECTION g_bgSaveCs;
static volatile LONG g_bgSaveCsReady = 0;
static volatile LONG g_bgWantRestore = 0;      // 置位后由回调线程执行还原

typedef HRESULT (STDMETHODCALLTYPE* AilGetObjFn)(void* pThis, void** value);

// 取元素当前 Background 画刷（返回引用，调用方负责 Release）；which 记录命中哪一层
static HRESULT AilGetBackground(IInspectable* obj, void** out, LONG* which) {
    if (!obj || !out) return E_INVALIDARG;
    *out = NULL;
    IBorder* b = NULL;
    if (SUCCEEDED(obj->QueryInterface(IID_IBorder, (void**)&b)) && b) {
        const HRESULT hr = b->get_Background(out);
        b->Release();
        if (SUCCEEDED(hr)) { if (which) *which = 1; return hr; }
    }
    IPanelAIL* p = NULL;
    if (SUCCEEDED(obj->QueryInterface(IID_IPanelAIL, (void**)&p)) && p) {
        const HRESULT hr = p->get_Background(out);
        p->Release();
        if (SUCCEEDED(hr)) { if (which) *which = 2; return hr; }
    }
    IControlAIL* c = NULL;
    if (SUCCEEDED(obj->QueryInterface(IID_IControlAIL, (void**)&c)) && c) {
        void** vt = *(void***)c;
        AilGetObjFn get = (AilGetObjFn)vt[36];
        const HRESULT hr = get(c, out);
        c->Release();
        if (SUCCEEDED(hr)) { if (which) *which = 3; return hr; }
    }
    return E_NOINTERFACE;
}

// 改写前保存原画刷（同一 handle 只存第一次；持有引用防止被回收）
static void AilSaveBackground(LONG64 h, IInspectable* obj) {
    if (!g_bgSaveCsReady) return;
    EnterCriticalSection(&g_bgSaveCs);
    for (LONG i = 0; i < g_bgSaveN && i < AIL_BGSAVE_MAX; i++) {
        if (g_bgSaves[i].h == h) { LeaveCriticalSection(&g_bgSaveCs); return; }
    }
    void* orig = NULL;
    LONG which = 0;
    const HRESULT hr = AilGetBackground(obj, &orig, &which);
    if (SUCCEEDED(hr) && orig) {
        const LONG k = InterlockedIncrement(&g_bgSaveN) - 1;
        if (k < AIL_BGSAVE_MAX) {
            g_bgSaves[k].h = h; g_bgSaves[k].brush = orig;
            g_bgSaves[k].which = which;
            // ⚠️ 必须记住保存时所在的线程：这个画刷是 **STA 对象**，
            //    只能在创建它的那个线程上再 put 回去（跨线程 RPC_E_WRONG_THREAD）。
            g_bgSaves[k].tid = GetCurrentThreadId();
        } else {
            InterlockedDecrement(&g_bgSaveN);
            ((IUnknown*)orig)->Release();
        }
    }
    LeaveCriticalSection(&g_bgSaveCs);
}

// 还原单个元素的原画刷（只在保存它的那个线程上才能成功）
static HRESULT AilRestoreBackground(LONG64 h) {
    if (!g_bgSaveCsReady) return E_FAIL;
    void* brush = NULL;
    EnterCriticalSection(&g_bgSaveCs);
    for (LONG i = 0; i < g_bgSaveN && i < AIL_BGSAVE_MAX; i++) {
        if (g_bgSaves[i].h == h && g_bgSaves[i].brush) {
            if (g_bgSaves[i].tid != GetCurrentThreadId()) break;   // 线程不对：留给该线程上的下一次回调
            brush = g_bgSaves[i].brush;
            g_bgSaves[i].brush = NULL;              // 取走，避免重复还原
            break;
        }
    }
    LeaveCriticalSection(&g_bgSaveCs);
    if (!brush) return E_PENDING;
    IInspectable* obj = NULL;
    HRESULT hr = g_diag ? g_diag->GetIInspectableFromHandle((InstanceHandle)h, &obj) : E_FAIL;
    if (SUCCEEDED(hr) && obj) {
        hr = AilApplyBrush(obj, (IInspectable*)brush);
        obj->Release();
    }
    ((IUnknown*)brush)->Release();
    return hr;
}

// 把元素 Background 换成透明画刷（保留子内容）。
static HRESULT AilSetBackgroundTransparent(LONG64 h) {
    const LONG64 us0 = AilNowUs();              // ★ 诊断：真实 UI 线程成本（含失败尝试）
    IInspectable* obj = NULL;
    HRESULT hr = g_diag ? g_diag->GetIInspectableFromHandle((InstanceHandle)h, &obj) : E_FAIL;
    InterlockedExchange(&g_bgHrGet, (LONG)hr);   // 跨线程拿对象句柄是否可行
    if (FAILED(hr) || !obj) return hr;
    AilSaveBackground(h, obj);          // ★ 先存原画刷，保证之后能还原成系统原生
    // 画刷只造一次然后复用（同线程场景性能更好）。但 WinRT 画刷是 STA 对象，
    // 跨线程用缓存画刷会 RPC_E_WRONG_THREAD —— 见下方兜底。
    if (!g_clearBrush) g_clearBrush = AilCreateTransparentBrush();
    IInspectable* brush = g_clearBrush;
    HRESULT hrSet = E_NOINTERFACE;
    InterlockedExchange(&g_bgHrQI, (LONG)(brush ? S_OK : E_NOINTERFACE));
    if (brush) {
        hrSet = AilApplyBrush(obj, brush);
        // 跨线程：缓存画刷属于别的 STA 公寓，本线程用不了 → 现造一个本线程的画刷重试。
        // （Catchup 路径专门对付这种：面板 island 跑在自己的 UI 线程上。）
        if (hrSet == RPC_E_WRONG_THREAD) {
            IInspectable* fresh = AilCreateTransparentBrush();
            if (fresh) {
                hrSet = AilApplyBrush(obj, fresh);
                fresh->Release();
            }
        }
    } else {
        InterlockedExchange(&g_bgHrQI, (LONG)E_NOINTERFACE);
    }
    InterlockedExchange(&g_bgHrSet, (LONG)hrSet);
    obj->Release();
    // ★ 诊断：累计宿主端耗时（CAS 环防止多 UI 线程累加撕裂）
    {
        const LONG64 us = AilNowUs() - us0;
        InterlockedIncrement(&g_bgCalls);
        if (us > 0) {
            LONG64 prev = g_bgCostUs;
            for (;;) {
                const LONG64 chk = InterlockedCompareExchange64(&g_bgCostUs, prev + us, prev);
                if (chk == prev) break;
                prev = chk;
            }
            LONG64 m = g_bgMaxUs;
            while (us > m) {
                const LONG64 chk = InterlockedCompareExchange64(&g_bgMaxUs, us, m);
                if (chk == m) break;
                m = chk;
            }
        }
    }
    return hrSet;
}

// 宿主进程名判断（GetModuleFileNameW(NULL) 取的是主模块路径）
static BOOL IsHostProcess(const wchar_t* exe) {
    wchar_t p[MAX_PATH] = {0};
    if (!GetModuleFileNameW(NULL, p, MAX_PATH)) return FALSE;
    const wchar_t* b = wcsrchr(p, L'\\');
    b = b ? b + 1 : p;
    return _wcsicmp(b, exe) == 0;
}

// 默认目标名单：通知中心 + 跳转列表的背景元素（都在 ShellExperienceHost 里）。
// ⚠️ 同一个 explorerTap.cpp 也会编成注入 **explorer** 的 DLL（任务栏），用的是同一份
//    默认名单 —— 而 RootGrid / RootContent 这种通用名在任务栏里也存在（实测会命中
//    任务栏自己的根 Grid，把任务栏背景改掉且不受用户设置控制）。所以下面按宿主过滤。
static void AutoBgInitDefaults() {
    if (g_autoBgCount) return;                 // 已经配过就不覆盖
#ifdef AIL_CC_TARGET
    // 快速设置 / WiFi 弹窗专用（注入 ShellHost.exe 的 ControlCenterWindow）。
    // 元素树实测（scripts/probe_cc.py 的 LOG）：
    //   DesktopWindowXamlSource → PopupRoot → RootScrollViewer → ScrollContentPresenter
    //   → Border → ControlCenter.ControlCenterPage
    //     → Grid RootGrid（背景板）
    //       → Grid RootContent → Grid ControlCenterRegion → ControlCenter.ControlCenterView
    static const char* defs[] = {
        "RootGrid",
        "RootContent",
        "ControlCenterRegion"
    };
#elif defined(AIL_TRAY_TARGET)
    // 托盘溢出区专用（注入 explorer.exe）。**绝不能**放 RootGrid/Border 这类通用名 ——
    // 实测 RootGrid 会命中任务栏自己的根 Grid，把任务栏背景也改掉（不受用户设置控制）。
    static const char* defs[] = {
        "OverflowFlyoutBackgroundBorder",      // 溢出面板背景板（Border）
        "OverflowRootGrid"                     // 溢出面板根容器（Grid，兜底）
    };
#else
    static const char* defs[] = {
        "NotificationCenterGrid",              // 通知中心
        "CalendarCenterGrid",
        "RootGrid",
        "RootContent",
        "JumpListRestyledAcrylic",             // 任务栏右键跳转列表（实测的亚克力背景）
        "SystemItemsAcrylic",
        "JumpListGrid"
    };
#endif
    // ⚠️ 不要按宿主过滤通用名！曾经为了"避免命中任务栏自己的 RootGrid"加过
    //    `IsHostProcess("explorer.exe")` 过滤，结果**直接把任务栏的透明效果关掉了** ——
    //    实测任务栏上 FULL_TRANSPARENT(Opacity 路径) 恒 `hrSet=E_FAIL`（属性索引 453 是
    //    开始菜单的属性链索引，任务栏元素不适用），任务栏的透明实际来自 **AUTOBG 改 RootGrid**。
    //    过滤掉通用名 = 任务栏再也不会透明。用户反馈"所有透明效果失效"就是踩了这个。
    const int n = (int)(sizeof(defs) / sizeof(defs[0]));
    int m = 0;
    for (int i = 0; i < n && m < AIL_AUTOBG_MAX; i++) {
        snprintf(g_autoBgNames[m], sizeof(g_autoBgNames[m]), "%s", defs[i]);
        m++;
    }
    InterlockedExchange(&g_autoBgCount, m);
    InterlockedExchange(&g_autoBgEnabled, 1);
}

// ============================================================
// ★ AUTOBG 性能护栏（2026-09-14）：通配符模式下，面板每次打开整棵树每个命名
//   元素都要做一次完整尝试（GetIInspectableFromHandle + 存原画刷 + QI×3 + put），
//   通知中心一次打开上万个元素全压在宿主 UI 线程上 = 打开面板明显卡顿。
//   两个削减手段：
//   ① 类型黑名单：文本/图标/形状类元素没有 Background（QI 三连必败），直接跳过；
//   ② nope 表：QI 三连都失败（E_NOINTERFACE）的元素记录在案，不再重试 ——
//      E_NOINTERFACE 不会因换线程而变，重试只对 RPC_E_WRONG_THREAD 有意义。
//      （此前 catchup 每 200ms 对所有失败元素无限重扫 = 面板开着就持续卡。）
// ============================================================
#define AIL_BGNOPE_MAX 8192
static volatile LONG64 g_bgNopeH[AIL_BGNOPE_MAX];   // 直接映射哈希：碰撞只损失一次重试机会，无害
static BOOL BgNopeHas(LONG64 h) {
    return g_bgNopeH[(SIZE_T)((h >> 4) & (AIL_BGNOPE_MAX - 1))] == h;
}
static void BgNopeAdd(LONG64 h) {
    g_bgNopeH[(SIZE_T)((h >> 4) & (AIL_BGNOPE_MAX - 1))] = h;
}

static char AilLowerCh(char c) { return (c >= 'A' && c <= 'Z') ? (char)(c + 32) : c; }
static BOOL StrIStr(const char* hay, const char* needle) {
    if (!hay || !needle || !needle[0]) return FALSE;
    for (const char* p = hay; *p; p++) {
        const char* a = p; const char* b = needle;
        while (*a && *b && AilLowerCh(*a) == AilLowerCh(*b)) { a++; b++; }
        if (!*b) return TRUE;
    }
    return FALSE;
}
// 这些类型的元素没有 Background 属性（QI IBorder/IPanel/IControl 必败），纯浪费尝试
static BOOL TypeNeverHasBackground(const char* type) {
    if (!type || !type[0]) return FALSE;
    static const char* const never[] = {
        "TextBlock", "Image", "FontIcon", "BitmapIcon", "SymbolIcon", "PathIcon",
        "Rectangle", "Ellipse", "Polygon", "Polyline", "Shape", "Line"
    };
    for (int i = 0; i < (int)(sizeof(never) / sizeof(never[0])); i++)
        if (StrIStr(type, never[i])) return TRUE;
    return FALSE;
}

// ============================================================
// 自动透明（AUTOBG）—— **只能**从视觉树回调里调用
//
// 为什么必须有这条路：ShellExperienceHost 在面板不显示时会被内核冻结，
// 里面的线程（包括命令循环）根本不被调度。所以"打开面板 → 发命令 → 改背景"
// 这条时序极不可靠（实测 4/4 超时）。但面板每次打开/重建，XAML 一定会
// 在 UI 线程上把整棵树重新 Add 一遍 —— 那个回调里改，既保证线程正确，
// 又天然实现"每次打开都自动生效"，正是产品要的行为。
// ============================================================
static void AutoApplyBgIfWanted(const char* name, LONG64 h, int isAdd, const char* type) {
    if (!g_autoBgEnabled || !isAdd || !h || !name || !name[0]) return;
    if (TypeNeverHasBackground(type)) return;      // ★ 性能：必败类型直接跳过
    if (BgNopeHas(h)) return;                      // ★ 性能：确认无 Background 的元素不再重试
    const LONG n = g_autoBgCount;
    // "*" = 名单里出现它就**全部元素都改**（定位"背景板到底是哪个元素"用，
    // 也能直接当成"整个弹层纯透明"的模式）
    BOOL wildcard = FALSE;
    for (LONG i = 0; i < n && i < AIL_AUTOBG_MAX; i++) {
        if (strcmp(g_autoBgNames[i], "*") == 0) { wildcard = TRUE; break; }
    }
    if (!wildcard) {
        BOOL matched = FALSE;
        for (LONG i = 0; i < n && i < AIL_AUTOBG_MAX; i++) {
            if (strcmp(g_autoBgNames[i], name) == 0) { matched = TRUE; break; }
        }
        if (!matched) return;
    }
    const HRESULT hr = AilSetBackgroundTransparent(h);
    InterlockedExchange(&g_autoBgLastHr, (LONG)hr);
    if (SUCCEEDED(hr)) InterlockedIncrement(&g_autoBgApplied);
    else if (hr == E_NOINTERFACE && g_clearBrush) BgNopeAdd(h);   // ★ 确认无 Background，不再重试
    // 记录（UI 线程，只写内存）：type|name|接口|hr|tid
    // tid 用来定位"哪些元素在别的 XAML 线程上"—— 跳转列表的元素实测会
    // RPC_E_WRONG_THREAD（对象解析失败），和通知中心不是一条 UI 线程。
    {
        LONG k = InterlockedIncrement(&g_autoBgLogN) - 1;
        if (k >= 0 && k < AIL_AUTOBG_LOG_MAX) {
            char rec[112];
            snprintf(rec, sizeof(rec), "%s|%s|w%ld|h0x%08lx|t%lu",
                     (type && type[0]) ? type : "?", name,
                     (long)g_bgWhich, (unsigned long)hr,
                     (unsigned long)GetCurrentThreadId());
            // 单次 strncpy，不追加 —— 读方按固定行读，半行也比撕裂好
            strncpy(g_autoBgLog[k], rec, sizeof(g_autoBgLog[k]) - 1);
            g_autoBgLog[k][sizeof(g_autoBgLog[k]) - 1] = 0;
        }
    }
}

// ------------------------------------------------------------
// 补改（AUTOBG-CATCHUP）
//   有些面板的视觉树**在注入之前就建好了**，之后打开只是复用，不再触发 Add
//   （托盘溢出区就是这样：实测打开面板 dBC=0.00，AUTOBG 完全没机会跑）。
//   而且这类 island 跑在自己的 UI 线程上，跨线程调 put_Background 恒
//   RPC_E_WRONG_THREAD —— 所以也不能靠"管道线程发一次性命令"补救。
//   做法：任何一次视觉树回调都顺手重试一遍名单里还没改成功的元素。
//   回调会在各个 island 线程上发生，只要有一次落在正确的线程上就补上了。
//   put_Background 是幂等的（设同一个透明画刷），重复调用无副作用。
// ------------------------------------------------------------
#define AIL_BGDONE_MAX 512
static volatile LONG64 g_bgDoneH[AIL_BGDONE_MAX];   // 已成功改写的 handle
static volatile LONG  g_bgDoneN = 0;
static volatile LONG  g_bgCatchupTries = 0;
static volatile LONG  g_bgCatchupOk = 0;
static volatile LONG  g_bgRestoreOk = 0;      // 已成功还原原画刷的元素数
// 补改限流：回调可能极密集（任务栏每秒上百次），全表扫描没必要每次都做。
static volatile LONG  g_catchupLastMs = 0;
static BOOL CatchupThrottled() {
    const LONG now = (LONG)GetTickCount64();
    const LONG last = g_catchupLastMs;
    if (now - last < 200 && now >= last) return TRUE;   // 非原子读：最坏多跑一次，无副作用
    g_catchupLastMs = now;
    return FALSE;
}

static BOOL BgDoneHas(LONG64 h) {
    const LONG n = g_bgDoneN > AIL_BGDONE_MAX ? AIL_BGDONE_MAX : g_bgDoneN;
    for (LONG i = 0; i < n; i++)
        if (g_bgDoneH[i] == h) return TRUE;
    return FALSE;
}

static BOOL NameInList(const char* name) {
    const LONG n = g_autoBgCount;
    for (LONG i = 0; i < n && i < AIL_AUTOBG_MAX; i++) {
        if (strcmp(g_autoBgNames[i], "*") == 0) return TRUE;
        if (strcmp(g_autoBgNames[i], name) == 0) return TRUE;
    }
    return FALSE;
}

// 注意：必须在**回调线程**上调用；内部不做任何 I/O。
static void AutoBgCatchup() {
    if (!g_autoBgEnabled || !g_enumCsReady) return;
    // 先快照（持锁拷贝），绝不在持锁时调 COM
    LONG64 hs[MAX_ENUM_ELEMENTS];
    char   nms[MAX_ENUM_ELEMENTS][64];
    LONG   cnt = 0;
    EnterCriticalSection(&g_enumCs);
    LONG n = g_enumCount;
    if (n > MAX_ENUM_ELEMENTS) n = MAX_ENUM_ELEMENTS;
    for (LONG i = 0; i < n; i++) {
        if (!g_enumElements[i].handle || !g_enumElements[i].name[0]) continue;
        if (!NameInList(g_enumElements[i].name)) continue;
        if (BgDoneHas(g_enumElements[i].handle)) continue;
        if (BgNopeHas(g_enumElements[i].handle)) continue;   // ★ 确认无 Background 的不再重扫
        hs[cnt] = g_enumElements[i].handle;
        strncpy(nms[cnt], g_enumElements[i].name, 63);
        nms[cnt][63] = 0;
        cnt++;
    }
    LeaveCriticalSection(&g_enumCs);
    if (!cnt) return;
    for (LONG i = 0; i < cnt; i++) {
        InterlockedIncrement(&g_bgCatchupTries);
        const HRESULT hr = AilSetBackgroundTransparent(hs[i]);
        if (SUCCEEDED(hr)) {
            LONG k = InterlockedIncrement(&g_bgDoneN) - 1;
            if (k >= 0 && k < AIL_BGDONE_MAX) g_bgDoneH[k] = hs[i];
            InterlockedIncrement(&g_bgCatchupOk);
        } else if (hr == E_NOINTERFACE && g_clearBrush) {
            BgNopeAdd(hs[i]);   // ★ 无 Background，从补扫名单里除名
        }
    }
}

// 记录表版本：有些宿主（ShellHost 的快速设置）附着时视觉树**已经建好**，
// 之后重开面板也不重建 → g_enumElements 永远是空的（Add 事件是 0 个），
// 但 g_recs 里存着带名字和 handle 的记录 —— 从那里拿目标。
static void AutoBgCatchupFromRecs() {
    if (!g_autoBgEnabled || !g_csReady) return;
    LONG64 hs[MAX_REC];
    LONG   cnt = 0;
    EnterCriticalSection(&g_cs);
    LONG rn = g_recCount;
    if (rn > MAX_REC) rn = MAX_REC;
    for (LONG i = 0; i < rn; i++) {
        Rec* r = &g_recs[i];
        if (!r->handle || !r->name[0]) continue;
        if (!NameInList(r->name)) continue;
        if (BgDoneHas((LONG64)r->handle)) continue;
        if (BgNopeHas((LONG64)r->handle)) continue;   // ★ 确认无 Background 的不再重扫
        hs[cnt++] = (LONG64)r->handle;
    }
    LeaveCriticalSection(&g_cs);
    for (LONG i = 0; i < cnt; i++) {
        InterlockedIncrement(&g_bgCatchupTries);
        const HRESULT hr = AilSetBackgroundTransparent(hs[i]);
        if (SUCCEEDED(hr)) {
            LONG k = InterlockedIncrement(&g_bgDoneN) - 1;
            if (k >= 0 && k < AIL_BGDONE_MAX) g_bgDoneH[k] = hs[i];
            InterlockedIncrement(&g_bgCatchupOk);
        } else if (hr == E_NOINTERFACE && g_clearBrush) {
            BgNopeAdd(hs[i]);   // ★ 无 Background，从补扫名单里除名
        }
    }
}

// ============================================================
// AutoBgTick —— 视觉树回调线程上的总入口（唯一允许改 XAML 的地方）
//   有还原请求（BGRESTORE 命令置位）就先还原原画刷，否则做补改。
//   还原必须在**本线程**执行：原画刷是 STA 对象，拿它去别的线程 put_Background
//   会 RPC_E_WRONG_THREAD。所以命令只置标志，真正干活在这里。
// ============================================================
static void AutoBgTick() {
    const BOOL wantRestore = InterlockedCompareExchange(&g_bgWantRestore, 0, 0) != 0;
    // ⚠️ 有还原待办时**不受节流限制**：面板打开往往只产生一两次回调，
    //    被 200ms 节流吃掉一次就可能再也等不到机会（踩过：restored 恒 0）。
    if (!wantRestore && CatchupThrottled()) return;
    if (wantRestore) {
        if (!g_bgSaveCsReady) return;
        LONG64 hs[AIL_BGSAVE_MAX];
        LONG n = 0;
        EnterCriticalSection(&g_bgSaveCs);
        for (LONG i = 0; i < g_bgSaveN && i < AIL_BGSAVE_MAX; i++)
            if (g_bgSaves[i].brush) hs[n++] = g_bgSaves[i].h;
        LeaveCriticalSection(&g_bgSaveCs);

        LONG ok = 0;
        for (LONG i = 0; i < n; i++)
            if (SUCCEEDED(AilRestoreBackground(hs[i]))) { ok++; InterlockedIncrement(&g_bgRestoreOk); }
        Log("AutoBgTick restore enter n=%ld ok=%ld tid=%lu", (long)n, (long)ok,
            (unsigned long)GetCurrentThreadId());

        if (n == 0 || ok == n) {
            // 全部还原完（或本来就没有要还原的）→ 收工
            InterlockedExchange(&g_bgWantRestore, 0);
            InterlockedExchange(&g_bgDoneN, 0);      // 清空"已改"环，以后可以重新应用
            Log("AutoBgTick restore done n=%ld ok=%ld", (long)n, (long)ok);
        } else {
            // 还有没还原的（多数是"当前线程不是当初保存画刷的那个线程"）
            // → 保持待办，等下一次回调，别把请求丢了。
            Log("AutoBgTick restore partial n=%ld ok=%ld (留待下次回调)", (long)n, (long)ok);
        }
        return;
    }
    AutoBgCatchup();
    AutoBgCatchupFromRecs();      // 附着时树已建好的宿主（ShellHost 快速设置）：目标从 recs 拿
}

// 把元素自身 Opacity 设为 val（0=全透明，整块淡出）。用于对照实验。
static HRESULT AilSetOpacityReal(LONG64 h, double val) {
    IInspectable* obj = NULL;
    HRESULT hr = g_diag ? g_diag->GetIInspectableFromHandle((InstanceHandle)h, &obj) : E_FAIL;
    if (FAILED(hr) || !obj) return hr;
    IUIElementAIL* ui = NULL;
    HRESULT hrQ = obj->QueryInterface(IID_IUIElementAIL, (void**)&ui);
    HRESULT hrSet = E_NOINTERFACE;
    if (SUCCEEDED(hrQ) && ui) {
        hrSet = ui->put_Opacity(val);
        ui->Release();
    }
    obj->Release();
    return hrSet;
}

// ============================================================
// M2 核心：真正去�?XAML。只允许�?UI 线程上执�）
//   （视觉树回调里直接调，或�?DispatcherQueue 排进来）�）
// ============================================================
static void RunPendingOp(int allowLog) {
    if (InterlockedCompareExchange(&g_applying, 1, 0) != 0) return;   // 已在执行，忽略（重入保护

    const LONG op = InterlockedExchange(&g_pendingOp, OP_NONE);
    if (op == OP_NONE) { InterlockedExchange(&g_applying, 0); return; }

    const LONG seq = g_pendingSeq;
    InterlockedIncrement(&g_opCount);
    InterlockedExchange(&g_resOp, op);
    InterlockedExchange(&g_resUiThread, (LONG)GetCurrentThreadId());
    InterlockedExchange(&g_resPropIndex, -1);
    InterlockedExchange(&g_resHrIdx, (LONG)E_UNEXPECTED);
    InterlockedExchange(&g_resHrGet, (LONG)E_UNEXPECTED);
    InterlockedExchange(&g_resHrCreate, (LONG)E_UNEXPECTED);
    InterlockedExchange(&g_resHrColor, (LONG)E_UNEXPECTED);
    InterlockedExchange(&g_resHrSet, (LONG)E_UNEXPECTED);
    InterlockedExchange64(&g_resPrevBrush, 0);
    InterlockedExchange64(&g_resNewBrush, 0);
    g_resBrushClass[0] = '\0';
    g_resEnum[0] = '\0';
    InterlockedExchange(&g_resHrChain, 0);
    InterlockedExchange(&g_fillChainIndex, -1);
    InterlockedExchange(&g_resHrRect, (LONG)E_UNEXPECTED);
    InterlockedExchange(&g_resHrShape, (LONG)E_UNEXPECTED);
    InterlockedExchange(&g_resHrBrush, (LONG)E_UNEXPECTED);

    if (op == OP_QICAP) {
        EnsureQStatics(allowLog);       // 线程无关（管道线程启动时通常已就绪，这里是兜底）
        CaptureOnUiThread(allowLog);    // 需�?UI 线程
        InterlockedExchange(&g_doneSeq, seq);
        InterlockedExchange(&g_applying, 0);
        return;
    }

    // OP_DUMP_PROPS: �?UI 线程�?dump 指定元素的完整属性链（诊断用
    if (op == OP_DUMP_PROPS) {
        LONG target = g_dumpTarget;
        g_dumpBuf[0] = 0;
        if (target >= 0 && target < g_enumCount && target < MAX_ENUM_ELEMENTS) {
            LONG64 h = (LONG64)g_enumElements[target].handle;
            if (h) {
                IInspectable* obj = NULL;
                if (SUCCEEDED(g_diag->GetIInspectableFromHandle((InstanceHandle)h, &obj)) && obj) {
                    unsigned int sc = 0, vc = 0;
                    PropertyChainSource* ps = NULL;
                    PropertyChainValue* pv = NULL;
                    char line[16384] = {0};
                    int pos = 0;
                    HRESULT hr = g_vts ? g_vts->GetPropertyValuesChain((InstanceHandle)h, &sc, &ps, &vc, &pv) : E_FAIL;
                    pos += snprintf(line + pos, sizeof(line) - pos, "P|%ld|%s|%s|CHAIN hr=0x%08lx vc=%u | ",
                                    target, g_enumElements[target].type, g_enumElements[target].name,
                                    (unsigned long)hr, vc);
                    if (SUCCEEDED(hr) && pv) {
                        for (unsigned int j = 0; j < vc && pos < (int)sizeof(line) - 200; j++) {
                            char nm[48] = {0}, t[48] = {0};
                            if (pv[j].PropertyName) NarrowCopy(nm, sizeof(nm), pv[j].PropertyName);
                            if (pv[j].Type) NarrowCopy(t, sizeof(t), pv[j].Type);
                            pos += snprintf(line + pos, sizeof(line) - pos, "[%u]%s(idx=%u)", j, nm, pv[j].Index);
                            if (pv[j].Value && pv[j].Value[0]) {
                                char val[64] = {0};
                                NarrowCopy(val, sizeof(val), pv[j].Value);
                                pos += snprintf(line + pos, sizeof(line) - pos, "=%s", val);
                            }
                            pos += snprintf(line + pos, sizeof(line) - pos, " ");
                        }
                        for (unsigned int j = 0; j < vc; j++) {
                            if (pv[j].PropertyName) SysFreeString(pv[j].PropertyName);
                            if (pv[j].Type) SysFreeString(pv[j].Type);
                            if (pv[j].DeclaringType) SysFreeString(pv[j].DeclaringType);
                            if (pv[j].ValueType) SysFreeString(pv[j].ValueType);
                            if (pv[j].ItemType) SysFreeString(pv[j].ItemType);
                            if (pv[j].Value) SysFreeString(pv[j].Value);
                        }
                        if (ps) { for (unsigned int j = 0; j < sc; j++) { if (ps[j].TargetType) SysFreeString(ps[j].TargetType); if (ps[j].Name) SysFreeString(ps[j].Name); } }
                        CoTaskMemFree(pv); CoTaskMemFree(ps);
                    }
                    obj->Release();
                    memcpy(g_dumpBuf, line, sizeof(line));
                }
            }
        }
        InterlockedExchange(&g_doneSeq, seq);
        InterlockedExchange(&g_applying, 0);
        return;
    }

    // OP_DUMPVALS: 全量元素用 GetProperty 探测 Background/Backdrop/Fill 画刷是否非空
    if (op == OP_DUMPVALS) {
        char line[16384] = {0};
        int pos = 0;
        int total = 0, hits = 0;
        LONG enumCount = g_enumCount;
        for (LONG i = 0; i < enumCount && i < MAX_ENUM_ELEMENTS && pos < (int)sizeof(line) - 1400; i++) {
            InstanceHandle h = (InstanceHandle)g_enumElements[i].handle;
            if (!h) continue;
            total++;
            static const wchar_t* names[] = { L"Background", L"BackdropBrush", L"Fill", L"BackdropMaterial.ApplyToRootOrPageBackground", L"BackdropMaterial.State", L"Opacity" };
            char hit[384] = {0};
            int hp = 0;
            for (int pi = 0; pi < 6; pi++) {
                unsigned int idx = 0;
                HRESULT hri = g_vts ? g_vts->GetPropertyIndex(h, names[pi], &idx) : E_FAIL;
                if (SUCCEEDED(hri)) {
                    InstanceHandle val = 0;
                    HRESULT hrg = g_vts->GetProperty(h, idx, &val);
                    if (SUCCEEDED(hrg) && val) {
                        char cbuf[96] = {0};
                        IInspectable* vobj = NULL;
                        if (SUCCEEDED(g_diag->GetIInspectableFromHandle(val, &vobj)) && vobj) {
                            HSTRING hs = NULL;
                            if (SUCCEEDED(vobj->GetRuntimeClassName(&hs)) && hs) {
                                UINT32 hlen = 0;
                                const wchar_t* wcls = WindowsGetStringRawBuffer(hs, &hlen);
                                if (wcls) NarrowCopy(cbuf, sizeof(cbuf), wcls);
                                WindowsDeleteString(hs);
                            }
                            vobj->Release();
                        }
                        if (cbuf[0]) {
                            hp += snprintf(hit + hp, sizeof(hit) - hp, "%ls(idx=%u)=%s; ", names[pi], idx, cbuf);
                        } else {
                            hp += snprintf(hit + hp, sizeof(hit) - hp, "%ls(idx=%u)=handle; ", names[pi], idx);
                        }
                        hits++;
                    }
                }
            }
            if (hit[0]) {
                pos += snprintf(line + pos, sizeof(line) - pos, "\nE%d %s %s: %s", (int)i, g_enumElements[i].name, g_enumElements[i].type, hit);
            }
        }
        pos += snprintf(line + pos, sizeof(line) - pos, "\nSUMMARY total=%d hits=%d", total, hits);
        memcpy(g_dumpBuf, line, sizeof(line));
        InterlockedExchange(&g_doneSeq, seq);
        InterlockedExchange(&g_applying, 0);
        return;
    }

    // OP_BGCLASS: 打印枚举元素 Background 画刷的运行时类
    if (op == OP_BGCLASS) {
        char line[2048] = {0};
        int pos = 0;
        LONG target = g_dumpTarget;
        if (target >= 0 && target < g_enumCount) {
            InstanceHandle h = (InstanceHandle)g_enumElements[target].handle;
            if (h) {
                unsigned int sc = 0, vc = 0;
                PropertyChainSource* ps = NULL;
                PropertyChainValue* pv = NULL;
                HRESULT hr = g_vts ? g_vts->GetPropertyValuesChain(h, &sc, &ps, &vc, &pv) : E_FAIL;
                if (SUCCEEDED(hr) && pv) {
                    pos += snprintf(line + pos, sizeof(line) - pos, "E%d %s %s:", (int)target, g_enumElements[target].name, g_enumElements[target].type);
                    for (unsigned int j = 0; j < vc && pos < (int)sizeof(line) - 200; j++) {
                        char nm[64] = {0};
                        if (pv[j].PropertyName) NarrowCopy(nm, sizeof(nm), pv[j].PropertyName);
                        if (strstr(nm, "Background") || strstr(nm, "BorderBrush")) {
                            const wchar_t* vw = pv[j].Value;
                            if (vw && vw[0] && wcscmp(vw, L"0") != 0) {
                                unsigned long long hv = _wcstoui64(vw, NULL, 10);
                                char cbuf[160] = {0};
                                if (hv) {
                                    IInspectable* vobj = NULL;
                                    if (SUCCEEDED(g_diag->GetIInspectableFromHandle((InstanceHandle)hv, &vobj)) && vobj) {
                                        HSTRING hs = NULL;
                                        if (SUCCEEDED(vobj->GetRuntimeClassName(&hs)) && hs) {
                                            UINT32 hlen = 0;
                                            const wchar_t* wcls = WindowsGetStringRawBuffer(hs, &hlen);
                                            if (wcls) NarrowCopy(cbuf, sizeof(cbuf), wcls);
                                            WindowsDeleteString(hs);
                                        }
                                        vobj->Release();
                                    }
                                }
                                pos += snprintf(line + pos, sizeof(line) - pos, " [%s(idx=%u)=0x%llx:%s]", nm, pv[j].Index, hv, cbuf[0] ? cbuf : "?");
                            }
                        }
                    }
                    for (unsigned int j = 0; j < vc; j++) {
                        if (pv[j].PropertyName) SysFreeString(pv[j].PropertyName);
                        if (pv[j].Type) SysFreeString(pv[j].Type);
                        if (pv[j].DeclaringType) SysFreeString(pv[j].DeclaringType);
                        if (pv[j].ValueType) SysFreeString(pv[j].ValueType);
                        if (pv[j].ItemType) SysFreeString(pv[j].ItemType);
                        if (pv[j].Value) SysFreeString(pv[j].Value);
                    }
                    if (ps) { for (unsigned int j = 0; j < sc; j++) { if (ps[j].TargetType) SysFreeString(ps[j].TargetType); if (ps[j].Name) SysFreeString(ps[j].Name); } }
                    CoTaskMemFree(pv); CoTaskMemFree(ps);
                }
            }
        }
        memcpy(g_dumpBuf, line, sizeof(line));
        InterlockedExchange(&g_doneSeq, seq);
        InterlockedExchange(&g_applying, 0);
        return;
    }

    // OP_PUTBG: 用 IBorder::put_Background 把元素 Background 换成纯色画刷（权威设置器）
    if (op == OP_PUTBG) {
        char line[1024] = {0};
        int pos = 0;
        LONG target = g_dumpTarget;
        HRESULT hrQ = E_FAIL, hrC = E_FAIL, hrSet = E_FAIL;
        if (target >= 0 && target < g_enumCount) {
            InstanceHandle h = (InstanceHandle)g_enumElements[target].handle;
            if (h) {
                IInspectable* obj = NULL;
                hrQ = g_diag->GetIInspectableFromHandle(h, &obj);
                if (SUCCEEDED(hrQ) && obj) {
                    IBorder* border = NULL;
                    HRESULT hrI = obj->QueryInterface(IID_IBorder, (void**)&border);
                    if (SUCCEEDED(hrI) && border) {
                        BSTR tn = SysAllocString(L"Windows.UI.Xaml.Media.SolidColorBrush");
                        InstanceHandle br = 0;
                        hrC = g_vts ? g_vts->CreateInstance(tn, NULL, &br) : E_FAIL;
                        SysFreeString(tn);
                        if (SUCCEEDED(hrC) && br) {
                            IInspectable* bobj = NULL;
                            if (SUCCEEDED(g_diag->GetIInspectableFromHandle(br, &bobj)) && bobj) {
                                unsigned int sc2 = 0, vc2 = 0;
                                PropertyChainSource* ps2 = NULL;
                                PropertyChainValue* pv2 = NULL;
                                unsigned int colorIdx = (unsigned int)-1;
                                if (SUCCEEDED(g_vts->GetPropertyValuesChain(br, &sc2, &ps2, &vc2, &pv2)) && pv2) {
                                    for (unsigned int j = 0; j < vc2; j++) {
                                        char nm[64] = {0};
                                        if (pv2[j].PropertyName) NarrowCopy(nm, sizeof(nm), pv2[j].PropertyName);
                                        if (strcmp(nm, "Color") == 0) colorIdx = pv2[j].Index;
                                    }
                                    for (unsigned int j = 0; j < vc2; j++) {
                                        if (pv2[j].PropertyName) SysFreeString(pv2[j].PropertyName);
                                        if (pv2[j].Type) SysFreeString(pv2[j].Type);
                                        if (pv2[j].DeclaringType) SysFreeString(pv2[j].DeclaringType);
                                        if (pv2[j].ValueType) SysFreeString(pv2[j].ValueType);
                                        if (pv2[j].ItemType) SysFreeString(pv2[j].ItemType);
                                        if (pv2[j].Value) SysFreeString(pv2[j].Value);
                                    }
                                    if (ps2) { for (unsigned int j = 0; j < sc2; j++) { if (ps2[j].TargetType) SysFreeString(ps2[j].TargetType); if (ps2[j].Name) SysFreeString(ps2[j].Name); } }
                                    CoTaskMemFree(pv2); CoTaskMemFree(ps2);
                                }
                                if (colorIdx != (unsigned int)-1) {
                                    wchar_t cv[16];
                                    swprintf(cv, 16, L"#%08lX", (unsigned long)g_resArgb);
                                    BSTR ct = SysAllocString(L"Windows.UI.Color");
                                    BSTR cs = SysAllocString(cv);
                                    InstanceHandle colorObj = 0;
                                    HRESULT hrCol = g_vts->CreateInstance(ct, cs, &colorObj);
                                    SysFreeString(ct); SysFreeString(cs);
                                    if (SUCCEEDED(hrCol) && colorObj) {
                                        g_vts->SetProperty(br, colorObj, colorIdx);
                                        hrSet = border->put_Background((void*)bobj);
                                    }
                                }
                                bobj->Release();
                            }
                        }
                        border->Release();
                    } else {
                        pos += snprintf(line + pos, sizeof(line) - pos, "PUTBG not-IBorder hrI=0x%08lx", (unsigned long)hrI);
                    }
                    obj->Release();
                }
            }
        }
        pos += snprintf(line + pos, sizeof(line) - pos, "PUTBG target=%ld argb=0x%08lx hrQ=0x%08lx hrC=0x%08lx hrSet=0x%08lx", target, (unsigned long)g_resArgb, (unsigned long)hrQ, (unsigned long)hrC, (unsigned long)hrSet);
        memcpy(g_dumpBuf, line, sizeof(line));
        InterlockedExchange(&g_doneSeq, seq);
        InterlockedExchange(&g_applying, 0);
        return;
    }

    // OP_ACRYLIC_KILL: 对元素 Background 链上的每个 AcrylicBrush 置 TintOpacity=0 与 TintLuminosityOpacity=0
    if (op == OP_ACRYLIC_KILL) {
        char line[4096] = {0};
        int pos = 0;
        LONG target = g_dumpTarget;
        if (target >= 0 && target < g_enumCount) {
            InstanceHandle h = (InstanceHandle)g_enumElements[target].handle;
            if (h) {
                unsigned int sc = 0, vc = 0;
                PropertyChainSource* ps = NULL;
                PropertyChainValue* pv = NULL;
                HRESULT hr = g_vts ? g_vts->GetPropertyValuesChain(h, &sc, &ps, &vc, &pv) : E_FAIL;
                if (SUCCEEDED(hr) && pv) {
                    int brushes = 0;
                    for (unsigned int j = 0; j < vc && pos < (int)sizeof(line) - 300; j++) {
                        char nm[64] = {0};
                        if (pv[j].PropertyName) NarrowCopy(nm, sizeof(nm), pv[j].PropertyName);
                        if (strstr(nm, "Background")) {
                            const wchar_t* vw = pv[j].Value;
                            if (vw && vw[0] && wcscmp(vw, L"0") != 0) {
                                unsigned long long hv = _wcstoui64(vw, NULL, 10);
                                if (hv) {
                                    IInspectable* vobj = NULL;
                                    if (SUCCEEDED(g_diag->GetIInspectableFromHandle((InstanceHandle)hv, &vobj)) && vobj) {
                                        HSTRING hs = NULL;
                                        char cbuf[128] = {0};
                                        if (SUCCEEDED(vobj->GetRuntimeClassName(&hs)) && hs) {
                                            UINT32 hlen = 0;
                                            const wchar_t* wcls = WindowsGetStringRawBuffer(hs, &hlen);
                                            if (wcls) NarrowCopy(cbuf, sizeof(cbuf), wcls);
                                            WindowsDeleteString(hs);
                                        }
                                        if (strstr(cbuf, "AcrylicBrush")) {
                                            brushes++;
                                            IAcrylicBrushAIL* acrylic = NULL;
                                            HRESULT hrQ = vobj->QueryInterface(IID_IAcrylicBrushAIL, (void**)&acrylic);
                                            pos += snprintf(line + pos, sizeof(line) - pos, "B%d h=0x%llx QI=0x%08lx", brushes, hv, (unsigned long)hrQ);
                                            if (SUCCEEDED(hrQ) && acrylic) {
                                                double to = -1, tl = -1, to2 = -1, tl2 = -1;
                                                HRESULT hrT1 = acrylic->get_TintOpacity(&to);
                                                HRESULT hrL1 = acrylic->get_TintLuminosityOpacity(&tl);
                                                pos += snprintf(line + pos, sizeof(line) - pos, " getTO=0x%08lx(%f) getTL=0x%08lx(%f)", (unsigned long)hrT1, to, (unsigned long)hrL1, tl);
                                                HRESULT hrT = acrylic->put_TintOpacity(0.0);
                                                HRESULT hrL = acrylic->put_TintLuminosityOpacity(0.0);
                                                HRESULT hrT2 = acrylic->get_TintOpacity(&to2);
                                                HRESULT hrL2 = acrylic->get_TintLuminosityOpacity(&tl2);
                                                pos += snprintf(line + pos, sizeof(line) - pos, " putTO=0x%08lx putTL=0x%08lx afterTO=%f afterTL=%f", (unsigned long)hrT, (unsigned long)hrL, to2, tl2);
                                                acrylic->Release();
                                            }
                                            pos += snprintf(line + pos, sizeof(line) - pos, " | ");
                                        }
                                        vobj->Release();
                                    }
                                }
                            }
                        }
                    }
                    pos += snprintf(line + pos, sizeof(line) - pos, "ACRYLIC_KILL target=%ld brushes=%d", target, brushes);
                    for (unsigned int j = 0; j < vc; j++) {
                        if (pv[j].PropertyName) SysFreeString(pv[j].PropertyName);
                        if (pv[j].Type) SysFreeString(pv[j].Type);
                        if (pv[j].DeclaringType) SysFreeString(pv[j].DeclaringType);
                        if (pv[j].ValueType) SysFreeString(pv[j].ValueType);
                        if (pv[j].ItemType) SysFreeString(pv[j].ItemType);
                        if (pv[j].Value) SysFreeString(pv[j].Value);
                    }
                    if (ps) { for (unsigned int j = 0; j < sc; j++) { if (ps[j].TargetType) SysFreeString(ps[j].TargetType); if (ps[j].Name) SysFreeString(ps[j].Name); } }
                    CoTaskMemFree(pv); CoTaskMemFree(ps);
                } else {
                    pos += snprintf(line + pos, sizeof(line) - pos, "ACRYLIC_KILL chain hr=0x%08lx", (unsigned long)hr);
                }
            }
        }
        memcpy(g_dumpBuf, line, sizeof(line));
        InterlockedExchange(&g_doneSeq, seq);
        InterlockedExchange(&g_applying, 0);
        return;
    }

    // OP_ACRYLIC_KILL2: 用 PropertyValue 装箱 double 经 SetProperty 把 AcrylicBrush 的 TintOpacity/LuminosityOpacity 置 0
    if (op == OP_ACRYLIC_KILL2) {
        char line[4096] = {0};
        int pos = 0;
        LONG target = g_dumpTarget;
        HRESULT hrPV = E_FAIL;
        if (target >= 0 && target < g_enumCount) {
            InstanceHandle h = (InstanceHandle)g_enumElements[target].handle;
            if (h) {
                unsigned int sc = 0, vc = 0;
                PropertyChainSource* ps = NULL;
                PropertyChainValue* pv = NULL;
                HRESULT hr = g_vts ? g_vts->GetPropertyValuesChain(h, &sc, &ps, &vc, &pv) : E_FAIL;
                if (SUCCEEDED(hr) && pv) {
                    int brushes = 0;
                    for (unsigned int j = 0; j < vc && pos < (int)sizeof(line) - 300; j++) {
                        char nm[64] = {0};
                        if (pv[j].PropertyName) NarrowCopy(nm, sizeof(nm), pv[j].PropertyName);
                        if (strstr(nm, "Background")) {
                            const wchar_t* vw = pv[j].Value;
                            if (vw && vw[0] && wcscmp(vw, L"0") != 0) {
                                unsigned long long hv = _wcstoui64(vw, NULL, 10);
                                if (hv) {
                                    IInspectable* vobj = NULL;
                                    if (SUCCEEDED(g_diag->GetIInspectableFromHandle((InstanceHandle)hv, &vobj)) && vobj) {
                                        HSTRING hs = NULL;
                                        char cbuf[128] = {0};
                                        if (SUCCEEDED(vobj->GetRuntimeClassName(&hs)) && hs) {
                                            UINT32 hlen = 0;
                                            const wchar_t* wcls = WindowsGetStringRawBuffer(hs, &hlen);
                                            if (wcls) NarrowCopy(cbuf, sizeof(cbuf), wcls);
                                            WindowsDeleteString(hs);
                                        }
                                        if (strstr(cbuf, "AcrylicBrush")) {
                                            brushes++;
                                            unsigned int bsc = 0, bvc = 0;
                                            PropertyChainSource* bps = NULL;
                                            PropertyChainValue* bpv = NULL;
                                            HRESULT hrB = g_vts->GetPropertyValuesChain((InstanceHandle)hv, &bsc, &bps, &bvc, &bpv);
                                            unsigned int tintIdx = (unsigned int)-1, lumIdx = (unsigned int)-1, srcIdx = (unsigned int)-1;
                                            const wchar_t* tintV = NULL; const wchar_t* lumV = NULL; const wchar_t* srcV = NULL;
                                            if (SUCCEEDED(hrB) && bpv) {
                                                for (unsigned int k = 0; k < bvc; k++) {
                                                    char bnm[64] = {0};
                                                    if (bpv[k].PropertyName) NarrowCopy(bnm, sizeof(bnm), bpv[k].PropertyName);
                                                    if (strcmp(bnm, "TintOpacity") == 0) { tintIdx = bpv[k].Index; tintV = bpv[k].Value; }
                                                    else if (strcmp(bnm, "LuminosityOpacity") == 0) { lumIdx = bpv[k].Index; lumV = bpv[k].Value; }
                                                    else if (strcmp(bnm, "BackgroundSource") == 0) { srcIdx = bpv[k].Index; srcV = bpv[k].Value; }
                                                }
                                                pos += snprintf(line + pos, sizeof(line) - pos, "B%d tint[idx=%u]=%ls lum[idx=%u]=%ls src[idx=%u]=%ls", brushes, tintIdx, tintV ? tintV : L"?", lumIdx, lumV ? lumV : L"?", srcIdx, srcV ? srcV : L"?");
                                                // 值装箱：优先 VTS CreateInstance 造 Windows.Foundation.Double，失败再走 PropertyValue
                                                IInspectable* boxed = NULL;
                                                InstanceHandle boxedH = 0;
                                                BSTR dtn = SysAllocString(L"Windows.Foundation.Double");
                                                BSTR dvs = SysAllocString(L"0");
                                                HRESULT hrCI = g_vts->CreateInstance(dtn, dvs, &boxedH);
                                                SysFreeString(dtn); SysFreeString(dvs);
                                                hrPV = hrCI;
                                                if (FAILED(hrCI) || !boxedH) {
                                                    ABI::Windows::Foundation::IPropertyValueStatics* pvs = NULL;
                                                    HSTRING hsClass = NULL;
                                                    WindowsCreateString(L"Windows.Foundation.PropertyValue", 30, &hsClass);
                                                    HRESULT hrS = RoGetActivationFactory(
                                                        hsClass
                                                        , IID_IPVS
                                                        , (void**)&pvs);
                                                    if (hsClass) { WindowsDeleteString(hsClass); hsClass = NULL; }
                                                    hrPV = hrS;
                                                    if (SUCCEEDED(hrS) && pvs) {
                                                        hrPV = pvs->CreateDouble(0.0, &boxed);
                                                        pvs->Release();
                                                        if (SUCCEEDED(hrPV) && boxed) {
                                                            HRESULT hrH = g_diag->GetHandleFromIInspectable(boxed, &boxedH);
                                                            if (FAILED(hrH)) boxedH = 0;
                                                        }
                                                    }
                                                }
                                                if (boxedH) {
                                                    HRESULT hrT = E_FAIL, hrL = E_FAIL;
                                                    if (tintIdx != (unsigned int)-1) hrT = g_vts->SetProperty((InstanceHandle)hv, boxedH, tintIdx);
                                                    if (lumIdx != (unsigned int)-1) hrL = g_vts->SetProperty((InstanceHandle)hv, boxedH, lumIdx);
                                                    pos += snprintf(line + pos, sizeof(line) - pos, " ci=0x%08lx setT=0x%08lx setL=0x%08lx", (unsigned long)hrCI, (unsigned long)hrT, (unsigned long)hrL);
                                                } else {
                                                    pos += snprintf(line + pos, sizeof(line) - pos, " boxed-fail hrPV=0x%08lx", (unsigned long)hrPV);
                                                }
                                                if (boxed) boxed->Release();
                                                for (unsigned int k = 0; k < bvc; k++) {
                                                    if (bpv[k].PropertyName) SysFreeString(bpv[k].PropertyName);
                                                    if (bpv[k].Type) SysFreeString(bpv[k].Type);
                                                    if (bpv[k].DeclaringType) SysFreeString(bpv[k].DeclaringType);
                                                    if (bpv[k].ValueType) SysFreeString(bpv[k].ValueType);
                                                    if (bpv[k].ItemType) SysFreeString(bpv[k].ItemType);
                                                    if (bpv[k].Value) SysFreeString(bpv[k].Value);
                                                }
                                                if (bps) { for (unsigned int k = 0; k < bsc; k++) { if (bps[k].TargetType) SysFreeString(bps[k].TargetType); if (bps[k].Name) SysFreeString(bps[k].Name); } }
                                                CoTaskMemFree(bpv); CoTaskMemFree(bps);
                                            } else {
                                                pos += snprintf(line + pos, sizeof(line) - pos, "B%d brushChain hr=0x%08lx", brushes, (unsigned long)hrB);
                                            }
                                            pos += snprintf(line + pos, sizeof(line) - pos, " | ");
                                        }
                                        vobj->Release();
                                    }
                                }
                            }
                        }
                    }
                    pos += snprintf(line + pos, sizeof(line) - pos, "ACRYLIC_KILL2 target=%ld brushes=%d", target, brushes);
                    for (unsigned int j = 0; j < vc; j++) {
                        if (pv[j].PropertyName) SysFreeString(pv[j].PropertyName);
                        if (pv[j].Type) SysFreeString(pv[j].Type);
                        if (pv[j].DeclaringType) SysFreeString(pv[j].DeclaringType);
                        if (pv[j].ValueType) SysFreeString(pv[j].ValueType);
                        if (pv[j].ItemType) SysFreeString(pv[j].ItemType);
                        if (pv[j].Value) SysFreeString(pv[j].Value);
                    }
                    if (ps) { for (unsigned int j = 0; j < sc; j++) { if (ps[j].TargetType) SysFreeString(ps[j].TargetType); if (ps[j].Name) SysFreeString(ps[j].Name); } }
                    CoTaskMemFree(pv); CoTaskMemFree(ps);
                } else {
                    pos += snprintf(line + pos, sizeof(line) - pos, "ACRYLIC_KILL2 chain hr=0x%08lx", (unsigned long)hr);
                }
            }
        }
        memcpy(g_dumpBuf, line, sizeof(line));
        InterlockedExchange(&g_doneSeq, seq);
        InterlockedExchange(&g_applying, 0);
        return;
    }

    // OP_OPACITY: 把元素 Opacity(idx=453) 设为 g_pendingArg (0-1000 → 0.000-1.000)
    if (op == OP_OPACITY) {
        char line[1024] = {0};
        int pos = 0;
        LONG target = g_dumpTarget;
        HRESULT hrCI = E_FAIL, hrSet = E_FAIL;
        double val = (double)g_pendingArgb / 1000.0;
        if (target >= 0 && target < g_enumCount) {
            InstanceHandle h = (InstanceHandle)g_enumElements[target].handle;
            if (h) {
                BSTR dtn = SysAllocString(L"Windows.Foundation.Double");
                char vs[32]; snprintf(vs, sizeof(vs), "%f", val);
                BSTR dvs = SysAllocStringLen(NULL, (UINT)strlen(vs));
                for (size_t k = 0; k < strlen(vs); k++) dvs[k] = (OLECHAR)vs[k];
                dvs[strlen(vs)] = 0;
                InstanceHandle boxedH = 0;
                hrCI = g_vts->CreateInstance(dtn, dvs, &boxedH);
                SysFreeString(dtn); SysFreeString(dvs);
                if (SUCCEEDED(hrCI) && boxedH) {
                    hrSet = g_vts->SetProperty(h, boxedH, 453);
                }
                if (boxedH) g_diag->GetIInspectableFromHandle(boxedH, NULL);
            }
        }
        pos += snprintf(line + pos, sizeof(line) - pos, "OPACITY target=%ld val=%f hrCI=0x%08lx hrSet=0x%08lx", target, val, (unsigned long)hrCI, (unsigned long)hrSet);
        memcpy(g_dumpBuf, line, sizeof(line));
        InterlockedExchange(&g_doneSeq, seq);
        InterlockedExchange(&g_applying, 0);
        return;
    }

    // OP_FULL_TRANSPARENT: 按名称定位背景/边框元素，把 Opacity(idx=453) 置为 arg/1000
    //   参数：0=全透明（壁纸原样透出）、1000=完全恢复、中间值=半透明（模拟模糊/亚克力）
    //   开始菜单名单：AcrylicBorder（模糊源）、StartDropShadow / MaxHeightEnforcer /
    //     DropShadowDismissTarget / StartBlendedFlexFrame（白框/窗体边框）、
    //     BackgroundBorder / BorderElement / MoreSuggestionsBackground（搜索框等内层白底）
    //   任务栏名单：BackgroundFill / BackgroundStroke / BackgroundControl
    if (op == OP_FULL_TRANSPARENT) {
        static const char* kFTNames[] = {
            "AcrylicBorder", "StartDropShadow", "DropShadowDismissTarget",
            "MaxHeightEnforcer", "StartBlendedFlexFrame", "BackgroundBorder",
            "BorderElement", "MoreSuggestionsBackground", "BackgroundFill",
            "BackgroundStroke", "BackgroundControl"
        };
        const int kFTNameCount = (int)(sizeof(kFTNames) / sizeof(kFTNames[0]));
        char line[1024] = {0};
        int pos = 0;
        LONG enumCount = g_enumCount;
        LONG found = 0;
        HRESULT hrCI = E_FAIL, hrSet = E_FAIL;
        double val = (double)g_pendingArgb / 1000.0;
        if (val < 0.0) val = 0.0; else if (val > 1.0) val = 1.0;
        BSTR dtn = SysAllocString(L"Windows.Foundation.Double");
        char vs[32]; snprintf(vs, sizeof(vs), "%f", val);
        BSTR dvs = SysAllocStringLen(NULL, (UINT)strlen(vs));
        for (size_t k = 0; k < strlen(vs); k++) dvs[k] = (OLECHAR)vs[k];
        dvs[strlen(vs)] = 0;
        InstanceHandle boxedH = 0;
        hrCI = g_vts->CreateInstance(dtn, dvs, &boxedH);
        SysFreeString(dtn); SysFreeString(dvs);
        if (SUCCEEDED(hrCI) && boxedH) {
            for (LONG i = 0; i < enumCount && i < MAX_ENUM_ELEMENTS; i++) {
                const char* nm = g_enumElements[i].name;
                if (!nm || !nm[0]) continue;
                for (int k = 0; k < kFTNameCount; k++) {
                    if (strcmp(nm, kFTNames[k]) == 0) {
                        LONG64 h = g_enumElements[i].handle;
                        if (h) {
                            hrSet = g_vts->SetProperty((InstanceHandle)h, boxedH, 453);
                            found++;
                        }
                        break;
                    }
                }
            }
        }
        pos += snprintf(line + pos, sizeof(line) - pos, "FULL_TRANSPARENT found=%ld val=%f hrCI=0x%08lx hrSet=0x%08lx", found, val, (unsigned long)hrCI, (unsigned long)hrSet);
        memcpy(g_dumpBuf, line, sizeof(line));
        InterlockedExchange(&g_doneSeq, seq);
        InterlockedExchange(&g_applying, 0);
        return;
    }

    // OP_SETOPACITY_AT: 把元素的 Opacity 设为 g_pendingArgb/1000
    //   g_dumpTarget >= 0  → 只改该索引的元素
    //   g_dumpTarget == -2 → 改所有名字 == g_setOpName 的元素
    //   属性索引 453 是 XAML UIElement.Opacity（任务栏那套已验证过）
    if (op == OP_SETOPACITY_AT) {
        LONG target = g_dumpTarget;
        double val = (double)g_pendingArgb / 1000.0;
        if (val < 0.0) val = 0.0; else if (val > 1.0) val = 1.0;
        char line[1200] = {0};
        int pos = 0;
        LONG found = 0, hit = 0;
        HRESULT hrCI = E_FAIL, hrSet = E_FAIL;
        BSTR dtn = SysAllocString(L"Windows.Foundation.Double");
        char vs[32]; snprintf(vs, sizeof(vs), "%f", val);
        BSTR dvs = SysAllocStringLen(NULL, (UINT)strlen(vs));
        for (size_t k = 0; k < strlen(vs); k++) dvs[k] = (OLECHAR)vs[k];
        dvs[strlen(vs)] = 0;
        InstanceHandle boxedH = 0;
        hrCI = g_vts ? g_vts->CreateInstance(dtn, dvs, &boxedH) : E_FAIL;
        SysFreeString(dtn); SysFreeString(dvs);
        if (SUCCEEDED(hrCI) && boxedH) {
            LONG n = g_enumCount;
            if (n > MAX_ENUM_ELEMENTS) n = MAX_ENUM_ELEMENTS;
            for (LONG i = 0; i < n; i++) {
                bool match = false;
                if (target >= 0) match = (i == target);
                else if (target == -2 && g_setOpName[0]) {
                    const char* nm = g_enumElements[i].name;
                    match = (nm && strcmp(nm, g_setOpName) == 0);
                }
                if (!match) continue;
                found++;
                LONG64 h = (LONG64)g_enumElements[i].handle;
                if (h) {
                    // 属性索引不能写死：实测 453 在这些元素上返回 E_FAIL。
                    // 正解是从元素自己的属性链里找名字叫 "Opacity" 的那一项，
                    // 用它的 Index。（XAML 的属性索引是分类型各自的索引空间）
                    UINT propIdx = 453;
                    {
                        unsigned int csc = 0, cvc = 0;
                        PropertyChainSource* cps = NULL;
                        PropertyChainValue* cpv = NULL;
                        HRESULT hrCh = g_vts ? g_vts->GetPropertyValuesChain(
                            (InstanceHandle)h, &csc, &cps, &cvc, &cpv) : E_FAIL;
                        if (SUCCEEDED(hrCh) && cpv) {
                            for (unsigned int q = 0; q < cvc; q++) {
                                char pnm[64] = {0};
                                if (cpv[q].PropertyName)
                                    NarrowCopy(pnm, sizeof(pnm), cpv[q].PropertyName);
                                if (propIdx == 453 && strcmp(pnm, "Opacity") == 0)
                                    propIdx = cpv[q].Index;
                            }
                            for (unsigned int q = 0; q < cvc; q++) {
                                if (cpv[q].PropertyName) SysFreeString(cpv[q].PropertyName);
                                if (cpv[q].Type) SysFreeString(cpv[q].Type);
                                if (cpv[q].DeclaringType) SysFreeString(cpv[q].DeclaringType);
                                if (cpv[q].ValueType) SysFreeString(cpv[q].ValueType);
                                if (cpv[q].ItemType) SysFreeString(cpv[q].ItemType);
                                if (cpv[q].Value) SysFreeString(cpv[q].Value);
                            }
                            CoTaskMemFree(cpv); CoTaskMemFree(cps);
                        }
                    }
                    hrSet = g_vts->SetProperty((InstanceHandle)h, boxedH, propIdx);
                    if (SUCCEEDED(hrSet)) hit++;
                    pos += snprintf(line + pos, sizeof(line) - pos,
                                    "[%ld:%s idx=%u hr=0x%08lx] ",
                                    i, g_enumElements[i].name, propIdx, (unsigned long)hrSet);
                }
                if (target >= 0) break;
            }
        }
        char head[300];
        snprintf(head, sizeof(head),
                 "OPACITY val=%f target=%ld name=%s found=%ld hit=%ld hrCI=0x%08lx",
                 val, target, g_setOpName, found, hit, (unsigned long)hrCI);
        snprintf(g_dumpBuf, sizeof(g_dumpBuf), "%s %s", head, line);
        InterlockedExchange(&g_doneSeq, seq);
        InterlockedExchange(&g_applying, 0);
        return;
    }

    // OP_OPACITYREAL: 真实对象路径把元素 Opacity 设为 g_pendingArgb/1000（对照实验，整块淡出）
    if (op == OP_OPACITYREAL) {
        LONG target = g_dumpTarget;
        double val = (double)g_pendingArgb / 1000.0;
        if (val < 0.0) val = 0.0; else if (val > 1.0) val = 1.0;
        LONG found = 0, hit = 0;
        HRESULT hrSet = E_FAIL;
        LONG n = g_enumCount;
        if (n > MAX_ENUM_ELEMENTS) n = MAX_ENUM_ELEMENTS;
        for (LONG i = 0; i < n; i++) {
            bool match = false;
            if (target >= 0) match = (i == target);
            else if (target == -2 && g_setOpName[0]) {
                const char* nm = g_enumElements[i].name;
                match = (nm && strcmp(nm, g_setOpName) == 0);
            }
            if (!match) continue;
            found++;
            LONG64 h = (LONG64)g_enumElements[i].handle;
            if (h) {
                HRESULT hr = AilSetOpacityReal(h, val);
                if (SUCCEEDED(hr)) hit++;
                hrSet = hr;
            }
            if (target >= 0) break;
        }
        char head2[300];
        snprintf(head2, sizeof(head2),
                 "OPACITYREAL val=%f target=%ld name=%s found=%ld hit=%ld hr=0x%08lx",
                 val, target, g_setOpName, found, hit, (unsigned long)hrSet);
        snprintf(g_dumpBuf, sizeof(g_dumpBuf), "%s", head2);
        InterlockedExchange(&g_doneSeq, seq);
        InterlockedExchange(&g_applying, 0);
        return;
    }

    // OP_BGTRANSPARENT: 真实对象路径把元素 Background 换成透明画刷（保留子内容 = 真·纯透明）
    if (op == OP_BGTRANSPARENT) {
        LONG target = g_dumpTarget;
        LONG found = 0, hit = 0;
        HRESULT hrSet = E_FAIL;
        LONG n = g_enumCount;
        if (n > MAX_ENUM_ELEMENTS) n = MAX_ENUM_ELEMENTS;
        for (LONG i = 0; i < n; i++) {
            bool match = false;
            if (target >= 0) match = (i == target);
            else if (target == -2 && g_setOpName[0]) {
                const char* nm = g_enumElements[i].name;
                match = (nm && strcmp(nm, g_setOpName) == 0);
            }
            if (!match) continue;
            found++;
            LONG64 h = (LONG64)g_enumElements[i].handle;
            if (h) {
                HRESULT hr = AilSetBackgroundTransparent(h);
                if (SUCCEEDED(hr)) hit++;
                hrSet = hr;
            }
            if (target >= 0) break;
        }
        char head2[512];
        snprintf(head2, sizeof(head2),
                 "BGTRANSPARENT target=%ld name=%s found=%ld hit=%ld hr=0x%08lx uiTid=%ld qTid=%ld getHr=0x%08lx qiHr=0x%08lx setHr=0x%08lx",
                 target, g_setOpName, found, hit, (unsigned long)hrSet,
                 (long)g_resUiThread, (long)g_qTid,
                 (unsigned long)g_bgHrGet, (unsigned long)g_bgHrQI, (unsigned long)g_bgHrSet);
        snprintf(g_dumpBuf, sizeof(g_dumpBuf), "%s", head2);
        InterlockedExchange(&g_doneSeq, seq);
        InterlockedExchange(&g_applying, 0);
        return;
    }

    // OP_BGRESTORE: 把改过的元素恢复成**原画刷**（用户切"默认"时用）。
    //
    //   ★ 必须走 SubmitOp（封送到 UI 线程），不能"置标志等下次视觉树回调"：
    //     ① 原画刷是**保存它的那个线程**的 STA 对象，跨线程 put 回去恒 RPC_E_WRONG_THREAD；
    //        而 BGTRANSPARENT 也是在 UI 线程上保存的 → 同线程才能放回去。
    //     ② 面板元素是**复用**的，第二次打开几乎不产生回调 →
    //        老实现（g_bgWantRestore + AutoBgTick）根本等不到执行时机，
    //        表现就是"选默认之后面板还是透明的、还原不了"（用户报的正是这个）。
    if (op == OP_BGRESTORE) {
        LONG n = 0, ok = 0;
        if (g_bgSaveCsReady) {
            LONG64 hs[AIL_BGSAVE_MAX];
            LONG cnt = 0;
            EnterCriticalSection(&g_bgSaveCs);
            for (LONG i = 0; i < g_bgSaveN && i < AIL_BGSAVE_MAX; i++)
                if (g_bgSaves[i].brush) hs[cnt++] = g_bgSaves[i].h;
            LeaveCriticalSection(&g_bgSaveCs);
            n = cnt;
            for (LONG i = 0; i < cnt; i++)
                if (SUCCEEDED(AilRestoreBackground(hs[i]))) { ok++; InterlockedIncrement(&g_bgRestoreOk); }
            InterlockedExchange(&g_bgDoneN, 0);         // 清空"已改"环，以后可以重新应用
            InterlockedExchange(&g_autoBgEnabled, 0);   // 顺手停掉自动改写
            InterlockedExchange(&g_bgWantRestore, 0);   // 老路径的待办一并取消
        }
        char rb[192];
        snprintf(rb, sizeof(rb), "BGRESTORE n=%ld ok=%ld uiTid=%ld qTid=%ld",
                 (long)n, (long)ok, (long)g_resUiThread, (long)g_qTid);
        snprintf(g_dumpBuf, sizeof(g_dumpBuf), "%s", rb);
        InterlockedExchange(&g_doneSeq, seq);
        InterlockedExchange(&g_applying, 0);
        return;
    }
    // OP_BGSCAN: 列出每个元素是否设置了 Background（及类型），定位真正的背景元素
    if (op == OP_BGSCAN) {
        g_dumpBuf[0] = 0;
        int pos = 0;
        LONG n = g_enumCount;
        if (n > MAX_ENUM_ELEMENTS) n = MAX_ENUM_ELEMENTS;
        for (LONG i = 0; i < n; i++) {
            LONG64 h = (LONG64)g_enumElements[i].handle;
            if (!h) continue;
            unsigned int sc = 0, vc = 0;
            PropertyChainSource* ps = NULL;
            PropertyChainValue* pv = NULL;
            HRESULT hrCh = g_vts ? g_vts->GetPropertyValuesChain((InstanceHandle)h, &sc, &ps, &vc, &pv) : E_FAIL;
            if (SUCCEEDED(hrCh) && pv) {
                for (unsigned int q = 0; q < vc; q++) {
                    char pnm[64] = {0};
                    if (pv[q].PropertyName) NarrowCopy(pnm, sizeof(pnm), pv[q].PropertyName);
                    if (strcmp(pnm, "Background") == 0) {
                        char bval[96] = {0}, btype[64] = {0};
                        if (pv[q].Value) NarrowCopy(bval, sizeof(bval), pv[q].Value);
                        if (pv[q].ValueType) NarrowCopy(btype, sizeof(btype), pv[q].ValueType);
                        if (bval[0] || btype[0]) {
                            pos += snprintf(g_dumpBuf + pos, sizeof(g_dumpBuf) - pos,
                                            "[%ld|%s|%s|%s] ", i, g_enumElements[i].name, btype, bval);
                        }
                    }
                }
                for (unsigned int q = 0; q < vc; q++) {
                    if (pv[q].PropertyName) SysFreeString(pv[q].PropertyName);
                    if (pv[q].Type) SysFreeString(pv[q].Type);
                    if (pv[q].DeclaringType) SysFreeString(pv[q].DeclaringType);
                    if (pv[q].ValueType) SysFreeString(pv[q].ValueType);
                    if (pv[q].ItemType) SysFreeString(pv[q].ItemType);
                    if (pv[q].Value) SysFreeString(pv[q].Value);
                }
                CoTaskMemFree(pv); CoTaskMemFree(ps);
            }
            if (pos >= (int)sizeof(g_dumpBuf) - 200) break;
        }
        if (!g_dumpBuf[0]) snprintf(g_dumpBuf, sizeof(g_dumpBuf), "BGSCAN no background found");
        InterlockedExchange(&g_doneSeq, seq);
        InterlockedExchange(&g_applying, 0);
        return;
    }

    // OP_SETPROP: 在 UI 线程上，把枚举元素的指定属性设置成 SolidColorBrush(颜色=g_resArgb)
    //   参数：g_dumpTarget=元素索引, g_setpropIdx=属性索引, g_resArgb=颜色
    if (op == OP_SETPROP) {
        LONG target = g_dumpTarget;
        LONG propIdx = g_setpropIdx;
        g_dumpBuf[0] = 0;
        char line[512] = {0};
        int pos = 0;
        LONG64 h = 0;
        if (target >= 0 && target < g_enumCount && target < MAX_ENUM_ELEMENTS) {
            h = (LONG64)g_enumElements[target].handle;
        }
        if (h && propIdx >= 0) {
            BSTR tn = SysAllocString(L"Windows.UI.Xaml.Media.SolidColorBrush");
            InstanceHandle br = 0;
            HRESULT hrC = g_vts ? g_vts->CreateInstance(tn, NULL, &br) : E_FAIL;
            SysFreeString(tn);
            InterlockedExchange(&g_resHrCreate, (LONG)hrC);
            if (SUCCEEDED(hrC) && br) {
                IInspectable* brushObj = NULL;
                HRESULT hrObj = g_diag->GetIInspectableFromHandle(br, &brushObj);
                if (SUCCEEDED(hrObj) && brushObj) {
                    unsigned int sc = 0, vc = 0;
                    PropertyChainSource* ps = NULL;
                    PropertyChainValue* pv = NULL;
                    HRESULT hrChain = g_vts->GetPropertyValuesChain(br, &sc, &ps, &vc, &pv);
                    unsigned int colorIdx = (unsigned int)-1;
                    if (SUCCEEDED(hrChain) && pv) {
                        for (unsigned int i = 0; i < vc; i++) {
                            char nm[64] = {0};
                            if (pv[i].PropertyName) NarrowCopy(nm, sizeof(nm), pv[i].PropertyName);
                            if (strcmp(nm, "Color") == 0) colorIdx = pv[i].Index;
                            if (pv[i].PropertyName) SysFreeString(pv[i].PropertyName);
                            if (pv[i].Type) SysFreeString(pv[i].Type);
                            if (pv[i].DeclaringType) SysFreeString(pv[i].DeclaringType);
                            if (pv[i].ValueType) SysFreeString(pv[i].ValueType);
                            if (pv[i].ItemType) SysFreeString(pv[i].ItemType);
                            if (pv[i].Value) SysFreeString(pv[i].Value);
                        }
                        if (ps) { for (unsigned int i = 0; i < sc; i++) { if (ps[i].TargetType) SysFreeString(ps[i].TargetType); if (ps[i].Name) SysFreeString(ps[i].Name); } }
                        CoTaskMemFree(pv); CoTaskMemFree(ps);
                    }
                    HRESULT hrColor = E_UNEXPECTED;
                    HRESULT hrSet = E_UNEXPECTED;
                    if (colorIdx != (unsigned int)-1) {
                        wchar_t colorVal[16];
                        swprintf(colorVal, 16, L"#%08lX", (unsigned long)g_resArgb);
                        InstanceHandle colorObj = 0;
                        BSTR colorType = SysAllocString(L"Windows.UI.Color");
                        BSTR colorStr = SysAllocString(colorVal);
                        hrColor = g_vts->CreateInstance(colorType, colorStr, &colorObj);
                        SysFreeString(colorType); SysFreeString(colorStr);
                        if (SUCCEEDED(hrColor) && colorObj) {
                            g_vts->SetProperty(br, colorObj, colorIdx);
                            hrSet = g_vts->SetProperty((InstanceHandle)h, br, (unsigned int)propIdx);
                            InterlockedExchange(&g_resHrSet, (LONG)hrSet);
                        }
                    }
                    pos += snprintf(line + pos, sizeof(line) - pos,
                        "SETPROP target=%ld prop=%ld argb=0x%08lx hrCreate=0x%08lx hrObj=0x%08lx hrChain=0x%08lx colorIdx=%ld hrColor=0x%08lx hrSet=0x%08lx brush=%p",
                        target, propIdx, (unsigned long)g_resArgb, (unsigned long)hrC, (unsigned long)hrObj,
                        (unsigned long)hrChain, (long)colorIdx, (unsigned long)hrColor, (unsigned long)hrSet, (void*)br);
                    brushObj->Release();
                } else {
                    pos += snprintf(line + pos, sizeof(line) - pos, "SETPROP obj-fail hr=0x%08lx", (unsigned long)hrObj);
                }
                InterlockedExchange64(&g_resNewBrush, (LONG64)br);
            } else {
                pos += snprintf(line + pos, sizeof(line) - pos,
                    "SETPROP create-fail target=%ld prop=%ld argb=0x%08lx hr=0x%08lx",
                    target, propIdx, (unsigned long)g_resArgb, (unsigned long)hrC);
            }
        } else {
            pos += snprintf(line + pos, sizeof(line) - pos, "SETPROP no-target");
        }
        memcpy(g_dumpBuf, line, sizeof(line));
        InterlockedExchange(&g_doneSeq, seq);
        InterlockedExchange(&g_applying, 0);
        return;
    }

    // OP_FILL_BORDER 不依�?g_fillHandle，先处理
    if (op == OP_FILL_BORDER) {
        // 从枚举数组中查找背景元素：AcrylicBorder、BackgroundBorder、AcrylicOverlay，以及第一个无�?Border
        LONG64 ab = 0, bb = 0, ao = 0, firstBorder = 0;
        LONG enumCount = g_enumCount;
        for (LONG i = 0; i < enumCount && i < MAX_ENUM_ELEMENTS; i++) {
            if (strcmp(g_enumElements[i].type, "Windows.UI.Xaml.Controls.Border") == 0) {
                if (strcmp(g_enumElements[i].name, "AcrylicBorder") == 0) ab = g_enumElements[i].handle;
                else if (strcmp(g_enumElements[i].name, "BackgroundBorder") == 0) bb = g_enumElements[i].handle;
                else if (strcmp(g_enumElements[i].name, "AcrylicOverlay") == 0) ao = g_enumElements[i].handle;
                else if (g_enumElements[i].name[0] == '\0' && !firstBorder) firstBorder = g_enumElements[i].handle;
            }
        }
        InterlockedExchange(&g_resBorderCount, (ab ? 1 : 0) + (bb ? 1 : 0) + (ao ? 1 : 0) + (firstBorder ? 1 : 0));

        if (ab || bb || ao || firstBorder) {
            // 创建 SolidColorBrush（先创建空实例，再设�?Color 属性）
            BSTR tn = SysAllocString(L"Windows.UI.Xaml.Media.SolidColorBrush");
            InstanceHandle br = 0;
            HRESULT hrC = g_vts ? g_vts->CreateInstance(tn, NULL, &br) : E_FAIL;
            InterlockedExchange(&g_resHrCreate, (LONG)hrC);
            SysFreeString(tn);

            if (SUCCEEDED(hrC) && br) {
                // 设置 Color 属
                IInspectable* brushObj = NULL;
                if (SUCCEEDED(g_diag->GetIInspectableFromHandle(br, &brushObj)) && brushObj) {
                    unsigned int sc = 0, vc = 0;
                    PropertyChainSource* ps = NULL;
                    PropertyChainValue* pv = NULL;
                    HRESULT hrChain = g_vts->GetPropertyValuesChain(br, &sc, &ps, &vc, &pv);
                    if (SUCCEEDED(hrChain) && pv) {
                        unsigned int colorIdx = (unsigned int)-1;
                        for (unsigned int i = 0; i < vc; i++) {
                            char nm[64] = {0};
                            if (pv[i].PropertyName) NarrowCopy(nm, sizeof(nm), pv[i].PropertyName);
                            if (strcmp(nm, "Color") == 0) colorIdx = pv[i].Index;
                            if (pv[i].PropertyName) SysFreeString(pv[i].PropertyName);
                            if (pv[i].Type) SysFreeString(pv[i].Type);
                            if (pv[i].DeclaringType) SysFreeString(pv[i].DeclaringType);
                            if (pv[i].ValueType) SysFreeString(pv[i].ValueType);
                            if (pv[i].ItemType) SysFreeString(pv[i].ItemType);
                            if (pv[i].Value) SysFreeString(pv[i].Value);
                        }
                        if (ps) { for (unsigned int i = 0; i < sc; i++) { if (ps[i].TargetType) SysFreeString(ps[i].TargetType); if (ps[i].Name) SysFreeString(ps[i].Name); } }
                        CoTaskMemFree(pv); CoTaskMemFree(ps);

                        if (colorIdx != (unsigned int)-1) {
                            wchar_t colorVal[16];
                            swprintf(colorVal, 16, L"#%08lX", (unsigned long)g_resArgb);
                            InstanceHandle colorObj = 0;
                            BSTR colorType = SysAllocString(L"Windows.UI.Color");
                            BSTR colorStr = SysAllocString(colorVal);
                            HRESULT hrColor = g_vts->CreateInstance(colorType, colorStr, &colorObj);
                            InterlockedExchange(&g_resHrColor, (LONG)hrColor);
                            SysFreeString(colorType); SysFreeString(colorStr);
                            if (SUCCEEDED(hrColor) && colorObj) {
                                g_vts->SetProperty(br, colorObj, colorIdx);
                            }
                        }
                    }
                    brushObj->Release();
                }
                InterlockedExchange64(&g_resNewBrush, (LONG64)br);
            }

            if (SUCCEEDED(hrC) && br) {
                // 辅助函数：设�?Border �?Background 属
                auto setBorderBackground = [&](LONG64 handle) -> HRESULT {
                    if (!handle) return E_FAIL;
                    IInspectable* border = NULL;
                    if (FAILED(g_diag->GetIInspectableFromHandle((InstanceHandle)handle, &border)) || !border) return E_FAIL;
                    unsigned int sc = 0, vc = 0;
                    PropertyChainSource* ps = NULL;
                    PropertyChainValue* pv = NULL;
                    int bgIdx = -1;
                    HRESULT hrChain = g_vts ? g_vts->GetPropertyValuesChain((InstanceHandle)handle, &sc, &ps, &vc, &pv) : E_FAIL;
                    if (SUCCEEDED(hrChain) && pv) {
                        char allProps[3072] = {0};
                        int pos = 0;
                        for (unsigned int i = 130; i < vc && i < 200; i++) {
                            char nm[64] = {0};
                            if (pv[i].PropertyName) NarrowCopy(nm, sizeof(nm), pv[i].PropertyName);
                            if (pos < (int)sizeof(allProps) - 80) {
                                pos += snprintf(allProps + pos, sizeof(allProps) - pos, "[%d]%s(idx=%d) ", i, nm, pv[i].Index);
                            }
                            if (strcmp(nm, "Background") == 0) { bgIdx = pv[i].Index; }
                        }
                        Log("FILL_BORDER props[130-200](%d): %s", vc, allProps);
                        for (unsigned int i = 0; i < vc; i++) {
                            if (pv[i].PropertyName) SysFreeString(pv[i].PropertyName);
                            if (pv[i].Type) SysFreeString(pv[i].Type);
                            if (pv[i].DeclaringType) SysFreeString(pv[i].DeclaringType);
                            if (pv[i].ValueType) SysFreeString(pv[i].ValueType);
                            if (pv[i].ItemType) SysFreeString(pv[i].ItemType);
                            if (pv[i].Value) SysFreeString(pv[i].Value);
                        }
                        if (ps) { for (unsigned int i = 0; i < sc; i++) { if (ps[i].TargetType) SysFreeString(ps[i].TargetType); if (ps[i].Name) SysFreeString(ps[i].Name); } }
                        CoTaskMemFree(pv); CoTaskMemFree(ps);
                    }
                    HRESULT hrS = E_FAIL;
                    // Background 属性索引为 785（通过 GetPropertyValuesChain 确认�?                    bgIdx = 785;
                    
                    // 先枚�?Border 对象实现的接口，找到获取 Background 的正确接
                    if (border) {
                        ULONG iidCount = 0;
                        IID* iids = NULL;
                        border->GetIids(&iidCount, &iids);
                        char iidInfo[1024] = {0};
                        int iidPos = 0;
                        iidPos += snprintf(iidInfo + iidPos, sizeof(iidInfo) - iidPos, "count=%d ", iidCount);
                        for (ULONG i = 0; i < iidCount && i < 10 && iidPos < (int)sizeof(iidInfo) - 80; i++) {
                            iidPos += snprintf(iidInfo + iidPos, sizeof(iidInfo) - iidPos,
                                "{%08x-%04x-%04x-%02x%02x-%02x%02x%02x%02x%02x%02x};",
                                iids[i].Data1, iids[i].Data2, iids[i].Data3,
                                iids[i].Data4[0], iids[i].Data4[1], iids[i].Data4[2], iids[i].Data4[3],
                                iids[i].Data4[4], iids[i].Data4[5], iids[i].Data4[6], iids[i].Data4[7]);
                        }
                        Log("FILL_BORDER Border IIDs: %s", iidInfo);
                        if (iids) CoTaskMemFree(iids);
                    }
                    
                    if (bgIdx >= 0) {
                        hrS = g_vts->SetProperty((InstanceHandle)handle, br, bgIdx);
                    }
                    border->Release();
                    return hrS;
                };

                // 处理 AcrylicBorder
                if (ab) {
                    HRESULT hrS = setBorderBackground(ab);
                    InterlockedExchange(&g_resHrSet, (LONG)hrS);
                }

                // 处理 BackgroundBorder
                if (bb) {
                    setBorderBackground(bb);
                }

                // 处理 AcrylicOverlay
                if (ao) {
                    setBorderBackground(ao);
                }

                // 处理第一个无�?Border（可能是最外层背景
                if (firstBorder) {
                    setBorderBackground(firstBorder);
                }
            }
        } else {
            InterlockedExchange(&g_resHrSet, (LONG)E_FAIL);
        }

        InterlockedExchange(&g_doneSeq, seq);
        InterlockedExchange(&g_applying, 0);
        return;
    }

    // OP_SET_ACRYLIC_OPACITY: 修改开始菜�?AcrylicBrush 的透明�）
    // 参�?TranslucentSM：创建透明 AcrylicBrush 并替�?Border.Background
    if (op == OP_SET_ACRYLIC_OPACITY) {
        LONG64 ab = 0, bb = 0, ao = 0, firstBorder = 0;
        LONG enumCount = g_enumCount;
        for (LONG i = 0; i < enumCount && i < MAX_ENUM_ELEMENTS; i++) {
            if (strcmp(g_enumElements[i].type, "Windows.UI.Xaml.Controls.Border") == 0) {
                if (strcmp(g_enumElements[i].name, "AcrylicBorder") == 0) ab = g_enumElements[i].handle;
                else if (strcmp(g_enumElements[i].name, "BackgroundBorder") == 0) bb = g_enumElements[i].handle;
                else if (strcmp(g_enumElements[i].name, "AcrylicOverlay") == 0) ao = g_enumElements[i].handle;
                else if (g_enumElements[i].name[0] == '\0' && !firstBorder) firstBorder = g_enumElements[i].handle;
            }
        }
        InterlockedExchange(&g_resBorderCount, (ab ? 1 : 0) + (bb ? 1 : 0) + (ao ? 1 : 0) + (firstBorder ? 1 : 0));

        if (ab || bb || ao || firstBorder) {
            // 创建 AcrylicBrush
            BSTR tn = SysAllocString(L"Windows.UI.Xaml.Media.AcrylicBrush");
            InstanceHandle br = 0;
            HRESULT hrC = g_vts ? g_vts->CreateInstance(tn, NULL, &br) : E_FAIL;
            InterlockedExchange(&g_resHrCreate, (LONG)hrC);
            SysFreeString(tn);

            if (SUCCEEDED(hrC) && br) {
                IInspectable* brush = NULL;
                HRESULT hrB = g_diag->GetIInspectableFromHandle(br, &brush);
                InterlockedExchange(&g_resHrBrush, (LONG)hrB);
                if (SUCCEEDED(hrB) && brush) {
                    // 设置 AcrylicBrush 属性：BackgroundSource=HostBackdrop, TintOpacity=0, TintColor=透明
                    unsigned int sc = 0, vc = 0;
                    PropertyChainSource* ps = NULL;
                    PropertyChainValue* pv = NULL;
                    HRESULT hrChain = g_vts->GetPropertyValuesChain(br, &sc, &ps, &vc, &pv);
                    if (SUCCEEDED(hrChain) && pv) {
                        unsigned int bgSrcIdx = (unsigned int)-1;
                        unsigned int tintOpIdx = (unsigned int)-1;
                        unsigned int tintColorIdx = (unsigned int)-1;
                        for (unsigned int i = 0; i < vc; i++) {
                            char nm[64] = {0};
                            if (pv[i].PropertyName) NarrowCopy(nm, sizeof(nm), pv[i].PropertyName);
                            if (strcmp(nm, "BackgroundSource") == 0) bgSrcIdx = pv[i].Index;
                            if (strcmp(nm, "TintOpacity") == 0) tintOpIdx = pv[i].Index;
                            if (strcmp(nm, "TintColor") == 0) tintColorIdx = pv[i].Index;
                            if (pv[i].PropertyName) SysFreeString(pv[i].PropertyName);
                            if (pv[i].Type) SysFreeString(pv[i].Type);
                            if (pv[i].DeclaringType) SysFreeString(pv[i].DeclaringType);
                            if (pv[i].ValueType) SysFreeString(pv[i].ValueType);
                            if (pv[i].ItemType) SysFreeString(pv[i].ItemType);
                            if (pv[i].Value) SysFreeString(pv[i].Value);
                        }
                        if (ps) { for (unsigned int i = 0; i < sc; i++) { if (ps[i].TargetType) SysFreeString(ps[i].TargetType); if (ps[i].Name) SysFreeString(ps[i].Name); } }
                        CoTaskMemFree(pv); CoTaskMemFree(ps);

                        // BackgroundSource = HostBackdrop (枚举�?0)
                        if (bgSrcIdx != (unsigned int)-1) {
                            InstanceHandle enumVal = 0;
                            BSTR enumType = SysAllocString(L"Windows.UI.Xaml.Media.AcrylicBackgroundSource");
                            BSTR enumValStr = SysAllocString(L"HostBackdrop");
                            HRESULT hrEnum = g_vts->CreateInstance(enumType, enumValStr, &enumVal);
                            SysFreeString(enumType); SysFreeString(enumValStr);
                            if (SUCCEEDED(hrEnum) && enumVal) {
                                g_vts->SetProperty(br, enumVal, bgSrcIdx);
                            }
                        }

                        // TintOpacity = 0 (完全透明)
                        if (tintOpIdx != (unsigned int)-1) {
                            // double 值需要通过 CreateInstance 创建
                            wchar_t opVal[16];
                            swprintf(opVal, 16, L"0");
                            InstanceHandle opObj = 0;
                            BSTR opType = SysAllocString(L"Double");
                            BSTR opStr = SysAllocString(opVal);
                            HRESULT hrOp = g_vts->CreateInstance(opType, opStr, &opObj);
                            SysFreeString(opType); SysFreeString(opStr);
                            if (SUCCEEDED(hrOp) && opObj) {
                                g_vts->SetProperty(br, opObj, tintOpIdx);
                            }
                        }

                        // TintColor = 透明
                        if (tintColorIdx != (unsigned int)-1) {
                            wchar_t colorVal[16];
                            swprintf(colorVal, 16, L"#00000000");
                            InstanceHandle colorObj = 0;
                            BSTR colorType = SysAllocString(L"Windows.UI.Color");
                            BSTR colorStr = SysAllocString(colorVal);
                            HRESULT hrColor = g_vts->CreateInstance(colorType, colorStr, &colorObj);
                            SysFreeString(colorType); SysFreeString(colorStr);
                            if (SUCCEEDED(hrColor) && colorObj) {
                                g_vts->SetProperty(br, colorObj, tintColorIdx);
                            }
                        }
                    }

                    // 辅助函数：获取并修改现有 AcrylicBrush �?TintOpacity
                    auto modifyAcrylicOpacity = [&](LONG64 handle) -> HRESULT {
                        if (!handle) return E_FAIL;
                        IInspectable* border = NULL;
                        if (FAILED(g_diag->GetIInspectableFromHandle((InstanceHandle)handle, &border)) || !border) return E_FAIL;
                        
                        HRESULT hrResult = E_FAIL;
                        
                        // 获取 Border 的激活工厂，然后获取 BackgroundProperty
                        static void* backgroundProperty = NULL;
                        if (!backgroundProperty) {
                            IBorderFactory* factory = NULL;
                            HSTRING className = NULL;
                            WindowsCreateString(L"Windows.UI.Xaml.Controls.Border", 31, &className);
                            HRESULT hrFactory = RoGetActivationFactory(className, IID_IBorderFactory, (void**)&factory);
                            if (SUCCEEDED(hrFactory) && factory) {
                                factory->get_BackgroundProperty(&backgroundProperty);
                                Log("SET_ACRYLIC BackgroundProperty=%p hr=0x%08lx", backgroundProperty, (unsigned long)hrFactory);
                                factory->Release();
                            } else {
                                Log("SET_ACRYLIC RoGetActivationFactory failed hr=0x%08lx", (unsigned long)hrFactory);
                            }
                            if (className) WindowsDeleteString(className);
                        }
                        
                        if (backgroundProperty) {
                            // 使用 IDependencyObject.GetValue 获取 Background
                            IDependencyObject* dp = NULL;
                            HRESULT hrQI = border->QueryInterface(IID_IDependencyObject, (void**)&dp);
                            if (SUCCEEDED(hrQI) && dp) {
                                IInspectable* background = NULL;
                                HRESULT hrGet = dp->GetValue(backgroundProperty, &background);
                                if (SUCCEEDED(hrGet) && background) {
                                    // 获取运行时类
                                    HSTRING className = NULL;
                                    background->GetRuntimeClassName(&className);
                                    if (className) {
                                        char classNameA[128] = {0};
                                        UINT32 len = 0;
                                        const wchar_t* classNameW = WindowsGetStringRawBuffer(className, &len);
                                        if (classNameW) NarrowCopy(classNameA, sizeof(classNameA), classNameW);
                                        Log("SET_ACRYLIC Background type: %s", classNameA);
                                        WindowsDeleteString(className);
                                    }
                                    
                                    // 尝试 QueryInterface 获取 IAcrylicBrushAIL
                                    IAcrylicBrushAIL* acrylic = NULL;
                                    HRESULT hrAcrylic = background->QueryInterface(IID_IAcrylicBrushAIL, (void**)&acrylic);
                                    if (SUCCEEDED(hrAcrylic) && acrylic) {
                                        double currentOpacity = 0;
                                        acrylic->get_TintOpacity(&currentOpacity);
                                        Log("SET_ACRYLIC current TintOpacity=%f", currentOpacity);
                                        
                                        hrResult = acrylic->put_TintOpacity(0.0);
                                        Log("SET_ACRYLIC put_TintOpacity(0) hr=0x%08lx", (unsigned long)hrResult);
                                        
                                        acrylic->put_TintLuminosityOpacity(0.0);
                                        acrylic->Release();
                                    } else {
                                        Log("SET_ACRYLIC QueryInterface IAcrylicBrush failed hr=0x%08lx", (unsigned long)hrAcrylic);
                                    }
                                    background->Release();
                                } else {
                                    Log("SET_ACRYLIC GetValue failed hr=0x%08lx bg=%p", (unsigned long)hrGet, background);
                                }
                                dp->Release();
                            } else {
                                Log("SET_ACRYLIC QueryInterface IDependencyObject failed hr=0x%08lx", (unsigned long)hrQI);
                            }
                        }
                        
                        border->Release();
                        return hrResult;
                    };

                    if (ab) {
                        HRESULT hrS = modifyAcrylicOpacity(ab);
                        InterlockedExchange(&g_resHrSet, (LONG)hrS);
                    }
                    if (bb) modifyAcrylicOpacity(bb);
                    if (ao) modifyAcrylicOpacity(ao);
                    if (firstBorder) modifyAcrylicOpacity(firstBorder);

                    Log("SET_ACRYLIC_OPACITY borders=%d", (int)g_resBorderCount);
                }
            }
        } else {
            InterlockedExchange(&g_resHrSet, (LONG)E_FAIL);
        }

        InterlockedExchange(&g_doneSeq, seq);
        InterlockedExchange(&g_applying, 0);
        return;
    }

    // OP_DIRECT_ACRYLIC: 通过 CoreDispatcher �?UI 线程直接操作现有 AcrylicBrush
    if (op == OP_DIRECT_ACRYLIC) {
        HRESULT hrResult = E_FAIL;
        IInspectable* dispatcher = NULL;
        HRESULT hrDisp = g_diag ? g_diag->GetDispatcher(&dispatcher) : E_FAIL;
        InterlockedExchange(&g_resHrCreate, (LONG)hrDisp);
        Log("DIRECT_ACRYLIC GetDispatcher hr=0x%08lx dispatcher=%p", (unsigned long)hrDisp, dispatcher);

        if (SUCCEEDED(hrDisp) && dispatcher) {
            // 获取 dispatcher 实现的所有接
            ULONG iidCount = 0;
            IID* iids = NULL;
            HRESULT hrIids = dispatcher->GetIids(&iidCount, &iids);
            Log("DIRECT_ACRYLIC dispatcher GetIids hr=0x%08lx count=%lu", (unsigned long)hrIids, iidCount);
            if (SUCCEEDED(hrIids) && iids && iidCount > 0) {
                char iidInfo[2048] = {0};
                int pos = 0;
                for (ULONG i = 0; i < iidCount && i < 20; i++) {
                    wchar_t iidStr[64] = {0};
                    StringFromGUID2(iids[i], iidStr, 64);
                    char iidA[64] = {0};
                    NarrowCopy(iidA, sizeof(iidA), iidStr);
                    if (pos < (int)sizeof(iidInfo) - 80) {
                        pos += snprintf(iidInfo + pos, sizeof(iidInfo) - pos, "[%lu]%s ", i, iidA);
                    }
                }
                Log("DIRECT_ACRYLIC dispatcher IIDs: %s", iidInfo);
                CoTaskMemFree(iids);
            }

            // 尝试 QueryInterface 获取 ICoreDispatcher
            ICoreDispatcher* coreDisp = NULL;
            HRESULT hrQI = dispatcher->QueryInterface(IID_ICoreDispatcher, (void**)&coreDisp);
            Log("DIRECT_ACRYLIC QI ICoreDispatcher hr=0x%08lx", (unsigned long)hrQI);

            if (SUCCEEDED(hrQI) && coreDisp) {
                // 检查是否在 UI 线程
                int hasAccess = 0;
                HRESULT hrAccess = coreDisp->get_HasThreadAccess(&hasAccess);
                Log("DIRECT_ACRYLIC HasThreadAccess hr=0x%08lx access=%d", (unsigned long)hrAccess, hasAccess);

                if (hasAccess) {
                    // 已经�?UI 线程，直接执
                    Log("DIRECT_ACRYLIC already on UI thread, executing directly");
                    
                    // 从枚举的元素中找�?AcrylicBorder
                    LONG64 abHandle = 0;
                    LONG enumCount = g_enumCount;
                    for (LONG i = 0; i < enumCount && i < MAX_ENUM_ELEMENTS; i++) {
                        if (strcmp(g_enumElements[i].type, "Windows.UI.Xaml.Controls.Border") == 0 &&
                            strcmp(g_enumElements[i].name, "AcrylicBorder") == 0) {
                            abHandle = g_enumElements[i].handle;
                            break;
                        }
                    }
                    Log("DIRECT_ACRYLIC AcrylicBorder handle=%lld", abHandle);
                    
                    if (abHandle) {
                        IInspectable* border = NULL;
                        HRESULT hrBorder = g_diag->GetIInspectableFromHandle((InstanceHandle)abHandle, &border);
                        Log("DIRECT_ACRYLIC GetIInspectableFromHandle hr=0x%08lx border=%p", (unsigned long)hrBorder, border);
                        
                        if (SUCCEEDED(hrBorder) && border) {
                            IBorder* borderObj = NULL;
                            HRESULT hrQI = border->QueryInterface(IID_IBorder, (void**)&borderObj);
                            Log("DIRECT_ACRYLIC QI IBorder hr=0x%08lx", (unsigned long)hrQI);
                            
                            if (SUCCEEDED(hrQI) && borderObj) {
                                IInspectable* background = NULL;
                                HRESULT hrBg = borderObj->get_Background((void**)&background);
                                Log("DIRECT_ACRYLIC get_Background hr=0x%08lx bg=%p", (unsigned long)hrBg, background);
                                
                                if (SUCCEEDED(hrBg) && background) {
                                    // 获取运行时类
                                    HSTRING className = NULL;
                                    background->GetRuntimeClassName(&className);
                                    if (className) {
                                        char classNameA[128] = {0};
                                        UINT32 len = 0;
                                        const wchar_t* classNameW = WindowsGetStringRawBuffer(className, &len);
                                        if (classNameW) NarrowCopy(classNameA, sizeof(classNameA), classNameW);
                                        Log("DIRECT_ACRYLIC Background type: %s", classNameA);
                                        WindowsDeleteString(className);
                                    }
                                    
                                    // QueryInterface 获取 IAcrylicBrushAIL
                                    IAcrylicBrushAIL* acrylic = NULL;
                                    HRESULT hrAcrylic = background->QueryInterface(IID_IAcrylicBrushAIL, (void**)&acrylic);
                                    Log("DIRECT_ACRYLIC QI IAcrylicBrushAIL hr=0x%08lx", (unsigned long)hrAcrylic);
                                    
                                    if (SUCCEEDED(hrAcrylic) && acrylic) {
                                        double currentOpacity = 0;
                                        acrylic->get_TintOpacity(&currentOpacity);
                                        Log("DIRECT_ACRYLIC current TintOpacity=%f", currentOpacity);
                                        
                                        // 设置新的 TintOpacity（根�?argb �?alpha 通道
                                        double newOpacity = (double)((g_resArgb >> 24) & 0xFF) / 255.0;
                                        HRESULT hrSet = acrylic->put_TintOpacity(newOpacity);
                                        Log("DIRECT_ACRYLIC put_TintOpacity(%f) hr=0x%08lx", newOpacity, (unsigned long)hrSet);
                                        
                                        if (SUCCEEDED(hrSet)) {
                                            hrResult = S_OK;
                                        }
                                        acrylic->Release();
                                    }
                                    background->Release();
                                }
                                borderObj->Release();
                            }
                            border->Release();
                        }
                    }
                } else {
                    // 需要通过 RunAsync �?UI 线程执行
                    Log("DIRECT_ACRYLIC not on UI thread, need RunAsync");
                    // TODO: 使用 RunAsync
                    hrResult = S_OK;
                }
                coreDisp->Release();
            }
            dispatcher->Release();
        }

        InterlockedExchange(&g_resHrSet, (LONG)hrResult);
        InterlockedExchange(&g_doneSeq, seq);
        InterlockedExchange(&g_applying, 0);
        return;
    }

    // OP_FILL_ALL: 测试用，修改所有有 Background 属性的元素
    if (op == OP_FILL_ALL) {
        LONG enumCount = g_enumCount;
        LONG modified = 0;
        wchar_t val[16];
        swprintf(val, 16, L"#%08lX", (unsigned long)g_resArgb);
        BSTR tn = SysAllocString(L"Windows.UI.Xaml.Media.SolidColorBrush");
        BSTR vs = SysAllocString(val);
        InstanceHandle br = 0;
        HRESULT hrC = g_vts ? g_vts->CreateInstance(tn, vs, &br) : E_FAIL;
        SysFreeString(tn); SysFreeString(vs);

        if (SUCCEEDED(hrC) && br) {
            for (LONG i = 0; i < enumCount && i < MAX_ENUM_ELEMENTS; i++) {
                LONG64 handle = g_enumElements[i].handle;
                if (!handle) continue;
                IInspectable* obj = NULL;
                if (FAILED(g_diag->GetIInspectableFromHandle((InstanceHandle)handle, &obj)) || !obj) continue;
                unsigned int sc = 0, vc = 0;
                PropertyChainSource* ps = NULL;
                PropertyChainValue* pv = NULL;
                int bgIdx = -1;
                if (SUCCEEDED(g_vts->GetPropertyValuesChain((InstanceHandle)handle, &sc, &ps, &vc, &pv)) && pv) {
                    for (unsigned int j = 0; j < vc; j++) {
                        char nm[64] = {0};
                        if (pv[j].PropertyName) NarrowCopy(nm, sizeof(nm), pv[j].PropertyName);
                        if (strcmp(nm, "Background") == 0) { bgIdx = pv[j].Index; }
                        if (pv[j].PropertyName) SysFreeString(pv[j].PropertyName);
                        if (pv[j].Type) SysFreeString(pv[j].Type);
                        if (pv[j].DeclaringType) SysFreeString(pv[j].DeclaringType);
                        if (pv[j].ValueType) SysFreeString(pv[j].ValueType);
                        if (pv[j].ItemType) SysFreeString(pv[j].ItemType);
                        if (pv[j].Value) SysFreeString(pv[j].Value);
                    }
                    if (ps) { for (unsigned int j = 0; j < sc; j++) { if (ps[j].TargetType) SysFreeString(ps[j].TargetType); if (ps[j].Name) SysFreeString(ps[j].Name); } }
                    CoTaskMemFree(pv); CoTaskMemFree(ps);
                }
                if (bgIdx >= 0) {
                    HRESULT hrS = g_vts->SetProperty((InstanceHandle)handle, br, bgIdx);
                    if (SUCCEEDED(hrS)) modified++;
                }
                obj->Release();
            }
        }
        InterlockedExchange(&g_resBorderCount, modified);
        InterlockedExchange(&g_resHrSet, (LONG)hrC);
        InterlockedExchange(&g_doneSeq, seq);
        InterlockedExchange(&g_applying, 0);
        return;
    }

    const LONG64 fill = g_fillHandle;
    InterlockedExchange64(&g_resFillHandle, fill);
    if (!g_vts || !fill) {
        // 常见原因：还没看�?BackgroundFill（视觉树事件没攒够），或订阅已失
        InterlockedExchange(&g_resHrIdx, (LONG)E_FAIL);
        InterlockedExchange(&g_doneSeq, seq);
        InterlockedExchange(&g_applying, 0);
        return;
    }

    // [M2 真改路径] 拿真�?Rectangle �?inspectable，QI �?IShape，再 put_Fill / get_Fill�）
    //   依据 winmd 实测：IShape::get_Fill=slot6, put_Fill=slot7（基�?6 个方法之后）�）
    //   VTS �?GetPropertyIndex("Fill") 在本 build 返回 E_INVALIDARG（Fill 不在附加属性链），
    //   所以走"真实对象 + 真实接口"才有效（TranslucentTB 也正是这么做）
    IInspectable* rect = NULL;
    IShapeAIL* shape = NULL;
    HRESULT hrRect = (g_diag && fill) ? g_diag->GetIInspectableFromHandle((InstanceHandle)fill, &rect) : E_FAIL;
    InterlockedExchange(&g_resHrRect, (LONG)hrRect);
    if (SUCCEEDED(hrRect) && rect) {
        HSTRING hc = NULL;
        if (SUCCEEDED(rect->GetRuntimeClassName(&hc)) && hc) {
            PCWSTR p = WindowsGetStringRawBuffer(hc, NULL);
            if (p) NarrowCopy(g_resBrushClass, sizeof(g_resBrushClass), p);
            WindowsDeleteString(hc);
        }
        HRESULT hrQ = rect->QueryInterface(IID_IShapeAIL, (void**)&shape);
        InterlockedExchange(&g_resHrShape, (LONG)hrQ);
    }

    // [DIAG] 属性链枚举（仅诊断：确�?Fill 不在 VTS 可索引的附加属性链里）
    {
        unsigned int sc = 0, vc = 0;
        PropertyChainSource* ps = NULL;
        PropertyChainValue* pv = NULL;
        const HRESULT hrC = g_vts ? g_vts->GetPropertyValuesChain((InstanceHandle)fill, &sc, &ps, &vc, &pv) : E_FAIL;
        InterlockedExchange(&g_resHrChain, (LONG)hrC);
        g_resEnum[0] = '\0';
        if (SUCCEEDED(hrC) && pv) {
            const unsigned int n = vc < 48 ? vc : 48;
            for (unsigned int i = 0; i < n; i++) {
                char nm[64]; nm[0] = '\0';
                if (pv[i].PropertyName) NarrowCopy(nm, sizeof(nm), pv[i].PropertyName);
                char tmp[96];
                snprintf(tmp, sizeof(tmp), "%s#%u; ", nm[0] ? nm : "?", pv[i].Index);
                strncat(g_resEnum, tmp, sizeof(g_resEnum) - strlen(g_resEnum) - 1);
                if (pv[i].PropertyName) SysFreeString(pv[i].PropertyName);
                if (pv[i].Type) SysFreeString(pv[i].Type);
                if (pv[i].DeclaringType) SysFreeString(pv[i].DeclaringType);
                if (pv[i].ValueType) SysFreeString(pv[i].ValueType);
                if (pv[i].ItemType) SysFreeString(pv[i].ItemType);
                if (pv[i].Value) SysFreeString(pv[i].Value);
            }
            if (ps) { for (unsigned int i = 0; i < sc; i++) { if (ps[i].TargetType) SysFreeString(ps[i].TargetType); if (ps[i].Name) SysFreeString(ps[i].Name); } }
            CoTaskMemFree(pv); CoTaskMemFree(ps);
        }
    }

    // PROBE：读当前 Fill（存原始画刷，供 RESTORE 干净还原
    if (op == OP_PROBE) {
        if (shape) {
            IInspectable* of = NULL;
            HRESULT hrG = shape->get_Fill(&of);
            InterlockedExchange(&g_resHrGet, (LONG)hrG);
            InterlockedExchange64(&g_resPrevBrush, (LONG64)of);
            if (SUCCEEDED(hrG) && of) {
                // 记录原始画刷的运行时类型（覆盖上面的矩形类名
                HSTRING hc = NULL;
                if (SUCCEEDED(of->GetRuntimeClassName(&hc)) && hc) {
                    PCWSTR p = WindowsGetStringRawBuffer(hc, NULL);
                    if (p) NarrowCopy(g_resBrushClass, sizeof(g_resBrushClass), p);
                    WindowsDeleteString(hc);
                }
                if (!g_origBrushSaved) {
                    InterlockedExchange64(&g_origBrush, (LONG64)of);   // 保留原始引用（不 Release，供 RESTORE
                    InterlockedExchange(&g_origBrushSaved, 1);
                } else {
                    of->Release();   // 已存过原始，这个临时引用释放
                }
            }
        } else {
            InterlockedExchange(&g_resHrGet, (LONG)E_NOINTERFACE);
        }
        // 同时保存 BackgroundStroke（边框）的原始画
        if (g_strokeHandle && !g_origStrokeBrushSaved) {
            IInspectable* strokeRect = NULL;
            if (SUCCEEDED(g_diag->GetIInspectableFromHandle((InstanceHandle)g_strokeHandle, &strokeRect)) && strokeRect) {
                IShapeAIL* strokeShape = NULL;
                if (SUCCEEDED(strokeRect->QueryInterface(IID_IShapeAIL, (void**)&strokeShape)) && strokeShape) {
                    IInspectable* origStroke = NULL;
                    if (SUCCEEDED(strokeShape->get_Fill(&origStroke)) && origStroke) {
                        InterlockedExchange64(&g_origStrokeBrush, (LONG64)origStroke);
                        InterlockedExchange(&g_origStrokeBrushSaved, 1);
                    }
                    strokeShape->Release();
                }
                strokeRect->Release();
            }
        }
        InterlockedExchange(&g_doneSeq, seq);
        InterlockedExchange(&g_applying, 0);
        return;
    }

    if (op == OP_RESTORE) {
        const LONG64 ob = g_origBrush;
        HRESULT hrS = E_FAIL;
        if (!shape) {
            hrS = E_NOINTERFACE;
        } else if (ob) {
            hrS = shape->put_Fill((IInspectable*)ob);     // 还原成捕获到的原始画
        } else {
            hrS = S_OK;                                     // 没有原始画刷可还原（极端情况
        }
        // 同时还原 BackgroundStroke（边框）
        const LONG64 osb = g_origStrokeBrush;
        if (g_strokeHandle && osb) {
            IInspectable* strokeRect = NULL;
            if (SUCCEEDED(g_diag->GetIInspectableFromHandle((InstanceHandle)g_strokeHandle, &strokeRect)) && strokeRect) {
                IShapeAIL* strokeShape = NULL;
                if (SUCCEEDED(strokeRect->QueryInterface(IID_IShapeAIL, (void**)&strokeShape)) && strokeShape) {
                    strokeShape->put_Fill((IInspectable*)osb);
                    strokeShape->Release();
                }
                strokeRect->Release();
            }
        }
        InterlockedExchange(&g_resHrSet, (LONG)hrS);
        if (allowLog) Log("RESTORE hrShape=0x%08lx hrSet=0x%08lx", (unsigned long)g_resHrShape, (unsigned long)hrS);
    } else if (op == OP_FILL && shape) {
        wchar_t val[16];
        swprintf(val, 16, L"#%08lX", (unsigned long)g_resArgb);
        BSTR tn = SysAllocString(L"Windows.UI.Xaml.Media.SolidColorBrush");
        BSTR vs = SysAllocString(val);
        InstanceHandle br = 0;
        HRESULT hrC = g_vts->CreateInstance(tn, vs, &br);
        InterlockedExchange(&g_resHrCreate, (LONG)hrC);
        SysFreeString(tn); SysFreeString(vs);
        if (SUCCEEDED(hrC) && br) {
            IInspectable* brush = NULL;
            HRESULT hrB = g_diag->GetIInspectableFromHandle(br, &brush);
            InterlockedExchange(&g_resHrBrush, (LONG)hrB);
            if (SUCCEEDED(hrB) && brush) {
                HRESULT hrS = shape->put_Fill(brush);      // 换掉 BackgroundFill.Fill
                InterlockedExchange(&g_resHrSet, (LONG)hrS);
                InterlockedExchange64(&g_resNewBrush, (LONG64)brush);

                // 同时设置 BackgroundStroke（边框）为透明
                // 对于透明效果，边框也需要透明；对于其他效果，边框保持半透明
                if (g_strokeHandle) {
                    IInspectable* strokeRect = NULL;
                    if (SUCCEEDED(g_diag->GetIInspectableFromHandle((InstanceHandle)g_strokeHandle, &strokeRect)) && strokeRect) {
                        IShapeAIL* strokeShape = NULL;
                        if (SUCCEEDED(strokeRect->QueryInterface(IID_IShapeAIL, (void**)&strokeShape)) && strokeShape) {
                            // 保存原始边框画刷（仅第一次）
                            if (!g_origStrokeBrushSaved) {
                                IInspectable* origStroke = NULL;
                                if (SUCCEEDED(strokeShape->get_Fill(&origStroke)) && origStroke) {
                                    InterlockedExchange64(&g_origStrokeBrush, (LONG64)origStroke);
                                    InterlockedExchange(&g_origStrokeBrushSaved, 1);
                                }
                            }
                            // 边框使用更透明的颜色（alpha 更低
                            unsigned long strokeArgb = g_resArgb;
                            // 如果是透明效果（alpha<=1），边框也完全透明
                            if ((g_resArgb >> 24) <= 1) {
                                strokeArgb = 0x00000000;  // 完全透明
                            } else {
                                // 其他效果，边框透明度减
                                unsigned long alpha = (g_resArgb >> 24) / 2;
                                strokeArgb = (alpha << 24) | (g_resArgb & 0x00FFFFFF);
                            }
                            wchar_t strokeVal[16];
                            swprintf(strokeVal, 16, L"#%08lX", strokeArgb);
                            BSTR stn = SysAllocString(L"Windows.UI.Xaml.Media.SolidColorBrush");
                            BSTR svs = SysAllocString(strokeVal);
                            InstanceHandle sbr = 0;
                            if (SUCCEEDED(g_vts->CreateInstance(stn, svs, &sbr)) && sbr) {
                                IInspectable* sbrush = NULL;
                                if (SUCCEEDED(g_diag->GetIInspectableFromHandle(sbr, &sbrush)) && sbrush) {
                                    strokeShape->put_Fill(sbrush);
                                    sbrush->Release();
                                }
                                SysFreeString(stn); SysFreeString(svs);
                            }
                            strokeShape->Release();
                        }
                        strokeRect->Release();
                    }
                }

                if (allowLog) {
                    Log("FILL argb=0x%08lX brush=0x%llx hrSet=0x%08lx stroke=0x%llx",
                        (unsigned long)g_resArgb, (unsigned long long)brush, (unsigned long)hrS,
                        (unsigned long long)g_strokeHandle);
                }
                brush->Release();
            }
        } else {
            if (allowLog) Log("FILL 建画刷失�?hrCreate=0x%08lx", (unsigned long)g_resHrCreate);
        }
    } else if (op == OP_ACRYLIC && shape) {
        // 创建 AcrylicBrush（亚克力效果�）
        // 依据 TranslucentTB 源码：AcrylicBrush{ BackgroundSource=Backdrop, TintColor=tint }
        // Backdrop 模式下，窗口失活时效果仍保留（HostBackdrop 会在失活时禁用）
        // 注意：CreateInstance �?value 参数对于 AcrylicBrush 必须�?NULL（不能是空字符串），
        // 否则会返�?E_POINTER。AcrylicBrush 没有字符串构造函数
        BSTR tn = SysAllocString(L"Windows.UI.Xaml.Media.AcrylicBrush");
        InstanceHandle br = 0;
        HRESULT hrC = g_vts->CreateInstance(tn, NULL, &br);
        InterlockedExchange(&g_resHrCreate, (LONG)hrC);
        SysFreeString(tn);
        if (SUCCEEDED(hrC) && br) {
            IInspectable* brush = NULL;
            HRESULT hrB = g_diag->GetIInspectableFromHandle(br, &brush);
            InterlockedExchange(&g_resHrBrush, (LONG)hrB);
            if (SUCCEEDED(hrB) && brush) {
                // 通过属性链找到 BackgroundSource �?TintColor 属性索
                unsigned int sc = 0, vc = 0;
                PropertyChainSource* ps = NULL;
                PropertyChainValue* pv = NULL;
                HRESULT hrChain = g_vts->GetPropertyValuesChain(br, &sc, &ps, &vc, &pv);
                if (SUCCEEDED(hrChain) && pv) {
                    unsigned int bgIdx = (unsigned int)-1;
                    unsigned int tintIdx = (unsigned int)-1;
                    for (unsigned int i = 0; i < vc; i++) {
                        char nm[64] = {0};
                        if (pv[i].PropertyName) NarrowCopy(nm, sizeof(nm), pv[i].PropertyName);
                        if (strcmp(nm, "BackgroundSource") == 0) bgIdx = pv[i].Index;
                        if (strcmp(nm, "TintColor") == 0) tintIdx = pv[i].Index;
                        if (pv[i].PropertyName) SysFreeString(pv[i].PropertyName);
                        if (pv[i].Type) SysFreeString(pv[i].Type);
                        if (pv[i].DeclaringType) SysFreeString(pv[i].DeclaringType);
                        if (pv[i].ValueType) SysFreeString(pv[i].ValueType);
                        if (pv[i].ItemType) SysFreeString(pv[i].ItemType);
                        if (pv[i].Value) SysFreeString(pv[i].Value);
                    }
                    if (ps) { for (unsigned int i = 0; i < sc; i++) { if (ps[i].TargetType) SysFreeString(ps[i].TargetType); if (ps[i].Name) SysFreeString(ps[i].Name); } }
                    CoTaskMemFree(pv); CoTaskMemFree(ps);

                    // 设置 BackgroundSource = Backdrop (枚举�?1)
                    if (bgIdx != (unsigned int)-1) {
                        InstanceHandle enumVal = 0;
                        BSTR enumType = SysAllocString(L"Windows.UI.Xaml.Media.AcrylicBackgroundSource");
                        BSTR enumValStr = SysAllocString(L"Backdrop");
                        HRESULT hrEnum = g_vts->CreateInstance(enumType, enumValStr, &enumVal);
                        SysFreeString(enumType); SysFreeString(enumValStr);
                        if (SUCCEEDED(hrEnum) && enumVal) {
                            g_vts->SetProperty(br, enumVal, bgIdx);
                        }
                    }

                    // 设置 TintColor（如果指定了颜色
                    if (tintIdx != (unsigned int)-1 && g_resArgb) {
                        wchar_t colorVal[16];
                        swprintf(colorVal, 16, L"#%08lX", (unsigned long)g_resArgb);
                        InstanceHandle colorObj = 0;
                        BSTR colorType = SysAllocString(L"Windows.UI.Color");
                        BSTR colorStr = SysAllocString(colorVal);
                        HRESULT hrColor = g_vts->CreateInstance(colorType, colorStr, &colorObj);
                        SysFreeString(colorType); SysFreeString(colorStr);
                        if (SUCCEEDED(hrColor) && colorObj) {
                            g_vts->SetProperty(br, colorObj, tintIdx);
                        }
                    }
                }

                // 设置�?BackgroundFill.Fill
                HRESULT hrS = shape->put_Fill(brush);
                InterlockedExchange(&g_resHrSet, (LONG)hrS);
                InterlockedExchange64(&g_resNewBrush, (LONG64)brush);

                // 同时设置 BackgroundStroke（边框）为透明
                if (g_strokeHandle) {
                    IInspectable* strokeRect = NULL;
                    if (SUCCEEDED(g_diag->GetIInspectableFromHandle((InstanceHandle)g_strokeHandle, &strokeRect)) && strokeRect) {
                        IShapeAIL* strokeShape = NULL;
                        if (SUCCEEDED(strokeRect->QueryInterface(IID_IShapeAIL, (void**)&strokeShape)) && strokeShape) {
                            // 保存原始边框画刷（仅第一次）
                            if (!g_origStrokeBrushSaved) {
                                IInspectable* origStroke = NULL;
                                if (SUCCEEDED(strokeShape->get_Fill(&origStroke)) && origStroke) {
                                    InterlockedExchange64(&g_origStrokeBrush, (LONG64)origStroke);
                                    InterlockedExchange(&g_origStrokeBrushSaved, 1);
                                }
                            }
                            // 亚克力效果下边框使用半透明
                            wchar_t strokeVal[16];
                            swprintf(strokeVal, 16, L"#%08lX", (unsigned long)0x1A000000);  // 10% 黑色
                            BSTR stn = SysAllocString(L"Windows.UI.Xaml.Media.SolidColorBrush");
                            BSTR svs = SysAllocString(strokeVal);
                            InstanceHandle sbr = 0;
                            if (SUCCEEDED(g_vts->CreateInstance(stn, svs, &sbr)) && sbr) {
                                IInspectable* sbrush = NULL;
                                if (SUCCEEDED(g_diag->GetIInspectableFromHandle(sbr, &sbrush)) && sbrush) {
                                    strokeShape->put_Fill(sbrush);
                                    sbrush->Release();
                                }
                                SysFreeString(stn); SysFreeString(svs);
                            }
                            strokeShape->Release();
                        }
                        strokeRect->Release();
                    }
                }

                if (allowLog) {
                    Log("ACRYLIC argb=0x%08lX brush=0x%llx hrSet=0x%08lx stroke=0x%llx",
                        (unsigned long)g_resArgb, (unsigned long long)brush, (unsigned long)hrS,
                        (unsigned long long)g_strokeHandle);
                }
                brush->Release();
            }
        } else {
            // AcrylicBrush 创建失败，回退到半透明 SolidColorBrush
            if (allowLog) Log("ACRYLIC 建画刷失�?hrCreate=0x%08lx，回退到半透明 SolidColorBrush", (unsigned long)g_resHrCreate);
            wchar_t val[16];
            swprintf(val, 16, L"#%08lX", (unsigned long)(g_resArgb ? g_resArgb : 0x33FFFFFF));
            BSTR tn2 = SysAllocString(L"Windows.UI.Xaml.Media.SolidColorBrush");
            BSTR vs2 = SysAllocString(val);
            InstanceHandle br2 = 0;
            g_vts->CreateInstance(tn2, vs2, &br2);
            SysFreeString(tn2); SysFreeString(vs2);
            if (br2) {
                IInspectable* brush2 = NULL;
                if (SUCCEEDED(g_diag->GetIInspectableFromHandle(br2, &brush2)) && brush2) {
                    shape->put_Fill(brush2);
                    brush2->Release();
                }
            }
        }
    }

    if (rect) rect->Release();
    if (shape) shape->Release();

    InterlockedExchange(&g_doneSeq, seq);
    InterlockedExchange(&g_applying, 0);
}

static void WriteResult(HANDLE pipe, const char* tag, int via, int done) {
  char b[2048];
    snprintf(b, sizeof(b),
             "R|tag=%s|op=%ld|via=%s|done=%d|uiTid=%ld|ops=%ld|cbDone=%ld|enqDone=%ld",
             tag, (long)g_resOp,
             via == 1 ? "enqueue" : (via == 2 ? "direct" : "callback"),
             done, (long)g_resUiThread, (long)g_opCount,
             (long)g_applyOnCallback, (long)g_applyViaEnqueue);
    WriteLine(pipe, b);

    snprintf(b, sizeof(b), "T|frame=0x%llx|fill=0x%llx|stroke=0x%llx|frameSeen=%ld",
             (unsigned long long)g_frameHandle, (unsigned long long)g_fillHandle,
             (unsigned long long)g_strokeHandle, (long)g_frameSeen);
    WriteLine(pipe, b);

    snprintf(b, sizeof(b), "X|hrIdx=0x%08lx|propIndex=%ld|hrGet=0x%08lx|prevBrush=0x%llx|brushClass=%s",
             (unsigned long)g_resHrIdx, (long)g_resPropIndex, (unsigned long)g_resHrGet,
             (unsigned long long)g_resPrevBrush, g_resBrushClass);
    WriteLine(pipe, b);

    snprintf(b, sizeof(b), "S|argb=0x%08lx|hrCreate=0x%08lx|hrColor=0x%08lx|newBrush=0x%llx|hrSet=0x%08lx",
             (unsigned long)g_resArgb, (unsigned long)g_resHrCreate, (unsigned long)g_resHrColor,
             (unsigned long long)g_resNewBrush, (unsigned long)g_resHrSet);
    WriteLine(pipe, b);

    snprintf(b, sizeof(b), "Q|qState=%ld|qHr=0x%08lx|qTid=%ld|origBrush=0x%llx|origSaved=%ld",
             (long)g_qState, (unsigned long)g_qHr, (long)g_qTid,
             (unsigned long long)g_origBrush, (long)g_origBrushSaved);
    WriteLine(pipe, b);

    snprintf(b, sizeof(b), "D|hrRect=0x%08lx|hrShape=0x%08lx|hrBrush=0x%08lx|hrCreate=0x%08lx",
             (unsigned long)g_resHrRect, (unsigned long)g_resHrShape,
             (unsigned long)g_resHrBrush, (unsigned long)g_resHrCreate);
    WriteLine(pipe, b);

    snprintf(b, sizeof(b), "E|enum=%s|hrChain=0x%08lx", g_resEnum, (unsigned long)g_resHrChain);
    WriteLine(pipe, b);

    snprintf(b, sizeof(b), "B|borderCount=%ld|bgIdx=%ld|borderProps=%s",
             (long)g_resBorderCount, (long)g_resBorderBgIdx, g_resBorderProps);
    WriteLine(pipe, b);

    WriteLine(pipe, "END");
}

// XAML 外观命令。支�?`:now` 后缀 = �?*当前（管道）线程**上执行，
// 专门用来对比线程亲和性（预期会失败或返回 RPC_E_WRONG_THREAD，属于诊断实验）
static int HandleXamlCmd(const char* cmd, HANDLE pipe) {
    char buf[96];
    snprintf(buf, sizeof(buf), "%s", cmd);
    if (!buf[0]) { WriteLine(pipe, "ERR empty"); return 0; }

    int direct = 0;
    char* colon = strchr(buf, ':');
    if (colon) {
        if (strcmp(colon + 1, "now") == 0) direct = 1;
        *colon = '\0';
    }

    char verb[32] = {0};
    char* arg = buf;
    while (*arg == ' ') ++arg;
    int i = 0;
    while (*arg && *arg != ' ' && *arg != '=' && i < (int)sizeof(verb) - 1) verb[i++] = *arg++;
    verb[i] = '\0';
    while (*arg == ' ' || *arg == '=') ++arg;
    if (*arg == '#') ++arg;

    LONG op = OP_NONE;
    unsigned long argb = 0;
    if (strcmp(verb, "PROBE") == 0)        op = OP_PROBE;
    else if (strcmp(verb, "QI") == 0)      op = OP_QICAP;
    else if (strcmp(verb, "RESTORE") == 0) op = OP_RESTORE;
    else if (strcmp(verb, "FILL") == 0) {
        op = OP_FILL;
        if (*arg) argb = strtoul(arg, NULL, 16);
        if (!argb) argb = 0x01FFFFFF;      // 防呆�? 视为非法（alpha=1 的近全透明
    }
    else if (strcmp(verb, "ACRYLIC") == 0) {
        op = OP_ACRYLIC;
        if (*arg) argb = strtoul(arg, NULL, 16);
        // 亚克力默认色调：半透明白色（浅色主题）或半透明黑色（深色主题）
        // 这里�?0x33FFFFFF 作为默认�?0% 不透明的白色）
        if (!argb) argb = 0x33FFFFFF;
    }
    else if (strcmp(verb, "FILL_BORDER") == 0) {
        op = OP_FILL_BORDER;
        if (*arg) argb = strtoul(arg, NULL, 16);
        // 允许 00000000 完全透明，不做默认值替
    }
    else if (strcmp(verb, "FILL_ALL") == 0) {
        op = OP_FILL_ALL;
        if (*arg) argb = strtoul(arg, NULL, 16);
        // 允许 00000000 完全透明，不做默认值替
    }
    else if (strcmp(verb, "SET_ACRYLIC_OPACITY") == 0) {
        op = OP_SET_ACRYLIC_OPACITY;
        if (*arg) argb = strtoul(arg, NULL, 16);
        if (!argb) argb = 0x00000000;  // 默认完全透明
    }
    else if (strcmp(verb, "DIRECT_ACRYLIC") == 0) {
        op = OP_DIRECT_ACRYLIC;
        if (*arg) argb = strtoul(arg, NULL, 16);
    }
    if (op == OP_NONE) { WriteLine(pipe, "ERR unknown-xaml-cmd"); return 0; }
    Log("HC verb=%s op=%ld direct=%d", verb, (long)op, direct);

    if (direct) {
        InterlockedIncrement(&g_pendingSeq);
        InterlockedExchange(&g_pendingArgb, (LONG)argb);
        InterlockedExchange(&g_resArgb, (LONG)argb);
        InterlockedExchange(&g_pendingOp, op);
        RunPendingOp(1);                    // �?就在管道线程上执行（实验；这里的 Log 是安全的
        WriteResult(pipe, verb, 2, 1);
        return 0;
    }

    int enq = 0;
    const LONG seq = SubmitOp(op, argb, &enq);
    Log("HC submitted op=%ld seq=%ld enq=%d", (long)op, (long)seq, enq);
    const int done = WaitDone(seq, 2500);
    Log("HC waited done=%d", done);
    WriteResult(pipe, verb, enq ? 1 : 0, done);
    if (!done) {
        WriteLine(pipe, "W|pending=1|note=尚未轮到 UI 线程；下一次视觉树事件会自动补做（点一下任务栏可催）");
    }
    return 0;
}

// ============================================================
// 命名管道
// ============================================================
static BOOL CreatePipeSecured(HANDLE* out) {
    // 不用 FILE_FLAG_FIRST_PIPE_INSTANCE：我们要**同时存在两个实例**
    // （一个在服务当前连接，另一个在监听），�?PipeThreadProc 的说明�）
    // 名字里已�?pid+装载时刻，本来就不会和历史实例相撞，不需要这个标志兜底
    HANDLE h = CreateNamedPipeA(
        g_pipeName,
        PIPE_ACCESS_DUPLEX,
        PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
        4, 4096, 4096, 1000, NULL);
    *out = h;
    return h != INVALID_HANDLE_VALUE;
}

static void DoUninstall() {
    if (g_vts && g_watcherRaw) {
        IVisualTreeServiceCallback* cb = NULL;
        if (SUCCEEDED(g_watcherRaw->QueryInterface(IID_IVisualTreeServiceCallback, (void**)&cb)) && cb) {
            HRESULT hr = g_vts->UnadviseVisualTreeChange(cb);
            Log("UnadviseVisualTreeChange hr=0x%08lx", (unsigned long)hr);
            cb->Release();
        }
    }
    InterlockedExchange(&g_advised, 0);
    if (g_tapSite) { g_tapSite->DetachSite(); g_tapSite->Release(); g_tapSite = NULL; }
    if (g_watcherRaw) { g_watcherRaw->Release(); g_watcherRaw = NULL; }
    if (g_vts) { g_vts->Release(); g_vts = NULL; }
    if (g_diag) { g_diag->Release(); g_diag = NULL; }
}

// 返回 0 = 继续服务�? = 请求卸载
static int HandleCommand(const char* cmd, HANDLE pipe);
static int HandleCommand(const char* cmd, HANDLE pipe) {
    if (strcmp(cmd, "PING") == 0) { WriteLine(pipe, "PONG"); return 0; }

    if (strcmp(cmd, "STATUS") == 0) {
        char b[256];
        snprintf(b, sizeof(b), "S|state=%ld|attempts=%ld|lastHr=0x%08lx|adviseHr=0x%08lx|advised=%ld|events=%ld|frames=%ld|fills=%ld|strokes=%ld|recs=%ld",
                 g_attachState, g_attachAttempts, (unsigned long)g_attachHr, (unsigned long)g_qiHr,
                 g_advised, g_totalEvents, g_frames, g_fills, g_strokes, g_recCount);
        WriteLine(pipe, b);
        char b2[256];
        snprintf(b2, sizeof(b2), "S2|frame=0x%llx|fill=0x%llx|stroke=0x%llx|frameSeen=%ld|qState=%ld|qStatics=%ld|autoQi=%ld|qHr=0x%08lx|qTid=%ld|ops=%ld|cbDone=%ld|enqDone=%ld|origSaved=%ld|pending=%ld|seq=%ld/%ld",
                 (unsigned long long)g_frameHandle, (unsigned long long)g_fillHandle,
                 (unsigned long long)g_strokeHandle, (long)g_frameSeen,
                 (long)g_qState, (long)g_qStaticsState, (long)g_autoQicap,
                 (unsigned long)g_qHr, (long)g_qTid,
                 (long)g_opCount, (long)g_applyOnCallback, (long)g_applyViaEnqueue,
                 (long)g_origBrushSaved, (long)g_pendingOp, (long)g_doneSeq, (long)g_pendingSeq);
        WriteLine(pipe, b2);
        return 0;
    }

    if (strcmp(cmd, "LOG") == 0) {
        // 先把记录快照到本地再逐行写：绝不在持锁期间做 I/O（会阻塞 XAML UI 线程上的回调）
        static Rec snapshot[MAX_REC];
        LONG n = 0;
        if (g_csReady) {
            EnterCriticalSection(&g_cs);
            n = g_recCount;
            if (n > MAX_REC) n = MAX_REC;
            if (n > 0) memcpy(snapshot, g_recs, sizeof(Rec) * (size_t)n);
            LeaveCriticalSection(&g_cs);
        }
        for (LONG i = 0; i < n; i++) {
            char line[384];
            snprintf(line, sizeof(line), "E|%ld|%ld|%ld|%s|%s|0x%llx|0x%llx",
                     snapshot[i].kind, snapshot[i].count, snapshot[i].interesting,
                     snapshot[i].type, snapshot[i].name,
                     snapshot[i].handle, snapshot[i].parent);
            WriteLine(pipe, line);
        }
        char tail[256];
        snprintf(tail, sizeof(tail), "END events=%ld recs=%ld frames=%ld fills=%ld strokes=%ld",
                 g_totalEvents, g_recCount, g_frames, g_fills, g_strokes);
        WriteLine(pipe, tail);
        return 0;
    }

    if (strcmp(cmd, "RESET") == 0) {
        if (g_csReady) {
            EnterCriticalSection(&g_cs);
            ZeroMemory(g_recs, sizeof(g_recs));
            InterlockedExchange(&g_recCount, 0);
            LeaveCriticalSection(&g_cs);
        }
        InterlockedExchange(&g_totalEvents, 0);
        InterlockedExchange(&g_frames, 0);
        InterlockedExchange(&g_fills, 0);
        InterlockedExchange(&g_strokes, 0);
        WriteLine(pipe, "OK");
        return 0;
    }

    if (strcmp(cmd, "ENUM") == 0) {
        // 枚举所有看到的视觉树元素（用于调试：找到开始菜�?通知中心的背景元素）
        static EnumElement snapshot[MAX_ENUM_ELEMENTS];
        LONG n = 0;
        if (g_enumCsReady) {
            EnterCriticalSection(&g_enumCs);
            n = g_enumCount;
            if (n > MAX_ENUM_ELEMENTS) n = MAX_ENUM_ELEMENTS;
            if (n > 0) memcpy(snapshot, g_enumElements, sizeof(EnumElement) * (size_t)n);
            LeaveCriticalSection(&g_enumCs);
        }
        for (LONG i = 0; i < n; i++) {
            char line[512];
            snprintf(line, sizeof(line), "N|%ld|%s|%s|0x%llx",
                     i, snapshot[i].type, snapshot[i].name,
                     (unsigned long long)snapshot[i].handle);
            WriteLine(pipe, line);
        }
        char tail[128];
        snprintf(tail, sizeof(tail), "END enum=%ld", n);
        WriteLine(pipe, tail);
        return 0;
    }

    if (strcmp(cmd, "ENUM_RESET") == 0) {
        if (g_enumCsReady) {
            EnterCriticalSection(&g_enumCs);
            ZeroMemory(g_enumElements, sizeof(g_enumElements));
            InterlockedExchange(&g_enumCount, 0);
            LeaveCriticalSection(&g_enumCs);
        }
        WriteLine(pipe, "OK");
        return 0;
    }

    if (strcmp(cmd, "DUMPBRUSHES") == 0) {
        // 诊断：遍历视觉树所有元素，列出�?Brush/背景/透明度语义的属性，定位真正绘制背景/模糊的元
        if (g_enumCsReady) {
            EnterCriticalSection(&g_enumCs);
            LONG n = g_enumCount;
            if (n > MAX_ENUM_ELEMENTS) n = MAX_ENUM_ELEMENTS;
            for (LONG i = 0; i < n; i++) {
                LONG64 h = (LONG64)g_enumElements[i].handle;
                if (!h) continue;
                IInspectable* obj = NULL;
                if (FAILED(g_diag->GetIInspectableFromHandle((InstanceHandle)h, &obj)) || !obj) continue;
                unsigned int sc = 0, vc = 0;
                PropertyChainSource* ps = NULL;
                PropertyChainValue* pv = NULL;
                char line[2048] = {0};
                int pos = 0;
                HRESULT hr = g_vts ? g_vts->GetPropertyValuesChain((InstanceHandle)h, &sc, &ps, &vc, &pv) : E_FAIL;
                if (SUCCEEDED(hr) && pv) {
                    for (unsigned int j = 0; j < vc; j++) {
                        char nm[64] = {0}, vt[96] = {0}, t[64] = {0};
                        if (pv[j].PropertyName) NarrowCopy(nm, sizeof(nm), pv[j].PropertyName);
                        if (pv[j].ValueType) NarrowCopy(vt, sizeof(vt), pv[j].ValueType);
                        if (pv[j].Type) NarrowCopy(t, sizeof(t), pv[j].Type);
                        bool brushy = strstr(vt, "Brush") || strstr(vt, "Mica") || strstr(vt, "Acrylic") ||
                                      strstr(nm, "ackground") || strstr(nm, "int") || strstr(nm, "pacity") ||
                                      strstr(nm, "ackdrop");
                        if (brushy && pos < (int)sizeof(line) - 160) {
                            pos += snprintf(line + pos, sizeof(line) - pos, "[%s]%s(idx=%u,vt=%s) ",
                                            t, nm, pv[j].Index, vt);
                        }
                    }
                    for (unsigned int j = 0; j < vc; j++) {
                        if (pv[j].PropertyName) SysFreeString(pv[j].PropertyName);
                        if (pv[j].Type) SysFreeString(pv[j].Type);
                        if (pv[j].DeclaringType) SysFreeString(pv[j].DeclaringType);
                        if (pv[j].ValueType) SysFreeString(pv[j].ValueType);
                        if (pv[j].ItemType) SysFreeString(pv[j].ItemType);
                        if (pv[j].Value) SysFreeString(pv[j].Value);
                    }
                    if (ps) { for (unsigned int j = 0; j < sc; j++) { if (ps[j].TargetType) SysFreeString(ps[j].TargetType); if (ps[j].Name) SysFreeString(ps[j].Name); } }
                    CoTaskMemFree(pv); CoTaskMemFree(ps);
                }
                obj->Release();
                if (pos > 0) {
                    char out[2200];
                    snprintf(out, sizeof(out), "D|%ld|%s|%s|%s",
                             i, g_enumElements[i].type, g_enumElements[i].name, line);
                    WriteLine(pipe, out);
                }
            }
            LeaveCriticalSection(&g_enumCs);
        }
        WriteLine(pipe, "END dump");
        return 0;
    }

    if (strcmp(cmd, "PROBE_BG") == 0) {
        // 诊断：对所有元素用 GetPropertyIndex + GetProperty 精确探测背景画刷类型
        // （GetPropertyValuesChain 在部分实例上返回短链，这里走 IVisualTreeService2 的精确索引）
        if (g_enumCsReady) {
            EnterCriticalSection(&g_enumCs);
            LONG n = g_enumCount;
            if (n > MAX_ENUM_ELEMENTS) n = MAX_ENUM_ELEMENTS;
            for (LONG i = 0; i < n; i++) {
                LONG64 h = (LONG64)g_enumElements[i].handle;
                if (!h) continue;
                IInspectable* obj = NULL;
                if (FAILED(g_diag->GetIInspectableFromHandle((InstanceHandle)h, &obj)) || !obj) continue;
                char out[1800] = {0};
                int pos = 0;
                pos += snprintf(out + pos, sizeof(out) - pos, "P|%ld|%s|%s|",
                                i, g_enumElements[i].type, g_enumElements[i].name);
                static const wchar_t* propNames[] = { L"Background", L"Backdrop", L"Fill", L"BackdropBrush" };
                for (int pi = 0; pi < 4; pi++) {
                    unsigned int idx = 0;
                    HRESULT hri = g_vts ? g_vts->GetPropertyIndex((InstanceHandle)h, propNames[pi], &idx) : E_FAIL;
                    if (SUCCEEDED(hri)) {
                        InstanceHandle val = 0;
                        HRESULT hrg = g_vts->GetProperty((InstanceHandle)h, idx, &val);
                        if (SUCCEEDED(hrg) && val) {
                            IInspectable* vobj = NULL;
                            if (SUCCEEDED(g_diag->GetIInspectableFromHandle(val, &vobj)) && vobj) {
                                HSTRING hs = NULL;
                                HRESULT hrc = vobj->GetRuntimeClassName(&hs);
                                if (SUCCEEDED(hrc) && hs) {
                                    char cbuf[160] = {0};
                                    UINT32 hlen = 0;
                                    const wchar_t* wcls = WindowsGetStringRawBuffer(hs, &hlen);
                                    if (wcls) NarrowCopy(cbuf, sizeof(cbuf), wcls);
                                    pos += snprintf(out + pos, sizeof(out) - pos, "%ls(idx=%u)=%s; ",
                                                    propNames[pi], idx, cbuf);
                                    WindowsDeleteString(hs);
                                }
                                vobj->Release();
                            } else {
                                pos += snprintf(out + pos, sizeof(out) - pos, "%ls(idx=%u)=handle; ", propNames[pi], idx);
                            }
                        } else {
                            pos += snprintf(out + pos, sizeof(out) - pos, "%ls(idx=%u)=null; ", propNames[pi], idx);
                        }
                    }
                }
                obj->Release();
                if (pos > 0) {
                    WriteLine(pipe, out);
                }
            }
            LeaveCriticalSection(&g_enumCs);
        }
        WriteLine(pipe, "END probe");
        return 0;
    }

    if (strncmp(cmd, "SETPROP ", 8) == 0) {
        // SETPROP <elemIdx> <propIdx> <AARRGGBB>：把枚举元素的指定属性设为纯色画刷
        long target = -1, propIdx = -1;
        unsigned long sargb = 0;
        char tmp[128] = {0};
        strncpy(tmp, cmd + 8, sizeof(tmp) - 1);
        char* p = tmp;
        char* tok = strtok(p, " ");
        if (tok) target = atol(tok);
        tok = strtok(NULL, " ");
        if (tok) propIdx = atol(tok);
        tok = strtok(NULL, " ");
        if (tok) sargb = strtoul(tok, NULL, 16);
        if (target < 0 || propIdx < 0) { WriteLine(pipe, "ERR setprop-args"); return 0; }
        InterlockedExchange(&g_dumpTarget, target);
        InterlockedExchange(&g_setpropIdx, propIdx);
        int enq = 0;
        LONG seq = SubmitOp(OP_SETPROP, sargb, &enq);
        if (enq) WaitDone(seq, 8000);
        WriteLine(pipe, g_dumpBuf[0] ? g_dumpBuf : "P|||no result");
        WriteLine(pipe, "END setprop");
        return 0;
    }

    if (strncmp(cmd, "DUMP_PROPS ", 11) == 0) {
        // DUMP_PROPS <idx>：在 UI 线程 dump 指定枚举元素的完整属性链（名�?索引
        long target = atol(cmd + 11);
        InterlockedExchange(&g_dumpTarget, target);
        int enq = 0;
        LONG seq = SubmitOp(OP_DUMP_PROPS, 0, &enq);
        if (enq) WaitDone(seq, 8000);
        WriteLine(pipe, g_dumpBuf[0] ? g_dumpBuf : "P|||no result");
        WriteLine(pipe, "END dump");
        return 0;
    }

    if (strcmp(cmd, "DUMPVALS") == 0) {
        int enq = 0;
        LONG seq = SubmitOp(OP_DUMPVALS, 0, &enq);
        if (enq) WaitDone(seq, 15000);
        WriteLine(pipe, g_dumpBuf[0] ? g_dumpBuf : "P|||no result");
        WriteLine(pipe, "END dumpvals");
        return 0;
    }

    if (strncmp(cmd, "BGCLASS ", 8) == 0) {
        long target = atol(cmd + 8);
        InterlockedExchange(&g_dumpTarget, target);
        int enq = 0;
        LONG seq = SubmitOp(OP_BGCLASS, 0, &enq);
        if (enq) WaitDone(seq, 8000);
        WriteLine(pipe, g_dumpBuf[0] ? g_dumpBuf : "P|||no result");
        WriteLine(pipe, "END bgclass");
        return 0;
    }

    if (strncmp(cmd, "PUTBG ", 6) == 0) {
        long target = -1;
        unsigned long sargb = 0;
        char tmp[128] = {0};
        strncpy(tmp, cmd + 6, sizeof(tmp) - 1);
        char* p = tmp;
        char* tok = strtok(p, " ");
        if (tok) target = atol(tok);
        tok = strtok(NULL, " ");
        if (tok) sargb = strtoul(tok, NULL, 16);
        if (target < 0) { WriteLine(pipe, "ERR putbg-args"); return 0; }
        InterlockedExchange(&g_dumpTarget, target);
        int enq = 0;
        LONG seq = SubmitOp(OP_PUTBG, sargb, &enq);
        if (enq) WaitDone(seq, 8000);
        WriteLine(pipe, g_dumpBuf[0] ? g_dumpBuf : "P|||no result");
        WriteLine(pipe, "END putbg");
        return 0;
    }

    if (strncmp(cmd, "ACRYLIC_KILL ", 13) == 0) {
        long target = atol(cmd + 13);
        if (target < 0) { WriteLine(pipe, "ERR acrylic-args"); return 0; }
        InterlockedExchange(&g_dumpTarget, target);
        int enq = 0;
        LONG seq = SubmitOp(OP_ACRYLIC_KILL, 0, &enq);
        if (enq) WaitDone(seq, 8000);
        WriteLine(pipe, g_dumpBuf[0] ? g_dumpBuf : "P|||no result");
        WriteLine(pipe, "END acrylic_kill");
        return 0;
    }

    if (strncmp(cmd, "ACRYLIC_KILL2 ", 14) == 0) {
        long target = atol(cmd + 14);
        if (target < 0) { WriteLine(pipe, "ERR acrylic2-args"); return 0; }
        InterlockedExchange(&g_dumpTarget, target);
        int enq = 0;
        LONG seq = SubmitOp(OP_ACRYLIC_KILL2, 0, &enq);
        if (enq) WaitDone(seq, 8000);
        WriteLine(pipe, g_dumpBuf[0] ? g_dumpBuf : "P|||no result");
        WriteLine(pipe, "END acrylic_kill2");
        return 0;
    }

    if (strncmp(cmd, "OPACITY ", 8) == 0) {
        long target = -1; long val = -1;
        char tmp[128] = {0};
        strncpy(tmp, cmd + 8, sizeof(tmp) - 1);
        char* p = tmp;
        char* tok = strtok(p, " ");
        if (tok) target = atol(tok);
        tok = strtok(NULL, " ");
        if (tok) val = atol(tok);
        if (target < 0 || val < 0) { WriteLine(pipe, "ERR opacity-args"); return 0; }
        InterlockedExchange(&g_dumpTarget, target);
        int enq = 0;
        LONG seq = SubmitOp(OP_OPACITY, val, &enq);
        if (enq) WaitDone(seq, 8000);
        WriteLine(pipe, g_dumpBuf[0] ? g_dumpBuf : "P|||no result");
        WriteLine(pipe, "END opacity");
        return 0;
    }

    // OPACITYAT <枚举索引> <0..1000>   /   OPACITYNAME <元素名> <0..1000>
    // 直接把某个元素的 Opacity 设成指定值。0 = 全透明，1000 = 原样。
    if (strncmp(cmd, "OPACITYAT", 9) == 0 || strncmp(cmd, "OPACITYNAME", 11) == 0) {
        long idx = -2;
        long val = 1000;
        g_setOpName[0] = 0;
        if (strncmp(cmd, "OPACITYNAME", 11) == 0) {
            const char* p = cmd + 11;
            while (*p == ' ') p++;
            const char* sp2 = strchr(p, ' ');
            size_t L = sp2 ? (size_t)(sp2 - p) : strlen(p);
            if (L >= sizeof(g_setOpName)) L = sizeof(g_setOpName) - 1;
            memcpy(g_setOpName, p, L);
            g_setOpName[L] = 0;
            if (sp2) val = atol(sp2 + 1);
        } else {
            const char* p = cmd + 9;
            while (*p == ' ') p++;
            idx = atol(p);
            const char* sp2 = strchr(p, ' ');
            if (sp2) val = atol(sp2 + 1);
        }
        InterlockedExchange(&g_dumpTarget, (LONG)idx);
        int enq = 0;
        LONG seq = SubmitOp(OP_SETOPACITY_AT, val, &enq);
        if (enq) WaitDone(seq, 8000);
        WriteLine(pipe, g_dumpBuf[0] ? g_dumpBuf : "P|||no result");
        WriteLine(pipe, "END opacity");
        return 0;
    }

    // OPACITYREAL <idx|name> <0..1000>  /  BGTRANSPARENT <idx|name>
    //   真实对象路径改写（绕开 VTS SetProperty 在通知中心元素上的 E_FAIL）
    if (strncmp(cmd, "OPACITYREAL", 11) == 0 || strncmp(cmd, "BGTRANSPARENT", 13) == 0) {
        long idx = -2;
        long val = 1000;
        g_setOpName[0] = 0;
        const char* head = (strncmp(cmd, "OPACITYREAL", 11) == 0) ? cmd + 11 : cmd + 13;
        while (*head == ' ') head++;
        if (head[0] >= '0' && head[0] <= '9') {
            idx = atol(head);                                  // 按索引
            const char* sp2 = strchr(head, ' ');
            if (sp2) val = atol(sp2 + 1);
        } else if (head[0]) {
            const char* sp2 = strchr(head, ' ');               // 按名字
            size_t L = sp2 ? (size_t)(sp2 - head) : strlen(head);
            if (L >= sizeof(g_setOpName)) L = sizeof(g_setOpName) - 1;
            memcpy(g_setOpName, head, L);
            g_setOpName[L] = 0;
            if (sp2) val = atol(sp2 + 1);
        }
        InterlockedExchange(&g_dumpTarget, (LONG)idx);
        int enq = 0;
        LONG op = (strncmp(cmd, "OPACITYREAL", 11) == 0) ? OP_OPACITYREAL : OP_BGTRANSPARENT;
        LONG seq = SubmitOp(op, (unsigned long)val, &enq);
        if (enq) WaitDone(seq, 8000);
        WriteLine(pipe, g_dumpBuf[0] ? g_dumpBuf : "P|||no result");
        WriteLine(pipe, "END");
        return 0;
    }

    // AUTOBG LOG —— 必须放在下面的通用 AUTOBG 分支**之前**：
    // 那个分支是 strncmp(cmd,"AUTOBG",6) 前缀匹配，"AUTOBG LOG" 会被它截胡。
    // 倒出自动透明的应用记录（type|name|接口|hr）。
    // 用法：先 AUTOBG CLEAR + AUTOBG ADD *，开关一次目标弹层，再 LOG。
    // 记录写在 UI 线程回调里（只写内存），这里在管道线程读 —— 有撕裂可能，
    // 但只用于定位，不影响功能。
    if (strcmp(cmd, "AUTOBG LOG") == 0) {
        const LONG total = g_autoBgLogN;
        LONG start = total > AIL_AUTOBG_LOG_MAX ? total - AIL_AUTOBG_LOG_MAX : 0;
        char b[128];
        snprintf(b, sizeof(b), "AUTOBGLOG total=%ld shown=%ld",
                 (long)total, (long)(total - start));
        WriteLine(pipe, b);
        for (LONG i = start; i < total; i++) {
            const LONG k = i % AIL_AUTOBG_LOG_MAX;
            WriteLine(pipe, g_autoBgLog[k][0] ? g_autoBgLog[k] : "(torn)");
        }
        WriteLine(pipe, "END autobglog");
        return 0;
    }

    // BGRESTORE —— 把改过的元素还原成系统原生背景（用户切"默认"时用）。
    //   ★ 走 SubmitOp **封送到 UI 线程立即执行**，不是"置标志等回调"：
    //     原画刷是保存它那个线程的 STA 对象，同线程才放得回去；
    //     而面板元素复用、第二次打开几乎不产生回调 → 老实现永远等不到时机，
    //     结果就是"切默认之后面板还是透明的"（用户报的就是这个）。
    if (strcmp(cmd, "BGRESTORE") == 0) {
        InterlockedExchange(&g_autoBgEnabled, 0);      // 先停掉自动改写，避免还原完又被改回去
        int enq = 0;
        LONG seq = SubmitOp(OP_BGRESTORE, 0, &enq);
        if (enq) WaitDone(seq, 8000);
        WriteLine(pipe, g_dumpBuf[0] ? g_dumpBuf : "BGRESTORE n=0 ok=0 (未入队)");
        WriteLine(pipe, "END");
        return 0;
    }

    // AUTOBG [ADD <name> | CLEAR] —— 自动透明：面板每次重建时，在视觉树回调里
    //   把指定名字的元素 Background 换成透明画刷。不带参数 = 只看状态。
    //   这是 AppContainer 宿主里唯一可靠的改法（详见 AutoApplyBgIfWanted 注释）。
    if (strncmp(cmd, "AUTOBG", 6) == 0) {
        const char* a = cmd + 6;
        while (*a == ' ') a++;
        if (strncmp(a, "CLEAR", 5) == 0) {
            InterlockedExchange(&g_autoBgCount, 0);
            InterlockedExchange(&g_autoBgEnabled, 0);
            // 诊断计时同步清零 → 之后的状态行反映的是"本启用周期"的宿主端成本
            InterlockedExchange64(&g_bgCostUs, 0);
            InterlockedExchange64(&g_bgMaxUs, 0);
            InterlockedExchange(&g_bgCalls, 0);
        } else if (strncmp(a, "RESET", 5) == 0) {
            // 恢复**编译时按宿主定好的默认名单**并重新启用。幂等 ——
            // 客户端"应用透明效果"就发这个（不需要往 cmd 里塞元素名）。
            InterlockedExchange(&g_autoBgCount, 0);
            InterlockedExchange(&g_autoBgEnabled, 0);
            AutoBgInitDefaults();
        } else if (strncmp(a, "ADD", 3) == 0) {
            const char* n = a + 3;
            while (*n == ' ') n++;
            if (n[0]) {
                LONG slot = InterlockedIncrement(&g_autoBgCount) - 1;
                if (slot < 0) slot = 0;
                if (slot < AIL_AUTOBG_MAX) {
                    snprintf(g_autoBgNames[slot], sizeof(g_autoBgNames[slot]), "%s", n);
                    InterlockedExchange(&g_autoBgEnabled, 1);
                } else {
                    InterlockedExchange(&g_autoBgCount, AIL_AUTOBG_MAX);
                }
            }
        }
        char nm[600] = {0};
        int pos = 0;
        const LONG cnt = g_autoBgCount;
        for (LONG i = 0; i < cnt && i < AIL_AUTOBG_MAX; i++)
            pos += snprintf(nm + pos, sizeof(nm) - pos, "%s%s", i ? "," : "", g_autoBgNames[i]);
        char b[1024];
        snprintf(b, sizeof(b),
                 "AUTOBG enabled=%ld count=%ld applied=%ld lastHr=0x%08lx catchup=%ld/%ld restored=%ld saved=%ld bgCalls=%ld bgCostMs=%ld bgMaxMs=%ld names=[%s]",
                 (long)g_autoBgEnabled, (long)cnt, (long)g_autoBgApplied,
                 (unsigned long)g_autoBgLastHr,
                 (long)g_bgCatchupOk, (long)g_bgCatchupTries,
                 (long)g_bgRestoreOk, (long)g_bgSaveN,
                 (long)g_bgCalls, (long)(g_bgCostUs / 1000), (long)(g_bgMaxUs / 1000), nm);
        WriteLine(pipe, b);
        WriteLine(pipe, "END autobg");
        return 0;
    }

    if (strcmp(cmd, "BGSCAN") == 0) {
        int enq = 0;
        LONG seq = SubmitOp(OP_BGSCAN, 0, &enq);
        if (enq) WaitDone(seq, 8000);
        WriteLine(pipe, g_dumpBuf[0] ? g_dumpBuf : "P|||no result");
        WriteLine(pipe, "END bgscan");
        return 0;
    }

    // （AUTOBG LOG 已挪到上面通用 AUTOBG 分支之前 —— 否则会被前缀匹配截胡）

    if (strncmp(cmd, "FULL_TRANSPARENT", 16) == 0) {
        long arg = 0;
        if (cmd[16] == 0x20 ) arg = atol(cmd + 17);
        int enq = 0;
        LONG seq = SubmitOp(OP_FULL_TRANSPARENT, arg, &enq);
        if (enq) WaitDone(seq, 8000);
        WriteLine(pipe, g_dumpBuf[0] ? g_dumpBuf : "P|||no result");
        WriteLine(pipe, "END full_transparent");
        return 0;
    }

    if (strcmp(cmd, "LOG:off") == 0) { InterlockedExchange(&g_logEnabled, 0); WriteLine(pipe, "OK"); return 0; }

    // 关掉"初始树转储期间自动抓 DispatcherQueue"。留个开关的意义�）
    // 万一�?UI 线程上抓 DispatcherQueue 出了意外，可以关掉它验证是不是它引起的
    if (strcmp(cmd, "AUTOQI:0") == 0) { InterlockedExchange(&g_autoQicap, 0); WriteLine(pipe, "OK"); return 0; }
    if (strcmp(cmd, "AUTOQI:1") == 0) { InterlockedExchange(&g_autoQicap, 1); WriteLine(pipe, "OK"); return 0; }

    if (strcmp(cmd, "UNINSTALL") == 0) {
        DoUninstall();
        WriteLine(pipe, "OK");
        return 0;
    }

    // 重新附着：模块若�?XAML 也持有引用而无法真正卸下，用这个命令重新走一�?attach�）
    // 不必重新注入（DllMain 不会二次触发）。这�?M1→M2 的反复实验才顺畅
    if (strcmp(cmd, "REATTACH") == 0) {
        DoUninstall();
        InterlockedExchange(&g_attachState, 0);
        InterlockedExchange(&g_attachAttempts, 0);
        InterlockedExchange(&g_attachHr, 0);
        InterlockedExchange(&g_qiHr, 0);
        HANDLE h = CreateThread(NULL, 0, AttachThreadProc, NULL, 0, NULL);
        if (h) CloseHandle(h);
        WriteLine(pipe, "OK");
        return 0;
    }

    if (strcmp(cmd, "UNLOAD") == 0) {
        DoUninstall();
        WriteLine(pipe, "BYE");
        Sleep(200);                                   // 让客户端先读�?BYE
        InterlockedExchange(&g_wantUnload, 1);
        return 1;
    }

    // ---- M2：XAML 外观操作 ----
    //   PROBE / QI / RESTORE / FILL [<AARRGGBB>]，可�?`:now` 后缀�?当前线程直接执行"实验�）    //   RESULT 只回读最近一次操作的结果，不触发新操作（用于"命令已排队、等 UI 线程补做"的场景）
    if (strcmp(cmd, "RESULT") == 0) {
        WriteResult(pipe, "cache", 0, g_pendingOp == OP_NONE ? 1 : 0);
        return 0;
    }
    if (strncmp(cmd, "PROBE", 5) == 0 || strncmp(cmd, "FILL", 4) == 0 ||
        strncmp(cmd, "RESTORE", 7) == 0 || strncmp(cmd, "QI", 2) == 0 ||
        strncmp(cmd, "ACRYLIC", 7) == 0 || strncmp(cmd, "SET_ACRYLIC_OPACITY", 19) == 0 ||
        strncmp(cmd, "DIRECT_ACRYLIC", 15) == 0 ||
        strncmp(cmd, "ENUM", 4) == 0) {
        return HandleXamlCmd(cmd, pipe);
    }

    WriteLine(pipe, "ERR unknown");
    return 0;
}

// PopupMarker —— 最朴素的"我到这儿了"痕迹。
// 用 CreateFileW 往 DLL 自己目录写一个固定文件（这条路径在 AppContainer 里实测可写），
// 不依赖日志系统、不依赖 CRT，专门用来区分"线程没跑"和"日志写不出去"。
static void PopupMarker(const char* text) {
    wchar_t dir[MAX_PATH] = {0};
    HMODULE hm = NULL;
    if (GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                           GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                           (LPCWSTR)&PopupMarker, &hm) && hm)
        GetModuleFileNameW(hm, dir, MAX_PATH);
    wchar_t* sp = wcsrchr(dir, L'\\');
    if (sp) *(sp + 1) = 0;
    wchar_t path[MAX_PATH] = {0};
    wsprintfW(path, L"%sail_popup_marker.txt", dir);
    HANDLE h = CreateFileW(path, GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                           NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) return;
    DWORD w = 0;
    WriteFile(h, text, (DWORD)strlen(text), &w, NULL);
    CloseHandle(h);
}

// ============================================================
// FileModeLoop —— AppContainer 宿主的"无管道"命令通道
//   2026-09-13 实测：ShellExperienceHost 是 AppContainer 进程，
//   CreateNamedPipe 一律失败 err=5 (ERROR_ACCESS_DENIED)，它根本建不了命名管道。
//   但文件读写是通的（实测：能往 DLL 自己所在目录写文件）。
//   于是用两个文件代替管道：客户端写 cmd 文件，模块把响应写进 resp 文件。
//   WriteLine 用的是 WriteFile，文件句柄照样能用 → 所有命令实现一行都不用改。
// ============================================================
static void FileModeLoop() {
    wchar_t dir[MAX_PATH] = {0};
    HMODULE hm2 = NULL;
    if (GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                           GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                           (LPCWSTR)&FileModeLoop, &hm2) && hm2)
        GetModuleFileNameW(hm2, dir, MAX_PATH);
    wchar_t* sp = wcsrchr(dir, L'\\');
    if (sp) *(sp + 1) = 0;

    PopupMarker("FileModeLoop entered");
    wchar_t cmdPath[MAX_PATH] = {0}, respPath[MAX_PATH] = {0};
    wsprintfW(cmdPath, L"%sail_popup_cmd.txt", dir);
    wsprintfW(respPath, L"%sail_popup_resp.txt", dir);
    Log("FileMode enter dir=%ls", dir);

    // ⚠️ 只比文件大小是**错的**（实测踩过）：客户端用 Python 文本模式写文件，'\n'
    //    会被翻译成 '\r\n'，于是 "PING\n# 1.<13位>\n" 和 "ENUM\n# 2.<13位>\n" 的
    //    字节数完全一样（都是 25）。上一次遗留的 cmd 文件如果也是 25 字节，
    //    新命令就被当成"没变"直接跳过 —— 表现为「marker 写了但命令永远不回」。
    //    所以判据必须是：大小 或 修改时间 或 内容，三者任一变化即视为新命令。
    //    内容一定变，因为客户端每次都会追加一个 ms 时间戳。
    DWORD lastSize = 0xFFFFFFFF;
    FILETIME lastWrite = {0, 0};
    char lastCmd[512] = {0};

    for (;;) {
        HANDLE hc = CreateFileW(cmdPath, GENERIC_READ,
                                FILE_SHARE_READ | FILE_SHARE_WRITE, NULL,
                                OPEN_EXISTING, 0, NULL);
        if (hc != INVALID_HANDLE_VALUE) {
            DWORD sz = GetFileSize(hc, NULL);
            FILETIME ft = {0, 0};
            const BOOL gotFt = GetFileTime(hc, NULL, NULL, &ft);

            int changed = (sz != lastSize);
            if (gotFt && (ft.dwHighDateTime != lastWrite.dwHighDateTime ||
                          ft.dwLowDateTime != lastWrite.dwLowDateTime)) changed = 1;

            char buf[512] = {0};
            DWORD rd = 0;
            if (sz > 0 && sz < sizeof(buf) - 1) ReadFile(hc, buf, sz, &rd, NULL);
            buf[rd] = 0;
            if (strcmp(buf, lastCmd) != 0) changed = 1;

            if (changed) {
                lastSize = sz;
                if (gotFt) lastWrite = ft;
                snprintf(lastCmd, sizeof(lastCmd), "%s", buf);

                for (int i = 0; buf[i]; i++)
                    if (buf[i] == '\r' || buf[i] == '\n') { buf[i] = 0; break; }
                if (buf[0]) {
                    Log("FileMode cmd=%s", buf);
                    HANDLE hr = CreateFileW(respPath, GENERIC_WRITE,
                                            FILE_SHARE_READ | FILE_SHARE_WRITE, NULL,
                                            CREATE_ALWAYS, 0, NULL);
                    if (hr != INVALID_HANDLE_VALUE) {
                        HandleCommand(buf, hr);
                        FlushFileBuffers(hr);
                        CloseHandle(hr);
                    }
                }
            }
            CloseHandle(hc);
        }
        Sleep(250);
    }
}

// DispatcherQueue 静态工厂的获取单独放一条线程。
// 2026-09-13 实测：宿主是 ShellExperienceHost（AppContainer）时，这一步可能长时间
// 不返回；它原先直接摆在 PipeThreadProc 开头，会堵死管道与附着线程的启动 ——
// 表现就是"DLL 明明加载进来了，但既没有管道也没有日志"，极难查。
// 它只是"提前取好静态工厂"的优化，慢/失败都不影响主流程，所以必须异步且不等待。
static DWORD WINAPI QStaticsThreadProc(LPVOID) {
    Log("QStatics thread enter");
    EnsureQStatics(1);
    Log("QStatics thread done");
    return 0;
}

static DWORD WINAPI PipeThreadProc(LPVOID) {
    PopupMarker("PipeThreadProc entered");
    LogInitPath();
    AutoBgInitDefaults();      // 默认就对通知中心/跳转列表的背景元素生效（可用 AUTOBG CLEAR 关掉）
    snprintf(g_pipeName, sizeof(g_pipeName), PIPE_PREFIX "p%lu_t%llu",
             (unsigned long)GetCurrentProcessId(), (unsigned long long)GetTickCount64());
    Log("管道�? %s", g_pipeName);

    // DispatcherQueue �?静态工�?与本线程无关，先在管道线程（MTA）上取好�）
    // 这样 UI 线程上只剩一个极轻的 GetForCurrentThread，不涉及任何 COM 激�?模块加载
    // 先让管道+AttachThread 起来（功能本体），DispatcherQueue 的预取放到旁一线程，不再挡住这里
    HANDLE hq = CreateThread(NULL, 0, QStaticsThreadProc, NULL, 0, NULL);
    if (hq) CloseHandle(hq);

    // 管道先就绪，这样客户端可以立�?PING（不用等 30s 附着循环
    HANDLE h = CreateThread(NULL, 0, AttachThreadProc, NULL, 0, NULL);
    if (h) { g_hAttachThread = h; CloseHandle(h); }

#ifdef AIL_FORCE_FILEMODE
    // 某些宿主（实测 ShellHost.exe：Medium IL 但 CreateNamedPipe 建不出来，
    // marker 只停在 "PipeThreadProc entered"）不能走管道 → 直接走文件通道。
    // 文件通道以 **DLL 所在目录** 为根，不同宿主各放一个目录即天然隔离。
    // ⚠️ 位置很关键：必须在 AttachThreadProc **启动之后**才进文件通道循环，
    //    否则会连附着线程一起跳过 → STATUS 永远 attempts=0/advised=0（踩过）。
    Log("AIL_FORCE_FILEMODE: skip pipe, use file channel");
    FileModeLoop();
    return 0;
#endif

    // ⚠️ 关键�?*先把下一个实例建好，再去服务当前连接**�）
    // 否则"关掉旧实�?�?建新实例"之间有一个空窗期，客户端此刻枚举 \\.\pipe\ 会一个都没有�）
    // 直接�?没有可用的探针管道（模块可能未注入）"——实测踩过，症状极像 explorer 崩了
    HANDLE pending = INVALID_HANDLE_VALUE;
    while (g_running) {
        if (pending == INVALID_HANDLE_VALUE) {
            if (!CreatePipeSecured(&pending)) {
                static int failCount = 0;
                DWORD perr = GetLastError();
                Log("CreateNamedPipe failed err=%lu (count=%d)", perr, failCount + 1);
                if (++failCount >= 3) {
                    Log("pipe impossible here -> FileMode");
                    FileModeLoop();      // 建不了管道，转文件通道
                }
                Sleep(200);
                continue;
            }
        }
        HANDLE cur = pending;
        pending = INVALID_HANDLE_VALUE;
        CreatePipeSecured(&pending);      // 立刻补一个，保证服务期间名字始终存在（失败也无妨

        BOOL ok = ConnectNamedPipe(cur, NULL) || GetLastError() == ERROR_PIPE_CONNECTED;
        Log("pipe conn ok=%d err=%lu", (int)ok, GetLastError());
        if (ok) {
            char buf[512];
            DWORD read = 0;
            while (g_running && ReadFile(cur, buf, sizeof(buf) - 1, &read, NULL)) {
                if (read == 0) continue;
                buf[read] = '\0';
                Log("pipe recv(%lu): %s", (unsigned long)read, buf);
                while (read > 0 && (buf[read - 1] == '\n' || buf[read - 1] == '\r')) buf[--read] = '\0';
                int rc = HandleCommand(buf, cur);
                Log("pipe cmd rc=%d", rc);
                if (rc != 0) break;
            }
            Log("pipe loop exit (err=%lu)", GetLastError());
            DisconnectNamedPipe(cur);
        }
        CloseHandle(cur);
        if (InterlockedCompareExchange(&g_wantUnload, 0, 0)) break;
    }
    if (pending != INVALID_HANDLE_VALUE) CloseHandle(pending);

    Log("管道线程退出");
    if (InterlockedCompareExchange(&g_wantUnload, 0, 0)) {
        InterlockedExchange(&g_running, FALSE);
        // 注意：XAML 可能也持有本模块的引用（它按路径 LoadLibrary 过）�）
        // 所以这�?FreeLibraryAndExitThread 未必能让模块真正卸下。客户端会枚举模块来确认�?        FreeLibraryAndExitThread(g_hModule, 0);
    }
    return 0;
}

// ============================================================
// DLL 入口
// ============================================================
BOOL APIENTRY DllMain(HMODULE hModule, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        g_hModule = hModule;
        DisableThreadLibraryCalls(hModule);
        InitializeCriticalSection(&g_cs);
        InitializeCriticalSection(&g_logCs);
        InitializeCriticalSection(&g_enumCs);
        InitializeCriticalSection(&g_bgSaveCs);
        g_csReady = 1;
        g_enumCsReady = 1;
        g_bgSaveCsReady = 1;
        g_running = TRUE;
        g_hPipeThread = CreateThread(NULL, 0, PipeThreadProc, NULL, 0, NULL);
        if (!g_hPipeThread) { g_running = FALSE; return FALSE; }
    } else if (reason == DLL_PROCESS_DETACH) {
        g_running = FALSE;
        if (g_hPipeThread) { CloseHandle(g_hPipeThread); g_hPipeThread = NULL; }
    }
    return TRUE;
}

