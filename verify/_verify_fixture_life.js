// 临时验证: fixture-life.html 渲染无JS错误. 用完即删.
const puppeteer = require('puppeteer');
const BASE = 'http://localhost:8080';
(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });
  // 登录拿 cookie
  await page.goto(BASE + '/portal.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    await fetch('/api/admin-login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({key:'12345678'}) });
  });
  // 加载 fixture-life
  await page.goto(BASE + '/fixture-life.html', { waitUntil: 'networkidle0', timeout: 20000 });
  await new Promise(r => setTimeout(r, 2500));
  // 检查渲染结果
  const res = await page.evaluate(() => {
    const cabRows = document.querySelectorAll('#cableTable tbody tr').length;
    const fxRows = document.querySelectorAll('#fixtureTable tbody tr').length;
    const g = id => document.getElementById(id) ? document.getElementById(id).textContent.trim() : 'NA';
    const bodyText = document.body.innerText;
    const hasNaN = bodyText.includes('NaN') || bodyText.includes('undefined');
    const hasLoading = bodyText.includes('加载中') && !bodyText.includes('更新于');
    const tags = {};
    document.querySelectorAll('#fixtureTable .tag, #cableTable .tag').forEach(t => { const s=t.textContent.trim(); tags[s]=(tags[s]||0)+1; });
    return {
      cabRows, fxRows,
      focusTitle: g('focusTitle'),
      kpiHealth: g('kpiHealthVal'), kpiAsset: g('kpiAssetVal'),
      kpiTracked: g('kpiTrackedVal'), kpiNew: g('kpiNewVal'),
      pieCanvas: !!document.querySelector('#stagePie canvas'),
      scrapPanel: !!document.getElementById('scrapTable'),
      stageTags: tags, hasNaN, hasLoading
    };
  });
  console.log('=== 渲染结果 ===');
  console.log(JSON.stringify(res, null, 2));
  console.log('\n=== JS 错误(' + errs.length + ') ===');
  errs.slice(0, 10).forEach(e => console.log(e));
  await browser.close();
  process.exit(errs.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
