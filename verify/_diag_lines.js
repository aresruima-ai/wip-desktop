// 诊断: 功放1线/功放2线/整机1线/整机2线 是什么 + 为何 OEE=0
// 用法: node verify/_diag_lines.js
require('dotenv').config({path:__dirname+'/../.env'});
const db = require('../db.js');

function pad(n){return String(n).padStart(2,'0');}
function todayStr(){const d=new Date();return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());}

(async()=>{
  await db.connect();
  const D = todayStr();
  console.log('=== 运营日:', D, '===');

  // 1. 全部线体(line_config)
  const lines = await db.getLines();
  console.log('\n=== ai_line_config 全部线体 ('+lines.length+') ===');
  for(const l of lines){
    const shifts = (l.shifts&&l.shifts.length)? l.shifts.map(s=>s.name+'('+s.start+'-'+s.end+')').join(',') : '无';
    console.log(`  ${l.line_name}  sort_order=${l.sort_order}  is_active=${l.is_active}  shifts=${shifts}`);
  }

  // 2. 针对目标线: 产量/OEE/班次
  const targets = ['功放1线','功放2线','整机1线','整机2线'];
  console.log('\n=== 目标线体 产量/OEE/班次 ===');
  for(const ln of targets){
    const total = await db.queryProductionTotal(D, D, ln);
    let shift = null;
    try{ shift = await db.getShiftConfig(ln); }catch(e){ shift=null; }
    const hasShift = shift && Array.isArray(shift.shifts) && shift.shifts.length>0;
    let oee = null, err=null;
    try{ oee = await db.computeOEE(D, D, ln); }catch(e){ err=e.message; }
    console.log(`\n  [${ln}]`);
    console.log(`    今日产量(去重SN): ${total}`);
    console.log(`    班次配置: ${hasShift? '有('+shift.shifts.length+'班)' : '无'}`);
    if(err) console.log(`    OEE计算异常: ${err}`);
    else if(oee){
      console.log(`    OEE: ${oee.oee!=null?(oee.oee*100).toFixed(1)+'%':'null'}  (A=${oee.availability!=null?(oee.availability*100).toFixed(1)+'%':'-'} P=${oee.performance!=null?(oee.performance*100).toFixed(1)+'%':'-'} Q=${oee.quality!=null?(oee.quality*100).toFixed(1)+'%':'-'})`);
      console.log(`    run_time=${oee.run_time}  downtime=${oee.downtime}  total_output=${oee.total_output}  good=${oee.good_output}  ct_source=${oee.ct_source||oee.ctSource}`);
    }
  }

  // 3. 近30天这些线是否有产量
  const mdb = db.getDb();
  console.log('\n=== 近30天产量分布(按线) ===');
  const from30 = new Date(Date.now()-30*86400000);
  const f = from30.getFullYear()+'-'+pad(from30.getMonth()+1)+'-'+pad(from30.getDate());
  const pipe=[{$match:{move_out_date:{$gte:f,$lte:D},line_name:{$nin:[null,'']}}},{$group:{_id:'$line_name',n:{$sum:1}}},{$sort:{n:-1}}];
  const rows = await mdb.collection('ai_production').aggregate(pipe).toArray();
  for(const r of rows) console.log(`  ${r._id}: ${r.n} 条`);
  process.exit(0);
})().catch(e=>{console.error('FATAL',e);process.exit(1);});
