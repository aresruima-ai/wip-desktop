// 复查: 仅 bad + oee 首屏
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
  for (const [name, url] of [['bad','/bad.html'],['oee','/oee.html']]) {
    const page = await browser.newPage();
    await page.setViewport({ width:1600, height:900, deviceScaleFactor:1 });
    await page.evaluateOnNewDocument(() => { try{localStorage.clear();sessionStorage.clear();}catch(e){} });
    await page.setCookie({ name:'session', value:session, domain:'localhost', path:'/' });
    await page.goto('http://localhost:8080'+url, { waitUntil:'networkidle2', timeout:30000 });
    await new Promise(r=>setTimeout(r, 5000));
    await page.screenshot({ path:path.join(OUT_DIR,name+'.png'), fullPage:false });
    // 抓取焦点壳文本验证
    if (name === 'bad') {
      const txt = await page.evaluate(() => ({
        fpy: document.getElementById('focusFpy')?.textContent,
        fpyHint: document.getElementById('focusFpyHint')?.textContent,
        closure: document.getElementById('focusClosure')?.textContent,
        closureHint: document.getElementById('focusClosureHint')?.textContent,
        closureSub: document.getElementById('focusClosureSub')?.textContent,
        side1cls: document.getElementById('focusSide1')?.className,
      }));
      console.log('BAD focus:', JSON.stringify(txt));
    }
    if (name === 'oee') {
      const txt = await page.evaluate(() => ({
        kpiOee: document.getElementById('kpiOeeVal')?.textContent,
        bodyText: document.body.innerText.match(/null[^<\n]{0,8}/g),
      }));
      console.log('OEE kpiOee:', JSON.stringify(txt));
    }
    await page.close();
  }
  await browser.close();
  console.log('DONE');
  process.exit(0);
})();
