const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');
const os = require('os');

contextBridge.exposeInMainWorld('api', {
  // Window control
  // ★ openMain 支持传入 tab 参数，打开主窗口后自动切换到指定页面（如 'models' 模型管理）
  openMain: (tab) => ipcRenderer.invoke('window:open-main', tab || null),
  closeMain: () => ipcRenderer.invoke('window:close-main'),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  maximize: () => ipcRenderer.invoke('window:maximize'),
  isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  togglePet: (show) => ipcRenderer.invoke('window:toggle-pet', show),
  disclaimerAccepted: () => ipcRenderer.invoke('disclaimer:accepted'),
  petDrag: (x, y) => ipcRenderer.send('pet:drag', { screenX: x, screenY: y }),
  dragMove: (dx, dy) => ipcRenderer.send('window:drag-move', { dx, dy }),
  startDragging: () => ipcRenderer.send('window:start-dragging'),
  getPetPosition: () => ipcRenderer.invoke('pet:get-position'),
  savePetPosition: () => ipcRenderer.invoke('pet:save-position'),
  setPetIgnoreMouseEvents: (ignore, forward) => ipcRenderer.send('pet:set-ignore-mouse-events', { ignore, forward }),
  focusPetWindow: () => ipcRenderer.send('pet:focus'),
  petMoveTo: (x, y, duration) => ipcRenderer.invoke('pet:move-to', { x, y, duration }),
  petExecuteAction: (action) => ipcRenderer.invoke('pet:execute-action', action),
  petDoAction: (name) => ipcRenderer.invoke('pet:do-action', name),
  petChat: (params) => ipcRenderer.invoke('pet:chat', params),
  petAgentChat: (params) => ipcRenderer.invoke('pet:agent-chat', params),
  onPetAgentEvent: (cb) => ipcRenderer.on('pet:agent-event', (_e, data) => cb(data)),
  applyPetSettings: (settings) => ipcRenderer.invoke('pet:apply-settings', settings),
  setPetRenderScale: (scale) => ipcRenderer.send('pet:set-render-scale', scale),
  setAutoStart: (enable) => ipcRenderer.invoke('app:set-auto-start', enable),

  // Config
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (config) => ipcRenderer.invoke('config:set', config),
  saveConfig: (config) => ipcRenderer.invoke('config:set', config),
  resetConfig: () => ipcRenderer.invoke('config:reset'),

  // Taskbar transparency (Windows only)
  // 任务栏外观：只暴露实测安全可用的能力（进程内改写 accent 会让 explorer 崩溃，已禁用）
  taskbarGetState: () => ipcRenderer.invoke('taskbar:get-state'),
  taskbarSetSystemTransparency: (enabled) => ipcRenderer.invoke('taskbar:set-system-transparency', enabled),
  // Phase B / XAML TAP 任务栏外观
  taskbarApplyEffect: (effect) => ipcRenderer.invoke('taskbar:apply-effect', effect),
  taskbarSetFlyoutSync: (key, enabled) => ipcRenderer.invoke('taskbar:set-flyout-sync', key, enabled),
  taskbarTapStatus: () => ipcRenderer.invoke('taskbar:tap-status'),
  // 开始菜单外观（独立开关）
  startMenuApplyEffect: (effect) => ipcRenderer.invoke('startmenu:apply-effect', effect),

  // Model management
  listModels: () => ipcRenderer.invoke('model:list'),
  importModel: (sourcePath) => ipcRenderer.invoke('model:import', sourcePath),
  deleteModel: (modelId) => ipcRenderer.invoke('model:delete', modelId),
  renameModel: (modelId, newName) => ipcRenderer.invoke('model:rename', modelId, newName),
  updateModel: (modelId, updates) => ipcRenderer.invoke('model:update', modelId, updates),
  rescanThumbnail: (modelId) => ipcRenderer.invoke('model:rescan-thumbnail', modelId),
  getActions: (modelId) => ipcRenderer.invoke('model:get-actions', modelId),
  getModel: (modelId) => ipcRenderer.invoke('model:get', modelId),
  saveActions: (modelId, data) => ipcRenderer.invoke('model:save-actions', modelId, data),
  previewActionInPet: (def) => ipcRenderer.invoke('pet:preview-action', def),
  setActionsInPet: (data) => ipcRenderer.invoke('pet:set-actions', data),
  setCurrentModel: (modelId) => ipcRenderer.invoke('model:set-current', modelId),
  validateModel: (modelPath) => ipcRenderer.invoke('model:validate', modelPath),
  scanLive2DDir: (dirPath) => ipcRenderer.invoke('model:scan-live2d-dir', dirPath),
  healLive2DModelJson: (modelPath) => ipcRenderer.invoke('model:heal-live2d-json', modelPath),

  // File operations
  listFiles: (params) => ipcRenderer.invoke('fs:list', params),
  readFile: (params) => ipcRenderer.invoke('fs:read', params),
  writeFile: (params) => ipcRenderer.invoke('fs:write', params),
  copyFile: (params) => ipcRenderer.invoke('fs:copy', params),
  moveFile: (params) => ipcRenderer.invoke('fs:move', params),
  deleteFile: (params) => ipcRenderer.invoke('fs:delete', params),
  createDir: (params) => ipcRenderer.invoke('fs:create-dir', params),
  rename: (params) => ipcRenderer.invoke('fs:rename', params),
  searchFiles: (params) => ipcRenderer.invoke('fs:search', params),
  getFileInfo: (params) => ipcRenderer.invoke('fs:get-info', params),
  openPath: (filePath) => ipcRenderer.invoke('fs:open-path', filePath),
  openInFolder: (filePath) => ipcRenderer.invoke('fs:open-in-folder', filePath),
  selectDirectory: () => ipcRenderer.invoke('fs:select-directory'),
  selectFiles: (options) => ipcRenderer.invoke('fs:select-files', options),
  saveFile: (options) => ipcRenderer.invoke('fs:save-file', options),

  // Command operations
  executeCommand: (params) => ipcRenderer.invoke('cmd:execute', params),
  listTerminals: () => ipcRenderer.invoke('cmd:list-terminals'),
  killProcess: (pid) => ipcRenderer.invoke('cmd:kill', pid),

  // Software management
  listInstalled: () => ipcRenderer.invoke('sw:list-installed'),
  installSoftware: (params) => ipcRenderer.invoke('sw:install', params),
  uninstallSoftware: (params) => ipcRenderer.invoke('sw:uninstall', params),
  getInstallInfo: (name) => ipcRenderer.invoke('sw:get-install-info', name),

  // AI operations
  listLocalModels: () => ipcRenderer.invoke('ai:list-local-models'),
  importLocalModel: (params) => ipcRenderer.invoke('ai:import-local-model', params),
  deleteLocalModel: (modelId) => ipcRenderer.invoke('ai:delete-local-model', modelId),
  // 本地模型（非 Ollama）：拉起/复用本地推理服务并切换为当前模型
  useLocalModel: (modelId) => ipcRenderer.invoke('ai:use-local-model', modelId),
  stopLocalModel: () => ipcRenderer.invoke('ai:stop-local-model'),
  getLocalEngineStatus: () => ipcRenderer.invoke('ai:local-engine-status'),
  detectLocalEngine: () => ipcRenderer.invoke('ai:detect-local-engine'),
  detectPython: () => ipcRenderer.invoke('ai:detect-python'),
  convertModelToGguf: (modelId) => ipcRenderer.invoke('ai:convert-model-to-gguf', modelId),
  checkTools: () => ipcRenderer.invoke('ai:check-tools'),
  downloadTool: (tool, installDir) => ipcRenderer.invoke('ai:download-tool', tool, installDir),
  testMirrors: (urls) => ipcRenderer.invoke('ai:test-mirrors', urls),
  onToolDownloadProgress: (cb) => ipcRenderer.on('ai:tool-download-progress', (_e, p) => cb(p)),
  listCloudProviders: () => ipcRenderer.invoke('ai:list-cloud-providers'),
  addCloudProvider: (params) => ipcRenderer.invoke('ai:add-cloud-provider', params),
  addProviderByPreset: (presetKey, overrides) => ipcRenderer.invoke('ai:add-provider-by-preset', presetKey, overrides),
  getProviderPresets: () => ipcRenderer.invoke('ai:get-provider-presets'),
  updateCloudProvider: (params) => ipcRenderer.invoke('ai:update-cloud-provider', params),
  deleteCloudProvider: (id) => ipcRenderer.invoke('ai:delete-cloud-provider', id),
  fetchProviderModels: (provider) => ipcRenderer.invoke('ai:fetch-provider-models', provider),
  chat: (params) => ipcRenderer.invoke('ai:chat', params),
  streamChat: (params) => ipcRenderer.invoke('ai:stream-chat', params),
  agentChat: (params) => ipcRenderer.invoke('ai:agent-chat', params),
  getAgentTools: () => ipcRenderer.invoke('ai:get-agent-tools'),
  getContextMeta: () => ipcRenderer.invoke('ai:get-context-meta'),
  cancelChat: () => ipcRenderer.invoke('ai:cancel'),
  confirmToolResponse: (allowed) => ipcRenderer.invoke('ai:tool-confirm-response', allowed),
  getAgentRoles: () => ipcRenderer.invoke('agent:roles'),
  saveAgentRole: (role) => ipcRenderer.invoke('agent:role-save', role),
  deleteAgentRole: (roleId) => ipcRenderer.invoke('agent:role-delete', roleId),
  getAIStatus: () => ipcRenderer.invoke('ai:get-status'),
  ollamaListModels: (host) => ipcRenderer.invoke('ai:ollama-list-models', host),
  ollamaTest: (host) => ipcRenderer.invoke('ai:ollama-test', host),

  // ===== AI 长期记忆（设置面板「AI 记忆」）=====
  memory: {
    list: (opts) => ipcRenderer.invoke('memory:list', opts),
    search: (query, limit) => ipcRenderer.invoke('memory:search', query, limit),
    save: (payload) => ipcRenderer.invoke('memory:save', payload),
    update: (id, patch) => ipcRenderer.invoke('memory:update', id, patch),
    remove: (id) => ipcRenderer.invoke('memory:delete', id),
    clear: () => ipcRenderer.invoke('memory:clear'),
    stats: () => ipcRenderer.invoke('memory:stats')
  },

  // ===== 待办事项（当前会话的任务清单）=====
  todo: {
    read: (conversationId) => ipcRenderer.invoke('todo:read', conversationId),
    write: (conversationId, items, title) => ipcRenderer.invoke('todo:write', conversationId, items, title),
    update: (conversationId, patch) => ipcRenderer.invoke('todo:update', conversationId, patch),
    clear: (conversationId) => ipcRenderer.invoke('todo:clear', conversationId),
    stats: () => ipcRenderer.invoke('todo:stats')
  },

  // ===== UI 自验证（截图 / 布局自检）=====
  ui: {
    capture: (opts) => ipcRenderer.invoke('ui:capture', opts),
    listWindows: () => ipcRenderer.invoke('ui:list-windows'),
    audit: (opts) => ipcRenderer.invoke('ui:audit', opts),
    shotsDir: () => ipcRenderer.invoke('ui:shots-dir')
  },

  // System
  getSystemInfo: () => ipcRenderer.invoke('sys:get-info'),
  browseUrl: (url) => ipcRenderer.invoke('sys:browse-url', url),

  // Notifications
  notify: (title, body) => ipcRenderer.invoke('notify:show', { title, body }),

  // Dialogs
  confirm: (options) => ipcRenderer.invoke('dialog:confirm', options),
  showError: (title, message, detail) => ipcRenderer.invoke('dialog:error', { title, message, detail }),

  // Event listeners
  on: (channel, callback) => {
    const wrapper = (_e, data) => callback(data);
    ipcRenderer.on(channel, wrapper);
    return () => ipcRenderer.removeListener(channel, wrapper);
  },

  // BongoCat：启动/停止全局键盘钩子（与 window.isBongocatMode 同步）
  setBongocatActive: (active) => ipcRenderer.invoke('bongocat:set-active', !!active),
  // BongoCat：获取模型目录中的键盘叠加层图片列表（resources/left-keys 和 right-keys）
  bongocatGetKeyImages: (modelDir) => ipcRenderer.invoke('bongocat:get-key-images', modelDir),

  // ★ 右键菜单（独立窗口，不遮挡模型，样式与退出弹窗一致）
  showContextMenu: (x, y, items) => ipcRenderer.invoke('pet:show-context-menu', { x, y, items }),
  onContextMenuAction: (callback) => {
    const wrapper = (_e, action) => callback(action);
    ipcRenderer.on('pet:context-menu-action', wrapper);
    return () => ipcRenderer.removeListener('pet:context-menu-action', wrapper);
  },

  // ★ 动作模组面板（独立窗口）
  showActionPanel: (x, y, actions) => ipcRenderer.invoke("pet:show-action-panel", { x, y, actions }),
  hideActionPanel: () => ipcRenderer.invoke("pet:hide-action-panel"),
  onActionPanelTrigger: (callback) => {
    const wrapper = (_e, data) => callback(data);
    ipcRenderer.on("action-panel:trigger", wrapper);
    return () => ipcRenderer.removeListener("action-panel:trigger", wrapper);
  },
  onActionPanelClosed: (callback) => {
    const wrapper = () => callback();
    ipcRenderer.on("action-panel:closed", wrapper);
    return () => ipcRenderer.removeListener("action-panel:closed", wrapper);
  },

  // ★ 输入框（独立窗口）
  showInputBar: (x, y) => ipcRenderer.invoke("pet:show-input-bar", { x, y }),
  hideInputBar: () => ipcRenderer.invoke("pet:hide-input-bar"),
  onInputBarSend: (callback) => {
    const wrapper = (_e, text) => callback(text);
    ipcRenderer.on("input-bar:send", wrapper);
    return () => ipcRenderer.removeListener("input-bar:send", wrapper);
  },
  onInputBarFocus: (callback) => {
    const wrapper = (_e, focused) => callback(focused);
    ipcRenderer.on("input-bar:focus-change", wrapper);
    return () => ipcRenderer.removeListener("input-bar:focus-change", wrapper);
  },

  // ★ 右键菜单（独立窗口）- 设置中关闭时调用，释放资源
  closeContextMenu: () => ipcRenderer.invoke("pet:close-context-menu"),

  // ★ 宠物窗口边界调整：按模型实际渲染边界包裹窗口（去除多余空白区域）
  // 渲染进程在模型加载完成后计算实际边界，通知主进程调整窗口大小并保持居中
  setPetWindowBounds: (width, height, centerX, centerY) =>
    ipcRenderer.invoke('pet:set-window-bounds', {
      width: Math.round(width),
      height: Math.round(height),
      centerX: typeof centerX === 'number' ? centerX : null,
      centerY: typeof centerY === 'number' ? centerY : null
    }),

  // Utilities
  getAppVersion: () => ipcRenderer.invoke('app:version'),
  quitApp: () => ipcRenderer.invoke('app:quit'),
  getChangelog: () => ipcRenderer.invoke('changelog:get'),
  checkUpdate: () => ipcRenderer.invoke('changelog:check-update'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateGetVersion: () => ipcRenderer.invoke('update:get-version'),
  getFullInstall: () => ipcRenderer.invoke('update:get-full-install'),
  updateDownload: (patchInfo) => ipcRenderer.invoke('update:download', patchInfo),
  updateVerify: (data) => ipcRenderer.invoke('update:verify', data),
  updateApply: (data) => ipcRenderer.invoke('update:apply', data),
  updateRunInstaller: (data) => ipcRenderer.invoke('update:run-installer', data),
  updateRollback: (version) => ipcRenderer.invoke('update:rollback', version),
  updateIgnore: (data) => ipcRenderer.invoke('update:ignore', data),
  updateGetBackups: () => ipcRenderer.invoke('update:get-backups'),
  relaunchApp: () => ipcRenderer.invoke('app:relaunch'),
  onUpdateDownloadProgress: (callback) => { ipcRenderer.on('update:download-progress', (_e, data) => callback(data)); },
  // 完整包下载中心
  updateDownloadFull: (fullInstall) => ipcRenderer.invoke('update:download-full', fullInstall),
  updateGetDownloads: () => ipcRenderer.invoke('update:get-downloads'),
  updateDeleteDownload: (data) => ipcRenderer.invoke('update:delete-download', data),
  updateShowInFolder: (data) => ipcRenderer.invoke('update:show-in-folder', data),
  updateGetFileIcon: (data) => ipcRenderer.invoke('update:get-file-icon', data),
  updateGetDownloadDir: () => ipcRenderer.invoke('update:get-download-dir'),
  updateSetDownloadDir: (data) => ipcRenderer.invoke('update:set-download-dir', data),
  updateResetDownloadDir: () => ipcRenderer.invoke('update:reset-download-dir'),
  updateChooseDownloadDir: () => ipcRenderer.invoke('update:choose-download-dir'),
  onFullDownloadProgress: (callback) => {
    const handler = (_e, data) => callback(data);
    ipcRenderer.on('update:full-progress', handler);
    return () => ipcRenderer.removeListener('update:full-progress', handler);
  },

  // 崩溃/异常上报：渲染进程把 window.error / 未捕获 Promise / WebGL 上下文丢失等
  // 上报到主进程写入 crash.log，避免“闪退无日志”无法定位。
  logCrash: (msg) => ipcRenderer.invoke('app:log-crash', String(msg || '')),
  getCrashLog: () => ipcRenderer.invoke('app:get-crash-log'),

  // 动作编辑器独立窗口控制
  editor: {
    open: (params) => ipcRenderer.invoke('editor:open', params),
    minimize: () => ipcRenderer.invoke('editor:minimize'),
    maximize: () => ipcRenderer.invoke('editor:maximize'),
    isMaximized: () => ipcRenderer.invoke('editor:is-maximized'),
    close: () => ipcRenderer.invoke('editor:close'),
    saved: (modelId) => ipcRenderer.invoke('editor:saved', modelId)
  },

  // Chat History
  saveChatHistory: (history) => ipcRenderer.invoke('chat:save', history),
  loadChatHistory: () => ipcRenderer.invoke('chat:load'),
  clearChatHistory: () => ipcRenderer.invoke('chat:clear'),

  // Speech Recognition (Windows SAPI via IPC)
  speechRecognize: () => ipcRenderer.invoke('speech:recognize'),
  speechStop: () => ipcRenderer.invoke('speech:stop'),
  speechRecognizeWav: (wavBuffer) => ipcRenderer.invoke('speech:recognize-wav', wavBuffer),
  // WaveIn 音频录制（主进程采集，避免渲染进程崩溃）
  speechRecordStart: () => ipcRenderer.invoke('speech:record-start'),
  speechRecordStop: () => ipcRenderer.invoke('speech:record-stop'),

  // Path utilities (safe for renderer)
  path: {
    join: (...args) => path.join(...args),
    dirname: (p) => path.dirname(p),
    basename: (p, ext) => path.basename(p, ext),
    extname: (p) => path.extname(p),
    resolve: (...args) => path.resolve(...args)
  },
  os: {
    homedir: () => os.homedir(),
    platform: () => os.platform(),
    arch: () => os.arch()
  },

  // ===== BongoCat 键盘猫专用 =====
  getBongocatModel: () => ipcRenderer.invoke('bongocat:get-model'),
  setBongocatModel: (modelPath) => ipcRenderer.invoke('bongocat:set-model', modelPath),
  launchBongocat: (modelPath) => ipcRenderer.invoke('bongocat:launch', modelPath),
  closeBongocat: () => ipcRenderer.invoke('bongocat:close'),
  fileExists: (filePath) => ipcRenderer.invoke('bongocat:file-exists', filePath),

  // ===== 独立调试日志窗口 =====
  toggleDebugLog: () => ipcRenderer.invoke('debug-log:toggle'),
  sendDebugLog: (type, msg) => ipcRenderer.send('debug-log:send', type, msg)
,

  // ===== Supabase 账号系统 =====
  supabase: {
    getConfig: () => ipcRenderer.invoke('supabase:get-config'),
    saveConfig: (config) => ipcRenderer.invoke('supabase:save-config', config),
    login: (data) => ipcRenderer.invoke('supabase:login', data),
    getEmailByUsername: (username) => ipcRenderer.invoke('supabase:get-email-by-username', { username }),
    githubLogin: () => ipcRenderer.invoke('supabase:github-login'),
    register: (data) => ipcRenderer.invoke('supabase:register', data),
    logout: () => ipcRenderer.invoke('supabase:logout'),
    clearSession: () => ipcRenderer.invoke('supabase:clearSession'),
    updateEmail: (data) => ipcRenderer.invoke('supabase:update-email', data),
    resetPassword: (data) => ipcRenderer.invoke('supabase:reset-password', data),
    getCurrentUser: () => ipcRenderer.invoke('supabase:get-current-user'),
    updateProfile: (data) => ipcRenderer.invoke('supabase:update-profile', data),
    changePassword: (data) => ipcRenderer.invoke('supabase:change-password', data),
    loadSettings: () => ipcRenderer.invoke('supabase:load-settings'),
    syncSettings: (settings) => ipcRenderer.invoke('supabase:sync-settings', settings)
  }
});

