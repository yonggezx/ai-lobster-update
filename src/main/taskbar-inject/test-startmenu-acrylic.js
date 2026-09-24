// 测试开始菜单透明化 - 使用 SET_ACRYLIC_OPACITY 命令
const path = require('path');
const genericInjector = require('./genericInjector');
const { createPipeClient } = require('./pipeClient');

const DLL_PATH = 'C:\\Temp\\aiLobsterTap.dll';

async function testStartMenuTransparency() {
  console.log('=== 测试开始菜单透明化 ===\n');

  // 1. 查找 StartMenuExperienceHost.exe 进程
  const { execSync } = require('child_process');
  let pid = null;
  try {
    const output = execSync('tasklist /fi "imagename eq StartMenuExperienceHost.exe" /fo csv /nh', { encoding: 'utf8' });
    const match = output.match(/"StartMenuExperienceHost\.exe","(\d+)"/);
    if (match) pid = parseInt(match[1]);
  } catch (e) {
    console.log('StartMenuExperienceHost.exe 未运行，尝试启动...');
  }

  if (!pid) {
    console.log('请先打开开始菜单，然后重新运行此脚本');
    return;
  }
  console.log(`找到 StartMenuExperienceHost.exe, PID=${pid}`);

  // 2. 注入 DLL
  console.log('\n注入 DLL...');
  const injectSuccess = genericInjector.inject(pid, DLL_PATH);
  if (!injectSuccess) {
    console.log('注入失败');
    return;
  }
  console.log('注入成功');

  // 3. 等待 TAP 附着
  console.log('\n等待 TAP 附着 (5秒)...');
  await new Promise(r => setTimeout(r, 5000));

  // 4. 创建管道客户端
  const pipeClient = createPipeClient('AI_Lobster_Tap', pid);
  const pipes = pipeClient.listPipes();
  console.log(`找到 ${pipes.length} 个管道`);
  if (pipes.length === 0) {
    console.log('未找到管道，TAP 可能未附着成功');
    return;
  }

  const pipeName = pipes[0];
  console.log(`使用管道: ${pipeName}`);

  // 5. 发送 PING 测试
  console.log('\n发送 PING...');
  const pong = await pipeClient.send('PING');
  console.log('PING 响应:', pong);

  // 6. 发送 ENUM 枚举视觉树
  console.log('\n发送 ENUM...');
  const enumResult = await pipeClient.send('ENUM');
  console.log('ENUM 响应:');
  console.log(enumResult);

  // 7. 发送 SET_ACRYLIC_OPACITY 设置透明
  console.log('\n发送 SET_ACRYLIC_OPACITY...');
  const opacityResult = await pipeClient.send('SET_ACRYLIC_OPACITY 00000000');
  console.log('SET_ACRYLIC_OPACITY 响应:');
  console.log(opacityResult);

  // 8. 发送 STATUS 查看状态
  console.log('\n发送 STATUS...');
  const status = await pipeClient.send('STATUS');
  console.log('STATUS 响应:', status);

  console.log('\n=== 测试完成 ===');
  console.log('请查看开始菜单是否变透明');
  console.log('按 Ctrl+C 退出（DLL 会保持注入状态）');

  // 保持进程运行
  process.stdin.resume();
}

testStartMenuTransparency().catch(console.error);
