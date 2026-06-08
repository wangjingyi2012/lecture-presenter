# Lecture Presenter / 演讲宝

[English](#english) | [中文](#中文)

## 中文

Lecture Presenter（演讲宝）是一个基于 Tauri 2 的桌面课程演示工具，用于浏览、播放和编辑课程资料。它支持 PDF、视频、Markdown、代码文件、网页资源，以及 PPT-EXTRA（PPTE）HTML 幻灯片。

### 功能

- 课程目录导航：按章节组织课件、阅读材料、视频、作业和源码。
- 多格式预览：内置 PDF.js、Markdown 渲染、代码高亮和视频播放。
- PPTE 幻灯片：支持 HTML 幻灯片播放、演讲者模式、可视化调整和导出。
- 本地课程管理：可导入已有课程目录，也可在应用内创建课程。
- 可选 AI 辅助：支持用户在本机配置自己的 DeepSeek 或 MiniMax API Key。

### 公开仓库范围

这个公开版本只包含客户端相关代码：

- `lecture-app/`：Tauri 桌面应用
- `lecture-app/src-tauri/使用指南/`：内置示例课程
- `lecture-app/src-tauri/PPT-Template/`：内置 PPTE 模板
- `COURSE_FORMAT.md`：课程格式说明

不包含服务端、部署脚本、数据库、私有配置或密钥。在线更新、账号系统、会员系统、通知和托管 AI 服务对应的服务端代码不在本仓库中。

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

### 密钥与本地配置

不要把真实密钥提交到 Git。应用内配置的 AI API Key 会写入本机应用数据目录中的 `app-config.json`，公开仓库中的默认 `app-config.json` 不应包含任何真实密钥、个人路径或私有服务地址。

### GitHub 发布建议

如果你的本地工作仓库历史中曾经包含密钥、服务端代码或私有课程内容，不要直接把原仓库历史推到公开 GitHub 仓库。请创建一个干净发布副本，重新初始化 Git，只提交公开客户端文件。

## English

Lecture Presenter is a Tauri 2 desktop app for presenting, browsing, and editing course materials. It supports PDF, video, Markdown, source code, web links, and PPT-EXTRA (PPTE) HTML slides.

### Features

- Course navigation organized by sections and resources.
- Built-in PDF.js rendering, Markdown viewing, code highlighting, and video playback.
- PPTE slide playback, speaker mode, visual adjustment tools, and export support.
- Local course import and in-app course creation.
- Optional AI assistance with user-provided DeepSeek or MiniMax API keys stored locally.

### Public Repository Scope

This public repository contains client-side code only:

- `lecture-app/`: the Tauri desktop app
- `lecture-app/src-tauri/使用指南/`: bundled sample course
- `lecture-app/src-tauri/PPT-Template/`: bundled PPTE templates
- `COURSE_FORMAT.md`: course format documentation

It does not include server code, deployment scripts, databases, private configuration, or secrets. Server-side features such as hosted updates, accounts, memberships, notifications, and hosted AI are outside this repository.

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

### Secrets and Local Config

Do not commit real secrets. AI API keys configured in the app are stored in the local app data `app-config.json`. The default repository `app-config.json` should never contain real API keys, personal filesystem paths, or private service URLs.

### GitHub Release Recommendation

If your local working repository history has ever contained secrets, server code, or private course materials, do not push that original history to a public GitHub repository. Create a clean release copy, initialize a fresh Git repository, and commit only the public client files.
