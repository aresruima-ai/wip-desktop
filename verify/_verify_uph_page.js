// UPH 前端页 puppeteer 验证: 0报错 + DOM渲染 + 图表canvas
require('dotenv').config();
const http = require('http');
const puppeteer = require('puppeteer');
const ADMIN_KEY = process.env.ADMIN_KEY || '12345678';

function httpReq(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = { hostname:'localhost', port:8080, path, method, headers:{} };
    if (data) { opts.headers['Content-Type']='application/json'; opts.headers['Content-Length']=Buffer.byteLength(data); }
    const r = http.request(opts, res => { let buf=''; res.on('data',d=>buf+=d); res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:buf})); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

(async () => {
  const lr = await httpReq('POST','/api/admin-login',{key:ADMIN_KEY});
  const setCookie = lr.headers['set-cookie']||[];
  const session = setCookie[0] ? setCookie[0].split(';')[0].split('=')[1] : '';
  if (!session) { console.log('登录失败'); process.exit(1); }

  const browser = await puppeteer.launch({ headless:'new', args:['--no-sandbox','--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.setViewport({ width:1500, height:1000 });
  const pageerrors = [], consoleErrors = [];
  page.on('pageerror', e => pageerrors.push(e.message));
  page.on('console', m => { if (m.type()==='error') consoleErrors.push(m.text()); });
  page.on('requestfailed', r => { const u=r.url(); if(!u.includes('favicon')) consoleErrors.push('REQFAIL '+u+' '+r.failure().errorText); });

  await page.evaluateOnNewDocument(() => { try { localStorage.clear(); sessionStorage.clear(); } catch(e){} });
  await page.setCookie({ name:'session', value:session, domain:'localhost', path:'/' });
  await page.goto('http://localhost:8080/uph.html', { waitUntil:'networkidle2', timeout:30000 });
  await new Promise(r=>setTimeout(r, 5000)); // 等图表渲染

  const checks = await page.evaluate(() => {
    const q = s => document.querySelector(s);
    const txt = el => el ? el.textContent.trim() : 'MISSING';
    return {
      title: document.title,
      kpiTotal: txt(q('#kpiTotal')),
      kpiUph: txt(q('#kpiUph')),
      kpiMom: txt(q('#kpiMom')),
      kpiModels: txt(q('#kpiModels')),
      granularCards: document.querySelectorAll('.uph-granular-card').length,
      activeGranular: document.querySelectorAll('.uph-granular-card.active').length,
      canvases: document.querySelectorAll('canvas').length,
      summaryRows: document.querySelectorAll('#summaryBody tr').length,
      focusTitle: txt(q('#focusTitle')).slice(0,100),
      dataStartHint: txt(q('#dataStartHint')),
      modelOptions: q('#productFilter') ? q('#productFilter').options.length : 0,
      opOptions: q('#workOpFilter') ? q('#workOpFilter').options.length : 0,
      updateTime: txt(q('#updateTime')).slice(0,80),
      navHasUph: !!Array.from(document.querySelectorAll('.mn-drop-link')).find(a=>a.getAttribute('href')==='uph.html'),
      dimChartExists: !!q('#dimChart'),
      matrixRows: q('#matrixBody') ? q('#matrixBody').querySelectorAll('tr').length : 0,
      stageFilterExists: !!q('#stageFilter'),
      shiftFilterExists: !!q('#shiftFilter')
    };
  });

  // 测试周期切换(点"本月"卡)
  await page.click('.uph-granular-card[data-period="month"]');
  await new Promise(r=>setTimeout(r, 4500));
  const afterMonth = await page.evaluate(() => {
    const q=s=>document.querySelector(s);
    return {
      activePeriod: q('.uph-granular-card.active') ? q('.uph-granular-card.active').dataset.period : 'none',
      periodSelect: q('#periodSelect') ? q('#periodSelect').value : 'none',
      kpiTotal: q('#kpiTotal') ? q('#kpiTotal').textContent.trim() : '',
      matrixRows: q('#matrixBody') ? q('#matrixBody').querySelectorAll('tr').length : 0
    };
  });

  // 测试选线收窄(同 bad 级联: 选线体 → 工序/机型按该线实际产出收窄)
  const opInit = await page.evaluate(() => document.querySelectorAll('#workOpFilter option').length);
  await page.select('#lineFilter', 'ASS_Line2');
  await new Promise(r=>setTimeout(r, 3500));
  const afterLine = await page.evaluate(() => ({
    opCount: document.querySelectorAll('#workOpFilter option').length,
    modelCount: document.querySelectorAll('#productFilter option').length,
    lineVal: document.querySelector('#lineFilter').value
  }));
  console.log('  [选线收窄] opInit='+opInit+' → ASS_Line2 op='+afterLine.opCount+' model='+afterLine.modelCount);
  await page.select('#lineFilter', '');  // 选回全部线体恢复
  await new Promise(r=>setTimeout(r, 2500));

  // 测试机型筛选(FilterBar product 下拉 → change 触发服务端重查)
  const firstModel = await page.evaluate(() => {
    const opts = document.querySelectorAll('#productFilter option');
    return opts.length>1 ? opts[1].value : '';
  });
  var modelFilterOk = false;
  if (firstModel) {
    const totalBefore = await page.evaluate(() => document.querySelector('#kpiTotal').textContent.trim());
    await page.select('#productFilter', firstModel);
    await new Promise(r=>setTimeout(r, 3500));
    const after = await page.evaluate(() => ({
      total: document.querySelector('#kpiTotal').textContent.trim(),
      updateTime: document.querySelector('#updateTime').textContent
    }));
    modelFilterOk = after.updateTime.includes(firstModel) && after.total !== totalBefore;
    console.log('  [机型筛选] before='+totalBefore+' after='+after.total+' model='+firstModel+' ok='+modelFilterOk);
  }

  // 测试维度切换(机型→工艺段) + 工艺段筛选
  var dimSwitchOk = false, stageFilterOk = false;
  try {
    await page.select('#dimSelect', 'stage');
    await new Promise(r=>setTimeout(r, 1200));
    dimSwitchOk = await page.evaluate(() => { const c=document.querySelector('#dimChart canvas'); return !!c; });
    // 工艺段筛选: 选"测试"段 → loadData, total 应变化(收窄到测试段)
    const totalBefore2 = await page.evaluate(() => document.querySelector('#kpiTotal').textContent.trim());
    await page.select('#dimSelect', 'model');  // 维度切回机型
    await page.select('#stageFilter', 'test');
    await new Promise(r=>setTimeout(r, 3500));
    const afterStage = await page.evaluate(() => document.querySelector('#kpiTotal').textContent.trim());
    stageFilterOk = afterStage !== totalBefore2;
    console.log('  [工艺段筛选] before='+totalBefore2+' after(测试段)='+afterStage+' ok='+stageFilterOk);
    await page.select('#stageFilter', '');  // 清除工艺段
    await new Promise(r=>setTimeout(r, 1500));
  } catch(e){ console.log('  [维度/工艺段测试] 异常: '+e.message); }

  // 测试 KPI 达成率(选有cycle_time的机型 → 目标UPH/达成率应有值)
  var achieveOk = false;
  try {
    await page.select('#productFilter', 'QOA.UD03.1624.ZK');
    await new Promise(r=>setTimeout(r, 3500));
    const kpiA = await page.evaluate(() => ({
      achieve: document.querySelector('#kpiAchieve') ? document.querySelector('#kpiAchieve').textContent.trim() : '',
      targetUph: document.querySelector('#kpiTargetUph') ? document.querySelector('#kpiTargetUph').textContent.trim() : '',
      ct: document.querySelector('#kpiCt') ? document.querySelector('#kpiCt').textContent.trim() : ''
    }));
    achieveOk = kpiA.achieve && !/--|MISSING/.test(kpiA.achieve) && !/--/.test(kpiA.targetUph);
    console.log('  [KPI达成率] model=QOA.UD03.1624.ZK target='+kpiA.targetUph+' achieve='+kpiA.achieve+' ct='+kpiA.ct+' ok='+achieveOk);
    await page.select('#productFilter', '');  // 清除机型
    await new Promise(r=>setTimeout(r, 1500));
  } catch(e){ console.log('  [KPI达成率测试] 异常: '+e.message); }

  await page.screenshot({ path:'_uph_shot.png', fullPage:false });
  await browser.close();

  console.log('=== DOM 检查 ===');
  console.log(JSON.stringify(checks, null, 2));
  console.log('\n=== 切换本月后 ===');
  console.log(JSON.stringify(afterMonth, null, 2));
  console.log('\n=== pageerrors:', pageerrors.length, pageerrors.slice(0,5));
  console.log('=== console errors:', consoleErrors.length, consoleErrors.slice(0,5));

  let fail = pageerrors.length + consoleErrors.length;
  // 关键 DOM 断言
  const assert = (n, c) => { if(!c){fail++; console.log('  ✗ ASSERT', n);} else console.log('  ✓ ASSERT', n); };
  console.log('\n=== 关键断言 ===');
  assert('6累计卡', checks.granularCards===6);
  assert('有active卡', checks.activeGranular===1);
  assert('5图表canvas(日趋势/24h/三段/维度切换/热力图)', checks.canvases>=5);
  assert('明细表有行', checks.summaryRows>0);
  assert('维度切换图存在', checks.dimChartExists);
  assert('交叉矩阵有行', checks.matrixRows>0);
  assert('工艺段下拉', checks.stageFilterExists);
  assert('班次下拉', checks.shiftFilterExists);
  assert('KPI产出有值', !/--|MISSING/.test(checks.kpiTotal) && checks.kpiTotal!=='');
  assert('焦点标题有值', !/MISSING|读取/.test(checks.focusTitle));
  assert('数据起点提示', !/MISSING/.test(checks.dataStartHint));
  assert('机型下拉有项', checks.modelOptions>1);
  assert('工序下拉有项', checks.opOptions>1);
  assert('nav含UPH入口', checks.navHasUph);
  assert('切换本月生效', afterMonth.activePeriod==='month' && afterMonth.periodSelect==='month');
  assert('本月矩阵渲染数据', afterMonth.matrixRows>1);
  assert('选线收窄工序选项', afterLine.opCount < opInit && afterLine.lineVal==='ASS_Line2');
  assert('机型下拉触发重查', modelFilterOk);
  assert('维度切换图渲染', dimSwitchOk);
  assert('工艺段筛选触发重查', stageFilterOk);
  assert('KPI达成率(选机型)', achieveOk);

  console.log(fail===0 ? '\n=== PASS 0报错 全断言通过 ===' : '\n=== FAIL '+fail+' 问题 ===');
  process.exit(fail?1:0);
})().catch(e=>{console.error('[ERR]',e.message, e.stack); process.exit(1);});
