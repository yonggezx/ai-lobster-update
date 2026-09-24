const { execSync, exec, spawnSync, spawn } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const os = require('os');
const path = require('path');

// ★ 软件列表缓存：避免重复扫描注册表导致系统卡顿
// 缓存有效期 5 分钟，期间重复调用直接返回缓存结果
let _softwareCache = null;
let _softwareCacheTime = 0;
const SOFTWARE_CACHE_TTL = 5 * 60 * 1000; // 5 分钟

async function listInstalled(forceRefresh = false) {
  try {
    // 检查缓存（非强制刷新时）
    if (!forceRefresh && _softwareCache && (Date.now() - _softwareCacheTime) < SOFTWARE_CACHE_TTL) {
      return _softwareCache;
    }

    const allSoftware = [];
    const seenNames = new Set();

    if (os.platform() === 'win32') {
      // ★ 优化：合并三个注册表路径到一个 PowerShell 命令，减少进程启动次数
      // 原实现依次启动 3 个 PowerShell 进程，每个启动需 1-2 秒，共需 3-6 秒且阻塞主进程
      // 现合并为 1 个命令，异步执行，不阻塞事件循环
      const regPaths = [
        'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
        'HKLM:\\Software\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
        'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
      ];

      // 构建合并的 PowerShell 命令：用数组收集所有路径的结果，最后统一输出 JSON
      const pathsArray = regPaths.map(p => `'${p}'`).join(',');
      const psCommand = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8; $results = @(); foreach ($p in @(${pathsArray})) { try { $results += Get-ItemProperty $p -ErrorAction SilentlyContinue | Select-Object DisplayName, DisplayVersion, InstallLocation, Publisher | Where-Object { $_.DisplayName } } catch {} }; $results | ConvertTo-Json -Compress`;

      try {
        const { stdout } = await execAsync(`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "${psCommand}"`, {
          encoding: 'utf-8',
          timeout: 20000,
          windowsHide: true,
          maxBuffer: 10 * 1024 * 1024 // 10MB 缓冲区，避免软件多时输出被截断
        });
        if (stdout && stdout.trim()) {
          let parsed;
          try {
            parsed = JSON.parse(stdout.trim());
          } catch (e) {
            parsed = null;
          }
          if (parsed) {
            const items = Array.isArray(parsed) ? parsed : [parsed];
            for (const item of items) {
              const name = item.DisplayName ? String(item.DisplayName).trim() : null;
              if (!name || seenNames.has(name.toLowerCase())) continue;
              seenNames.add(name.toLowerCase());
              allSoftware.push({
                name,
                version: item.DisplayVersion ? String(item.DisplayVersion).trim() : null,
                installLocation: item.InstallLocation ? String(item.InstallLocation).trim() : null,
                publisher: item.Publisher ? String(item.Publisher).trim() : null
              });
            }
          }
        }
      } catch (e) {
        // PowerShell 执行失败，静默处理
      }
    } else if (os.platform() === 'darwin') {
      try {
        const { stdout } = await execAsync('ls /Applications', { encoding: 'utf-8', timeout: 10000 });
        const apps = stdout.split('\n').filter(l => l.trim());
        for (const app of apps) {
          const name = app.replace(/\.app$/, '').trim();
          if (name && !seenNames.has(name.toLowerCase())) {
            seenNames.add(name.toLowerCase());
            allSoftware.push({ name, version: null, installLocation: '/Applications', publisher: null });
          }
        }
      } catch (e) {}
    } else {
      // Linux
      const commands = [
        'dpkg-query -W -f="${Package} ${Version}\\n" 2>/dev/null',
        'snap list 2>/dev/null',
        'flatpak list --app --columns=name,version 2>/dev/null'
      ];
      for (const cmd of commands) {
        try {
          const { stdout } = await execAsync(cmd, { encoding: 'utf-8', timeout: 10000 });
          const lines = stdout.split('\n').filter(l => l.trim());
          for (const line of lines) {
            const parts = line.split(/\s+/);
            const name = parts[0];
            const version = parts[1] || null;
            if (name && !seenNames.has(name.toLowerCase())) {
              seenNames.add(name.toLowerCase());
              allSoftware.push({ name, version, installLocation: null, publisher: null });
            }
          }
        } catch (e) {}
      }
    }

    // ★ 过滤系统核心软件和安全相关软件，避免列表过于杂乱
    const filteredSoftware = allSoftware.filter(sw => !shouldHideSoftware(sw.name, sw.publisher));

    const result = {
      success: true,
      data: filteredSoftware.sort((a, b) => a.name.localeCompare(b.name)),
      total: filteredSoftware.length
    };

    // ★ 保存到缓存（5 分钟内重复调用直接返回缓存，避免重复扫描）
    _softwareCache = result;
    _softwareCacheTime = Date.now();

    return result;
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// 判断是否应该隐藏该软件（系统核心组件、运行时库、驱动、安全软件等）
function shouldHideSoftware(name, publisher) {
  if (!name) return true;
  const nameLower = name.toLowerCase();
  const pubLower = (publisher || '').toLowerCase();

  // 安全软件关键词（杀毒、安全卫士、防火墙等）
  const securityKeywords = [
    '火绒', 'huorong', '360安全', '360杀毒', '360安全卫士', 'qihoo',
    '腾讯电脑管家', 'qqpcmgr', 'tencent security',
    '卡巴斯基', 'kaspersky', '诺顿', 'norton', 'symantec',
    'mcafee', '迈克菲', 'avast', 'avg', 'bitdefender', 'eset', 'nod32',
    '瑞星', 'rising', '金山毒霸', '金山卫士', 'duba',
    '2345安全卫士', '2345安全', 'baidu antivirus', '百度杀毒',
    'defender', 'windows defender', 'malwarebytes', 'spybot',
    'zonealarm', 'comodo', 'panda security', '趋势科技', 'trend micro',
    'dr.web', '大蜘蛛', 'f-secure', 'sophos', 'webroot',
    '安全卫士', '杀毒', '安全软件', '防火墙', 'firewall'
  ];

  // 系统核心组件和运行时库关键词
  const systemKeywords = [
    // Windows 系统组件
    'windows ', 'microsoft windows', 'windows update', 'windows installer',
    'windows sdk', 'windows driver kit', 'wdk', 'windows assessment',
    'windows performance', 'windows remote', 'windows powershell',
    // 运行时库和框架
    'microsoft visual c++', 'visual c++ redistributable', 'vc++', 'vc redist',
    '.net framework', '.net runtime', '.net core', 'dotnet', 'asp.net',
    'microsoft .net', 'silverlight', 'xna framework', 'xamarin',
    'directx', 'openal', 'opengl', 'vulkan runtime',
    'microsoft visual studio tools', 'visual studio 20', 'build tools',
    'microsoft sql server', 'sql server compact', 'sql server native',
    'microsoft access database', 'microsoft excel', 'microsoft word',
    'microsoft powerpoint', 'microsoft outlook', 'microsoft office',
    'microsoft edge', 'microsoft edgeupdate', 'edge update',
    // 驱动程序
    'intel(r)', 'intel®', 'intel graphics', 'intel chipset', 'intel management engine',
    'intel serial io', 'intel me', 'intel(r) me', 'intel processor',
    'nvidia', 'geforce', 'quadro', 'nview', 'nvcontainer',
    'amd ', 'radeon', 'ati ', 'amd catalyst', 'amd chipset',
    'realtek', 'broadcom', 'qualcomm', 'mediatek', 'marvell',
    'synaptics', 'elan', 'alps', 'goodix', 'wacom',
    'creative', 'sound blaster', 'asmedia', 'ricoh', 'genesys',
    // 系统更新和补丁
    'kb\\d{6,}', 'security update', 'cumulative update', 'feature update',
    'update for ', 'hotfix', 'service pack',
    // 其他系统组件
    'microsoft help', 'microsoft viewer', 'microsoft translator',
    'microsoft sync', 'microsoft feed', 'microsoft web',
    'application verifier', 'debugging tools', 'process explorer',
    'microsoft application', 'microsoft baseline', 'microsoft deployment',
    'microsoft expression', 'microsoft math', 'microsoft reader',
    'microsoft student', 'microsoft encarta', 'microsoft money',
    'microsoft works', 'microsoft picture', 'microsoft photo',
    'microsoft lifecam', 'microsoft keyboard', 'microsoft mouse',
    'microsoft sidewinder', 'microsoft intellipoint', 'microsoft intellitype',
    'microsoft activesync', 'microsoft device', 'microsoft runtime',
    'microsoft xps', 'microsoft print', 'microsoft scanner',
    'microsoft camera', 'microsoft codec', 'microsoft media',
    'microsoft silverlight', 'microsoft games for windows',
    'microsoft visual f#', 'microsoft visual j#', 'microsoft visual basic',
    'microsoft office click-to-run', 'office 16 click-to-run',
    'microsoft 365', 'office 365', 'microsoft 365 apps'
  ];

  // 检查安全软件
  for (const kw of securityKeywords) {
    if (nameLower.includes(kw.toLowerCase()) || pubLower.includes(kw.toLowerCase())) {
      return true;
    }
  }

  // 检查系统核心组件
  for (const kw of systemKeywords) {
    if (nameLower.includes(kw.toLowerCase())) {
      return true;
    }
  }

  // 检查发布者是否为 Microsoft 且名称包含系统组件关键词
  if (pubLower.includes('microsoft') || pubLower.includes('intel corporation') || pubLower.includes('nvidia')) {
    // 微软的一些非系统软件（如 VS Code、Teams、OneDrive 等）不应该隐藏
    const allowedMicrosoft = [
      'visual studio code', 'vs code', 'vscode',
      'microsoft teams', 'teams',
      'microsoft onedrive', 'onedrive',
      'microsoft skype', 'skype',
      'microsoft todo', 'to do',
      'microsoft sticky notes', 'sticky notes',
      'microsoft whiteboard', 'whiteboard',
      'microsoft projector', 'projector',
      'microsoft remote desktop', 'remote desktop',
      'microsoft azure', 'azure',
      'microsoft bing', 'bing',
      'microsoft garage', 'garage'
    ];
    for (const allowed of allowedMicrosoft) {
      if (nameLower.includes(allowed)) {
        return false;
      }
    }
    // 微软/Intel/NVIDIA 发布的其他软件，如果名称较短或包含驱动/运行时关键词，隐藏
    if (nameLower.length < 15) return true;
  }

  return false;
}

async function install({ sourcePath, silent = true }) {
  try {
    if (!sourcePath) {
      return { success: false, error: '安装包路径不能为空' };
    }

    const ext = path.extname(sourcePath).toLowerCase();
    let command;
    let result;

    switch (os.platform()) {
      case 'win32':
        if (ext === '.msi') {
          command = silent
            ? `msiexec /i "${sourcePath}" /quiet /norestart`
            : `msiexec /i "${sourcePath}"`;
        } else if (ext === '.exe') {
          command = silent
            ? `"${sourcePath}" /S /D=${os.homedir()}\\Installed`
            : `"${sourcePath}"`;
        } else if (ext === '.zip' || ext === '.rar') {
          const { execSync: admZipSync } = require('child_process');
          const destDir = path.join(os.homedir(), 'Installed', path.basename(sourcePath, ext));
          command = `powershell -Command "Expand-Archive -Path '${sourcePath}' -DestinationPath '${destDir}' -Force"`;
        } else {
          return { success: false, error: `不支持的安装包格式: ${ext}` };
        }
        break;

      case 'darwin':
        if (ext === '.dmg') {
          command = `hdiutil attach "${sourcePath}" -nobrowse -readonly`;
        } else if (ext === '.pkg') {
          command = silent ? `sudo installer -pkg "${sourcePath}" -target /` : `open "${sourcePath}"`;
        } else if (ext === '.zip' || ext === '.tar.gz') {
          const destDir = path.join(os.homedir(), 'Installed');
          command = `ditto -x -k "${sourcePath}" "${destDir}"`;
        } else {
          return { success: false, error: `不支持的安装包格式: ${ext}` };
        }
        break;

      default:
        if (ext === '.deb') {
          command = `sudo dpkg -i "${sourcePath}"`;
        } else if (ext === '.rpm') {
          command = `sudo rpm -i "${sourcePath}"`;
        } else if (ext === '.AppImage') {
          command = `chmod +x "${sourcePath}" && "${sourcePath}"`;
        } else {
          return { success: false, error: `不支持的安装包格式: ${ext}` };
        }
    }

    try {
      result = execSync(command, { encoding: 'utf-8', timeout: 300000 });
      return { success: true, output: result, source: sourcePath };
    } catch (execError) {
      return {
        success: false,
        error: execError.stderr || execError.message,
        source: sourcePath,
        command
      };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * 解析 Windows 命令行字符串，提取可执行文件路径和参数列表。
 * 处理带引号的路径（如 "C:\Program Files\app.exe" /arg）和不带引号的路径。
 * @param {string} cmdLine - Windows UninstallString 格式的命令行
 * @returns {{file: string, args: string[]}}
 */
function parseWindowsCommandLine(cmdLine) {
  const args = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < cmdLine.length; i++) {
    const ch = cmdLine[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ' ' && !inQuotes) {
      if (current) {
        args.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current) args.push(current);
  return { file: args[0] || '', args: args.slice(1) };
}

async function uninstall({ name, silent = true }) {
  try {
    if (!name) {
      return { success: false, error: '软件名称不能为空' };
    }

    if (os.platform() === 'win32') {
      // ★ 从注册表读取 UninstallString，直接调用卸载程序
      //   避免使用 Win32_Product（会触发所有 MSI 重新配置，导致卡死几分钟）
      //   直接调用 UninstallString 会弹出软件自带的卸载界面
      const psName = name.replace(/'/g, "''");
      const regPaths = [
        'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
        'HKLM:\\Software\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
        'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
      ];
      const pathsArray = regPaths.map(p => `'${p}'`).join(',');
      const psCommand = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8; $found = $null; foreach ($p in @(${pathsArray})) { try { $items = Get-ItemProperty $p -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq '${psName}' }; if ($items) { $found = $items; break } } catch {} }; if ($found) { $u = $found.UninstallString; $q = $found.QuietUninstallString; Write-Output (@{ UninstallString = $u; QuietUninstallString = $q } | ConvertTo-Json -Compress) } else { Write-Output 'NOT_FOUND' }`;

      try {
        const result = spawnSync('powershell', [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psCommand
        ], { encoding: 'utf8', timeout: 15000, windowsHide: true });
        const output = (result.stdout || '').trim();

        if (output === 'NOT_FOUND' || !output) {
          return { success: false, error: '未找到该软件的卸载信息', name };
        }

        let info;
        try {
          info = JSON.parse(output);
        } catch (e) {
          return { success: false, error: '解析卸载信息失败', name, output };
        }

        // 选择卸载命令：静默优先用 QuietUninstallString，否则用 UninstallString（弹出卸载界面）
        let uninstallCmd = (silent && info.QuietUninstallString) ? info.QuietUninstallString : info.UninstallString;
        if (!uninstallCmd) {
          return { success: false, error: '该软件没有提供卸载程序', name };
        }

        // ★ 用 cmd /c start "" 启动卸载程序，不等待：
        //   Windows 卸载程序架构复杂（有的是启动器、有的提权后子进程），
        //   任何等待方式都无法100%准确获取退出码，反而会误报"卸载完成"。
        //   因此直接启动后返回"已启动"，由用户在卸载窗口中操作，前端显示真实提示。
        //   start 命令启动后立即返回，cmd 窗口闪一下就关闭。
        try {
          spawn('cmd', ['/c', 'start', '', uninstallCmd], { stdio: 'ignore', windowsHide: true, detached: true });
          return { success: true, message: '已启动卸载程序，请在弹出的窗口中完成卸载', name };
        } catch (spawnError) {
          return { success: false, error: '启动卸载程序失败: ' + spawnError.message, name };
        }
      } catch (execError) {
        return { success: false, error: execError.message, name };
      }
    }

    let command;
    if (os.platform() === 'darwin') {
      command = `rm -rf "/Applications/${name}.app" ~/Library/Application\\ Support/${name}`;
    } else {
      command = `sudo apt-get remove -y "${name}" 2>/dev/null || sudo snap remove "${name}" 2>/dev/null || echo "not_found"`;
    }

    try {
      const result = execSync(command, { encoding: 'utf-8', timeout: 120000 });
      return { success: true, output: result, name };
    } catch (execError) {
      return {
        success: false,
        error: execError.stderr || execError.message,
        name,
        command
      };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function getInstallInfo(name) {
  try {
    const all = await listInstalled();
    if (!all.success) return all;

    const found = all.data.find(s => s.name.toLowerCase().includes(name.toLowerCase()));
    if (found) {
      return { success: true, data: found };
    }
    return { success: false, error: `未找到软件: ${name}` };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

module.exports = { listInstalled, install, uninstall, getInstallInfo };