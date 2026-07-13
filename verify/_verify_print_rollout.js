const puppeteer = require('puppeteer');
async function check(page, url, period) {
  await page.goto('http://localhost:8080/login.html', { waitUntil: 'networkidle2' });
  await page.type('input[type="text"]', 'yangning').catch(()=>{});
  await page.type('input[type="password"]', 'Yn@20250908').catch(()=>{});
  await Promise.all([page.waitForNavigation({waitUntil:'networkidle2'}).catch(()=>{}), page.click('button[type=submit]').catch(()=>{})]);
  await page.goto(url, { waitUntil: 'networkidle2' });
  await new Promise(r=>setTimeout(r, 8000));
  if (period) { await page.select('#periodSelect', period).catch(()=>{}); await new Promise(r=>setTimeout(r, 6000)); }
  return await page.evaluate(() => {
    if (typeof autoPrintCharts === 'undefined') return { err: 'autoPrintCharts undefined' };
    autoPrintCharts.enter();
    const imgs = document.querySelectorAll('.__print_chart_img').length;
    const locked = document.querySelectorAll('[data-print-chart]').length;
    const neutral = !!document.getElementById('__print_neutral');
    autoPrintCharts.exit();
    const restored = document.querySelectorAll('.__print_chart_img').length === 0 && document.querySelectorAll('[data-print-chart]').length === 0 && !document.getElementById('__print_neutral');
    return { imgsInjected: imgs, chartsMarked: locked, neutralAdded: neutral, restored: restored };
  });
}
(async () => {
  const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const p = await b.newPage();
  const errs = [];
  p.on('pageerror', e=>errs.push('PAGEERROR:'+e.message));
  p.on('console', m=>{ if(m.type()==='error') errs.push('ERR:'+m.text()); });
  const bad = await check(p, 'http://localhost:8080/bad.html', 'month');
  const wip = await check(p, 'http://localhost:8080/wip.html', 'month');
  const oee = await check(p, 'http://localhost:8080/oee.html', 'month');
  const cockpit = await check(p, 'http://localhost:8080/cockpit.html', null);
  console.log('BAD:', JSON.stringify(bad));
  console.log('WIP:', JSON.stringify(wip));
  console.log('OEE:', JSON.stringify(oee));
  console.log('COCKPIT:', JSON.stringify(cockpit));
  console.log('errs:', errs.filter(e=>!/WebSocket|ERR_CONNECTION|net::ERR|favicon/i.test(e)).slice(0,5).join(' | '));
  const ok = r => r && !r.err && r.imgsInjected > 0 && r.restored;
  console.log('\nBAD:', ok(bad), '| WIP:', ok(wip), '| OEE:', ok(oee), '| COCKPIT:', ok(cockpit));
  await b.close();
  process.exit(ok(bad)&&ok(wip)&&ok(oee)&&ok(cockpit)?0:1);
})().catch(e=>{console.error(e.message);process.exit(1);});
