# Lecture Presenter / 演讲宝

[English](#english) | [中文](#中文)

## 中文

Lecture Presenter（演讲宝）是一个基于 Tauri 2 的桌面课程演示工具，用于浏览、播放和编辑课程资料。它支持 PDF、视频、Markdown、代码文件、网页资源，以及 PPT-EXTRA（PPTE）HTML 幻灯片。

### 功能

- 课程目录导航：按章节组织课件、阅读材料、视频、作业和源码。
- 多格式预览：内置 PDF.js、Markdown 渲染、代码高亮和视频播放。
- PPTE 幻灯片：支持 HTML 幻灯片播放、演讲者模式、可视化调整和导出。
- 本地课程管理：可导入已有课程目录，也可在应用内创建课程。
- AI 辅助：支持 LectureAI，也支持用户配置自己的 DeepSeek 或 MiniMax API Key。
- 在线服务：支持账号登录、会员权益、通知和在线更新。

### 开发环境

需要安装：

- Node.js 20+
- Rust stable
- Tauri 2 所需的系统依赖

启动开发模式：

```bash
cd lecture-app
npm install
npm run dev
```

构建桌面应用：

```bash
cd lecture-app
npm run build
```

构建产物会生成在 `lecture-app/src-tauri/target/release/bundle/` 下。

### 课程格式

课程目录需要包含一个 `course.json`。详细字段和资源类型见 [COURSE_FORMAT.md](COURSE_FORMAT.md)。

### 本地配置

应用设置会保存到本机应用数据目录。用户自配置的 AI API Key 只用于调用对应 AI 提供商，请不要把个人配置文件提交到 Git。

## English

Lecture Presenter is a Tauri 2 desktop app for presenting, browsing, and editing course materials. It supports PDF, video, Markdown, source code, web links, and PPT-EXTRA (PPTE) HTML slides.

### Features

- Course navigation organized by sections and resources.
- Built-in PDF.js rendering, Markdown viewing, code highlighting, and video playback.
- PPTE slide playback, speaker mode, visual adjustment tools, and export support.
- Local course import and in-app course creation.
- AI assistance through LectureAI or user-provided DeepSeek / MiniMax API keys.
- Online services for account login, memberships, notifications, and updates.

### Development

Requirements:

- Node.js 20+
- Rust stable
- System dependencies required by Tauri 2

Run in development mode:

```bash
cd lecture-app
npm install
npm run dev
```

Build the desktop app:

```bash
cd lecture-app
npm run build
```

Build artifacts are generated under `lecture-app/src-tauri/target/release/bundle/`.

### Course Format

A course directory must contain a `course.json` file. See [COURSE_FORMAT.md](COURSE_FORMAT.md) for the full schema and supported resource types.

### Local Config

App settings are stored in the local app data directory. User-provided AI API keys are used only for the selected AI provider. Do not commit personal configuration files to Git.
