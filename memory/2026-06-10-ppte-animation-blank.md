# DEBUG REPORT: PPTE 动画页空白

- **Symptom:** PPTE 页面内动画在 Lecture Presenter 中显示为空白，典型页面如 `第一周/第1章-GIT/slide06.html`。该页依赖 `vendor/gsap.min.js`，且大量元素初始为 `opacity: 0`，需要脚本在 `load` 后显示。
- **Root cause:** 播放器为兼容 Tauri/WebView2 将 PPTE iframe 改为 `srcdoc` 加载，并使用 `http://slide.localhost/...` 自定义协议 URL 作为资源基准。但旧课件 HTML 内已有 `<base href="slide://localhost/...">`，`_injectBaseHref` 遇到已有 `<base>` 直接返回原 HTML，导致 `srcdoc` 内的相对脚本仍按旧 `slide://localhost/...` 解析。外部 GSAP 加载失败后，页面脚本不能执行，初始隐藏的动画元素保持不可见。
- **Fix:** 修改 `lecture-app/src/js/ppt-extra-viewer.js` 的 `_injectBaseHref`，对已有 `<base>` 进行替换，而不是跳过注入，保证 `srcdoc` 页面资源统一解析到播放器当前生成的 `http://slide.localhost/.../`。
- **Evidence:** 对 `slide06.html` 静态验证后，`vendor/gsap.min.js` 会解析为 `http://slide.localhost/.../vendor/gsap.min.js`，不再使用旧的 `slide://localhost/...`。
- **Regression test:** 新增 `lecture-app/scripts/test-ppt-extra-viewer.js`，覆盖旧 `<base>` 替换、无 `<base>` 注入、中文路径 URL 编码。
- **Verification:** `npm run test:ppte` 通过；`cargo check` 通过。
- **Status:** DONE
