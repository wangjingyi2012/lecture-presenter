// ppte-annotator.js — Transient ink/text annotation overlay for PPTE slides.
// Annotations live in memory only (per page, per window) and are discarded on reset().
// Used by the main PPTE viewer (over #ppt-extra-container) and the audience window.
// Styles live in css/ppte-annotator.css — pages using this module must <link> it.
// (Runtime <style> injection is blocked by Tauri's production CSP on pages that
// contain inline <style> blocks, because the generated style hashes disable
// 'unsafe-inline'.)
(function () {
  const COLORS = ['#ff3b30', '#ff9500', '#ffd60a', '#34c759', '#0a84ff', '#ffffff'];
  const TOOLS = [
    { id: 'pen', label: '✏️', title: '画笔' },
    { id: 'highlight', label: '🖍', title: '荧光笔' },
    { id: 'text', label: 'T', title: '文字' },
    { id: 'eraser', label: '🧽', title: '橡皮擦' },
  ];

  const PEN_WIDTH_RATIO = 0.006;        // stroke width relative to canvas height
  const HIGHLIGHT_WIDTH_RATIO = 0.035;
  const HIGHLIGHT_ALPHA = 0.35;
  const TEXT_FONT_RATIO = 0.045;
  const ERASE_RADIUS_PX = 14;
  const MAX_UNDO = 50;

  function isEditableTarget(target) {
    if (!target) return false;
    const tag = target.tagName;
    return target.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  function emptyPage() {
    return { strokes: [], texts: [], undo: [] };
  }

  function create(options) {
    const container = options.container;
    const isAvailable = options.isAvailable || (() => true);
    const onActiveChange = options.onActiveChange || (() => {});

    if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }

    // --- State ---
    let active = false;
    let tool = 'pen';
    let color = COLORS[0];
    let pages = {};           // pageKey -> { strokes, texts, undo }
    let pageKey = 'default';
    let drawing = null;       // in-progress stroke { tool, color, points }
    let erasing = false;
    let eraseUndoPushed = false;
    let redrawQueued = false;
    let textIdSeq = 0;

    // --- DOM ---
    const layer = document.createElement('div');
    layer.className = 'ppte-anno-layer';
    const canvas = document.createElement('canvas');
    canvas.className = 'ppte-anno-canvas';
    const textsEl = document.createElement('div');
    textsEl.className = 'ppte-anno-texts';
    const toolbar = buildToolbar();
    layer.appendChild(canvas);
    layer.appendChild(textsEl);
    layer.appendChild(toolbar);
    let fab = null;
    if (options.floatingToggle) {
      fab = document.createElement('button');
      fab.className = 'ppte-anno-fab';
      fab.textContent = '✏️';
      fab.title = '标注模式 (P)';
      fab.addEventListener('click', () => setActive(!active));
      layer.appendChild(fab);
    }
    container.appendChild(layer);
    const ctx = canvas.getContext('2d');

    function buildToolbar() {
      const bar = document.createElement('div');
      bar.className = 'ppte-anno-toolbar';

      TOOLS.forEach(t => {
        const btn = document.createElement('button');
        btn.className = 'ppte-anno-btn';
        btn.dataset.tool = t.id;
        btn.textContent = t.label;
        btn.title = t.title;
        btn.addEventListener('click', () => setTool(t.id));
        bar.appendChild(btn);
      });

      bar.appendChild(separator());

      COLORS.forEach(c => {
        const sw = document.createElement('button');
        sw.className = 'ppte-anno-swatch';
        sw.dataset.color = c;
        sw.style.background = c;
        sw.title = '颜色';
        sw.addEventListener('click', () => setColor(c));
        bar.appendChild(sw);
      });

      bar.appendChild(separator());

      bar.appendChild(actionButton('↩', '撤销 (Cmd/Ctrl+Z)', () => undo()));
      bar.appendChild(actionButton('🗑', '清除本页标注', () => clearPage()));
      bar.appendChild(actionButton('✕', '退出标注 (Esc)', () => setActive(false)));
      return bar;
    }

    function separator() {
      const sep = document.createElement('div');
      sep.className = 'ppte-anno-sep';
      return sep;
    }

    function actionButton(label, title, handler) {
      const btn = document.createElement('button');
      btn.className = 'ppte-anno-btn';
      btn.textContent = label;
      btn.title = title;
      btn.addEventListener('click', handler);
      return btn;
    }

    function syncToolbarSelection() {
      toolbar.querySelectorAll('[data-tool]').forEach(btn => {
        btn.classList.toggle('selected', btn.dataset.tool === tool);
      });
      toolbar.querySelectorAll('[data-color]').forEach(sw => {
        sw.classList.toggle('selected', sw.dataset.color === color);
      });
    }

    function setTool(next) {
      commitActiveTextEdit();
      tool = next;
      layer.classList.toggle('tool-text', tool === 'text');
      layer.classList.toggle('tool-eraser', tool === 'eraser');
      syncToolbarSelection();
    }

    function setColor(next) {
      color = next;
      syncToolbarSelection();
    }

    // --- Page state (immutable updates so undo snapshots stay valid) ---
    function page() {
      if (!pages[pageKey]) pages[pageKey] = emptyPage();
      return pages[pageKey];
    }

    function pushUndo() {
      const p = page();
      p.undo = [...p.undo.slice(-(MAX_UNDO - 1)), { strokes: p.strokes, texts: p.texts }];
    }

    function undo() {
      commitActiveTextEdit();
      const p = page();
      const snapshot = p.undo[p.undo.length - 1];
      if (!snapshot) return;
      p.undo = p.undo.slice(0, -1);
      p.strokes = snapshot.strokes;
      p.texts = snapshot.texts;
      rebuild();
    }

    function clearPage() {
      commitActiveTextEdit();
      const p = page();
      if (p.strokes.length === 0 && p.texts.length === 0) return;
      pushUndo();
      p.strokes = [];
      p.texts = [];
      rebuild();
    }

    // --- Canvas sizing / drawing ---
    function resizeCanvas() {
      const rect = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      rebuild();
    }

    const resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => resizeCanvas())
      : null;
    if (resizeObserver) resizeObserver.observe(container);
    resizeCanvas();

    function canvasSize() {
      const rect = canvas.getBoundingClientRect();
      return { w: rect.width, h: rect.height };
    }

    function pointFromEvent(e) {
      const rect = canvas.getBoundingClientRect();
      return {
        x: (e.clientX - rect.left) / Math.max(1, rect.width),
        y: (e.clientY - rect.top) / Math.max(1, rect.height),
      };
    }

    function queueRedraw() {
      if (redrawQueued) return;
      redrawQueued = true;
      requestAnimationFrame(() => {
        redrawQueued = false;
        redraw();
      });
    }

    function redraw() {
      const { w, h } = canvasSize();
      ctx.clearRect(0, 0, w, h);
      page().strokes.forEach(s => drawStroke(s, w, h));
      if (drawing) drawStroke(drawing, w, h);
    }

    function drawStroke(stroke, w, h) {
      const pts = stroke.points;
      if (pts.length === 0) return;
      const isHighlight = stroke.tool === 'highlight';
      const width = h * (isHighlight ? HIGHLIGHT_WIDTH_RATIO : PEN_WIDTH_RATIO);
      ctx.globalAlpha = isHighlight ? HIGHLIGHT_ALPHA : 1;
      ctx.strokeStyle = stroke.color;
      ctx.fillStyle = stroke.color;
      ctx.lineWidth = width;
      ctx.lineJoin = 'round';
      ctx.lineCap = isHighlight ? 'butt' : 'round';

      if (pts.length === 1) {
        ctx.beginPath();
        ctx.arc(pts[0].x * w, pts[0].y * h, width / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.moveTo(pts[0].x * w, pts[0].y * h);
        for (let i = 1; i < pts.length - 1; i++) {
          const midX = ((pts[i].x + pts[i + 1].x) / 2) * w;
          const midY = ((pts[i].y + pts[i + 1].y) / 2) * h;
          ctx.quadraticCurveTo(pts[i].x * w, pts[i].y * h, midX, midY);
        }
        const last = pts[pts.length - 1];
        ctx.lineTo(last.x * w, last.y * h);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // --- Eraser ---
    function eraseAt(pt) {
      const { w, h } = canvasSize();
      const p = page();
      const kept = p.strokes.filter(s => !strokeHits(s, pt, w, h));
      if (kept.length === p.strokes.length) return;
      if (!eraseUndoPushed) {
        pushUndo();
        eraseUndoPushed = true;
      }
      p.strokes = kept;
      queueRedraw();
    }

    function strokeHits(stroke, pt, w, h) {
      const px = pt.x * w;
      const py = pt.y * h;
      return stroke.points.some(sp => {
        const dx = sp.x * w - px;
        const dy = sp.y * h - py;
        return dx * dx + dy * dy <= ERASE_RADIUS_PX * ERASE_RADIUS_PX;
      });
    }

    // --- Text annotations ---
    function fontSizePx() {
      return Math.max(14, canvasSize().h * TEXT_FONT_RATIO);
    }

    function rebuildTexts() {
      textsEl.innerHTML = '';
      page().texts.forEach(t => textsEl.appendChild(createTextDiv(t)));
    }

    function createTextDiv(textData) {
      const div = document.createElement('div');
      div.className = 'ppte-anno-text';
      div.contentEditable = 'true';
      div.spellcheck = false;
      div.dataset.textId = String(textData.id);
      div.textContent = textData.text;
      div.style.left = (textData.x * 100) + '%';
      div.style.top = (textData.y * 100) + '%';
      div.style.color = textData.color;
      div.style.fontSize = fontSizePx() + 'px';

      div.addEventListener('pointerdown', (e) => {
        if (!active) return;
        if (tool === 'eraser') {
          e.preventDefault();
          e.stopPropagation();
          removeText(textData.id);
        } else if (tool === 'text') {
          e.stopPropagation(); // allow focus/editing without creating a new text box
        }
      });
      div.addEventListener('blur', () => commitTextDiv(div));
      div.addEventListener('keydown', (e) => {
        e.stopPropagation(); // keep slide navigation keys out of the editor
        if (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey)) {
          e.preventDefault();
          div.blur();
        }
      });
      return div;
    }

    function placeTextAt(pt) {
      commitActiveTextEdit();
      const textData = { id: ++textIdSeq, x: pt.x, y: pt.y, text: '', color };
      const div = createTextDiv(textData);
      div.dataset.draft = '1';
      div._draftData = textData;
      textsEl.appendChild(div);
      div.focus();
    }

    function commitTextDiv(div) {
      const text = (div.textContent || '').trim();
      const isDraft = div.dataset.draft === '1';
      const p = page();

      if (isDraft) {
        const data = div._draftData;
        div.remove();
        if (!text || !data) return;
        pushUndo();
        p.texts = [...p.texts, { ...data, text }];
        rebuildTexts();
        return;
      }

      const id = Number(div.dataset.textId);
      const existing = p.texts.find(t => t.id === id);
      if (!existing) return;
      if (!text) {
        removeText(id);
      } else if (existing.text !== text) {
        pushUndo();
        p.texts = p.texts.map(t => (t.id === id ? { ...t, text } : t));
        rebuildTexts();
      }
    }

    function removeText(id) {
      const p = page();
      if (!p.texts.some(t => t.id === id)) return;
      pushUndo();
      p.texts = p.texts.filter(t => t.id !== id);
      rebuildTexts();
    }

    function commitActiveTextEdit() {
      const focused = textsEl.querySelector('.ppte-anno-text:focus');
      if (focused) focused.blur();
    }

    function rebuild() {
      redraw();
      rebuildTexts();
    }

    // --- Pointer handlers ---
    canvas.addEventListener('pointerdown', (e) => {
      if (!active || e.button !== 0) return;
      e.preventDefault();
      const pt = pointFromEvent(e);
      if (tool === 'text') {
        placeTextAt(pt);
        return;
      }
      canvas.setPointerCapture(e.pointerId);
      if (tool === 'eraser') {
        erasing = true;
        eraseUndoPushed = false;
        eraseAt(pt);
      } else {
        drawing = { tool, color, points: [pt] };
        queueRedraw();
      }
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!active) return;
      const pt = pointFromEvent(e);
      if (drawing) {
        drawing.points.push(pt);
        queueRedraw();
      } else if (erasing) {
        eraseAt(pt);
      }
    });

    function finishPointer() {
      if (drawing) {
        const stroke = drawing;
        drawing = null;
        if (stroke.points.length > 0) {
          pushUndo();
          const p = page();
          p.strokes = [...p.strokes, stroke];
        }
        queueRedraw();
      }
      erasing = false;
      eraseUndoPushed = false;
    }

    canvas.addEventListener('pointerup', finishPointer);
    canvas.addEventListener('pointercancel', finishPointer);

    // --- Keyboard (capture phase, so Esc wins over modal close handlers) ---
    function onKeyDown(e) {
      if (isEditableTarget(e.target)) return;
      if (!active) {
        if ((e.key === 'p' || e.key === 'P') && isAvailable()) {
          e.preventDefault();
          e.stopPropagation();
          setActive(true);
        }
        return;
      }
      if (e.key === 'Escape' || e.key === 'p' || e.key === 'P') {
        e.preventDefault();
        e.stopPropagation();
        setActive(false);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        e.stopPropagation();
        undo();
      }
    }
    document.addEventListener('keydown', onKeyDown, true);

    // --- Public API ---
    function setActive(next) {
      if (active === next) return;
      if (!next) {
        commitActiveTextEdit();
        finishPointer();
      }
      active = next;
      layer.classList.toggle('active', active);
      if (fab) fab.classList.toggle('active', active);
      if (active) syncToolbarSelection();
      onActiveChange(active);
    }

    function setPage(key) {
      commitActiveTextEdit();
      finishPointer();
      pageKey = String(key);
      rebuild();
    }

    function reset() {
      setActive(false);
      pages = {};
      pageKey = 'default';
      rebuild();
    }

    return {
      toggle: () => setActive(!active),
      setActive,
      isActive: () => active,
      setPage,
      reset,
    };
  }

  window.PpteAnnotator = { create };
})();
