// ppte-render-diagnostics.js - Deterministic, privacy-safe slide diagnostics.
//
// Slide scripts run in an opaque sandbox and return a compact allowlisted result
// through postMessage. The parent never combines allow-scripts with
// allow-same-origin, and diagnostics never include HTML, page text, absolute
// paths, or script exception messages.
//
// Measurement facts (render.measure.v1): overflow element bounding boxes, text
// line-wrap counts, and an opt-in full-page screenshot. Facts stay raw — no
// local conclusions. The optional screenshot only renders when the caller (the
// server-initiated measure task) explicitly requests it AND the user granted
// the cloud-analysis consent, and it never enters receipts or the journal.
//
// Platform note (P4-D2): the diagnostic frame is always fed via srcdoc with an
// injected <base>, the same strategy the Windows WebView2 path uses, so the
// runner is platform-neutral by construction (no slide:// iframe is ever
// loaded here). Still, both real-machine load paths need a manual smoke:
//   macOS (slide:// + WebKit):  1) measure a deck page, 2) verify overflow
//     boxes/wrap facts return with the sandbox attribute intact, 3) optional
//     screenshot produces a jpeg data URI when consented.
//   Windows (srcdoc + WebView2): same three steps via the http://slide.localhost
//     base href; watch for base-href regressions in _renderDiagnosticBaseHref.
// Neither smoke could be run in this development session; both remain TODO
// before release.
(function () {
  'use strict';

  const WIDTH = 1920;
  const HEIGHT = 1080;
  // Timeout budget chain (all values must stay ordered largest->smallest):
  //   Pi inactivity timeout (workbench-window.js, 180s)
  //   > worst-case per-page sum of ALL diagnostics runs on that page
  //     (a page may run validate_slide + measure_render, each up to
  //     DEFAULT_TIMEOUT_MS)
  //   > DEFAULT_TIMEOUT_MS (frame parse + bounded resource settle + measurement)
  //   > SCREENSHOT_TIMEOUT_MS (rasterization fits inside the frame's budget).
  // Collection starts at DOMContentLoaded, NOT load: a single hanging
  // subresource must never burn the whole frame budget. Fonts and images each
  // get their own bounded settle inside collect(), so the total stays close to
  // FONT_SETTLE_MS + IMAGE_SETTLE_MS + measurement even when resources hang.
  const DEFAULT_TIMEOUT_MS = 4500;
  const MESSAGE_TYPE = 'lectureai-render-diagnostics';
  const MAX_OVERFLOW_BOXES = 12;
  const MAX_WRAP_FACTS = 30;
  const MAX_TEXT_BOXES = 60;
  // Must stay well below DEFAULT_TIMEOUT_MS: the screenshot runs inside the
  // diagnostic frame, so a rasterization timeout here must fire first and
  // leave the frame time to report its facts (see budget chain above).
  const SCREENSHOT_TIMEOUT_MS = 2500;
  // Bounded settle inside the frame: fonts and not-yet-complete images get a
  // short window, then measurement proceeds regardless.
  const FONT_SETTLE_MS = 600;
  const IMAGE_SETTLE_MS = 1200;
  // Snapshots measure end states: kill transitions/animations so stepped or
  // animated pages settle immediately (same rule as the PPTX image exporter).
  const MOTION_KILL_CSS = '*,*::before,*::after{transition:none!important;animation:none!important}';

  function diagnosticFrameRunner(config) {
    const resourceFailures = [];
    let scriptErrorCount = 0;
    const startedAt = Date.now();
    const safeText = value => String(value || '').replace(/\s+/g, ' ').trim();
    const safeResource = value => {
      const raw = String(value || '').replace(/[?#].*$/, '').replace(/\\/g, '/');
      if (!raw) return 'unknown';
      try {
        const parsed = new URL(raw, document.baseURI);
        const parts = parsed.pathname.split('/').filter(Boolean).slice(-2);
        return parts.join('/').slice(0, 200) || parsed.hostname.slice(0, 120) || 'resource';
      } catch (_) {
        return raw.split('/').filter(Boolean).slice(-2).join('/').slice(0, 200) || 'resource';
      }
    };
    const escapeSelector = value => {
      if (globalThis.CSS?.escape) return CSS.escape(String(value || ''));
      return String(value || '').replace(/[^A-Za-z0-9_-]/g, '_');
    };
    const selector = element => {
      if (element.id) return `${element.tagName.toLowerCase()}#${escapeSelector(element.id)}`.slice(0, 160);
      const classes = typeof element.className === 'string'
        ? element.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).map(name => `.${escapeSelector(name)}`).join('')
        : '';
      return `${element.tagName.toLowerCase()}${classes}`.slice(0, 160);
    };
    const post = result => parent.postMessage({ type: config.messageType, nonce: config.nonce, result }, '*');
    const issue = (code, message, extra) => ({ code, severity: 'error', message, ...(extra || {}) });
    // Two animation frames when the frame is visible — but the diagnostic
    // frame is parked offscreen at left:-12000px, where browsers may never
    // produce frames at all, so a bare rAF chain can starve forever. The
    // setTimeout fallback keeps hidden frames moving (~100ms per pause).
    const pause = () => new Promise(resolve => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      try {
        requestAnimationFrame(() => requestAnimationFrame(finish));
      } catch (_) { finish(); }
      setTimeout(finish, 100);
    });

    window.addEventListener('error', event => {
      const target = event.target;
      if (target && target !== window) {
        const raw = target.getAttribute?.('src') || target.getAttribute?.('href') || target.getAttribute?.('poster');
        if (raw) resourceFailures.push(safeResource(raw));
        return;
      }
      scriptErrorCount += 1;
    }, true);
    window.addEventListener('unhandledrejection', () => { scriptErrorCount += 1; });

    async function collect() {
      try {
        await Promise.race([
          document.fonts?.ready || Promise.resolve(),
          new Promise(resolve => setTimeout(resolve, config.fontSettleMs || 0)),
        ]);
      } catch (_) { /* font failures are reflected by resource events */ }
      // Bounded image settle: never let one hanging subresource stall the run.
      try {
        const pending = [...document.querySelectorAll('img')].filter(img => !img.complete);
        if (pending.length) {
          await Promise.race([
            Promise.allSettled(pending.map(img => new Promise(resolve => {
              img.addEventListener('load', resolve, { once: true });
              img.addEventListener('error', resolve, { once: true });
            }))),
            new Promise(resolve => setTimeout(resolve, config.imageSettleMs || 0)),
          ]);
        }
      } catch (_) { /* image wait is best-effort */ }
      await pause();

      const stepRoot = document.querySelector('[data-max-step]');
      let steps = { present: false, maxStep: 0, finalStep: 0, completed: true };
      if (stepRoot) {
        const maxStep = Number(stepRoot.dataset.maxStep || 0);
        for (let index = 0; Number.isInteger(maxStep) && index < maxStep + 2 && Number(stepRoot.dataset.step || 0) < maxStep; index += 1) {
          document.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'ArrowRight', code: 'ArrowRight', bubbles: true, cancelable: true,
          }));
          await pause();
        }
        const finalStep = Number(stepRoot.dataset.step || 0);
        steps = {
          present: true,
          maxStep,
          finalStep,
          completed: Number.isInteger(maxStep) && maxStep >= 1 && finalStep === maxStep,
        };
      }

      const visible = element => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && Number(style.opacity || 1) > 0
          && rect.width > 0
          && rect.height > 0;
      };
      const elements = [...document.body.querySelectorAll('*')]
        .filter(element => visible(element) && !/^(SCRIPT|STYLE|LINK|META|DEFS)$/.test(element.tagName));
      const horizontal = [];
      const vertical = [];
      const overflowBoxes = [];
      const seenBoxSelectors = new Set();
      for (const element of elements) {
        const rect = element.getBoundingClientRect();
        const beyondHorizontal = rect.left < -2 || rect.right > config.width + 2;
        const beyondVertical = rect.top < -2 || rect.bottom > config.height + 2;
        if (beyondHorizontal) horizontal.push(selector(element));
        if (beyondVertical) vertical.push(selector(element));
        if ((beyondHorizontal || beyondVertical) && overflowBoxes.length < config.maxOverflowBoxes) {
          const name = selector(element);
          // The raw canvas-space box (rounded to integer px). One entry per
          // selector so a repeated class never floods the cap.
          if (!seenBoxSelectors.has(name)) {
            seenBoxSelectors.add(name);
            const fontPx = Number.parseFloat(getComputedStyle(element).fontSize || '0');
            overflowBoxes.push({
              selector: name,
              direction: beyondVertical && beyondHorizontal ? 'both' : (beyondVertical ? 'vertical' : 'horizontal'),
              box: {
                x: Math.round(rect.left),
                y: Math.round(rect.top),
                w: Math.round(rect.width),
                h: Math.round(rect.height),
              },
              ...(Number.isFinite(fontPx) && fontPx > 0 ? { fontPx: Number(fontPx.toFixed(2)) } : {}),
            });
          }
        }
      }

      const textElements = elements.filter(element => {
        if (/^(SVG|PATH|USE|IMG|VIDEO|CANVAS|BR|HR)$/.test(element.tagName)) return false;
        return [...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && safeText(node.textContent));
      });

      // In-canvas text element boxes: the raw bbox (canvas-space integer px)
      // plus fontPx of every visible text element fully inside the canvas, so
      // the cloud side can detect in-canvas text overlap (R13). Capped at
      // MAX_TEXT_BOXES with an explicit truncation flag. Still facts only —
      // no text content ever leaves the frame.
      const textBoxes = [];
      let textBoxesTruncated = false;
      for (const element of textElements) {
        if (textBoxes.length >= config.maxTextBoxes) { textBoxesTruncated = true; break; }
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        if (rect.left < -2 || rect.right > config.width + 2 || rect.top < -2 || rect.bottom > config.height + 2) continue;
        const fontPx = Number.parseFloat(getComputedStyle(element).fontSize || '0');
        textBoxes.push({
          selector: selector(element),
          box: {
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
          },
          ...(Number.isFinite(fontPx) && fontPx > 0 ? { fontPx: Number(fontPx.toFixed(2)) } : {}),
        });
      }

      let minBodyFontPx = null;
      const fontViolations = [];
      for (const element of textElements) {
        const size = Number.parseFloat(getComputedStyle(element).fontSize || '0');
        if (!Number.isFinite(size) || size <= 0) continue;
        minBodyFontPx = minBodyFontPx === null ? size : Math.min(minBodyFontPx, size);
        if (size + 0.25 < 28.8) {
          fontViolations.push({ selector: selector(element), actualPx: Number(size.toFixed(2)), minimumPx: 28.8 });
        }
      }

      // Line-wrap facts: how many rendered lines each text element occupies and
      // how full its last line is (0-1). Only multi-line elements are reported
      // so the cloud side can spot widows and wrapped titles. No text content
      // ever leaves the frame.
      const wraps = [];
      for (const element of textElements) {
        if (wraps.length >= config.maxWrapFacts) break;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0) continue;
        const range = document.createRange();
        let lineTop = null;
        let lines = 0;
        let lastLineWidth = 0;
        let hasText = false;
        for (const node of element.childNodes) {
          if (node.nodeType !== Node.TEXT_NODE || !safeText(node.textContent)) continue;
          hasText = true;
          range.selectNodeContents(node);
          for (const clientRect of range.getClientRects()) {
            if (clientRect.width <= 0 || clientRect.height <= 0) continue;
            if (lineTop === null || Math.abs(clientRect.top - lineTop) > Math.max(2, clientRect.height * 0.5)) {
              lineTop = clientRect.top;
              lines += 1;
              lastLineWidth = clientRect.width;
            } else {
              lastLineWidth = Math.max(lastLineWidth, clientRect.width);
            }
          }
        }
        range.detach?.();
        if (!hasText || lines < 2) continue;
        const fontPx = Number.parseFloat(getComputedStyle(element).fontSize || '0');
        wraps.push({
          selector: selector(element),
          lines,
          lastLineWidthRatio: Number(Math.max(0, Math.min(1, lastLineWidth / rect.width)).toFixed(2)),
          ...(Number.isFinite(fontPx) && fontPx > 0 ? { fontPx: Number(fontPx.toFixed(2)) } : {}),
        });
      }

      const missingResources = [...document.querySelectorAll('img,video,audio')]
        .filter(element => (element.tagName === 'IMG' && element.complete && element.naturalWidth === 0)
          || (element.tagName === 'VIDEO' && element.readyState === 0 && element.getAttribute('src'))
          || (element.tagName === 'AUDIO' && element.readyState === 0 && element.getAttribute('src')))
        .map(element => safeResource(element.getAttribute('src') || element.getAttribute('poster')));
      const resources = [...new Set([...resourceFailures, ...missingResources])].slice(0, 20);
      const root = document.documentElement;
      const body = document.body;
      const canvas = {
        width: config.width,
        height: config.height,
        scrollWidth: Math.max(root.scrollWidth, body.scrollWidth),
        scrollHeight: Math.max(root.scrollHeight, body.scrollHeight),
      };
      const overflow = {
        horizontalCount: horizontal.length,
        verticalCount: vertical.length,
        selectors: [...new Set([...horizontal, ...vertical])].slice(0, 12),
      };
      const templateRoot = document.querySelector('[data-template]');
      const actualTemplate = String(templateRoot?.getAttribute('data-template') || '');
      const template = {
        expected: config.expectedTemplate || null,
        actual: actualTemplate || null,
        matched: !config.expectedTemplate || actualTemplate === config.expectedTemplate,
      };
      const issues = [];
      if (overflow.horizontalCount > 0 || canvas.scrollWidth > config.width + 2) {
        issues.push(issue('RENDER_HORIZONTAL_OVERFLOW', '页面存在横向溢出', { selectors: overflow.selectors }));
      }
      if (overflow.verticalCount > 0 || canvas.scrollHeight > config.height + 2) {
        issues.push(issue('RENDER_VERTICAL_OVERFLOW', '页面存在纵向溢出', { selectors: overflow.selectors }));
      }
      if (fontViolations.length) {
        issues.push(issue('RENDER_FONT_TOO_SMALL', '页面存在过小正文', {
          selectors: fontViolations.slice(0, 12).map(item => item.selector),
        }));
      }
      if (resources.length) issues.push(issue('RENDER_RESOURCE_MISSING', '页面资源加载失败', { resources }));
      if (scriptErrorCount) issues.push(issue('RENDER_SCRIPT_ERROR', '页面脚本执行异常', { count: scriptErrorCount }));
      if (!steps.completed) issues.push(issue('RENDER_STEPS_INCOMPLETE', '分步页面无法进入最终状态'));
      if (!template.matched) issues.push(issue('RENDER_TEMPLATE_MISMATCH', '实际模板与课件蓝图不一致'));
      let screenshot = { available: false };
      if (config.screenshot === true) {
        // The rasterizer (html-to-image) is inlined into this frame by the
        // caller; the sandbox has no network/origin access to load it itself.
        // Failure is a missing fact, never a page failure.
        // html-to-image resolves its internal image loads through
        // requestAnimationFrame, which never fires in this offscreen frame —
        // shim it to a timer for the duration of the rasterization.
        const realRaf = window.requestAnimationFrame;
        window.requestAnimationFrame = callback => setTimeout(() => callback(Date.now()), 16);
        try {
          const toJpeg = globalThis.htmlToImage?.toJpeg;
          if (typeof toJpeg !== 'function') throw new Error('unavailable');
          const dataUri = await Promise.race([
            toJpeg(document.documentElement, {
              width: 1280,
              height: 720,
              canvasWidth: 1280,
              canvasHeight: 720,
              quality: 0.7,
              backgroundColor: '#ffffff',
              pixelRatio: 1,
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), config.screenshotTimeoutMs)),
          ]);
          if (typeof dataUri === 'string' && dataUri.startsWith('data:image/jpeg;base64,')) {
            screenshot = { available: true, dataUri: dataUri.slice(0, 4 * 1024 * 1024) };
          }
        } catch (_) { /* screenshot stays unavailable */ }
        finally { if (realRaf) window.requestAnimationFrame = realRaf; }
      }
      post({
        schemaVersion: 1,
        available: true,
        passed: issues.length === 0,
        load: { ok: true, timedOut: false, durationMs: Date.now() - startedAt },
        canvas,
        overflow,
        measure: { overflowBoxes, wraps, textBoxes, textBoxesTruncated },
        screenshot,
        font: {
          minBodyPx: minBodyFontPx === null ? null : Number(minBodyFontPx.toFixed(2)),
          violationCount: fontViolations.length,
        },
        resources: { failedCount: resources.length, items: resources },
        scripts: { errorCount: scriptErrorCount },
        steps,
        template,
        issues,
      });
    }

    // Collect as soon as the DOM is parsed, not at window load: one hanging
    // subresource (custom-protocol image, stylesheet) must never stall the
    // whole run until the parent timeout. load remains as a safety net in case
    // DOMContentLoaded was somehow missed.
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      collect().catch(() => post({
        schemaVersion: 1,
        available: false,
        passed: false,
        issues: [issue('RENDER_DIAGNOSTICS_UNAVAILABLE', '页面渲染诊断暂不可用')],
      }));
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start, { once: true });
      window.addEventListener('load', start, { once: true });
    } else {
      start();
    }
  }

  function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function safeStrings(values, maxItems, maxLength) {
    return (Array.isArray(values) ? values : [])
      .map(value => String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength))
      .filter(Boolean)
      .slice(0, maxItems);
  }

  function safeIssue(value) {
    const code = String(value?.code || 'RENDER_DIAGNOSTICS_UNAVAILABLE').toUpperCase();
    const allowedCode = /^RENDER_[A-Z0-9_]+$/.test(code) ? code : 'RENDER_DIAGNOSTICS_UNAVAILABLE';
    const messages = {
      RENDER_LOAD_FAILED: '页面未完成加载',
      RENDER_HORIZONTAL_OVERFLOW: '页面存在横向溢出',
      RENDER_VERTICAL_OVERFLOW: '页面存在纵向溢出',
      RENDER_FONT_TOO_SMALL: '页面存在过小正文',
      RENDER_RESOURCE_MISSING: '页面资源加载失败',
      RENDER_SCRIPT_ERROR: '页面脚本执行异常',
      RENDER_STEPS_INCOMPLETE: '分步页面无法进入最终状态',
      RENDER_TEMPLATE_MISMATCH: '实际模板与课件蓝图不一致',
      RENDER_DIAGNOSTICS_UNAVAILABLE: '页面渲染诊断暂不可用',
    };
    const normalized = {
      code: allowedCode,
      severity: 'error',
      message: messages[allowedCode] || '页面渲染检查未通过',
    };
    const selectors = safeStrings(value?.selectors, 12, 160);
    const resources = safeStrings(value?.resources, 20, 200).map(item => item.split(/[\\/]/).slice(-2).join('/'));
    if (selectors.length) normalized.selectors = selectors;
    if (resources.length) normalized.resources = resources;
    if (allowedCode === 'RENDER_SCRIPT_ERROR') normalized.count = Math.max(0, Math.floor(finite(value?.count)));
    return normalized;
  }

  function safeBox(value) {
    const raw = { x: Number(value?.x), y: Number(value?.y), w: Number(value?.w), h: Number(value?.h) };
    if (!Object.values(raw).every(number => Number.isFinite(number) && Math.abs(number) <= 100000)) return null;
    return { x: Math.round(raw.x), y: Math.round(raw.y), w: Math.round(raw.w), h: Math.round(raw.h) };
  }

  function normalizeResult(raw, config) {
    const issues = (Array.isArray(raw?.issues) ? raw.issues : []).map(safeIssue).slice(0, 30);
    const selectors = safeStrings(raw?.overflow?.selectors, 12, 160);
    const resources = safeStrings(raw?.resources?.items, 20, 200).map(item => item.split(/[\\/]/).slice(-2).join('/'));
    const overflowBoxes = (Array.isArray(raw?.measure?.overflowBoxes) ? raw.measure.overflowBoxes : [])
      .map(item => {
        if (!item || typeof item !== 'object') return null;
        const box = safeBox(item.box);
        if (!box) return null;
        const direction = ['horizontal', 'vertical', 'both'].includes(item.direction) ? item.direction : null;
        const name = String(item.selector || '').replace(/\s+/g, ' ').trim().slice(0, 160);
        if (!name || !direction) return null;
        const fontPx = Number(item.fontPx);
        return {
          selector: name,
          direction,
          box,
          ...(Number.isFinite(fontPx) && fontPx > 0 && fontPx <= 400 ? { fontPx: Number(fontPx.toFixed(2)) } : {}),
        };
      })
      .filter(Boolean)
      .slice(0, MAX_OVERFLOW_BOXES);
    const wraps = (Array.isArray(raw?.measure?.wraps) ? raw.measure.wraps : [])
      .map(item => {
        if (!item || typeof item !== 'object') return null;
        const name = String(item.selector || '').replace(/\s+/g, ' ').trim().slice(0, 160);
        const lines = Math.floor(finite(item.lines));
        const ratio = Number(finite(item.lastLineWidthRatio));
        if (!name || lines < 2 || lines > 200) return null;
        const fontPx = Number(item.fontPx);
        return {
          selector: name,
          lines,
          lastLineWidthRatio: Math.max(0, Math.min(1, Number(ratio.toFixed(2)))),
          ...(Number.isFinite(fontPx) && fontPx > 0 && fontPx <= 400 ? { fontPx: Number(fontPx.toFixed(2)) } : {}),
        };
      })
      .filter(Boolean)
      .slice(0, MAX_WRAP_FACTS);
    const textBoxes = (Array.isArray(raw?.measure?.textBoxes) ? raw.measure.textBoxes : [])
      .map(item => {
        if (!item || typeof item !== 'object') return null;
        const box = safeBox(item.box);
        const name = String(item.selector || '').replace(/\s+/g, ' ').trim().slice(0, 160);
        if (!box || !name || box.w <= 0 || box.h <= 0) return null;
        const fontPx = Number(item.fontPx);
        return {
          selector: name,
          box,
          ...(Number.isFinite(fontPx) && fontPx > 0 && fontPx <= 400 ? { fontPx: Number(fontPx.toFixed(2)) } : {}),
        };
      })
      .filter(Boolean)
      .slice(0, MAX_TEXT_BOXES);
    const available = raw?.available !== false && !issues.some(item => item.code === 'RENDER_DIAGNOSTICS_UNAVAILABLE');
    let screenshot = { available: false };
    if (config.includeScreenshot === true
      && typeof raw?.screenshot?.dataUri === 'string'
      && raw.screenshot.dataUri.startsWith('data:image/jpeg;base64,')
      && raw.screenshot.dataUri.length <= 4 * 1024 * 1024) {
      screenshot = { available: true, dataUri: raw.screenshot.dataUri };
    }
    return {
      schemaVersion: 1,
      available,
      page: Number.isInteger(config.page) ? config.page : null,
      pageId: config.pageId || null,
      passed: available && issues.length === 0,
      load: {
        ok: raw?.load?.ok === true,
        timedOut: raw?.load?.timedOut === true,
        durationMs: Math.max(0, Math.floor(finite(raw?.load?.durationMs))),
      },
      canvas: {
        width: finite(raw?.canvas?.width, WIDTH),
        height: finite(raw?.canvas?.height, HEIGHT),
        scrollWidth: finite(raw?.canvas?.scrollWidth, 0),
        scrollHeight: finite(raw?.canvas?.scrollHeight, 0),
      },
      overflow: {
        horizontalCount: Math.max(0, Math.floor(finite(raw?.overflow?.horizontalCount))),
        verticalCount: Math.max(0, Math.floor(finite(raw?.overflow?.verticalCount))),
        selectors,
      },
      measure: {
        schemaVersion: 1,
        overflowBoxes,
        wraps,
        textBoxes,
        textBoxesTruncated: raw?.measure?.textBoxesTruncated === true,
      },
      ...(config.includeScreenshot === true ? { screenshot } : {}),
      font: {
        minBodyPx: raw?.font?.minBodyPx == null ? null : finite(raw.font.minBodyPx),
        violationCount: Math.max(0, Math.floor(finite(raw?.font?.violationCount))),
      },
      resources: { failedCount: Math.max(resources.length, Math.floor(finite(raw?.resources?.failedCount))), items: resources },
      scripts: { errorCount: Math.max(0, Math.floor(finite(raw?.scripts?.errorCount))) },
      steps: {
        present: raw?.steps?.present === true,
        maxStep: Math.max(0, Math.floor(finite(raw?.steps?.maxStep))),
        finalStep: Math.max(0, Math.floor(finite(raw?.steps?.finalStep))),
        completed: raw?.steps?.completed !== false,
      },
      template: {
        expected: config.expectedTemplate || null,
        actual: raw?.template?.actual ? String(raw.template.actual).slice(0, 120) : null,
        matched: raw?.template?.matched !== false,
      },
      issues,
    };
  }

  function unavailableResult(config, timedOut) {
    return normalizeResult({
      available: false,
      load: { ok: false, timedOut: !!timedOut },
      issues: [{ code: timedOut ? 'RENDER_LOAD_FAILED' : 'RENDER_DIAGNOSTICS_UNAVAILABLE' }],
    }, config);
  }

  function buildSrcdoc(html, baseHref, config) {
    const safeConfig = JSON.stringify({
      nonce: config.nonce,
      messageType: MESSAGE_TYPE,
      width: WIDTH,
      height: HEIGHT,
      expectedTemplate: config.expectedTemplate || '',
      screenshot: config.includeScreenshot === true,
      // Everything the serialized runner needs must ride in this config: the
      // frame re-evaluates diagnosticFrameRunner from source, so closure
      // constants (caps, timeouts) would be ReferenceErrors there.
      screenshotTimeoutMs: SCREENSHOT_TIMEOUT_MS,
      fontSettleMs: FONT_SETTLE_MS,
      imageSettleMs: IMAGE_SETTLE_MS,
      maxOverflowBoxes: MAX_OVERFLOW_BOXES,
      maxWrapFacts: MAX_WRAP_FACTS,
      maxTextBoxes: MAX_TEXT_BOXES,
    }).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
    const runner = `<script>(${diagnosticFrameRunner.toString()})(${safeConfig});<\/script>`;
    const motionKill = `<style data-ppte-diag-motion>${MOTION_KILL_CSS}</style>`;
    // The screenshot rasterizer runs inside the sandboxed frame, so its source
    // has to be inlined; a src reference could not be fetched from this origin.
    const rasterizer = config.includeScreenshot === true && typeof config.screenshotScript === 'string'
      && config.screenshotScript.length < 300000 && !/<\/script/i.test(config.screenshotScript)
      ? `<script>${config.screenshotScript}<\/script>`
      : '';
    const escapedBase = String(baseHref || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const base = escapedBase ? `<base href="${escapedBase}">` : '';
    let source = String(html || '').replace(/<base\b[^>]*>/i, '');
    if (/<head[^>]*>/i.test(source)) return source.replace(/<head([^>]*)>/i, `<head$1>${base}${motionKill}${rasterizer}${runner}`);
    if (/<html[^>]*>/i.test(source)) return source.replace(/<html([^>]*)>/i, `<html$1><head>${base}${motionKill}${rasterizer}${runner}</head>`);
    return `<!doctype html><html><head>${base}${motionKill}${rasterizer}${runner}</head><body>${source}</body></html>`;
  }

  function nonce() {
    if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
    const bytes = new Uint8Array(16);
    globalThis.crypto?.getRandomValues?.(bytes);
    return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('') || `${Date.now()}-${Math.random()}`;
  }

  async function diagnose(options) {
    const config = {
      page: Number.isInteger(Number(options?.page)) ? Number(options.page) : null,
      pageId: options?.pageId ? String(options.pageId).slice(0, 120) : null,
      expectedTemplate: String(options?.expectedTemplate || '').slice(0, 120),
      includeScreenshot: options?.includeScreenshot === true,
      screenshotScript: options?.includeScreenshot === true && typeof options?.screenshotScript === 'string'
        ? options.screenshotScript
        : null,
      nonce: nonce(),
    };
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText = `position:fixed;left:-12000px;top:0;width:${WIDTH}px;height:${HEIGHT}px;border:0;opacity:0;pointer-events:none;`;
    document.body.appendChild(iframe);
    const timeoutMs = Math.max(250, Number(options?.timeoutMs || DEFAULT_TIMEOUT_MS));
    try {
      return await new Promise(resolve => {
        let settled = false;
        const finish = value => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          window.removeEventListener('message', onMessage);
          resolve(value);
        };
        const onMessage = event => {
          if (event.source !== iframe.contentWindow || event.data?.type !== MESSAGE_TYPE || event.data?.nonce !== config.nonce) return;
          finish(normalizeResult(event.data.result, config));
        };
        const timer = setTimeout(() => finish(unavailableResult(config, true)), timeoutMs);
        window.addEventListener('message', onMessage);
        iframe.srcdoc = buildSrcdoc(options?.html, options?.baseHref, config);
      });
    } catch (_) {
      return unavailableResult(config, false);
    } finally {
      iframe.remove();
    }
  }

  window.PpteRenderDiagnostics = {
    diagnose,
    _buildSrcdoc: buildSrcdoc,
    _normalizeResult: normalizeResult,
    _unavailableResult: unavailableResult,
  };
})();
