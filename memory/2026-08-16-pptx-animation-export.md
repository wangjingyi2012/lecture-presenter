# PPTE 导出 PPTX：分步/静态修复 + 原生点击动画

日期：2026-08-16

## 背景

LectureAI 生成链路的模板页面形态已固定（`[data-template]` + `data-step`/`data-max-step` 步进契约），用户持续要求把 PPTE 课件导出为保留动画效果的可编辑 PPTX。明确不做截图/栅格化，只用原生 PPTX 元素。

## 两档实现

### 第一档：导出菜单 + 静态/分步修复

- 导出按钮（`index.html` `#ppt-extra-export`）旁新增下拉 `#ppt-export-menu`，三个模式：
  - `animate` 动画导出（每个源页一张 PPTX 页，绑定原生单击动画）；
  - `steps` 分步展开（每个动画步一张页，文件名加 `-分步版`）；
  - `static` 静态（先驱动到最终态再快照，修复了原来只导出第一幕、丢后续内容的问题）。
- 步进驱动：在隐藏 iframe 里 dispatch ArrowRight keydown，模板 `preventDefault()` 消费；`event.defaultPrevented` 判断是否还有下一步。

### 第二档：原生点击动画注入

- `PptePptExporter.export(viewer, {mode:'animate'})`：加载时给 iframe DOM 元素盖 `data-ppt-export-id`；`_buildAnimationPlan` 按可见区间跨步追踪元素，内容签名（排除 box，纯位移不拆对象）变化或区间断裂时拆变体做 exit+enter 对。
- 动画对象经 pptxgenjs `objectName: "pptr<N>"` 写入 `<p:cNvPr name>`。
- Rust `save_pptx_file` 新增 `animation: Option<Vec<PptxSlideAnimation>>` 参数，`patch_pptx_animations` 用 zip crate 按 name 解析 spid，向每页 slide XML 的 `</p:sld>` 前插入 `<p:timing>` 树（fade = presetID 10 entr/exit，单击触发）。
- 离线补丁工具：`src-tauri/examples/pptx_patch.rs`（`cargo run --example pptx_patch <in.pptx> <manifest.json> <out.pptx>`），供 headless 验证链路复用正式补丁代码。

## 版式问题修复（用户实测反馈：动画对，但字叠字、箭头乱画）

全部在 `src/js/ppte-ppt-exporter.js`：

1. **字叠字**：`_shouldExportTextElement` 的子串正则把含 `tag` 的 `stage` 类名（如 `.story-stage`）误判为文本容器，整页内容被当成一个巨型文本框叠加。改为 token 边界匹配 `/(^|[-_])(title|subtitle|heading|label|tag|desc|text|number|caption)([-_]|$)/i`；另加 `_hasExportedAncestor` 祖先去重（修 `<pre>+<span>` 父子重复导出）。
2. **箭头乱画**：`_svgToDataUri(svg, win)` 现在内联计算样式（fill/stroke/stroke-width/marker-* 等，`none` 显式写入防祖先覆盖，currentColor 解析），并把 `url(#id)` 跨 SVG 引用的 defs（marker 等）拷进克隆；url 值可能带引号，匹配正则 `url\(\s*["']?#([^)"'\s]+)["']?\s*\)`。
3. **文字箭头消失**：`_isIconOnly` 不再把 `→←↑↓↔↕⇒⇐⇑⇓↗↘↙↖` 当图标跳过；icon/emoji 类名保持子串匹配（iconfont 需要）。

## 验证

- `npm run test:ppt-export` / `test:ppt-export-animate` / `test:ppte` 全过；`cargo test` 42 过 2 跳过（云凭证 live caption）。
- headless 复验（tmp/ 下临时 capture server + harness HTML + gstack 驱动，真 `vendor/pptxgen.bundle.js`，假 `__TAURI__.core.invoke` 捕获 save 载荷，再用 examples/pptx_patch 离线补丁）：容器重复消失（concept-story 6→5 文本、flow-command 12→10），箭头恢复（flow-loop 18→26 文本），SVG 内联 stroke/fill/marker defs 完整。四个模板样品经用户目测确认。
- 已知长尾（如遇反馈再逐个修）：CSS 渐变背景不提取（`_parseCssColor` 只认 rgb/hex）、伪元素/clip-path 装饰线不提取、中英文字体度量差异可能致文本框高度不足。

## 工程备忘

- vm 沙盒测试里 `assert.deepEqual` 对跨 realm 对象误报，用 `JSON.parse(JSON.stringify(...))` 或逐字段断言。
- zip crate 2.4.2，用 `zip::write::SimpleFileOptions`；slide XML 固定以 `</p:clrMapOvr></p:sld>` 结尾，timing 插 `</p:sld>` 前。
- `request_id` 无关本功能；动画导出不走 Pi/网络，纯本地。
