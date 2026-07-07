const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const viewerPath = path.join(__dirname, '..', 'src', 'js', 'ppt-extra-viewer.js');
const source = fs.readFileSync(viewerPath, 'utf8');

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const context = {
  console,
  window: {
    __TAURI__: {},
  },
  navigator: {
    platform: 'MacIntel',
    userAgent: 'Macintosh',
  },
  document: {
    createElement() {
      return {
        _text: '',
        set textContent(value) {
          this._text = value;
        },
        get innerHTML() {
          return escapeHtml(this._text);
        },
      };
    },
  },
};

vm.createContext(context);
vm.runInContext(`${source}\nglobalThis.PptExtraViewer = PptExtraViewer;`, context);

const viewer = context.PptExtraViewer;

{
  const html = '<!doctype html><html><head><base href="slide://localhost/old/"><script src="vendor/gsap.min.js"></script></head></html>';
  const output = viewer._injectBaseHref(html, 'slide://localhost/Users/course/');

  assert.match(output, /<base href="slide:\/\/localhost\/Users\/course\/">/);
  assert.doesNotMatch(output, /slide:\/\/localhost\/old\//);
  assert.equal((output.match(/<base\b/gi) || []).length, 1);
}

{
  const html = '<!doctype html><html><head><title>Slide</title></head><body></body></html>';
  const output = viewer._injectBaseHref(html, 'slide://localhost/Users/course/');

  assert.match(output, /<head><base href="slide:\/\/localhost\/Users\/course\/"><title>Slide<\/title>/);
}

{
  const output = viewer._assetUrl('/Users/jingyi/课件/slide06.html');

  assert.equal(output, 'slide://localhost/Users/jingyi/%E8%AF%BE%E4%BB%B6/slide06.html');
}

{
  viewer.basePath = '/Users/jingyi/课件';
  viewer.baseUrl = 'asset://localhost/Users/jingyi/课件';
  viewer.slides = [{ file: 'slide06.html' }];
  const output = viewer.getSlideUrl(0, { bustCache: true, token: '7' });

  assert.equal(output, 'slide://localhost/Users/jingyi/%E8%AF%BE%E4%BB%B6/slide06.html?t=7');
}

{
  context.navigator.platform = 'Win32';
  context.navigator.userAgent = 'Windows';
  const output = viewer._assetUrl('C:/Users/jingyi/课件/slide06.html');

  assert.equal(output, 'http://slide.localhost/C%3A/Users/jingyi/%E8%AF%BE%E4%BB%B6/slide06.html');
}

{
  const output = viewer.getSlideUrl(0, { bustCache: true, token: '8' });

  assert.equal(output, 'http://slide.localhost/Users/jingyi/%E8%AF%BE%E4%BB%B6/slide06.html?t=8');
}

{
  let anchorFocused = false;
  const input = { tagName: 'INPUT', isContentEditable: false };
  const frameDoc = {
    hasFocus: () => true,
    activeElement: input,
  };
  const originalGetElementById = context.document.getElementById;
  context.document.getElementById = (id) => {
    if (id === 'ppt-extra-iframe') {
      return {
        contentDocument: frameDoc,
      };
    }
    if (id === 'speaker-current-slide' || id === 'speaker-next-slide') {
      return null;
    }
    if (id === 'ppt-extra-focus-anchor') {
      return {
        focus: () => {
          anchorFocused = true;
        },
      };
    }
    return null;
  };
  viewer.modal = { classList: { contains: () => false } };
  viewer.isPlaying = true;
  viewer._slideEditableFocus = false;

  viewer._restorePlayFocus();

  assert.equal(anchorFocused, false);
  context.document.getElementById = originalGetElementById;
}

{
  // slide-bridge-ready handshake: main slide and speaker current slide get
  // clickNavigate=true, the next-slide preview gets clickNavigate=false.
  const originalGetElementById = context.document.getElementById;
  const makeWindow = () => {
    const win = { messages: [] };
    win.postMessage = (msg) => win.messages.push(msg);
    return win;
  };
  const mainWindow = makeWindow();
  const previewWindow = makeWindow();
  context.document.getElementById = (id) => {
    if (id === 'ppt-extra-iframe') return { contentWindow: mainWindow };
    if (id === 'speaker-next-slide') return { contentWindow: previewWindow };
    return null;
  };
  viewer.modal = { classList: { contains: () => false } };

  viewer._handleSlideOpenMessage({ type: 'slide-bridge-ready' }, mainWindow);
  assert.equal(JSON.stringify(mainWindow.messages), JSON.stringify([{ type: 'slide-bridge-config', clickNavigate: true }]));

  viewer._handleSlideOpenMessage({ type: 'slide-bridge-ready' }, previewWindow);
  assert.equal(JSON.stringify(previewWindow.messages), JSON.stringify([{ type: 'slide-bridge-config', clickNavigate: false }]));

  // Unknown sources are ignored entirely.
  const strangerWindow = makeWindow();
  viewer._handleSlideOpenMessage({ type: 'slide-bridge-ready' }, strangerWindow);
  assert.equal(strangerWindow.messages.length, 0);

  context.document.getElementById = originalGetElementById;
}

console.log('ppt-extra-viewer tests passed');
