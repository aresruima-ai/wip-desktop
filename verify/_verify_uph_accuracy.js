// UPH 数据准确度/失真度评估: 全机型 实际UPH vs 目标UPH + 失真源量化
require('dotenv').config();
const db = require('../db');

(async()=>{
  await db.connect();
  const df='2026-04-17', dt='2026-06-27';  // 数据全窗口

  // 1) 全厂各机型段级 实际/目标/达成率
  console.log('=== 1) 各机型段级 UPH 实际 vs 目标 (数据全窗口 04-17~06-27) ===');
  console.log('机型 | 段 | 产出 | 实际UPH | 目标UPH | source | 达成率% | 判定');
  console.log('-'.repeat(105));

  // 拿所有有过产出的机型
  const col = db.getDb().collection('ai_production');
  const models = await col.distinct('ai_product_model', db.prefixAi({ product_model:{$nin:[null,'']}, move_out_time:{$gte:new Date(df).toISOString()} }));
  const summary = { total:0, op_hit:0, model_fallback:0, null_target:0, reasonable:0, low:0, absurd:0 };
  const rows = [];

  for (const model of models.sort()) {
    const r = await db.queryProductionByStageEnd(df, dt, {model});
    for (const s of r.stages) {
      if (s.output === 0) continue;
      summary.total++;
      const src = s.target_source || 'null';
      if (src === 'capacity_op') summary.op_hit++;
      else if (src === 'capacity_model') summary.model_fallback++;
      else summary.null_target++;
      const achieve = (s.uph!=null && s.target_uph && s.target_uph>0) ? +((s.uph/s.target_uph)*100).toFixed(0) : null;
      let judge = '-';
      if (achieve != null) {
        if (achieve >= 30 && achieve <= 150) { summary.reasonable++; judge='合理'; }
        else if (achieve >= 5) { summary.low++; judge='偏低'; }
        else { summary.absurd++; judge='失真'; }
      }
      rows.push({ model, stage:s.label, output:s.output, uph:s.uph, target:s.target_uph, src, achieve, judge });
      console.log(`${model} | ${s.label} | ${s.output} | ${s.uph??'-'} | ${s.target_uph??'-'} | ${src} | ${achieve!=null?achieve+'%':'-'} | ${judge}`);
    }
  }

  console.log('\n=== 2) 汇总 ===');
  console.log(`评估段数: ${summary.total}`);
  console.log(`目标源: 工序级(capacity_op)=${summary.op_hit} | 机型级兜底=${summary.model_fallback} | 无目标=${summary.null_target}`);
  console.log(`达成率: 合理(30-150%)=${summary.reasonable} | 偏低(5-30%)=${summary.low} | 失真(<5%)=${summary.absurd}`);

  // 3) 失真源诊断: 取一个失真机型(QOA.UB10.1242.MI)看运行时长 vs 产出
  console.log('\n=== 3) 失真源诊断: QOA.UB10.1242.MI (低产机型) ===');
  const diag = await db.queryProductionByStageEnd(df, dt, {model:'QOA.UB10.1242.MI'});
  console.log('run_hours(全厂T5/60):', diag.run_hours, '小时');
  console.log('产出仅437台/71天 → 437/710h≈0.6uph, 但用全厂runH除 → 严重压低');
  console.log('根因: 机型过滤时仍用全厂T5运行时长, 应改用该机型实际活跃时长');

  // 4) 对比: 高产机型 VQC1006-A
  console.log('\n=== 4) 对比: VQC1006-A (高产机型) ===');
  const diag2 = await db.queryProductionByStageEnd(df, dt, {model:'VQC1006-A'});
  console.log('run_hours:', diag2.run_hours, '| 包装产出:', diag2.stages[2].output, '| uph:', diag2.stages[2].uph, '| target:', diag2.stages[2].target_uph);
  const achieve2 = diag2.stages[2].uph / diag2.stages[2].target_uph * 100;
  console.log(`达成率: ${achieve2.toFixed(0)}% (量级合理, 但仍偏低→运行时长estimated含非该机型生产时间)`);

  process.exit(0);
})().catch(e=>{ console.error('ERR:',e); process.exit(1); });
