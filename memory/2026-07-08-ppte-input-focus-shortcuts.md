# DEBUG REPORT: 演讲/播放模式下输入框输入后快捷键失效

- **Symptom:** 播放模式或演讲者模式下，点击幻灯片里的输入框可以正常输入，但输入完成后点击页面非输入区域，左右方向键、F/P/S 等快捷键不再生效，无法翻页。观众窗口同样受影响。
- **Root cause:** 键盘转发依赖前端 `_installFrameNavigation` 往 iframe 的 `contentDocument` 注入监听器。macOS 上幻灯片 iframe 直载 `slide://localhost/...`，与主窗口 `tauri://localhost` 不同源，访问 `contentDocument` 抛 SecurityError 且被 try/catch 静默吞掉——桥接从未安装。点击输入框后焦点进入 iframe，之后 iframe 内没有任何转发器，父窗口 keydown 收不到事件。Windows 走 srcdoc 同源路径不受影响。
- **Fix:**
  - `lecture-app/src-tauri/src/lib.rs`：`slide://` 协议处理器对 HTML 响应追加 `src-tauri/src/ppte-slide-bridge.js`（`include_str!` 内嵌）。脚本在幻灯片自身上下文运行，转发 `slide-navigate`（方向键/翻页键）、`slide-shortcut`（F/P/S/Escape）、`slide-edit-focus`（pointerdown/focusin/focusout 上报是否在可编辑控件中），并中继嵌套 iframe 的同类消息。有 `__ppteSlideBridgeInstalled` 防重复安装守卫（Windows srcdoc 同源路径下与前端注入共存不冲突）。
  - 点击翻页通过握手控制：桥加载后发 `slide-bridge-ready`，演示窗口回 `slide-bridge-config {clickNavigate:true}`（`ppt-extra-iframe`、`speaker-current-slide`），下一页预览 `speaker-next-slide` 回 false；观众窗口不回复（默认 false，点击继续穿透给幻灯片，保持键盘导航为主的原设计）。
  - `audience.html` 处理 `slide-shortcut` 的 `annotate` 动作（P 键切换批注）。
- **Key flow after fix (macOS):** 点输入框 → 桥发 `slide-edit-focus active:true` → 父窗口快捷键让位，正常输入；点非输入区域 → 桥发 `active:false` → 父窗口 `_restorePlayFocus()` 把焦点拉回 `ppt-extra-focus-anchor` → 快捷键恢复。即使焦点仍在 iframe 内，keydown 也由桥转发，翻页不中断。
- **Regression tests:** `test-ppt-extra-viewer.js` 新增 `slide-bridge-ready` 握手用例（主 iframe true / 预览 false / 未知来源忽略）；`lib.rs` 新增 `slide_bridge_tests`（HTML 注入、非 HTML 跳过、`.HTM` 大小写）。注意 vm 跨上下文对象不能用 `assert.deepEqual`（原型不同），用 JSON 序列化比较。
- **Verification:** `npm run test:ppte`、`npm run test:annotator`、`cargo test` 全部通过。
- **Status:** DONE
