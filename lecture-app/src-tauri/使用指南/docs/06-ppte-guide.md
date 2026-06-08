# PPTE 格式介绍

## 什么是 PPT-EXTRA？

**PPT-EXTRA（PPTE）** 是演讲宝独创的幻灯片格式。它使用一系列 HTML 文件模拟 PPT 的翻页效果，同时利用 Web 技术的强大能力实现传统 PPT 难以做到的视觉效果。

### 为什么选择 PPTE？

| 特性 | 传统 PPT | PPTE |
|------|----------|------|
| 视觉表现力 | 受模板限制 | CSS/HTML 无限可能 |
| 渐变与动画 | 基础 | CSS 动画、渐变、变换 |
| 代码展示 | 截图或纯文本 | 语法高亮、等宽字体 |
| 响应式 | 固定尺寸 | 自适应屏幕 |
| 版本控制 | 二进制文件 | 纯文本，可 Git 管理 |
| 创建方式 | 需要 PowerPoint | 文本编辑器 + AI 辅助 |

---

## 目录结构

一组 PPTE 幻灯片由一个目录组成，包含一个 `manifest.json` 和多个 HTML 文件：

```
ppt-extra/
└── my-slides/
    ├── manifest.json     # 必须 — 幻灯片清单
    ├── slide01.html      # 第一页
    ├── slide02.html      # 第二页
    ├── slide03.html      # 第三页
    └── assets/           # 可选 — 图片等资源
        └── logo.png
```

---

## manifest.json 格式

```json
{
  "title": "我的演示",
  "slides": [
    { "file": "slide01.html", "title": "封面" },
    { "file": "slide02.html", "title": "目录" },
    { "file": "slide03.html", "title": "第一章" }
  ]
}
```

| 字段 | 说明 |
|------|------|
| `title` | 幻灯片组的标题 |
| `slides` | 幻灯片列表，按显示顺序排列 |
| `slides[].file` | HTML 文件名（相对于当前目录） |
| `slides[].title` | 该页的标题（显示在导航栏） |

---

## HTML 页面规范

### 基础 CSS 模板

每个 HTML 页面应使用 16:9 比例的标准布局：

```css
html, body {
    margin: 0;
    padding: 0;
    width: 100vw;
    height: 100vh;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
}

.slide {
    width: min(100vw, 177.78vh);   /* 16:9 宽度 */
    height: min(100vh, 56.25vw);   /* 16:9 高度 */
    max-width: 100vw;
    max-height: 100vh;
    padding: 60px;
    box-sizing: border-box;
}
```

### HTML 基础结构

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>页面标题</title>
    <style>
        /* CSS 样式 */
    </style>
</head>
<body>
    <div class="slide">
        <!-- 页面内容 -->
    </div>
</body>
</html>
```

### 内容约束

为保证幻灯片的展示效果，请遵循以下约束：

1. **内容不超出** `.slide` 容器边界
2. **单页文字**不超过 15 行
3. **代码块**不超过 20 行
4. **图片高度**不超过容器的 80%
5. **不使用**外部链接跳转（`<a href="http://...">`）
6. **不包含**应用导航栏或工具栏元素

---

## 幻灯片类型

PPTE 没有严格的类型限制，但推荐使用以下常见类型：

### 1. 封面页（Cover）

用于展示演示的标题、副标题和作者信息。通常使用大字体和背景渐变。

### 2. 目录页（Catalog）

列出演示的主要章节或议程，帮助观众了解整体结构。

### 3. 章节页（Chapter）

标记一个新章节的开始，通常使用突出的视觉设计。

### 4. 内容页（Content）

承载具体内容，包括文字、列表、图片、代码块等。

### 5. 结尾页（Finish）

总结要点，致谢，或提供联系信息。

---

## 在 course.json 中引用 PPTE

在 `slides` 分类中，使用 `ppt-extra` 字段指定 PPTE 目录：

```json
"slides": [
    { "title": "互动演示", "ppt-extra": "ppt-extra/my-slides" }
]
```

> **提示**：PPTE 幻灯片通常放在 `slides` 分类中，但也可以放在其他分类中。

---

## 浏览 PPTE 幻灯片

在演讲宝中打开 PPTE 幻灯片后：

- **左右翻页**：点击页面左/右侧，或使用左/右方向键
- **查看页码**：底部显示当前页码和总页数
- **全屏模式**：自动适配窗口大小
