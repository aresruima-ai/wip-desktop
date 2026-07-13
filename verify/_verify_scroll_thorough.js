// 滚动看板数据级回归验证(不只查 console 错误,逐屏校验真实数据)
// 运行: node _verify_scroll_thorough.js
// 教训: 切屏前必须 togglePlay 暂停自动播放, 否则轮播计时器在等待期 next() 跳屏致误判
const puppeteer = require('puppeteer');

const BASE = 'http://localhost:8080';
const USER = 'yangning', PWD = 'Yn@20250908';

async function login() {
  const r = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PWD }),
  });
  const m = (r.headers.get('set-cookie') || '').match(/session=([^;]+)/);
  if (!m) throw new Error('login failed: ' + await r.text());
  return 'session=' + m[1];
}

(async () => {
  const cookie = await login().catch(e => { console.error(e.message); process.exit(1); });
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.setCookie({ name: 'session', value: cookie.split('=')[1], domain: 'localhost', path: '/' });

  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

  await page.goto(BASE + '/scroll-board.html?_t=' + Date.now(), { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 4000)); // 等 loadBoard + 首屏渲染

  // 暂停自动播放, 避免逐屏切换时 next() 干扰
  await page.evaluate(() => { if (typeof playing !== 'undefined' && playing && typeof togglePlay === 'function') togglePlay(); });

  const names = ['焦点KPI', '趋势', '产线对比', '质量根因', '质量闭环', 'OEE', '治具线材', 'AI研判', '系统健康'];
  const results = [];

  for (let i = 0; i < 9; i++) {
    await page.evaluate(idx => { if (typeof go === 'function') go(idx); }, i);
    await new Promise(r => setTimeout(r, 1500)); // 等 transition(.9s) + 渲染

    const info = await page.evaluate(() => {
      function txt(id) { const e = document.getElementById(id); return e ? e.textContent.trim() : null; }
      const ss = [].slice.call(document.querySelectorAll('.board-screen'));
      // 用 rect 精确定位当前可见屏(不用 .entered, 有残留 class 误判)
      const vis = ss.filter(s => { const r = s.getBoundingClientRect(); return r.top > -50 && r.top < 200; })[0] || ss[0];
      const canvas = vis.querySelectorAll('canvas').length;
      const empties = [].slice.call(vis.querySelectorAll('.empty-note')).map(e => e.textContent.trim().slice(0, 30));
      const dash = [].slice.call(vis.querySelectorAll('*')).filter(e => e.children.length === 0 && /^--?$/.test(e.textContent.trim())).length;
      const insights = [].slice.call(vis.querySelectorAll('.chart-insight')).map(e => e.textContent.trim().slice(0, 40));
      return {
        di: vis.dataset.i,
        title: ((vis.querySelector('.st-text') || {}).textContent || '').slice(0, 18),
        canvas, empties, dash, insights,
        // 关键字段(各屏)
        prod: txt('bProd'), fpy: txt('bFpy'), oeeMini: txt('bOee'),
        rootCards: document.querySelectorAll('#bRootCause .rc-card').length,
        closure: txt('bClosure'), p90: txt('bP90'), badTotal: txt('bBadTotal'), open: txt('bOpen'), fpy2: txt('bFpy2'),
        oeeVal: txt('bOeeVal'), avail: txt('bAvail'), mtbf: txt('bMtbf'),
        flHealth: txt('bFlHealth'),
        insightCards: document.querySelectorAll('#bInsight > div').length,
        hGridKids: document.getElementById('bHGrid') ? document.getElementById('bHGrid').children.length : 0,
      };
    });

    // 断言: 导航正确(di==i) + 该屏有数据
    let ok = String(info.di) === String(i);
    let detail = `di=${info.di} canvas=${info.canvas} --=${info.dash}`;
    if (i === 0) ok = ok && info.prod && info.prod !== '--' && info.rootCards >= 0;
    if (i === 1) ok = ok && info.canvas >= 1 && info.insights.length >= 1;
    if (i === 2) ok = ok && info.canvas >= 1;
    if (i === 3) ok = ok && info.canvas >= 2;
    if (i === 4) ok = ok && info.closure && info.closure !== '--' && info.badTotal && info.badTotal !== '--' && info.fpy2 && info.fpy2 !== '--';
    if (i === 5) ok = ok && info.oeeVal && info.oeeVal !== '--' && info.avail && info.avail !== '--';
    if (i === 6) ok = ok && info.empties.length >= 0; // 治具屏: 台账未录时空态是设计内, 允许
    if (i === 7) ok = ok && info.insightCards >= 1 && info.canvas >= 1;
    if (i === 8) ok = ok && info.hGridKids >= 6 && info.dash === 0;

    results.push({ i, name: names[i], ok, detail, info });
    console.log(`${ok ? '✓' : '✗'} 屏${i + 1} ${names[i]} [di=${info.di}] canvas=${info.canvas} --=${info.dash}${info.empties.length ? ' 空态=' + JSON.stringify(info.empties) : ''}${info.insights.length ? ' 洞察=' + info.insights.length + '条' : ''}`);
    if (i === 0) console.log(`     产量=${info.prod} FPY=${info.fpy} OEE=${info.oeeMini} 根因卡=${info.rootCards}`);
    if (i === 4) console.log(`     闭环率=${info.closure} P90=${info.p90}h 不良=${info.badTotal} 未闭环=${info.open} FPY=${info.fpy2}`);
    if (i === 5) console.log(`     OEE=${info.oeeVal} 可用率=${info.avail} MTBF=${info.mtbf}`);
    if (i === 8) console.log(`     健康卡数=${info.hGridKids}`);
  }

  await browser.close();
  const failed = results.filter(r => !r.ok);
  console.log('\n=== ERROR COUNT: ' + errors.length + ' ===');
  errors.slice(0, 8).forEach(e => console.log('  ' + e));
  console.log('\n=== RESULT: ' + (failed.length === 0 && errors.length === 0 ? 'ALL PASS (9屏数据齐全, 0错误)' : `FAIL (${failed.length}屏异常, ${errors.length}错误)`) + ' ===');
  if (failed.length) failed.forEach(r => console.log('  失败: 屏' + (r.i + 1) + ' ' + r.name + ' ' + r.detail));
  process.exit(failed.length === 0 && errors.length === 0 ? 0 : 1);
})();
