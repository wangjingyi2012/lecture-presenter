// ppte-render-diagnostics.js - Deterministic, privacy-safe slide diagnostics.
//
// Slide scripts run in an opaque sandbox and return a compact allowlisted result
// through postMessage. The parent never combines allow-scripts with
// allow-same-origin, and diagnostics never include HTML, screenshots, page text,
// absolute paths, or script exception messages.
(function () {
  'use strict';

  const WIDTH = 1920;
  const HEIGHT = 1080;
  const DEFAULT_TIMEOUT_MS = 8500;
  const MESSAGE_TYPE = 'lectureai-render-diagnostics';

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
    const pause = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

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
          new Promise(resolve => setTimeout(resolve, 600)),
        ]);
      } catch (_) { /* font failures are reflected by resource events */ }
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
      for (const element of elements) {
        const rect = element.getBoundingClientRect();
        if (rect.left < -2 || rect.right > config.width + 2) horizontal.push(selector(element));
        if (rect.top < -2 || rect.bottom > config.height + 2) vertical.push(selector(element));
      }

      const textElements = elements.filter(element => {
        if (/^(SVG|PATH|USE|IMG|VIDEO|CANVAS|BR|HR)$/.test(element.tagName)) return false;
        return [...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && safeText(node.textContent));
      });
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
      post({
        schemaVersion: 1,
        available: true,
        passed: issues.length === 0,
        load: { ok: true, timedOut: false, durationMs: Date.now() - startedAt },
        canvas,
        overflow,
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

    window.addEventListener('load', () => {
      collect().catch(() => post({
        schemaVersion: 1,
        available: false,
        passed: false,
        issues: [issue('RENDER_DIAGNOSTICS_UNAVAILABLE', '页面渲染诊断暂不可用')],
      }));
    }, { once: true });
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

  function normalizeResult(raw, config) {
    const issues = (Array.isArray(raw?.issues) ? raw.issues : []).map(safeIssue).slice(0, 30);
    const selectors = safeStrings(raw?.overflow?.selectors, 12, 160);
    const resources = safeStrings(raw?.resources?.items, 20, 200).map(item => item.split(/[\\/]/).slice(-2).join('/'));
    const available = raw?.available !== false && !issues.some(item => item.code === 'RENDER_DIAGNOSTICS_UNAVAILABLE');
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
    }).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
    const runner = `<script>(${diagnosticFrameRunner.toString()})(${safeConfig});<\/script>`;
    const escapedBase = String(baseHref || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const base = escapedBase ? `<base href="${escapedBase}">` : '';
    let source = String(html || '').replace(/<base\b[^>]*>/i, '');
    if (/<head[^>]*>/i.test(source)) return source.replace(/<head([^>]*)>/i, `<head$1>${base}${runner}`);
    if (/<html[^>]*>/i.test(source)) return source.replace(/<html([^>]*)>/i, `<html$1><head>${base}${runner}</head>`);
    return `<!doctype html><html><head>${base}${runner}</head><body>${source}</body></html>`;
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
