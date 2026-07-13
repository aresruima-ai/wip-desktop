// 首屏截图(视口尺寸,图小便于视觉模型读取)
require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const ADMIN_KEY = process.env.ADMIN_KEY || '12345678';
const OUT_DIR = path.join(__dirname, '_audit_shots_fold');
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
const PAGES = [
  ['portal','/portal.html'],['cockpit','/cockpit.html'],['wip','/wip.html'],['bad','/bad.html'],
  ['oee','/oee.html'],['kanban','/kanban.html'],['uph','/uph.html'],['health','/health.html'],
  ['line-balance','/line-balance.html'],['fixture-life','/fixture-life.html'],['factory-3d','/factory-3d.html'],
  ['ai-center','/ai-center.html'],['scroll-board','/scroll-board.html'],['admin','/admin.html'],['settings','/settings.html'],
];
(async () => {
  const lr = await httpReq('POST','/api/admin-login',{key:ADMIN_KEY});
  const session = (lr.headers['set-cookie']||[])[0]?.split(';')[0].split('=')[1] || '';
  if (!session) { console.error('登录失败'); process.exit(1); }
  const browser = await puppeteer.launch({ headless:'new', args:['--no-sandbox','--disable-dev-shm-usage'] });
  for (const [name, url] of PAGES) {
    const page = await browser.newPage();
    await page.setViewport({ width:1600, height:900, deviceScaleFactor:1 });
    try {
      await page.evaluateOnNewDocument(() => { try{localStorage.clear();sessionStorage.clear();}catch(e){} });
      await page.setCookie({ name:'session', value:session, domain:'localhost', path:'/' });
      await page.goto('http://localhost:8080'+url, { waitUntil:'networkidle2', timeout:30000 });
      await new Promise(r=>setTimeout(r, 4500));
      await page.screenshot({ path:path.join(OUT_DIR,name+'.png'), fullPage:false });
      console.log('OK', name);
    } catch(e) { console.log('FAIL', name, e.message); }
    await page.close();
  }
  await browser.close();
  console.log('DONE ->', OUT_DIR);
  process.exit(0);
})();
