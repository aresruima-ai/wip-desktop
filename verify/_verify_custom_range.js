// 验证全站7页自定义日期范围(ai-center/bad/health/kanban/line-balance/oee/wip)
// 运行: node _verify_custom_range.js
const puppeteer = require('puppeteer');
const BASE = 'http://localhost:8080';
const PAGES = ['ai-center', 'bad', 'health', 'kanban', 'line-balance', 'oee', 'wip'];

(async () => {
  const r = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'yangning', password: 'Yn@20250908' }) });
  const m = (r.headers.get('set-cookie') || '').match(/session=([^;]+)/);
  if (!m) { console.error('login failed'); process.exit(1); }
  const cookie = m[1];
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
  let allOk = true;

  for (const page of PAGES) {
    const p = await browser.newPage();
    await p.setViewport({ width: 1920, height: 1080 });
    await p.setCookie({ name: 'session', value: cookie, domain: 'localhost', path: '/' });
    const errs = [];
    p.on('pageerror', e => errs.push(e.message));
    p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
    try {
      await p.goto(BASE + '/' + page + '.html?_t=' + Date.now(), { waitUntil: 'networkidle2', timeout: 30000 });
      await new Promise(r => setTimeout(r, 3500));
      // 选 custom
      const res = await p.evaluate(() => {
        const sel = document.getElementById('periodSelect');
        if (!sel) return { err: '无periodSelect' };
        const hasOpt = !!sel.querySelector('option[value="custom"]');
        if (!hasOpt) return { err: '无custom选项' };
        sel.value = 'custom';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return { hasOpt: true };
      });
      if (res.err) { console.log('✗ ' + page + ': ' + res.err); allOk = false; await p.close(); continue; }
      await new Promise(r => setTimeout(r, 600));
      // 确认 date input 显示
      const vis = await p.evaluate(() => {
        const pc = document.querySelector('.period-custom');
        const from = pc && pc.querySelector('.cust-from');
        const to = pc && pc.querySelector('.cust-to');
        const btn = pc && pc.querySelector('.cust-apply');
        return { show: pc && pc.style.display !== 'none', hasFrom: !!from, hasTo: !!to, hasBtn: !!btn };
      });
      if (!vis.show || !vis.hasFrom || !vis.hasBtn) { console.log('✗ ' + page + ': custom日期区未显示 show=' + vis.show); allOk = false; await p.close(); continue; }
      // 输入日期 + 应用
      await p.evaluate(() => {
        const pc = document.querySelector('.period-custom');
        pc.querySelector('.cust-from').value = '2026-06-15';
        pc.querySelector('.cust-to').value = '2026-06-20';
        pc.querySelector('.cust-apply').click();
      });
      await new Promise(r => setTimeout(r, 2500));
      // 确认 localStorage 已存 + 无错误
      const stored = await p.evaluate(() => { try { return JSON.parse(localStorage.getItem('_wipui_custom_range')); } catch (e) { return null; } });
      const ok = stored && stored.dateFrom === '2026-06-15' && stored.dateTo === '2026-06-20' && errs.length === 0;
      if (!ok) allOk = false;
      console.log((ok ? '✓' : '✗') + ' ' + page + ': custom显示=' + vis.show + ' 应用后存储=' + JSON.stringify(stored) + ' 错误=' + errs.length);
      if (errs.length) errs.slice(0, 3).forEach(e => console.log('    ' + e.slice(0, 120)));
    } catch (e) {
      console.log('✗ ' + page + ': ' + e.message.slice(0, 80)); allOk = false;
    }
    await p.close();
  }
  await browser.close();
  console.log('\n=== ' + (allOk ? 'ALL PASS (7页自定义日期范围正常)' : 'FAIL') + ' ===');
  process.exit(allOk ? 0 : 1);
})();
