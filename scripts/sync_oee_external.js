#!/usr/bin/env node
/**
 * OEE外部库 → mes_dashboard 物理迁移脚本(方案A: 只搬运行真值)
 * 把4个产线OEE库(功放1/2线·整机1/3线OEE)的"设备运行真值"按 产线×日 聚合,
 * 灌进 mes_dashboard.ai_oee_device_raw, 按 LINE_TO_DB 反向打 line_name 标签。
 *
 * 搬的字段(每产线每天一条): line_name, date, device_run_sec(设备运行真值秒), device_output(产量)
 *   - device_run_sec = Σ 各工位 cumulative_run_seconds? 不行(那是累计)。用 total_run_time 转(但同日多工位是分别计时)。
 *   - 实际: 一个产线日有多条文档(每工位一条), 每条有 total_run_time(HH:MM:SS)。产线级运行时长 = 各工位时长之和(工位并行不重叠时合理)。
 *   - 产量 total_products: 末道工位为准? 这里取该线当日各工位 total_products 的最大值(避免多工位重复计数)。
 *
 * 用途: computeOEE 用 device_run_sec 覆盖 estimated 运行时长 → A/P/Q 分母变真值。
 * 可重复运行: 清旧档再灌(按 source_db 删)。
 * 用法:
 *   node scripts/sync_oee_external.js            # 实跑迁移
 *   node scripts/sync_oee_external.js --dry-run  # 只看schema不拷贝
 */
require('dotenv').config();
const { MongoClient } = require('mongodb');
const { OEE_DB_NAMES, LINE_TO_DB } = require('../oee_external/connection');

const TARGET_COLL = 'ai_oee_device_raw';
const DRY = process.argv.includes('--dry-run');
const DB_TO_LINE = {};
for (const [ln, dn] of Object.entries(LINE_TO_DB)) DB_TO_LINE[dn] = ln;

// "HH:MM:SS" → 秒; 非法返回0
function hmsToSec(s) {
  if (typeof s !== 'string') return 0;
  const p = s.split(':');
  if (p.length < 3) return 0;
  const h = Number(p[0]), m = Number(p[1]), sec = Number(p[2]);
  if (isNaN(h) || isNaN(m) || isNaN(sec)) return 0;
  return h * 3600 + m * 60 + sec;
}

(async () => {
  const uri = process.env.OEE_EXTERNAL_URI;
  if (!uri) { console.error('[sync] 未配置 OEE_EXTERNAL_URI'); process.exit(1); }
  console.log('[sync] 模式:', DRY ? 'DRY-RUN' : '迁移(方案A:运行真值)', '源:', uri.replace(/\/\/[^@]+@/, '//***@'));

  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  const targetDb = client.db(process.env.MONGO_DB || 'mes_dashboard');
  const target = targetDb.collection(TARGET_COLL);
  if (!DRY) {
    try { await target.createIndex({ line_name: 1, date: 1 }, { unique: true }); } catch (e) {}
    try { await target.createIndex({ source_db: 1 }); } catch (e) {}
  }

  let totalDays = 0;
  for (const dn of OEE_DB_NAMES) {
    const lineName = DB_TO_LINE[dn];
    if (!lineName) { console.log('\n[sync] 跳过(无映射):', dn); continue; }
    const srcDb = client.db(dn);
    let cols;
    try { cols = await srcDb.listCollections({}).toArray(); }
    catch (e) { console.log('\n[sync] 读不到', dn, ':', e.message.substring(0, 60)); continue; }

    console.log('\n=== ' + dn + ' → line_name=' + lineName + ' ===');
    if (!cols.length) { console.log('  (空库)'); continue; }

    if (!DRY) { const del = await target.deleteMany({ source_db: dn }); console.log('  清旧档:', del.deletedCount); }

    // 按 production_date 聚合该产线每日运行真值
    const byDate = {};
    for (const c of cols) {
      const cur = srcDb.collection(c.name).find({});
      while (await cur.hasNext()) {
        const doc = await cur.next();
        const date = doc.production_date;
        if (!date) continue;
        if (!byDate[date]) byDate[date] = { runSec: 0, maxProd: 0, ops: 0 };
        byDate[date].runSec += hmsToSec(doc.total_run_time);
        const tp = Number(doc.total_products) || 0;
        if (tp > byDate[date].maxProd) byDate[date].maxProd = tp;
        byDate[date].ops += 1;
      }
    }

    const dates = Object.keys(byDate).sort();
    console.log('  覆盖天数:', dates.length, dates[0] || '', '→', dates[dates.length - 1] || '');
    if (dates.length) {
      const s = byDate[dates[0]];
      console.log('  示例', dates[0], ': 设备运行', Math.round(s.runSec / 60), 'min, 产量', s.maxProd, ', 工位文档', s.ops);
    }

    if (DRY) continue;

    const batch = [];
    for (const date of dates) {
      batch.push({
        line_name: lineName, date, source_db: dn,
        device_run_sec: byDate[date].runSec,
        device_run_min: +(byDate[date].runSec / 60).toFixed(1),
        device_output: byDate[date].maxProd,
        op_doc_count: byDate[date].ops,
        synced_at: new Date(),
      });
    }
    if (batch.length) {
      // upsert 按 (line_name,date) 唯一
      for (const d of batch) {
        await target.updateOne({ line_name: d.line_name, date: d.date }, { $set: d }, { upsert: true });
      }
      console.log('  灌入:', batch.length, '天');
      totalDays += batch.length;
    }
  }

  console.log('\n[sync] 完成' + (DRY ? '(dry-run,未拷贝)' : ', 总灌入 ' + totalDays + ' 产线×日 → ' + TARGET_COLL));
  if (!DRY) console.log('[sync] 下一步: 开 OEE_EXTERNAL_ENABLED=1, computeOEE 富化钩子会用 device_run_min 覆盖 estimated 运行时长');
  await client.close();
})().catch(e => { console.error('[sync] 失败:', e.message); process.exit(1); });
