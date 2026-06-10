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
  context.navigator.platform = 'Win32';
  context.navigator.userAgent = 'Windows';
  const output = viewer._assetUrl('C:/Users/jingyi/课件/slide06.html');

  assert.equal(output, 'http://slide.localhost/C%3A/Users/jingyi/%E8%AF%BE%E4%BB%B6/slide06.html');
}

console.log('ppt-extra-viewer tests passed');
