/**
 * 极简 Windows 注册表读写（koffi + advapi32），只覆盖本功能需要的 DWORD 操作。
 *
 * 为什么不用 `reg.exe`：
 *   1. 起子进程慢、且会带一个控制台窗口一闪而过；
 *   2. 本机安全策略把 reg.exe 拉黑了，子进程路线直接不可用。
 *   直接调 advapi32 既快又稳，也不依赖任何外部程序。
 */

const koffi = require('koffi');

const advapi32 = koffi.load('advapi32.dll');

const RegOpenKeyExW = advapi32.func('RegOpenKeyExW', 'int32',
  ['void*', 'str16', 'uint32', 'uint32', 'void*']);
const RegQueryValueExW = advapi32.func('RegQueryValueExW', 'int32',
  ['void*', 'str16', 'void*', 'void*', 'void*', 'void*']);
const RegSetValueExW = advapi32.func('RegSetValueExW', 'int32',
  ['void*', 'str16', 'uint32', 'uint32', 'void*', 'uint32']);
const RegDeleteValueW = advapi32.func('RegDeleteValueW', 'int32', ['void*', 'str16']);
const RegCloseKey = advapi32.func('RegCloseKey', 'int32', ['void*']);

// 预定义根键（HKEY_* 常量值）
const HKEY = {
  CLASSES_ROOT: 0x80000000,
  CURRENT_USER: 0x80000001,
  LOCAL_MACHINE: 0x80000002,
  USERS: 0x80000003,
};

const KEY_READ = 0x20019;
const KEY_WRITE = 0x20006;
const REG_DWORD = 4;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_SUCCESS = 0;

/**
 * 读取一个 DWORD 值。返回 number；不存在或失败返回 null。
 */
function readDword(root, subKey, name) {
  const phk = Buffer.alloc(8);
  const rc = RegOpenKeyExW(root, subKey, 0, KEY_READ, koffi.address(phk));
  if (rc !== ERROR_SUCCESS) return null;
  const hKey = phk.readBigUInt64LE(0);

  const type = Buffer.alloc(4);
  const data = Buffer.alloc(4);
  const cb = Buffer.alloc(4);
  cb.writeUInt32LE(4, 0);
  const q = RegQueryValueExW(hKey, name, null, koffi.address(type),
    koffi.address(data), koffi.address(cb));
  RegCloseKey(hKey);
  if (q !== ERROR_SUCCESS) return null;
  if (type.readUInt32LE(0) !== REG_DWORD) return null;
  return data.readUInt32LE(0);
}

/**
 * 写入一个 DWORD 值。返回 true/false。
 */
function writeDword(root, subKey, name, value) {
  const phk = Buffer.alloc(8);
  const rc = RegOpenKeyExW(root, subKey, 0, KEY_WRITE, koffi.address(phk));
  if (rc !== ERROR_SUCCESS) return { ok: false, error: `RegOpenKeyEx 失败 rc=${rc}` };
  const hKey = phk.readBigUInt64LE(0);

  const data = Buffer.alloc(4);
  data.writeUInt32LE(value >>> 0, 0);
  const s = RegSetValueExW(hKey, name, 0, REG_DWORD, koffi.address(data), 4);
  RegCloseKey(hKey);
  return s === ERROR_SUCCESS ? { ok: true } : { ok: false, error: `RegSetValueEx 失败 rc=${s}` };
}

/**
 * 删除一个值。值本来就不存在也算成功（幂等，便于做"清理"）。
 */
function deleteValue(root, subKey, name) {
  const phk = Buffer.alloc(8);
  const rc = RegOpenKeyExW(root, subKey, 0, KEY_WRITE, koffi.address(phk));
  if (rc !== ERROR_SUCCESS) return { ok: false, error: `RegOpenKeyEx 失败 rc=${rc}` };
  const hKey = phk.readBigUInt64LE(0);
  const d = RegDeleteValueW(hKey, name);
  RegCloseKey(hKey);
  if (d === ERROR_SUCCESS) return { ok: true, existed: true };
  if (d === ERROR_FILE_NOT_FOUND) return { ok: true, existed: false };
  return { ok: false, error: `RegDeleteValue 失败 rc=${d}` };
}

module.exports = { HKEY, readDword, writeDword, deleteValue };
