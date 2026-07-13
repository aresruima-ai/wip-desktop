// 配色收口验证截图(2026-06-27):截改动涉及页面 + 收集console错误
require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const ADMIN_KEY = process.env.ADMIN_KEY || '12345678';
const OUT_DIR = path.join(__dirname, '_audit_color_shots');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
function httpReq(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = { hostname:'localhost', port:8080, path:p, method, headers:{} };
    if (data) { opts.headers['Content-Type']='application/json'; opts.headers['Content-Length']=Buffer.byteLength(data); }
    const r = http.request(opts, res => { let buf=''; res.on('data',d=>buf+=d); res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:buf})); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const AUTH_PAGES = [
  ['cockpit','/cockpit.html'],['portal','/portal.html'],['wip','/wip.html'],
  ['ai-center','/ai-center.html'],['bad','/bad.html'],
];
const NOAUTH_PAGES = [['login','/login.html']];
(async () => {
  const lr = await httpReq('POST','/api/admin-login',{key:ADMIN_KEY});
  const session = (lr.headers['set-cookie']||[])[0] && (lr.headers['set-cookie'][0].split(';')[0].split('=')[1]) || '';
  if (!session) { console.error('登录失败 ADMIN_KEY='+ADMIN_KEY); process.exit(1); }
  console.log('登录OK');
  const browser = await puppeteer.launch({ headless:'new', args:['--no-sandbox','--disable-dev-shm-usage'] });
  const errors = {};
  for (const [name, url] of [...AUTH_PAGES, ...NOAUTH_PAGES]) {
    const page = await browser.newPage();
    await page.setViewport({ width:1600, height:900, deviceScaleFactor:1 });
    const errs = [];
    page.on('console', m => { if (m.type()==='error') errs.push(m.text()); });
    page.on('pageerror', e => errs.push('PAGEERROR: '+e.message));
    try {
      await page.evaluateOnNewDocument(() => { try{localStorage.clear();sessionStorage.clear();}catch(e){} });
      if (AUTH_PAGES.find(p=>p[0]===name)) {
        await page.setCookie({ name:'session', value:session, domain:'localhost', path:'/' });
      }
      await page.goto('http://localhost:8080'+url, { waitUntil:'networkidle2', timeout:30000 });
      await new Promise(r=>setTimeout(r, 5000));
      await page.screenshot({ path:path.join(OUT_DIR,name+'.png'), fullPage:false });
      errors[name] = errs;
      console.log('OK', name, errs.length?('errs='+errs.length):'clean');
    } catch(e) { console.log('FAIL', name, e.message); errors[name]=[e.message]; }
    await page.close();
  }
  await browser.close();
  fs.writeFileSync(path.join(OUT_DIR,'_console_errors.json'), JSON.stringify(errors,null,2));
  console.log('DONE ->', OUT_DIR);
  process.exit(0);
})();
