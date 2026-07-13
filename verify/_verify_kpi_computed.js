// ABCD 变体层收口 — computed style 精确确认(去锁后值是否正确,不依赖视觉)
const http=require('http');
function login(){return new Promise((res,rej)=>{const r=http.request({hostname:'127.0.0.1',port:8080,method:'POST',path:'/api/admin-login',headers:{'Content-Type':'application/json'}},rr=>{let d='';rr.on('data',c=>d+=c);rr.on('end',()=>{const sc=rr.headers['set-cookie']||[];res(sc[0]?sc[0].split(';')[0]:'');});});r.on('error',rej);r.write(JSON.stringify({key:'12345678'}));r.end();});}
(async()=>{
  const cookie=await login();
  const puppeteer=require('puppeteer');
  const browser=await puppeteer.launch({headless:'new',args:['--no-sandbox']});
  const checks={
    'portal.html':[[".focus-side","grid-template-columns"],[".portal-focus .focus-mini","min-height"]],
    'cockpit.html':[[".kpi-row.cockpit .kpi-value","font-size"],[".kpi-row.cockpit .kpi-card","padding"],[".kpi-row.cockpit .kpi-label","color"]],
    'wip.html':[[".focus-mini--liquid","min-height"]],
    'bad.html':[[".bad-page .kpi-value","line-height"]],
    'fixture-life.html':[[".kpi-sub","margin-top"],[".kpi-sub","text-align"]]
  };
  let fail=0;
  for(const p of Object.keys(checks)){
    const page=await browser.newPage();
    await page.setViewport({width:1440,height:900});
    await page.setCookie({name:'session',value:cookie.split('=')[1],domain:'127.0.0.1'});
    await page.goto('http://127.0.0.1:8080/'+p,{waitUntil:'networkidle2',timeout:20000});
    await new Promise(r=>setTimeout(r,2000));
    for(const [sel,prop] of checks[p]){
      const val=await page.evaluate((s,pr)=>{const el=document.querySelector(s);if(!el)return 'NO_EL';return getComputedStyle(el).getPropertyValue(pr);},sel,prop);
      console.log(p+'  '+sel+'.'+prop+' = '+val);
    }
    await page.close();
  }
  await browser.close();
  process.exit(0);
})().catch(e=>{console.error('FATAL',e.message);process.exit(1);});
