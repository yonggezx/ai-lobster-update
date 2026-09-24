# 浮灵饰界

> 智能桌面宠物助手 · 让 AI 陪伴你的每一天

浮灵饰界是一款基于 Electron 的 Windows 桌面宠物应用，以虚拟角色「灵汐」为核心，融合 Live2D / MMD 模型渲染、本地与云端 AI 对话、系统级操作助手等能力，让桌面宠物不再只是装饰，而是能真正帮你做事的 AI 伙伴。

![版本](https://img.shields.io/badge/version-1.0.7-blue)
![平台](https://img.shields.io/badge/platform-Windows%20x64-lightgrey)
![许可证](https://img.shields.io/badge/license-MIT-green)

---

## 目录

- [功能特性](#功能特性)
- [技术栈](#技术栈)
- [目录结构](#目录结构)
- [环境要求](#环境要求)
- [快速开始](#快速开始)
- [核心模块说明](#核心模块说明)
- [配置说明](#配置说明)
- [开源范围说明](#开源范围说明)
- [许可证](#许可证)

---

## 功能特性

### 🦊 桌面宠物
- 基于 Live2D / MMD 模型的实时角色渲染，支持呼吸、眨眼、鼠标跟随、点击交互等动作
- 宠物窗口置顶、透明背景、可拖拽移动，支持自定义模型导入
- 角色情绪与状态联动，根据对话内容和系统状态产生反应

### 🤖 AI 对话助手
- 兼容 OpenAI API 协议的云端 AI 服务，支持多提供商切换
- 本地 AI 引擎集成，可在离线环境下运行本地大模型
- 对话上下文记忆、角色设定、多轮对话管理
- 流式输出、打字机效果、Markdown 渲染与代码高亮

### ⚙️ 系统级操作
- 文件管理：浏览、复制、移动、删除文件
- 命令执行：通过自然语言触发系统命令
- 软件安装：自动检测并安装常用工具
- 全局快捷键与鼠标监听，快速唤起宠物面板

### 📋 效率工具
- 待办事项管理（Todo）
- 本地记忆存储，跨会话记住用户偏好
- 模型管理器，统一配置本地与云端模型
- 项目面板，快速切换工作上下文

### 🔄 自动更新
- 基于 electron-updater 的增量与完整包更新
- 更新公告弹窗，版本变更日志
- 下载进度实时显示，支持断点续传

### 🎨 任务栏集成
- Windows 任务栏注入，实现宠物与开始菜单 / 飞行面板的视觉融合
- 亚克力 / 透明效果适配
- 任务栏图标与快捷操作

---

## 技术栈

| 类别 | 技术 |
|---|---|
| 应用框架 | Electron 28 |
| 前端 | 原生 HTML5 / CSS3 / JavaScript（无框架） |
| 2D 渲染 | PixiJS 6 + pixi-live2d-display |
| 3D / MMD | Three.js（MMDLoader / MMDAnimationHelper） |
| 原生交互 | koffi（FFI 调用 Windows API） |
| 数据存储 | 本地 JSON 配置 + Supabase（可选云端同步） |
| 自动更新 | electron-updater |
| 构建打包 | electron-builder 24 |
| 任务栏注入 | C++（MinHook / Detours，需自行编译） |
| 语言 | 中文 / 英文（i18n） |

---

## 目录结构

```
.
├── src/
│   ├── main/                  # 主进程
│   │   ├── main.js            # 应用入口，窗口管理
│   │   ├── preload.js         # 预加载脚本（在根目录）
│   │   ├── configManager.js   # 配置管理
│   │   ├── changelog.js       # 更新公告
│   │   ├── globalKeyboard.js  # 全局快捷键
│   │   ├── globalMouse.js     # 全局鼠标监听
│   │   ├── taskbarTransparency.js  # 任务栏透明效果
│   │   ├── waveInRecorder.js  # 音频录制
│   │   ├── winreg.js          # 注册表操作
│   │   ├── ipc/               # IPC 通信模块
│   │   │   ├── aiOps.js           # AI 对话操作
│   │   │   ├── localAiEngine.js   # 本地 AI 引擎
│   │   │   ├── modelManager.js    # 模型管理
│   │   │   ├── fileOps.js         # 文件操作
│   │   │   ├── commandOps.js      # 命令执行
│   │   │   ├── installOps.js      # 软件安装
│   │   │   ├── todoStore.js       # 待办存储
│   │   │   ├── memoryStore.js     # 记忆存储
│   │   │   ├── updateOps.js       # 更新下载与安装
│   │   │   ├── electronUpdater.js # electron-updater 封装
│   │   │   ├── supabaseAuth.js    # Supabase 认证
│   │   │   ├── crashGuard.js      # 崩溃守护
│   │   │   └── ...
│   │   └── taskbar-inject/    # 任务栏注入（C++ 源码 + JS 客户端）
│   │       ├── taskbarInject.cpp  # 注入器核心
│   │       ├── explorerTap.cpp    # 资源管理器挂钩
│   │       ├── taskbarInjector.js # JS 端注入控制
│   │       ├── tapClient.js       # 注入通信客户端
│   │       └── ...
│   ├── renderer/              # 渲染进程
│   │   ├── index.html         # 主界面
│   │   ├── pet.html           # 宠物窗口
│   │   ├── debug-log.html     # 调试日志窗口
│   │   ├── css/style.css      # 全局样式
│   │   ├── js/
│   │   │   ├── app.js             # 主界面逻辑
│   │   │   ├── mmdPet.js          # MMD 宠物渲染
│   │   │   ├── mmdPreview.src.js  # 模型预览
│   │   │   ├── i18n.js            # 国际化
│   │   │   ├── icons.js           # 图标系统
│   │   │   ├── dialog.js          # 对话框组件
│   │   │   ├── visualEditor.js    # 可视化编辑器
│   │   │   └── ...
│   │   └── assets/            # 渲染进程资源
│   └── preload.js             # 主预加载脚本
├── scripts/                   # 构建与发布脚本
│   ├── publish.js             # 发布主流程
│   ├── build-patch.js         # 增量补丁构建
│   ├── build-web-installer.js # 网页安装器构建
│   ├── sync-update-to-github.js  # 更新文件同步到 GitHub
│   ├── deploy-website.js      # 官网部署
│   ├── setup-github-pages.js  # GitHub Pages 初始化
│   ├── sync-website-version.js   # 官网版本同步
│   └── test-update-network.js    # 更新网络测试
├── assets/icons/              # 应用图标与品牌资源
├── package.json
├── package-lock.json
├── LICENSE
└── .gitignore
```

---

## 环境要求

- **操作系统**：Windows 10 / 11（x64）
- **Node.js**：≥ 16.0（推荐 18+）
- **npm**：≥ 8.0
- **C++ 编译环境**（仅编译任务栏注入 DLL 时需要）：Visual Studio 2022 或 Build Tools，Windows SDK

---

## 快速开始

### 1. 克隆仓库

```bash
git clone https://github.com/yonggezx/fuling-shijie-update.git
cd fuling-shijie-update
```

### 2. 安装依赖

```bash
npm install
```

### 3. 运行开发模式

```bash
npm run dev
```

或直接启动：

```bash
npm start
```

### 4. 构建 Windows 应用

```bash
# 构建未打包的目录版本（便于调试）
npm run build:win-dir
```

构建产物输出到 `dist/` 目录。

### 5. 编译任务栏注入 DLL（可选）

任务栏注入功能需要编译 C++ 源码生成 DLL。源码位于 `src/main/taskbar-inject/`，依赖 MinHook 头文件。使用 Visual Studio 命令行或 `build.bat` 进行编译：

```bash
cd src/main/taskbar-inject
# 使用 MSVC 编译（需安装 Visual Studio Build Tools）
cl /LD /EHsc taskbarInject.cpp /link /OUT:taskbarInject.dll
```

> 注：MinHook 与 Detours 的完整第三方库源码未包含在本仓库中，需自行获取并配置头文件路径。

---

## 核心模块说明

### 主进程（`src/main/`）

- **main.js**：应用生命周期管理，创建主窗口、宠物窗口、调试窗口，注册全局快捷键。
- **configManager.js**：统一管理用户配置（AI 设置、模型、宠物、界面偏好），持久化到本地 JSON。
- **ipc/aiOps.js**：AI 对话核心，处理消息发送、流式接收、上下文管理。
- **ipc/localAiEngine.js**：本地大模型引擎封装，支持 llama.cpp 兼容接口。
- **ipc/updateOps.js**：更新下载管理器，支持临时文件下载、校验、重命名、安装。
- **ipc/fileOps.js / commandOps.js / installOps.js**：系统操作三件套，通过 IPC 暴露给渲染进程。

### 渲染进程（`src/renderer/`）

- **index.html + js/app.js**：主控制面板，包含对话、设置、待办、模型管理等界面。
- **pet.html + js/mmdPet.js**：宠物窗口，基于 Three.js MMDLoader 渲染模型，处理交互动作。
- **js/i18n.js**：中英文国际化，所有界面文案通过 `data-i18n` 属性绑定。
- **js/icons.js**：SVG 图标系统，统一管理界面图标。

### 任务栏注入（`src/main/taskbar-inject/`）

- 通过 Windows 钩子将 DLL 注入资源管理器（explorer.exe），实现宠物与任务栏 / 开始菜单的视觉融合。
- JS 端（`taskbarInjector.js`、`tapClient.js`）通过命名管道与注入的 DLL 通信。
- 支持亚克力背景、透明效果、飞行面板交互等。

### 构建发布（`scripts/`）

- **publish.js**：一键发布流程，版本号管理、构建、打包、上传。
- **build-patch.js**：生成增量更新补丁（基于文件差异）。
- **sync-update-to-github.js**：将更新清单和安装包同步到 GitHub Releases / Pages。
- **deploy-website.js**：部署官网到 GitHub Pages（需配置 `GITHUB_TOKEN` 环境变量）。

---

## 配置说明

首次运行后，应用会在用户目录下生成配置文件。主要配置项：

| 配置项 | 说明 |
|---|---|
| `ai.providers` | AI 提供商列表（名称、API 地址、密钥、模型） |
| `ai.activeProviderId` | 当前活跃的提供商 |
| `pet.modelPath` | 当前使用的模型文件路径 |
| `pet.scale` / `pet.position` | 宠物缩放与位置 |
| `settings.language` | 界面语言（zh / en） |
| `settings.theme` | 主题设置 |
| `update.channel` | 更新通道（stable / beta） |

API 密钥等敏感信息仅存储在本地，不会上传。

---

## 开源范围说明

本仓库公开的是**应用核心源码**，包括：

- ✅ 主进程与渲染进程的全部 JavaScript / HTML / CSS 源码
- ✅ 任务栏注入的 C++ 源码与 JS 通信客户端
- ✅ 构建、发布、部署脚本
- ✅ 应用图标与品牌资源
- ✅ `package.json` / `package-lock.json` / 许可证

以下内容**不包含**在本仓库中：

- ❌ 安装器与卸载器工程（installer / uninstaller）
- ❌ 第三方库完整源码（MinHook、Detours、Three.js 等，通过 npm 或自行获取）
- ❌ 调试脚本、探测脚本、测试截图
- ❌ 编译产物（DLL / EXE / 压缩包）
- ❌ 安全与激活相关模块
- ❌ 用户协议与免责声明文案

如需完整构建可运行的安装包，需在上述缺失模块的基础上自行补充。

---

## 许可证

本项目基于 [MIT 许可证](LICENSE) 开源。

Copyright © 2026 浮灵饰界
