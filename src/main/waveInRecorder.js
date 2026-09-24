// Windows MCI 音频录制器（主进程使用，完全避免渲染进程崩溃）
// 使用 mciSendString API 录制麦克风音频，输出 WAV 格式文件
// 简单稳定，不需要回调函数，不会导致崩溃
// 录制完成后自动转换为16kHz/16bit/单声道格式，提高SAPI识别率

const koffi = require('koffi');
const fs = require('fs');
const path = require('path');
const os = require('os');

// 加载 winmm.dll
let winmm = null;
let mciSendString = null;
try {
  winmm = koffi.load('winmm.dll');
  // 定义 mciSendString 函数
  mciSendString = winmm.func('uint32_t mciSendStringA(const char *lpszCommand, char *lpszReturnString, uint32_t cchReturn, void *hwndCallback)');
  console.log('[MCIRecorder] winmm.dll 加载成功，mciSendString 可用');
} catch (e) {
  console.error('[MCIRecorder] winmm.dll 加载失败:', e.message);
}

// 执行 MCI 命令
function mciExec(command) {
  if (!mciSendString) {
    throw new Error('mciSendString 不可用');
  }
  const retBuf = Buffer.alloc(256);
  const ret = mciSendString(command, retBuf, 256, null);
  const retStr = retBuf.toString().trim();
  if (ret !== 0) {
    console.warn(`[MCIRecorder] 命令失败 (${ret}): ${command} -> ${retStr}`);
  }
  return { code: ret, text: retStr };
}

// 将8bit/11025Hz WAV转换为16bit/16000Hz WAV
function convertWavTo16k16bit(inputBuffer) {
  try {
    // 解析输入WAV头
    const inputSampleRate = inputBuffer.readUInt32LE(24);
    const inputBitsPerSample = inputBuffer.readUInt16LE(34);
    const inputChannels = inputBuffer.readUInt16LE(22);
    
    console.log(`[MCIRecorder] 原始格式: ${inputSampleRate}Hz/${inputBitsPerSample}bit/${inputChannels}声道`);
    
    // 找到data子块
    let dataOffset = -1;
    let dataSize = 0;
    let offset = 12; // 跳过RIFF头
    while (offset < inputBuffer.length - 8) {
      const chunkId = inputBuffer.toString('ascii', offset, offset + 4);
      const chunkSize = inputBuffer.readUInt32LE(offset + 4);
      if (chunkId === 'data') {
        dataOffset = offset + 8;
        dataSize = chunkSize;
        break;
      }
      offset += 8 + chunkSize;
    }
    
    if (dataOffset < 0 || dataSize === 0) {
      console.log('[MCIRecorder] 未找到data子块，使用原始数据');
      return inputBuffer;
    }
    
    // 读取PCM数据
    const pcmData = inputBuffer.slice(dataOffset, dataOffset + dataSize);
    
    // 转换为16bit样本
    let samples16bit = [];
    if (inputBitsPerSample === 8) {
      // 8bit unsigned -> 16bit signed
      for (let i = 0; i < pcmData.length; i++) {
        const sample8 = pcmData.readUInt8(i);
        const sample16 = ((sample8 - 128) * 256);
        samples16bit.push(sample16);
      }
    } else if (inputBitsPerSample === 16) {
      // 已经是16bit
      for (let i = 0; i < pcmData.length; i += 2) {
        samples16bit.push(pcmData.readInt16LE(i));
      }
    } else {
      console.log('[MCIRecorder] 不支持的位深，使用原始数据');
      return inputBuffer;
    }
    
    // 处理多声道（只取左声道）
    if (inputChannels > 1) {
      const monoSamples = [];
      for (let i = 0; i < samples16bit.length; i += inputChannels) {
        monoSamples.push(samples16bit[i]);
      }
      samples16bit = monoSamples;
    }
    
    // 重采样到16000Hz（简单线性插值）
    const targetSampleRate = 16000;
    const resampled = [];
    if (inputSampleRate !== targetSampleRate) {
      const ratio = inputSampleRate / targetSampleRate;
      const targetLength = Math.floor(samples16bit.length / ratio);
      for (let i = 0; i < targetLength; i++) {
        const srcIndex = i * ratio;
        const index0 = Math.floor(srcIndex);
        const index1 = Math.min(index0 + 1, samples16bit.length - 1);
        const frac = srcIndex - index0;
        const sample = Math.round(samples16bit[index0] * (1 - frac) + samples16bit[index1] * frac);
        resampled.push(Math.max(-32768, Math.min(32767, sample)));
      }
    } else {
      resampled.push(...samples16bit);
    }
    
    // 构建16bit/16000Hz WAV文件
    const dataSize16 = resampled.length * 2;
    const outputBuffer = Buffer.alloc(44 + dataSize16);
    
    // RIFF头
    outputBuffer.write('RIFF', 0);
    outputBuffer.writeUInt32LE(36 + dataSize16, 4);
    outputBuffer.write('WAVE', 8);
    
    // fmt子块
    outputBuffer.write('fmt ', 12);
    outputBuffer.writeUInt32LE(16, 16);
    outputBuffer.writeUInt16LE(1, 20); // PCM
    outputBuffer.writeUInt16LE(1, 22); // 单声道
    outputBuffer.writeUInt32LE(targetSampleRate, 24);
    outputBuffer.writeUInt32LE(targetSampleRate * 2, 28); // ByteRate
    outputBuffer.writeUInt16LE(2, 32); // BlockAlign
    outputBuffer.writeUInt16LE(16, 34); // BitsPerSample
    
    // data子块
    outputBuffer.write('data', 36);
    outputBuffer.writeUInt32LE(dataSize16, 40);
    
    // 写入PCM数据
    for (let i = 0; i < resampled.length; i++) {
      outputBuffer.writeInt16LE(resampled[i], 44 + i * 2);
    }
    
    console.log(`[MCIRecorder] 转换完成: ${targetSampleRate}Hz/16bit/单声道，大小: ${outputBuffer.length} bytes`);
    return outputBuffer;
  } catch (e) {
    console.error('[MCIRecorder] 格式转换失败:', e.message);
    return inputBuffer; // 转换失败时返回原始数据
  }
}

class MCIRecorder {
  constructor(options = {}) {
    this.sampleRate = options.sampleRate || 16000;
    this.channels = options.channels || 1;
    this.bitsPerSample = options.bitsPerSample || 16;
    this.alias = 'lobster_rec_' + Date.now();
    this.isRecording = false;
    this.tempWavPath = null;
  }
  
  // 检查是否可用
  static isAvailable() {
    if (!mciSendString) return false;
    try {
      // 尝试打开一个测试设备
      const testAlias = 'test_' + Date.now();
      const ret = mciExec(`open new Type waveaudio Alias ${testAlias}`);
      if (ret.code === 0) {
        mciExec(`close ${testAlias}`);
        console.log('[MCIRecorder] 音频设备可用');
        return true;
      }
      console.log('[MCIRecorder] 音频设备不可用，错误码:', ret.code);
      return false;
    } catch (e) {
      console.error('[MCIRecorder] 检查设备失败:', e.message);
      return false;
    }
  }
  
  // 开始录制
  start() {
    if (this.isRecording) {
      console.log('[MCIRecorder] 已在录制中');
      return false;
    }
    
    if (!mciSendString) {
      throw new Error('mciSendString 不可用');
    }
    
    try {
      console.log('[MCIRecorder] 开始录制...');
      
      // 第一步：打开设备并设置音频格式
      const openRet = mciExec(`open new Type waveaudio Alias ${this.alias}`);
      if (openRet.code !== 0) {
        throw new Error(`无法打开音频设备，错误码: ${openRet.code}`);
      }
      
      // 设置音频格式（注意：mciSendString的set命令参数是单数形式）
      let formatSet = true;
      const set1 = mciExec(`set ${this.alias} bitspersample ${this.bitsPerSample}`);
      if (set1.code !== 0) { formatSet = false; }
      const set2 = mciExec(`set ${this.alias} samplespersec ${this.sampleRate}`);
      if (set2.code !== 0) { formatSet = false; }
      const set3 = mciExec(`set ${this.alias} channels ${this.channels}`);
      if (set3.code !== 0) { formatSet = false; }
      
      if (formatSet) {
        console.log(`[MCIRecorder] 音频格式设置成功: ${this.sampleRate}Hz/${this.bitsPerSample}bit/${this.channels}声道`);
      } else {
        console.warn('[MCIRecorder] 部分音频格式设置失败，使用默认格式（录制后将自动转换）');
      }
      
      // 第二步：关闭设备（设置格式后需要关闭再重新打开才能录制，否则错误码328）
      mciExec(`close ${this.alias}`);
      
      // 第三步：重新打开设备
      const reopenRet = mciExec(`open new Type waveaudio Alias ${this.alias}`);
      if (reopenRet.code !== 0) {
        throw new Error(`无法重新打开音频设备，错误码: ${reopenRet.code}`);
      }
      
      // 第四步：开始录制
      const recordRet = mciExec(`record ${this.alias}`);
      if (recordRet.code !== 0) {
        mciExec(`close ${this.alias}`);
        throw new Error(`无法开始录制，错误码: ${recordRet.code}`);
      }
      
      this.isRecording = true;
      console.log('[MCIRecorder] 录制已开始');
      return true;
    } catch (e) {
      console.error('[MCIRecorder] 开始录制失败:', e.message);
      this.cleanup();
      throw e;
    }
  }
  
  // 停止录制并返回 WAV 数据
  stop() {
    if (!this.isRecording) {
      console.log('[MCIRecorder] 未在录制中');
      return null;
    }
    
    try {
      console.log('[MCIRecorder] 停止录制...');
      this.isRecording = false;
      
      // 停止录制
      mciExec(`stop ${this.alias}`);
      
      // 保存到临时文件
      this.tempWavPath = path.join(os.tmpdir(), `lobster_voice_${Date.now()}.wav`);
      const saveRet = mciExec(`save ${this.alias} "${this.tempWavPath}"`);
      if (saveRet.code !== 0) {
        throw new Error(`无法保存音频，错误码: ${saveRet.code}`);
      }
      
      // 关闭设备
      mciExec(`close ${this.alias}`);
      
      // 读取 WAV 文件
      if (!fs.existsSync(this.tempWavPath)) {
        throw new Error('WAV 文件未生成');
      }
      
      let wavBuffer = fs.readFileSync(this.tempWavPath);
      console.log('[MCIRecorder] 录制完成，原始WAV大小:', wavBuffer.length, 'bytes');
      
      // 自动转换为16kHz/16bit/单声道格式，提高SAPI识别率
      wavBuffer = convertWavTo16k16bit(wavBuffer);
      
      // 清理临时文件
      try { fs.unlinkSync(this.tempWavPath); } catch (e) {}
      this.tempWavPath = null;
      
      if (wavBuffer.length < 100) {
        console.log('[MCIRecorder] 音频数据太小，可能没有声音');
        return null;
      }
      
      // 转换为 ArrayBuffer 以便传输到渲染进程
      const arrayBuffer = new ArrayBuffer(wavBuffer.length);
      const view = new Uint8Array(arrayBuffer);
      view.set(wavBuffer);
      console.log('[MCIRecorder] 最终WAV大小:', arrayBuffer.byteLength, 'bytes');
      return arrayBuffer;
    } catch (e) {
      console.error('[MCIRecorder] 停止录制失败:', e.message);
      this.cleanup();
      throw e;
    }
  }
  
  // 清理资源
  cleanup() {
    try {
      if (this.isRecording) {
        mciExec(`stop ${this.alias}`);
        mciExec(`close ${this.alias}`);
      }
      if (this.tempWavPath && fs.existsSync(this.tempWavPath)) {
        try { fs.unlinkSync(this.tempWavPath); } catch (e) {}
      }
      this.isRecording = false;
      this.tempWavPath = null;
      console.log('[MCIRecorder] 资源已清理');
    } catch (e) {
      console.error('[MCIRecorder] 清理资源失败:', e.message);
    }
  }
}

module.exports = MCIRecorder;
