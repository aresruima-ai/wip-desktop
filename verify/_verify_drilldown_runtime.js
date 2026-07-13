// Phase4 — 全站回归:detail 3 新 source(output-sn/sn-trace/rework)渲染 + 8 页 0 pageerror
const puppeteer=require('puppeteer');
const base='http://localhost:8080';
(async()=>{
  let r;
  try{ r=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'yangning',password:'Yn@20250908'})}); }
  catch(e){ console.error('LOGIN FAIL',e.message); process.exit(1); }
  const m=(r.headers.get('set-cookie')||'').match(/session=([^;]+)/);
  if(!m){ console.error('LOGIN FAILED'); process.exit(1); }
  console.log('login ok');
  const cookie={name:'session',value:m[1],domain:'localhost',path:'/'};

  // 取一个真实 barcode 用于 sn-trace(T7 后 envelope={success,data:{items,total,page,pageSize}},兼容旧裸数组)
  let barcode=null;
  try{ const j=await (await fetch(base+'/api/output/sns?dateFrom=2026-06-01&dateTo=2026-06-25',{headers:{Cookie:'session='+m[1]}})).json(); const arr=(j&&j.data&&(Array.isArray(j.data)?j.data:j.data.items))||[]; if(arr[0]) barcode=arr[0].barcode; }catch(e){}

  const browser=await puppeteer.launch({headless:'new',args:['--no-sandbox','--disable-gpu']});
  const fails=[];
  function ok(name,cond){ console.log((cond?'  ✓ ':'  ✗ ')+name); if(!cond) fails.push(name); }

  // 1. detail output-sn 渲染(有数据)
  let page=await browser.newPage();
  await page.setViewport({width:1920,height:1080});
  await page.setCookie(cookie);
  await page.goto(base+'/detail.html?source=output-sn&dateFrom=2026-06-01&dateTo=2026-06-25&from=portal.html',{waitUntil:'networkidle2',timeout:30000});
  await new Promise(r=>setTimeout(r,2500));
  let d=await page.evaluate(()=>({title:(document.getElementById('detailTitle')||{}).textContent||'',head:document.getElementById('detailHead')?document.getElementById('detailHead').querySelectorAll('th').length:0,info:(document.getElementById('tableInfo')||{}).textContent||''}));
  ok('detail output-sn 标题=产量 SN 流水', d.title==='产量 SN 流水');
  ok('detail output-sn 表头渲染', d.head>=4);
  ok('detail output-sn 有真实数据(共N条,N>0)', /共 (\d+) 条/.test(d.info) && parseInt((d.info.match(/共 (\d+) 条/)||[])[1]||'0')>0);

  // 2. detail rework 渲染(空态诚实)
  await page.goto(base+'/detail.html?source=rework&dateFrom=2026-06-01&dateTo=2026-06-25&from=bad.html',{waitUntil:'networkidle2',timeout:30000});
  await new Promise(r=>setTimeout(r,2000));
  d=await page.evaluate(()=>({title:(document.getElementById('detailTitle')||{}).textContent||'',info:(document.getElementById('tableInfo')||{}).textContent||'',empty:!!document.querySelector('.detail-empty')}));
  ok('detail rework 标题=返工明细', d.title==='返工明细');
  ok('detail rework 空数据诚实(共0条或空态)', /共 0 条/.test(d.info)||d.empty);

  // 3. detail sn-trace(barcode)
  if(barcode){
    await page.goto(base+'/detail.html?source=sn-trace&dimValue='+encodeURIComponent(barcode)+'&from=wip.html',{waitUntil:'networkidle2',timeout:30000});
    await new Promise(r=>setTimeout(r,2000));
    d=await page.evaluate(()=>({title:(document.getElementById('detailTitle')||{}).textContent||'',head:document.getElementById('detailHead')?document.getElementById('detailHead').querySelectorAll('th').length:0,info:(document.getElementById('tableInfo')||{}).textContent||''}));
    ok('detail sn-trace 标题=SN 过站轨迹', d.title==='SN 过站轨迹');
    ok('detail sn-trace 表头渲染', d.head>=3);
    ok('detail sn-trace 有轨迹数据(共N条)', /共 \d+ 条/.test(d.info));
  } else {
    ok('sn-trace 取 barcode 跳过(无产量数据)', false);
  }
  await page.close();

  // 4. 8 页 0 pageerror 回归
  const pages8=['portal','cockpit','oee','wip','bad','line-balance','kanban','ai-center'];
  let totalErr=0;
  for(const p of pages8){
    page=await browser.newPage();
    await page.setCookie(cookie);
    const errs=[];
    page.on('pageerror',e=>errs.push(e.message));
    await page.goto(base+'/'+p+'.html',{waitUntil:'networkidle2',timeout:40000});
    await new Promise(r=>setTimeout(r,3000));
    totalErr+=errs.length;
    if(errs.length){ console.log('  ✗ '+p+'.html '+errs.length+' pageerror'); errs.slice(0,3).forEach(e=>console.log('    '+e)); }
    await page.close();
  }
  ok('8 看板页 0 pageerror 回归(总:'+totalErr+')', totalErr===0);

  await browser.close();
  console.log('\n'+(fails.length?'FAIL: '+fails.join(', '):'ALL PASS'));
  process.exit(fails.length?1:0);
})();
