/**
 * AI龙虾 - 账号系统（渲染进程 - 弹窗式）
 * 通过 IPC 调用主进程 Supabase 认证模块
 * 顶部按钮点击弹出登录/注册弹窗，个人信息、修改密码均为弹窗
 */

(function() {
  'use strict';

  // ==================== 全局变量 ====================
  let currentUser = null;
  let isConfigured = false;
  let tempAvatarBase64 = null; // 临时存储上传的头像 base64
  
  // 全局函数：处理头像图片加载失败
  window.handleAvatarError = function(img) {
    if (img && img.parentElement) {
      img.parentElement.innerHTML = DEFAULT_LOBSTER_AVATAR;
    }
  };
  let saveProfileCooldown = false; // 保存个人资料的冷却状态

  // ==================== 初始化 ====================
  async function init() {
    // 安全检查：确保 window.api 存在
    if (!window.api || !window.api.supabase) {
      console.warn('[Account] window.api.supabase 不存在，账号系统不可用');
      bindEvents();
      updateTopBar();
      return;
    }

    // 检查配置状态
    try {
      const config = await window.api.supabase.getConfig();
      isConfigured = config.configured;
    } catch (e) {
      console.error('[Account] 获取配置失败:', e);
    }

    // 检查登录状态（带重试机制，等待主进程会话恢复完成）
    let loginCheckRetries = 0;
    const maxRetries = 5;
    async function checkLoginStatus() {
      try {
        const result = await window.api.supabase.getCurrentUser();
        if (result.loggedIn) {
          currentUser = result.user;
          console.log('[Account] 已恢复登录状态:', currentUser.email || currentUser.username);
          return true;
        }
        return false;
      } catch (e) {
        console.error('[Account] 检查登录状态失败:', e);
        return false;
      }
    }
    
    // 第一次检查
    let loggedIn = await checkLoginStatus();
    
    // 如果未登录且还有重试次数，延迟后重试
    while (!loggedIn && loginCheckRetries < maxRetries) {
      loginCheckRetries++;
      await new Promise(resolve => setTimeout(resolve, 500));
      loggedIn = await checkLoginStatus();
    }

    // 自动填充保存的账号（不自动登录模式）
    try {
      const savedAccount = localStorage.getItem('savedAccount');
      if (savedAccount && !currentUser) {
        const loginEmailInput = document.getElementById('modal-login-email');
        if (loginEmailInput) {
          loginEmailInput.value = savedAccount;
          console.log('[Account] 已自动填充保存的账号:', savedAccount);
        }
      }
    } catch (e) {
      console.error('[Account] 自动填充账号失败:', e);
    }

    bindEvents();
    updateTopBar();
    updateAILock();
  }

  // ==================== AI 功能登录锁定（已永久解锁） ====================
  function updateAILock() {
    const lockOverlay = document.getElementById('ai-config-lock');
    const lockIcon = document.getElementById('nav-lock-ai');
    // 永久解锁：始终隐藏锁定遮罩和锁定图标
    if (lockOverlay) lockOverlay.classList.add('hidden');
    if (lockIcon) lockIcon.style.display = 'none';
  }

  // ==================== 事件绑定 ====================
  function bindEvents() {
    // 顶部登录按钮
    const loginBtn = document.getElementById('top-login-btn');
    if (loginBtn) loginBtn.addEventListener('click', () => openModal('login'));

    // 顶部用户头像
    const userAvatar = document.getElementById('top-user-avatar');
    if (userAvatar) userAvatar.addEventListener('click', () => openModal('profile'));

    // AI 配置锁定遮罩的"立即登录"按钮
    const aiLockLoginBtn = document.getElementById('ai-lock-login-btn');
    if (aiLockLoginBtn) aiLockLoginBtn.addEventListener('click', () => openModal('login'));

    // 弹窗关闭按钮
    document.querySelectorAll('.account-modal-close').forEach(btn => {
      btn.addEventListener('click', closeAllModals);
    });

    // 登录/注册切换
    document.querySelectorAll('.account-modal-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const type = tab.dataset.type;
        document.querySelectorAll('.account-modal-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('modal-login-form').style.display = type === 'login' ? 'block' : 'none';
        document.getElementById('modal-register-form').style.display = type === 'register' ? 'block' : 'none';
        hideModalMessage();
      });
    });

    // 登录按钮
    const modalLoginBtn = document.getElementById('modal-login-btn');
    if (modalLoginBtn) modalLoginBtn.addEventListener('click', handleLogin);

    // GitHub 登录按钮
    const githubLoginBtn = document.getElementById('github-login-btn');
    if (githubLoginBtn) githubLoginBtn.addEventListener('click', handleGitHubLogin);

    // GitHub 授权完成按钮
    const githubCompleteBtn = document.getElementById('github-complete-btn');
    if (githubCompleteBtn) githubCompleteBtn.addEventListener('click', checkGitHubLoginStatus);

    // 注册按钮
    const modalRegisterBtn = document.getElementById('modal-register-btn');
    if (modalRegisterBtn) modalRegisterBtn.addEventListener('click', handleRegister);

    // 退出登录按钮
    const modalLogoutBtn = document.getElementById('modal-logout-btn');
    if (modalLogoutBtn) modalLogoutBtn.addEventListener('click', handleLogout);

    // 保存个人信息按钮
    const saveProfileBtn = document.getElementById('save-profile-btn');
    if (saveProfileBtn) saveProfileBtn.addEventListener('click', handleSaveProfile);

    // 头像上传（限制 20KB 及以下）
    const MAX_AVATAR_SIZE = 20 * 1024; // 20KB
    const profileAvatarDisplay = document.getElementById('profile-avatar-display');
    const profileAvatarInput = document.getElementById('profile-avatar-input');
    const profileAvatarUrl = document.getElementById('profile-avatar-url');
    const applyAvatarUrlBtn = document.getElementById('apply-avatar-url-btn');
    
    if (profileAvatarDisplay && profileAvatarInput) {
      profileAvatarDisplay.addEventListener('click', () => {
        profileAvatarInput.click();
      });
      profileAvatarInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
          // 检查文件大小
          if (file.size > MAX_AVATAR_SIZE) {
            showToast('头像过大', `图片大小 ${(file.size / 1024).toFixed(1)}KB，超过限制 20KB，请压缩后再上传`, 'error');
            profileAvatarInput.value = '';
            return;
          }
          const reader = new FileReader();
          reader.onload = (event) => {
            tempAvatarBase64 = event.target.result;
            profileAvatarDisplay.innerHTML = `<img src="${tempAvatarBase64}" alt="avatar" style="width:100%;height:100%;object-fit:cover;border-radius:50%;pointer-events:none;">`;
            if (profileAvatarUrl) profileAvatarUrl.value = '';
            showToast('头像已选择', `图片大小 ${(file.size / 1024).toFixed(1)}KB，点击保存修改生效`, 'success');
          };
          reader.readAsDataURL(file);
        }
      });
    }
    
    // 应用头像 URL 链接
    if (applyAvatarUrlBtn && profileAvatarUrl && profileAvatarDisplay) {
      applyAvatarUrlBtn.addEventListener('click', () => {
        const url = profileAvatarUrl.value.trim();
        if (!url) {
          showToast('请输入链接', '请输入头像图片的URL链接', 'warning');
          return;
        }
        // 简单的 URL 验证
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
          showToast('链接格式错误', '请输入以 http:// 或 https:// 开头的有效链接', 'error');
          return;
        }
        // 预加载图片验证
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          tempAvatarBase64 = url; // URL 模式直接保存链接
          profileAvatarDisplay.innerHTML = `<img src="${url}" alt="avatar" style="width:100%;height:100%;object-fit:cover;border-radius:50%;pointer-events:none;">`;
          if (profileAvatarInput) profileAvatarInput.value = '';
          showToast('头像链接已应用', '点击保存修改生效，注意：网络头像需确保链接长期有效', 'success');
        };
        img.onerror = () => {
          showToast('链接无效', '无法加载该图片链接，请检查URL是否正确或图片是否可访问', 'error');
        };
        img.src = url;
      });
    }

    // 修改邮箱按钮
    const updateEmailBtn = document.getElementById('update-email-btn');
    if (updateEmailBtn) updateEmailBtn.addEventListener('click', handleUpdateEmail);

    // 忘记密码按钮
    const forgotPasswordBtn = document.getElementById('forgot-password-btn');
    if (forgotPasswordBtn) forgotPasswordBtn.addEventListener('click', () => openModal('reset'));

    // 发送重置密码邮件按钮
    const resetPasswordBtn = document.getElementById('reset-password-btn');
    if (resetPasswordBtn) resetPasswordBtn.addEventListener('click', handleResetPassword);

    // 密码找回弹窗的返回登录按钮
    const resetBackBtn = document.getElementById('reset-back-btn');
    if (resetBackBtn) resetBackBtn.addEventListener('click', () => openModal('login'));

    // 修改密码按钮
    const changePasswordBtn = document.getElementById('change-password-btn');
    if (changePasswordBtn) changePasswordBtn.addEventListener('click', () => openModal('password'));

    // 确认修改密码按钮
    const confirmPasswordBtn = document.getElementById('confirm-password-btn');
    if (confirmPasswordBtn) confirmPasswordBtn.addEventListener('click', handleChangePassword);

    // 密码显示/隐藏切换
    const passwordToggles = document.querySelectorAll('.account-password-toggle');
    passwordToggles.forEach(toggle => {
      toggle.addEventListener('click', () => {
        const targetId = toggle.getAttribute('data-target');
        const input = document.getElementById(targetId);
        if (!input) return;
        
        const isPassword = input.type === 'password';
        input.type = isPassword ? 'text' : 'password';
        toggle.classList.toggle('show-password', isPassword);
        toggle.setAttribute('title', isPassword ? '隐藏密码' : '显示密码');
      });
    });

    // 回车登录
    const loginPassword = document.getElementById('modal-login-password');
    if (loginPassword) {
      loginPassword.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleLogin();
      });
    }

    // ESC 关闭弹窗
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeAllModals();
    });
  }

  // ==================== 弹窗控制 ====================
  function openModal(type) {
    closeAllModals();
    const modal = document.getElementById('account-modal-' + type);
    if (modal) {
      modal.classList.add('show');
      if (type === 'profile' && currentUser) {
        fillProfileForm();
      }
    }
  }

  function closeAllModals() {
    document.querySelectorAll('.account-modal').forEach(modal => {
      modal.classList.remove('show');
    });
    hideModalMessage();
  }

  function showModalMessage(text, type = 'info') {
    const msg = document.getElementById('account-modal-message');
    if (!msg) return;
    msg.textContent = text;
    msg.className = 'account-modal-message ' + type;
  }

  function hideModalMessage() {
    const msg = document.getElementById('account-modal-message');
    if (msg) msg.className = 'account-modal-message';
  }

  // ==================== 登录（支持用户名或邮箱）====================
  async function handleLogin() {
    const identifier = document.getElementById('modal-login-email').value.trim();
    const password = document.getElementById('modal-login-password').value;

    console.log('[Account] 开始登录，identifier:', identifier, 'password长度:', password.length);

    if (!identifier || !password) {
      showModalMessage('请输入用户名/邮箱和密码', 'error');
      return;
    }

    const btn = document.getElementById('modal-login-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="account-loading"></span>登录中...';

    try {
      let email = identifier;
      // 如果不包含 @，则是用户名，需要先查询邮箱（后台静默查询，不显示提示）
      if (!identifier.includes('@')) {
        const emailResult = await window.api.supabase.getEmailByUsername(identifier);
        if (emailResult.success && emailResult.email) {
          email = emailResult.email;
        } else {
          showModalMessage('用户名不存在', 'error');
          btn.disabled = false;
          btn.innerHTML = '登录';
          return;
        }
      }

      const result = await window.api.supabase.login({ email, password });
      if (result.success) {
        currentUser = result.user;
        updateTopBar();
        updateAILock();
        
        // 检查是否勾选了自动登录
        const autoLoginCheckbox = document.getElementById('auto-login-checkbox');
        const autoLogin = autoLoginCheckbox ? autoLoginCheckbox.checked : false;
        
        if (autoLogin) {
          // 自动登录模式：保存会话（Supabase 自动保存），清除 localStorage 中的账号
          localStorage.removeItem('savedAccount');
          console.log('[Account] 自动登录模式：会话已保存');
        } else {
          // 不自动登录模式：保存账号到 localStorage，清除会话存储
          localStorage.setItem('savedAccount', identifier);
          // 延迟清除会话，确保 currentUser 已经设置
          setTimeout(async () => {
            try {
              await window.api.supabase.clearSession();
              console.log('[Account] 不自动登录模式：会话已清除，账号已保存');
            } catch (e) {
              console.error('[Account] 清除会话失败:', e);
            }
          }, 100);
        }
        
        closeAllModals();
        showToast('登录成功！欢迎回来');
      } else {
        showModalMessage('登录失败: ' + result.error, 'error');
      }
    } catch (e) {
      console.error('[Account] 登录异常:', e);
      showModalMessage('登录失败: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '登录';
    }
  }

  // ==================== GitHub 登录（所有校验请求由 Supabase 完成）====================
  async function handleGitHubLogin() {
    const btn = document.getElementById('github-login-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="account-loading"></span>正在打开 GitHub...';

    try {
      const result = await window.api.supabase.githubLogin();
      if (result.success) {
        // 显示 GitHub 授权提示
        showModalMessage('已在浏览器中打开 GitHub 授权页面，授权完成后点击下方按钮', 'info');
        
        // 显示"完成授权"按钮
        const completeBtn = document.getElementById('github-complete-btn');
        if (completeBtn) {
          completeBtn.style.display = 'block';
        }
      } else {
        showModalMessage('GitHub 登录失败: ' + result.error, 'error');
      }
    } catch (e) {
      showModalMessage('GitHub 登录失败: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<svg class="github-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg> 使用 GitHub 登录';
    }
  }

  // 检查 GitHub 登录状态
  async function checkGitHubLoginStatus() {
    try {
      const result = await window.api.supabase.getCurrentUser();
      if (result.loggedIn) {
        currentUser = result.user;
        updateTopBar();
        updateAILock();
        closeAllModals();
        showToast('GitHub 登录成功！欢迎回来');
      } else {
        showModalMessage('尚未检测到登录状态，请确保已在浏览器中完成 GitHub 授权', 'error');
      }
    } catch (e) {
      showModalMessage('检查登录状态失败: ' + e.message, 'error');
    }
  }

  // ==================== 注册 ====================
  async function handleRegister() {
    const nickname = document.getElementById('modal-register-nickname').value.trim();
    const username = document.getElementById('modal-register-username').value.trim();
    const email = document.getElementById('modal-register-email').value.trim();
    const password = document.getElementById('modal-register-password').value;
    const confirmPassword = document.getElementById('modal-register-confirm').value;

    if (!nickname || !username || !email || !password) {
      showModalMessage('请填写昵称、用户名、邮箱和密码', 'error');
      return;
    }
    if (password.length < 6) {
      showModalMessage('密码至少需要6位', 'error');
      return;
    }
    if (password !== confirmPassword) {
      showModalMessage('两次输入的密码不一致', 'error');
      return;
    }

    const btn = document.getElementById('modal-register-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="account-loading"></span>注册中...';

    try {
      const result = await window.api.supabase.register({ nickname, username, email, password });
      if (result.success) {
        showModalMessage('注册成功！请登录', 'success');
        setTimeout(() => {
          document.querySelector('.account-modal-tab[data-type="login"]').click();
          document.getElementById('modal-login-email').value = username;
        }, 2000);
      } else {
        showModalMessage('注册失败: ' + result.error, 'error');
      }
    } catch (e) {
      showModalMessage('注册失败: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '注册';
    }
  }

  // ==================== 退出登录 ====================
  async function handleLogout() {
    try {
      const result = await window.api.supabase.logout();
      if (result.success) {
        currentUser = null;
        updateTopBar();
        updateAILock();
        closeAllModals();
        showToast('已退出登录');
      } else {
        showModalMessage('退出失败: ' + result.error, 'error');
      }
    } catch (e) {
      showModalMessage('退出失败: ' + e.message, 'error');
    }
  }

  // ==================== 个人资料 ====================
  function fillProfileForm() {
    if (!currentUser) return;
    // 不重置 tempAvatarBase64，保留用户未保存的临时头像选择
    document.getElementById('profile-nickname').value = currentUser.nickname || currentUser.username || '';
    document.getElementById('profile-username').value = currentUser.username || '';
    document.getElementById('profile-email').textContent = currentUser.email || '';
    
    // 显示头像：如果有临时头像（未保存），显示临时头像；否则显示用户当前头像
    const profileAvatarDisplay = document.getElementById('profile-avatar-display');
    if (profileAvatarDisplay) {
      if (tempAvatarBase64) {
        // 有临时头像（本地图片或URL链接），保留显示
        profileAvatarDisplay.innerHTML = `<img src="${tempAvatarBase64}" alt="avatar" style="width:100%;height:100%;object-fit:cover;border-radius:50%;pointer-events:none;" onerror="handleAvatarError(this)">`;
      } else if (currentUser.avatar_url) {
        profileAvatarDisplay.innerHTML = `<img src="${currentUser.avatar_url}" alt="avatar" style="width:100%;height:100%;object-fit:cover;border-radius:50%;pointer-events:none;" onerror="handleAvatarError(this)">`;
      } else {
        profileAvatarDisplay.innerHTML = DEFAULT_LOBSTER_AVATAR;
      }
    }
    
    // 更新显示的昵称
    const profileNameDisplay = document.getElementById('profile-name-display');
    if (profileNameDisplay) {
      profileNameDisplay.textContent = currentUser.nickname || currentUser.username || '用户';
    }
  }

  async function handleSaveProfile() {
    if (!currentUser) return;

    // 冷却检查
    if (saveProfileCooldown) {
      showToast('操作太频繁，请稍后再试', 'warning');
      return;
    }

    const nickname = document.getElementById('profile-nickname').value.trim();
    const avatar_url = tempAvatarBase64 || currentUser.avatar_url || null;

    // 用户名不可修改，使用当前用户的用户名
    const username = currentUser.username;

    const btn = document.getElementById('save-profile-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="account-loading"></span>保存中...';

    try {
      const result = await window.api.supabase.updateProfile({ nickname, avatar_url });
      if (result.success) {
        currentUser.nickname = nickname || username;
        currentUser.avatar_url = avatar_url;
        tempAvatarBase64 = null; // 重置临时头像
        updateTopBar();
        // 更新显示的昵称
        const profileNameDisplay = document.getElementById('profile-name-display');
        if (profileNameDisplay) {
          profileNameDisplay.textContent = currentUser.nickname || currentUser.username || '用户';
        }
        showModalMessage('个人信息已更新', 'success');
        showToast('保存成功', 'success');
        
        // 设置冷却时间（3秒）
        saveProfileCooldown = true;
        setTimeout(() => {
          saveProfileCooldown = false;
        }, 3000);
      } else {
        showModalMessage('保存失败: ' + result.error, 'error');
        showToast('保存失败', 'error');
      }
    } catch (e) {
      showModalMessage('保存失败: ' + e.message, 'error');
      showToast('保存失败', 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '保存修改';
    }
  }

  // ==================== 修改邮箱 ====================
  async function handleUpdateEmail() {
    const email = document.getElementById('profile-email').value.trim();
    if (!email || !email.includes('@')) {
      showModalMessage('请输入有效的邮箱地址', 'error');
      return;
    }

    try {
      const result = await window.api.supabase.updateEmail({ email });
      if (result.success) {
        showModalMessage(result.message, 'success');
      } else {
        showModalMessage('修改失败: ' + result.error, 'error');
      }
    } catch (e) {
      showModalMessage('修改失败: ' + e.message, 'error');
    }
  }

  // ==================== 密码找回 ====================
  async function handleResetPassword() {
    const email = document.getElementById('reset-password-email').value.trim();
    if (!email || !email.includes('@')) {
      showModalMessage('请输入有效的邮箱地址', 'error');
      return;
    }

    const btn = document.getElementById('reset-password-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="account-loading"></span>发送中...';

    try {
      const result = await window.api.supabase.resetPassword({ email });
      if (result.success) {
        showModalMessage(result.message, 'success');
        setTimeout(() => {
          closeAllModals();
          openModal('login');
        }, 2000);
      } else {
        showModalMessage('发送失败: ' + result.error, 'error');
      }
    } catch (e) {
      showModalMessage('发送失败: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '发送重置邮件';
    }
  }

  // ==================== 修改密码 ====================
  async function handleChangePassword() {
    if (!currentUser) return;

    const oldPassword = document.getElementById('password-old').value;
    const newPassword = document.getElementById('password-new').value;
    const confirmPassword = document.getElementById('password-confirm').value;

    if (!oldPassword || !newPassword || !confirmPassword) {
      showModalMessage('请填写所有密码字段', 'error');
      return;
    }
    if (newPassword.length < 6) {
      showModalMessage('新密码至少需要6位', 'error');
      return;
    }
    if (newPassword !== confirmPassword) {
      showModalMessage('两次输入的新密码不一致', 'error');
      return;
    }

    const btn = document.getElementById('confirm-password-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="account-loading"></span>修改中...';

    try {
      const result = await window.api.supabase.changePassword({ oldPassword, newPassword });
      if (result.success) {
        showModalMessage('密码修改成功', 'success');
        setTimeout(() => {
          document.getElementById('password-old').value = '';
          document.getElementById('password-new').value = '';
          document.getElementById('password-confirm').value = '';
          openModal('profile');
        }, 1500);
      } else {
        showModalMessage('修改失败: ' + result.error, 'error');
      }
    } catch (e) {
      showModalMessage('修改失败: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '确认修改';
    }
  }

  // 默认龙虾 SVG 头像
  const DEFAULT_LOBSTER_AVATAR = `<svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg"><ellipse cx="32" cy="36" rx="14" ry="18" fill="#E74C3C"/><ellipse cx="32" cy="20" rx="10" ry="8" fill="#C0392B"/><circle cx="28" cy="18" r="2.5" fill="#fff"/><circle cx="36" cy="18" r="2.5" fill="#fff"/><circle cx="28" cy="18" r="1.2" fill="#000"/><circle cx="36" cy="18" r="1.2" fill="#000"/><path d="M26 14 Q22 8 20 6" stroke="#C0392B" stroke-width="2" stroke-linecap="round" fill="none"/><path d="M38 14 Q42 8 44 6" stroke="#C0392B" stroke-width="2" stroke-linecap="round" fill="none"/><path d="M18 32 Q10 28 8 34 Q6 40 12 42 Q16 40 18 36" fill="#C0392B"/><path d="M46 32 Q54 28 56 34 Q58 40 52 42 Q48 40 46 36" fill="#C0392B"/><path d="M22 42 L18 48" stroke="#C0392B" stroke-width="2" stroke-linecap="round"/><path d="M26 46 L22 52" stroke="#C0392B" stroke-width="2" stroke-linecap="round"/><path d="M38 46 L42 52" stroke="#C0392B" stroke-width="2" stroke-linecap="round"/><path d="M42 42 L46 48" stroke="#C0392B" stroke-width="2" stroke-linecap="round"/><path d="M32 54 L28 60 L32 58 L36 60 Z" fill="#C0392B"/></svg>`;

  // ==================== 更新顶部栏 ====================
  function updateTopBar() {
    const loginBtn = document.getElementById('top-login-btn');
    const userAvatar = document.getElementById('top-user-avatar');
    const userName = document.getElementById('top-user-name');

    if (currentUser) {
      if (loginBtn) loginBtn.style.display = 'none';
      if (userAvatar) {
        userAvatar.style.display = 'flex';
        if (currentUser.avatar_url) {
          userAvatar.innerHTML = `<img src="${currentUser.avatar_url}" alt="avatar" onerror="handleAvatarError(this)">`;
        } else {
          userAvatar.innerHTML = DEFAULT_LOBSTER_AVATAR;
        }
      }
      if (userName) {
        userName.style.display = 'inline';
        userName.textContent = currentUser.nickname || currentUser.username || '用户';
      }
    } else {
      if (loginBtn) loginBtn.style.display = 'flex';
      if (userAvatar) userAvatar.style.display = 'none';
      if (userName) userName.style.display = 'none';
    }
  }

  // ==================== Toast 提示 ====================
  function showToast(message, type = 'info') {
    let toast = document.getElementById('account-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'account-toast';
      toast.className = 'account-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.className = 'account-toast toast-' + type;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3000);
  }

  // ==================== 导出 API ====================
  window.AccountAPI = {
    init,
    getCurrentUser: () => currentUser,
    isLoggedIn: () => !!currentUser,
    openModal,
    closeAllModals,
    showToast
  };

  // 页面加载完成后初始化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();




