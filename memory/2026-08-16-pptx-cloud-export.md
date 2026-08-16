# 2026-08-16 PPTX 导出改造：图片版本地导出 + 可编辑版云端渲染

## 背景

原本地可编辑 PPTX 导出（`ppte-ppt-exporter.js` static/steps/animate 三模式 + Rust `<p:timing>` 动画补丁）整体下线，改为：

- **图片版导出**（新）：本地把每页渲染成整图放进 pptx，免费不限次。
- **可编辑导出**（static/steps/animate）：前端只做登录与配额门槛，PPTE 目录由 Rust 打包上传到云端渲染，返回 pptx 后本地另存。

所有导出要求登录；可编辑导出按会员月度配额计次。

## 云端契约（冻结，字段名不可改）

- `GET {serverUrl}/api/web/desktop/pptx-export/quota`，Bearer → `{used, limit, remaining, period, plan_code}`；401 = 未登录。
- `POST {serverUrl}/api/web/desktop/pptx-export`，Bearer + multipart：`file`=zip、`mode`=static|steps|animate → 200 pptx 二进制 / 402 `{"detail": 中文额度耗尽}` / 502 `{"detail": 渲染失败}`。

## 实现要点

- `src/js/ppte-image-exporter.js`（全局 `PpteImageExporter`）：从旧 exporter 移植 srcdoc 隐藏 iframe 加载、base 注入、inline script 外联（CSP）、ArrowRight 步进到最终态、`_imageUrlToDataUri`。新增 `_inlineLocalImages`：html-to-image 走 SVG foreignObject，抓不到 `slide://` / `http://slide.localhost` 资源，必须先把 `<img>` 和 computed background-image 内联成 data URI，否则截图空白。截图 `pixelRatio: 2`、1920×1080，pptxgenjs 每页一张满版图。
- `ppt-extra-viewer.js`：`exportToPpt` 开头统一登录门槛；image 走 `PpteImageExporter`；其余三模式先拉 quota（401 → 登录弹窗；remaining<=0 → alert + confirm 打开 membershipUrl），再 `invoke('export_pptx_editable', {dirPath, mode, token, serverUrl, defaultName})`。菜单 desc 打开时异步刷新为"可编辑 · 本月剩 N 次"，未登录/401 显示"登录后可用"。Rust 返回的 `unauthorized: ` 前缀错误同样触发登录弹窗。
- Rust `export_pptx_editable`（lib.rs）：`zip_ppte_directory` 打包整个 PPTE 目录（排除 `.DS_Store`，相对路径统一 `/`）→ reqwest multipart POST（`no_proxy`，timeout 300s）→ 非 200 解析 `{"detail"}` 透传；200 拿 bytes 走 `save_pptx_with_dialog`（从 `save_pptx_file` 抽出的"另存对话框+写盘"公共函数，取消返回 `Err("cancelled")`）。Cargo.toml 的 reqwest 加了 `multipart` feature。
- 菜单 4 项：image（"图片版 · 免费不限次"）+ animate/steps/static（带 `data-export-editable` 标记供 desc 刷新选择器使用）。

## 删除

- `src/js/ppte-ppt-exporter.js`、`scripts/test-ppt-exporter-steps.js`、`scripts/test-ppt-exporter-animate.js`、`src-tauri/examples/pptx_patch.rs`（整个 examples/ 目录）。
- lib.rs 的 `patch_pptx_animations` / `patch_slide_xml` / `scan_pptr_shape_ids` / `build_timing_xml` / `PptxSlideAnimation` / `PptxClickGroup` / `pptx_animation_tests`，`save_pptx_file` 的 animation 参数。
- package.json 的 `test:ppt-export` / `test:ppt-export-animate` 别名。

## 其他

- 新测试 `scripts/test-ppt-export-gating.js`（别名 `test:ppt-export-gating`）：未登录拦截（4 模式）、remaining=0 拦截 + 会员页跳转、quota 401、有额度时 invoke 参数契约、image 路由、上传 401 弹登录、菜单 desc 三种刷新文案。
- `.github/workflows/build-windows.yml`：tag 构建新增 publish-release job（对齐 macOS 的 gh release create/upload 方式），产物命名 `Lecture-Presenter_${VERSION}_Windows_x64.exe`。

## 验证

- `node --check` 三个改动 JS 通过；`npm run test:ppte / ppte-shared / resource-center / annotator / captions / course-manager / workbench / ppt-export-gating` + `node scripts/test-auth.js` 全绿。
- `cargo check` + `cargo test` 全绿（38 passed, 2 ignored）。
- 未验证：真实云端接口联调（契约冻结但服务器未联调）、html-to-image 在真机 WebKit/WebView2 的截图效果（需 `npm run dev` 人工冒烟，重点看中文字体与本地图片是否完整入图）。
