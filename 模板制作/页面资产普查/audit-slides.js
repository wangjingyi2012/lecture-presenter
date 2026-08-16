const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const ROOT = '/Users/jingyi.wang/Documents/workspace/培训/2026课件';
const WEB_ROOT = '/Users/jingyi.wang/Documents/workspace/培训/2026课件';
const OUTPUT = path.join(__dirname, 'output');
const CDP_PORT = Number(process.env.CDP_PORT || 9224);
const HTTP_PORT = Number(process.env.HTTP_PORT || 8766);

const decks = [
  { id: 'knowledge-base', name: '知识库搭建', dir: '知识库搭建' },
  { id: 'llm-principles', name: 'AI大模型原理_安恒', dir: 'AI大模型原理_安恒' },
  { id: 'agent-basics', name: 'Agent概念及基础开发', dir: 'Agent概念及基础开发' }
];

function getJson(route) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: CDP_PORT, path: route }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve(JSON.parse(body)));
    }).on('error', reject);
  });
}

async function connect() {
  const tabs = await getJson('/json');
  const tab = tabs.find(item => item.type === 'page');
  if (!tab) throw new Error('No Chrome page target found');
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  let id = 0;
  const pending = new Map();
  ws.on('message', payload => {
    const message = JSON.parse(payload.toString());
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  const call = (method, params = {}) => new Promise(resolve => {
    const callId = ++id;
    pending.set(callId, resolve);
    ws.send(JSON.stringify({ id: callId, method, params }));
  });
  return { ws, call };
}

function sourceSignals(source) {
  const count = pattern => (source.match(pattern) || []).length;
  return {
    clickHandlers: count(/addEventListener\s*\(\s*['"]click['"]/g),
    keyHandlers: count(/addEventListener\s*\(\s*['"]keydown['"]/g),
    stepStates: count(/data-step|dataset\.step|currentStep|setStep/g),
    keyframes: count(/@keyframes/g),
    transitions: count(/transition\s*:/g),
    transforms: count(/transform\s*:/g),
    grids: count(/display\s*:\s*grid/g),
    flexes: count(/display\s*:\s*flex/g),
    mediaQueries: count(/@media/g),
    hasAutoplay: /setInterval|autoplay/i.test(source),
    hasAnimationFrame: /requestAnimationFrame/.test(source),
    hasZoom: /zoomable|img-overlay|imageOverlay|openZoom/i.test(source)
  };
}

function loadDeck(deck) {
  const deckPath = path.join(ROOT, deck.dir);
  const manifest = JSON.parse(fs.readFileSync(path.join(deckPath, 'manifest.json'), 'utf8'));
  const actual = fs.readdirSync(deckPath).filter(file => /^slide.*\.html$/i.test(file)).sort();
  const manifestMap = new Map((manifest.slides || []).map((slide, index) => [slide.file, { ...slide, order: index + 1 }]));
  const ordered = (manifest.slides || []).map(slide => slide.file).filter(file => actual.includes(file));
  const extras = actual.filter(file => !manifestMap.has(file));
  return {
    ...deck,
    deckPath,
    title: manifest.title || deck.name,
    slides: [...ordered, ...extras].map((file, index) => ({
      file,
      order: index + 1,
      manifest: manifestMap.get(file) || null
    }))
  };
}

const evaluateExpression = `(() => {
  const all = [...document.querySelectorAll('*')];
  const classCounts = {};
  all.forEach(node => node.classList && node.classList.forEach(name => { classCounts[name] = (classCounts[name] || 0) + 1; }));
  const topClasses = Object.entries(classCounts).sort((a, b) => b[1] - a[1]).slice(0, 24);
  const images = [...document.images];
  const titleNode = document.querySelector('.page-title, h1, .chapter-title, .cover-title');
  const bodyText = (document.body.innerText || '').replace(/\s+/g, ' ').trim();
  const visibleCards = all.filter(node => {
    const name = String(node.className || '');
    return /card|panel|node|item|cell|box|stage|timeline|diagram|flow/i.test(name);
  }).length;
  return {
    documentTitle: document.title,
    heading: titleNode ? titleNode.textContent.trim() : '',
    textLength: bodyText.length,
    imgCount: images.length,
    loadedImages: images.filter(img => img.complete && img.naturalWidth > 0).length,
    svgCount: document.querySelectorAll('svg').length,
    tableCount: document.querySelectorAll('table').length,
    tableRows: document.querySelectorAll('tr').length,
    codeCount: document.querySelectorAll('pre, code').length,
    canvasCount: document.querySelectorAll('canvas').length,
    iframeCount: document.querySelectorAll('iframe').length,
    videoCount: document.querySelectorAll('video').length,
    buttonCount: document.querySelectorAll('button, [role=button]').length,
    listItems: document.querySelectorAll('li').length,
    visibleCards,
    topClasses,
    scroll: {
      width: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      height: document.documentElement.scrollHeight,
      clientHeight: document.documentElement.clientHeight
    }
  };
})()`;

async function waitForReady(call) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await call('Runtime.evaluate', {
      expression: 'document.readyState + ":" + [...document.images].every(img => img.complete)',
      returnByValue: true
    });
    const value = result.result && result.result.result && result.result.result.value;
    if (String(value).startsWith('complete:true')) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

async function main() {
  fs.mkdirSync(OUTPUT, { recursive: true });
  const { ws, call } = await connect();
  await call('Page.enable');
  await call('Runtime.enable');
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1920,
    height: 1080,
    deviceScaleFactor: 1,
    mobile: false
  });

  const report = { generatedAt: new Date().toISOString(), root: ROOT, decks: [] };
  for (const deckConfig of decks) {
    const deck = loadDeck(deckConfig);
    const screenshotDir = path.join(OUTPUT, 'screenshots', deck.id);
    fs.mkdirSync(screenshotDir, { recursive: true });
    const deckReport = { id: deck.id, name: deck.name, title: deck.title, path: deck.deckPath, slides: [] };
    process.stdout.write(`\n[${deck.name}] ${deck.slides.length} pages\n`);
    for (const slide of deck.slides) {
      const sourcePath = path.join(deck.deckPath, slide.file);
      const source = fs.readFileSync(sourcePath, 'utf8');
      const url = `http://127.0.0.1:${HTTP_PORT}/${encodeURIComponent(deck.dir)}/${encodeURIComponent(slide.file)}`;
      await call('Page.navigate', { url });
      await waitForReady(call);
      await new Promise(resolve => setTimeout(resolve, 180));
      const evaluated = await call('Runtime.evaluate', { expression: evaluateExpression, returnByValue: true });
      const dom = evaluated.result && evaluated.result.result ? evaluated.result.result.value : null;
      const number = String(slide.order).padStart(3, '0');
      const screenshotName = `${number}-${slide.file.replace(/\.html$/i, '')}.jpg`;
      const screenshot = await call('Page.captureScreenshot', { format: 'jpeg', quality: 74, captureBeyondViewport: false });
      fs.writeFileSync(path.join(screenshotDir, screenshotName), Buffer.from(screenshot.result.data, 'base64'));
      deckReport.slides.push({
        order: slide.order,
        file: slide.file,
        title: (slide.manifest && slide.manifest.title) || (dom && dom.heading) || (dom && dom.documentTitle) || slide.file,
        slideType: (slide.manifest && slide.manifest.slide_type) || 'unspecified',
        screenshot: `output/screenshots/${deck.id}/${screenshotName}`,
        dom,
        source: sourceSignals(source)
      });
      process.stdout.write(`${slide.order % 10 === 0 || slide.order === deck.slides.length ? slide.order : '.'}`);
    }
    report.decks.push(deckReport);
  }
  fs.writeFileSync(path.join(OUTPUT, 'audit.json'), JSON.stringify(report, null, 2));
  ws.close();
  process.stdout.write(`\nSaved ${path.join(OUTPUT, 'audit.json')}\n`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
