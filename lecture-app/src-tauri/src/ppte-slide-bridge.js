// PPTE slide navigation bridge — appended by the slide:// protocol handler.
// Slide frames load cross-origin from the app window (slide://localhost vs
// tauri://localhost), so the parent cannot reach into contentDocument to
// install navigation forwarding. This script runs inside the slide itself and
// forwards navigation keys, shortcuts, and editable-focus state to the parent
// via postMessage — the same message types the app already handles for the
// same-origin (Windows srcdoc) path.
//
// Clicks are deliberately NOT forwarded as navigation: slides handle their own
// click-driven animations, and page navigation is keyboard-only.
(function () {
  if (window.__ppteSlideBridgeInstalled) return;
  window.__ppteSlideBridgeInstalled = true;
  if (window.parent === window) return;

  function isEditableTarget(target) {
    if (!target) return false;
    var tag = target.tagName;
    return target.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  function navigationDirectionFromKey(key) {
    if (key === 'ArrowLeft' || key === 'PageUp') return 'prev';
    if (key === 'ArrowRight' || key === 'PageDown' || key === ' ' || key === 'Spacebar' || key === 'Enter') return 'next';
    return '';
  }

  function shortcutFromKey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return '';
    if (e.key === 'f' || e.key === 'F') return 'play';
    if (e.key === 'p' || e.key === 'P') return 'annotate';
    if (e.key === 's' || e.key === 'S') return 'speaker';
    if (e.key === 'Escape') return 'escape';
    return '';
  }

  function post(message) {
    try {
      window.parent.postMessage(message, '*');
    } catch (err) {
      // Parent may be gone during teardown; nothing to do.
    }
  }

  document.addEventListener('keydown', function (e) {
    if (isEditableTarget(e.target)) return;
    var shortcut = shortcutFromKey(e);
    if (shortcut) {
      e.preventDefault();
      post({ type: 'slide-shortcut', action: shortcut });
      return;
    }
    var direction = navigationDirectionFromKey(e.key);
    if (!direction) return;
    e.preventDefault();
    post({ type: 'slide-navigate', direction: direction });
  }, true);

  // Report whether the user is interacting with an editable control so the
  // embedding window knows when to reclaim keyboard focus. Clicking a
  // non-editable area after typing sends active:false, which lets the parent
  // pull focus back and re-enable its own shortcuts.
  document.addEventListener('pointerdown', function (e) {
    post({ type: 'slide-edit-focus', active: isEditableTarget(e.target) });
  }, true);

  document.addEventListener('focusin', function (e) {
    if (!isEditableTarget(e.target)) return;
    post({ type: 'slide-edit-focus', active: true });
  }, true);

  document.addEventListener('focusout', function (e) {
    if (!isEditableTarget(e.target)) return;
    post({ type: 'slide-edit-focus', active: false });
  }, true);

  // Relay messages from nested frames (e.g. embedded code-browser pages that
  // also load via slide:// and got this bridge injected) up to the app window.
  window.addEventListener('message', function (e) {
    if (e.source === window.parent) return;
    var data = e.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'slide-navigate' || data.type === 'slide-shortcut' || data.type === 'slide-edit-focus') {
      post(data);
    }
  });
})();
