// 统一OEE外部数据源 — 读取层(方案A: 设备运行真值修正)
// 4个产线OEE库的"设备运行真值"由 scripts/sync_oee_external.js 按产线×日灌进 ai_oee_device_raw。
// 本层从本地读, 喂给 computeOEE 富化钩子: 用 device_run_min 覆盖 estimated 运行时长(T5/run_time_min),
// 使 A/P/Q 分母从"班次-停机推算"升级为"设备实际开机制表真值"。
// 不改 A/P/Q 算法, 只换分母 → 口径不冲突, 全站14调用点自动受益。
const { LINE_TO_DB } = require('./connection');

const RAW_COLL = 'ai_oee_device_raw';
const DEVICE_LINES = Object.keys(LINE_TO_DB); // 4条ASS_线有设备真值

// 批量取设备运行真值。返回 { line_name: { run_time_min, device_output } } 或 null。
// dateFrom/dateTo/lineName 与 computeOEE 同口径; localDb 由 db.js 富化钩子传入。
async function getDeviceOEEBatch(dateFrom, dateTo, lineName, localDb) {
  if (!localDb) return null;
  const filter = { date: { $gte: dateFrom, $lte: dateTo } };
  if (lineName) filter.line_name = lineName;
  else filter.line_name = { $in: DEVICE_LINES }; // 仅4条ASS_线有外部真值

  let docs;
  try { docs = await localDb.collection(RAW_COLL).find(filter, { projection: { _id: 0, line_name: 1, date: 1, device_run_min: 1, device_output: 1 } }).toArray(); }
  catch (e) { return null; }
  if (!docs || !docs.length) return null;

  // 按line_name聚合: 多天求和运行时长, 产量取最大(日产), 供computeOEE区间用
  const out = {};
  for (const d of docs) {
    if (!out[d.line_name]) out[d.line_name] = { run_time_min: 0, device_output: 0, days: 0 };
    out[d.line_name].run_time_min += (d.device_run_min || 0);
    if ((d.device_output || 0) > out[d.line_name].device_output) out[d.line_name].device_output = d.device_output;
    out[d.line_name].days += 1;
  }
  return out;
}

module.exports = { getDeviceOEEBatch, RAW_COLL };
