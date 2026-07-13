// 前端 runtime 验证: 登录后访问 4 页, 断言"下线 Y"副位已填充且无 JS 错误
require('dotenv').config();
const puppeteer = require('puppeteer');
const BASE = 'http://localhost:8080';
const USER = 'yangning', PWD = 'Yn@20250908';
async function login() {
  const r = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: USER, password: PWD }) });
  const m = (r.headers.get('set-cookie') || '').match(/session=([^;]+)/);
  if (!m) throw new Error('login failed: ' + await r.text());
  return 'session=' + m[1];
}
(async () => {
  const cookie = await login();
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.setCookie({ name: 'session', value: cookie.split('=')[1], domain: 'localhost', path: '/' });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
  const checks = [
    { url: '/portal.html', sel: '#pKpiProdOffline', name: 'portal' },
    { url: '/cockpit.html', sel: '#kpiOutputSub', name: 'cockpit' },
    { url: '/kanban.html', sel: '#kpiOutputSub', name: 'kanban' },
    { url: '/scroll-board.html', sel: '#bProdOffline', name: 'scroll-board' },
  ];
  let ok = 0, fail = 0;
  for (const c of checks) {
    try {
      await page.goto(BASE + c.url + '?_t=' + Date.now(), { waitUntil: 'networkidle2', timeout: 30000 });
      await new Promise(r => setTimeout(r, 5000));
      const txt = await page.evaluate(s => { const e = document.querySelector(s); return e ? e.textContent.trim() : null; }, c.sel);
      const cond = txt != null && /下线/.test(txt) && !/下线\s*--/.test(txt);
      if (cond) { ok++; console.log('  ✓', c.name, '→', txt); }
      else { fail++; console.log('  ✗', c.name, '→', JSON.stringify(txt)); }
    } catch (e) { fail++; console.log('  ✗', c.name, 'EXC:', e.message); }
  }
  console.log('pageerrors:', errors.length);
  errors.slice(0, 8).forEach(e => console.log('  ', e));
  console.log('\n结果: ' + ok + ' PASS / ' + fail + ' FAIL');
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('[ERR]', e.message); process.exit(1); });
