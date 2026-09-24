/**
 * AI龙虾 - Supabase 认证模块（主进程）
 * 处理登录注册、用户资料、修改密码、云端设置同步
 * 配置内置在程序中，正式版用户无需手动填写
 */

const { ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');

// 内置默认配置（正式版用户直接使用）
const DEFAULT_CONFIG = {
  url: 'https://fdoxhnfhtdzhefmhlcas.supabase.co',
  key: 'sb_publishable_cj0kw0FQtzNr1CaQP7kCww_ow5AhUqA'
};

// ==================== 自定义文件存储适配器 ====================
// Supabase 默认使用 localStorage，在 Electron 主进程中不可用
// 使用文件存储来持久化会话
const fileStorage = {
  getItem: (key) => {
    try {
      if (SESSION_PATH && fs.existsSync(SESSION_PATH)) {
        const data = JSON.parse(fs.readFileSync(SESSION_PATH, 'utf-8'));
        return data[key] || null;
      }
      return null;
    } catch (e) {
      console.error('[SupabaseAuth] 文件存储读取失败:', e.message);
      return null;
    }
  },
  setItem: (key, value) => {
    try {
      if (SESSION_PATH) {
        let data = {};
        if (fs.existsSync(SESSION_PATH)) {
          data = JSON.parse(fs.readFileSync(SESSION_PATH, 'utf-8'));
        }
        data[key] = value;
        fs.writeFileSync(SESSION_PATH, JSON.stringify(data, null, 2));
      }
    } catch (e) {
      console.error('[SupabaseAuth] 文件存储写入失败:', e.message);
    }
  },
  removeItem: (key) => {
    try {
      if (SESSION_PATH && fs.existsSync(SESSION_PATH)) {
        const data = JSON.parse(fs.readFileSync(SESSION_PATH, 'utf-8'));
        delete data[key];
        fs.writeFileSync(SESSION_PATH, JSON.stringify(data, null, 2));
      }
    } catch (e) {
      console.error('[SupabaseAuth] 文件存储删除失败:', e.message);
    }
  }
};

// 配置文件路径（用户数据目录，用于自定义配置覆盖）
let CONFIG_PATH = null;
let SESSION_PATH = null;
let supabaseClient = null;
let currentUser = null;

// ==================== 初始化 ====================
function init(userDataPath) {
  CONFIG_PATH = path.join(userDataPath, 'supabase-config.json');
  SESSION_PATH = path.join(userDataPath, 'supabase-session.json');
  
  // 启动时自动初始化（使用内置配置，不需要用户手动配置）
  loadConfigAndInit();
  
  // 注册 IPC 处理函数（防御性：确保 ipcMain 存在）
  try {
    if (ipcMain && typeof ipcMain.handle === 'function') {
      registerIpcHandlers();
      console.log('[SupabaseAuth] IPC 处理函数注册成功');
    } else {
      console.warn('[SupabaseAuth] ipcMain 不可用，跳过 IPC 注册');
    }
  } catch (e) {
    console.error('[SupabaseAuth] IPC 注册失败:', e.message);
  }
}

// ==================== 配置管理 ====================
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const data = fs.readFileSync(CONFIG_PATH, 'utf-8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.error('[SupabaseAuth] 读取配置失败:', e.message);
  }
  return null;
}

function saveConfig(config) {
  try {
    const dir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('[SupabaseAuth] 保存配置失败:', e.message);
    return false;
  }
}

function loadConfigAndInit() {
  // 优先使用本地配置文件（用于自定义配置覆盖），否则使用内置默认配置
  let config = null;
  try {
    config = loadConfig();
  } catch (e) {
    console.error('[SupabaseAuth] 读取本地配置异常:', e.message);
  }
  
  if (!config || !config.url || !config.key) {
    config = DEFAULT_CONFIG;
    console.log('[SupabaseAuth] 使用内置默认配置');
  } else {
    console.log('[SupabaseAuth] 使用本地自定义配置');
  }
  
  console.log('[SupabaseAuth] 正在初始化，URL:', config.url);
  
  try {
    // 动态导入 Supabase
    console.log('[SupabaseAuth] 正在加载 @supabase/supabase-js...');
    const { createClient } = require('@supabase/supabase-js');
    console.log('[SupabaseAuth] @supabase/supabase-js 加载成功');
    
    supabaseClient = createClient(config.url, config.key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        storage: fileStorage
      },
      realtime: {
        enabled: false
      }
    });
    console.log('[SupabaseAuth] 初始化成功！');
    
    // 恢复登录状态
    restoreSession();
  } catch (e) {
    console.error('[SupabaseAuth] 初始化失败:', e.message);
    console.error('[SupabaseAuth] 错误详情:', e);
    console.error('[SupabaseAuth] 堆栈:', e.stack);
  }
}

// ==================== 会话恢复 ====================
async function restoreSession() {
  if (!supabaseClient) return;
  try {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (session) {
      currentUser = session.user;
      console.log('[SupabaseAuth] 已恢复登录状态:', currentUser.email);
    }
  } catch (e) {
    console.error('[SupabaseAuth] 恢复会话失败:', e.message);
  }
}

// ==================== 配置相关 IPC ====================
function handleGetConfig() {
  // 配置已内置，始终返回已配置状态
  return {
    configured: true,
    url: DEFAULT_CONFIG.url,
    hasKey: true
  };
}

function handleSaveConfig(event, { url, key }) {
  if (!url || !key) {
    return { success: false, error: 'URL 和密钥不能为空' };
  }
  
  const result = saveConfig({ url, key });
  if (result) {
    // 重新初始化
    loadConfigAndInit();
    return { success: true, message: '配置已保存' };
  }
  return { success: false, error: '保存配置失败' };
}

// ==================== 通过用户名查询邮箱 ====================
async function handleGetEmailByUsername(event, { username }) {
  if (!supabaseClient) {
    return { success: false, error: 'Supabase 初始化失败，请检查网络连接' };
  }
  
  try {
    const { data, error } = await supabaseClient.rpc('get_email_by_username', { username });
    if (error) throw error;
    
    return { success: true, email: data };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ==================== 认证相关 IPC ====================
async function handleLogin(event, { email, password }) {
  if (!supabaseClient) {
    return { success: false, error: 'Supabase 初始化失败，请检查网络连接' };
  }
  
  try {
    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) throw error;
    
    currentUser = data.user;
    const profile = await loadUserProfile();
    
    return {
      success: true,
      user: {
        id: currentUser.id,
        email: currentUser.email,
        username: profile?.username || '',
        nickname: profile?.nickname || profile?.username || '',
        avatar_url: profile?.avatar_url || ''
      }
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ==================== GitHub 登录 ====================
async function handleGitHubLogin() {
  if (!supabaseClient) {
    return { success: false, error: 'Supabase 初始化失败，请检查网络连接' };
  }
  
  try {
    const { data, error } = await supabaseClient.auth.signInWithOAuth({
      provider: 'github',
      options: {
        redirectTo: 'ailobster://auth/callback'
      }
    });
    if (error) throw error;
    
    // 在系统浏览器中打开 GitHub 授权页面
    if (data.url) {
      shell.openExternal(data.url);
    }
    
    return { success: true, url: data.url };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ==================== 注册 ====================
async function handleRegister(event, { nickname, username, email, password }) {
  if (!supabaseClient) {
    return { success: false, error: 'Supabase 初始化失败，请检查网络连接' };
  }
  
  try {
    const { data, error } = await supabaseClient.auth.signUp({
      email,
      password,
      options: { data: { username, nickname } }
    });
    if (error) throw error;
    
    currentUser = data.user;
    
    // 创建用户资料
    if (currentUser) {
      await supabaseClient.from('profiles').upsert({
        id: currentUser.id,
        username,
        nickname: nickname || username,
        avatar_url: null
      });
      
      await supabaseClient.from('user_settings').upsert({
        id: currentUser.id,
        merit_count: 0,
        tap_count: 0,
        theme: 'default',
        sound_enabled: true,
        auto_combo: false
      });
    }
    
    return {
      success: true,
      user: {
        id: currentUser.id,
        email: currentUser.email,
        username,
        nickname: nickname || username
      }
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ==================== 登出 ====================
async function handleLogout() {
  if (!supabaseClient || !currentUser) {
    return { success: false, error: '未登录' };
  }
  
  try {
    await supabaseClient.auth.signOut();
    currentUser = null;
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// 清除会话存储（不清除 currentUser，用于不自动登录的情况）
async function handleClearSession() {
  try {
    // 直接删除会话文件，不调用 signOut（这样 currentUser 不会被清除）
    if (SESSION_PATH && fs.existsSync(SESSION_PATH)) {
      fs.unlinkSync(SESSION_PATH);
      console.log('[SupabaseAuth] 会话存储已清除（不自动登录模式）');
    }
    return { success: true };
  } catch (e) {
    console.error('[SupabaseAuth] 清除会话存储失败:', e.message);
    return { success: false, error: e.message };
  }
}

// ==================== 修改邮箱 ====================
async function handleUpdateEmail(event, { email }) {
  if (!supabaseClient || !currentUser) {
    return { success: false, error: '未登录' };
  }
  
  try {
    const { data, error } = await supabaseClient.auth.updateUser({ email });
    if (error) throw error;
    
    return { success: true, message: '邮箱修改成功，请查收验证邮件' };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ==================== 密码找回（发送重置密码邮件）====================
async function handleResetPassword(event, { email }) {
  if (!supabaseClient) {
    return { success: false, error: 'Supabase 初始化失败，请检查网络连接' };
  }
  
  try {
    const { data, error } = await supabaseClient.auth.resetPasswordForEmail(email, {
      redirectTo: 'ailobster://reset-password'
    });
    if (error) throw error;
    
    return { success: true, message: '重置密码邮件已发送，请查收' };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ==================== 获取当前用户 ====================
async function handleGetCurrentUser() {
  if (!currentUser) return { loggedIn: false };
  
  const profile = await loadUserProfile();
  
  return {
    loggedIn: true,
    user: {
      id: currentUser.id,
      email: currentUser.email,
      username: profile?.username || '',
      nickname: profile?.nickname || profile?.username || '',
      avatar_url: profile?.avatar_url || ''
    }
  };
}

// ==================== 加载用户资料 ====================
async function loadUserProfile() {
  if (!supabaseClient || !currentUser) return null;
  
  try {
    const { data, error } = await supabaseClient
      .from('profiles')
      .select('*')
      .eq('id', currentUser.id)
      .single();
    
    if (error) throw error;
    return data;
  } catch (e) {
    console.error('[SupabaseAuth] 加载用户资料失败:', e.message);
    return null;
  }
}

// ==================== 更新用户资料 ====================
async function handleUpdateProfile(event, { username, nickname, avatar_url }) {
  if (!supabaseClient || !currentUser) {
    return { success: false, error: '未登录' };
  }
  
  try {
    const updateData = {
      id: currentUser.id,
      username
    };
    if (nickname !== undefined) updateData.nickname = nickname;
    if (avatar_url !== undefined) updateData.avatar_url = avatar_url;
    
    const { data, error } = await supabaseClient
      .from('profiles')
      .upsert(updateData);
    
    if (error) throw error;
    
    return { success: true, message: '个人信息已更新' };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ==================== 修改密码 ====================
async function handleChangePassword(event, { oldPassword, newPassword }) {
  if (!supabaseClient || !currentUser) {
    return { success: false, error: '未登录' };
  }
  
  try {
    // 先验证旧密码
    const { error: signInError } = await supabaseClient.auth.signInWithPassword({
      email: currentUser.email,
      password: oldPassword
    });
    
    if (signInError) {
      return { success: false, error: '旧密码不正确' };
    }
    
    // 更新密码
    const { data, error } = await supabaseClient.auth.updateUser({
      password: newPassword
    });
    
    if (error) throw error;
    
    return { success: true, message: '密码修改成功' };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ==================== 云端设置同步 ====================
async function handleLoadSettings() {
  if (!supabaseClient || !currentUser) {
    return { success: false, error: '未登录' };
  }
  
  try {
    const { data, error } = await supabaseClient
      .from('user_settings')
      .select('*')
      .eq('id', currentUser.id)
      .single();
    
    if (error) throw error;
    
    return { success: true, settings: data };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function handleSyncSettings(event, settings) {
  if (!supabaseClient || !currentUser) {
    return { success: false, error: '未登录' };
  }
  
  try {
    const { data, error } = await supabaseClient
      .from('user_settings')
      .upsert({
        id: currentUser.id,
        ...settings,
        updated_at: new Date().toISOString()
      });
    
    if (error) throw error;
    
    return { success: true, message: '设置已同步' };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ==================== 注册 IPC 处理函数 ====================
function registerIpcHandlers() {
  ipcMain.handle('supabase:get-config', handleGetConfig);
  ipcMain.handle('supabase:save-config', handleSaveConfig);
  ipcMain.handle('supabase:login', handleLogin);
  ipcMain.handle('supabase:get-email-by-username', handleGetEmailByUsername);
  ipcMain.handle('supabase:github-login', handleGitHubLogin);
  ipcMain.handle('supabase:register', handleRegister);
  ipcMain.handle('supabase:logout', handleLogout);
  ipcMain.handle('supabase:clearSession', handleClearSession);
  ipcMain.handle('supabase:update-email', handleUpdateEmail);
  ipcMain.handle('supabase:reset-password', handleResetPassword);
  ipcMain.handle('supabase:get-current-user', handleGetCurrentUser);
  ipcMain.handle('supabase:update-profile', handleUpdateProfile);
  ipcMain.handle('supabase:change-password', handleChangePassword);
  ipcMain.handle('supabase:load-settings', handleLoadSettings);
  ipcMain.handle('supabase:sync-settings', handleSyncSettings);
}

module.exports = {
  init
};



