// 分屏截图: 对指定页滚动截多张首屏高度图, 覆盖首屏下方内容(视觉模型对 fullPage 长图超时, 改分屏)
// 用法: node verify/_audit_scroll_shot.js
require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const ADMIN_KEY = process.env.ADMIN_KEY || '12345678';
const OUT_DIR = path.join(__dirname, '_audit_shots_scroll');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
function httpReq(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = { hostname:'localhost', port:8080, path:p, method, headers:{} };
    if (data) { opts.headers['Content-Type']='application/json'; opts.headers['Content-Length']=Buffer.byteLength(data); }
    const r = http.request(opts, res => { let buf=''; res.on('data',d=>buf+=d); res.on('end',()=>resolve({headers:res.headers,body:buf})); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
// 聚焦 crosscheck 异常页: fixture-life(613个--) / line-balance(54个--) + portal(下方研判公告区首屏未覆盖)
const PAGES = [['fixture-life','/fixture-life.html', 4], ['line-balance','/line-balance.html', 3], ['portal','/portal.html', 3]];
(async () => {
  const lr = await httpReq('POST','/api/admin-login',{key:ADMIN_KEY});
  const session = (lr.headers['set-cookie']||[])[0]?.split(';')[0].split('=')[1] || '';
  const browser = await puppeteer.launch({ headless:'new', args:['--no-sandbox','--disable-dev-shm-usage'] });
  const VH = 900;
  for (const [name, url, screens] of PAGES) {
    const page = await browser.newPage();
    await page.setViewport({ width:1600, height:VH, deviceScaleFactor:1 });
    await page.evaluateOnNewDocument(() => { try{localStorage.clear();sessionStorage.clear();}catch(e){} });
    await page.setCookie({ name:'session', value:session, domain:'localhost', path:'/' });
    await page.goto('http://localhost:8080'+url, { waitUntil:'networkidle2', timeout:30000 });
    await new Promise(r=>setTimeout(r, 5000));
    const totalH = await page.evaluate(() => document.body.scrollHeight);
    console.log(`${name}: 总高 ${totalH}px, 截 ${Math.min(screens, Math.ceil(totalH/VH))} 屏`);
    for (let i = 0; i < screens; i++) {
      const y = i * VH;
      if (y >= totalH) break;
      await page.evaluate((yy) => window.scrollTo(0, yy), y);
      await new Promise(r=>setTimeout(r, 800));
      await page.screenshot({ path:path.join(OUT_DIR, `${name}_s${i}.png`), fullPage:false });
      console.log(`  ${name}_s${i}.png (scrollY=${y})`);
    }
    await page.close();
  }
  await browser.close();
  console.log('DONE ->', OUT_DIR);
  process.exit(0);
})();
