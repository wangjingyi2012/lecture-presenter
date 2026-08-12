# LectureAI 整套课件规划与设计案例库

## 目标

LectureAI 在整套生成前先保存结构化课件蓝图，按页面语义检索真实设计案例，并在结束前运行整套校验，避免连续生成大卡片网格。同时保持旧 PPTE 零迁移可用。

## 数据流

```text
用户整套指令
  -> set_deck_plan
  -> search_design_examples
  -> read/write/insert/validate_slide
  -> validate_deck
  -> 修复未通过项
  -> 完成
```

“检查一下课件”属于整套任务，必须执行 `validate_deck`，但不强制创建规划。单页 `@N` 修改不强制规划。

## 兼容策略

- PPTE 核心仍是 `manifest.json + HTML + note`，没有格式迁移要求。
- 规划按需写入 `.lectureai/deck-plan.json`，旧客户端会直接忽略。
- 读取旧项目不会创建 `.lectureai`，也不会改写 manifest。
- 支持最老的字符串 slides 清单与对象 slides 清单。
- 规划损坏只返回 `invalid`，不影响播放、编辑或导出。
- Web 与桌面使用 `lectureai-deck-revision-v1` 同一指纹算法；固定测试向量防止双端误判 stale。
- Agent 确认写页后刷新规划基线，外部编辑不刷新，因此会正确标记 `stale`。
- 桌面规划保存使用临时文件、旧文件备份和失败恢复，兼容 Windows 覆盖语义。

## 新工具

- `set_deck_plan {plan}`
- `search_design_examples {content_kind?, layout_family?, density?, motion?, exclude?, limit?}`
- `validate_deck {}`

整套新建或大规模改造在页面写入前有规划门禁，最终总结前有校验门禁。整套校验把以下项目视为失败：结束页位置错误、目标页数不符、相邻主构图重复、正文布局少于六种、卡片类超过 25%、十二页以上动画/交互少于三页、任一页面存在硬性规范错误。

## 设计案例库

闭源 Web 后端维护 16 个首批案例，覆盖概念图解、类比、历史事件、横纵时间轴、动态图表、仪表盘、精确表格、前后对比、分层架构、关系网络、流程管线、终端、浏览器、章节转场和知识地图。

桌面不打包案例源码，通过登录后的 LectureAI 接口按需检索。Web 项目则通过项目级接口检索同一个案例库。

## 主要实现位置

### Lecture Web / LectureAI

- `backend/app/services/ai/deck_planning.py`
- `backend/app/services/ai/design_library.py`
- `backend/app/services/ai/design_library/catalog.json`
- `backend/app/services/ai/prompts/workbench_skill.md`
- `backend/app/api/ppte.py`
- `backend/app/api/chat.py`
- `frontend/app/workstation.html`
- `backend/tests/test_deck_planning.py`

### Lecture Presenter 桌面端

- `lecture-app/src-tauri/src/lib.rs`
- `lecture-app/src/js/ppte-workbench-agent.js`
- `lecture-app/src/js/workbench-window.js`
- `lecture-app/src-tauri/resources/prompts.source.txt`
- `lecture-app/src-tauri/resources/prompts.example.txt`
- `lecture-app/scripts/test-workbench-window.js`

## 验证

- Web：`.venv/bin/python -m pytest -q`，31 passed
- 桌面前端：全部 npm 测试脚本通过，包括 `test:workbench`
- Rust：`cargo test -q`，27 passed，2 ignored；Info.plist 测试通过
- Web 工作台内联 JavaScript 成功解析
- Python compileall、案例 JSON 校验、双仓库 `git diff --check` 通过

## 后续评测

需要在部署新 Web 后端并重启进程后，用真实 LectureAI 模型运行固定提示“创建一个15页的AI发展史课件”。验收最终15页、至少6种正文布局、卡片不超过25%、至少3页动画/交互、结束页最后、`validate_deck.passed=true`。Harness 通过 `lru_cache` 加载，修改提示后必须重启服务。
