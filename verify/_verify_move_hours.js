// 验证 P0-2: 拉moveOutWorkHours灌入→查getMesRunHours→对比estimated vs MES失真修复
require('dotenv').config();
const puppeteer = require('puppeteer');
const db = require('../db');
const MES_BASE = 'https://lh-cmes.cviauto.cn';
const UN = process.env.MES_USERNAME, PW = process.env.MES_PASSWORD;

(async()=>{
  await db.connect();

  // 1) puppeteer 登录拉多批 moveOutWorkHours 灌入
  console.log('1) 拉取 moveOutWorkHours 灌入...');
  const browser = await puppeteer.launch({ headless:'new', args:['--no-sandbox','--ignore-certificate-errors'] });
  const page = await browser.newPage();
  await page.goto(MES_BASE+'/login?callback=%2F',{waitUntil:'domcontentloaded',timeout:30000});
  await page.waitForSelector('input[type="password"]',{timeout:10000});
  const ins=await page.$$('input[type="text"], input:not([type])'), pw=await page.$$('input[type="password"]');
  if(ins.length&&pw.length){ await ins[ins.length-1].focus(); await page.keyboard.type(UN); await pw[0].focus(); await page.keyboard.type(PW); const b=await page.$('button[type="submit"], .ant-btn-primary'); if(b) await b.click(); }
  await page.waitForFunction(()=>!location.href.includes('/login'),{timeout:15000}).catch(()=>{});
  await page.goto(MES_BASE+'/',{waitUntil:'domcontentloaded'}).catch(()=>{}); await new Promise(r=>setTimeout(r,1200));

  let totalIngested = 0, totalCount = 0;
  for (let skip=0; skip<3000; skip+=500) {
    const items = await page.evaluate(async (BASE, skip) => {
      const r = await fetch(BASE+`/frontApi/prod/api/services/mbiz/DailyReport/GetTaskMoveRecordPages?maxResultCount=500&skipCount=${skip}`,{credentials:'include'});
      const t = await r.text();
      try { const j = JSON.parse(t); return { items: j?.result?.items||[], totalCount: j?.result?.totalCount||0 }; } catch(e) { return { items:[], totalCount:0 }; }
    }, MES_BASE, skip);
    if (!items.items.length) break;
    totalCount = items.totalCount;
    const n = await db.saveTaskMoveHours(items.items);
    totalIngested += n;
    console.log(`  skip=${skip} +${n} 累计${totalIngested}/${totalCount}`);
    if (items.items.length < 500 || skip+500 >= totalCount) break;
    await new Promise(r=>setTimeout(r,300));
  }
  await browser.close();
  console.log('  灌入完成:', totalIngested, '条 / MES总', totalCount);

  // 2) 集合检查
  const col = db.getDb().collection('ai_task_move_hours');
  const cnt = await col.countDocuments();
  const valid = await col.countDocuments({ ai_record_type: 2, ai_move_out_work_hours: { $gt: 0 } });
  const dates = await col.distinct('ai_produce_date');
  const lines = await col.distinct('ai_line_name');
  console.log('\n2) 集合: count=', cnt, '| 有效(rt2&move>0)=', valid, '| 日期数=', dates.length, '| 线体=', lines.length);
  console.log('   日期:', dates.sort().join(', '));
  console.log('   线体:', lines.join(', '));

  if (!dates.length) { console.log('无数据,终止'); process.exit(1); }
  const testDate = dates.includes('2026-06-26') ? '2026-06-26' : dates.sort()[dates.length-1];

  // 3) getMesRunHours 查询
  console.log('\n3) getMesRunHours ('+testDate+'):');
  for (const line of lines.slice(0,4)) {
    const mes = await db.getMesRunHours(testDate, testDate, line, null);
    console.log(`   ${line} | MES工时=${mes.totalHours}h coverage=${mes.coverage}`);
  }

  // 4) 失真修复实证
  console.log('\n4) 失真修复实证 (queryProductionSummary 单线, source应为mes):');
  for (const line of lines.slice(0,3)) {
    const s = await db.queryProductionSummary(testDate, testDate, {lineName:line}, null, null);
    console.log(`   ${line}: total=${s.total} uph=${s.uph} runH=${s.run_hours}h source=${s.run_source}`);
  }

  // 5) stageEnd run_source
  console.log('\n5) stageEnd run_source:');
  const se = await db.queryProductionByStageEnd(testDate, testDate, {lineName:lines[0]});
  console.log(`   ${lines[0]}: run_source=${se.run_source} runH=${se.run_hours}h`);
  se.stages.forEach(s=>console.log(`     ${s.label}: output=${s.output} uph=${s.uph} target=${s.target_uph}`));

  process.exit(0);
})().catch(e=>{ console.error('ERR:', e.message, e.stack); process.exit(1); });

