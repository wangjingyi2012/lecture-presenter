const fs = require('fs');
const path = require('path');

const BASE = __dirname;
const audit = JSON.parse(fs.readFileSync(path.join(BASE, 'output', 'audit.json'), 'utf8'));

function tags(slide) {
  const result = [];
  const { dom, source } = slide;
  if (dom.imgCount) result.push(`图片 ${dom.imgCount}`);
  if (dom.svgCount) result.push(`SVG ${dom.svgCount}`);
  if (dom.tableCount) result.push(`表格 ${dom.tableRows} 行`);
  if (dom.codeCount) result.push(`代码 ${dom.codeCount}`);
  if (dom.canvasCount) result.push('Canvas');
  if (dom.videoCount) result.push('视频');
  if (source.clickHandlers || source.stepStates) result.push(`分步/点击 ${source.clickHandlers + source.stepStates}`);
  if (source.keyframes) result.push(`关键帧 ${source.keyframes}`);
  if (source.grids) result.push(`网格 ${source.grids}`);
  if (source.flexes) result.push(`弹性布局 ${source.flexes}`);
  if (dom.scroll.width > dom.scroll.clientWidth || dom.scroll.height > dom.scroll.clientHeight) result.push('疑似溢出');
  return result;
}

function score(slide) {
  const { dom, source } = slide;
  const semantic = Math.min(dom.imgCount, 8) * 1.2 + Math.min(dom.svgCount, 12) * 0.45 + Math.min(dom.tableRows, 8) * 0.6 + Math.min(dom.codeCount, 6) * 0.5;
  const structure = Math.min(source.grids, 5) * 1.1 + Math.min(source.flexes, 8) * 0.5 + Math.min(dom.visibleCards, 18) * 0.15;
  const motion = Math.min(source.clickHandlers, 4) * 1.6 + Math.min(source.stepStates, 8) * 0.75 + Math.min(source.keyframes, 5) * 0.7;
  return Math.round((semantic + structure + motion) * 10) / 10;
}

const items = audit.decks.flatMap(deck => deck.slides.map(slide => ({ ...slide, deckId: deck.id, deckName: deck.name, tags: tags(slide), score: score(slide) })));
fs.writeFileSync(path.join(BASE, 'output', 'pages.json'), JSON.stringify(items, null, 2));

const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PPTE 页面资产普查</title><style>
*{box-sizing:border-box}body{margin:0;background:#f4f6f8;color:#172033;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}header{position:sticky;top:0;z-index:10;background:rgba(255,255,255,.96);border-bottom:1px solid #d9dee7;padding:14px 24px}.top{display:flex;align-items:center;gap:18px;flex-wrap:wrap}h1{font-size:20px;margin:0}.count{color:#667085}.filters{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}button,input{height:34px;border:1px solid #cfd6e1;background:#fff;border-radius:6px;padding:0 12px;font:inherit}button{cursor:pointer}button.active{background:#123d6a;color:#fff;border-color:#123d6a}.export{margin-left:auto}input{min-width:280px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px;padding:18px 24px 42px}.card{background:#fff;border:1px solid #d9dee7;border-radius:7px;overflow:hidden;box-shadow:0 2px 7px rgba(15,23,42,.05)}.card[data-current-rating="like"]{border-color:#21884a;box-shadow:0 0 0 2px rgba(33,136,74,.16)}.card[data-current-rating="dislike"]{opacity:.58}.thumb{display:block;aspect-ratio:16/9;background:#e5e9ef;overflow:hidden}.thumb img{width:100%;height:100%;display:block;object-fit:cover;transition:transform .2s}.thumb:hover img{transform:scale(1.02)}.meta{padding:11px 12px 12px}.line{display:flex;gap:8px;align-items:baseline}.num{font-weight:800;color:#123d6a;white-space:nowrap}.title{font-weight:750;line-height:1.35}.sub{margin-top:5px;color:#667085;font-size:13px}.tags{display:flex;gap:5px;flex-wrap:wrap;margin-top:8px}.tag{border:1px solid #d9dee7;background:#f8fafc;border-radius:4px;padding:2px 6px;color:#475467;font-size:12px}.score{margin-left:auto;color:#946200;font-size:12px;font-weight:800}.rating{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:10px}.rating button{height:30px;padding:0 6px;font-size:13px}.rating button.selected[data-rating="like"]{background:#e8f7ee;border-color:#21884a;color:#176236}.rating button.selected[data-rating="neutral"]{background:#fff6dd;border-color:#b7791f;color:#805800}.rating button.selected[data-rating="dislike"]{background:#f6e9e9;border-color:#a94442;color:#85312f}.empty{padding:80px;text-align:center;color:#667085}.hidden{display:none}</style></head><body>
<header><div class="top"><h1>PPTE 页面资产普查</h1><span class="count" id="count"></span><input id="search" placeholder="搜索标题、文件名或结构标签"><button class="export" id="exportRatings">导出评价</button></div><div class="filters"><button class="active" data-deck="all">全部</button>${audit.decks.map(deck => `<button data-deck="${deck.id}">${deck.name}</button>`).join('')}<button data-deck="interactive">有交互</button><button data-deck="image">含图片</button><button data-deck="table">表格</button><button data-deck="code">代码</button><button data-deck="rated">已评价</button></div></header>
<main class="grid" id="grid">${items.map(item => `<article class="card" data-key="${item.deckId}/${item.file}" data-deck="${item.deckId}" data-interactive="${item.source.clickHandlers > 0 || item.source.stepStates > 0}" data-image="${item.dom.imgCount > 0}" data-table="${item.dom.tableCount > 0}" data-code="${item.dom.codeCount > 0}" data-search="${[item.deckName,item.file,item.title,...item.tags].join(' ').replace(/"/g,'&quot;')}"><a class="thumb" href="${item.screenshot}" target="_blank"><img loading="lazy" src="${item.screenshot}" alt="${item.title.replace(/"/g,'&quot;')}"></a><div class="meta"><div class="line"><span class="num">${item.deckName} · ${String(item.order).padStart(2,'0')}</span><span class="score">结构分 ${item.score}</span></div><div class="title">${item.title}</div><div class="sub">${item.file} · ${item.slideType}</div><div class="tags">${item.tags.map(tag => `<span class="tag">${tag}</span>`).join('')}</div><div class="rating"><button data-rating="like">喜欢</button><button data-rating="neutral">一般</button><button data-rating="dislike">不喜欢</button></div></div></article>`).join('')}</main>
<script>const cards=[...document.querySelectorAll('.card')],count=document.getElementById('count'),search=document.getElementById('search'),filters=[...document.querySelectorAll('button[data-deck]')],storageKey='lecture-template-page-ratings-v1';let filter='all',ratings=JSON.parse(localStorage.getItem(storageKey)||'{}');function applyRatings(){cards.forEach(card=>{const value=ratings[card.dataset.key]||'';card.dataset.currentRating=value;card.dataset.rated=String(Boolean(value));card.querySelectorAll('[data-rating]').forEach(button=>button.classList.toggle('selected',button.dataset.rating===value))})}function render(){const q=search.value.trim().toLowerCase();let shown=0;cards.forEach(card=>{const matchFilter=filter==='all'||card.dataset.deck===filter||card.dataset[filter]==='true';const matchSearch=!q||card.dataset.search.toLowerCase().includes(q);const visible=matchFilter&&matchSearch;card.classList.toggle('hidden',!visible);if(visible)shown++});const rated=Object.keys(ratings).length;count.textContent=shown+' / '+cards.length+' 页 · 已评价 '+rated}filters.forEach(button=>button.addEventListener('click',()=>{filter=button.dataset.deck;filters.forEach(item=>item.classList.toggle('active',item===button));render()}));cards.forEach(card=>card.querySelectorAll('[data-rating]').forEach(button=>button.addEventListener('click',()=>{const key=card.dataset.key,value=button.dataset.rating;if(ratings[key]===value)delete ratings[key];else ratings[key]=value;localStorage.setItem(storageKey,JSON.stringify(ratings));applyRatings();render()})));search.addEventListener('input',render);document.getElementById('exportRatings').addEventListener('click',()=>{const payload={exportedAt:new Date().toISOString(),ratings};const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download='PPTE页面评价.json';link.click();URL.revokeObjectURL(link.href)});applyRatings();render();</script></body></html>`;

fs.writeFileSync(path.join(BASE, 'gallery.html'), html);
console.log(`Generated gallery for ${items.length} pages`);
