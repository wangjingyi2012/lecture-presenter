# AI 助手外接 SKILL

演讲宝把能力分成两层：

- `/layout-check`、`/student-copy`、`/concept-animate` 等是应用内置命令
- `$skill-name` 是用户从 Codex、Claude Code 或第三方导入的外接工作流
- `@3` 用于限定页面

示例：

```text
@3 $security-course /layout-check 优化这一页
```

## 导入

在 AI 工作台点击“导入 SKILL”，可以选择：

1. 单个技能目录：目录内直接包含 `SKILL.md`
2. Agent 的 skills 根目录：目录下包含多个各自带 `SKILL.md` 的子目录

因此可以直接选择 Codex 的 `~/.codex/skills`、Claude Code 的 `~/.claude/skills`，或其他遵循同一目录结构的技能库。导入成功后输入 `$` 即可搜索和启用。

导入目标是演讲宝应用数据目录的 `skills/<skill-name>/`。同名技能不会被静默覆盖。

当前课件仍可携带课件专属技能：

```text
<PPTE>/.lectureai/skills/<skill-name>/SKILL.md
```

课件专属技能优先于用户全局导入的同名技能。

## 标准结构

```text
skill-name/
├── SKILL.md
├── agents/           # 可保留其他 Agent 的 UI 元数据
├── references/       # 按需读取的资料
├── scripts/          # 随包导入，但演讲宝不会自动执行
└── assets/           # 随包导入，不自动注入上下文
```

`SKILL.md` 必须包含标准 frontmatter：

```markdown
---
name: skill-name
description: 说明技能做什么，以及什么情况下应当使用
---

# Skill Name

1. 执行步骤
2. 判断标准
3. 验证要求
```

名称只能包含小写字母、数字和连字符，最长 64 字符。

## 安全边界

- 导入时复制文件，不直接依赖原 Agent 目录
- 拒绝符号链接、绝对路径和 `..` 越界
- 单个技能最多 2000 个文件、50MB，单文件最多 20MB
- `SKILL.md` 最大 128KB，模型按需读取的附加文本最大 256KB
- `scripts/` 只作为技能资料导入，第一版不会自动执行
- 页面写入继续经过 PPTE 编辑器的冲突检测和原子保存

内置斜杠命令不再以可导出的 `SKILL.md` 目录随应用分发。不过桌面客户端本身不是 DRM；必须严格保密的商业规则应放在 LectureAI 服务端。
