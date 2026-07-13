// 视觉审计 DOM 交叉验证: 抓取每页 DOM 事实, 过滤视觉模型误报
// 用法: node verify/_audit_crosscheck.js
//   1) null/undefined/NaN 文本检测 — 视觉模型常把 "--" 误读为 "null", 此项若 0 命中则证伪
//   2) 硬编码色扫描 — 内联 style 的 color/border/background 用 #xxx 而非 var()
//   3) 占位符统计 — "--" vs "0" 同屏分布(口径一致性核查)
//   4) KPI 关键值快照 — 供视觉结论对照
// 输出: 控制台摘要 + verify/_audit_crosscheck.json
require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const ADMIN_KEY = process.env.ADMIN_KEY || '12345678';
const OUT = path.join(__dirname, '_audit_crosscheck.json');

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
  ['portal','/portal.html'],
  ['cockpit','/cockpit.html'],
  ['wip','/wip.html'],
  ['bad','/bad.html'],
  ['oee','/oee.html'],
  ['kanban','/kanban.html'],
  ['uph','/uph.html'],
  ['health','/health.html'],
  ['line-balance','/line-balance.html'],
  ['fixture-life','/fixture-life.html'],
  ['factory-3d','/factory-3d.html'],
  ['ai-center','/ai-center.html'],
  ['scroll-board','/scroll-board.html'],
  ['admin','/admin.html'],
  ['settings','/settings.html'],
];

// 已知 token hex 值 (common.css 定义) — 运行时 JS 读取 var() 后赋值会还原成这些 hex,
// 色值正确非真硬编码, 脚本白名单排除避免误报
const TOKEN_HEX = new Set([
  '#0166b1','#10b981','#f59e0b','#ef4444','#38bdf8','#a78bfa','#22d3ee',
  '#eceef1','#8893a3','#5d6a7c','#2d3540','#015494'
].map(s => s.toLowerCase()));

// 各页关键 KPI id (textContent 抓取, 供视觉结论对照)
const KPI_IDS = {
  portal: ['pKpiProd','pKpiProdDelta','pKpiProdOffline','pKpiRate','pKpiOee','pKpiUpph','pKpiPpm'],
  cockpit: ['fmKpi1','fmKpi2','fmKpi3','fmKpi4'],
  bad: ['focusFpy','focusFpyHint','focusClosure','focusClosureHint','kpiRate','kpiClosure'],
  oee: ['kpiOeeVal','kpiAvailVal','kpiPerfVal','kpiQualityVal','kpiMtbfVal','kpiMttrVal'],
  scroll_board: ['bProd','bFpy','bOee','bUpph','bFpySub','bOeeSub'],
  uph: ['uphToday','uphTarget'],
  kanban: ['kpiOutput','kpiOutputSub'],
};

(async () => {
  const lr = await httpReq('POST','/api/admin-login',{key:ADMIN_KEY});
  const session = (lr.headers['set-cookie']||[])[0]?.split(';')[0].split('=')[1] || '';
  if (!session) { console.error('登录失败'); process.exit(1); }
  const browser = await puppeteer.launch({ headless:'new', args:['--no-sandbox','--disable-dev-shm-usage'] });
  const report = [];
  console.log('页名          null命中  硬编码色  --计数  0计数  KPI快照');
  console.log('─'.repeat(90));
  for (const [name, url] of PAGES) {
    const page = await browser.newPage();
    await page.setViewport({ width:1600, height:900, deviceScaleFactor:1 });
    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    try {
      await page.evaluateOnNewDocument(() => { try{localStorage.clear();sessionStorage.clear();}catch(e){} });
      await page.setCookie({ name:'session', value:session, domain:'localhost', path:'/' });
      await page.goto('http://localhost:8080'+url, { waitUntil:'networkidle2', timeout:30000 });
      await new Promise(r=>setTimeout(r, 4500));
      const data = await page.evaluate((pageName, kpiIds, tokenHexArr) => {
        const TOKEN_HEX = new Set(tokenHexArr);
        const txt = document.body.innerText || '';
        // 1) null/undefined/NaN 文本检测 (排除合法的代码注释/属性, 只看可见文本)
        const nullMatches = [];
        const re = /\b(null|undefined|NaN)\b/g; let m;
        while ((m = re.exec(txt)) !== null) {
          const ctx = txt.substring(Math.max(0,m.index-15), m.index+20).replace(/\s+/g,' ').trim();
          nullMatches.push(ctx);
          if (nullMatches.length >= 5) break;
        }
        // 2) 硬编码色: 内联 style 含 color/border/background: #xxx 而非 var()
        //    区分: =token值(JS动态读var()赋值, 色值正确非bug) vs 真硬编码(需修)
        const hcColors = new Set();
        const tokenColors = new Set();
        const hcRe = /(color|background|border-color|border)\s*:\s*(#[0-9a-fA-F]{3,8})(?!\s*\))/g;
        document.querySelectorAll('[style]').forEach(el => {
          const s = el.getAttribute('style') || '';
          let mm;
          while ((mm = hcRe.exec(s)) !== null) {
            const hex = mm[2].toLowerCase();
            if (TOKEN_HEX.has(hex)) tokenColors.add(mm[2]);
            else hcColors.add(mm[2]);
          }
        });
        // 3) 占位符统计: 可见文本中 "--" 与 独立 "0" 出现次数
        const dashCount = (txt.match(/--/g) || []).length;
        const zeroCount = (txt.match(/(?<![\d.])0(?![\d.%])/g) || []).length;
        // 4) KPI 快照
        const kpi = {};
        (kpiIds || []).forEach(id => { const el = document.getElementById(id); kpi[id] = el ? el.textContent.trim().slice(0,24) : null; });
        return { nullMatches, hcColors: Array.from(hcColors), tokenColors: Array.from(tokenColors), dashCount, zeroCount, kpi };
      }, name, KPI_IDS[name.replace('-','_')] || [], Array.from(TOKEN_HEX));
      report.push({ name, url, errs, ...data });
      const kpiStr = Object.entries(data.kpi).filter(([,v]) => v != null).map(([k,v]) => k+'='+v).join(' ').slice(0,50);
      console.log(
        name.padEnd(14),
        String(data.nullMatches.length).padStart(6),
        String(data.hcColors.length).padStart(8),
        String(data.dashCount).padStart(7),
        String(data.zeroCount).padStart(7),
        '  '+kpiStr
      );
      if (data.nullMatches.length) console.log('    ⚠ null上下文:', JSON.stringify(data.nullMatches));
      if (data.hcColors.length) console.log('    ⚠ 真硬编码色(需修):', data.hcColors.join(' '));
      if (data.tokenColors.length) console.log('    · =token值(动态读取,非bug):', data.tokenColors.join(' '));
    } catch (e) {
      report.push({ name, url, error: String(e.message).slice(0,200) });
      console.log(name.padEnd(14), 'ERROR:', e.message);
    }
    await page.close();
  }
  await browser.close();
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log('─'.repeat(90));
  console.log('报告已写:', OUT);
  // 汇总
  const totalNull = report.reduce((s,r) => s + (r.nullMatches?r.nullMatches.length:0), 0);
  const totalHc = report.reduce((s,r) => s + (r.hcColors?r.hcColors.length:0), 0);
  console.log(`汇总: null文本命中 ${totalNull} 处, 硬编码色 ${totalHc} 处, pageerror ${report.filter(r=>r.errs&&r.errs.length).length} 页`);
  process.exit(0);
})();
