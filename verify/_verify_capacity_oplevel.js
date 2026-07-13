// 验证工序级目标UPH: 先补工序mes_id(模拟server同步), 再跑queryProductionByStageEnd验工序级target
require('dotenv').config();
const puppeteer = require('puppeteer');
const path = require('path');
const db = require('../db');
const MES_BASE = 'https://lh-cmes.cviauto.cn';
const UN = process.env.MES_USERNAME, PW = process.env.MES_PASSWORD;

(async()=>{
  await db.connect();

  // 1) 用 puppeteer 登录拉工序列表, 补 mes_id 到 ai_work_operations (模拟 server 同步后状态)
  console.log('1) 拉工序列表补 mes_id...');
  const browser = await puppeteer.launch({ headless:'new', args:['--no-sandbox','--ignore-certificate-errors'] });
  const page = await browser.newPage();
  await page.goto(MES_BASE+'/login?callback=%2F',{waitUntil:'domcontentloaded',timeout:30000});
  await page.waitForSelector('input[type="password"]',{timeout:10000});
  const ins=await page.$$('input[type="text"], input:not([type])'), pw=await page.$$('input[type="password"]');
  if(ins.length&&pw.length){ await ins[ins.length-1].focus(); await page.keyboard.type(UN); await pw[0].focus(); await page.keyboard.type(PW); const b=await page.$('button[type="submit"], .ant-btn-primary'); if(b) await b.click(); }
  await page.waitForFunction(()=>!location.href.includes('/login'),{timeout:15000}).catch(()=>{});
  await page.goto(MES_BASE+'/',{waitUntil:'domcontentloaded'}).catch(()=>{}); await new Promise(r=>setTimeout(r,1200));
  const ops = await page.evaluate(async (BASE)=>{
    const r = await fetch(BASE+'/frontApi/prod/api/services/main-data/WorkOperation/GetCacheAllList?maxResultCount=9999&transactionType=1',{credentials:'include'});
    const j = await r.json(); return j?.result?.items||j?.result||[];
  }, MES_BASE);
  await browser.close();
  console.log('   MES工序:', ops.length, '条');

  const opCol = db.getDb().collection('ai_work_operations');
  let updated = 0;
  for (const op of ops) {
    const code = op.code || op.workOperationCode || '';
    if (!code || !op.id) continue;
    await opCol.updateOne(db.prefixAi({code}), { $set: db.prefixAi({ mes_id: op.id }) });
    updated++;
  }
  console.log('   补 mes_id:', updated, '条');
  // 验证 B50 的 mes_id 落地
  const b50 = await opCol.findOne(db.prefixAi({code:'B50'}));
  console.log('   B50 mes_id:', b50?.ai_mes_id || '无');

  // 2) 跑 queryProductionByStageEnd, 验证工序级 target
  // 选有 capacity 工序级数据的机型: QOA.UB10.1242.MI (capacity B50=uph45) / VQC1006-A (capacity B50=uph47 LH_GD04)
  console.log('\n2) 工序级目标UPH验证:');
  for (const model of ['QOA.UB10.1242.MI', 'VQC1006-A', 'QOA.UD03.1624.ZK']) {
    const r = await db.queryProductionByStageEnd('2026-04-17','2026-06-27',{model});
    console.log(`\n  机型 ${model}:`);
    r.stages.forEach(s => console.log(`    ${s.label}: output=${s.output} uph=${s.uph} target_uph=${s.target_uph} ct=${s.ct_seconds} source=${s.target_source||'-'}`));
  }

  // 3) 覆盖率: capacity工序级命中数 vs 机型级兜底数
  console.log('\n3) source 分布:');
  const r = await db.queryProductionByStageEnd('2026-04-17','2026-06-27',{model:'QOA.UB10.1242.MI'});
  const sources = r.stages.map(s=>s.target_source||'null');
  console.log('   QOA.UB10.1242.MI sources:', sources.join(','));

  process.exit(0);
})().catch(e=>{ console.error('ERR:',e); process.exit(1); });
