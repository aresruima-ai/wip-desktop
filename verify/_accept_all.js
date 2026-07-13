// 全站验收: 15页 pageerror + 关键改动点 DOM 验证 + 截图
require('dotenv').config();
const http = require('http');
const path = require('path');
const puppeteer = require('puppeteer');
const ADMIN_KEY = process.env.ADMIN_KEY || '12345678';
const OUT = path.join(__dirname, '_audit_shots_fold');
function httpReq(m, p, b) {
  return new Promise((rs, rj) => { const d=b?JSON.stringify(b):null; const o={hostname:'localhost',port:8080,path:p,method:m,headers:{}}; if(d){o.headers['Content-Type']='application/json';o.headers['Content-Length']=Buffer.byteLength(d)} const r=http.request(o,res=>{let buf='';res.on('data',d=>buf+=d);res.on('end',()=>rs({headers:res.headers,body:buf}))}); r.on('error',rj); if(d)r.write(d); r.end() });
}
const PAGES = [
  ['portal','/portal.html'],['cockpit','/cockpit.html'],['wip','/wip.html'],['bad','/bad.html'],
  ['oee','/oee.html'],['kanban','/kanban.html'],['uph','/uph.html'],['health','/health.html'],
  ['line-balance','/line-balance.html'],['fixture-life','/fixture-life.html'],['factory-3d','/factory-3d.html'],
  ['ai-center','/ai-center.html'],['scroll-board','/scroll-board.html'],['admin','/admin.html'],['settings','/settings.html'],
];
// 各页验收点(DOM 抓取)
const CHECKS = {
  portal: () => ({ title: document.querySelector('.focus-title')?.innerText, hasProdMeta: !!document.querySelector('.focus-prod-meta'), upphHint: document.getElementById('pKpiUpphHint')?.textContent, hasAttnSkeleton: !!document.querySelector('.attn-skeleton'), hasOldEmpty: !!document.querySelector('.announce-empty') }),
  bad: () => ({ fpy: document.getElementById('focusFpy')?.textContent, fpyHint: document.getElementById('focusFpyHint')?.textContent, closureHint: document.getElementById('focusClosureHint')?.textContent }),
  fixture_life: () => ({ bodyH: document.body.scrollHeight, fixtureRows: document.querySelectorAll('#fixtureTable tbody tr').length, fixturePager: document.getElementById('fixturePager')?.innerText?.slice(0,40), cablePager: document.getElementById('cablePager')?.innerText?.slice(0,40) }),
  kanban: () => ({ kpiOutput: document.getElementById('kpiOutput')?.textContent, kpiLines: document.getElementById('kpiLines')?.textContent }),
  health: () => ({ hasOldEmpty: !!document.querySelector('.event-empty'), hasAttnEmpty: !!document.querySelector('.attn-empty') }),
  cockpit: () => ({ fmKpi3: document.getElementById('fmKpi3')?.textContent }),
  admin: () => ({ btnPad: document.querySelector('.btn-sys') ? getComputedStyle(document.querySelector('.btn-sys')).padding : 'NOBTN' }),
  settings: () => ({ btnPad: document.querySelector('.btn-sys') ? getComputedStyle(document.querySelector('.btn-sys')).padding : 'NOBTN' }),
};
(async () => {
  const lr = await httpReq('POST','/api/admin-login',{key:ADMIN_KEY});
  const session = (lr.headers['set-cookie']||[])[0]?.split(';')[0].split('=')[1] || '';
  const browser = await puppeteer.launch({ headless:'new', args:['--no-sandbox','--disable-dev-shm-usage'] });
  let totalErr = 0;
  console.log('页名             pageerror  验收点');
  console.log('─'.repeat(80));
  for (const [name, url] of PAGES) {
    const page = await browser.newPage();
    await page.setViewport({ width:1600, height:900, deviceScaleFactor:1 });
    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    page.on('console', m => { if (m.type()==='error') errs.push('CE:'+m.text().slice(0,80)); });
    try {
      await page.evaluateOnNewDocument(() => { try{localStorage.clear();sessionStorage.clear();}catch(e){} });
      await page.setCookie({ name:'session', value:session, domain:'localhost', path:'/' });
      await page.goto('http://localhost:8080'+url, { waitUntil:'networkidle2', timeout:30000 });
      await new Promise(r=>setTimeout(r, 5000));
      const key = name.replace('-','_');
      let checkStr = '';
      if (CHECKS[key]) { try { const c = await page.evaluate(CHECKS[key]); checkStr = JSON.stringify(c); } catch(e){ checkStr = 'CHECK_ERR:'+e.message; } }
      await page.screenshot({ path:path.join(OUT,name+'.png'), fullPage:false });
      totalErr += errs.length;
      console.log(name.padEnd(17), String(errs.length).padStart(6), errs.length?'⚠ '+errs.slice(0,2).join(' | '):'OK', checkStr);
    } catch(e) { console.log(name.padEnd(17), 'LOAD_ERR:', e.message); totalErr++; }
    await page.close();
  }
  await browser.close();
  console.log('─'.repeat(80));
  console.log('总 pageerror:', totalErr);
  process.exit(0);
})();
