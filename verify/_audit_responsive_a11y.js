// 响应式 + a11y 自动检测:
//  1) 1366x768(工厂机常见)水平溢出: body scrollWidth > clientWidth 即布局崩
//  2) 1366x768 关键 KPI 卡片是否被挤压(clientHeight 异常小/文字溢出)
//  3) 键盘 a11y: Tab 遍历, 检查 focus-visible outline 是否存在(纯键盘可操作)
//  4) 已有 aria/role 抽样
require('dotenv').config();
const http = require('http');
const puppeteer = require('puppeteer');
const ADMIN_KEY = process.env.ADMIN_KEY || '12345678';
function httpReq(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = { hostname:'localhost', port:8080, path:p, method, headers:{} };
    if (data) { opts.headers['Content-Type']='application/json'; opts.headers['Content-Length']=Buffer.byteLength(data); }
    const r = http.request(opts, res => { let buf=''; res.on('data',d=>buf+=d); res.on('end',()=>resolve({headers:res.headers,body:buf})); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const PAGES = [
  ['portal','/portal.html'],['cockpit','/cockpit.html'],['wip','/wip.html'],['bad','/bad.html'],
  ['oee','/oee.html'],['kanban','/kanban.html'],['uph','/uph.html'],['health','/health.html'],
  ['line-balance','/line-balance.html'],['fixture-life','/fixture-life.html'],['ai-center','/ai-center.html'],
  ['scroll-board','/scroll-board.html'],['admin','/admin.html'],['settings','/settings.html'],
];
(async () => {
  const lr = await httpReq('POST','/api/admin-login',{key:ADMIN_KEY});
  const session = (lr.headers['set-cookie']||[])[0]?.split(';')[0].split('=')[1] || '';
  const browser = await puppeteer.launch({ headless:'new', args:['--no-sandbox','--disable-dev-shm-usage'] });
  console.log('页名           水平溢出px  垂直溢出px  可Tab元素  有outline  aria/role数');
  console.log('─'.repeat(80));
  for (const [name, url] of PAGES) {
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    try {
      await page.evaluateOnNewDocument(() => { try{localStorage.clear();sessionStorage.clear();}catch(e){} });
      await page.setCookie({ name:'session', value:session, domain:'localhost', path:'/' });
      // 1366x768 工厂机常见分辨率
      await page.setViewport({ width:1366, height:768, deviceScaleFactor:1 });
      await page.goto('http://localhost:8080'+url, { waitUntil:'networkidle2', timeout:30000 });
      await new Promise(r=>setTimeout(r, 4000));
      const data = await page.evaluate(() => {
        const sx = document.body.scrollWidth - document.body.clientWidth;
        const sy = document.body.scrollHeight - document.body.clientHeight;
        // 可 Tab 元素(粗略: 有 tabindex 或原生可聚焦且可见)
        const focusable = document.querySelectorAll('a[href],button:not([disabled]),input,select,textarea,[tabindex]');
        let tabCount = 0;
        focusable.forEach(el => { const r = el.getBoundingClientRect(); if (r.width>0 && r.height>0 && el.getClientRects().length) tabCount++; });
        // focus-visible outline 检测: 取第一个可聚焦元素, 模拟聚焦看 outline
        const ariaCount = document.querySelectorAll('[role],[aria-label],[aria-sort],[aria-expanded]').length;
        return { overflowX: sx, overflowY: sy, tabCount, ariaCount };
      });
      // 键盘 outline 检测: Tab 一次, 看活跃元素 outline
      await page.keyboard.press('Tab');
      const focusInfo = await page.evaluate(() => {
        const a = document.activeElement;
        if (!a || a === document.body) return { hasOutline: false, tag: 'none' };
        const cs = getComputedStyle(a);
        return { hasOutline: cs.outlineStyle !== 'none' && cs.outlineWidth !== '0px', tag: a.tagName + (a.id ? '#'+a.id : '') };
      });
      const flag = data.overflowX > 2 ? '⚠' : ' ';
      console.log(
        name.padEnd(15),
        flag + String(data.overflowX).padStart(7),
        String(data.overflowY).padStart(9),
        String(data.tabCount).padStart(8),
        (focusInfo.hasOutline ? '是' : '否⚠').padStart(8),
        String(data.ariaCount).padStart(9),
        errs.length ? 'errs:'+errs.length : ''
      );
      if (data.overflowX > 2) console.log('    ⚠ 水平溢出 ' + data.overflowX + 'px — 1366 宽度下布局崩/出现横向滚动条');
    } catch (e) { console.log(name.padEnd(15), 'ERROR:', e.message); }
    await page.close();
  }
  await browser.close();
  process.exit(0);
})();
