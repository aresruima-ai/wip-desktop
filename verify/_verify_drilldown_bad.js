// Phase1 — bad 标杆页 3 级下钻端到端验证
// 图表 bindChart 绑定 → 模拟点缺陷柱 → 跳 detail.html?source=bad-records → 该缺陷 SN 明细
// 双绑定修复:点 kpiBadRate 卡 → 不跳页 + 开本页 Drawer
const puppeteer=require('puppeteer');
const base='http://localhost:8080';

(async()=>{
  let r;
  try{ r=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'yangning',password:'Yn@20250908'})}); }
  catch(e){ console.error('LOGIN FAIL',e.message); process.exit(1); }
  const m=(r.headers.get('set-cookie')||'').match(/session=([^;]+)/);
  if(!m){ console.error('LOGIN FAILED'); process.exit(1); }
  console.log('login ok');

  const browser=await puppeteer.launch({headless:'new',args:['--no-sandbox','--disable-gpu']});
  const page=await browser.newPage();
  await page.setViewport({width:1920,height:1080});
  await page.setCookie({name:'session',value:m[1],domain:'localhost',path:'/'});
  const pageErrors=[];
  page.on('pageerror',e=>pageErrors.push(e.message));

  const fails=[];
  function ok(name,cond){ console.log((cond?'  ✓ ':'  ✗ ')+name); if(!cond) fails.push(name); }

  // 1. 访问 bad.html,等 renderAll(bad 页 5 模块+多 API,给足时间)
  await page.goto(base+'/bad.html',{waitUntil:'networkidle2',timeout:40000});
  await new Promise(r=>setTimeout(r,4000));

  // 2. bindAllDrill 绑定验证
  const bind=await page.evaluate(()=>{
    var pareto=document.getElementById('paretoChart');
    var chart=window.echarts?echarts.getInstanceByDom(pareto):null;
    var lineEl=document.getElementById('lineChart');
    var lineChart=window.echarts&&lineEl?echarts.getInstanceByDom(lineEl):null;
    return {
      hasDrillLink: typeof window.DrillLink,
      paretoCursor: pareto?(pareto.style.cursor||getComputedStyle(pareto).cursor):'',
      hasDrillDim: !!(chart&&chart._drillDim&&chart._drillDim.length),
      drillDim0: chart&&chart._drillDim?chart._drillDim[0]:null,
      lineName0: lineChart?((lineChart.getOption().yAxis&&lineChart.getOption().yAxis[0])||{}).data: null
    };
  });
  ok('bad 页 DrillLink 就绪', bind.hasDrillLink==='object');
  ok('paretoChart 已绑下钻(cursor pointer)', /pointer/.test(bind.paretoCursor));
  ok('paretoChart 挂 _drillDim(完整缺陷名数组)', bind.hasDrillDim);

  // 3. 模拟图表下钻 L3:优先 pareto 缺陷,否则 lineChart 线名
  var dimValue=bind.drillDim0;
  var dimension='defect';
  if(!dimValue && bind.lineName0 && bind.lineName0.length){
    dimValue=bind.lineName0[bind.lineName0.length-1]; // reverse 后末尾是最高
    dimension='line';
  }
  if(dimValue){
    await page.evaluate(function(src,dim,val){
      DrillLink.openL3(src, val, null, {dimension:dim, chart:dim==='defect'?'paretoChart':'lineChart'});
    }, 'bad-records', dimension, dimValue);
    await new Promise(r=>setTimeout(r,2800));
    const url=page.url();
    ok('点图表维度项 → 跳 detail.html?source=bad-records', /detail\.html\?source=bad-records/.test(url));
    ok('跳转 URL 含 dim='+dimension, url.indexOf('dim='+dimension)>=0);
    const det=await page.evaluate(()=>{
      return {
        title:(document.getElementById('detailTitle')||{}).textContent||'',
        crumb:(document.getElementById('detailBreadcrumb')||{}).textContent||'',
        info:(document.getElementById('tableInfo')||{}).textContent||'',
        headCols:document.getElementById('detailHead')?document.getElementById('detailHead').querySelectorAll('th').length:0
      };
    });
    ok('detail 标题=不良记录', det.title==='不良记录');
    ok('detail 表头渲染(≥10列)', det.headCols>=10);
    ok('detail 面包屑含来源(不良管理)+dimValue', det.crumb.includes('不良管理')&&det.crumb.indexOf(dimValue)>=0);
    ok('detail 过滤后显示"共 N 条"(数据或0)', /共 \d+ 条/.test(det.info));
    // 返回按钮可回 bad
    const backBtn=await page.evaluate(()=>!!document.querySelector('.detail-back'));
    ok('detail 返回按钮存在', backBtn);
  } else {
    console.log('  ⚠ 本次无不良数据,pareto/lineChart 均空,下钻链路跳过(非回归)');
  }

  // 4. 双绑定修复:回 bad,点 kpiBadRate 卡 → 不跳页 + 开 Drawer
  await page.goto(base+'/bad.html',{waitUntil:'networkidle2',timeout:40000});
  await new Promise(r=>setTimeout(r,3500));
  const beforeUrl=page.url();
  await page.click('#kpiBadRate');
  await new Promise(r=>setTimeout(r,900));
  const afterUrl=page.url();
  const drawerShow=await page.evaluate(()=>{ var d=document.getElementById('drawer'); return !!(d&&d.classList.contains('show')); });
  ok('点 kpiBadRate 卡 → 不跳页(双绑定已修)', afterUrl===beforeUrl || /bad\.html/.test(afterUrl));
  ok('点 kpiBadRate 卡 → 开本页 Drawer', drawerShow);

  // 5. 0 pageerror
  ok('bad 页 0 pageerror(实际:'+pageErrors.length+')', pageErrors.length===0);
  if(pageErrors.length) pageErrors.slice(0,8).forEach(e=>console.log('    '+e));

  await browser.close();
  console.log('\n'+(fails.length?'FAIL: '+fails.join(', '):'ALL PASS'));
  process.exit(fails.length?1:0);
})();
