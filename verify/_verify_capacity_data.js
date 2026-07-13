// 验证 CapacityDataSet 接入: 灌数据 → 集合检查 → 目标UPH换源 → 覆盖率提升 → 对账
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../db');

(async()=>{
  await db.connect();
  const items = JSON.parse(fs.readFileSync(path.join(__dirname,'_seed_capacity_full.json'),'utf8'));
  console.log('1) 灌入 capacity_full.json:', items.length, '条');
  await db.saveCapacityData(items);

  const col = db.getDb().collection('ai_capacity_data');
  const cnt = await col.countDocuments();
  const models = await col.distinct('ai_product_model');
  const segs = await col.distinct('ai_process_segment_code');
  const ops = await col.distinct('ai_work_operation_id');
  const sample = await col.findOne({});
  console.log('2) 集合: count=', cnt, '| 机型=', models.length, '| 工艺段=', segs.length, '| 工序=', ops.length);
  console.log('   字段:', Object.keys(sample).join(', '));
  console.log('   样本:', JSON.stringify(sample).slice(0,300));

  // 3) 目标UPH换源验证: QOA.UB10.1242.MI → capacity ct=80 → target_uph=45 (旧product_config=50)
  console.log('\n3) 目标UPH换源 (QOA.UB10.1242.MI, 期望 target_uph=45 / ct=80):');
  const stage1 = await db.queryProductionByStageEnd('2026-04-17','2026-06-27',{model:'QOA.UB10.1242.MI'});
  stage1.stages.forEach(s => console.log(`   ${s.label}: output=${s.output} uph=${s.uph} target_uph=${s.target_uph} ct=${s.ct_seconds}`));

  // 4) 覆盖率提升: IMT1206-D (capacity有/pc无) → target_uph 应有值
  console.log('\n4) 覆盖率提升 (IMT1206-D, capacity有/pc无, 期望 target_uph 有值):');
  const stage2 = await db.queryProductionByStageEnd('2026-04-17','2026-06-27',{model:'IMT1206-D'});
  stage2.stages.forEach(s => console.log(`   ${s.label}: output=${s.output} uph=${s.uph} target_uph=${s.target_uph} ct=${s.ct_seconds}`));

  // 5) 对账: cap vs pc 差异
  console.log('\n5) 对账 (cap_ct vs pc_ct):');
  const [capData, products] = await Promise.all([db.getCapacityData(), db.getProducts()]);
  const capByModel = {};
  capData.forEach(c => { if(c.product_model && c.order_type==='量产' && c.ct!=null) capByModel[c.product_model]=c.ct; else if(c.product_model && !(c.product_model in capByModel) && c.ct!=null) capByModel[c.product_model]=c.ct; });
  const pcByModel = {}; products.forEach(p=>{ if(p.product_model) pcByModel[p.product_model]=p.cycle_time; });
  let both=0, diff=0, onlyCap=0, onlyPc=0;
  Object.keys(capByModel).forEach(m=>{ if(m in pcByModel){ both++; if(capByModel[m]!==pcByModel[m]) diff++; } else onlyCap++; });
  Object.keys(pcByModel).forEach(m=>{ if(!(m in capByModel)) onlyPc++; });
  console.log(`   两源都有: ${both} (其中数值不一致: ${diff}) | 仅capacity: ${onlyCap} | 仅product_config: ${onlyPc}`);
  console.log('   不一致示例:');
  Object.keys(capByModel).filter(m=>m in pcByModel && capByModel[m]!==pcByModel[m]).slice(0,5).forEach(m=>console.log(`     ${m}: cap_ct=${capByModel[m]} pc_ct=${pcByModel[m]}`));

  process.exit(0);
})().catch(e=>{ console.error('ERR:', e); process.exit(1); });
