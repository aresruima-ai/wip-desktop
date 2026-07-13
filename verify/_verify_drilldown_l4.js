// L4 验证:detail bad-records 明细行点击(barcode)→ 自动跳 sn-trace 轨迹页
const puppeteer=require('puppeteer');
const base='http://localhost:8080';
(async()=>{
  let r;
  try{ r=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'yangning',password:'Yn@20250908'})}); }
  catch(e){ console.error('LOGIN FAIL',e.message,'(确认 server 在 8080)'); process.exit(1); }
  const m=(r.headers.get('set-cookie')||'').match(/session=([^;]+)/);
  if(!m){ console.error('LOGIN FAILED'); process.exit(1); }
  console.log('login ok');

  const browser=await puppeteer.launch({headless:'new',args:['--no-sandbox','--disable-gpu']});
  const page=await browser.newPage();
  await page.setViewport({width:1920,height:1080});
  await page.setCookie({name:'session',value:m[1],domain:'localhost',path:'/'});
  const fails=[];
  function ok(name,cond){ console.log((cond?'  ✓ ':'  ✗ ')+name); if(!cond) fails.push(name); }

  // detail bad-records(有 SN 数据)
  await page.goto(base+'/detail.html?source=bad-records&dateFrom=2026-06-01&dateTo=2026-06-25&from=bad.html',{waitUntil:'networkidle2',timeout:30000});
  await new Promise(r=>setTimeout(r,2500));
  const rowInfo=await page.evaluate(()=>{
    var tr=document.querySelector('#detailBody tr[data-idx="0"]');
    return {hasRow:!!tr, barcode: tr?tr.querySelector('td')?tr.querySelector('td').textContent:'' : ''};
  });
  ok('bad-records 明细有数据行', rowInfo.hasRow);

  if(rowInfo.hasRow){
    // 点第一行(有 barcode → 应跳 sn-trace)
    await page.click('#detailBody tr[data-idx="0"]');
    await new Promise(r=>setTimeout(r,2500));
    const url=page.url();
    ok('点明细行(barcode)→ 跳 detail?source=sn-trace', /detail\.html\?source=sn-trace/.test(url));
    ok('URL 含 dimValue=barcode', url.indexOf('dimValue=')>=0);
    const d=await page.evaluate(()=>({
      title:(document.getElementById('detailTitle')||{}).textContent||'',
      head:document.getElementById('detailHead')?document.getElementById('detailHead').querySelectorAll('th').length:0,
      info:(document.getElementById('tableInfo')||{}).textContent||''
    }));
    ok('sn-trace 标题=SN 过站轨迹', d.title==='SN 过站轨迹');
    ok('sn-trace 表头渲染(工序/时间/线体)', d.head>=3);
    ok('sn-trace 有轨迹数据(共N条)', /共 \d+ 条/.test(d.info) && parseInt((d.info.match(/共 (\d+) 条/)||[])[1]||'0')>=1);
  }

  await browser.close();
  console.log('\n'+(fails.length?'FAIL: '+fails.join(', '):'ALL PASS'));
  process.exit(fails.length?1:0);
})();
