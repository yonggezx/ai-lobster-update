// 全局鼠标跟踪（Windows）：使用 koffi 调用 Windows API 定期查询鼠标位置和按键状态
// 即使宠物窗口失去焦点，也能获取屏幕鼠标坐标和按键状态，用于 BongoCat 眼球跟踪和鼠标跟随
const koffi = require('koffi');

let user32 = null;
let GetCursorPos = null;
let GetSystemMetrics = null;
let GetAsyncKeyState = null;

let trackingInterval = null;
let onMouseMove = null;
let lastX = -1, lastY = -1;
let lastLeftDown = false, lastRightDown = false;
const THROTTLE_MS = 50; // 节流：每 50ms 最多查询一次，避免 IPC 过于频繁

// Windows 虚拟键码
const VK_LBUTTON = 0x01;
const VK_RBUTTON = 0x02;

// POINT 结构
const POINT = koffi.struct('POINT', {
  x: 'long',
  y: 'long'
});

function initWinAPI() {
  if (user32) return true;
  try {
    user32 = koffi.load('user32.dll');
    GetCursorPos = user32.func('int __stdcall GetCursorPos(void* lpPoint)');
    GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int nIndex)');
    // GetAsyncKeyState：返回值最高位(0x8000)表示按键是否按下
    GetAsyncKeyState = user32.func('short __stdcall GetAsyncKeyState(int vKey)');
    return true;
  } catch (e) {
    console.error('[GlobalMouse] 初始化 Windows API 失败:', e.message);
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

// 获取屏幕分辨率
function getScreenSize() {
  if (!initWinAPI()) return { width: 1920, height: 1080 };
  try {
    const SM_CXSCREEN = 0;
    const SM_CYSCREEN = 1;
    return {
      width: GetSystemMetrics(SM_CXSCREEN),
      height: GetSystemMetrics(SM_CYSCREEN)
    };
  } catch (e) {
    return { width: 1920, height: 1080 };
  }
}

// 启动全局鼠标跟踪
function startGlobalMouseTracking(callback) {
  if (process.platform !== 'win32') {
    console.warn('[GlobalMouse] 仅支持 Windows 平台');
    return false;
  }
  if (trackingInterval) {
    console.warn('[GlobalMouse] 鼠标跟踪已在运行');
    return false;
  }
  if (!initWinAPI()) return false;

  onMouseMove = callback;
  const pointBuf = Buffer.alloc(koffi.sizeof(POINT));
  const screen = getScreenSize();

  trackingInterval = setInterval(() => {
    try {
      const ok = GetCursorPos(pointBuf);
      if (!ok) return;
      const pt = koffi.decode(pointBuf, POINT);
      // 查询鼠标左右键状态
      const leftDown = isKeyDown(VK_LBUTTON);
      const rightDown = isKeyDown(VK_RBUTTON);
      // 节流：位置变化太小且按键状态无变化则不发送
      const dx = Math.abs(pt.x - lastX);
      const dy = Math.abs(pt.y - lastY);
      const keyChanged = (leftDown !== lastLeftDown) || (rightDown !== lastRightDown);
      if (dx < 2 && dy < 2 && !keyChanged) return;
      lastX = pt.x;
      lastY = pt.y;
      lastLeftDown = leftDown;
      lastRightDown = rightDown;
      if (onMouseMove) {
        onMouseMove({
          x: pt.x,
          y: pt.y,
          leftDown: leftDown,
          rightDown: rightDown,
          screenWidth: screen.width,
          screenHeight: screen.height
        });
      }
    } catch (e) {
      // 静默处理单次查询错误
    }
  }, THROTTLE_MS);

  console.log('[GlobalMouse] 全局鼠标跟踪已启动（含按键状态，节流 ' + THROTTLE_MS + 'ms）');
  return true;
}

// 停止全局鼠标跟踪
function stopGlobalMouseTracking() {
  if (trackingInterval) {
    clearInterval(trackingInterval);
    trackingInterval = null;
    console.log('[GlobalMouse] 全局鼠标跟踪已停止');
  }
  onMouseMove = null;
  lastX = -1;
  lastY = -1;
  lastLeftDown = false;
  lastRightDown = false;
}

module.exports = {
  startGlobalMouseTracking,
  stopGlobalMouseTracking,
  getScreenSize
};
