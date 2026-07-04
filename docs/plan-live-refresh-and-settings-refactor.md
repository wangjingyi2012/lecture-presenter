# 实施方案:PPTE 数据安全(防覆盖 + 实时刷新 + Gitee 备份)+ settings.js 拆分

> 状态:已实施并收尾(2026-07-05)
> 作者:结对讨论产出,供作者研究数日后再动手
> 范围:仅 `lecture-presenter-public`(desktop 开源仓库)。反馈 5(AI 生成)归 `lecture-presenter-public-web`,本方案不涉及。

> **收尾结论(2026-07-05)**:本轮已完成 PPTE 数据安全主线、防覆盖、实时刷新、Gitee 手动备份、settings 拆分和一轮低风险界面整理。当前版本已多轮打包覆盖到 `/Applications/Lecture Presenter.app` 进行人工试用,用户准备进入正式使用和深度测试阶段。全局资源中心、模板机制增强和 LectureAI 生成入口后续另起计划。

## 实施摘要(2026-07-05)

本轮实际交付:

- **保存防覆盖**:PPTE 保存引入磁盘状态校验,保存冲突时不再静默覆盖外部改动;编辑器只保存 dirty slide,降低误覆盖范围。
- **实时刷新**:播放器和编辑器接入 PPTE 文件夹监听,外部改动可触发刷新;播放器增加手动刷新入口作为兜底。
- **Gitee 备份**:Gitee Token 存入系统钥匙串;支持创建私有仓库、初始化 Git、手动一键备份;已有 Git 仓库优先沿用原仓库;Gitee SSH origin 自动转 HTTPS;Token 不写入 `.git/config`。
- **PPTE 创建修正**:新建 PPTE 时同步创建空 `.note` 文件,与 web 端 PPTE 结构对齐。
- **settings 拆分**:`settings.js` 已瘦身,AI 配置、Gitee 配置、开发者设置、PPTE 最近记录、PPTE 编辑器、PPTE 创建流程拆入独立文件。
- **界面整理**:增加 PPTE 工作台入口;整理 PPTE 工作台、课程资源列表、左侧章节列表、PPTE 编辑器顶部工具区、播放器控制按钮和设置页表单视觉。
- **局部资源面板**:已实现当前 PPTE 内资源查看/导入/复制路径/打开文件夹。注意:这不是用户设想的“全局资源中心”,后续需要重新设计。

本轮验证:

- `node --check lecture-app/src/js/content.js`
- `node --check lecture-app/src/js/settings.js`
- `node --check lecture-app/src/js/ppte-editor.js`
- `npm run test:ppte`
- `npm run test:annotator`
- `cargo check`
- `cargo test`
- `npm run build`

延期到下一轮:

- **全局资源中心**:跨所有 Lecture 课程、PPTE、文件的统一资源检索与管理。
- **模板系统开放机制**:用户模板目录、模板导入/管理、桌面端模板选择体验。
- **LectureAI 生成入口**:desktop 仅作为落地容器,生成能力仍应在 web/API 稳定后再接入。
- **PPTE 编辑器深改**:可视化编辑、AI 助手、资源面板、预览区的统一编辑工作台。
- **播放器/演讲模式深改**:当前保持稳定优先,正式使用一轮后再调整。

> **贯穿主线:PPTE 永不丢失。** 本方案的三件核心事——防覆盖(第 2 章)、实时刷新(第 2 章)、Gitee 备份(第 4 章)——是同一个目标的三层防线:
> - **第一层 防覆盖**:desktop 保存不再静默抹掉外部改动(防"自己人误伤")。
> - **第二层 实时刷新**:外部改动实时可见(防"看到旧内容误判")。
> - **第三层 Gitee 远程备份**:本地整个被误删也能回退(防"脚本/误操作删库"——真实发生过:一次 Claude Code 脚本误删了汇报用 PPTE 且本地无法恢复,险些搞砸汇报)。

---

## 0. 背景与战略定位(先读这段)

经讨论确认的产品分工:

- **开源 desktop(本仓库)= 编辑器 + 呈现器**。把「编辑 + 播放」外壳做到极致好用,并成为 web 生成结果的最佳落地容器。
- **闭源 web(LectureAI)= 生成大脑**。大纲→多页 PPTE、风格/模板的高质量内容能力,作为护城河,通过 API 授权,别人能用不能改。
- 两端共用同一 PPTE 文件夹格式(`manifest.json` + `slide*.html` + `.note` + 资源),可互相打开。

因此本仓库的优化 = 把编辑/播放体验拉满,**不泄露核心生成能力**。

五个用户反馈的归属:

| 反馈 | 性质 | 归属 | 本方案是否覆盖 |
|---|---|---|---|
| 2 动态刷新不稳定 + **保存覆盖 Claude Code 改动** | 🔴 真 bug / 数据丢失 | desktop 核心 | ✅ 本方案主体(第 1、2 章) |
| **PPTE 被误删无法恢复(作者亲历)** | 🔴 数据丢失 | desktop 核心 | ✅ 本方案(第 4 章 Gitee 备份) |
| settings.js 2750 行失控 | 🟡 可维护性 | desktop | ✅ 本方案(第 3 章),与上面顺带一起改 |
| 3 缺统一资源管理 | 🟡 编辑体验 | desktop | 🔜 后续方案(第 5 章仅列方向) |
| 1 编辑按钮太小 / 菜单奇怪 | 🟡 UX | desktop | 🔜 后续(第 5 章仅列方向) |
| 4 模板太少 / 不能改 | 🟢 机制开源、内容闭源 | 跨仓库 | 🔜 后续(第 5 章仅列方向) |
| 5 拿软件≠能做课件 | 🔵 产品定位 | **web** | ❌ 不在本仓库 |

本方案聚焦要动源码的四件事:**防覆盖(写)、实时刷新(读)、Gitee 备份、settings 拆分**。

---

## 1. 反馈 2 的根因分析(已通过读码确认)

反馈 2 实际是**两个方向**的问题,严重程度不同。

### 1.1 读方向:改了 HTML,播放器不刷新

**现象**:Claude Code 改了某 slide 的 HTML,desktop 播放器里看到的还是旧内容;有时按左右键切页重进就刷新,有时要退出软件重进。

**根因**(见 `js/ppt-extra-viewer.js`):
- 全仓库**没有任何文件监听**(`grep -i watch` 在 `lib.rs` 零命中)。播放器只在「切页时重新给 iframe 赋 `src`/`srcdoc`」时才会重新加载。
- **平台不一致**导致「有时要重启」:
  - **macOS WebKit**:走 `slide://localhost/<abs-path>` 协议(`ppt-extra-viewer.js:342` `frame.src = slideUrl`)。同一个 URL,WebKit 会**缓存**,切回同页不强制刷新就读旧内容 → 表现为「要退出重进」。
  - **Windows WebView2**:走 `srcdoc`(`_loadSlideFrame` 里 `frame.srcdoc = html`),每次都是重新读盘的新内容 → 反而不容易复现。
- 「按左右键重进能刷新」是因为切走再切回会重新赋值 iframe;但由于上面的缓存,macOS 上不总是生效。

### 1.2 写方向:保存覆盖了 Claude Code 的改动(更危险,静默数据丢失)

**现象**:在 desktop 的 PPTE 编辑器里打开某 PPTE,期间在 Claude Code 改了同一个 slide 文件,回到 desktop 一保存,**Claude Code 的改动被 desktop 内存里的旧内容整包覆盖**。

**根因**(见 `js/settings.js` 的 `_pptBuilder` + `src-tauri/src/lib.rs` 的 `save_ppt_extra`):

1. 打开编辑器时(`settings.js:_openPptBuilder`),把每个 slide 的内容**一次性读进内存**副本 `pb.slides[].content`(读盘发生在打开那一刻)。
2. **没有任何 dirty / mtime / version 概念**(`grep -iE 'dirty|mtime|version'` 在编辑相关代码零命中)。
3. 保存时(`settings.js:_savePptExtra` → `invoke('save_ppt_extra', ...)`)把**整个内存副本**通过 `save_ppt_extra` **无条件整包覆盖写回磁盘**(`lib.rs:1268` `fs::write` 逐个覆盖,连你没编辑过的 slide 也一起覆盖)。

这是典型的 **last-write-wins 静默覆盖**。危害:
- 你在编辑器打开的这段时间里,任何外部对这些文件的修改(Claude Code、手动改、git 切分支)都会在下次保存时被悄无声息地抹掉。
- 因为是**整包写**,不是「只写我改过的那几个 slide」,受影响面比想象的大。

> **结论**:1.2 比 1.1 严重得多。1.1 只是看到旧内容(刷新一下就好);1.2 是**真丢数据且无提示**。方案必须优先解决 1.2。

---

## 2. 方案:实时刷新 + 防覆盖

分成四个可独立交付的改动块。建议顺序:2.1 → 2.2 → 2.3 → 2.4。每块结束都能编译、能测、能单独提交。

### 2.1 【最高优先】保存前的「磁盘变更检测」——堵住数据丢失

**目标**:保存时,如果磁盘上的文件在编辑器打开之后被外部改动过,**不静默覆盖**,而是提示用户选择(保留磁盘版本 / 用编辑器版本覆盖 / 取消)。

**设计(基于文件 mtime,简单可靠,不需要文件监听)**:

后端(`lib.rs`):
- 新增 command `fn stat_files(paths: Vec<String>) -> Result<Vec<FileStat>, String>`,返回每个文件的 `mtime`(秒或毫秒时间戳)与是否存在。`FileStat { path, exists, mtime_ms }`。
- 修改 `save_ppt_extra`:增加一个可选入参 `expected_mtimes: Option<Vec<(String, i64)>>`(文件名 → 打开/上次保存时记录的 mtime)。写盘前对每个待写文件重新 stat:
  - 若磁盘 mtime **大于** `expected`(说明被外部改过)→ **不写该文件**,收集到 `conflicts: Vec<String>` 一并返回给前端,由前端决定。
  - 为保持后端简单,后端只做「检测 + 拒绝冲突文件」,**决策留给前端**(见下)。返回结构改为 `Result<SaveResult, String>`,`SaveResult { saved: Vec<String>, conflicts: Vec<String> }`。
  - ⚠️ 兼容性:`save_ppt_extra` 有 6+ 处调用,改签名要么全改,要么新增 `expected_mtimes` 为 `Option` 默认 `None`(=旧行为,无检测)。**推荐新增可选参数**,老调用点保持行为不变,只有 PPTE 编辑器的保存路径传入 mtime。

前端(编辑器,`settings.js` → 拆分后见第 3 章):
- 打开编辑器读盘时,同时通过 `stat_files` 记录每个 slide 的 `mtime`,存入 `pb.slides[].diskMtime`。
- 保存时把 `(file, diskMtime)` 作为 `expected_mtimes` 传给 `save_ppt_extra`。
- 若返回 `conflicts` 非空 → 弹一个明确的对话框(中文 UI):
  - 「以下文件在编辑期间被外部修改过:<列表>。」
  - 三个选项:**保留磁盘版本(放弃我的修改)** / **用我的版本覆盖** / **取消保存**。
  - 若选「用我的版本覆盖」→ 再次调用 `save_ppt_extra`,这次对冲突文件传 `expected_mtimes = None`(强制写)。
  - 若选「保留磁盘版本」→ 对冲突文件重新 `read_text_file` 刷新内存副本 + iframe,丢弃编辑器改动。
- 保存成功后,用新的磁盘 mtime 更新 `pb.slides[].diskMtime`(下次比较的基线)。

**只改我编辑过的 slide(顺带修一个隐患)**:
- 给内存副本加 `dirty` 标记(编辑器里真正改动过内容才置 true)。
- 保存时只把 `dirty === true` 的 slide 放进 `slideFiles`。未编辑的 slide 不再参与整包覆盖,从根本上缩小误覆盖面。
- 这一步和「mtime 检测」是两道独立防线,建议都做。

**测试**:
- 扩展现有 `scripts/` 下的 node 测试思路,新增 `scripts/test-save-conflict.js`,纯逻辑单测:给定 `expected_mtimes` 与模拟磁盘 mtime,断言 `conflicts` 计算正确。
- 手动验收:打开编辑器 → 用外部编辑器改同一 slide → 在 desktop 保存 → 必须弹冲突框,不能静默覆盖。

### 2.2 【高优先】读方向:文件监听 + 破缓存刷新

**目标**:外部改了当前正在看/编辑的 slide,desktop **自动**刷新对应 iframe,无需手动切页或重启。

**后端(`lib.rs`,引入 `notify` crate)**:
- 新增 command `fn watch_ppte_folder(folder_path: String) -> Result<(), String>`,用 `notify`(Tauri 生态常用,跨平台)监听该 PPTE 目录。
- 文件变化时,通过 Tauri event 向前端 `emit` 一个 `ppte-file-changed` 事件,payload = 变化的文件名列表(去抖 ~300ms 合并连续写入)。
- 新增 `fn unwatch_ppte_folder(...)`,离开编辑器/播放器时停止监听,避免泄漏。
- 依赖:`Cargo.toml` 加 `notify = "6"`(确认与 Tauri 2 兼容的版本)。注意 macOS FSEvents 的路径大小写与符号链接行为,测试时留意。

**前端(播放器 `ppt-extra-viewer.js` + 编辑器)**:
- 进入 PPTE 时 `invoke('watch_ppte_folder', {folderPath})`,监听 `ppte-file-changed`。
- 收到事件:
  - 若变化文件 == 当前显示的 slide → **重新加载当前 iframe**。
  - **破缓存关键**:macOS 走 `slide://` 路径时,reload 的 URL 追加 `?t=<mtime 或递增计数>`(不能用 `Date.now()`,前面已知随机/时间在某些执行环境受限——用后端返回的 mtime 或前端维护的递增整数)。这样 WebKit 不会命中旧缓存。Windows 走 `srcdoc` 的路径本就每次重读,追加参数无害。
  - 若变化文件是当前编辑器打开但**未 dirty** 的 slide → 直接刷新内存副本 + 预览(安全,无冲突)。
  - 若变化文件是当前编辑器打开且 **已 dirty** 的 slide → **不自动覆盖**,顶部显示一条非阻塞提示条:「此文件已被外部修改,点击查看差异 / 重新载入」,交给用户决定(与 2.1 的冲突处理复用同一套 UI)。
- 离开时 `unwatch_ppte_folder` + 移除事件监听。

**为什么不用 watch 代替 2.1 的 mtime 检测**:watch 有平台差异、可能漏事件、编辑器打开前的改动它抓不到。2.1 的「保存前 stat」是保存那一刻的**权威兜底**,两者互补:watch 负责「实时体验」,mtime 负责「保存正确性」。

**测试**:
- 手动:`npm run dev` 打开一个 PPTE 播放 → 外部改 slide → 观察是否自动刷新(macOS 重点验破缓存)。
- `scripts/test-ppt-extra-viewer.js` 已覆盖 URL/平台逻辑,新增用例断言「reload URL 带破缓存参数且仍是合法 slide:// 路径 / srcdoc」。

### 2.3 【中】统一「刷新当前 slide」的入口

现在切页赋值 iframe 的逻辑散落在 `_loadSlide` / `updateSpeakerView`(三处 iframe:主、speaker-current、speaker-next)。趁改动抽一个 `_reloadFrame(frame, index, {bustCache})` 私有方法,让「切页」「watch 触发」「冲突后重载」共用一条路径,减少三处不一致(平台分支现在是复制粘贴的,见 `ppt-extra-viewer.js:223/246/258`)。纯重构,不改行为,配合 2.2 一起做最省事。

### 2.4 【低】一个手动「刷新」按钮(兜底)

即使 watch 万一在某平台失灵,给播放器/编辑器头部加一个「⟳ 刷新」按钮,手动触发 2.3 的 `_reloadFrame(..., {bustCache:true})`。成本极低,用户心理兜底。

---

## 3. settings.js 拆分(2750 行 → 多个聚焦模块)

**动机**:`settings.js` 2750 行,是第二大文件(935)的 3 倍,远超作者自己的规范(800 上限)。它塞了至少 6 个不相干职责,且本方案 2.1/2.2 的编辑器保存改动**正好落在这个文件里**,趁机拆分,避免在巨型文件里动刀。

**当前 settings.js 承担的职责(读码归纳)**:
1. PPTE 列表 / 最近打开记录(`loadPpteList` / `renderPpteList` / `_loadRecentPpte` / `_addRecentPpte` / `_openRecentPpte` / `_deleteRecentPpte`)
2. 主题 / 字号 / 外观(`applyTheme` / `applyFontSize`)
3. 课程选择器(`initCourseSelect` / `refreshCourseOptions`)
4. 关于弹窗 / 开发者设置(`initAboutModal` / `initDevSettings`)
5. AI provider 配置(deepseek/minimax/lectureai/custom 的 UI 与保存)
6. **PPTE 编辑器 `_pptBuilder`**(占了最大篇幅,约 857 行起到文件末尾)—— 这是 2.1/2.2 要改的部分

**拆分目标(每个 200–400 行)**:

| 新文件 | 内容 | 备注 |
|---|---|---|
| `js/settings.js`(瘦身后) | 只留「设置面板」本体:主题/字号/课程选择/关于/开发者设置的装配 | 目标 < 500 行 |
| `js/ai-settings.js` | AI provider 配置 UI 与持久化(职责 5) | 与 web/LectureAI 对接点集中于此 |
| `js/ppte-recent.js` | 最近打开的 PPTE 记录(职责 1) | 纯数据 + 渲染 |
| `js/ppte-editor.js` | `_pptBuilder` 整套 PPTE 编辑器(职责 6) | **2.1/2.2 的保存/冲突逻辑落在这里** |

**拆分纪律(重要,避免翻车)**:
- 这是**纯搬迁重构,不改行为**。一次搬一个职责,搬完 `npm run dev` 冒烟一次再搬下一个。
- 保持现有「每个文件一个全局对象、无模块」的约定(见 CLAUDE.md);新文件同样是 `const AiSettings = {...}` 挂全局,在 `index.html` 的 `<script>` 里按依赖顺序加载。
- 注意 `settings.js` 与 `course-creator.js` **都有 `_pptBuilder`**(两处独立副本,见 grep 结果)。拆分时要搞清楚这两个编辑器入口的关系,避免把逻辑合错。**这一步开工前需单独确认**(见第 6 章待确认项)。
- 拆分前先跑一遍 `git grep` 确认没有其它文件直接引用 `Settings._pptBuilder` 之类的私有成员。

**顺序建议**:先做第 2 章的功能改动(在现有 settings.js 里把编辑器保存逻辑改对),**功能验证通过后再拆文件**。或者反过来:先把 `ppte-editor.js` 拆出来,再在干净的小文件里做 2.1/2.2。两种都行,取决于你更怕「在大文件里改」还是「边改边搬」。**推荐:先拆出 `ppte-editor.js`,再在其中实现防覆盖**——小文件里动刀更安全。

---

## 4. Gitee 远程备份(第三层防线:本地被误删也能回退)

### 4.0 动机(真实事故)
作者曾在汇报前 2 小时,因 Claude Code 一个脚本误操作删除了汇报用 PPTE,且本地无法恢复,险些搞砸汇报。此后的应对是「所有 PPTE 都放 Git」。本功能把这个应对**内置成一键流程**:创建 PPTE 时可选择同步到 Gitee 私有仓库,本地整个目录被误删也能从远程回退。

这是「PPTE 永不丢失」主线的**最后一道防线**,和第 2 章(防覆盖/防误判)互补:第 2 章防"改错",第 4 章防"删没"。

### 4.1 已确认的设计决策(讨论产出)
| 维度 | 决策 | 理由 |
|---|---|---|
| **同步时机** | **手动一键同步**(不自动提交) | 最可控,不会把半成品或"覆盖了外部改动的内容"意外推上去;与第 2 章的谨慎一致 |
| **git 实现** | **系统 git CLI**(经 `tauri-plugin-shell` 调用) | git 2.50 已确认可用;复用用户机器已有 git 认证配置;比内置 git 库简单 |
| **建仓方式** | **Gitee REST API**(复用现有 `reqwest`) | 无需新增 http 依赖;只用 API 建私有仓,推送走 git CLI |
| **Token 存储** | **系统钥匙串**(Tauri keyring 插件) | 绝不硬编码、绝不入开源代码;顺带把现有 AI api_key 明文存储问题一并升级 |

### 4.2 关键安全红线(必须遵守)
- **Token 绝不进源码、绝不进 app config 明文、绝不进任何提交**。作者已明确点出:内置自己的 token 会在发布时泄露 → 必须做成**用户自填的配置项 + 系统钥匙串存储**。
- 开源仓库里只有"读钥匙串取 token"的代码,没有任何 token 值。
- 推送 URL 里若需带 token(`https://<token>@gitee.com/...`),**只在内存中拼接传给 git 子进程,不写入 `.git/config`**(否则 token 会落盘到仓库配置)。优先用 git 的 credential helper 或 `-c` 临时注入,避免持久化。

### 4.3 前端流程(创建 PPTE 时)
1. 现有"创建 PPTE"流程(`course-creator.js` / `settings.js` 的 `create_ppt_extra` 链路)增加一步询问:**「是否同步到 Gitee 私有仓库?」**
   - 若设置里**没配 Gitee token** → 该选项灰掉,提示"请先在设置中配置 Gitee Token"。
2. 若用户选是:
   - 后端**静默**创建同名私有仓库(见 4.4),失败则给出清晰错误(仓库重名 / token 无效 / 无网络),不阻塞 PPTE 本地创建。
   - 本地 `git init`(若尚未是仓库)、写一份合适的 `.gitignore`、关联 remote、首次 commit + push。
   - 把「PPTE 目录 ↔ Gitee 仓库」的关联信息记录到该 PPTE 的元数据(见 4.5)。
3. 已关联的 PPTE,在编辑器/管理界面显示一个**「⤴ 备份到 Gitee」按钮**:点一下 = `git add -A && git commit -m "<时间戳/自动信息> && git push`。这就是"手动一键同步"。
   - commit message 不能用 `Date.now()`(脚本环境受限)——由后端 Rust 侧取系统时间生成,或让用户可编辑。

### 4.4 后端新增 command(`lib.rs`,或拆到新 `git_backup.rs` 模块)
- `gitee_create_repo(name, private=true) -> Result<RepoInfo, String>`:调 Gitee REST API `POST /api/v5/user/repos`(token 从钥匙串取,不作为参数从前端传)。返回 clone/remote URL。
- `ppte_git_init_and_push(folder_path, remote_url) -> Result<(), String>`:经 shell 依次跑 `git init` / 写 `.gitignore` / `git add` / `git commit` / `git remote add` / `git push -u`。token 注入见 4.2 红线。
- `ppte_git_sync(folder_path, message) -> Result<SyncResult, String>`:`git add -A` → 若有变更则 `commit` → `push`。返回是否有变更/推送成功。
- `gitee_token_set(token)` / `gitee_token_get() -> bool(是否已配置,不回传明文)` / `gitee_token_clear()`:钥匙串读写。**注意:绝不提供把 token 明文回传前端的 command**,前端只需知道"配没配"。
- 依赖:新增 keyring 插件(如 `keyring` crate 或 Tauri 社区 stronghold/keyring 方案,需确认与 Tauri 2 兼容)。git 走已有 `tauri-plugin-shell`。Gitee API 走已有 `reqwest`。

### 4.5 PPTE ↔ 仓库关联信息存哪
- 方案 A:存进该 PPTE 的 `manifest.json`(加 `gitee: { repo, remote }` 字段)。优点:跟着 PPTE 走,拷到别的机器也在;缺点:改了共享格式,需确认不破坏 web 端 Compatibility Contract(web README 明确会剥离非法字段,新增字段要确认不被误删)。
- 方案 B:存进 app config,以 folderPath 为 key 记录关联。优点:不碰 PPTE 格式;缺点:换机器/移动目录会丢关联。
- **待你拍板**(见第 6 章)。倾向 A,但需先验证 web 端不会剥掉该字段。

### 4.6 `.gitignore` 与"别把敏感物推上去"
- 自动生成的 PPTE 仓库 `.gitignore` 至少排除:`.DS_Store`、`._*`、`__MACOSX/`、临时文件。
- **`.note` 演讲者笔记建议纳入备份**(笔记也可能很重要)。前提是创建时就有 `.note` 文件存在 —— 见 4.8(现状不创建,需一并修正)。
- 私有仓兜底:即使误传,私有仓也不公开。但仍应避免把 token/密钥类文件纳入。

### 4.7 测试
- `scripts/test-gitee-backup.js`(纯逻辑):仓库名合法化、`.gitignore` 生成内容、push URL 拼接**不含 token 落盘**的断言。
- 手动验收:配 token → 创建 PPTE 选同步 → 确认 Gitee 出现私有仓且有内容 → 本地删目录 → `git clone` 能拉回。
- 安全验收:创建后检查 `.git/config` **不含 token 明文**。

### 4.8 创建 PPTE 时默认一并创建 `.note`(附带修正,与备份相关)
**现状问题**(已读码确认):`create_ppt_extra_folder`(`lib.rs:1056`)在收尾循环(约 `lib.rs:1259-1261`)里**只写 `slideNN.html`,不创建对应的 `.note`**。于是:
- 演讲者模式首次编辑笔记前,slide 旁没有 `.note` 文件;
- 后续所有"读/保存/备份笔记"的逻辑都要额外处理"文件不存在"的分支,徒增复杂度;
- 4.6 的"笔记纳入备份"若倾向为是,则没有 `.note` 可备份的空 slide 会在 git 状态里表现不一致。

**修正**:在写每个 `slideNN.html` 的同时,创建同名 `slideNN.note`(空内容或一行占位注释均可)。

- 落点非常明确:就在 `lib.rs` 写 slide HTML 的那个 `for (filename, _, html)` 循环内,`fs::write(ppt_dir.join(&filename), html)` 之后补一句写 `ppt_dir.join(filename.replace(".html", ".note"))`。
- 与 web 端一致:web README 的 Compatibility Contract 说明 web 创建的 PPTE 就带 `slide01.note` —— desktop 补上这条后两端行为对齐。
- 幂等/兼容:只在"创建"时补;不影响已有 PPTE。对已存在的 `.note` 不覆盖(创建流程本就是新目录,无冲突)。
- 测试:创建 PPTE 后断言每个 slide 都有配对 `.note` 文件存在。

---

## 5. 后续方案(本方案不实施,仅记录方向,供你排期)

### 反馈 3:PPTE 统一资源管理
- 在 PPTE 编辑器加「资源面板」:列出该 PPTE 目录下的图片/CSS/其它资源,支持查看引用、导入、删除、重命名。
- 与 web 下载的包互通:web 端已有资源规范化(见 web README 的 Compatibility Contract),desktop 资源面板应兼容同一布局。

### 反馈 1:编辑入口 UX
- 「右上角按钮太小 / 菜单奇怪」是新手盲区,作者自己无感。
- 建议先做一次**交互评审**(用别人的视角过一遍进入编辑/播放/演讲者模式的路径),再重排编辑入口。不要凭感觉改。

### 反馈 4:模板系统(机制开源、内容闭源)
- **开源机制**:desktop 支持「用户导入 / 自定义模板文件夹」,`list_ppt_templates` / `get_template_files` / `export_template` 已存在,扩展为可加载用户目录下的模板。
- **闭源内容**:高质量模板本身作为 web/skill 能力,不进开源仓库。与护城河一致。

### 反馈 5:AI 生成(归 web 仓库)
- desktop 只保留「连接 LectureAI 生成」的入口 + 引导文案。`call_lectureai` 链路已在 `lib.rs`。
- 真正的大纲→多页生成在 `lecture-presenter-public-web`,等其生成 API 稳定后再对接。**不在本仓库实施。**

---

## 6. 开工前需要你拍板 / 我需再确认的点

1. **`settings.js` 与 `course-creator.js` 两个 `_pptBuilder` 的关系** —— 是两个不同入口(设置里的 PPTE 管理 vs 新建课程时的 PPTE 构建)还是历史重复?拆分前必须查清。这是拆分成败的关键,我会在动手前专门调查。
2. **`save_ppt_extra` 改签名的策略** —— 确认走「新增可选 `expected_mtimes` 参数、老调用点不变」这条(推荐),还是全量改。
3. **`notify` crate 版本** —— 需确认与当前 Tauri 2 / Rust 版本兼容,并在 macOS + Windows 各验一次。
4. **冲突对话框的文案与默认项** —— 默认按钮建议是「取消保存」(最安全),避免手滑覆盖。请确认。
5. **【Gitee】PPTE↔仓库关联信息存哪**(4.5)—— 方案 A(存 manifest.json,需验证 web 端不剥字段)还是 B(存 app config)。倾向 A。
6. **【Gitee】`.note` 演讲者笔记是否纳入备份**(4.6)—— 倾向纳入(笔记也重要)。请确认。
7. **【Gitee】keyring 插件选型** —— 确认与 Tauri 2 兼容的钥匙串方案,macOS/Windows 各验一次。
8. **【Gitee】token 注入 git 的方式** —— 确认走「临时 `-c` / credential helper,不写入 `.git/config`」,杜绝 token 落盘(4.2 红线)。

---

## 7. 交付顺序总览(建议)

```
阶段一(数据安全 - 防覆盖,最先做):
  [2.1] save 前 mtime 冲突检测 + 只存 dirty slide  ← 堵静默覆盖,最高优先
  (可先在现有 settings.js 内实现,验证通过)

阶段二(实时体验):
  [3]   拆出 js/ppte-editor.js(把 2.1 的逻辑搬进干净小文件)
  [2.3] 抽 _reloadFrame 统一刷新入口
  [2.2] notify 文件监听 + 破缓存自动刷新
  [2.4] 手动刷新按钮兜底

阶段三(数据安全 - 远程备份):
  [4.8] 创建 PPTE 时默认建 .note(前置小修,lib.rs 一处循环)
  [4]   Gitee 钥匙串 token + 建私有仓 + init/push + 一键同步按钮
  (顺带把现有 AI api_key 也迁到钥匙串)

阶段四(可维护性,顺带):
  [3]   settings.js 其余职责拆分(ai-settings / ppte-recent)

后续(另立方案):
  反馈 3 资源面板 / 反馈 1 UX 评审 / 反馈 4 模板机制 / 反馈 5 对接 web
```

每个方括号项都能独立编译、测试、提交。

**三层防线的独立价值:**
- 只上**阶段一**,就消除了最致命的"保存静默覆盖"数据丢失。
- 只上**阶段三(Gitee)**,就有了"本地删没也能回退"的兜底——这正是作者被坑那次最需要的。
- 三层都上,PPTE 从"改错/看错/删没"三个方向都有防护。
