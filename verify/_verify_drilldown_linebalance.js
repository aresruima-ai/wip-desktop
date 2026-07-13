// Phase2-1 — line-balance 接入验证:绑定/双绑定修复/0 pageerror(有 stations 数据则测下钻)
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

  // 取一线体用于选线(line-balance 单线才有效)
  let lineName=null;
  try{
    const lr=await (await fetch(base+'/api/lines',{headers:{Cookie:'session='+m[1]}})).json();
    const items=lr.items||lr.data||lr;
    if(Array.isArray(items)&&items.length) lineName=items[0].line_name||items[0].name||items[0];
  }catch(e){}

  await page.goto(base+'/line-balance.html',{waitUntil:'networkidle2',timeout:40000});
  await new Promise(r=>setTimeout(r,3000));

  // 选线(若默认全厂无 stations):找 line select 设值触发 change
  if(lineName){
    const hasDim=await page.evaluate(()=>{ var c=window.echarts&&echarts.getInstanceByDom(document.getElementById('ctChart')); return !!(c&&c._drillDim&&c._drillDim.length); });
    if(!hasDim){
      await page.evaluate(function(ln){
        var sels=document.querySelectorAll('select');
        for(var i=0;i<sels.length;i++){ if(sels[i].id.toLowerCase().indexOf('line')>=0||sels[i].name.toLowerCase().indexOf('line')>=0){ sels[i].value=ln; sels[i].dispatchEvent(new Event('change',{bubbles:true})); return; } }
      }, lineName);
      await new Promise(r=>setTimeout(r,3500));
    }
  }

  const bind=await page.evaluate(()=>{
    var ct=document.getElementById('ctChart');
    var chart=window.echarts&&ct?echarts.getInstanceByDom(ct):null;
    return {
      hasDrillLink: typeof window.DrillLink,
      bindFn: typeof window.bindAllDrillLB,
      ctCursor: ct?(ct.style.cursor||getComputedStyle(ct).cursor):'',
      hasDrillDim: !!(chart&&chart._drillDim&&chart._drillDim.length),
      drillDim0: chart&&chart._drillDim?chart._drillDim[0]:null
    };
  });
  ok('line-balance DrillLink 就绪', bind.hasDrillLink==='object');
  ok('bindAllDrillLB 定义', bind.bindFn==='function');
  ok('ctChart 已绑下钻(cursor pointer)', /pointer/.test(bind.ctCursor));
  ok('ctChart 挂 _drillDim(工站代码,选线后有数据)', bind.hasDrillDim);

  // 下钻端到端(若有数据)
  if(bind.drillDim0){
    await page.evaluate(function(val){
      DrillLink.openL3('wip-sn', val, null, {dimension:'operation', chart:'ctChart'});
    }, bind.drillDim0);
    await new Promise(r=>setTimeout(r,2500));
    const url=page.url();
    ok('点工位 → 跳 detail.html?source=wip-sn', /detail\.html\?source=wip-sn/.test(url));
    ok('跳转 URL 含 dim=operation', url.indexOf('dim=operation')>=0);
    const det=await page.evaluate(()=>({
      title:(document.getElementById('detailTitle')||{}).textContent||'',
      headCols:document.getElementById('detailHead')?document.getElementById('detailHead').querySelectorAll('th').length:0
    }));
    ok('detail 标题=WIP 在制 SN', det.title==='WIP 在制 SN');
    ok('detail 表头渲染', det.headCols>=5);
  } else {
    console.log('  ⚠ 未选线或无 stations 数据,下钻端到端跳过(绑定已验证,范式同 bad)');
  }

  // 双绑定修复:回 line-balance,点 kpiBalance → 不跳页
  await page.goto(base+'/line-balance.html',{waitUntil:'networkidle2',timeout:40000});
  await new Promise(r=>setTimeout(r,2500));
  const beforeUrl=page.url();
  await page.click('#kpiBalance');
  await new Promise(r=>setTimeout(r,800));
  const afterUrl=page.url();
  ok('点 kpiBalance 卡 → 不跳页(双绑定已修)', afterUrl===beforeUrl);

  ok('line-balance 0 pageerror(实际:'+pageErrors.length+')', pageErrors.length===0);
  if(pageErrors.length) pageErrors.slice(0,8).forEach(e=>console.log('    '+e));

  await browser.close();
  console.log('\n'+(fails.length?'FAIL: '+fails.join(', '):'ALL PASS'));
  process.exit(fails.length?1:0);
})();
