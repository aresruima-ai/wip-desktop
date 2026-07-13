// ABCD 变体层收口 — 视觉抽查截图(focal 激活态 + focus-side 2×2 + KPI 卡 + liquid)
const http=require('http');
function login(){return new Promise((res,rej)=>{const r=http.request({hostname:'127.0.0.1',port:8080,method:'POST',path:'/api/admin-login',headers:{'Content-Type':'application/json'}},rr=>{let d='';rr.on('data',c=>d+=c);rr.on('end',()=>{const sc=rr.headers['set-cookie']||[];res(sc[0]?sc[0].split(';')[0]:'');});});r.on('error',rej);r.write(JSON.stringify({key:'12345678'}));r.end();});}
(async()=>{
  const cookie=await login();
  const puppeteer=require('puppeteer');
  const browser=await puppeteer.launch({headless:'new',args:['--no-sandbox']});
  const pages=['portal.html','cockpit.html','wip.html','bad.html','fixture-life.html','line-balance.html'];
  for(const p of pages){
    const page=await browser.newPage();
    await page.setViewport({width:1440,height:900});
    await page.setCookie({name:'session',value:cookie.split('=')[1],domain:'127.0.0.1'});
    await page.goto('http://127.0.0.1:8080/'+p,{waitUntil:'networkidle2',timeout:20000});
    await new Promise(r=>setTimeout(r,2500));
    await page.screenshot({path:'verify/_vis_'+p.replace('.html','')+'.png'});
    console.log('shot '+p);
    await page.close();
  }
  await browser.close();
  console.log('done');
  process.exit(0);
})().catch(e=>{console.error('FATAL',e.message);process.exit(1);});
