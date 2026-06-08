# course.json 格式说明

## 概述

`course.json` 是课程的核心配置文件，定义了课程的元数据和所有内容的组织结构。本文档详细说明其格式规范。

---

## 顶层字段

```json
{
  "id":         "my-course",
  "title":      "课程完整名称",
  "subtitle":   "机构或来源",
  "instructor": "讲师姓名",
  "weeks":      [ ... ]
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | 是 | 全局唯一标识符，只含字母、数字、连字符 |
| `title` | string | 是 | 显示在侧边栏顶部的课程名 |
| `subtitle` | string | 否 | 副标题，显示于课程名下方 |
| `instructor` | string | 否 | 讲师姓名 |
| `weeks` | array | 是 | 章节列表 |

> **提示**：`id` 建议使用小写英文和连字符，如 `deep-learning-101`、`lecture-presenter-guide`。

---

## weeks 数组

`weeks` 中每个元素代表一个章节。虽然字段名叫"weeks"（周），但你可以用它表示任何组织单位——模块、主题、课时等。

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
| `number` | integer | 章节编号，决定排列顺序，对应 `Cmd+数字` 快捷键 |
| `title` | string | 章节标题 |
| `description` | string | 章节描述，显示在内容区顶部 |
| `resources` | object | 五类资源，每类均为数组，可为空 `[]` |

> **注意**：`number` 字段在同一课程中必须唯一，建议从 1 开始连续编号。

---

## 资源条目

每个资源条目包含 `title` 字段，以及以下来源之一：

### 四种资源来源

| 来源字段 | 类型 | 行为 |
|----------|------|------|
| `file` | string | 相对路径。PDF 用内置查看器，MP4 用内置播放器，.md 用 Markdown 渲染器，代码文件用语法高亮查看器 |
| `url` | string | 外部链接，在系统默认浏览器中打开 |
| `dir` | string | 目录路径，在 Finder 中打开 |
| `ppt-extra` | string | PPTE 目录路径，使用内置 PPTE 查看器 |

> **重要**：所有路径都是**相对于课程根目录**的。

---

## 完整示例

以下是一个包含各种资源类型的完整课程配置示例：

```json
{
  "id": "python-basics",
  "title": "Python 编程基础",
  "subtitle": "入门教程",
  "instructor": "张老师",
  "weeks": [
    {
      "number": 1,
      "title": "环境搭建",
      "description": "安装 Python 和开发工具，编写第一个程序。",
      "resources": {
        "slides": [
          { "title": "第一讲课件", "file": "slides/week01.pdf" },
          { "title": "互动演示", "ppt-extra": "ppt-extra/week01" }
        ],
        "videos": [
          { "title": "安装教程", "file": "videos/install-python.mp4" }
        ],
        "readings": [
          { "title": "Python 官方文档", "url": "https://docs.python.org/3/" },
          { "title": "参考手册", "file": "pdfs/reference.pdf" }
        ],
        "assignments": [
          { "title": "作业一", "dir": "assignments/week1" }
        ],
        "sourceCode": [
          { "title": "Hello World", "file": "source_code/hello.py" }
        ]
      }
    },
    {
      "number": 2,
      "title": "数据类型与控制流",
      "description": "学习 Python 的基本数据类型、条件判断和循环。",
      "resources": {
        "slides": [
          { "title": "第二讲课件", "file": "slides/week02.pdf" }
        ],
        "videos": [],
        "readings": [],
        "assignments": [
          { "title": "作业二", "dir": "assignments/week2" }
        ],
        "sourceCode": [
          { "title": "数据类型示例", "file": "source_code/types_demo.py" }
        ]
      }
    }
  ]
}
```

---

## 常见问题

### Q: 资源分类可以为空吗？

可以。如果某个章节没有视频，将 `videos` 设为空数组 `[]` 即可。

### Q: 章节数量有限制吗？

没有硬性限制。但 `Cmd+数字` 快捷键仅支持 1-9，超过 9 个章节需通过侧边栏点击导航。

### Q: 一个资源可以同时有 file 和 url 吗？

不可以。每个资源条目只能指定一种来源（`file`、`url`、`dir` 或 `ppt-extra` 中的一种）。

### Q: 支持嵌套子目录吗？

支持。只要路径正确即可，例如 `"file": "materials/week1/slides/intro.pdf"`。

### Q: 如何验证 JSON 格式是否正确？

可以使用在线工具（如 jsonlint.com）验证 JSON 语法，或在代码编辑器中检查。演讲宝在导入时也会自动验证。
