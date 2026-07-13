#!/usr/bin/env node
/**
 * OEE外部库 → mes_dashboard "移动"收尾: 删除源库
 * 前置: 数据已由 sync_oee_external_full.js 拷进 mes_dashboard 并验证一致。
 * 本脚本: 再次逐一核对 源行数==目标行数, 全部一致才 drop 4个源库; 任一不一致则中止(不删)。
 *
 * 删除范围: dropDatabase(整个库从服务器移除, Compass里消失)。
 * 不可逆。脚本会打印每步, 全部校验通过才执行删除。
 *
 * 用法:
 *   node scripts/move_oee_external_drop_source.js            # 核对+删
 *   node scripts/move_oee_external_drop_source.js --check    # 只核对不删
 */
require('dotenv').config();
const { MongoClient } = require('mongodb');

const CHECK_ONLY = process.argv.includes('--check');

// 源库 → mes_dashboard目标表
const MAP = [
  ['功放1线OEE', '202606', 'ai_oee_gongfang1_202606'],
  ['功放2线OEE', '202606', 'ai_oee_gongfang2_202606'],
  ['整机1线OEE', '202606', 'ai_oee_zhengji1_202606'],
  ['整机3线OEE', '202606', 'ai_oee_zhengji3_202606'],
];

(async () => {
  const admin = new MongoClient(process.env.OEE_EXTERNAL_URI, { serverSelectionTimeoutMS: 5000 });
  const mes = new MongoClient(process.env.MONGO_URI, { serverSelectionTimeoutMS: 5000 });
  await Promise.all([admin.connect(), mes.connect()]);
  const mesDb = mes.db('mes_dashboard');

  console.log('[move] 模式:', CHECK_ONLY ? '仅核对(不删)' : '核对+删除源库');
  console.log('[move] 第1步: 逐一核对 源行数 vs 目标行数\n');

  let allMatch = true;
  for (const [dn, srcColl, tgt] of MAP) {
    let s, t;
    try { s = await admin.db(dn).collection(srcColl).countDocuments(); }
    catch (e) { console.log('  ✗ 源库读不到 ' + dn + ': ' + e.message.substring(0, 50)); allMatch = false; continue; }
    t = await mesDb.collection(tgt).countDocuments();
    const ok = s === t;
    if (!ok) allMatch = false;
    console.log('  ' + (ok ? '✓' : '✗') + ' ' + dn + '/' + srcColl + '=' + s + '  vs  mes_dashboard/' + tgt + '=' + t + (ok ? '  一致' : '  不一致!'));
  }

  if (!allMatch) { console.log('\n[move] 核对未全部通过, 中止删除(源库保留)。请先重跑 sync_oee_external_full.js。'); await Promise.all([admin.close(), mes.close()]); process.exit(1); }
  console.log('\n[move] 全部一致 ✓');

  if (CHECK_ONLY) { console.log('[move] --check 模式, 不删除。'); await Promise.all([admin.close(), mes.close()]); return; }

  console.log('\n[move] 第2步: 删除4个源库(dropDatabase, 不可逆)');
  for (const [dn] of MAP) {
    try { await admin.db(dn).dropDatabase(); console.log('  ✓ 已删除库: ' + dn); }
    catch (e) { console.log('  ✗ 删除失败 ' + dn + ': ' + e.message.substring(0, 60)); }
  }

  console.log('\n[move] 第3步: 验证源库已消失 + mes_dashboard数据仍在');
  const dbs = await admin.db().admin().listDatabases();
  const remain = dbs.databases.map(d => d.name).filter(n => /OEE/.test(n) && n !== 'mes_dashboard');
  console.log('  剩余OEE源库:', remain.length ? remain.join(', ') : '(无, 已全部删除)');
  for (const [, , tgt] of MAP) {
    const t = await mesDb.collection(tgt).countDocuments();
    console.log('  mes_dashboard/' + tgt + '=' + t + '行 ' + (t > 0 ? '✓ 数据在' : '✗ 数据丢了!'));
  }

  await Promise.all([admin.close(), mes.close()]);
})().catch(e => { console.error('[move] 失败:', e.message); process.exit(1); });
