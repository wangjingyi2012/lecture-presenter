# FEATURE REPORT: 资源中心（全局页面复用）

- **Date:** 2026-07-24
- **需求:** 用户最原始的需求是"课件中的某几页可以复用"。此前唯一的复用机制是共享页面组（引用+同步，只读、需预先建组、仅连续页面、来源仅限最近打开），用户反馈不好用。讨论确认痛点：找不到可复用的页、流程太绕、拷过来不能改。决策：默认拷贝独立、可选保持同步；来源为已导入课程+recentPpte；编辑器+主界面双入口；资源冲突自动隔离。

## 实现

- **后端** `lecture-app/src-tauri/src/lib.rs`：新 command `ppte_copy_slides({sourcePath, targetPath, slideFiles})` → 把选中 slide HTML + 同名 `.note` + 共享资源（复用快照排除规则，额外排除 `.ppte-copies`）拷贝到目标的 `.ppte-copies/<copyId>/` 隔离目录，返回 `{copyId, copyRoot, slides:[{sourceFile, targetFile}]}`。从快照实现抽取了三个公共 helper（`collect_ppte_files_excluding`、`ppte_filter_selected_files`、`ppte_copy_files_preserving_layout`），快照行为不变（原有测试全绿）。
- **前端** `lecture-app/src/js/resource-center.js` + `css/resource-center.css`：全局 `ResourceCenter`，三栏 UI（课件列表 / 页面多选 / 预览 iframe）。来源扫描兼容 course.json 两种 ppt-extra 形状 + v2 sections + recentPpte，按归一化路径去重，不可用源置灰。预览复用 `PptExtraViewer._assetUrl/_injectBaseHref/_usesCustomProtocolHost` 平台分流。
- **拷贝插入**：editor 模式 splice 进 `pb.slides`（无 `linkedFrom`，落地即普通可编辑页，标 manifestDirty 走正常保存）；main 模式直接读写目标 manifest.json（v1 保持 v1 形状，v2 生成 `slide_` id），目标正在编辑器打开时拒绝。
- **引用插入**：保留共享分组机制，作为资源中心内的次选动作（`Settings._showInsertSharedGroupModal`）。
- **入口**：titlebar「资源中心」按钮（全屏 modal）+ 编辑器工具栏原「插入共享」按钮改为「资源中心」（抽屉）。

## 关键取舍

- 拷贝落地在 `.ppte-copies/<copyId>/` 子目录而非目标根目录：自动隔离，绝不影响目标现有文件；子目录路径作为 slide `file` 已被 `.ppte-links` 引用页验证过全链路可用。
- 勾选状态跨源保存（Map），插入顺序稳定（组序→源序→manifest 页序），每个源一次 `ppte_copy_slides` 调用。
- CSP 约束：样式走 `<link>` 的独立 css 文件，未用运行时 `<style>` 注入。

## 验证

- `cargo test`：25 passed（含 4 个新 `copy_slides_*`：基本拷贝/排除规则/source==target/空列表与逃逸），既有 snapshot 测试全绿。
- `npm run test:resource-center`（新）、`test:ppte`、`test:annotator`、`test:ppte-shared` 全部通过。
- **未验证**：未跑 `npm run dev` 实机冒烟（双模式插入、预览 iframe、WebKit/WebView2 实机表现待桌面端实测）。

## 文档

- `COURSE_FORMAT.md`：新增「资源中心拷贝目录」一节（`.ppte-copies` 属课件内容，移动/备份须保留；与 `.ppte-links` 的区别是可手工编辑）。
- `AGENTS.md`：新增 shared groups + resource center 架构小节，commands 补 `test:ppte-shared`/`test:resource-center`。

## 打包坑（2026-07-25 补记）

本机默认 Rust toolchain 是 `stable-x86_64-apple-darwin`（Rosetta 下安装），直接 `npm run build` 会产出 **x86_64 未签名**的包。正确姿势：`npx tauri build --target aarch64-apple-darwin`（不要用 `npm run build -- -- --target`，双 `--` 传参不稳定）。产物在 `target/aarch64-apple-darwin/release/bundle/`。tauri 打包后可能是 linker-signed 残缺签名（`codesign --verify` 报 "code has no resources..."），需 `codesign --force --deep --sign -` 重签，`--verify --deep --strict` 通过后再替换 /Applications。

- **Status:** DONE（已打包 arm64 版替换 /Applications，待桌面端实测资源中心）
