// 验证 UPH 页深度开发: 前端JS无pageerror + 关键元素渲染 + 截图
require('dotenv').config();
const puppeteer = require('puppeteer');
const ADMIN_KEY = process.env.ADMIN_KEY || '12345678';
const OUT = require('path').join(__dirname, '_uph_depth_out'); try{require('fs').mkdirSync(OUT,{recursive:true})}catch{}

(async()=>{
  const browser = await puppeteer.launch({ headless:'new', args:['--no-sandbox','--ignore-certificate-errors'] });
  const page = await browser.newPage();
  await page.setViewport({width:1600,height:1100});
  const errors = [];
  page.on('pageerror', e=>errors.push('pageerror: '+e.message));
  page.on('console', m=>{ if(m.type()==='error') errors.push('console: '+m.text().slice(0,150)); });

  // admin 登录
  await page.goto('http://127.0.0.1:8080/login',{waitUntil:'domcontentloaded',timeout:30000}).catch(()=>{});
  await page.evaluate(async (k)=>{ await fetch('/api/admin-login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:k})}).then(r=>r.json()).then(j=>{ if(j.success) document.cookie='session='+document.cookie.match(/session=([^;]+)/)?.[1]; }); }, ADMIN_KEY);
  // 用 admin-login 拿 cookie
  const loginResp = await page.evaluate(async (k)=>{ const r=await fetch('/api/admin-login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:k})}); return r.json(); }, ADMIN_KEY);
  // 取 set-cookie
  await page.goto('http://127.0.0.1:8080/api/admin-login',{waitUntil:'domcontentloaded'}).catch(()=>{});

  // 直接用 node http 拿 cookie 再注入 — 简化: 用 page.evaluate reload 带 cookie
  // 实际 admin-login 返回 set-cookie, puppeteer 自动存
  await page.goto('http://127.0.0.1:8080/uph.html',{waitUntil:'networkidle2',timeout:45000}).catch(e=>console.log('goto err:',e.message));
  await new Promise(r=>setTimeout(r,5000));

  await page.screenshot({path:require('path').join(OUT,'uph_full.png'),fullPage:true});

  // 检查关键元素
  const info = await page.evaluate(()=>{
    const get=id=>document.getElementById(id);
    return {
      granularCards: document.querySelectorAll('.uph-granular-card').length,
      granularFirstSub: document.querySelector('.ug-sub')?.textContent || '无',
      kpiUph: get('kpiUph')?.textContent,
      kpiTargetUphSub: get('kpiTargetUphSub')?.textContent,
      kpiAchieveSub: get('kpiAchieveSub')?.textContent,
      kpiCtSub: document.querySelector('#kpiCt + .kpi-sub')?.textContent,
      focusTrust: get('focusTrust')?.textContent,
      hourChartCanvas: !!document.querySelector('#hourChart canvas'),
      dimChartCanvas: !!document.querySelector('#dimChart canvas'),
      hourTitle: document.querySelector('#hourChart').closest('.chart-panel').querySelector('.chart-panel-title')?.textContent,
    };
  });
  console.log('=== 元素检查 ===');
  console.log(JSON.stringify(info,null,2));
  console.log('\n=== pageerror/console错误 ===');
  console.log(errors.length?errors.join('\n'):'无错误 ✓');
  console.log('\n[done] 截图:', OUT);
  await browser.close();
})().catch(e=>{console.error('FATAL:',e);process.exit(1)});
