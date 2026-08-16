# 模板制作索引

这里保存从优秀 PPTE 页面抽象出的候选模板预览。模板规则属于 LectureAI 服务端资产；本目录只用于结构确认、视觉验收和后续模板注册前的人工评审。

三套课件共 138 页的资产普查、缩略图总览和候选分类位于 [`页面资产普查/`](./页面资产普查/README.md)。

| 模板 ID | 中文名 | 版式族 | 来源页面 | 状态 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `agent-bridge-reveal` | 中心执行者桥接图 | `concept-bridge` | `MCP协议/slide05.html` | 待确认 | 已完成第一版预览；支持 1～4 个桥接实现和 3 段点击揭示 |
| `table-reference-catalog` | 参考目录型表格 | `table` | `MCP协议/slide13.html` | 待确认 | 对象 + 能力字段；适合工具清单、接口目录和资源索引 |
| `table-comparison-matrix` | 横向方案对比表 | `table` | `MCP协议/slide22.html` | 待确认 | 对比维度 + 多方案；适合协议、版本和技术路线选型 |
| `term-expansion-reveal` | 术语展开讲解页 | `concept-reveal` | `MCP协议/slide31.html` | 待确认 | 缩写/术语展开为全称和定义；终端、代码或流程示例为可选模块 |
| `flow-loop-orchestration` | 循环调度流程图 | `flow` | `MCP协议/slide34.html` | 待确认 | 思考 → 动作 → 结果回路；适合 Agent、反馈控制和多轮工具调用 |
| `flow-command-breakdown` | 复合命令拆解流程 | `flow` | `MCP协议/slide35.html` | 待确认 | 外层工具调用 + 命令内部多段拆解；适合脚本和流水线解释 |
| `image-attention-focus` | 图片注意力聚焦图 | `image-explanation` | `AI大模型原理_安恒/slide22.html` + `slide23.html` | 待确认 | 候选图片 → Query / Key / 权重 → Value；可合并两页讲解 |
| `image-filter-upload` | 图片资产处理流水线 | `image-workflow` | `MCP协议/slide33.html` | 待确认 | 混合图片池 → 条件筛选 → 统一处理 → 目标集合 → 结果交付 |
| `concept-story-progression` | 抽象概念分幕演进 | `concept-story` | `AI大模型原理_安恒/slide05.html` 等 4 页 | 已通过预览 | 样例 → 特征 → 机制 → 结论与边界；来源页均被标记为喜欢 |
| `architecture-zoom-path` | 架构总览到局部路径 | `architecture` | `AI大模型原理_安恒/slide24.html` 等 3 页 | 已通过预览 | 系统总览 → 核心层 → 支撑层 → 端到端路径 |
| `parameter-result-space` | 参数控制与结果空间 | `interactive-explanation` | `知识库搭建/slide18.html` | 已通过预览 | 控制参数同步改变中央空间和结果列表 |
| `key-message-evidence` | 核心结论与支撑依据 | `basic-content` | `知识库搭建/slide16.html` 等 | 已通过预览 | 一个核心结论 + 2～4 条直接依据 |
| `concept-definition-boundary` | 概念定义与适用边界 | `basic-content` | `知识库搭建/slide16.html` 等 | 已通过预览 | 单一术语 + 定义 + 属性 + 边界 |
| `structured-paragraph-aside` | 结构化段落与侧栏摘要 | `basic-content` | `Agent概念及基础开发/slide018.html` 等 | 已通过预览 | 2～3 段连续论述 + 可扫描摘要 |
| `numbered-key-points` | 编号要点清单 | `basic-content` | `Agent概念及基础开发/slide048.html` 等 | 已通过预览 | 3～6 个同层级原则、定义或能力 |
| `two-object-comparison` | 双对象逐项对照 | `basic-content` | `Agent概念及基础开发/slide037.html` | 已通过预览 | 两个对象沿相同维度严格配对比较 |
| `case-facts-conclusion` | 案例事实与分析结论 | `basic-content` | `Agent概念及基础开发/slide018.html` 等 | 已通过预览 | 事实、原因分析和可迁移经验分区 |

## 状态约定

- `待确认`：已抽象，等待视觉和叙事确认。
- `已通过预览`：本地预览和静态约束已通过，可进入服务端模板注册评审。
- `进入服务端`：已迁移到 LectureAI 私有模板库，客户端只接收渲染结果。

## 基础正文模板选型

基础模板默认静态、完整可读，用于承载课件主体内容；高动效模板只用于存在状态变化、空间关系或需要逐步推导的关键页面。

| 内容关系 | 优先模板 | 不应选择的情况 |
| --- | --- | --- |
| 一条主张需要事实或原则支撑 | `key-message-evidence` | 结论尚不明确，或依据存在严格顺序 |
| 第一次解释单个术语 | `concept-definition-boundary` | 概念必须通过多幕样例推导 |
| 必须保留连续背景或分析文字 | `structured-paragraph-aside` | 超过三段，或侧栏产生新的论述 |
| 3～6 个同层级要点 | `numbered-key-points` | 条目实际构成流程或时间线 |
| 两个对象按相同维度比较 | `two-object-comparison` | 三个以上对象，或左右维度不一致 |
| 一个案例支撑一条原则 | `case-facts-conclusion` | 重点是完整时间顺序或原始证据引用 |

同一套课件中应先根据内容关系选择模板，再检查前后页版式重复。基础页负责节奏和清晰度，复杂交互页负责重点与记忆点。
