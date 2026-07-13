// 通用 MES API 调用器: puppeteer登录后 fetch 指定 path, 输出 JSON
// 用法: MES_PATH=/frontApi/xxx METHOD=GET [BODY={...}] node _call_mes.js
require('dotenv').config();
const puppeteer = require('puppeteer');
const MES_BASE = 'https://lh-cmes.cviauto.cn';
const UN = process.env.MES_USERNAME, PW = process.env.MES_PASSWORD;
const path_ = process.env.MES_PATH || '';
const method = process.env.METHOD || 'GET';
const body = process.env.BODY || '';

(async()=>{
  if (!path_) { console.error('MES_PATH required'); process.exit(1); }
  const b = await puppeteer.launch({ headless:'new', args:['--no-sandbox','--ignore-certificate-errors'] });
  const p = await b.newPage();
  await p.goto(MES_BASE+'/login?callback=%2F',{waitUntil:'domcontentloaded',timeout:30000});
  await p.waitForSelector('input[type="password"]',{timeout:10000});
  const ins=await p.$$('input[type="text"], input:not([type])'), pw=await p.$$('input[type="password"]');
  if(ins.length&&pw.length){ await ins[ins.length-1].focus(); await p.keyboard.type(UN); await pw[0].focus(); await p.keyboard.type(PW); const btn=await p.$('button[type="submit"], .ant-btn-primary'); if(btn) await btn.click(); }
  await p.waitForFunction(()=>!location.href.includes('/login'),{timeout:15000}).catch(()=>{});
  await p.goto(MES_BASE+'/',{waitUntil:'domcontentloaded'}).catch(()=>{}); await new Promise(r=>setTimeout(r,1200));
  const result = await p.evaluate(async (BASE, path_, method, body) => {
    const opt = { method, credentials:'include', headers:{'Content-Type':'application/json'} };
    if (body) opt.body = body;
    try { const r = await fetch(BASE+path_, opt); const t = await r.text(); return { status:r.status, body:t }; }
    catch(e) { return { error:e.message }; }
  }, MES_BASE, path_, method, body);
  // 只输出 JSON (跳过 dotenvx 提示行等非JSON stdout)
  const out = result.body || result.error;
  const firstBrace = out.indexOf('{');
  console.log(firstBrace > 0 ? out.slice(firstBrace) : out);
  await b.close();
})().catch(e=>{console.error('FATAL:',e);process.exit(1)});
