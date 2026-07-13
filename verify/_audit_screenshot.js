// 全站页面截图(视觉审计用): 登录拿 session -> 逐页访问 -> 存全页 PNG
require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const ADMIN_KEY = process.env.ADMIN_KEY || '12345678';
const OUT_DIR = path.join(__dirname, '_audit_shots');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

function httpReq(method, path2, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = { hostname:'localhost', port:8080, path:path2, method, headers:{} };
    if (data) { opts.headers['Content-Type']='application/json'; opts.headers['Content-Length']=Buffer.byteLength(data); }
    const r = http.request(opts, res => { let buf=''; res.on('data',d=>buf+=d); res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:buf})); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

// 全站主页面清单(按看板导航顺序)
const PAGES = [
  ['portal',        '/portal.html'],
  ['cockpit',       '/cockpit.html'],
  ['wip',           '/wip.html'],
  ['bad',           '/bad.html'],
  ['oee',           '/oee.html'],
  ['kanban',        '/kanban.html'],
  ['uph',           '/uph.html'],
  ['health',        '/health.html'],
  ['line-balance',  '/line-balance.html'],
  ['fixture-life',  '/fixture-life.html'],
  ['factory-3d',    '/factory-3d.html'],
  ['ai-center',     '/ai-center.html'],
  ['scroll-board',  '/scroll-board.html'],
  ['admin',         '/admin.html'],
  ['settings',      '/settings.html'],
];

(async () => {
  const lr = await httpReq('POST','/api/admin-login',{key:ADMIN_KEY});
  const setCookie = lr.headers['set-cookie']||[];
  const session = setCookie[0] ? setCookie[0].split(';')[0].split('=')[1] : '';
  if (!session) { console.error('登录失败:', lr.status, lr.body); process.exit(1); }
  console.log('登录OK, session len', session.length);

  const browser = await puppeteer.launch({ headless:'new', args:['--no-sandbox','--disable-dev-shm-usage','--force-device-scale-factor=1'] });
  const results = [];
  for (const [name, url] of PAGES) {
    const page = await browser.newPage();
    await page.setViewport({ width:1600, height:1000, deviceScaleFactor:1 });
    const errs = [];
    page.on('pageerror', e => errs.push('PE:'+e.message));
    page.on('console', m => { if (m.type()==='error') errs.push('CE:'+m.text()); });
    try {
      await page.evaluateOnNewDocument(() => { try{localStorage.clear();sessionStorage.clear();}catch(e){} });
      await page.setCookie({ name:'session', value:session, domain:'localhost', path:'/' });
      await page.goto('http://localhost:8080'+url, { waitUntil:'networkidle2', timeout:30000 });
      await new Promise(r=>setTimeout(r, 4500)); // 等图表/ECharts 渲染
      const out = path.join(OUT_DIR, name+'.png');
      await page.screenshot({ path:out, fullPage:true });
      const stat = fs.statSync(out);
      const title = await page.title();
      results.push({ name, ok:true, title, sizeKB:Math.round(stat.size/1024), errs:errs.slice(0,5) });
      console.log(`OK  ${name.padEnd(14)} ${Math.round(stat.size/1024)}KB  errs=${errs.length}  title="${title}"`);
    } catch (e) {
      results.push({ name, ok:false, err:String(e.message||e).slice(0,200) });
      console.log(`FAIL ${name}: ${e.message}`);
    }
    await page.close();
  }
  await browser.close();
  fs.writeFileSync(path.join(OUT_DIR,'_summary.json'), JSON.stringify(results,null,2));
  console.log('\nDONE ->', OUT_DIR);
  process.exit(0);
})();
