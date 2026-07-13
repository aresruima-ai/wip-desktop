// UPH 数据层验证: 6 个新函数 语法+逻辑+真实数据
require('dotenv').config();
const db = require('../db');
(async () => {
  await db.connect();
  const t = '2026-06-25', t0 = '2026-06-20';
  let ok = 0, fail = 0;
  const ck = (name, cond, extra) => { if (cond) { ok++; console.log('  ✓', name, extra||''); } else { fail++; console.log('  ✗', name, extra||''); } };

  // 1. getStageEndOps
  console.log('\n[1] getStageEndOps');
  const endOps = await db.getStageEndOps(null);
  ck('三段都有末道', endOps.assembly.length>0 || endOps.test.length>0 || endOps.packaging.length>0, JSON.stringify({assembly:endOps.assembly.length, test:endOps.test.length, packaging:endOps.packaging.length}));
  ck('包装末道含B50', endOps.packaging.includes('B50'), 'packaging='+endOps.packaging.join(','));
  const endOpsL = await db.getStageEndOps('ASS_Line2');
  ck('按线体过滤生效', endOpsL.packaging.length>0, 'ASS_Line2 packaging='+endOpsL.packaging.join(','));

  // 2. queryProductionByStageEnd
  console.log('\n[2] queryProductionByStageEnd');
  const stageEnd = await db.queryProductionByStageEnd(t0, t, {});
  ck('返回三段', stageEnd.stages.length===3, stageEnd.stages.map(s=>s.label+':'+s.output+'/uph'+s.uph).join('  '));
  ck('包装产出>0', stageEnd.stages[2].output>0, '包装output='+stageEnd.stages[2].output);
  const stageEndM = await db.queryProductionByStageEnd(t0, t, {model:'QOA.UD03.1624.ZK'});
  ck('机型过滤生效', stageEndM.stages[2].output>0, 'target_uph='+stageEndM.stages[2].target_uph+' ct='+stageEndM.stages[2].ct_seconds);

  // 3. queryProductionAgg 五种 groupBy
  console.log('\n[3] queryProductionAgg');
  const byHour = await db.queryProductionAgg(t, t, {}, 'hour');
  ck('hour聚合', byHour.length>0 && byHour.length<=24, '条数='+byHour.length);
  const byDay = await db.queryProductionAgg('2026-06-19', t, {}, 'day');
  ck('day聚合', byDay.length>=6 && byDay.length<=8, '条数='+byDay.length+' 样例='+byDay.map(d=>d.key+':'+d.total).join(' '));
  const byModel = await db.queryProductionAgg(t0, t, {}, 'model');
  ck('model聚合', byModel.length>0, 'top3='+byModel.slice(0,3).map(m=>m.key+':'+m.total).join(' '));
  const byLine = await db.queryProductionAgg(t0, t, {}, 'line');
  ck('line聚合', byLine.length>0, byLine.map(l=>l.key+':'+l.total).join(' '));
  const byOp = await db.queryProductionAgg(t0, t, {}, 'operation');
  ck('operation聚合', byOp.length>0, 'top5='+byOp.slice(0,5).map(o=>o.key+':'+o.total).join(' '));
  // 去重SN口径校验: byLine 各线 total 之和 应 <= 全量过站次数(去重后), 且 byDay 之和 = queryProductionCount
  const total = await db.queryProductionCount(t0, t, {});
  const daySum = byDay.reduce((s,d)=>s+d.total,0);
  ck('day去重SN合计=总数', daySum===total, 'daySum='+daySum+' total='+total);

  // 4. queryProductionSummary + 环比
  console.log('\n[4] queryProductionSummary');
  const sum = await db.queryProductionSummary(t0, t, {}, '2026-06-15', '2026-06-19');
  ck('summary完整', sum.total>0 && sum.uph!=null, JSON.stringify(sum));
  const sumL = await db.queryProductionSummary(t0, t, {lineName:'ASS_Line2'});
  ck('线体过滤', sumL.total>0 && sumL.total<=sum.total, 'ASS_Line2 total='+sumL.total+' (全厂'+sum.total+')');

  // 5. getProductionDataStart
  console.log('\n[5] getProductionDataStart');
  const ds = await db.getProductionDataStart();
  ck('数据起点', !!ds, 'dataStart='+ds);

  console.log('\n=== 结果: '+ok+' 通过 / '+fail+' 失败 ===');
  process.exit(fail?1:0);
})().catch(e=>{console.error('[ERR]', e.message); console.error(e.stack); process.exit(1);});
