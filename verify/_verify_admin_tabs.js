const puppeteer=require('puppeteer');const BASE='http://localhost:8080';
(async()=>{
  const b=await puppeteer.launch({headless:'new',args:['--no-sandbox']});
  const p=await b.newPage();const errs=[];
  p.on('pageerror',e=>errs.push('PAGEERROR: '+e.message));
  p.on('console',m=>{if(m.type()==='error')errs.push('CONSOLE: '+m.text());});
  await p.goto(BASE+'/portal.html',{waitUntil:'domcontentloaded'});
  await p.evaluate(async()=>{await fetch('/api/admin-login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:'12345678'})});});
  await p.goto(BASE+'/admin.html',{waitUntil:'networkidle0',timeout:20000});
  // 逐个点 tab, 收集每个 tab 是否有内容 + 错误
  const tabs=['users','data','ops','fixture','monitor'];
  const res={};
  for(const t of tabs){
    errs.length=0;
    await p.click('#tabs .tab-btn[data-tab="'+t+'"]').catch(()=>{});
    await new Promise(r=>setTimeout(r,2500));
    res[t]=await p.evaluate((t)=>({
      active: !!document.querySelector('#tab-'+t+'.active'),
      // 该tab下第一个表格行数(粗略判断有内容)
      rows: document.querySelectorAll('#tab-'+t+' tr').length
    }),t);
    res[t].errs=errs.length;
  }
  console.log(JSON.stringify(res,null,1));
  console.log('total pageerrors:',errs.length);
  await b.close();process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
