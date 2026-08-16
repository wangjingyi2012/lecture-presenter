const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');

const CDP_PORT = 9227;
const BASE_URL = 'http://127.0.0.1:8769';
const OUT = '/tmp/lecture-basic-templates';
const templates = [
  { id: 'key-message-evidence', item: '.evidence-item', target: '[data-evidence]', max: 4, boundary: '.message-layout' },
  { id: 'concept-definition-boundary', item: '.attribute', target: '[data-attributes]', max: 4, boundary: '.definition-layout' },
  { id: 'structured-paragraph-aside', item: '.section', target: '[data-sections]', max: 3, boundary: '.paragraph-layout' },
  { id: 'numbered-key-points', item: '.point-item', target: '[data-items]', max: 6, boundary: '.point-list' },
  { id: 'two-object-comparison', item: '.dimension', target: '[data-dimensions]', max: 6, boundary: '.rows' },
  { id: 'case-facts-conclusion', item: '.fact', target: '[data-facts]', max: 5, boundary: '.case-layout' }
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
  await call('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });

  const results = [];
  for (const template of templates) {
    await call('Page.navigate', { url: `${BASE_URL}/${template.id}/slide.html` });
    await new Promise(resolve => setTimeout(resolve, 350));
    const initial = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(`${OUT}/${template.id}-initial.png`, Buffer.from(initial.result.data, 'base64'));

    await call('Runtime.evaluate', {
      expression: `(()=>{const target=document.querySelector(${JSON.stringify(template.target)}),source=document.querySelector(${JSON.stringify(template.item)});while(target&&source&&target.querySelectorAll(${JSON.stringify(template.item)}).length<${template.max}){const clone=source.cloneNode(true);clone.querySelectorAll('span,p').forEach(node=>{if(node.textContent.length>8)node.textContent+='，并保留必要的验证依据'});target.appendChild(clone)}if(target&&target.matches('[data-attributes]')&&target.children.length===4)target.style.gridTemplateColumns='repeat(2,1fr)'})()`
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    const pressure = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(`${OUT}/${template.id}-pressure.png`, Buffer.from(pressure.result.data, 'base64'));

    const evaluated = await call('Runtime.evaluate', {
      expression: `(()=>{const boundary=document.querySelector(${JSON.stringify(template.boundary)}),takeaway=document.querySelector('.takeaway,.lesson'),items=[...document.querySelectorAll(${JSON.stringify(template.item)})],boxes=items.map(node=>node.getBoundingClientRect());return JSON.stringify({
        id:${JSON.stringify(template.id)},
        itemCount:items.length,
        scrollWidth:document.documentElement.scrollWidth,
        clientWidth:document.documentElement.clientWidth,
        scrollHeight:document.documentElement.scrollHeight,
        clientHeight:document.documentElement.clientHeight,
        boundaryInsideViewport:Boolean(boundary&&boundary.getBoundingClientRect().top>=0&&boundary.getBoundingClientRect().bottom<=innerHeight),
        overlapsTakeaway:Boolean(takeaway&&boxes.some(box=>box.bottom>takeaway.getBoundingClientRect().top)),
        itemsOutsideBoundary:boundary?boxes.filter(box=>box.left<boundary.getBoundingClientRect().left-1||box.right>boundary.getBoundingClientRect().right+1||box.top<boundary.getBoundingClientRect().top-1||box.bottom>boundary.getBoundingClientRect().bottom+1).length:items.length
      })})()`,
      returnByValue: true
    });
    results.push(JSON.parse(evaluated.result.result.value));
  }
  console.log(JSON.stringify({ results, exceptions }, null, 2));
  ws.close();
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
