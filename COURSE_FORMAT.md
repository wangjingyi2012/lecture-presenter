# 课程格式规范

本文档定义了 Lecture Presenter 桌面应用所支持的课程格式，供创建或导入新课程时参考。

---

## 目录结构

课程是一个**普通文件夹**，位置不限，应用通过绝对路径访问。推荐结构如下：

```
MyCourse/
├── course.json          # 必须，课程元数据与内容描述
├── slides/              # 课件（PDF）
├── videos/              # 视频（MP4）
├── pdfs/                # 阅读材料（PDF）
├── assignments/         # 作业目录
│   ├── week1/
│   └── week2/
├── source_code/         # 示例代码
└── ppt-extra/           # HTML 模拟 PPT（可选）
    └── week01/
        ├── manifest.json # 必须，幻灯片列表
        ├── slide01.html  # 第一页
        ├── slide02.html  # 第二页
        └── ...
```

> **PPT-EXTRA 格式**：使用一系列 HTML 文件模拟 PPT 翻页效果，适用于需要动画、交互或自定义布局的"课件"。学员无法意识到他们看的是 HTML。
```

子目录名称可自由命名，`course.json` 中所有路径均**相对于课程根目录**。

---

## course.json 格式

### 顶层字段

```json
{
  "id":         "my-course",
  "title":      "课程完整名称",
  "subtitle":   "机构或来源（如 Stanford University）",
  "instructor": "讲师姓名",
  "weeks":      [ ... ]
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | 是 | 全局唯一标识符，只含字母/数字/连字符，如 `lecture-presenter-guide` |
| `title` | string | 是 | 显示在侧边栏顶部的课程名 |
| `subtitle` | string | 否 | 副标题，显示于课程名下方 |
| `instructor` | string | 否 | 讲师姓名 |
| `weeks` | array | 是 | 章节列表，见下节 |

### weeks 数组

`weeks` 中每个元素代表一个**章节**（不限于"周"，可以是模块、主题等）：

```json
{
  "number":      1,
  "title":       "章节标题",
  "description": "该章节的简短描述。",
  "resources": {
    "slides":      [ ... ],
    "videos":      [ ... ],
    "readings":    [ ... ],
    "assignments": [ ... ],
    "sourceCode":  [ ... ]
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `number` | integer | 章节编号，决定排列顺序，同时对应 `Cmd+数字` 快捷键 |
| `title` | string | 章节标题 |
| `description` | string | 章节描述，显示在内容区顶部 |
| `resources` | object | 五类资源，每类均为数组，可为空 `[]` |

### 资源条目

每个资源条目包含 `title` 字段，以及以下**三种来源之一**：

| 来源字段 | 类型 | 行为 |
|----------|------|------|
| `file` | string | 相对于课程根目录的文件路径，`.pdf` 用内置查看器打开，`.mp4` 用内置播放器播放，其他文件用系统默认程序打开 |
| `url` | string | 外部链接，在系统默认浏览器中打开 |
| `dir` | string | 相对于课程根目录的目录路径，在 Finder 中打开 |
| `ppt-extra` | string | 相对于课程根目录的目录路径，该目录下包含多个 HTML 文件，模拟 PPT 翻页效果 |

**示例：**

```json
"slides": [
  { "title": "第一讲 介绍",  "file": "slides/lecture01.pdf" },
  { "title": "配套网页",      "url": "https://example.com/lecture1" }
],
"videos": [
  { "title": "课程录像",      "file": "videos/lecture01.mp4" }
],
"readings": [
  { "title": "参考论文",      "file": "pdfs/paper.pdf" },
  { "title": "在线文档",      "url": "https://docs.example.com" }
],
"assignments": [
  { "title": "作业一",        "dir": "assignments/week1" }
],
"sourceCode": [
  { "title": "示例代码",      "file": "source_code/demo.py" }
],
"ppt-extra": [
  { "title": "交互演示",      "dir": "ppt-extra/week01" }
]
```

---

## 完整 course.json 示例

```json
{
  "id": "my-course",
  "title": "深度学习基础",
  "subtitle": "自学课程",
  "instructor": "张三",
  "weeks": [
    {
      "number": 1,
      "title": "神经网络入门",
      "description": "介绍感知机、激活函数与反向传播的基本原理。",
      "resources": {
        "slides": [
          { "title": "第一讲课件", "file": "slides/week01.pdf" }
        ],
        "videos": [
          { "title": "3Blue1Brown - 神经网络", "url": "https://www.youtube.com/watch?v=aircAruvnKk" }
        ],
        "readings": [
          { "title": "Deep Learning Book 第 1 章", "url": "https://www.deeplearningbook.org/contents/intro.html" }
        ],
        "assignments": [
          { "title": "作业一：实现感知机", "dir": "assignments/week1" }
        ],
        "sourceCode": []
      }
    },
    {
      "number": 2,
      "title": "卷积神经网络",
      "description": "卷积操作、池化层与经典 CNN 架构。",
      "resources": {
        "slides": [
          { "title": "第二讲课件", "file": "slides/week02.pdf" }
        ],
        "videos": [],
        "readings": [
          { "title": "CS231n 课程笔记", "url": "https://cs231n.github.io/convolutional-networks/" }
        ],
        "assignments": [
          { "title": "作业二：实现 CNN", "dir": "assignments/week2" }
        ],
        "sourceCode": [
          { "title": "CNN 示例代码", "file": "source_code/cnn_demo.py" }
        ]
      }
    }
  ]
}
```

---

## PPT-EXTRA 格式

`ppt-extra` 是一种使用 HTML 文件模拟 PPT 翻页效果的格式。每个目录包含一个 `manifest.json` 和多个 HTML 文件。

### manifest.json 格式

```json
{
  "schemaVersion": 2,
  "deckId": "deck_唯一标识",
  "title": "演示标题",
  "slides": [
    { "id": "slide_第一页", "file": "slide01.html", "title": "第一页" },
    { "id": "slide_第二页", "file": "slide02.html", "title": "第二页" }
  ],
  "sharedGroups": [],
  "linkedGroups": []
}
```

`schemaVersion`、`deckId`、页面 `id`、`sharedGroups` 和 `linkedGroups` 由演讲宝在需要共享页面时自动维护。旧版只包含 `title` 和 `slides` 的 manifest 仍然兼容，不需要手工迁移。

### 课件母版信息（agentTemplate v2）

从模板中心创建的 PPTE 会在 manifest 中记录母版身份，并把原始角色页保存为不可变快照：

```json
{
  "agentTemplate": {
    "schemaVersion": 2,
    "template": {
      "id": "scholar-blue",
      "remoteId": null,
      "name": "学术蓝",
      "version": "1.0.0",
      "source": "builtin",
      "digest": "sha256:..."
    },
    "state": "starter",
    "roles": {
      "cover": {"blueprintFile": ".ppte-template/roles/cover.html", "starterFile": "slide01.html"},
      "catalog": {"blueprintFile": ".ppte-template/roles/catalog.html", "starterFile": "slide02.html"},
      "chapter": {"blueprintFile": ".ppte-template/roles/chapter.html", "starterFile": "slide03.html"},
      "content": [
        {"id": "text", "title": "要点正文", "blueprintFile": ".ppte-template/roles/content-text.html", "starterFile": "slide04.html"}
      ],
      "finish": {"blueprintFile": ".ppte-template/roles/finish.html", "starterFile": "slide05.html"}
    }
  }
}
```

- `source` 为 `builtin`、`custom` 或 `cloud`；云端模板的 `remoteId` 是模板中心记录 ID。
- `content` 可以有多个正文变体，助教通过稳定的变体 `id` 选择合适母版。
- `.ppte-template/roles/` 是助教新增页面时使用的原始母版，不会随普通页面编辑而变化。移动、压缩或备份 PPTE 时必须保留整个 `.ppte-template/` 目录；不要手工修改其中内容。
- 旧版 `agentTemplate` v1 和不含该字段的 PPTE 继续兼容。

### 课件母版模板包

可上传到模板中心的模板包使用以下结构：

```text
template-package/
├── template.json
├── preview.png              # 可选，建议 16:9
├── cover.html
├── catalog.html
├── chapter.html
├── content.html
├── content-visual.html      # 可选正文变体
├── finish.html
└── theme.css / images/...
```

`template.json` 的格式如下：

```json
{
  "schemaVersion": 1,
  "id": "my-course-template",
  "name": "我的课程模板",
  "version": "1.0.0",
  "description": "模板说明",
  "tags": ["教学", "简洁"],
  "roles": {
    "cover": "cover.html",
    "catalog": "catalog.html",
    "chapter": "chapter.html",
    "content": [
      {"id": "text", "file": "content.html", "title": "正文"},
      {"id": "visual", "file": "content-visual.html", "title": "图文"}
    ],
    "finish": "finish.html"
  }
}
```

角色 HTML 必须位于包根目录，`id` 和正文变体 `id` 使用 kebab-case。公开发布的模板只能包含被动 HTML/CSS、本地图片和 JSON：不能包含脚本、事件属性、表单、iframe、远程资源或 CSS `@import`。私有模板可以保留自己的脚本，但发布审核前必须移除主动内容。

### 共享页面组

编辑器支持把一张或连续多张页面设为共享真源，再插入其他 PPTE：

- 目标 PPTE 保存完整本地快照，源课件不可用时仍可播放和导出。
- 源内容变化后只显示更新提示，不会自动覆盖目标课件。
- 页面身份使用稳定 `id`，排序和文件改名不会改变引用关系。
- 快照保存在 `.ppte-links/<groupId>/snapshots/<contentHash>/`，该目录属于 PPTE 内容，移动或备份课件时必须一并保留。
- 链接页面默认只读。如需单独修改，应先在“共享页面”中断开引用。

不要手工修改 `.ppte-links` 中的文件。演讲宝会通过内容哈希识别本地改动或损坏。

### 资源中心拷贝目录

通过资源中心「拷贝插入」复用的页面保存在 `.ppte-copies/<copyId>/` 下，包含页面 HTML、笔记和所需的共享资源（CSS/图片等）。与 `.ppte-links` 不同，拷贝落地后与源课件再无关联，是目标课件普通可编辑的页面。

`.ppte-copies` 目录属于 PPTE 内容，移动或备份课件时必须一并保留，否则对应页面无法播放。可以手工编辑其中的文件（编辑器的修改也会直接写回这里），但不要手工移动或重命名。

### 章纲 outline.md

每个 PPTE 目录可以有一个可选的 `outline.md`：作者在写页面前手写的章纲（Markdown），记录章节顺序、每页主题与排版意图。编辑器顶部的「大纲」页签可直接编辑和预览它，保存走与页面相同的事务写入与冲突保护，Gitee 备份会一并提交。

章纲会作为 LectureAI 整套生成的规划输入（AI 按章纲排页面）。它不属于播放内容：资源中心拷贝、共享页面组快照和 PPTX 云端导出都不会包含它。

### HTML 页面约束

为保证模拟 PPT 的翻页效果，每个 HTML 页面应遵循以下约束：

1. **页面尺寸**：固定为 16:9 比例，推荐使用 CSS：
   ```css
   html, body {
     width: 100vw;
     height: 100vh;
     margin: 0;
     overflow: hidden;
     display: flex;
     align-items: center;
     justify-content: center;
   }
   .slide {
     width: min(100vw, 177.78vh);  /* 16:9 保持 */
     height: min(100vh, 56.25vw);
     max-width: 100vw;
     max-height: 100vh;
   }
   ```

2. **内容高度限制**：内容不应超出 `.slide` 容器，建议：
   - 单页文字不超过 15 行
   - 代码块不超过 20 行
   - 图片高度不超过容器 80%

3. **无顶部/底部栏**：HTML 页面不应包含应用的导航栏、工具栏，页面全屏显示

4. **禁止链接外跳**：不要在 HTML 中使用 `<a href="http://...">` 跳转外部链接

### 目录结构示例

```
ppt-extra/
└── week01/
    ├── manifest.json
    ├── slide01.html
    ├── slide02.html
    └── assets/
        └── diagram.png
```

### 在 course.json 中引用

```json
"ppt-extra": [
  { "title": "第一章：概述", "dir": "ppt-extra/week01" }
]
```

---

## 导入课程

在应用顶部工具栏点击 **`+`** 按钮，在弹出的文件夹选择对话框中选择包含 `course.json` 的课程根目录即可完成导入。

**导入要求：**
- 所选目录下必须存在 `course.json`
- `course.json` 中 `id` 字段不得与已导入的课程重复
- `course.json` 必须是合法的 JSON 格式，且包含 `id` 字段

---

## 课程管理

点击工具栏右侧的 **⚙ 按钮** → **管理课程**，可进行以下操作：

- **导入课程**：添加新课程
- **删除课程**：从列表中移除（不删除文件）
- **编辑课程**：修改课程标题
- **调整顺序**：拖拽课程卡片改变显示顺序

---

## PPTE 幻灯片编辑器

在课程管理界面中，每个资源卡片提供以下操作按钮：

| 按钮 | 功能 |
|------|------|
| **添加文件** | 选择文件（PDF、视频、代码等）添加为资源 |
| **添加文件夹** | 选择文件夹作为资源，可自动检测 PPT-EXTRA 格式 |
| **创建幻灯片** | 创建新的 PPT-EXTRA 幻灯片组（需输入名称） |
| **编辑** | 编辑 PPT-EXTRA 幻灯片结构（添加/删除/重排序页面） |

**编辑 PPTE 幻灯片时会隐藏侧边栏**，以提供更大的编辑空间。关闭编辑器后侧边栏自动恢复。

---

## 约束与说明

- `id` 必须在所有已导入课程中唯一
- `weeks[].number` 在同一课程中必须唯一，建议从 1 开始连续编号（`Cmd+1`～`Cmd+9` 快速跳转）
- 章节数量不限
- `resources` 下的六个分类（新增 `ppt-extra`）均可为空数组 `[]`
- 视频建议使用 `.mp4` 格式，其他格式未经充分测试
- 课程目录可放在磁盘任意位置，应用通过绝对路径访问
