const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');

const CDP_PORT = 9226;
const BASE_URL = 'http://127.0.0.1:8768';
const OUT = '/tmp/lecture-template-first-batch';
const templates = [
  { id: 'concept-story-progression', final: "document.querySelector('[data-target=\\\"3\\\"]').click()" },
  { id: 'architecture-zoom-path', final: "document.querySelector('[data-target=\\\"3\\\"]').click()" },
  { id: 'parameter-result-space', final: "const r=document.querySelector('input[type=range]');r.value=45;r.dispatchEvent(new Event('input',{bubbles:true}))" }
];

function getJson(route) {
  return new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: CDP_PORT, path: route }, response => {
    let body = '';
    response.on('data', chunk => { body += chunk; });
    response.on('end', () => resolve(JSON.parse(body)));
  }).on('error', reject));
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const tab = (await getJson('/json')).find(item => item.type === 'page');
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise(resolve => ws.once('open', resolve));
  let callId = 0;
  const pending = new Map();
  const exceptions = [];
  ws.on('message', payload => {
    const message = JSON.parse(payload.toString());
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  const call = (method, params = {}) => new Promise(resolve => {
    const id = ++callId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  await call('Runtime.enable');
  await call('Page.enable');
  const results = [];
  const inspect = async () => {
    const evaluated = await call('Runtime.evaluate', {
      expression: `(()=>{const root=document.querySelector('[data-template]'),step=root.dataset.step||null,takeaway=document.querySelector('.takeaway'),lastResult=[...document.querySelectorAll('.result-item')].at(-1),event=new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true});document.dispatchEvent(event);return JSON.stringify({
        template: document.querySelector('[data-template]').dataset.template,
        step,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        scrollHeight: document.documentElement.scrollHeight,
        clientHeight: document.documentElement.clientHeight,
        selectedPoints: document.querySelectorAll('.point.selected').length,
        resultItems: document.querySelectorAll('.result-item').length,
        distinctPointPositions: new Set([...document.querySelectorAll('.point')].map(node => {
          const box=node.getBoundingClientRect();return Math.round(box.left)+','+Math.round(box.top)
        })).size,
        resultOverlapsTakeaway: Boolean(lastResult&&takeaway&&lastResult.getBoundingClientRect().bottom>takeaway.getBoundingClientRect().top),
        pathNodes: document.querySelectorAll('[data-path-node]').length,
        activeScene: document.querySelectorAll('.scene.active').length,
        hostNavigationReleased: !event.defaultPrevented
      })})()`,
      returnByValue: true
    });
    return JSON.parse(evaluated.result.result.value);
  };
  for (const template of templates) {
    await call('Page.navigate', { url: `${BASE_URL}/${template.id}/slide.html` });
    await new Promise(resolve => setTimeout(resolve, 900));
    const initial = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(`${OUT}/${template.id}-initial.png`, Buffer.from(initial.result.data, 'base64'));
    const initialState = await inspect();
    await call('Runtime.evaluate', { expression: template.final });
    await new Promise(resolve => setTimeout(resolve, 500));
    const final = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(`${OUT}/${template.id}-final.png`, Buffer.from(final.result.data, 'base64'));
    const finalState = await inspect();
    results.push({ id: template.id, initial: initialState, final: finalState });
  }
  console.log(JSON.stringify({ results, exceptions }, null, 2));
  ws.close();
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
