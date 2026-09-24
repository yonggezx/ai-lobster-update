const genericInjector = require('./genericInjector');
const { createPipeClient } = require('./pipeClient');
const { execSync } = require('child_process');

async function test() {
  const output = execSync('tasklist /fi "imagename eq StartMenuExperienceHost.exe" /fo csv /nh', { encoding: 'utf8' });
  const match = output.match(/"StartMenuExperienceHost\.exe","(\d+)"/);
  if (!match) { console.log('请先打开开始菜单'); return; }
  const pid = parseInt(match[1]);
  console.log('PID:', pid);
  
  genericInjector.inject(pid, 'C:\\Temp\\aiLobsterTap.dll');
  await new Promise(r => setTimeout(r, 4000));
  
  const pipeClient = createPipeClient('AI_Lobster_Tap', pid);
  const pipes = pipeClient.listPipes();
  console.log('Pipes:', pipes.length);
  
  if (pipes.length) {
    console.log('PING:', await pipeClient.send('PING'));
    console.log('\n--- ENUM (枚举元素) ---');
    const enumResult = await pipeClient.send('ENUM');
    console.log(enumResult.substring(0, 200) + '...');
    
    console.log('\n--- DIRECT_ACRYLIC 00FFFFFF (alpha=0 完全透明) ---');
    console.log(await pipeClient.send('DIRECT_ACRYLIC 00FFFFFF'));
  }
}
test().catch(console.error);
