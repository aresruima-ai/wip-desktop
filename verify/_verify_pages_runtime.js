// 前端运行时: 各页加载后 0 pageerror + 无 401/500
const http=require('http');
function login(){return new Promise((res,rej)=>{const r=http.request({hostname:'127.0.0.1',port:8080,method:'POST',path:'/api/admin-login',headers:{'Content-Type':'application/json'}},rr=>{let d='';rr.on('data',c=>d+=c);rr.on('end',()=>{const sc=rr.headers['set-cookie']||[];res(sc[0]?sc[0].split(';')[0]:'');});});r.on('error',rej);r.write(JSON.stringify({key:'12345678'}));r.end();});}
(async()=>{
  const cookie=await login();
  const {spawn}=require('child_process');
  const pages=['portal.html','cockpit.html','wip.html','oee.html','bad.html','uph.html','fixture-life.html','kanban.html','line-balance.html','settings.html'];
  // 用 puppeteer 注入 cookie 打开页面, 收集 pageerror
  const puppeteer=require('puppeteer');
  const browser=await puppeteer.launch({headless:'new',args:['--no-sandbox']});
  let pass=0,fail=0;
  for(const p of pages){
    const page=await browser.newPage();
    const errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    page.on('console',m=>{if(m.type()==='error')errors.push('console:'+m.text().slice(0,80));});
    try{
      await page.setCookie({name:'session',value:cookie.split('=')[1],domain:'127.0.0.1'});
      await page.goto('http://127.0.0.1:8080/'+p,{waitUntil:'networkidle2',timeout:20000});
      await new Promise(r=>setTimeout(r,1500));
      const ok=errors.length===0;
      console.log((ok?'PASS':'FAIL')+' '+p+(ok?'':'  ERR='+errors.slice(0,2).join(' | ')));
      if(ok)pass++;else fail++;
    }catch(e){console.log('FAIL '+p+'  '+e.message.slice(0,60));fail++;}
    await page.close();
  }
  await browser.close();
  console.log('\n=== '+pass+' PASS / '+fail+' FAIL ===');
  process.exit(fail?1:0);
})().catch(e=>{console.error('FATAL',e.message);process.exit(1);});
