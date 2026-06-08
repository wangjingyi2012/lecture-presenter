# PPT 课件 HTML 模板使用手册

本手册将以“Trae 开发工具教学课件”为例，详细说明如何使用和修改本套 HTML 模板来制作 PPT。

## 1. 模板概览

本套模板包含以下 5 种页面类型，每种页面对应一个 HTML 文件和 CSS 样式。

| 页面类型 | 对应文件 | 适用场景 | 背景图片 |
| :--- | :--- | :--- | :--- |
| **封面页** | `cover.html` | 整个课件的第一页，展示主标题和副标题。 | `AH-CoverTemplateBG.png` |
| **目录页** | `catalog.html` | 展示课程大纲，动态生成目录列表。 | `AH-CatalogTemplateBG.png` |
| **章节过渡页** | `chapter.html` | 每个大章节的起始页，展示章节序号、名称和简介。 | `AH-CommonPageTemplateBG.png` |
| **正文内容页** | `content.html` | 具体的教学内容页，包含标题和正文（文字、列表、图片等）。 | `AH-CommonPageTemplateBG.png` |
| **结束页** | `finish.html` | 整个课件的最后一页，无文字内容，仅展示背景。 | `AH-FinishTemplageBG.png` |

---

## 2. 页面修改指南 (以 Trae 教学课件为例)

### 2.1 封面页 (`cover.html`)

**修改目标**：设置课件的主标题和副标题。

**操作步骤**：
1.  打开 `cover.html`。
2.  找到 `<div class="main-title-area">` 区域。
3.  **【可替换】** 修改 `<h1>` 标签内容为主标题（例如：“Trae 智能开发工具”）。
4.  **【可替换】** 修改 `<h2>` 标签内容为副标题（例如：“从入门到精通”）。

```html
<!-- Main Content: Title -->
<div class="main-title-area">
    <h1 class="main-title">Trae 智能开发工具</h1> <!-- 修改这里 -->
    <h2 class="sub-title">从入门到精通</h2>     <!-- 修改这里 -->
</div>
```

---

### 2.2 目录页 (`catalog.html`)

**修改目标**：设置左上角的固定标题（通常为“课程导览”），并配置目录列表。

**操作步骤**：
1.  打开 `catalog.html`。
2.  **【一般不改】** 左上角的标题 `<h1 class="page-title">课程导览</h1>` 默认为“课程导览”，通常不需要修改。如果需要改为“Trae 课程大纲”，可在此处修改。
3.  **【重点修改】** 找到底部的 `<script>` 标签中的 `catalogData` 数组。
4.  根据你的章节数量，添加或删除数组对象。修改 `id` (序号) 和 `title` (章节名称)。

```javascript
// 目录数据配置
const catalogData = [
    { id: '01', title: 'Trae 的介绍与安装' }, // 修改这里
    { id: '02', title: '基础使用指南' },     // 修改这里
    { id: '03', title: '进阶开发技巧' }      // 修改这里
];
```

*注意：无需手动编写 HTML 列表，脚本会自动根据上述数据生成目录项。*

---

### 2.3 章节过渡页 (`chapter.html`)

**修改目标**：作为每个大章节（如“Trae 的介绍”）的开始页面。

**操作步骤**：
1.  复制 `chapter.html` 文件（例如命名为 `chapter1.html`, `chapter2.html` 等）。
2.  打开文件，找到 `<div class="chapter-content">` 区域。
3.  **【可替换】** 修改 `.part-number` 内容为章节序号（例如 `Part01`）。
4.  **【可替换】** 修改 `.chapter-title` 内容为章节名称（例如 `Trae 的介绍与安装`）。
5.  **【可替换】** 修改 `.chapter-desc` 内容为章节简介（建议 20-30 字）。

```html
<div class="chapter-content">
    <div class="part-number">Part01</div> <!-- 修改章节序号 -->
    <h1 class="chapter-title">Trae 的介绍与安装</h1> <!-- 修改章节名称 -->
    <p class="chapter-desc">本章将介绍 Trae 的核心优势、下载安装步骤以及首次配置流程。</p> <!-- 修改简介 -->
</div>
```

---

### 2.4 正文内容页 (`content.html`)

**修改目标**：编写具体的教学内容。这是课件中数量最多的页面。

**操作步骤**：
1.  复制 `content.html` 文件（建议按内容命名，如 `p1_intro.html`, `p2_features.html` 等）。
2.  打开文件。
3.  **【可替换】** 修改左上角的 `.page-title` 为**本页 PPT 的标题**（注意：这里不是课程总标题，而是当前页面的主题，例如“Trae 的核心功能”）。

```html
<!-- 页面标题 -->
<div class="page-header">
    <h1 class="page-title">Trae 的核心功能</h1> <!-- 修改本页标题 -->
</div>
```

4.  **【可替换】** 在 `.content-area` 区域内编写正文内容。
    *   **限制**：内容必须位于 `.content-area` 标签内部。
    *   **范围**：内容区域已限制在上下两条横线之间（`top: 100px`, `bottom: 60px`），请确保内容不要过多，以免被截断。如果内容过多，请拆分为两页。
    *   **格式**：可以使用 `<h2>` (小标题), `<p>` (段落), `<ul>/<li>` (列表), `<img>` (图片) 等标准 HTML 标签。

```html
<!-- 内容区域 -->
<div class="content-area">
    <h2>代码智能补全</h2>
    <p>Trae 内置了强大的 AI 模型，能够根据上下文自动补全代码...</p>
    <ul>
        <li>支持多种编程语言</li>
        <li>上下文感知能力强</li>
    </ul>
    <!-- 可以在这里插入图片，注意控制图片大小 -->
    <!-- <img src="demo.png" style="width: 80%; margin: 20px auto; display: block;"> -->
</div>
```

---

### 2.5 结束页 (`finish.html`)

**修改目标**：展示结束画面。

**操作步骤**：
1.  该页面仅展示背景图 `AH-FinishTemplageBG.png`，**不需要修改任何代码**。
2.  直接使用即可。

---

## 3. 样式调整 (高级)

如果需要统一调整样式（如字体大小、颜色、位置），请修改对应的 CSS 文件：

-   `style.css` -> 封面页样式
-   `catalog.css` -> 目录页样式
-   `chapter.css` -> 章节过渡页样式
-   `content.css` -> 正文页样式
-   `finish.css` -> 结束页样式

**常见调整项**：
-   **正文页标题位置**：在 `content.css` 中找到 `.page-header`，调整 `top` 值（当前为 `20px`）。
-   **正文区域范围**：在 `content.css` 中找到 `.content-area`，调整 `top` (顶部边界) 和 `bottom` (底部边界)。
