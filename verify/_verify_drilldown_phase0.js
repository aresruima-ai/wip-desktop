// 3级下钻框架 Phase0 验证:框架对象/DrillCtx往返/Drawer.onItem/detail骨架/8页0pageerror
const puppeteer=require('puppeteer');
const base='http://localhost:8080';

(async()=>{
  // 登录拿 session
  let r;
  try{ r=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'yangning',password:'Yn@20250908'})}); }
  catch(e){ console.error('LOGIN FETCH FAIL',e.message,'(确认 server 在 8080 运行)'); process.exit(1); }
  const sc=r.headers.get('set-cookie')||'';
  const m=sc.match(/session=([^;]+)/);
  if(!m){ console.error('LOGIN FAILED',await r.text()); process.exit(1); }
  console.log('login ok (yangning)');

  const browser=await puppeteer.launch({headless:'new',args:['--no-sandbox','--disable-gpu']});
  const page=await browser.newPage();
  await page.setViewport({width:1920,height:1080});
  await page.setCookie({name:'session',value:m[1],domain:'localhost',path:'/'});

  const pageErrors=[];
  page.on('pageerror',e=>pageErrors.push(e.message));
  page.on('console',msg=>{ if(msg.type()==='error' && !/Failed to load resource/i.test(msg.text())) pageErrors.push('CONSOLE: '+msg.text()); });

  const fails=[];
  function ok(name,cond){ console.log((cond?'  ✓ ':'  ✗ ')+name); if(!cond) fails.push(name); }

  // ── 1. 框架对象 + KPILinkage 12 key(在 portal 页验证)──
  await page.goto(base+'/portal.html',{waitUntil:'networkidle2',timeout:30000});
  await new Promise(r=>setTimeout(r,1500));
  const fw=await page.evaluate(()=>{
    return {
      DrillCtx: typeof window.DrillCtx,
      PageContext: typeof window.PageContext,
      DrillLink: typeof window.DrillLink,
      hasOpenL1: !!(window.DrillLink&&DrillLink.openL1),
      hasOpenL2: !!(window.DrillLink&&DrillLink.openL2),
      hasOpenL3: !!(window.DrillLink&&DrillLink.openL3),
      hasBindChart: !!(window.DrillLink&&DrillLink.bindChart),
      kpiKeys: window.KPILinkage ? Object.keys(KPILinkage.map).length : 0
    };
  });
  ok('DrillCtx 定义', fw.DrillCtx==='object');
  ok('PageContext 定义', fw.PageContext==='object');
  ok('DrillLink 定义', fw.DrillLink==='object');
  ok('DrillLink.openL1/L2/L3/bindChart 均存在', fw.hasOpenL1&&fw.hasOpenL2&&fw.hasOpenL3&&fw.hasBindChart);
  ok('KPILinkage.map 扩至 12 key', fw.kpiKeys===12);

  // ── 2. DrillCtx.toQuery/fromQuery 往返(含中文/特殊值)──
  const rt=await page.evaluate(()=>{
    var ctx={source:'bad-records',kpi:'bad_rate',dimension:'defect',dimValue:'划伤',from:'cockpit.html',level:3,filter:{line:'A线',dateFrom:'2026-06-01',dateTo:'2026-06-25',shift:'早'}};
    var q=DrillCtx.toQuery(ctx);
    var saved=location.search;
    history.replaceState(null,'','?'+q);
    var back=DrillCtx.fromQuery();
    history.replaceState(null,'',saved);
    return back;
  });
  ok('DrillCtx 往返 source=bad-records', rt&&rt.source==='bad-records');
  ok('DrillCtx 往返 dimValue=划伤(中文)', rt&&rt.dimValue==='划伤');
  ok('DrillCtx 往返 filter.line=A线', rt&&rt.filter&&rt.filter.line==='A线');
  ok('DrillCtx 往返 filter.dateFrom', rt&&rt.filter&&rt.filter.dateFrom==='2026-06-01');
  ok('DrillCtx 往返 level=3', rt&&rt.level===3);

  // ── 3. detail.html?source=bad-records 骨架 ──
  await page.goto(base+'/detail.html?source=bad-records&dim=defect&dimValue='+encodeURIComponent('划伤')+'&dateFrom=2026-06-01&dateTo=2026-06-25&from=cockpit.html',{waitUntil:'networkidle2',timeout:30000});
  await new Promise(r=>setTimeout(r,1800));
  const det=await page.evaluate(()=>{
    return {
      title: (document.getElementById('detailTitle')||{}).textContent||'',
      crumb: (document.getElementById('detailBreadcrumb')||{}).textContent||'',
      head: document.getElementById('detailHead')?document.getElementById('detailHead').querySelectorAll('th').length:0,
      bodyRows: document.getElementById('detailBody')?document.getElementById('detailBody').querySelectorAll('tr').length:0,
      backBtn: !!document.querySelector('.detail-back'),
      hasWipUI: typeof window.WipUI
    };
  });
  ok('detail.html 标题=不良记录', det.title==='不良记录');
  ok('detail.html 面包屑含来源(驾驶舱)+dimValue(划伤)', det.crumb.includes('驾驶舱')&&det.crumb.includes('划伤'));
  ok('detail.html 表头渲染(≥10列)', det.head>=10);
  ok('detail.html DetailTable.mount 后 tbody 有行', det.bodyRows>=1);
  ok('detail.html 返回按钮存在', det.backBtn);
  ok('detail.html 引入 wip-ui.js(WipUI 就绪)', det.hasWipUI==='object');

  // ── 4. Drawer.onItem 钩子(detail 页有 Drawer DOM + WipUI)──
  const dr=await page.evaluate(()=>{
    return new Promise(function(resolve){
      var got=null;
      WipUI.Drawer.open({
        title:'测试分组',
        html:'<div class="drill-group-list"><div class="drill-group-row" data-drill-item="'+JSON.stringify({name:'A线',value:120}).replace(/"/g,'&quot;')+'" role="button" tabindex="0">A线 120</div></div>',
        onItem:function(item){ got=item; }
      });
      var row=document.querySelector('#drawerContent [data-drill-item]');
      if(row) row.click();
      setTimeout(function(){ resolve({opened:document.getElementById('drawer').classList.contains('show'), got:got}); },100);
    });
  });
  ok('Drawer.open 接 onItem + 抽屉展开', dr&&dr.opened);
  ok('Drawer [data-drill-item] 点击触发 onItem(item)', dr&&dr.got&&dr.got.name==='A线'&&dr.got.value===120);

  // ── 5. nav.js detail.html 顶栏标题=数据明细 ──
  const navTitle=await page.evaluate(()=>{ var t=document.getElementById('mnPageTitle'); return t?t.textContent:''; });
  ok('nav.js detail.html 顶栏标题=数据明细', navTitle==='数据明细');

  // ── 6. output-sn 已补全(Phase3),渲染明细(标题=产量 SN 流水)──
  await page.goto(base+'/detail.html?source=output-sn&dateFrom=2026-06-01&dateTo=2026-06-25&from=portal.html',{waitUntil:'networkidle2',timeout:30000});
  await new Promise(r=>setTimeout(r,2000));
  const osn=await page.evaluate(()=>({title:(document.getElementById('detailTitle')||{}).textContent||'', head:document.getElementById('detailHead')?document.getElementById('detailHead').querySelectorAll('th').length:0}));
  ok('output-sn 渲染(标题=产量 SN 流水+表头)', osn.title==='产量 SN 流水' && osn.head>=4);

  // ── 7. 8 看板页 0 pageerror(框架注入不破坏现有页)──
  const before=pageErrors.length;
  const pages8=['portal','cockpit','oee','wip','bad','line-balance','kanban','ai-center'];
  for(const p of pages8){
    await page.goto(base+'/'+p+'.html',{waitUntil:'networkidle2',timeout:30000});
    await new Promise(r=>setTimeout(r,1200));
  }
  const newErrs=pageErrors.slice(before);
  ok('8 看板页框架注入后 0 pageerror(实际:'+newErrs.length+')', newErrs.length===0);
  if(newErrs.length){ newErrs.slice(0,8).forEach(e=>console.log('    '+e)); }

  await browser.close();
  console.log('\n'+(fails.length?'FAIL: '+fails.join(', '):'ALL PASS'));
  process.exit(fails.length?1:0);
})();
