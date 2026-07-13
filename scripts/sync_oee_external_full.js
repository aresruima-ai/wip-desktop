#!/usr/bin/env node
/**
 * OEE外部库 → mes_dashboard 整表迁移(方案B: 全表原样拷贝)
 * 把4个产线OEE库的表原样拷进 mes_dashboard, 每张表加产线前缀避免重名。
 * 不聚合、不挑字段、不改 schema — 完整保留原始数据, 后续要算什么再说。
 *
 * 目标表命名: ai_oee_<产线简称>_<原表名>
 *   功放1线OEE/202606  → ai_oee_gongfang1_202606
 *   功放2线OEE/202606  → ai_oee_gongfang2_202606
 *   整机1线OEE/202606  → ai_oee_zhengji1_202606
 *   整机3线OEE/202606  → ai_oee_zhengji3_202606
 *
 * 可重复运行: 每张目标表先 drop 再拷(保证与源一致)。
 * 用法:
 *   node scripts/sync_oee_external_full.js            # 实跑
 *   node scripts/sync_oee_external_full.js --dry-run  # 只看不动
 */
require('dotenv').config();
const { MongoClient } = require('mongodb');

const DRY = process.argv.includes('--dry-run');

// 源库名 → 目标表前缀(产线简称)
const DB_TO_PREFIX = {
  '功放1线OEE': 'ai_oee_gongfang1_',
  '功放2线OEE': 'ai_oee_gongfang2_',
  '整机1线OEE': 'ai_oee_zhengji1_',
  '整机3线OEE': 'ai_oee_zhengji3_',
};

(async () => {
  const srcUri = process.env.OEE_EXTERNAL_URI;
  if (!srcUri) { console.error('[full] 未配置 OEE_EXTERNAL_URI'); process.exit(1); }
  console.log('[full] 模式:', DRY ? 'DRY-RUN' : '整表迁移', '源:', srcUri.replace(/\/\/[^@]+@/, '//***@'));

  const client = new MongoClient(srcUri, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  const targetDb = client.db(process.env.MONGO_DB || 'mes_dashboard');

  let totalDocs = 0, totalTables = 0;
  for (const [dn, prefix] of Object.entries(DB_TO_PREFIX)) {
    const srcDb = client.db(dn);
    let cols;
    try { cols = await srcDb.listCollections({}).toArray(); }
    catch (e) { console.log('\n[full] 读不到', dn, ':', e.message.substring(0, 60)); continue; }

    console.log('\n=== ' + dn + ' ===');
    if (!cols.length) { console.log('  (空库)'); continue; }

    for (const c of cols) {
      const srcColl = srcDb.collection(c.name);
      const count = await srcColl.estimatedDocumentCount();
      const targetName = prefix + c.name;
      console.log('  ' + c.name + ' (' + count + '行) → ' + targetName);

      if (DRY) { totalTables++; totalDocs += count; continue; }

      // drop 目标表(若存在)再拷, 保证与源完全一致
      try { await targetDb.dropCollection(targetName); } catch (e) {}
      // 用 aggregate+$out 直接在服务器端拷(同实例, 快; 不走客户端网络)
      await srcColl.aggregate([{ $match: {} }, { $project: { _id: 1, _src_db: { $literal: dn }, _src_coll: { $literal: c.name } } }]).toArray();
      // $out 跨库不行, 改用客户端流式拷(数据量小, 48行无所谓)
      const docs = await srcColl.find({}).toArray();
      // 保留原 _id, 加来源标记
      for (const d of docs) { d._src_db = dn; d._src_coll = c.name; }
      if (docs.length) await targetDb.collection(targetName).insertMany(docs, { ordered: false });
      try { await targetDb.collection(targetName).createIndex({ _src_db: 1 }); } catch (e) {}
      console.log('    拷入', docs.length, '行');
      totalTables++; totalDocs += docs.length;
    }
  }

  console.log('\n[full] 完成' + (DRY ? '(dry-run)' : ', 总 ' + totalTables + ' 表 ' + totalDocs + ' 行 → mes_dashboard'));
  if (!DRY) {
    const all = await targetDb.listCollections({ nameOnly: true }).toArray();
    const oee = all.filter(x => x.name.startsWith('ai_oee_')).map(x => x.name);
    console.log('[full] mes_dashboard 现有 ai_oee_* 表:', oee.join(', '));
  }
  await client.close();
})().catch(e => { console.error('[full] 失败:', e.message); process.exit(1); });
