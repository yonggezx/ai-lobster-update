const { exec, execSync, spawn } = require('child_process');
const path = require('path');
const os = require('os');

const activeTerminals = new Map();

function getShell() {
  switch (os.platform()) {
    case 'win32': return { shell: 'powershell.exe', type: 'powershell' };
    case 'darwin': return { shell: '/bin/zsh', type: 'zsh' };
    default: return { shell: '/bin/bash', type: 'bash' };
  }
}

async function execute({ command, workingDir, timeout = 30000, shell: shellName }) {
  return new Promise((resolve) => {
    const shell = shellName || getShell().shell;
    const cwd = workingDir || os.homedir();
    const env = { ...process.env };

    const child = spawn(shell, ['-c', command], {
      cwd,
      env,
      timeout,
      maxBuffer: 1024 * 1024 * 10
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGTERM'); } catch (e) {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} }, 2000);
    }, timeout);

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        success: !killed && code === 0,
        exitCode: code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        timedOut: killed,
        command,
        workingDir: cwd,
        shell
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        success: false,
        error: err.message,
        command,
        workingDir: cwd
      });
    });
  });
}

async function listTerminals() {
  const list = [];
  for (const [id, info] of activeTerminals) {
    list.push({ id, ...info });
  }
  return { success: true, data: list };
}

async function kill(pid) {
  try {
    if (os.platform() === 'win32') {
      execSync(`taskkill /F /PID ${pid}`, { timeout: 5000 });
    } else {
      process.kill(pid, 'SIGKILL');
    }
    return { success: true, pid };
  } catch (error) {
    return { success: false, error: error.message, pid };
  }
}

module.exports = { execute, listTerminals, kill, getShell };