// 验证导出横展 v3: bad/oee 用 month(有数据), portal 默认。图表可见(red像素)+清理干净
const puppeteer = require('puppeteer');
async function testExport(page, url, fnName, period) {
  await page.goto('http://localhost:8080/login.html', { waitUntil: 'networkidle2' });
  await page.type('input[type="text"]', 'yangning').catch(()=>{});
  await page.type('input[type="password"]', 'Yn@20250908').catch(()=>{});
  await Promise.all([page.waitForNavigation({waitUntil:'networkidle2'}).catch(()=>{}), page.click('button[type=submit]').catch(()=>{})]);
  await page.goto(url, { waitUntil: 'networkidle2' });
  await new Promise(r=>setTimeout(r, 8000));
  if (period) { await page.select('#periodSelect', period).catch(()=>{}); await new Promise(r=>setTimeout(r, 7000)); }
  await page.addScriptTag({ url: 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js' }).catch(()=>{});
  await new Promise(r=>setTimeout(r, 2000));
  const r = await page.evaluate(async (fnName) => {
    let href = null;
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function(){ if(this.href && this.href.startsWith('data:image')) href = this.href; else orig.call(this); };
    try { window[fnName](); } catch(e){ HTMLAnchorElement.prototype.click = orig; return { err: 'threw: '+e.message }; }
    for (let i=0;i<60;i++){ if(href) break; await new Promise(r=>setTimeout(r,500)); }
    HTMLAnchorElement.prototype.click = orig;
    if(!href) return { err: 'timeout' };
    const img = await new Promise(res=>{ const im=new Image(); im.onload=()=>res(im); im.onerror=()=>res(null); im.src=href; });
    if(!img) return { err: 'img load' };
    const c=document.createElement('canvas'); c.width=img.width; c.height=img.height;
    const ctx=c.getContext('2d'); ctx.drawImage(img,0,0);
    const W=c.width,H=c.height,bgRgb=[10,13,18]; let n=0,t=0,red=0;
    for(let y=0;y<H;y+=16){for(let x=0;x<W;x+=16){t++;const d=ctx.getImageData(x,y,1,1).data;if(Math.abs(d[0]-bgRgb[0])>25||Math.abs(d[1]-bgRgb[1])>25||Math.abs(d[2]-bgRgb[2])>25)n++;if(d[0]>120&&d[1]<90&&d[2]<90)red++;}}
    return { W, H, ratio:(n/t).toFixed(4), red, neutralRemoved: !document.getElementById('__h2c_neutral'), chartMarkRemoved: document.querySelectorAll('[data-h2c-chart]').length===0 };
  }, fnName);
  return r;
}
(async () => {
  const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const p = await b.newPage();
  const errs = [];
  p.on('pageerror', e=>errs.push('PAGEERROR:'+e.message));
  p.on('console', m=>{ if(m.type()==='error') errs.push('ERR:'+m.text()); });
  const bad = await testExport(p, 'http://localhost:8080/bad.html', 'exportBadPage', 'month');
  const oee = await testExport(p, 'http://localhost:8080/oee.html', 'exportOeePage', 'month');
  const portal = await testExport(p, 'http://localhost:8080/portal.html', 'exportAnnouncements', null);
  console.log('BAD:', JSON.stringify(bad));
  console.log('OEE:', JSON.stringify(oee));
  console.log('PORTAL:', JSON.stringify(portal));
  console.log('errs:', errs.filter(e=>!/WebSocket|ERR_CONNECTION|net::ERR|favicon/i.test(e)).slice(0,5).join(' | '));
  const ok = (r, needRed) => r && !r.err && r.neutralRemoved && r.chartMarkRemoved && (needRed ? r.red > 30 : +r.ratio > 0.01);
  console.log('\nBAD PASS:', ok(bad,true), '| OEE PASS:', ok(oee,true), '| PORTAL PASS:', ok(portal,false));
  await b.close();
  process.exit(ok(bad,true)&&ok(oee,true)&&ok(portal,false) ? 0 : 1);
})().catch(e=>{console.error(e.message);process.exit(1);});
