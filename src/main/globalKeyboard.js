// 全局键盘跟踪（Windows）：使用 koffi 调用 Windows API 定期查询按键状态
// 即使宠物窗口失去焦点，也能检测键盘按下/释放事件，用于 BongoCat 打字响应
// ★ 实现方式：轮询 GetAsyncKeyState（和全局鼠标跟踪一致），不使用低级键盘钩子 WH_KEYBOARD_LL。
// 之前用低级钩子需要 Windows 消息循环 + native 线程回调，容易因 V8 HandleScope 问题
// 导致钩子静默失败，全局键盘完全不响应。轮询方式更简单稳定。
const koffi = require('koffi');

let user32 = null;
let GetAsyncKeyState = null;

let trackingInterval = null;
let onKeyEvent = null;
const THROTTLE_MS = 20; // 轮询间隔：20ms（约50fps），平衡响应速度和CPU占用

// 需要监控的虚拟键码列表（常用键）
// 格式：{ vk: 虚拟键码, key: 键名字符, code: KeyboardEvent.code }
const MONITORED_KEYS = [
  // 字母键 A-Z
  { vk: 0x41, key: 'a', code: 'KeyA' },
  { vk: 0x42, key: 'b', code: 'KeyB' },
  { vk: 0x43, key: 'c', code: 'KeyC' },
  { vk: 0x44, key: 'd', code: 'KeyD' },
  { vk: 0x45, key: 'e', code: 'KeyE' },
  { vk: 0x46, key: 'f', code: 'KeyF' },
  { vk: 0x47, key: 'g', code: 'KeyG' },
  { vk: 0x48, key: 'h', code: 'KeyH' },
  { vk: 0x49, key: 'i', code: 'KeyI' },
  { vk: 0x4A, key: 'j', code: 'KeyJ' },
  { vk: 0x4B, key: 'k', code: 'KeyK' },
  { vk: 0x4C, key: 'l', code: 'KeyL' },
  { vk: 0x4D, key: 'm', code: 'KeyM' },
  { vk: 0x4E, key: 'n', code: 'KeyN' },
  { vk: 0x4F, key: 'o', code: 'KeyO' },
  { vk: 0x50, key: 'p', code: 'KeyP' },
  { vk: 0x51, key: 'q', code: 'KeyQ' },
  { vk: 0x52, key: 'r', code: 'KeyR' },
  { vk: 0x53, key: 's', code: 'KeyS' },
  { vk: 0x54, key: 't', code: 'KeyT' },
  { vk: 0x55, key: 'u', code: 'KeyU' },
  { vk: 0x56, key: 'v', code: 'KeyV' },
  { vk: 0x57, key: 'w', code: 'KeyW' },
  { vk: 0x58, key: 'x', code: 'KeyX' },
  { vk: 0x59, key: 'y', code: 'KeyY' },
  { vk: 0x5A, key: 'z', code: 'KeyZ' },
  // 数字键 0-9
  { vk: 0x30, key: '0', code: 'Digit0' },
  { vk: 0x31, key: '1', code: 'Digit1' },
  { vk: 0x32, key: '2', code: 'Digit2' },
  { vk: 0x33, key: '3', code: 'Digit3' },
  { vk: 0x34, key: '4', code: 'Digit4' },
  { vk: 0x35, key: '5', code: 'Digit5' },
  { vk: 0x36, key: '6', code: 'Digit6' },
  { vk: 0x37, key: '7', code: 'Digit7' },
  { vk: 0x38, key: '8', code: 'Digit8' },
  { vk: 0x39, key: '9', code: 'Digit9' },
  // 小键盘数字 0-9
  { vk: 0x60, key: '0', code: 'Numpad0' },
  { vk: 0x61, key: '1', code: 'Numpad1' },
  { vk: 0x62, key: '2', code: 'Numpad2' },
  { vk: 0x63, key: '3', code: 'Numpad3' },
  { vk: 0x64, key: '4', code: 'Numpad4' },
  { vk: 0x65, key: '5', code: 'Numpad5' },
  { vk: 0x66, key: '6', code: 'Numpad6' },
  { vk: 0x67, key: '7', code: 'Numpad7' },
  { vk: 0x68, key: '8', code: 'Numpad8' },
  { vk: 0x69, key: '9', code: 'Numpad9' },
  // 功能键 F1-F12
  { vk: 0x70, key: 'F1', code: 'F1' },
  { vk: 0x71, key: 'F2', code: 'F2' },
  { vk: 0x72, key: 'F3', code: 'F3' },
  { vk: 0x73, key: 'F4', code: 'F4' },
  { vk: 0x74, key: 'F5', code: 'F5' },
  { vk: 0x75, key: 'F6', code: 'F6' },
  { vk: 0x76, key: 'F7', code: 'F7' },
  { vk: 0x77, key: 'F8', code: 'F8' },
  { vk: 0x78, key: 'F9', code: 'F9' },
  { vk: 0x79, key: 'F10', code: 'F10' },
  { vk: 0x7A, key: 'F11', code: 'F11' },
  { vk: 0x7B, key: 'F12', code: 'F12' },
  // 修饰键
  { vk: 0x10, key: 'Shift', code: 'ShiftLeft' },
  { vk: 0x11, key: 'Control', code: 'ControlLeft' },
  { vk: 0x12, key: 'Alt', code: 'AltLeft' },
  // 常用特殊键
  { vk: 0x08, key: 'Backspace', code: 'Backspace' },
  { vk: 0x09, key: 'Tab', code: 'Tab' },
  { vk: 0x0D, key: 'Enter', code: 'Enter' },
  { vk: 0x1B, key: 'Escape', code: 'Escape' },
  { vk: 0x20, key: ' ', code: 'Space' },
  { vk: 0x2E, key: 'Delete', code: 'Delete' },
  // 方向键
  { vk: 0x25, key: 'ArrowLeft', code: 'ArrowLeft' },
  { vk: 0x26, key: 'ArrowUp', code: 'ArrowUp' },
  { vk: 0x27, key: 'ArrowRight', code: 'ArrowRight' },
  { vk: 0x28, key: 'ArrowDown', code: 'ArrowDown' },
];

// 记录每个按键的上一个状态（用于检测状态变化）
let keyStates = new Uint8Array(256); // 0=释放, 1=按下

function initWinAPI() {
  if (user32) return true;
  try {
    user32 = koffi.load('user32.dll');
    // GetAsyncKeyState：返回值最高位(0x8000)表示按键是否按下
    GetAsyncKeyState = user32.func('short __stdcall GetAsyncKeyState(int vKey)');
    return true;
  } catch (e) {
    console.error('[GlobalKeyboard] 初始化 Windows API 失败:', e.message);
    return false;
  }
}

// 查询按键是否按下
function isKeyDown(vkCode) {
  if (!GetAsyncKeyState) return false;
  try {
    const state = GetAsyncKeyState(vkCode);
    return (state & 0x8000) !== 0;
  } catch (e) {
    return false;
  }
}

// 启动全局键盘跟踪
function startGlobalKeyboardHook(callback) {
  if (process.platform !== 'win32') {
    console.warn('[GlobalKeyboard] 仅支持 Windows 平台');
    return false;
  }
  if (trackingInterval) {
    console.warn('[GlobalKeyboard] 键盘跟踪已在运行');
    return false;
  }
  if (!initWinAPI()) return false;

  onKeyEvent = callback;
  // 初始化按键状态
  for (const k of MONITORED_KEYS) {
    keyStates[k.vk] = isKeyDown(k.vk) ? 1 : 0;
  }

  trackingInterval = setInterval(() => {
    try {
      for (const k of MONITORED_KEYS) {
        const down = isKeyDown(k.vk) ? 1 : 0;
        const prev = keyStates[k.vk];
        if (down !== prev) {
          keyStates[k.vk] = down;
          if (onKeyEvent) {
            onKeyEvent({
              key: k.key,
              code: k.code,
              vkCode: k.vk,
              type: down === 1 ? 'down' : 'up'
            });
          }
        }
      }
    } catch (e) {
      // 静默处理单次查询错误
    }
  }, THROTTLE_MS);

  console.log('[GlobalKeyboard] 全局键盘跟踪已启动（轮询方式，监控 ' + MONITORED_KEYS.length + ' 个键，间隔 ' + THROTTLE_MS + 'ms）');
  return true;
}

// 停止全局键盘跟踪
function stopGlobalKeyboardHook() {
  if (trackingInterval) {
    clearInterval(trackingInterval);
    trackingInterval = null;
    console.log('[GlobalKeyboard] 全局键盘跟踪已停止');
  }
  onKeyEvent = null;
  keyStates.fill(0);
}

module.exports = {
  startGlobalKeyboardHook,
  stopGlobalKeyboardHook
};
