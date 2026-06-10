# DEBUG REPORT: PPTE 动画页空白和资源异常

- **Symptom:** PPTE 页面内动画在 Lecture Presenter 中显示为空白，典型页面如 `第一周/第1章-GIT/slide06.html`。第一轮修复后，动画问题缓解但 macOS 上图片等资源显示异常，iframe 地址变成 `about:srcdoc`。
- **Root cause:** PPTE 旧课件 HTML 内已有 `<base href="slide://localhost/...">`，动画页又依赖 `vendor/gsap.min.js`。Windows/Tauri WebView2 不能稳定直载 `slide://` iframe，因此需要 `srcdoc + http://slide.localhost/...` 的兼容路径。但 macOS WebKit 对 Tauri 自定义协议的子资源解析更适合 `slide://localhost/...` 直载。第一轮修复把 `srcdoc + http://slide.localhost` 逻辑套到了所有平台，导致 macOS 资源解析路径漂移。
- **Fix:** 在 `lecture-app/src/js/ppt-extra-viewer.js` 中按平台分流：Windows 使用 `srcdoc + http://slide.localhost/...`，macOS 和其他平台使用 iframe 直接加载 `slide://localhost/.../slideNN.html`。同时保留 `_injectBaseHref` 对旧 `<base>` 的替换能力，覆盖需要 `srcdoc` 的平台。
- **Related fix:** `lecture-app/src-tauri/src/lib.rs` 的内置使用指南配置以前只在缺失时插入，已存在旧路径时不会更新。现在启动时会把 `lecture-presenter-guide` 更新到当前 `/Applications/Lecture Presenter.app/Contents/Resources/使用指南`。
- **Evidence:** 已安装的 `/Applications/Lecture Presenter.app` 中，`slide06.html` 和 `slide14.html` 的 iframe URL 均为 `slide://localhost/...`；`slide06.html` 动画内容可见，`slide14.html` 能看到 `git push 输出` 图片节点和正文内容，不再是 `about:srcdoc`。
- **Regression test:** `lecture-app/scripts/test-ppt-extra-viewer.js` 覆盖 macOS 默认 `slide://localhost/...`、Windows `http://slide.localhost/...`、旧 `<base>` 替换、无 `<base>` 注入、中文路径 URL 编码。
- **Verification:** `npm run test:ppte` 通过；`cargo check` 通过；`codesign --verify --deep --strict` 验证 `/Applications/Lecture Presenter.app` 通过。
- **Status:** DONE
