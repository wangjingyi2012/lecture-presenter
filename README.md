# Lecture Presenter · AI 课件工作台

> 用对话的方式，做出一堂课。

Lecture Presenter 是一套**AI 驱动的课件创作与演示平台**。它用自研的 PPTE（HTML 幻灯片）格式替代 PPTX，让课件支持动画、交互和实时预览；内置一个 Claude-Code 风格的 AI 工作台，教师用自然语言对话就能生成、修改、校验课件。

---

## 🎯 核心创新

### 1. PPTE 格式：HTML 幻灯片，碾压 PPTX

PPTE（PPT-EXTRA）是自研的 HTML 幻灯片体系。每页课件是一个完整的 HTML 文档，支持 CSS 动画、SVG 图标、交互弹窗、点击放大等 PPTX 无法实现的效果。播放顺序由 `manifest.json` 控制，无需重命名文件。

```
课件目录/
├── manifest.json          # 标题 + 页面清单
├── slide01.html           # 每页 = 一个完整 HTML
├── slide01.note           # 讲师口述（不进正文）
├── slide02.html
└── content.css            # 共享样式
```

### 2. AI 工作台 + 内置 SKILL：课件质量护城河

工作台是一个终端流式界面（类 Claude Code），教师输入指令，AI 自动读取页面、修改 HTML、校验排版、保存预览。

关键：AI 内置了一套 **PPTE 专家 SKILL**（`workbench_skill.md`，约 2500 字 + 6 个专项 SKILL 文件），涵盖课件制作的全链路：

**排版规范（9 条硬性约束）**：
- 去讲师痕迹（标题不写"开场""续""案例①"）
- 全面书面化（去口语词）
- 去破折号、去句末句号
- emoji 全换内联 SVG（✓✗⚠️→SVG 图标）
- 重点词 `<b style="color:#dc2626">` 红色高亮
- 卡片统一 4 边边框（禁止 border-left 彩条）
- 术语弹窗（`<span class="term" data-popover-body>`）
- 全局覆盖样式集中管理

**教学法（课程设计层）**：
- 循序渐进，不留未知知识点
- 一个概念一页，每页要有真实数据（数据库行、JSON 字段、终端输出）
- 实操环节五步讲：做什么→为什么→复制哪条命令→正常应看到什么→报错最常见原因
- 概念讲透讲够，反对过度压缩
- 实战案例选型四标准：AI 裸用做不到、环境零负担、无合规风险、教学真刚需

**设计规则（视觉与交互层）**：
- 字号分级（vw 制）：H1=3-3.5vw、Body=1.8vw、Caption=1.5vw，禁用 px
- 布局体系：宽度 `%`、垂直 `vh`、字体 `vw`，Grid/Flex 优先
- 16:9 投影安全区（76vh），溢出用 `min-height:0; overflow-y:auto`
- 配色规范：科技蓝 `#3b82f6` + 翡翠绿 `#10b981` + 深灰文字；禁止紫粉渐变
- 卡片：圆角 + 轻阴影 + 浅灰边框，禁止发光/彩条
- 图片点击放大全屏（`.zoomable` + overlay + Esc 关闭）
- 文案直接面向学员，禁讲者口吻（"我们""接下来""大家"）

**页面类型与模板**：
- slide_type：封面 cover / 目录 toc / 内容 content / 图文分栏 split / 卡片网格 cards / 结束 ending
- 排版模板库：feature-list / two-column / timeline / table / image-text-split / image-grid / hero-figure
- 每页 `.note` 文件存放讲师口述（不进正文）

**工具协议（Agent 执行层）**：
- `write_slide` {page, html, reason}：替换某页完整 HTML
- `insert_slide` {after, title, html, reason}：在某页之后插入新页
- `reorder_slides` {order, reason}：重排页面顺序
- `read_slide` {page}：读取某页当前 HTML（AI 自主查看）
- `validate_slide` {page}：对该页跑 PPTE 规范 linter，返回违规项

**动画与交互效果（PPTE 格式原生能力）**：
- CSS 动画 / 过渡 / 关键帧（页面进入、内容揭示、数据高亮）
- 交互弹窗（术语首次出现点击展开）
- 点击放大图片（全屏 overlay）
- 键盘导航（方向键翻页、F 全屏、S 演讲者模式）
- 演讲者模式（独立观众窗口 + 当前/下一页预览 + 计时器 + Markdown 讲稿）
- 批注叠加层（画笔/高亮/文本，内存态不修改课件）

SKILL 沉淀在**服务器端**作为产品资产，客户端无法篡改。每次 AI 对话自动注入，保证产出合规。这不是简单的 prompt 工程，而是将**教学方法论 + 视觉设计规范 + 交互能力 + Agent 工具链**系统化为可执行的 AI 指令集。

### 3. "选 AI" 模型：LectureAI vs 自己的 AI

| | LectureAI（平台内置） | 我的 AI（自配） |
|---|---|---|
| LLM | 平台配置的 DeepSeek | 用户自己的 API Key |
| SKILL | ✅ 完整注入（排版+教学法+设计+协议） | ❌ 仅最小格式约束 |
| 质量 | 高（专家级合规课件） | 低（无 SKILL，反衬 LectureAI 价值） |

用户选 LectureAI = 走平台 LLM + 完整 SKILL = 高质量产出（产品卖点）；选自己的 AI = 走自己的 LLM + 无 SKILL = 效果自然差。**SKILL 是差异化壁垒**。

### 4. 双端互通：桌面 ↔ Web 课件无缝流转

PPTE 格式是桌面端和 Web 端的**通用课件载体**。两端共享同一套 `manifest.json` + `slide*.html` + `.note` 文件结构，课件在任意一端创建，另一端可直接打开：

```
桌面应用创建/编辑 PPTE  ──→  上传到 Web 平台  ──→  在线播放/分享/导出 PDF
                                ↓
Web 平台 AI 生成 PPTE   ──→  下载 PPTE 包   ──→  桌面应用打开/播放/继续编辑
```

| 场景 | 桌面端 | Web 端 |
|---|---|---|
| 创建课件 | ✅ 编辑器 + AI 工作台 | ✅ 工作站 AI 面板 |
| 打开课件 | ✅ 本地文件夹 | ✅ 上传 / 项目列表 |
| 播放 | ✅ 全屏 + 演讲者模式 + 观众窗口 | ✅ 浏览器内在线播放 |
| AI 生成 | ✅ 终端工作台（LectureAI / 自配） | ✅ AI 面板（LectureAI / 自配） |
| 导出 | ✅ PPTX | ✅ PDF / PPTX |
| 分享 | Gitee 备份 | 课件广场公开 + 链接分享 |

两端通过同一套后端 API（`/api/web/*`）+ 同一套 AI 服务（`/api/web/ai/chat` + SKILL）+ 同一套账号体系（`lecture_web_token`）打通，用户在任意端登录后都能访问自己的课件和 AI 配置。

---

## 🌐 在线体验

**Web 平台**：https://design.hz-study-system.com/app/login.html

**评审账号**（登录页一键填入）：
- 用户名 `demo` / 密码 `demo1234`

也可自助注册（需邮箱验证）。

### 评委体验路径

详见 [评委体验指南](docs/JUDGE_GUIDE.md)，核心 5 步：

1. **登录**：用 demo 账号或注册
2. **项目台**：创建/上传 PPTE 课件
3. **工作台**：打开项目，AI 面板选 LectureAI，生成一页课件
4. **缩略图**：左侧实时渲染每页幻灯片
5. **导出**：下载 PPTE 包 / 导出 PDF

---

## 🏗️ 技术架构

```
┌─ 桌面应用 (Tauri 2) ──────────────────────────────┐
│  Rust 后端 (lib.rs)        Vanilla JS 前端          │
│  · PPTE 编辑器             · 工作台 Agent 窗口       │
│  · slide:// 协议           · 终端流式 UI             │
│  · AI 工具执行              · @页面定位               │
│  · PPTX 导出               · 模型选择器              │
└──────────┬───────────────────────────┬────────────┘
           │                           │
     ┌─────▼─────┐              ┌──────▼──────┐
     │ Web 平台   │              │  AI 服务     │
     │ FastAPI    │              │  /api/web/  │
     │ 11 页 SPA  │              │  ai/chat    │
     │ 邮箱验证    │              │  + SKILL    │
     │ 管理后台    │              │  + DeepSeek │
     └────────────┘              └─────────────┘
```

### 技术栈

| 层 | 技术 |
|---|---|
| 桌面 | Tauri 2 (Rust) + 原生 HTML/CSS/JS |
| Web 后端 | Python FastAPI + SQLAlchemy + MySQL |
| Web 前端 | 原生多页 HTML/CSS/JS + `core.js` 共享层 |
| AI | DeepSeek (OpenAI 兼容) + Resend (邮件) |
| 部署 | Docker Compose + Nginx |

---

## ✨ 功能全景

### 桌面应用

- **PPTE 编辑器**：页面目录 + HTML 编辑 + 实时预览 + 拖拽排序
- **AI 工作台**：终端流式界面，`@N` 定位页面，AI 自动改+校验+保存
- **播放模式**：全屏播放 + 键盘导航 + 演讲者模式（观众窗口）
- **批注**：画笔/高亮/文本标注（内存态，不修改课件）
- **PPTX 导出**：将 PPTE 转为可编辑 .pptx
- **AI 模型选择**：LectureAI（平台+SKILL）/ DeepSeek / MiniMax / 自定义

### Web 平台（11 个页面）

| 页面 | 功能 |
|---|---|
| 课件广场 | 公开课件浏览 + 在线播放 |
| 项目台 | 创建/上传/下载/管理 PPTE 项目 |
| 工作站 | 幻灯片 rail + 实时预览 + AI 生成 + 校验 + 快照 |
| AI 任务 | 任务列表 + 状态轮询 + 取消/重试 |
| 导出 | PPTE 直下 + PDF/PPTX 异步导出 |
| 设置 | LLM 配置 + 会员 + 模板 + 账号管理 |
| 管理后台 | 用户管理 + AI 任务监控 + 审计日志 + 运营日报 |
| 注册 + 邮箱验证 | Resend SMTP + JWT 验证 token |
| 演示账号 | 评审一键登录 |

---

## 🚀 安装与开发

### 安装包

| 平台 | 文件 |
|---|---|
| macOS (Apple Silicon) | `Lecture Presenter_0.1.0_aarch64.dmg` |
| Windows (x64) | `Lecture Presenter_0.1.0_x64-setup.exe` |

### 开发模式

```bash
cd lecture-app
npm install
npm run dev          # 启动桌面应用
npm run build        # 构建安装包
npm run test:ppte    # 运行 PPTE 测试
```

### 课件格式

详见 [COURSE_FORMAT.md](COURSE_FORMAT.md)。

---

## 📁 项目结构

```
lecture-presenter-public/
├── lecture-app/                 # 桌面应用
│   ├── src/                      # 前端 (HTML/CSS/JS)
│   │   ├── index.html            # 主界面
│   │   ├── workbench.html        # AI 工作台窗口（终端流式）
│   │   ├── audience.html         # 观众窗口
│   │   └── js/
│   │       ├── workbench-window.js   # 工作台 Agent（终端 + diff + 打字机）
│   │       ├── ppte-workbench-agent.js # 主窗口侧（工具执行 + RPC）
│   │       ├── ppte-rules-prompt.js   # PPTE 规范提示词 + linter
│   │       └── ...
│   └── src-tauri/
│       └── src/lib.rs            # Rust 后端（AI 命令 + slide:// 协议 + 文件 I/O）
├── .github/workflows/            # CI 构建（macOS + Windows）
├── COURSE_FORMAT.md              # PPTE 课件格式规范
└── docs/
    └── JUDGE_GUIDE.md            # 评委体验指南
```

---

## 📝 PPTE 排版规范（SKILL 核心，9 条）

1. **去讲师痕迹**：标题不写"开场""续""案例①"等
2. **全面书面化**：去掉口语词
3. **去破折号**：正文 `--` 用逗号/句号替代
4. **去句末句号**：段落末尾 `。` 去掉
5. **重点词高亮**：`<b style="color:#dc2626">` 红色加粗
6. **卡片统一边框**：禁止 border-left 彩条
7. **emoji 换 SVG**：图形 emoji 全用内联 SVG
8. **术语弹窗**：`<span class="term" data-popover-body>`
9. **全局覆盖样式集中**：`<style>` 末尾追加全局覆盖 CSS

---

## License

MIT
