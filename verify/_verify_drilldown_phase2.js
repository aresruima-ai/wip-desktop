// Phase2 — 8 看板页下钻接入通用验证:DrillLink就绪/图表绑定/双绑定修复/0 pageerror
const puppeteer=require('puppeteer');
const base='http://localhost:8080';
const PAGES=[
  {url:'bad.html',         chart:'paretoChart', card:'#kpiBadRate'},
  {url:'line-balance.html',chart:'ctChart',     card:'#kpiBalance'},
  {url:'oee.html',         chart:'paretoChart', card:null},
  {url:'wip.html',         chart:'chartBar',    card:'#kpiWipCard'},
  {url:'kanban.html',      chart:'chartOrder',  card:'[onclick*="openKpiDrawer"]'},
  {url:'ai-center.html',   chart:'chartSev',    card:'#kpiChat'},
  {url:'cockpit.html',     chart:'chartOutput', card:'[onclick*="Cockpit.openDrawer"]'},
  {url:'portal.html',      chart:'trendChart',  card:null}
];
(async()=>{
  let r;
  try{ r=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'yangning',password:'Yn@20250908'})}); }
  catch(e){ console.error('LOGIN FAIL',e.message); process.exit(1); }
  const m=(r.headers.get('set-cookie')||'').match(/session=([^;]+)/);
  if(!m){ console.error('LOGIN FAILED'); process.exit(1); }
  console.log('login ok');

  const browser=await puppeteer.launch({headless:'new',args:['--no-sandbox','--disable-gpu']});
  const fails=[];
  function ok(name,cond){ console.log((cond?'  ✓ ':'  ✗ ')+name); if(!cond) fails.push(name); }

  for(const p of PAGES){
    console.log('\n— '+p.url+' —');
    const page=await browser.newPage();
    await page.setViewport({width:1920,height:1080});
    await page.setCookie({name:'session',value:m[1],domain:'localhost',path:'/'});
    const errs=[];
    page.on('pageerror',e=>errs.push(e.message));
    page.on('console',msg=>{ if(msg.type()==='error' && !/Failed to load resource/i.test(msg.text())) errs.push('CONSOLE: '+msg.text()); });

    await page.goto(base+'/'+p.url,{waitUntil:'networkidle2',timeout:40000});
    await new Promise(r=>setTimeout(r,3500));

    // DrillLink 就绪
    const hasDrill=await page.evaluate(()=>typeof window.DrillLink);
    ok(p.url+' DrillLink 就绪', hasDrill==='object');

    // 图表绑定(cursor pointer)
    const cursor=await page.evaluate(function(cid){
      var el=document.getElementById(cid); if(!el) return 'no-el';
      var ch=window.echarts?echarts.getInstanceByDom(el):null;
      return {cursor: el.style.cursor||getComputedStyle(el).cursor, hasChart:!!ch};
    }, p.chart);
    ok(p.url+' '+p.chart+' 已 init', cursor.hasChart);
    ok(p.url+' '+p.chart+' 已绑下钻(cursor pointer)', /pointer/.test(cursor.cursor));

    // 双绑定修复:点卡不跳页
    if(p.card){
      const before=page.url();
      try{ await page.click(p.card); }catch(e){}
      await new Promise(r=>setTimeout(r,700));
      const after=page.url();
      ok(p.url+' 双绑定修复(点卡不跳页)', after.indexOf(p.url)>=0);
    }

    // 0 pageerror(排除 admin 角色门禁,本批无 admin)
    ok(p.url+' 0 pageerror('+errs.length+')', errs.length===0);
    if(errs.length) errs.slice(0,5).forEach(e=>console.log('    '+e));
    await page.close();
  }

  await browser.close();
  console.log('\n'+(fails.length?'FAIL: '+fails.join(', '):'ALL PASS'));
  process.exit(fails.length?1:0);
})();
