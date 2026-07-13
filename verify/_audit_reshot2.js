// 复查2: factory-3d(验证空态叠加) + portal + scroll-board
require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const ADMIN_KEY = process.env.ADMIN_KEY || '12345678';
const OUT_DIR = path.join(__dirname, '_audit_shots_fold');
function httpReq(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = { hostname:'localhost', port:8080, path:p, method, headers:{} };
    if (data) { opts.headers['Content-Type']='application/json'; opts.headers['Content-Length']=Buffer.byteLength(data); }
    const r = http.request(opts, res => { let buf=''; res.on('data',d=>buf+=d); res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:buf})); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
(async () => {
  const lr = await httpReq('POST','/api/admin-login',{key:ADMIN_KEY});
  const session = (lr.headers['set-cookie']||[])[0]?.split(';')[0].split('=')[1] || '';
  const browser = await puppeteer.launch({ headless:'new', args:['--no-sandbox','--disable-dev-shm-usage'] });
  const errs = [];
  for (const [name, url] of [['factory-3d','/factory-3d.html'],['portal','/portal.html'],['scroll-board','/scroll-board.html']]) {
    const page = await browser.newPage();
    await page.setViewport({ width:1600, height:900, deviceScaleFactor:1 });
    page.on('pageerror', e => errs.push(name+':PE:'+e.message));
    page.on('console', m => { if (m.type()==='error') errs.push(name+':CE:'+m.text()); });
    await page.evaluateOnNewDocument(() => { try{localStorage.clear();sessionStorage.clear();}catch(e){} });
    await page.setCookie({ name:'session', value:session, domain:'localhost', path:'/' });
    await page.goto('http://localhost:8080'+url, { waitUntil:'networkidle2', timeout:30000 });
    await new Promise(r=>setTimeout(r, 6000));
    await page.screenshot({ path:path.join(OUT_DIR,name+'.png'), fullPage:false });
    if (name === 'factory-3d') {
      const t = await page.evaluate(() => {
        const ov = document.getElementById('factoryEmptyOverlay');
        return { hasOverlay: !!ov, display: ov ? ov.style.display : 'none', stationMeshesLen: -1 };
      });
      console.log('factory-3d overlay:', JSON.stringify(t));
    }
    if (name === 'portal') {
      const t = await page.evaluate(() => {
        const ids = ['kpiOutput','kpiFpy','kpiOee','kpiUpph','kpiPpm'];
        const r = {}; ids.forEach(id => { const el = document.getElementById(id); r[id] = el ? el.textContent.trim() : 'NOEL'; });
        return r;
      });
      console.log('portal kpi:', JSON.stringify(t));
    }
    if (name === 'scroll-board') {
      const t = await page.evaluate(() => {
        const ids = ['bProd','bFpy','bOee','bUpph','bFpySub','bOeeSub'];
        const r = {}; ids.forEach(id => { const el = document.getElementById(id); r[id] = el ? el.textContent.trim() : 'NOEL'; });
        return r;
      });
      console.log('scroll-board kpi:', JSON.stringify(t));
    }
    await page.close();
  }
  console.log('pageerrors:', errs.length, JSON.stringify(errs).slice(0,500));
  await browser.close();
  process.exit(0);
})();
