const { MongoClient, ObjectId } = require('mongodb');

let _tsWarned = false, _tsWarned2 = false, _tsWarnedIqc = false;

// === ai_ 前缀翻译层 ===
// MongoDB 文档字段统一 ai_ 前缀; db.js 作为翻译边界: 内部用 ai_ 与 Mongo 交互,
// 对外(server.js/前端)保持原字段名。读: Mongo(ai_) → stripAi → 原名; 写: 原名 → prefixAi → ai_。
// 聚合里"管道别名输出键"保持原名(不前缀), 仅 $match/$sort 键、$storedfield 引用、存储字段 include 改 ai_;
// 故聚合结果天然原名, 无需 stripAi。仅 raw find() 全文档读取需 stripAi。
function _isObj(v){ return v && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v) && !(v instanceof Date) && !(v instanceof ObjectId) && !(v instanceof RegExp); }
function stripAi(v){ // ai_xxx → xxx (递归, _id 保留)
  if (Array.isArray(v)) return v.map(stripAi);
  if (!_isObj(v)) return v;
  const o = {};
  for (const k of Object.keys(v)) { if (k === '_id') { o[k] = v[k]; continue; } const nk = k.startsWith('ai_') ? k.slice(3) : k; o[nk] = stripAi(v[k]); }
  return o;
}
function prefixAi(v){ // xxx → ai_xxx (递归, _id 保留; $ 操作符键原样但其值递归前缀)
  if (Array.isArray(v)) return v.map(prefixAi);
  if (!_isObj(v)) return v;
  const o = {};
  for (const k of Object.keys(v)) {
    if (k === '_id') { o[k] = v[k]; continue; }
    if (k.startsWith('$')) { o[k] = prefixAi(v[k]); continue; }
    const nk = k.startsWith('ai_') ? k : 'ai_' + k;
    o[nk] = prefixAi(v[k]);
  }
  return o;
}

// 防 NoSQL 注入/字段污染: update 前剔除 $ 开头键与受保护字段(_id/ai_created_at/ai_updated_at),
// 并对剩余键加 ai_ 前缀(写库), 阻断 {$set:..}/{$inc:..}/{$unset:..} 等操作符通过 body 注入。
const PROTECTED_FIELDS = new Set(['_id', 'ai_created_at', 'ai_updated_at']);
function cleanForSet(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const stripped = {};
  for (const k of Object.keys(data)) {
    if (k === '_id' || k.startsWith('$')) continue;
    stripped[k] = data[k];
  }
  const prefixed = prefixAi(stripped);
  for (const pk of Object.keys(prefixed)) { if (PROTECTED_FIELDS.has(pk)) delete prefixed[pk]; }
  return prefixed;
}

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) { console.error('[FATAL] MONGO_URI 未设置'); process.exit(1); }
const MONGO_DB = process.env.MONGO_DB || 'mes_dashboard';

let client, db;
let col = {};

async function connect() {
  // 连接池/超时配置: 远程 Mongo(10.50.55.39), 每次冷连接代价高, 显式设池+超时
  client = new MongoClient(MONGO_URI, {
    maxPoolSize: 50,
    minPoolSize: 2,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
    maxIdleTimeMS: 30000,
  });
  await client.connect();
  db = client.db(MONGO_DB);
  col.production = db.collection('ai_production');
  col.bad_repair = db.collection('ai_bad_repair');
  col.task_orders = db.collection('ai_task_orders');
  col.line_config = db.collection('ai_line_config');
  col.product_config = db.collection('ai_product_config');
  col.downtime_records = db.collection('ai_downtime_records');
  col.cache = db.collection('ai_cache');
  col.exceptions = db.collection('ai_exceptions');
  col.action_items = db.collection('ai_action_items');
  col.attendance = db.collection('ai_attendance');
  col.maintenance = db.collection('ai_maintenance');
  col.inspection = db.collection('ai_inspection');
  col.production_plan = db.collection('ai_production_plan');
  col.daily_snapshot = db.collection('ai_daily_snapshot');
  col.shift_config = db.collection('ai_shift_config');
  col.shift_override = db.collection('ai_shift_override');
  col.work_operations = db.collection('ai_work_operations');
  col.machines = db.collection('ai_machines');
  col.fixture = db.collection('ai_fixture');
  col.aging_cable = db.collection('ai_aging_cable');
  // 12-KPI Phase1 新增集合
  col.mo_orders = db.collection('ai_mo_orders');
  col.task_order_wip = db.collection('ai_task_order_wip');
  col.repair_report = db.collection('ai_repair_report');
  // UPH 目标基准产能数据集 (MES CapacityDataSet, 工序级·机型×工艺段×工序)
  col.capacity_data = db.collection('ai_capacity_data');
  // UPH 实际分母·任务单切换过站工时 (MES GetTaskMoveRecordPages, moveOutWorkHours=工序级真实净生产工时)
  col.task_move_hours = db.collection('ai_task_move_hours');
  const ensureIndex = async (collection, keys, options) => {
    try { await collection.createIndex(keys, options || {}); }
    catch(e) { console.log('[DB] Index warning:', e.message.substring(0,80)); }
  };
  await ensureIndex(col.production, { ai_id: 1 }, { unique: true });
  await ensureIndex(col.production, { ai_move_out_date: 1, ai_line_name: 1 });
  await ensureIndex(col.production, { ai_task_order_no: 1, ai_move_out_time: -1 });
  await ensureIndex(col.production, { ai_barcode: 1, ai_move_out_time: -1 });
  await ensureIndex(col.bad_repair, { ai_id: 1 }, { unique: true });
  await ensureIndex(col.bad_repair, { ai_test_date: 1 });
  await ensureIndex(col.bad_repair, { ai_test_date: 1, ai_line_name: 1 });
  await ensureIndex(col.bad_repair, { ai_test_date: 1, ai_line_name: 1, ai_test_time: -1 });
  await ensureIndex(col.task_orders, { ai_task_no: 1 }, { unique: true });
  await ensureIndex(col.line_config, { ai_line_name: 1 }, { unique: true });
  await ensureIndex(col.product_config, { ai_product_model: 1 }, { unique: true });
  await ensureIndex(col.capacity_data, { ai_product_model: 1, ai_order_type: 1 });
  await ensureIndex(col.capacity_data, { ai_work_operation_id: 1 });
  await ensureIndex(col.task_move_hours, { ai_produce_date: 1, ai_line_name: 1 });
  await ensureIndex(col.task_move_hours, { ai_product_model: 1, ai_work_operation_id: 1 });
  await ensureIndex(col.task_move_hours, { ai_task_order_no: 1, ai_work_operation_id: 1 }, { unique: true });
  await ensureIndex(col.downtime_records, { ai_date: 1, ai_line_name: 1 });
  await ensureIndex(col.daily_snapshot, { ai_date: 1 }, { unique: true });
  await ensureIndex(col.cache, { ai_key: 1 }, { unique: true });
  await ensureIndex(col.shift_config, { ai_line_name: 1, ai_is_active: 1 });
  await ensureIndex(col.shift_override, { ai_date: 1, ai_line_name: 1 });
  await ensureIndex(col.fixture, { ai_code: 1 });
  await ensureIndex(col.fixture, { ai_edo_id: 1 }, { unique: true });
  await ensureIndex(col.fixture, { ai_match_product_model: 1 });
  await ensureIndex(col.fixture, { ai_line_name: 1, ai_work_operation_code: 1 });
  await ensureIndex(col.aging_cable, { ai_code: 1 }, { unique: true });
  await ensureIndex(col.aging_cable, { ai_edo_id: 1 }, { unique: true });
  await ensureIndex(col.aging_cable, { ai_match_product_model: 1 });
  await ensureIndex(col.aging_cable, { ai_line_name: 1, ai_product_model: 1 });
  // work_operation_code 索引: 解 fixtures/cables N+1 countDocuments 全表扫描, 以及 queryStationUPH/queryProductionByStage
  await ensureIndex(col.production, { ai_work_operation_code: 1, ai_move_out_date: 1 });
  await ensureIndex(col.bad_repair, { ai_work_operation_name: 1, ai_test_date: 1 });
  // 12-KPI Phase1 索引
  await ensureIndex(col.mo_orders, { ai_mo_lot_no: 1 }, { unique: true });
  await ensureIndex(col.mo_orders, { ai_plan_shipping_date: 1 });
  await ensureIndex(col.mo_orders, { ai_customer: 1 });
  await ensureIndex(col.task_order_wip, { ai_task_no: 1 }, { unique: true });
  await ensureIndex(col.task_order_wip, { ai_line_id: 1 });
  await ensureIndex(col.repair_report, { ai_id: 1 }, { unique: true });
  await ensureIndex(col.repair_report, { ai_test_date: 1 });
  await ensureIndex(col.repair_report, { ai_test_date: 1, ai_line_name: 1 });
  console.log('[DB] Connected:', MONGO_URI.replace(/\/\/.*@/, '//*****@'));
}

// === Production ===
async function insertProduction(items) {
  if (!items || !items.length) return;
  const now = Date.now();
  const cutoffMin = await getOpDayCutoffMin();
  const ops = items.map(item => {
    const ts = item.moveOutTime || '';
    let d = ts ? new Date(ts) : new Date();
    if (isNaN(d.getTime())) d = new Date();
    const iso = d.toISOString();
    // move_out_date 用运营日归天(夜班跨零点归同一天): 本地时刻<cutoff算前一天, 与 hour(本地)口径一致
    const date = _operationalDateStr(d, cutoffMin);
    const hour = d.getHours();
    const id = (item.containerName||item.snCode||'') + '|' + (item.workOperationCode||'') + '|' + ts;
    const opName = item.workOperationName || item.work_operation_name || item.operationName || item.workCenterName || '';
    return { updateOne: { filter: prefixAi({id}), update:{$set: prefixAi({id, barcode:item.containerName||item.snCode||'', line_name:item.lineCode||'', line_id:item.lineId||'', product_model:item.productModel||'', work_operation_id:item.workOperationId||'', work_operation_code:item.workOperationCode||'', work_operation_name:opName, next_work_operation_code:item.nextWorkOperationCode||'', sort_no:item.sortNo??9999, task_order_no:item.taskOrderNo||'', move_out_time:iso, move_out_date:date, hour, source: item.source || 'mes', synced_at:now})}, upsert:true }};
  });
  await col.production.bulkWrite(ops, { ordered: false });
}

// === Bad Repair ===
async function insertBadRepair(items) {
  if (!items || !items.length) return;
  const now = Date.now();
  const cutoffMin = await getOpDayCutoffMin();
  const ops = items.map(item => {
    const ts = item.testTime || '';
    let d;
    if (typeof ts === 'number') { d = new Date(ts); }
    else if (ts) {
      // 处理无时区标记的日期字符串，强制按本地时间解析
      if (/^\d{4}-\d{2}-\d{2}$/.test(ts)) { d = new Date(ts + 'T00:00:00+08:00'); }
      else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(ts) && !ts.includes('Z') && !ts.includes('+')) { d = new Date(ts.replace(' ', 'T') + '+08:00'); }
      else { d = new Date(ts); }
    } else { d = new Date(); if (!_tsWarned) { console.warn('[DB] 产量记录缺少 moveOutTime,用同步时间填补 — 数据可能不准确'); _tsWarned = true; } }
    if (isNaN(d.getTime())) { d = new Date(); if (!_tsWarned2) { console.warn('[DB] 产量记录 moveOutTime 解析失败,用同步时间填补'); _tsWarned2 = true; } }
    // test_date 用运营日归天(与产量move_out_date口径一致, 夜班跨零点归同一天)
    const date = _operationalDateStr(d, cutoffMin);
    const iso = d.toISOString();
    // 去重ID: snCode为空时用badItems+testTime+lineName做hash兜底
    const sn = item.snCode || '';
    const id = sn
      ? (sn + '|' + ts + '|' + (item.badItems||''))
      : ('_' + Buffer.from((ts||'')+'|'+(item.badItems||'')+'|'+(item.lineName||'')+'|'+(item.workOprationName||'')).toString('base64').slice(0,32));
    return { replaceOne: { filter: prefixAi({id}), replacement: prefixAi({
      id, barcode:sn, line_name:item.lineName||'', product_model:item.productModel||'',
      work_operation_name:item.workOprationName||'', bad_items:item.badItems||'',
      category_name:item.categoryName||'', content_name:item.contentName||'',
      causes_name:item.causesName||'', remark:item.remark||'',
      repair_state_code:item.repairStateCode||0,
      repair_man:item.maintainerName||item.repairMan||item.repair_man||'',
      repair_time:item.repairEndTime ? new Date(item.repairEndTime).toISOString() : (item.repairTime||item.repair_time||''),
      work_station:item.workStation||item.work_station||'',
      test_user:item.testUser||'',
      quality_inspector:item.qualityInspector||'',
      quality_time:item.qualityTime ? new Date(item.qualityTime).toISOString() : '',
      quality_confirm:item.qualityConfirmContent||'',
      mo_lot_no:item.moLotNo||'',
      task_order_no:item.taskOrderNo||'',
      item_number:item.itemNumber||'',
      repair_total:item.repairTotal != null ? item.repairTotal : null,
      bad_positions:item.badPositions||'',
      part_name:item.partName||'',
      part_no:item.partNo||'',
      repair_level:item.repairLevel||'',
      organization_code:item.organizationCode||'',
      repair_area:item.repairArea||'',
      test_time:iso, test_date:date,
      source: item.source || 'mes', // R3: 数据来源标记(manual=手动补数, mes=CMES同步), 便于审计/后续按需排除; 不改查询故不影响KPI
      synced_at:now
    }), upsert:true }};
  });
  await col.bad_repair.bulkWrite(ops, { ordered: false });
}

// === Task Orders ===
async function insertTaskOrders(items) {
  if (!items || !items.length) return;
  const ops = items.map(item => ({ updateOne: { filter: prefixAi({task_no:item.taskNo}), update:{$set: prefixAi({task_no:item.taskNo, mo_lot_no:item.moLotNo||'', product_model:item.productModel||'', qty:item.qty||0, completed_qty:item.completedQty||0, task_mes_status:item.taskMesStatus, first_move_out:item.firstSnMoveOutTime||'', last_move_out:item.lastSnMoveOutTime||'', synced_at:Date.now()})}, upsert:true }}));
  await col.task_orders.bulkWrite(ops, { ordered: false });
}

// === 12-KPI Phase1: MoOrder (工单·OTD+计划达成率) ===
async function insertMoOrders(items) {
  if (!items || !items.length) return;
  const now = Date.now();
  const ops = items.map(item => {
    const moLotNo = item.moLotNo || item.topMoLotNo || item.moNo || '';
    // planShippingDate 是 string，容错解析
    const psd = item.planShippingDate || '';
    let planShippingDate = '';
    if (psd) { const d = new Date(psd); planShippingDate = isNaN(d.getTime()) ? psd : d.toISOString(); }
    return { updateOne: { filter: prefixAi({mo_lot_no:moLotNo}), update:{$set: prefixAi({
      mo_lot_no:moLotNo, top_mo_lot_no:item.topMoLotNo||'', mo_no:item.moNo||'', mo_mode:item.moMode||'',
      part_no:item.partNo||'', part_name:item.partName||'', product_model:item.productModel||'',
      qty:item.qty||0, task_qty:item.taskQty||0, reported_completed_qty:item.reportedCompletedQty||0,
      wms_qty:item.wmsQty||'', ebs_qty:item.ebsQty||'',
      mes_status:item.mesStatus, mes_status_desc:item.mesStatusDesc||'',
      customer:item.customer||'', sale_order_no:item.saleOrderNo||'',
      plan_shipping_date:planShippingDate, plan_shipping_date_raw:psd,
      task_time:item.taskTime||'', clear_tail_time:item.clearTailTime||'', creation_time:item.crtTime||item.creationTime||'',
      factory_code:item.factoryCode||'', origin:item.origin||'', origin_desc:item.originDesc||'',
      classification:item.classification||'', mo_type:item.moType, mo_type_desc:item.moTypeDesc||'',
      synced_at:now
    })}, upsert:true }};
  });
  await col.mo_orders.bulkWrite(ops, { ordered: false });
}

// === 12-KPI Phase1: TaskOrderWip (在制周期·快照) ===
async function insertTaskOrderWip(items) {
  if (!items || !items.length) return;
  const now = Date.now();
  const ops = items.map(item => {
    const taskNo = item.taskNo || item.taskOrderId || '';
    const planStart = item.planStartTime ? new Date(item.planStartTime) : null;
    const planDelivery = item.planDeliveryTime ? new Date(item.planDeliveryTime) : null;
    return { updateOne: { filter: prefixAi({task_no:taskNo}), update:{$set: prefixAi({
      task_no:taskNo, task_order_id:item.taskOrderId||'', task_mes_status:item.taskMesStatus,
      mo_lot_no:item.moLotNo||'', product_model:item.productModel||'', product_part_no:item.productPartNo||'',
      line_id:item.lineId||'', work_center_id:item.workCenterId||'', classes:item.classes||'',
      customer:item.customer||'', customer_code:item.customerCode||'',
      qty:item.qty||0, unprocessed_qty:item.unprocessedQty||0, inventory_qty:item.inventoryQty||0, wip_qty:item.wipQty||0,
      plan_start_time: planStart && !isNaN(planStart.getTime()) ? planStart.toISOString() : '',
      plan_delivery_time: planDelivery && !isNaN(planDelivery.getTime()) ? planDelivery.toISOString() : '',
      creation_time:item.creationTime||'', description:item.description||'', synced_at:now
    })}, upsert:true }};
  });
  await col.task_order_wip.bulkWrite(ops, { ordered: false });
}

// === 12-KPI Phase1: RepairReport (返工率·结构化) ===
async function insertRepairReport(items) {
  if (!items || !items.length) return;
  const now = Date.now();
  const ops = items.map(item => {
    const ts = item.testTime || item.test_time || '';
    let d; if (ts) { d = new Date(ts); } if (!d || isNaN(d.getTime())) { d = new Date(); if (!_tsWarnedIqc) { console.warn('[DB] IQC记录缺少检验时间,用同步时间填补 — 数据可能不准确'); _tsWarnedIqc = true; } }
    const iso = d.toISOString();
    const date = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
    const sn = item.snCode || item.sn_code || '';
    const id = sn ? (sn + '|' + ts + '|' + (item.badItems||item.bad_items||''))
      : ('_' + Buffer.from((ts||'')+'|'+(item.badItems||item.bad_items||'')+'|'+(item.lineName||item.line_name||'')).toString('base64').slice(0,32));
    return { replaceOne: { filter: prefixAi({id}), replacement: prefixAi({
      id, sn_code:sn, mo_lot_no:item.moLotNo||item.mo_lot_no||'', task_order_no:item.taskOrderNo||item.task_order_no||'',
      line_name:item.lineName||item.line_name||'', product_model:item.productModel||item.product_model||'',
      item_number:item.itemNumber||'', work_opration_name:item.workOpration||item.work_opration_name||'',
      repair_total:item.repairTotal != null ? item.repairTotal : (item.repair_total != null ? item.repair_total : null),
      repair_state_code:item.repairStateCode != null ? item.repairStateCode : null,
      test_user:item.testUser||'', test_time:iso, test_date:date,
      quality_inspector:item.qualityInspector||'', quality_time:item.qualityTime||'',
      maintainer_name:item.maintainerName||'', repair_end_time:item.repairEndTime||'',
      bad_items:item.badItems||item.bad_items||'', category_name:item.categoryName||'',
      causes_name:item.causesName||'', content_name:item.contentName||'',
      repair_area:item.repairArea||'', repair_level:item.repairLevel||'', remark:item.remark||'',
      bad_positions:item.badPositions||'', synced_at:now
    }), upsert:true }};
  });
  await col.repair_report.bulkWrite(ops, { ordered: false });
}

// === Queries ===
async function queryProductionTotal(dateFrom, dateTo, lineName) {
  // 产出口径=去重SN(过站记录一台多道, 去重后才是真实产品数); 用作FPY/PPM分母, 与去重不良SN口径一致
  const m = { move_out_date: { $gte: dateFrom, $lte: dateTo }, barcode: { $nin: [null, ''] } };
  if (lineName) m.line_name = lineName;
  const rows = await col.production.aggregate([
    { $match: prefixAi(m) },
    { $group: { _id: '$ai_barcode' } },
    { $count: 'total' }
  ]).toArray();
  return rows.length > 0 ? rows[0].total : 0;
}

async function queryProductionByLine(dateFrom, dateTo) {
  // 产出口径=去重SN(过站一台多道, 去重后真实产品数; 过站次数虚高1-9.8倍)
  return await col.production.aggregate([
    { $match: prefixAi({ move_out_date: { $gte: dateFrom, $lte: dateTo }, barcode: { $nin: [null, ''] } }) },
    // 阶段1: (line,barcode)去重, 取该SN在该线首末过站
    { $group: { _id: { line: '$ai_line_name', sn: '$ai_barcode' }, first_time: { $min: '$ai_move_out_time' }, last_time: { $max: '$ai_move_out_time' } } },
    // 阶段2: 按线计数 + 该线所有SN首末的全局min/max(供OEE mes_derived CT用)
    { $group: { _id: '$_id.line', total: { $sum: 1 }, first_time: { $min: '$first_time' }, last_time: { $max: '$last_time' } } },
    { $project: { _id: 0, line_name: '$_id', total: 1, first_time: 1, last_time: 1 } }
  ]).toArray();
}

async function queryProductionByHour(dateFrom, dateTo, lineName) {
  // 产出口径=去重SN: 同一SN同小时多道工序只算1(每小时活跃产品数)
  const m = { move_out_date: { $gte: dateFrom, $lte: dateTo }, barcode: { $nin: [null, ''] } };
  if (lineName) m.line_name = lineName;
  return await col.production.aggregate([
    { $match: prefixAi(m) },
    { $group: { _id: { hour: '$ai_hour', sn: '$ai_barcode' } } },
    { $group: { _id: '$_id.hour', total: { $sum: 1 } } },
    { $project: { _id: 0, hour: '$_id', total: 1 } },
    { $sort: { hour: 1 } }
  ]).toArray();
}

async function queryBadItems(dateFrom, dateTo, lineName, opts={}) {
  const m = { test_date: { $gte: dateFrom, $lte: dateTo } };
  if (lineName) m.line_name = lineName;
  if (opts.excludeManual) m.source = { $ne: 'manual' }; // R3: 可选排除手动补数, 默认不排除(保持KPI数字不变)
  // 分页(可选): opts.page / opts.pageSize → 返回 {items,total}; 不传则返回完整数组(向后兼容)
  if (opts.page != null) {
    const pageSize = Math.min(Math.max(parseInt(opts.pageSize, 10) || 50, 1), 500);
    const page = Math.max(parseInt(opts.page, 10) || 1, 1);
    const cursor = col.bad_repair.find(prefixAi(m)).sort({ ai_test_time: -1 });
    const total = await cursor.count();
    const items = stripAi(await cursor.skip((page - 1) * pageSize).limit(pageSize).toArray());
    return { items, total, page, pageSize };
  }
  return stripAi(await col.bad_repair.find(prefixAi(m)).sort({ ai_test_time: -1 }).toArray());
}

async function queryBadStats(dateFrom, dateTo, lineName, opts={}) {
  const m = { test_date: { $gte: dateFrom, $lte: dateTo } };
  if (lineName) m.line_name = lineName;
  if (opts.excludeManual) m.source = { $ne: 'manual' };
  return await col.bad_repair.aggregate([
    { $match: prefixAi(m) },
    { $group: { _id: { category: '$ai_category_name', content: '$ai_content_name' }, total: { $sum: 1 } } },
    { $project: { _id: 0, category: '$_id.category', content: '$_id.content', total: 1 } },
    { $sort: { total: -1 } }
  ]).toArray();
}

// === 引用/字典数据缓存 (60s TTL, 配置类数据变更频率低; 写操作失效) ===
const _REF_TTL = 60 * 1000;
function _refMemo(name, loader) {
  return async function cached() {
    const e = _refStore[name];
    if (e && Date.now() - e.ts < _REF_TTL) return e.val;
    const val = await loader();
    _refStore[name] = { val, ts: Date.now() };
    return val;
  };
}
const _refStore = {};
function _refInvalidate(name) { if (name) delete _refStore[name]; else for (const k in _refStore) delete _refStore[k]; }

async function getTaskOrders(options={}) {
  const query = prefixAi(options.query || {});
  const cursor = col.task_orders.find(query).sort({ai_synced_at:-1, ai_last_move_out:-1, ai_task_no:1});
  // 分页模式: 仅当显式传入 page/pageSize 时启用, 返回 {items,total,page,pageSize}
  const pageRaw = Number(options.page);
  const pageSizeRaw = Number(options.pageSize);
  if (options.page != null && options.pageSize != null && !Number.isNaN(pageRaw) && !Number.isNaN(pageSizeRaw)) {
    const page = Math.max(1, Math.floor(pageRaw) || 1);
    const pageSize = Math.min(Math.max(Math.floor(pageSizeRaw) || 50, 1), 200);
    const [total, items] = await Promise.all([
      col.task_orders.countDocuments(query),
      cursor.skip((page - 1) * pageSize).limit(pageSize).toArray()
    ]);
    return { items: stripAi(items), total, page, pageSize };
  }
  // 兼容旧调用: 返回裸数组 (limit 或无参)
  const limit = Math.min(Math.max(Number(options.limit) || 20, 1), 500);
  return stripAi(await cursor.limit(limit).toArray());
}
const getLines = _refMemo('lines', async () => stripAi(await col.line_config.find().sort({ai_sort_order:1}).toArray()));
async function saveLine(data) { await col.line_config.replaceOne(prefixAi({line_name:data.line_name}), prefixAi(data), {upsert:true}); _refInvalidate('lines'); }
// MES 同步专用 upsert: 仅更新 line_name/line_display/synced_at; 班次/目标等本地配置用 $setOnInsert 仅首次创建时填默认,
// 已存在的线保留 admin 配置不覆写 (KPI 计算读 shift_config, line_config 班次仅为元数据; 原 replaceOne 会抹掉 sort_order 等扩展字段, 故改 updateOne)
async function upsertLineFromMes(data) {
  await col.line_config.updateOne(
    prefixAi({ line_name: data.line_name }),
    prefixAi({ $set: { line_name: data.line_name, line_display: data.line_display, synced_at: Date.now() },
      $setOnInsert: { shift_start: '08:00', shift_end: '20:00', break_time: 100, target_oee: 85, sort_order: 999 } }),
    { upsert: true }
  );
  _refInvalidate('lines');
}
const getProducts = _refMemo('products', async () => stripAi(await col.product_config.find().toArray()));
async function saveProduct(data) { await col.product_config.replaceOne(prefixAi({product_model:data.product_model}), prefixAi(data), {upsert:true}); _refInvalidate('products'); }
async function deleteProduct(productModel) { await col.product_config.deleteOne(prefixAi({product_model:productModel})); _refInvalidate('products'); }

// === Capacity Data (MES CapacityDataSet · UPH目标基准) ===
// 工序级产能主数据: 机型×工艺段×工序 → ct(周期)/st(标准工时)/uph_value/order_type
// 唯一键 = productModel+processSegmentCode+workOperationId+orderType, upsert 不膨胀
async function saveCapacityData(items) {
  if (!items || !items.length) return;
  const now = Date.now();
  const ops = items.map(item => ({
    updateOne: {
      filter: prefixAi({ product_model: item.productModel||'', process_segment_code: item.processSegmentCode||'', work_operation_id: item.workOperationId||'', order_type: item.orderType||'' }),
      update: { $set: prefixAi({
        product_model: item.productModel||'',
        process_segment_code: item.processSegmentCode||'',
        work_operation_id: item.workOperationId||'',
        work_center_id: item.workCenterId||'',
        line_id: item.lineId||'',
        part_no: item.partNo||'',
        ct: item.ct!=null ? +item.ct : null,        // 周期(秒/件) = 3600/uph, 与 product_config.cycle_time 同口径
        st: item.st!=null ? +item.st : null,        // 标准工时(按工序不同)
        uph_value: item.uphValue!=null ? +item.uphValue : null,
        order_type: item.orderType||'',
        synced_at: now,
      })},
      upsert: true,
    },
  }));
  await col.capacity_data.bulkWrite(ops, { ordered: false });
  _refInvalidate('capacity');
}
const getCapacityData = _refMemo('capacity', async () => stripAi(await col.capacity_data.find().toArray()));

// === Task Move Hours (MES 任务单切换过站工时 · UPH实际分母) ===
// moveOutWorkHours = 任务单×工序级首末SN过站净工时(MES已扣午/晚餐休息), recordType=2量产有效
// 唯一键 = taskOrderNo+workOperationId, upsert 不膨胀; 全量条目入库(含recordType=1切换供OEE换线损耗扩展)
async function saveTaskMoveHours(items) {
  if (!items || !items.length) return;
  const now = Date.now();
  const ops = items.map(item => ({
    updateOne: {
      filter: prefixAi({ task_order_no: item.taskOrderNo||'', work_operation_id: item.workOperationId||'' }),
      update: { $set: prefixAi({
        produce_date: (item.produceDate||'').slice(0,10),
        task_order_no: item.taskOrderNo||'',
        work_operation_id: item.workOperationId||'',
        work_operation_code: item.workOperationCode||'',
        work_center_id: item.workCenterId||'',
        work_center_name: item.workCenterName||'',
        line_id: item.lineId||'',
        line_name: item.lineName||'',
        product_model: item.productModel||'',
        bop_segment_code: item.bopSegmentCode||'',
        bop_segment_name: item.bopSegmentName||'',
        first_sn_time: item.firstSnTime||'',
        last_sn_time: item.lastSnTime||'',
        record_type: item.recordType!=null ? +item.recordType : null,
        move_out_work_hours: item.moveOutWorkHours!=null ? +item.moveOutWorkHours : null,
        synced_at: now,
      })},
      upsert: true,
    },
  })).filter(op => op.updateOne.filter['ai_task_order_no'] && op.updateOne.filter['ai_work_operation_id']);
  if (ops.length) await col.task_move_hours.bulkWrite(ops, { ordered: false });
  return ops.length;
}
const getWorkOperations = _refMemo('work_operations', async () => stripAi(await col.work_operations.find().sort({ ai_sort_no: 1, ai_code: 1, ai_name: 1 }).toArray()));
const getEquipment = _refMemo('equipment', async () => stripAi(await col.machines.find().sort({ ai_line_name: 1, ai_code: 1, ai_name: 1 }).toArray()));

async function getDowntimeRecords(dateFrom, dateTo, lineName) {
  const m = { date: { $gte: dateFrom, $lte: dateTo } };
  if (lineName) m.line_name = lineName;
  return stripAi(await col.downtime_records.find(prefixAi(m)).sort({ai_date:-1}).toArray());
}
async function insertDowntime(record) { await col.downtime_records.insertOne(prefixAi({...record, source: record.source||'manual', created_at:Date.now()})); }
async function updateDowntime(id, data) { const {ObjectId}=require('mongodb'); await col.downtime_records.updateOne({_id:new ObjectId(id)},{$set:{...cleanForSet(data),ai_updated_at:Date.now()}}); }
async function deleteDowntime(id) { const {ObjectId}=require('mongodb'); await col.downtime_records.deleteOne({_id:new ObjectId(id)}); }

// === Shift Config ===
const getShiftConfigs = _refMemo('shift_configs', async () => stripAi(await col.shift_config.find(prefixAi({is_active:true})).sort({ai_line_name:1}).toArray()));
async function getShiftConfig(lineName) {
  const all = await getShiftConfigs();
  const lineConf = lineName ? all.find(s => s.line_name === lineName) : null;
  if (lineConf) return lineConf;
  return all.find(s => s.line_name == null) || null;
}
async function saveShiftConfig(data) {
  const filter = data._id ? {_id: new (require('mongodb').ObjectId)(data._id)} : prefixAi({line_name: data.line_name||null});
  delete data._id;
  data.updated_at = Date.now();
  data.is_active = data.is_active !== false;
  await col.shift_config.replaceOne(filter, prefixAi(data), {upsert:true});
  _refInvalidate('shift_configs');
  _opDayCutoffCache = { val: null, ts: 0 }; // 班次变→运营日cutoff失效
}
async function deleteShiftConfig(id) { const {ObjectId}=require('mongodb'); await col.shift_config.deleteOne({_id:new ObjectId(id)}); _refInvalidate('shift_configs'); _opDayCutoffCache = { val: null, ts: 0 }; }

// === Shift Override ===
async function getShiftOverrides(dateFrom, dateTo, lineName) {
  const m = { date: { $gte: dateFrom, $lte: dateTo } };
  if (lineName) m.$or = [{line_name:lineName},{line_name:null}];
  return stripAi(await col.shift_override.find(prefixAi(m)).sort({ai_date:1}).toArray());
}
async function saveShiftOverride(data) {
  const filter = data._id ? {_id: new (require('mongodb').ObjectId)(data._id)} : prefixAi({date:data.date, line_name:data.line_name||null});
  delete data._id;
  data.created_at = data.created_at || Date.now();
  await col.shift_override.replaceOne(filter, prefixAi(data), {upsert:true});
}
async function deleteShiftOverride(id) { const {ObjectId}=require('mongodb'); await col.shift_override.deleteOne({_id:new ObjectId(id)}); }

// 运营日cutoff缓存(全局班次配置的末班end), 避免每条过站都查库; 5分钟失效
let _opDayCutoffCache = { val: null, ts: 0 };
async function getOpDayCutoffMin() {
  const now = Date.now();
  if (_opDayCutoffCache.val !== null && now - _opDayCutoffCache.ts < 5*60*1000) return _opDayCutoffCache.val;
  const cfg = stripAi(await col.shift_config.findOne(prefixAi({line_name:null, is_active:true})));
  const val = _operationalCutoffMin(cfg);
  _opDayCutoffCache = { val, ts: now };
  return val;
}

// === Downtime Categories (dictionary) ===
const _defaultDowntimeCategories = {
  planned: [
    {code:'changeover',label:'换型/转线'},{code:'shift_change',label:'交接班'},
    {code:'no_schedule',label:'无计划'},{code:'pm',label:'计划保养'}
  ],
  unplanned: [
    {code:'breakdown',label:'设备故障'},{code:'material',label:'缺料等待'},
    {code:'quality',label:'品质异常'},{code:'tooling',label:'工装治具'},{code:'other',label:'其他'}
  ]
};
const getDowntimeCategories = _refMemo('downtime_categories', async () => {
  const doc = await col.cache.findOne({ai_key:'downtime_categories'});
  return doc ? doc.ai_value : _defaultDowntimeCategories;
});
async function saveDowntimeCategories(value) {
  await col.cache.replaceOne({ai_key:'downtime_categories'},{ai_key:'downtime_categories',ai_value:value,ai_updated_at:Date.now()},{upsert:true});
  _refInvalidate('downtime_categories');
}

// === OEE ===
const DEFAULT_SHIFT_MIN = 630; // 10.5h fallback
const DEFAULT_BREAK_MIN = 100;
const HANDOVER_CAP_MIN = 30;      // 交接班自动推导封顶(分钟)
const HANDOVER_MAX_GAP_MIN = 180; // 相邻班次间隙超过此值视为非工作时间,豁免
const DEFAULT_OPDAY_CUTOFF_MIN = 5*60+30; // 运营日cutoff默认05:30(夜班结束)

// 运营日cutoff(分钟,本地时刻): 取班次配置里最晚的end(跨天end<12:00视为次日),即夜班结束时刻
// 用途: 夜班跨零点归天——cutoff之前的过站算前一天运营日,使夜班全程时间与产量归同一天
function _operationalCutoffMin(shiftConfig) {
  const shifts = shiftConfig && Array.isArray(shiftConfig.shifts) ? shiftConfig.shifts : [];
  if (!shifts.length) return DEFAULT_OPDAY_CUTOFF_MIN;
  let maxEnd = -1;
  for (const s of shifts) {
    const m = _hhmmToMin(s && s.end);
    if (m === null) continue;
    let abs = m < 12*60 ? m + 24*60 : m; // <12点视为跨天次日结束
    if (abs > maxEnd) maxEnd = abs;
  }
  if (maxEnd < 0) return DEFAULT_OPDAY_CUTOFF_MIN;
  return maxEnd % (24*60); // 折回0-1439
}

// 把本地Date按运营日cutoff归天: 本地时刻<cutoff的算前一天
// 返回 "YYYY-MM-DD" 运营日字符串
function _operationalDateStr(d, cutoffMin) {
  const localMin = d.getHours()*60 + d.getMinutes();
  // 若本地时刻早于cutoff(如凌晨03:00<05:30),归属前一天运营日
  const adjusted = localMin < cutoffMin ? new Date(d.getFullYear(), d.getMonth(), d.getDate()-1) : d;
  return adjusted.getFullYear()+'-'+String(adjusted.getMonth()+1).padStart(2,'0')+'-'+String(adjusted.getDate()).padStart(2,'0');
}

// hhmm("08:30") -> 当日分钟数(0-1439);非法返回 null
function _hhmmToMin(hhmm) {
  if (typeof hhmm !== 'string') return null;
  const parts = hhmm.split(':');
  if (parts.length < 2) return null;
  const h = Number(parts[0]), m = Number(parts[1]);
  if (isNaN(h) || isNaN(m)) return null;
  return h*60+m;
}

// 班次/休息段时长(分钟),跨天(end<=start)自动 +24h
function _spanDur(sMin, eMin) {
  let dur = eMin - sMin;
  if (dur <= 0) dur += 24*60;
  return dur;
}

// 将一个跨天时段展开成 [0,1440) 内的不跨天区间集合,供交集判定
function _unrollSpan(sMin, eMin) {
  return eMin > sMin ? [[sMin, eMin]] : [[sMin, 24*60], [0, eMin]];
}

// 推导交接班与班前点检(双班时间模型自动必扣项)
// 交接班: 配置了 handover_min 用配置值(每对相邻班次各扣一次);否则按相邻班次间隙自动推
//         min(gap, HANDOVER_CAP_MIN),间隙 > HANDOVER_MAX_GAP_MIN 豁免(当非工作时间)
// 班前点检: Σ shifts[].pre_shift_min,缺省 0
// 返回 { shiftChangeMin, preShiftMin, shiftChangeSource, exemptPairs }
//   shiftChangeSource: none | auto_derived | configured | exempt
function calcShiftExtras(shiftConfig) {
  const out = { shiftChangeMin: 0, preShiftMin: 0, shiftChangeSource: 'none', exemptPairs: 0 };
  const shifts = shiftConfig && Array.isArray(shiftConfig.shifts) ? shiftConfig.shifts : [];
  if (shifts.length === 0) return out;

  // 班前点检累加
  let preShift = 0;
  for (const s of shifts) preShift += Number(s && s.pre_shift_min) || 0;
  out.preShiftMin = Math.max(0, preShift);

  if (shifts.length < 2) return out; // 单班无相邻,无交接班

  // 解析班次时段,过滤非法
  const pts = shifts.map(s => {
    const sMin = _hhmmToMin(s && s.start), eMin = _hhmmToMin(s && s.end);
    if (sMin === null || eMin === null) return null;
    return { sMin, eMin, dur: _spanDur(sMin, eMin) };
  }).filter(Boolean);
  if (pts.length < 2) return out;

  // 按起始时间排序,unroll 到线性轴(处理夜班跨天,让绝对起止单调递增)
  pts.sort((a, b) => a.sMin - b.sMin);
  const abs = [];
  let cursor = null;
  for (const p of pts) {
    let sAbs = p.sMin;
    if (cursor !== null && sAbs < cursor) sAbs += 24*60; // 起始早于上一班结束 → 跨天
    abs.push({ sAbs, eAbs: sAbs + p.dur });
    cursor = sAbs + p.dur;
  }

  // handover_min 严格判定: 仅真正数字/非空数字字符串视为配置(null/''/false/undefined → 未配置,走自动推)
  const rawHm = shiftConfig.handover_min;
  const useCfg = (typeof rawHm === 'number' && !isNaN(rawHm) && rawHm >= 0)
              || (typeof rawHm === 'string' && rawHm.trim() !== '' && !isNaN(Number(rawHm)) && Number(rawHm) >= 0);
  const cfg = useCfg ? Number(rawHm) : NaN;
  let total = 0, exempt = 0;
  let source = 'none';

  // gap 适用性对配置/自动两分支统一: >180min 非工作时间豁免, ≤0(重叠/同起)不扣; 仅扣减幅度不同
  // 相邻班次之间的间隙
  for (let i = 1; i < abs.length; i++) {
    const gap = abs[i].sAbs - abs[i-1].eAbs;
    if (gap > HANDOVER_MAX_GAP_MIN) { exempt++; if (source === 'none') source = 'exempt'; }
    else if (gap > 0) { total += useCfg ? Math.min(cfg, gap) : Math.min(gap, HANDOVER_CAP_MIN); source = useCfg ? 'configured' : 'auto_derived'; }
  }
  // 末班结束 → 首班开始(次日)的过夜间隙也算交接(双班回环)
  const nightGap = (abs[0].sAbs + 24*60) - abs[abs.length-1].eAbs;
  if (nightGap > HANDOVER_MAX_GAP_MIN) { exempt++; if (source === 'none') source = 'exempt'; }
  else if (nightGap > 0) { total += useCfg ? Math.min(cfg, nightGap) : Math.min(nightGap, HANDOVER_CAP_MIN); source = useCfg ? 'configured' : 'auto_derived'; }

  out.shiftChangeMin = total;
  out.shiftChangeSource = source;
  out.exemptPairs = exempt;
  return out;
}

// 计算班次总时长 / 休息 / 交接班 / 班前点检(OEE 时间模型核心)
// 返回 { shiftMin, breakMin, shiftChangeMin, preShiftMin, orphanBreaks, shiftChangeSource }
//   - 无配置:走默认(单班10.5h+100min休息),无法推导交接/点检
//   - 有配置但无休息:breakMin=0(不再兜底硬扣100)
//   - 休息边界校验:不落在任何班次时段内的休息跳过并计入 orphanBreaks
function calcShiftMinutes(shiftConfig, dateStr) {
  // 无配置:默认值,无法推导交接/点检
  if (!shiftConfig || !shiftConfig.shifts || !shiftConfig.shifts.length) {
    return { shiftMin: DEFAULT_SHIFT_MIN, breakMin: DEFAULT_BREAK_MIN, shiftChangeMin: 0, preShiftMin: 0, orphanBreaks: 0, shiftChangeSource: 'none' };
  }

  // 班次总时长(各自累加=配置班次时长) + 班次时段集合(跨天拆两段,合并并集供休息交集判定)
  let shiftMin = 0;
  const rawSpans = [];
  for (const s of shiftConfig.shifts) {
    const sMin = _hhmmToMin(s && s.start), eMin = _hhmmToMin(s && s.end);
    if (sMin === null || eMin === null) continue;
    shiftMin += _spanDur(sMin, eMin);
    rawSpans.push(..._unrollSpan(sMin, eMin));
  }
  // 合并为不重叠并集,使休息按墙钟分钟只扣一次(跨班次重叠区不重复计)
  rawSpans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const shiftSpans = [];
  for (const sp of rawSpans) {
    const last = shiftSpans[shiftSpans.length - 1];
    if (last && sp[0] <= last[1]) last[1] = Math.max(last[1], sp[1]);
    else shiftSpans.push([sp[0], sp[1]]);
  }

  // 休息:校验与某班次时段有交集,越界休息跳过并计数;跨班次重复部分只扣一次
  let breakMin = 0, orphanBreaks = 0;
  if (shiftConfig.breaks) {
    for (const b of shiftConfig.breaks) {
      const bsMin = _hhmmToMin(b && b.start), beMin = _hhmmToMin(b && b.end);
      if (bsMin === null || beMin === null) continue;
      const bSpans = _unrollSpan(bsMin, beMin);
      let overlap = 0;
      for (const [bs, be] of bSpans) {
        for (const [ss, se] of shiftSpans) {
          const lo = Math.max(bs, ss), hi = Math.min(be, se);
          if (hi > lo) overlap += (hi - lo);
        }
      }
      if (overlap <= 0) { orphanBreaks++; continue; } // 越界休息不计入
      breakMin += overlap;
    }
  }

  const extras = calcShiftExtras(shiftConfig);

  return {
    shiftMin: shiftMin || DEFAULT_SHIFT_MIN,
    breakMin,
    shiftChangeMin: extras.shiftChangeMin,
    preShiftMin: extras.preShiftMin,
    orphanBreaks,
    shiftChangeSource: extras.shiftChangeSource
  };
}

// MES过站间隙推微停机(P1): 同一线体相邻过站时间间隔>阈值(默认10min)视为非计划停机
// 返回 { "line_name": idleGapMin }, 仅累计间隙超过阈值的部分(间隙-阈值), 避免把正常节拍间隔回收
const MES_GAP_THRESHOLD_MIN = 10; // 过站间隔超过此值(分钟)视为微停机
// 按 (line, move_out_date) 分组计算同日相邻过站间隙>阈值部分, 返回 { "date|line": idleMin }
// 同日分组避免跨天/过夜间隙被误计为微停机(daily 与汇总口径一致)
async function _lineIdleGapsByDay(dateFrom, dateTo, lineName) {
  const m = { move_out_date: { $gte: dateFrom, $lte: dateTo }, line_name: { $nin: [null, ''] }, move_out_time: { $nin: [null, ''] } };
  if (lineName) m.line_name = lineName;
  let rows;
  try {
    // projection 仅保留间隙计算所需 3 字段, 减少全量 production 行(含 SN/工位/时间戳等)的网络传输与内存占用。
    // 服务端窗口函数改造(LAG over sorted rows)可选, 此处仅加 projection 降传输量。
    rows = await col.production.aggregate([
      { $match: prefixAi(m) },
      { $sort: prefixAi({ line_name: 1, move_out_date: 1, move_out_time: 1 }) },
      { $project: { move_out_date: '$ai_move_out_date', line_name: '$ai_line_name', move_out_time: '$ai_move_out_time', _id: 0 } }
    ]).toArray();
  } catch(e) { return {}; }
  const byKey = {};
  const thrMs = MES_GAP_THRESHOLD_MIN * 60 * 1000;
  for (const r of rows) {
    const key = (r.move_out_date || '') + '|' + r.line_name;
    if (!byKey[key]) byKey[key] = { last: null, idle: 0 };
    const t = new Date(r.move_out_time).getTime();
    if (isNaN(t)) continue;
    if (byKey[key].last !== null) {
      const gap = t - byKey[key].last;
      if (gap > thrMs) byKey[key].idle += (gap - thrMs); // 超阈值部分计入
    }
    byKey[key].last = t;
  }
  const out = {};
  for (const [key, v] of Object.entries(byKey)) out[key] = v.idle / 60000; // 转分钟
  return out;
}
// 汇总口径: 各日同线微停机求和(已按日分组, 不再 ×numDays, 也不含过夜间隙)
async function _lineIdleGaps(dateFrom, dateTo, lineName) {
  const byDay = await _lineIdleGapsByDay(dateFrom, dateTo, lineName);
  const byLine = {};
  for (const [key, min] of Object.entries(byDay)) {
    const ln = key.substring(key.indexOf('|') + 1); // "date|line" → line
    byLine[ln] = (byLine[ln] || 0) + min;
  }
  return byLine;
}

async function computeOEE(dateFrom, dateTo, lineName) {
  const prodByLine = await queryProductionByLine(dateFrom, dateTo);
  const badItems = await queryBadItems(dateFrom, dateTo, lineName);
  const downtimes = await getDowntimeRecords(dateFrom, dateTo, lineName);
  const products = await getProducts();
  const overrides = await getShiftOverrides(dateFrom, dateTo, lineName);
  const idleGaps = await _lineIdleGaps(dateFrom, dateTo, lineName); // P1: MES间隙推微停机

  // 动态获取停机分类，确保用户新增的类型也能被OEE计算识别
  const cats = await getDowntimeCategories();
  const plannedCodes = (cats.planned||[]).map(c => c.code);
  const unplannedCodes = (cats.unplanned||[]).map(c => c.code);

  // CT口径(诚实, 不造假工艺节拍): ①产品型号理论CT → ②MES反推(estimated真实实际节拍) → ③无配置则null(performance不可算)
  // 不做"同线加权"/"work_center按线匹配"/"全产品平均"等借CT回退——未配置型号的节拍不可用别的型号凑,否则工艺路线是假的

  // 查今天各线生产的产品型号,用于型号→CT直接匹配
  const prodCol = db.collection('ai_production');
  const lineModels = {};
  try {
    const models = await prodCol.aggregate([
      { $match: prefixAi({ move_out_date: { $gte: dateFrom, $lte: dateTo }, line_name: { $nin: [null, ''] } }) },
      { $group: { _id: { line: '$ai_line_name', model: '$ai_product_model' }, cnt: { $sum: 1 } } },
      { $sort: { cnt: -1 } }
    ]).toArray();
    for (const m of models) {
      const ln = m._id.line;
      if (!lineModels[ln]) lineModels[ln] = [];
      lineModels[ln].push({ model: m._id.model, cnt: m.cnt });
    }
  } catch(e) { /* 非关键,回退即可 */ }

  // 工作中心→线体映射仅用于工序/工位展示, 不参与CT推导(避免借工位CT套到未配置型号=造假工艺节拍)

  // 批量预取所有班次配置(替代 per-line getShiftConfig N+1 循环)
  const allShiftConfigs = await getShiftConfigs();

  const results = [];

  for (const pl of prodByLine) {
    if (lineName && pl.line_name !== lineName) continue;

    // --- 节拍时间推导(诚实口径: 只用产品自己的理论CT, 不借别的型号/工位) ---
    // 优先级: ①产品型号理论CT(工程配置) → ②MES反推(estimated,真实实际节拍) → ③默认
    // 注: 不做"同线加权"/"work_center按线匹配"等借CT回退——未配置型号的节拍不可用别的型号凑,否则工艺路线是假的
    let lineCT = null;
    let ctSource = 'missing_config';

    // ① 产品型号直接匹配: 取当天该线产量最大的、已配置理论CT的型号
    if (lineModels[pl.line_name]) {
      for (const { model, cnt } of lineModels[pl.line_name]) {
        const prodCfg = products.find(p => p.product_model === model && p.cycle_time > 0);
        if (prodCfg) { lineCT = prodCfg.cycle_time; ctSource = 'configured_model'; break; }
      }
    }

    // ② MES过站时间反推(降级estimated): 实际跨度/产量, 真实实际节拍(非理论), P测"跨度覆盖"非真速度
    if (ctSource === 'missing_config' && pl.first_time && pl.last_time && pl.total > 1) {
      const runSec = (new Date(pl.last_time) - new Date(pl.first_time)) / 1000;
      if (runSec > 60) { // 至少1分钟以上才有意义
        lineCT = runSec / pl.total;
        ctSource = 'mes_derived';
      }
    }

    // 班次配置: 批量预取(allShiftConfigs 已在循环外取), 替代 per-line getShiftConfig N+1
    const shiftConf = allShiftConfigs.find(s => s.line_name === pl.line_name) || allShiftConfigs.find(s => !s.line_name);
    const lineOverride = overrides.find(o => (o.line_name===pl.line_name || !o.line_name) && (!o.date || (o.date >= dateFrom && o.date <= dateTo)));
    const effectiveConf = lineOverride && lineOverride.shifts ? lineOverride : shiftConf;
    const hasShiftConfig = !!effectiveConf;
    const { shiftMin, breakMin, shiftChangeMin, preShiftMin, orphanBreaks, shiftChangeSource } = calcShiftMinutes(effectiveConf, dateFrom);

    const numDays = Math.max(1, Math.round((new Date(dateTo) - new Date(dateFrom))/(86400000)) + 1);
    const totalShiftMin = shiftMin * numDays;
    const totalBreakMin = breakMin * numDays;
    const totalShiftChangeMin = shiftChangeMin * numDays;
    const totalPreShiftMin = preShiftMin * numDays;

    const lineDt = downtimes.filter(d => d.line_name === pl.line_name);
    let plannedDt=0, unplannedDt=0, unknownDt=0, bdCount=0, bdMin=0;
    for (const d of lineDt) {
      if (plannedCodes.includes(d.downtime_category)) plannedDt += (d.duration||0);
      else if (unplannedCodes.includes(d.downtime_category)) { unplannedDt += (d.duration||0); }
      else { unknownDt += (d.duration||0); } // 未知类型独立统计,不打入非计划
      if (d.downtime_category==='breakdown') { bdCount++; bdMin+=(d.duration||0); }
    }
    let T3 = totalShiftMin - totalBreakMin - totalShiftChangeMin - totalPreShiftMin - plannedDt;
    const t3Invalid = T3 <= 0;
    if (t3Invalid) T3 = 0; // 配置异常(休息+点检+交接+计划停机>班次时长)保护,防负分母
    // P1: MES过站间隙推微停机(>10min的闲置), 计入非计划停机, 使稼动A反映真实利用率、性能P不再因闲置被惩罚
    const mesGapMin = idleGaps[pl.line_name] || 0; // idleGaps 已是全区间同日求和(不含过夜), 不再 ×numDays
    const effectiveUnplanned = unplannedDt + mesGapMin;
    const T5 = Math.max(T3 - effectiveUnplanned, 0);
    const availability = T3>0 ? T5/T3 : 0;

    // 性能率: 理论CT计算, cap到100%(OEE经典上限). 超出说明实际比理论快(理论CT配大/流水线并行), 真值perf_raw保留供data_quality披露
    const perfRaw = (T5>0 && lineCT!=null) ? (lineCT * pl.total) / (T5 * 60) : null;
    const performance = perfRaw!=null ? Math.min(perfRaw, 1) : null; // OEE上限100%; 无CT配置→null(不可算)

    // 质量率: 按唯一不良SN去重
    const lineBad = badItems.filter(b=>b.line_name===pl.line_name);
    const uniqueBad = new Set(lineBad.map(b=>b.barcode));
    const quality = pl.total>0 ? Math.max(pl.total-uniqueBad.size,0)/pl.total : 1;
    const oee = performance!=null ? availability*performance*quality : null;
    // MTBF/MTTR: 无故障(bdCount=0)时均为 null(无间隔/无维修可言), 前端显示 —; 与MTBF口径对称, 避免无故障线 MTTR=0 拉低多线均值
    const mtbf = bdCount>0 ? T5/bdCount : null;
    const mttr = bdCount>0 ? bdMin/bdCount : null;

    results.push({
      line_name:pl.line_name, total_output:pl.total, first_time:pl.first_time, last_time:pl.last_time,
      availability:+(availability*100).toFixed(1), performance: performance!=null ? +(performance*100).toFixed(1) : null, quality:+(quality*100).toFixed(1), oee: oee!=null ? +(oee*100).toFixed(1) : null,
      mtbf: mtbf===null ? null : +mtbf.toFixed(1), mttr: mttr===null ? null : +mttr.toFixed(1), breakdown_count:bdCount, bad_count:uniqueBad.size, good_output: pl.total - uniqueBad.size, bad_output: uniqueBad.size,
      run_time_min: +T5.toFixed(1), // 实际运行时长(分钟): 班次配置-各类停机推算, MES无设备开停机真值
      data_quality: {
        cycle_time: ctSource,
        cycle_time_sec: lineCT!=null ? +lineCT.toFixed(1) : null,
        shift: hasShiftConfig ? 'configured' : 'default',
        shift_change: shiftChangeSource,
        shift_change_min: totalShiftChangeMin > 0 ? +totalShiftChangeMin.toFixed(1) : 0,
        pre_shift_min: totalPreShiftMin > 0 ? +totalPreShiftMin.toFixed(1) : 0,
        orphan_breaks: orphanBreaks || 0,
        t3_invalid: t3Invalid ? true : null,
        downtime: lineDt.length ? 'records' : 'none',
        run_time_source: lineDt.length ? 'estimated_shift_minus_downtime' : 'estimated_no_downtime_records', // 运行时长恒为推算(无设备开停机信号)
        unknown_downtime_min: unknownDt > 0 ? +unknownDt.toFixed(1) : 0,
        mes_gap_min: mesGapMin > 0 ? +mesGapMin.toFixed(1) : 0,
        perf_suspicious: (perfRaw!=null && perfRaw > 1.0) ? 'perf_raw_gt_100pct_check_ct' : null,
        perf_raw: (perfRaw!=null && perfRaw > 1.0) ? +(perfRaw*100).toFixed(1) : null,
        _t3_min: +T3.toFixed(1),     // 临时: 计划运行时长(供富化钩子重算A用), 钩子后删除
        _lineCT: lineCT              // 临时: 节拍秒(供重算P用), 钩子后删除
      }
    });
  }

  // === 统一OEE外部访问层 富化钩子(默认关) ===
  // OEE_EXTERNAL_ENABLED=1 时, 用4个产线OEE库(功放1/2线·整机1/3线OEE)的"设备运行真值"覆盖 estimated 运行时长(T5):
  //   device_run_min 替换 T5 → 重算 A=T5/T3, P=(lineCT×total)/(T5×60), OEE=A×P×Q (Q按不良SN不变)
  // 分母从"班次-停机推算"升级为"设备实际开机制表真值"; 原estimated值保留进data_quality.estimated_* 供审计。
  // 无设备真值的线(QJG_/PKG_)不动, 维持estimated; 连不上只告警, 主链回退estimated。
  if (process.env.OEE_EXTERNAL_ENABLED === '1') {
    try {
      const { getDeviceOEEBatch } = require('./oee_external');
      const devMap = await getDeviceOEEBatch(dateFrom, dateTo, lineName, db);
      if (devMap) {
        for (const r of results) {
          const d = devMap[r.line_name];
          if (d && d.run_time_min != null && d.run_time_min > 0) {
            const dq = r.data_quality = r.data_quality || {};
            // 保留 estimated 原值供审计
            dq.estimated_availability = r.availability;
            dq.estimated_performance = r.performance;
            dq.estimated_oee = r.oee;
            dq.estimated_run_time_min = r.run_time_min;
            dq.estimated_run_time_source = dq.run_time_source;
            // 用设备真值重算
            const T3 = dq._t3_min || 0;
            const lineCT = dq._lineCT;
            const T5dev = d.run_time_min;
            const avail = T3 > 0 ? Math.min(T5dev / T3, 1) : 0; // cap 100%(设备运行不应超计划时长)
            const perfRaw = (T5dev > 0 && lineCT != null) ? (lineCT * r.total_output) / (T5dev * 60) : null;
            const perf = perfRaw != null ? Math.min(perfRaw, 1) : null;
            const qual = r.quality / 100; // Q 不变(按不良SN)
            const oeeNew = perf != null ? avail * perf * qual : null;
            r.availability = +(avail * 100).toFixed(1);
            r.performance = perf != null ? +(perf * 100).toFixed(1) : null;
            r.oee = oeeNew != null ? +(oeeNew * 100).toFixed(1) : null;
            r.run_time_min = +T5dev.toFixed(1);
            dq.run_time_source = 'device';
            dq.oee_source = 'device';
            dq.device_run_min = +T5dev.toFixed(1);
            dq.device_days = d.days || 0;
            if (perfRaw != null && perfRaw > 1.0) dq.perf_suspicious = 'perf_raw_gt_100pct_check_ct';
          }
          // 清临时字段
          if (r.data_quality) { delete r.data_quality._t3_min; delete r.data_quality._lineCT; }
        }
      } else {
        // 无设备真值: 清临时字段即可
        for (const r of results) { if (r.data_quality) { delete r.data_quality._t3_min; delete r.data_quality._lineCT; } }
      }
    } catch(e) { console.log('[oee_external] 富化失败,主链回退estimated:', e.message.substring(0,80)); }
  } else {
    for (const r of results) { if (r.data_quality) { delete r.data_quality._t3_min; delete r.data_quality._lineCT; } }
  }
  return results;
}

// === OEE Daily (逐天逐线，避免逐天调用 computeOEE) ===
async function computeOEEDaily(dateFrom, dateTo, lineName) {
  // 一次聚合产量：按 (move_out_date, line_name) 分组求 total + first/last time
  const prodMatch = { move_out_date: { $gte: dateFrom, $lte: dateTo }, line_name: { $nin: [null, ''] }, barcode: { $nin: [null, ''] } };
  if (lineName) prodMatch.line_name = lineName;
  // 产出口径=去重SN(过站一台多道, 去重后真实产品数; 与computeOEE/FPY口径一致)
  const prodByDayLine = await col.production.aggregate([
    { $match: prefixAi(prodMatch) },
    { $group: { _id: { date: '$ai_move_out_date', line_name: '$ai_line_name', sn: '$ai_barcode' }, first_time: { $min: '$ai_move_out_time' }, last_time: { $max: '$ai_move_out_time' } } },
    { $group: { _id: { date: '$_id.date', line_name: '$_id.line_name' }, total: { $sum: 1 }, first_time: { $min: '$first_time' }, last_time: { $max: '$last_time' } } },
    { $project: { _id: 0, date: '$_id.date', line_name: '$_id.line_name', total: 1, first_time: 1, last_time: 1 } }
  ]).toArray();

  // 一次聚合不良：按 (test_date, line_name) 分组，barcode 去重计数
  const badMatch = { test_date: { $gte: dateFrom, $lte: dateTo } };
  if (lineName) badMatch.line_name = lineName;
  const badByDayLine = await col.bad_repair.aggregate([
    { $match: prefixAi(badMatch) },
    { $group: { _id: { date: '$ai_test_date', line_name: '$ai_line_name' }, barcodes: { $addToSet: '$ai_barcode' } } },
    { $project: { _id: 0, date: '$_id.date', line_name: '$_id.line_name', unique_bad: { $size: '$barcodes' } } }
  ]).toArray();

  // 停机记录一次性拉取后内存按 (date, line_name) 归类
  const downtimes = await getDowntimeRecords(dateFrom, dateTo, lineName);
  const cats = await getDowntimeCategories();
  const plannedCodes = (cats.planned||[]).map(c => c.code);
  const unplannedCodes = (cats.unplanned||[]).map(c => c.code);

  // 一次拉取产品配置、班次覆盖、全部班次配置，避免逐天查询
  const products = await getProducts();
  const overrides = await getShiftOverrides(dateFrom, dateTo, lineName);
  const allShiftConfigs = await getShiftConfigs();
  const idleGapsByDay = await _lineIdleGapsByDay(dateFrom, dateTo, lineName); // 同日微停机, 与computeOEE口径一致

  // CT口径(诚实): daily无型号聚合, 用MES反推(estimated真实实际节拍) → 无配置则null(performance不可算). 不借work_center CT(避免造假工艺节拍)

  const shiftConfByLine = {};
  let globalShiftConf = null;
  allShiftConfigs.forEach(c => { if (c.line_name) shiftConfByLine[c.line_name] = c; else if (!globalShiftConf) globalShiftConf = c; });

  // 不良索引：(date, line_name) -> unique_bad
  const badMap = {};
  badByDayLine.forEach(b => { badMap[b.date + '|' + b.line_name] = b.unique_bad; });

  // 停机索引：(date, line_name) -> {plannedDt, unplannedDt, bdCount, bdMin}
  const dtMap = {};
  downtimes.forEach(d => {
    const key = d.date + '|' + d.line_name;
    if (!dtMap[key]) dtMap[key] = { plannedDt:0, unplannedDt:0, unknownDt:0, bdCount:0, bdMin:0 };
    const e = dtMap[key];
    if (plannedCodes.includes(d.downtime_category)) e.plannedDt += (d.duration||0);
    else if (unplannedCodes.includes(d.downtime_category)) e.unplannedDt += (d.duration||0);
    else e.unknownDt += (d.duration||0); // 未知类型独立统计
    if (d.downtime_category === 'breakdown') { e.bdCount++; e.bdMin += (d.duration||0); }
  });

  const results = [];
  for (const pl of prodByDayLine) {
    const ln = pl.line_name;
    const date = pl.date;

    // CT推导(诚实口径): daily无型号聚合, 用MES反推(estimated真实实际节拍) → 默认. 不借work_center CT
    let lineCT = null;
    let ctSource = 'missing_config';
    // ① MES过站时间反推(estimated, 真实实际节拍)
    if (pl.first_time && pl.last_time && pl.total > 1) {
      const runSec = (new Date(pl.last_time) - new Date(pl.first_time)) / 1000;
      if (runSec > 60) { lineCT = runSec / pl.total; ctSource = 'mes_derived'; }
    }

    const shiftConf = shiftConfByLine[ln] || globalShiftConf;
    const lineOverride = overrides.find(o => o.date === date && o.line_name === ln) || overrides.find(o => o.date === date && !o.line_name);
    const effectiveConf = lineOverride && lineOverride.shifts ? lineOverride : shiftConf;
    const { shiftMin, breakMin, shiftChangeMin, preShiftMin, orphanBreaks, shiftChangeSource } = calcShiftMinutes(effectiveConf, date);

    // 每日独立：班次分钟按 1 天算，不乘 numDays
    const dt = dtMap[date + '|' + ln] || { plannedDt:0, unplannedDt:0, unknownDt:0, bdCount:0, bdMin:0 };
    const mesGap = idleGapsByDay[date + '|' + ln] || 0; // MES同日过站间隙微停机(与computeOEE口径一致)
    let T3 = shiftMin - breakMin - shiftChangeMin - preShiftMin - dt.plannedDt;
    const t3Invalid = T3 <= 0;
    if (t3Invalid) T3 = 0; // 配置异常保护,防负分母
    const T5 = Math.max(T3 - dt.unplannedDt - mesGap, 0);
    const availability = T3>0 ? T5/T3 : 0;
    const perfRaw = (T5>0 && lineCT!=null) ? (lineCT*pl.total)/(T5*60) : null;
    const performance = perfRaw!=null ? Math.min(perfRaw, 1) : null; // 无CT配置→null(不可算), 与computeOEE一致
    const uniqueBad = badMap[date + '|' + ln] || 0;
    const quality = pl.total>0 ? Math.max(pl.total-uniqueBad,0)/pl.total : 1;
    const oee = performance!=null ? availability*performance*quality : null;
    const mtbf = dt.bdCount>0 ? T5/dt.bdCount : null;
    const mttr = dt.bdCount>0 ? dt.bdMin/dt.bdCount : null;

    results.push({
      date, line_name: ln, line_display: '',
      availability: +(availability*100).toFixed(1),
      performance: performance!=null ? +(performance*100).toFixed(1) : null,
      quality: +(quality*100).toFixed(1),
      oee: oee!=null ? +(oee*100).toFixed(1) : null,
      mtbf: mtbf===null ? null : +mtbf.toFixed(1),
      mttr: mttr===null ? null : +mttr.toFixed(1),
      total_output: pl.total,
      breakdown_count: dt.bdCount,
      bad_count: uniqueBad,
      run_time_min: +T5.toFixed(1), // 实际运行时长(分钟): 班次配置-停机推算, MES无设备开停机真值
      data_quality: {
        shift: effectiveConf ? 'configured' : 'default',
        shift_change: shiftChangeSource,
        shift_change_min: shiftChangeMin > 0 ? +shiftChangeMin.toFixed(1) : 0,
        pre_shift_min: preShiftMin > 0 ? +preShiftMin.toFixed(1) : 0,
        orphan_breaks: orphanBreaks || 0,
        t3_invalid: t3Invalid ? true : null,
        mes_gap_min: mesGap > 0 ? +mesGap.toFixed(1) : 0,
        downtime: (dt.bdCount > 0 || dt.plannedDt > 0 || dt.unplannedDt > 0 || (dt.unknownDt || 0) > 0) ? 'records' : 'none',
        run_time_source: (dt.bdCount > 0 || dt.plannedDt > 0 || dt.unplannedDt > 0 || (dt.unknownDt || 0) > 0) ? 'estimated_shift_minus_downtime' : 'estimated_no_downtime_records'
      }
    });
  }

  // 按 date 升序，同 date 内按 line_name 排序
  results.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.line_name < b.line_name ? -1 : a.line_name > b.line_name ? 1 : 0;
  });
  return results;
}

// === Downtime Pareto (停机柏拉图) ===
async function computeDowntimePareto(dateFrom, dateTo, lineName) {
  const m = { date: { $gte: dateFrom, $lte: dateTo } };
  if (lineName) m.line_name = lineName;
  const rows = await col.downtime_records.aggregate([
    { $match: prefixAi(m) },
    { $group: { _id: '$ai_downtime_category', minutes: { $sum: '$ai_duration' } } },
    { $project: { _id: 0, category: '$_id', minutes: 1 } },
    { $sort: { minutes: -1 } }
  ]).toArray();
  if (!rows.length) return [];

  // 调分类字典建立 code->label 映射
  const cats = await getDowntimeCategories();
  const codeLabel = {};
  (cats.planned||[]).forEach(c => { codeLabel[c.code] = c.label; });
  (cats.unplanned||[]).forEach(c => { codeLabel[c.code] = c.label; });

  const totalMinutes = rows.reduce((s,r) => s + (r.minutes||0), 0);
  let cumulative = 0;
  const arr = rows.map(r => {
    const minutes = r.minutes || 0;
    const percent = totalMinutes>0 ? minutes/totalMinutes*100 : 0;
    cumulative += percent;
    return {
      category: r.category,
      label: codeLabel[r.category] || r.category,
      minutes,
      percent: +percent.toFixed(1),
      cumulative: +cumulative.toFixed(1)
    };
  });
  // 强制末项累计为 100.0，避免浮点误差导致末项非 100
  if (arr.length) arr[arr.length-1].cumulative = 100.0;
  return arr;
}

// === Station UPH (工站产能) ===
async function queryStationUPH(dateFrom, dateTo, lineName) {
  const m = { move_out_date: { $gte: dateFrom, $lte: dateTo }, barcode: { $nin: [null, ''] } };
  if (lineName) m.line_name = lineName;
  // 工站UPH口径=去重SN: 同站同SN只算1台(返修/复测不重复计), 避免测试站过站次数虚高→UPH虚高→漏判瓶颈
  const rows = await col.production.aggregate([
    { $match: prefixAi(m) },
    { $group: { _id: { op: '$ai_work_operation_code', sn: '$ai_barcode' }, first_time: { $min: '$ai_move_out_time' }, last_time: { $max: '$ai_move_out_time' }, sort_no: { $min: '$ai_sort_no' } } },
    { $group: { _id: '$_id.op', total: { $sum: 1 }, first_time: { $min: '$first_time' }, last_time: { $max: '$last_time' }, sort_no: { $min: '$sort_no' } } },
    { $project: { _id: 0, operation: '$_id', total: 1, first_time: 1, last_time: 1, sort_no: 1 } },
    { $sort: { total: -1 } }
  ]).toArray();

  // 统一时间窗：MES真实净生产工时优先(该线), fallback estimated T5
  const mes = await getMesRunHours(dateFrom, dateTo, lineName || null, null);
  let runH, runSource;
  if (mes.coverage === 'mes' && mes.totalHours > 0) { runH = mes.totalHours; runSource = 'mes'; }
  else { runH = await _runHours(dateFrom, dateTo, lineName || null); runSource = 'estimated'; }
  // 样本不足判定: total<10 置 null(绝对最小样本);total<maxTotal*5% 标记 sample_insufficient(有值但不参与平衡率/瓶颈,避免低频工位极值CT拉低平衡率)
  const maxTotal = rows.reduce((mx, r) => Math.max(mx, r.total || 0), 0);
  const insufficientThreshold = Math.max(10, maxTotal * 0.05);
  return rows.map(r => {
    if (!r.total || r.total < 10 || runH == null) {
      return { operation: r.operation, total: r.total || 0, uph: null, ct_seconds: null, first_time: r.first_time, last_time: r.last_time, sort_no: r.sort_no, sample_insufficient: false, run_source: runSource };
    }
    const uph = r.total / runH;
    const ct_seconds = 3600 / uph;
    return {
      operation: r.operation,
      total: r.total,
      uph: +uph.toFixed(1),
      ct_seconds: +ct_seconds.toFixed(1),
      first_time: r.first_time, last_time: r.last_time, sort_no: r.sort_no,
      sample_insufficient: r.total < insufficientThreshold,  // 低频工位:有CT值但不参与平衡率/瓶颈
      run_source: runSource
    };
  });
}

// === Production by Stage (组装/测试/包装分段) ===
// 工序按工艺段分类: 包装 > 测试 > 组装(默认)
function stageOfOperation(name) {
  if (!name) return 'assembly';
  if (/包装|下料|贴标|封箱|装箱/.test(name)) return 'packaging';
  if (/测试|检测|EOL|ATE|振动|震动|老化|噪音|异响|目检|PIN|静置|GP12/.test(name)) return 'test';
  return 'assembly';
}

// 测试异常判定: bad_items 命中 -NoReturn / -纯数字(测量值/状态码) → 测试设备/程序问题,非产品不良
// 与前端 bad-core.js isTestAbnormal 同规则
const TEST_ABNORMAL_REGEX = /-NoReturn$|-\d+(\.\d+)?$/;
function isTestAbnormal(badItems) { return TEST_ABNORMAL_REGEX.test(badItems || ''); }
// 误测判定: content_name=误测/NTF 或 causes_name含故障不再现 或 remark=重测
function isMisce(doc) {
  const c = doc.content_name || '';
  const ca = doc.causes_name || '';
  const r = doc.remark || '';
  return c === '误测' || c === 'NTF' || ca.includes('故障不再现') || r === '重测';
}

// 三类互斥过滤器, typeFilter: 'all' | 'real' | 'abnormal' | 'mistest'
// real=非误测&&非测试异常; abnormal=非误测&&测试异常; mistest=误测(误测优先级最高)
function badTypeFilter(typeFilter) {
  if (typeFilter === 'real') {
    return [{ content_name: { $nin: ['误测', 'NTF'] } }, { causes_name: { $not: /故障不再现/ } }, { remark: { $ne: '重测' } }, { bad_items: { $not: TEST_ABNORMAL_REGEX } }];
  }
  if (typeFilter === 'abnormal') {
    return [{ content_name: { $nin: ['误测', 'NTF'] } }, { causes_name: { $not: /故障不再现/ } }, { remark: { $ne: '重测' } }, { bad_items: TEST_ABNORMAL_REGEX }];
  }
  if (typeFilter === 'mistest') {
    return [{ $or: [{ content_name: { $in: ['误测', 'NTF'] } }, { causes_name: /故障不再现/ }, { remark: '重测' }] }];
  }
  return null;
}

// 工艺段 + 类型联合过滤条件(注入到各 bad 查询的 $match)
function buildBadFilterExtras(stageFilter, typeFilter) {
  const extras = [];
  if (stageFilter && stageFilter !== 'all') {
    const TEST_RE = /测试|检测|EOL|ATE|振动|震动|老化|噪音|异响|目检|PIN|静置|GP12/;
    const PKG_RE = /包装|下料|贴标|封箱|装箱/;
    if (stageFilter === 'test') {
      extras.push({ work_operation_name: TEST_RE });
    } else if (stageFilter === 'packaging') {
      extras.push({ work_operation_name: PKG_RE });
    } else if (stageFilter === 'assembly') {
      // 组装 = 既非测试也非包装
      extras.push({ work_operation_name: { $not: TEST_RE } });
      extras.push({ work_operation_name: { $not: PKG_RE } });
    }
  }
  const typeConds = badTypeFilter(typeFilter);
  if (typeConds) typeConds.forEach(c => extras.push(c));
  return extras;
}

async function queryProductionByStage(dateFrom, dateTo, lineName) {
  // 工序 code→stage 映射(从 ai_work_operations 的中文名分类;production 的 name 常为空但 code 有值)
  // 用 60s 缓存的 getWorkOperations() 替代裸 find, 避免每次调用都全表扫描 ai_work_operations
  const opDocs = await getWorkOperations();
  const codeStage = {};
  opDocs.forEach(o => { if (o.code) codeStage[o.code] = stageOfOperation(o.name); });
  // 产出按 work_operation_code 分组
  const m = { move_out_date: { $gte: dateFrom, $lte: dateTo }, work_operation_code: { $nin: [null, ''] } };
  if (lineName) m.line_name = lineName;
  const byOp = await col.production.aggregate([
    { $match: prefixAi(m) },
    { $group: { _id: '$ai_work_operation_code', total: { $sum: 1 } } }
  ]).toArray();
  // 不良按 work_operation_name(中文)分组
  const bm = { test_date: { $gte: dateFrom, $lte: dateTo }, work_operation_name: { $nin: [null, ''] } };
  if (lineName) bm.line_name = lineName;
  const badByOp = await col.bad_repair.aggregate([
    { $match: prefixAi(bm) },
    { $group: { _id: '$ai_work_operation_name', total: { $sum: 1 } } }
  ]).toArray();
  const stages = {
    assembly: { stage: 'assembly', label: '组装', output: 0, bad: 0, ops: 0 },
    test: { stage: 'test', label: '测试', output: 0, bad: 0, ops: 0 },
    packaging: { stage: 'packaging', label: '包装', output: 0, bad: 0, ops: 0 }
  };
  let unknown = 0;
  byOp.forEach(o => {
    const st = codeStage[o._id] || 'assembly';
    if (stages[st]) { stages[st].output += o.total; stages[st].ops++; }
    else unknown += o.total;
  });
  badByOp.forEach(b => {
    const st = stageOfOperation(b._id);
    if (stages[st]) stages[st].bad += b.total;
  });
  const result = Object.values(stages).map(s => ({
    ...s,
    fpy: s.output > 0 ? +(((s.output - s.bad) / s.output) * 100).toFixed(1) : null,
    bad_rate: s.output > 0 ? +((s.bad / s.output) * 100).toFixed(2) : 0
  }));
  return {
    stages: result,
    total_output: byOp.reduce((s, o) => s + o.total, 0),
    total_bad: badByOp.reduce((s, b) => s + b.total, 0),
    unknown_output: unknown
  };
}

// === UPH 产出统计 (多维度·多粒度·三段末道工位口径) ===
// 产出口径与全站一致=去重SN; 段产出=该段末道工位过站去重SN(末道完成=段完成,口径干净,避免中间工序过站干扰)
// 通用过滤器 filters: { lineName, model, opCode, stageOps, shift } (均可空)
//   stageOps: 工艺段对应的工序code数组(由server层用stageOfOperation算出), opCode优先于stageOps
//   shift: 'day'(白班hour8-19) | 'night'(夜班hour20-23,0-7)
function _prodMatch(dateFrom, dateTo, filters) {
  const m = { move_out_date: { $gte: dateFrom, $lte: dateTo }, barcode: { $nin: [null, ''] } };
  if (filters && filters.lineName) m.line_name = filters.lineName;
  if (filters && filters.model) m.product_model = filters.model;
  if (filters && filters.opCode) m.work_operation_code = filters.opCode;
  else if (filters && filters.stageOps && filters.stageOps.length) m.work_operation_code = { $in: filters.stageOps };
  if (filters && filters.shift === 'day') m.hour = { $gte: 8, $lte: 19 };
  else if (filters && filters.shift === 'night') m.hour = { $in: [20,21,22,23,0,1,2,3,4,5,6,7] };
  return m;
}

// 通用去重SN计数(支持机型/工序过滤) — queryProductionTotal 的扩展版, 不改动原函数(10+调用点)
async function queryProductionCount(dateFrom, dateTo, filters = {}) {
  const rows = await col.production.aggregate([
    { $match: prefixAi(_prodMatch(dateFrom, dateTo, filters)) },
    { $group: { _id: '$ai_barcode' } },
    { $count: 'total' }
  ]).toArray();
  return rows.length > 0 ? rows[0].total : 0;
}

// 通用多维聚合(去重SN): groupBy = 'hour'|'day'|'line'|'model'|'operation'
// 先按 (分组键, sn) 去重, 再按分组键计数 — 与 queryProductionByHour/ByLine 口径一致
async function queryProductionAgg(dateFrom, dateTo, filters = {}, groupBy = 'day') {
  const fieldMap = { hour: '$ai_hour', day: '$ai_move_out_date', line: '$ai_line_name', model: '$ai_product_model', operation: '$ai_work_operation_code' };
  const field = fieldMap[groupBy] || '$ai_move_out_date';
  const rows = await col.production.aggregate([
    { $match: prefixAi(_prodMatch(dateFrom, dateTo, filters)) },
    { $group: { _id: { k: field, sn: '$ai_barcode' } } },
    { $group: { _id: '$_id.k', total: { $sum: 1 } } },
    { $project: { _id: 0, key: '$_id', total: 1 } },
    { $sort: { key: 1 } }
  ]).toArray();
  // 补 UPH/占比: line 维度有单线T5分母可算UPH; model/operation 分母不可靠(机型/工序无独立T5)只补占比
  if (groupBy === 'line' || groupBy === 'model' || groupBy === 'operation') {
    const sum = rows.reduce((a,r)=>a+(r.total||0),0);
    if (groupBy === 'line') {
      // MES真实工时优先(每线), fallback estimated T5
      const mes = await getMesRunHours(dateFrom, dateTo, null, filters.model);
      const t5res = await computeLineT5(dateFrom, dateTo, null);
      const t5byLine = t5res?.byLine || {};
      rows.forEach(r => {
        r.pct = sum>0 ? +((r.total/sum)*100).toFixed(1) : 0;
        const mesL = mes.byLine[r.key];
        if (mes.coverage === 'mes' && mesL && mesL > 0) { r.run_hours = +mesL.toFixed(1); r.uph = +(r.total/mesL).toFixed(1); r.run_source='mes'; }
        else { const t5l = t5byLine[r.key]; r.run_hours = t5l!=null ? +(t5l/60).toFixed(1) : null; r.uph = (t5l && t5l>0) ? +(r.total/(t5l/60)).toFixed(1) : null; r.run_source='estimated'; }
      });
    } else {
      rows.forEach(r => { r.pct = sum>0 ? +((r.total/sum)*100).toFixed(1) : 0; });
    }
  }
  return rows;
}

// 工序×小时 二维去重SN产出矩阵(分工位小时产出): (op,hour,sn)去重 → (op,hour)计数
// 返回 [{op, hour, total}], hour 为本地 0-23; 供前端热力图渲染
async function queryProductionOpHour(dateFrom, dateTo, filters = {}) {
  return await col.production.aggregate([
    { $match: prefixAi(_prodMatch(dateFrom, dateTo, filters)) },
    { $group: { _id: { op: '$ai_work_operation_code', hour: '$ai_hour', sn: '$ai_barcode' } } },
    { $group: { _id: { op: '$_id.op', hour: '$_id.hour' }, total: { $sum: 1 } } },
    { $project: { _id: 0, op: '$_id.op', hour: '$_id.hour', total: 1 } }
  ]).toArray();
}

// 末道工位(整机下线)去重SN byHour = 每小时产出/下线台数
// 与 queryProductionAgg('hour') 区别: 后者是全工序活跃产品数(同SN跨小时重复, 和>产出); 本函数用包装末道, 和≈产出
async function queryProductionByHourEnd(dateFrom, dateTo, filters = {}) {
  const endOps = await getStageEndOps(filters.lineName || null);
  const codes = endOps.packaging;  // 包装末道=整机下线
  if (!codes || !codes.length) return [];
  const m = { move_out_date:{$gte:dateFrom,$lte:dateTo}, barcode:{$nin:[null,'']}, work_operation_code:{$in:codes} };
  if (filters.lineName) m.line_name = filters.lineName;
  if (filters.model) m.product_model = filters.model;
  if (filters.shift === 'day') m.hour = {$gte:8, $lte:19};
  else if (filters.shift === 'night') m.hour = {$in:[20,21,22,23,0,1,2,3,4,5,6,7]};
  return await col.production.aggregate([
    { $match: prefixAi(m) },
    { $group: { _id: { hour: '$ai_hour', sn: '$ai_barcode' } } },
    { $group: { _id: '$_id.hour', total: { $sum: 1 } } },
    { $project: { _id: 0, key: '$_id', total: 1 } },
    { $sort: { key: 1 } }
  ]).toArray();
}

// 末道工位(整机下线)去重SN总数 = 今日下线台数(成品口径)
// 与 queryProductionByHourEnd 同源(getStageEndOps.packaging), 返回总数而非按小时; 无末道配置→0
async function queryOfflineOutput(dateFrom, dateTo, lineName) {
  const endOps = await getStageEndOps(lineName || null);
  const codes = endOps.packaging;
  if (!codes || !codes.length) return 0;
  return await queryProductionCount(dateFrom, dateTo, { stageOps: codes });
}

// 交叉产出矩阵(行×列二维去重SN): rowDim/colDim ∈ {model,line,operation,hour,day}
// (row,col,sn)去重 → (row,col)计数; stage/shift 作为筛选(filters)不作为行列(派生维度聚合复杂)
async function queryProductionMatrix(dateFrom, dateTo, filters, rowDim, colDim) {
  const fieldMap = { model:'$ai_product_model', line:'$ai_line_name', operation:'$ai_work_operation_code', hour:'$ai_hour', day:'$ai_move_out_date' };
  const rowField = fieldMap[rowDim] || '$ai_product_model';
  const colField = fieldMap[colDim] || '$ai_line_name';
  return await col.production.aggregate([
    { $match: prefixAi(_prodMatch(dateFrom, dateTo, filters)) },
    { $group: { _id: { row: rowField, col: colField, sn: '$ai_barcode' } } },
    { $group: { _id: { row: '$_id.row', col: '$_id.col' }, total: { $sum: 1 } } },
    { $project: { _id:0, row:'$_id.row', col:'$_id.col', total:1 } }
  ]).toArray();
}

// 工艺段→工序code集合(供 stage 筛选用): 用 ai_work_operations 中文名 stageOfOperation 分类
async function getStageOpCodes(stage) {
  if (!stage) return null;
  const ops = await getWorkOperations();
  return ops.filter(o => o.code && stageOfOperation(o.name) === stage).map(o => o.code);
}

// 实际运行分钟(T5): 复用 OEE 口径 = 班次总 - 休息 - 交接 - 点检 - 计划停机 - 非计划停机 - MES间隙微停机
// 全厂(多线)时各线T5求和; 无班次配置→null。比旧 shiftMin(班次总,未扣休息停机) 准 — 修复UPH偏低
// 量化验证(ASS_Line2 6/20-25): shiftMin口径UPH=43.7, T5口径UPH≈51+(扣休息+交接+点检), 偏差+17%
async function computeLineT5(dateFrom, dateTo, lineName) {
  const numDays = Math.max(1, Math.round((new Date(dateTo) - new Date(dateFrom)) / 86400000) + 1);
  const lines = await getLines();
  const targetLines = lineName ? lines.filter(l=>l.line_name===lineName) : lines;
  if (!targetLines.length) return null;
  const allShiftConfigs = await getShiftConfigs();
  const overrides = await getShiftOverrides(dateFrom, dateTo, lineName);
  const downtimes = await getDowntimeRecords(dateFrom, dateTo, lineName);
  const cats = await getDowntimeCategories();
  const plannedCodes = (cats.planned||[]).map(c=>c.code);
  const unplannedCodes = (cats.unplanned||[]).map(c=>c.code);
  // 注: 不调 _lineIdleGaps(MES过站间隙微停机) — 它拉全量过站排序到内存, 本月4-8s 太慢致 puppeteer 超时
  // UPH 用 T3-非计划停机(扣休息+交接+点检+计划/非计划停机), 不含微停机; OEE 仍用完整T5(含mesGap), 口径略异但UPH够准且快
  let totalT5 = 0, hasAny = false;
  const byLine = {};
  for (const l of targetLines) {
    const shiftConf = allShiftConfigs.find(s=>s.line_name===l.line_name) || allShiftConfigs.find(s=>!s.line_name);
    const ov = overrides.find(o=>(o.line_name===l.line_name||!o.line_name)&&(!o.date||(o.date>=dateFrom&&o.date<=dateTo)));
    const eff = ov&&ov.shifts ? ov : shiftConf;
    if (!eff) continue;
    const { shiftMin, breakMin, shiftChangeMin, preShiftMin } = calcShiftMinutes(eff, dateFrom);
    const lineDt = downtimes.filter(d=>d.line_name===l.line_name);
    let plannedDt=0, unplannedDt=0;
    for (const d of lineDt) {
      if (plannedCodes.includes(d.downtime_category)) plannedDt += (d.duration||0);
      else if (unplannedCodes.includes(d.downtime_category)) unplannedDt += (d.duration||0);
    }
    const mesGap = 0; // 不含MES间隙微停机(性能: _lineIdleGaps 太慢), 见上方注释
    let T3 = shiftMin*numDays - breakMin*numDays - shiftChangeMin*numDays - preShiftMin*numDays - plannedDt;
    if (T3 < 0) T3 = 0;
    const T5 = Math.max(T3 - unplannedDt - mesGap, 0);
    totalT5 += T5;
    byLine[l.line_name] = T5;
    hasAny = true;
  }
  return hasAny ? { total: totalT5, byLine } : null;
}

// 运行小时数(T5实际运行/60, 与 OEE 口径一致): 无班次配置→null
async function _runHours(dateFrom, dateTo, lineName) {
  const t5 = await computeLineT5(dateFrom, dateTo, lineName || null);
  return t5 != null ? t5.total/60 : null;
}

// MES真实净生产工时(任务单×工序级 moveOutWorkHours 求和, recordType=2量产, moveOutWorkHours>0)
// 替代 estimated T5 作UPH实际分母, 根治运行时长失真+中低产机型全厂分母稀释
// 返回 {totalHours, byLine, coverage}: coverage='mes'(有数据)|'none'(无数据,调用方fallback estimated)
async function getMesRunHours(dateFrom, dateTo, lineName, productModel) {
  const m = { produce_date: { $gte: dateFrom, $lte: dateTo }, record_type: 2, move_out_work_hours: { $gt: 0 } };
  if (lineName) m.line_name = lineName;
  if (productModel) m.product_model = productModel;
  const rows = await col.task_move_hours.aggregate([
    { $match: prefixAi(m) },
    { $group: { _id: '$ai_line_name', hours: { $sum: '$ai_move_out_work_hours' } } }
  ]).toArray();
  if (!rows.length) return { totalHours: null, byLine: {}, coverage: 'none' };
  const byLine = {};
  let total = 0;
  rows.forEach(r => { if (r._id) { byLine[r._id] = +r.hours.toFixed(2); total += r.hours; } });
  return { totalHours: +total.toFixed(2), byLine, coverage: 'mes' };
}

// 三段末道工位集合(按线体): 基于 ai_process_routes 的 operations 数组(已按工艺顺序排序),
// 用 stageOfOperation 分类, 每段最后出现的工序=末道; 汇总该线所有路线的各段末道. 无路线→空集
// 用 ai_work_operations 的 code→中文名 兜底 derived 路线(其 operations 无 display_name)
async function getStageEndOps(lineName) {
  const routeCol = getDb().collection('ai_process_routes');
  const match = { 'operations.0': { $exists: true } };
  if (lineName) match.line_name = lineName;
  const [routes, opDocs] = await Promise.all([
    stripAi(await routeCol.find(prefixAi(match)).toArray()),
    getWorkOperations()
  ]);
  const opNameMap = {};
  opDocs.forEach(o => { if (o.code) opNameMap[o.code] = o.name || o.code; });
  const ends = { assembly: new Set(), test: new Set(), packaging: new Set() };
  routes.forEach(r => {
    const lastByStage = { assembly: null, test: null, packaging: null };
    (r.operations || []).forEach(o => {
      const code = o.name || o.code;
      if (!code) return;
      const dispName = o.display_name || opNameMap[code] || code;
      const st = stageOfOperation(dispName);
      if (lastByStage[st] !== undefined) lastByStage[st] = code; // 后出现覆盖=末道(数组已按工艺序)
    });
    Object.keys(lastByStage).forEach(st => { if (lastByStage[st]) ends[st].add(lastByStage[st]); });
  });
  return { assembly: Array.from(ends.assembly), test: Array.from(ends.test), packaging: Array.from(ends.packaging) };
}

// 三段末道工位产出(去重SN) + 段UPH + 目标UPH(3600/cycle_time, 按机型匹配)
async function queryProductionByStageEnd(dateFrom, dateTo, filters = {}) {
  const endOps = await getStageEndOps(filters.lineName || null);
  const lineName = filters.lineName || null;
  // 段级runH: MES真实工时优先, fallback estimated T5
  const mes = await getMesRunHours(dateFrom, dateTo, lineName, filters.model);
  let runH, runSource;
  if (mes.coverage === 'mes' && mes.totalHours > 0) { runH = mes.totalHours; runSource = 'mes'; }
  else { runH = await _runHours(dateFrom, dateTo, lineName); runSource = 'estimated'; }
  const mesByLine = mes.byLine || {};
  // 目标UPH基准(工序级): capacity_data 是单工序节拍(3600/ct=uph), 段级目标取该段末道工序的uph
  //   需 work_operation_code → mes_id 映射(项目工序集合存了 mes_id), 再按 (机型,mes_id) 查 capacity uph_value(量产优先)
  // 兜底链: capacity工序级 → capacity机型级(量产) → product_config.cycle_time(整机综合节拍) → null
  const [capData, products, opDocs] = await Promise.all([getCapacityData(), getProducts(), getWorkOperations()]);
  const codeToMesId = {};
  opDocs.forEach(o => { if (o.code && o.mes_id) codeToMesId[o.code] = o.mes_id; });
  // 工序级目标: (机型, mes_id) → uph (量产优先, 同工序多条取量产)
  const capOpUph = {}; // key = model|mes_id → {uph, ct}
  const capSeen = {};
  capData.forEach(c => {
    if (!c.product_model || !c.work_operation_id) return;
    const key = c.product_model + '|' + c.work_operation_id;
    const isMass = c.order_type === '量产';
    const prev = capSeen[key];
    if (prev === undefined || (!prev && isMass)) { capOpUph[key] = { uph: c.uph_value, ct: c.ct }; capSeen[key] = isMass; }
  });
  // 机型级兜底: capacity 量产条目 → product_config.cycle_time
  const ctByModel = {};
  const capModelSeen = {};
  capData.forEach(c => {
    if (!c.product_model || !c.ct || c.ct <= 0) return;
    const isMass = c.order_type === '量产';
    const prev = capModelSeen[c.product_model];
    if (prev === undefined || (!prev && isMass)) { ctByModel[c.product_model] = c.ct; capModelSeen[c.product_model] = isMass; }
  });
  products.forEach(p => { if (p.cycle_time > 0 && p.product_model && !(p.product_model in ctByModel)) ctByModel[p.product_model] = p.cycle_time; });
  // 全厂时各线工时(MES优先, estimated兜底), 用于段UPH=Σ各线(并行产出和), 与 summary.uph 口径一致
  let hoursByLine = null;
  if (!lineName) {
    const t5res = await computeLineT5(dateFrom, dateTo, null);
    const t5byLine = t5res ? t5res.byLine : {};
    // MES byLine 优先, 缺的线用 estimated T5/60 兜底
    const allLines = new Set([...Object.keys(mesByLine), ...Object.keys(t5byLine)]);
    hoursByLine = {};
    allLines.forEach(l => {
      const mesL = mesByLine[l];
      if (mes.coverage === 'mes' && mesL && mesL > 0) hoursByLine[l] = mesL;
      else if (t5byLine[l] && t5byLine[l] > 0) hoursByLine[l] = t5byLine[l]/60;
    });
    if (!Object.keys(hoursByLine).length) hoursByLine = null;
  }
  const stages = ['assembly', 'test', 'packaging'];
  const labels = { assembly: '组装', test: '测试', packaging: '包装' };
  const result = [];
  for (const st of stages) {
    const codes = endOps[st];
    if (!codes.length) {
      result.push({ stage: st, label: labels[st], end_ops: [], output: 0, uph: null, target_uph: null, ct_seconds: null });
      continue;
    }
    const m = { move_out_date: { $gte: dateFrom, $lte: dateTo }, work_operation_code: { $in: codes }, barcode: { $nin: [null, ''] } };
    if (filters.lineName) m.line_name = filters.lineName;
    if (filters.model) m.product_model = filters.model;
    const rows = await col.production.aggregate([
      { $match: prefixAi(m) },
      { $group: { _id: '$ai_barcode' } },
      { $count: 'total' }
    ]).toArray();
    const output = rows.length > 0 ? rows[0].total : 0;
    let uph = null;
    if (lineName) {
      uph = (runH != null && runH > 0) ? +(output / runH).toFixed(1) : null;
    } else if (hoursByLine) {
      // 全厂: Σ各线(该线段产出_l/各线工时_l) 并行产出和 (工时=MES真实优先, estimated兜底)
      const mAll = { move_out_date: { $gte: dateFrom, $lte: dateTo }, work_operation_code: { $in: codes }, barcode: { $nin: [null, ''] } };
      if (filters.model) mAll.product_model = filters.model;
      const byLine = await col.production.aggregate([
        { $match: prefixAi(mAll) },
        { $group: { _id: { line: '$ai_line_name', sn: '$ai_barcode' } } },
        { $group: { _id: '$_id.line', total: { $sum: 1 } } }
      ]).toArray();
      let sumUph = 0;
      byLine.forEach(r => { const h = hoursByLine[r._id]; if (h && h > 0) sumUph += r.total / h; });
      uph = sumUph > 0 ? +sumUph.toFixed(1) : null;
    }
    // 目标UPH(工序级): 指定机型时, 取该段末道工序在 capacity_data 的 uph(量产优先)
    //   末道工序可能多个(B50等), 取命中 capacity 的首个; 都未命中→机型级兜底; 再无→null
    let targetUph = null, ctSec = null, targetSource = null;
    if (filters.model) {
      for (const code of codes) {
        const mesId = codeToMesId[code];
        if (!mesId) continue;
        const hit = capOpUph[filters.model + '|' + mesId];
        if (hit && hit.uph > 0) { targetUph = +hit.uph.toFixed(1); ctSec = hit.ct != null ? +hit.ct.toFixed(1) : null; targetSource = 'capacity_op'; break; }
      }
      // 兜底1: capacity 机型级(量产)
      if (targetUph == null && ctByModel[filters.model]) {
        ctSec = +ctByModel[filters.model].toFixed(1); targetUph = +(3600 / ctByModel[filters.model]).toFixed(1); targetSource = 'capacity_model';
      }
      // 兜底2 已含在 ctByModel(product_config) — 不再单独标
    }
    result.push({ stage: st, label: labels[st], end_ops: codes, output, uph, target_uph: targetUph, ct_seconds: ctSec, target_source: targetSource });
  }
  return { stages: result, run_hours: runH, run_source: runSource };
}

// 周期汇总: 总产出(去重SN) + 环比 + UPH + 活跃机型/线体/工序数
async function queryProductionSummary(dateFrom, dateTo, filters = {}, prevFrom = null, prevTo = null) {
  const total = await queryProductionCount(dateFrom, dateTo, filters);
  const lineName = filters.lineName || null;
  let uph = null, runH = null, runSource = 'estimated';
  // 优先 MES 真实净生产工时(moveOutWorkHours), fallback estimated T5
  const mes = await getMesRunHours(dateFrom, dateTo, lineName, filters.model);
  if (lineName) {
    if (mes.coverage === 'mes' && mes.totalHours > 0) {
      runH = mes.totalHours; runSource = 'mes';
    } else {
      runH = await _runHours(dateFrom, dateTo, lineName);
    }
    uph = (runH != null && runH > 0) ? +(total / runH).toFixed(1) : null;
  } else {
    // 全厂: UPH=Σ各线(产出_l/工时_l) 并行产出和 — MES工时优先, 各线fallback estimated T5
    const lineAgg = await queryProductionAgg(dateFrom, dateTo, filters, 'line');
    let sumUph = 0; let mesAny = false;
    lineAgg.forEach(r => {
      const mesL = mes.byLine[r.key];
      if (mes.coverage === 'mes' && mesL && mesL > 0) { sumUph += r.total / mesL; mesAny = true; }
      else { /* fallback 在下方统一算 */ }
    });
    if (mesAny) {
      uph = sumUph > 0 ? +sumUph.toFixed(1) : null; runSource = 'mes';
      runH = mes.totalHours; // 总工时(参考)
      // 对MES未覆盖的线补 estimated 并累加
      const t5res = await computeLineT5(dateFrom, dateTo, null);
      if (t5res && t5res.byLine) {
        lineAgg.forEach(r => { const mesL = mes.byLine[r.key]; if (!(mesL && mesL > 0)) { const t5_l = t5res.byLine[r.key]; if (t5_l && t5_l > 0) sumUph += r.total / (t5_l/60); } });
        uph = sumUph > 0 ? +sumUph.toFixed(1) : null;
      }
    } else {
      // 全部 fallback estimated
      const t5res = await computeLineT5(dateFrom, dateTo, null);
      if (t5res && t5res.byLine) {
        let s = 0;
        lineAgg.forEach(r => { const t5_l = t5res.byLine[r.key]; if (t5_l && t5_l > 0) s += r.total / (t5_l/60); });
        uph = s > 0 ? +s.toFixed(1) : null;
        runH = t5res.total != null ? t5res.total/60 : null;
      }
    }
  }
  let prevTotal = null, mom = null;
  if (prevFrom && prevTo) {
    prevTotal = await queryProductionCount(prevFrom, prevTo, filters);
    if (prevTotal > 0) mom = +(((total - prevTotal) / prevTotal) * 100).toFixed(1);
  }
  const [models, lines, ops] = await Promise.all([
    col.production.distinct('ai_product_model', prefixAi(_prodMatch(dateFrom, dateTo, filters))),
    col.production.distinct('ai_line_name', prefixAi(_prodMatch(dateFrom, dateTo, filters))),
    col.production.distinct('ai_work_operation_code', prefixAi(_prodMatch(dateFrom, dateTo, filters)))
  ]);
  return {
    total, prev_total: prevTotal, mom, uph, run_hours: runH, run_source: runSource,
    active_models: models.filter(Boolean).length,
    active_lines: lines.filter(Boolean).length,
    active_ops: ops.filter(Boolean).length
  };
}

// 产出明细最早日期(用于页面诚实标注数据起点, 长周期若不足则提示)
async function getProductionDataStart() {
  // 注: ai_ 代码须配合已迁移的 ai_ DB; 迁移前查询会落空(非bug)。见 migrate_ai_prefix.js
  const r = stripAi(await col.production.find(prefixAi({ move_out_date: { $gte: '0000' } })).sort({ ai_move_out_date: 1 }).limit(1).project({ ai_move_out_date: 1, _id: 0 }).toArray());
  return r[0] ? r[0].move_out_date : null;
}

// === Bad Analysis Advanced Queries ===
// bad_repair ai_→原名 别名阶段: $match 用 ai_ 字段查库后, 把所需字段别名回原名,
// 使后续 _closureMsStage/$group/$facet 等复杂管道沿用原名 $field 引用, 无需逐个改表达式
const _badAliasStage = { $addFields: {
  id:'$ai_id', barcode:'$ai_barcode', line_name:'$ai_line_name', product_model:'$ai_product_model',
  work_operation_name:'$ai_work_operation_name', work_station:'$ai_work_station',
  bad_items:'$ai_bad_items', bad_positions:'$ai_bad_positions', category_name:'$ai_category_name',
  content_name:'$ai_content_name', causes_name:'$ai_causes_name', remark:'$ai_remark',
  repair_state_code:'$ai_repair_state_code', repair_man:'$ai_repair_man', repair_time:'$ai_repair_time',
  repair_area:'$ai_repair_area', repair_level:'$ai_repair_level', repair_total:'$ai_repair_total',
  test_user:'$ai_test_user', test_time:'$ai_test_time', test_date:'$ai_test_date',
  quality_inspector:'$ai_quality_inspector', quality_time:'$ai_quality_time', quality_confirm:'$ai_quality_confirm',
  mo_lot_no:'$ai_mo_lot_no', task_order_no:'$ai_task_order_no', item_number:'$ai_item_number',
  part_name:'$ai_part_name', part_no:'$ai_part_no', organization_code:'$ai_organization_code',
  synced_at:'$ai_synced_at', source:'$ai_source'
}};
// 构造 bad 查询的公共前置管道: $match(base, ai_) + [excludeMisce $match] + [extras...$match] + _badAliasStage(别名回原名)
// 多个查询共享同一筛选口径, 抽出复用避免口径漂移
function _badMatchStages(dateFrom, dateTo, lineName, excludeMisce, stageFilter, typeFilter) {
  const m = { test_date: { $gte: dateFrom, $lte: dateTo } };
  if (lineName) m.line_name = lineName;
  const stages = [{ $match: prefixAi(m) }];
  if (excludeMisce) {
    // 与 isMistest/isMisce 三条件对齐: 误测判定为 OR(content∈{误测,NTF} || causes含故障不再现 || remark=重测),
    // 取反即 AND, 避免老口径漏排 causes_name 含"故障不再现"导致 excludeMisce ≠ type=real
    stages.push({ $match: prefixAi({
      content_name: { $nin: ['误测', 'NTF'] },
      causes_name: { $not: /故障不再现/ },
      remark: { $ne: '重测' }
    })});
  }
  // 工艺段 + 不良类型 二维筛选(排除 isMistest 后再按 type 切分)
  buildBadFilterExtras(stageFilter, typeFilter).forEach(c => stages.push({ $match: prefixAi(c) }));
  stages.push(_badAliasStage);
  return stages;
}
// $addFields _closureMs: repair_time - test_time(毫秒), 仅对已闭环(state=20)且双时间齐全的记录
const _closureMsStage = { $addFields: { _closureMs: {
  $cond: [
    { $and: [
      { $eq: ['$repair_state_code', 20] },
      { $ifNull: ['$test_time', false] },
      { $ifNull: ['$repair_time', false] }
    ]},
    { $subtract: [{ $toDate: '$repair_time' }, { $toDate: '$test_time' }] },
    null
  ]
}}};

async function queryBadSummary(dateFrom, dateTo, lineName, excludeMisce, stageFilter, typeFilter) {
  const matchStages = _badMatchStages(dateFrom, dateTo, lineName, excludeMisce, stageFilter, typeFilter);

  // === 拆分聚合消除 16MB BSON 风险 ===
  // 旧实现把 barcodes/$addToSet + closedBarcodes/$addToSet + closureMsVals/$push + topDefects/$push
  // 全部累积进单个 _id:null 文档: 宽日期范围下数百万条记录的数组同框物化, 必撞 16MB 上限。
  // 现拆为 4 个并行轻量聚合, 每个只产出小文档:
  //   A) total/closed/closureMsSum/closureMsCount($sum, 无数组) + $percentile 算 P50/P90
  //   B) bad_unique/closed_unique(两阶段 $group 去重 + $count)
  //   C) topDefects($group + $sort + $limit, 输出限定个数的字符串数组)
  //   D) barcodes 数组(供 server.js .filter().length; 两阶段去重 + $limit 上限保护)
  const [aggA, aggB, aggC, aggD] = await Promise.all([
    // A: 总数/闭环数/闭环时长统计 + P50/P90
    col.bad_repair.aggregate([
      ...matchStages, _closureMsStage,
      { $group: {
        _id: null,
        total: { $sum: 1 },
        closed: { $sum: { $cond: [{ $eq: ['$repair_state_code', 20] }, 1, 0] } },
        closureMsSum: { $sum: '$_closureMs' },
        closureMsCount: { $sum: { $cond: [{ $ne: ['$_closureMs', null] }, 1, 0] } },
        // P50/P90 用 $percentile(MongoDB 5.0+); 版本不支持时 catch 后走 $push 兜底(见下方)
        p50: { $percentile: { input: '$_closureMs', p: [0.5], method: 'approximate' } },
        p90: { $percentile: { input: '$_closureMs', p: [0.9], method: 'approximate' } }
      }}
    ]).toArray().catch(() => null),
    // B: unique SN 计数(两阶段去重: 先按 (state,barcode) 分组去重, 再按 state 分组 $sum:1 计数)
    col.bad_repair.aggregate([
      ...matchStages,
      { $group: { _id: { bc: '$barcode', closed: { $eq: ['$repair_state_code', 20] } } } },
      { $group: {
        _id: '$_id.closed',
        n: { $sum: 1 }
      }}
    ]).toArray().catch(() => []),
    // C: topDefects: $group 按 bad_items 计数, 降序取前 200, 展开为字符串数组(每个重复 count 次)
    // server.js 依赖字符串数组再 defMap 重排前 10; 这里取 top 200 已足够覆盖前 10, 控制数组大小
    col.bad_repair.aggregate([
      ...matchStages,
      { $group: { _id: '$bad_items', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 200 }
    ]).toArray().catch(() => []),
    // D: barcodes 数组(供 server.js .filter(b=>b).length 求唯一 SN 数):
    // 两阶段 $group 去重后再收集, $limit 上限 100000 防极端宽范围撞 16MB(唯一 SN 超 10w 时仅取前 10w, length 口径在极端下略偏小)
    col.bad_repair.aggregate([
      ...matchStages,
      { $match: { barcode: { $nin: [null, ''] } } },
      { $group: { _id: '$barcode' } },
      { $limit: 100000 },
      { $group: { _id: null, bcs: { $push: '$_id' } } }
    ]).toArray().catch(() => [])
  ]);

  // --- A 解析: total/closed/closureMsSum/closureMsCount/P50/P90 ---
  let total = 0, closed = 0, closureMsSum = 0, closureMsCount = 0;
  let p50Hours = null, p90Hours = null;
  if (aggA && aggA.length) {
    const r = aggA[0];
    total = r.total || 0; closed = r.closed || 0;
    closureMsSum = r.closureMsSum || 0; closureMsCount = r.closureMsCount || 0;
    // $percentile 在不支持版本(5.0 以下)会抛错 → aggA 为 null, 走兜底
    if (r.p50 != null) p50Hours = +(r.p50 / 3600000).toFixed(2);
    if (r.p90 != null) p90Hours = +(r.p90 / 3600000).toFixed(2);
  }
  // --- 兜底: $percentile 不支持时(聚合抛错 → aggA===null), 用 $push closureMsVals + JS 线性插值分位数 ---
  // ⚠️ 风险: 兜底路径仍 $push 全量 closureMs 进单文档, 宽范围可能撞 16MB。仅在低版本 Mongo(5.0 以下)触发;
  //    生产环境建议升级 Mongo 5.0+ 走 $percentile 主路径以彻底消除该风险。
  // 注: $percentile 成功但无闭环数据(p50/p90 为 null, closureMsCount=0)时不进兜底, 直接返回 null。
  if (aggA === null) {
    const fallback = await col.bad_repair.aggregate([
      ...matchStages, _closureMsStage,
      { $match: { _closureMs: { $ne: null } } },
      { $group: { _id: null, vals: { $push: '$_closureMs' } } }
    ]).toArray().catch(() => []);
    const vals = (fallback[0] && fallback[0].vals ? fallback[0].vals : []).slice().sort((a, b) => a - b);
    const pct = (p) => { if (!vals.length) return null; const idx = (vals.length - 1) * p, lo = Math.floor(idx), hi = Math.min(vals.length - 1, Math.ceil(idx)); const v = lo === hi ? vals[lo] : vals[lo] + (vals[hi] - vals[lo]) * (idx - lo); return +(v.valueOf() / 3600000).toFixed(2); };
    // 主聚合因 $percentile 失败而整体抛错 → 重跑无 $percentile 的轻量聚合补 total/closed/sum/count
    const basic = await col.bad_repair.aggregate([
      ...matchStages,
      { $group: { _id: null, total: { $sum: 1 }, closed: { $sum: { $cond: [{ $eq: ['$repair_state_code', 20] }, 1, 0] } }, closureMsSum: { $sum: { $cond: [{ $eq: ['$repair_state_code', 20] }, { $subtract: [{ $toDate: '$repair_time' }, { $toDate: '$test_time' }] }, 0] } }, closureMsCount: { $sum: { $cond: [{ $and: [{ $eq: ['$repair_state_code', 20] }, { $ifNull: ['$test_time', false] }, { $ifNull: ['$repair_time', false] }] }, 1, 0] } } } }
    ]).toArray().catch(() => []);
    if (basic.length) { total = basic[0].total || 0; closed = basic[0].closed || 0; closureMsSum = basic[0].closureMsSum || 0; closureMsCount = basic[0].closureMsCount || 0; }
    p50Hours = pct(0.5);
    p90Hours = pct(0.9);
  }

  // --- B 解析: bad_unique / closed_unique(两阶段去重计数) ---
  let badUnique = 0, closedUnique = 0;
  for (const g of aggB) {
    if (g._id === true) closedUnique = g.n || 0;
    else if (g._id === false) badUnique = g.n || 0;
  }
  badUnique += closedUnique; // bad_unique = 全部唯一 SN(含已闭环)

  // --- C 解析: topDefects 展开为字符串数组(保持原 $push 结构供 server.js defMap 重排) ---
  const topDefects = [];
  for (const d of aggC) {
    const name = d._id;
    if (name == null) continue;
    const c = Math.min(d.count || 0, 50); // 每种缺陷最多展开 50 次, 控制数组规模(前 10 排序不受影响)
    for (let i = 0; i < c; i++) topDefects.push(name);
  }

  // --- D 解析: barcodes 数组(供 server.js .filter(b=>b).length; 兜底空数组) ---
  const barcodes = (aggD[0] && aggD[0].bcs) ? aggD[0].bcs : [];

  // 计算闭环时长均值(小时)
  const closureCount = closureMsCount || 0;
  const closureAvgHours = closureCount > 0 ? +(closureMsSum / closureCount / 3600000).toFixed(2) : null;

  // 闭环率统一用 unique-SN 口径(closed_unique / bad_unique), 与前端 KPI/焦点壳 closedCount/bad 一致,
  // 避免 record-based(closed/total) 与 unique-SN 在 SN 重复时打架
  const closureRate = badUnique > 0 ? +((closedUnique / badUnique) * 100).toFixed(1) : 0;
  return {
    total,
    closed,
    barcodes,
    bad_unique: badUnique,
    closed_unique: closedUnique,
    closureRate,
    topDefects,
    closureAvgHours,
    closureP50Hours: p50Hours,
    closureP90Hours: p90Hours,
    closureCount
  };
}

async function queryBadTrend(dateFrom, dateTo, lineName, granularity, stageFilter, typeFilter) {
  const m = { test_date: { $gte: dateFrom, $lte: dateTo } };
  if (lineName) m.line_name = lineName;
  const groupId = granularity === 'week'
    ? { $substr: ['$test_date', 0, 8] }
    : '$test_date';
  const extras = buildBadFilterExtras(stageFilter, typeFilter).map(c => ({ $match: prefixAi(c) }));
  // 两阶段 $group 消除 barcodes/$addToSet 大数组物化:
  // 先按 (分组键, barcode) 去重并累计该 SN 的记录数(recN)与是否闭环; 再按分组键 $sum 汇总
  //   count       = 全部记录数(去重前)  = $sum recN
  //   unique_count= 唯一 SN 数           = $sum 1
  //   closed      = 闭环 SN 数(去重,任一记录 state=20 即计为闭环)
  return await col.bad_repair.aggregate([
    { $match: prefixAi(m) },
    ...extras,
    _badAliasStage,
    { $group: { _id: { g: groupId, bc: '$barcode' }, recN: { $sum: 1 }, closed: { $max: { $eq: ['$repair_state_code', 20] } } } },
    { $group: {
      _id: '$_id.g',
      count: { $sum: '$recN' },
      unique_count: { $sum: 1 },
      closed: { $sum: { $cond: ['$closed', 1, 0] } }
    }},
    { $project: { _id: 0, date: '$_id', count: 1, unique_count: 1, closed: 1 } },
    { $sort: { date: 1 } }
  ]).toArray();
}

async function queryBadPareto(dateFrom, dateTo, lineName, groupBy, stageFilter, typeFilter) {
  const m = { test_date: { $gte: dateFrom, $lte: dateTo } };
  if (lineName) m.line_name = lineName;
  const field = groupBy === 'process' ? '$work_operation_name'
    : groupBy === 'line' ? '$line_name'
    : groupBy === 'model' ? '$product_model'
    : '$bad_items';
  const extras = buildBadFilterExtras(stageFilter, typeFilter).map(c => ({ $match: prefixAi(c) }));
  // 两阶段 $group: 先按 (field, barcode) 去重累计记录数, 再按 field 汇总
  //   count        = 全部记录数(去重前) = $sum recN
  //   unique_count = 唯一 SN 数          = $sum 1
  return await col.bad_repair.aggregate([
    { $match: prefixAi(m) },
    ...extras,
    _badAliasStage,
    { $group: { _id: { f: field, bc: '$barcode' }, recN: { $sum: 1 } } },
    { $group: { _id: '$_id.f', count: { $sum: '$recN' }, unique_count: { $sum: 1 } } },
    { $project: { _id: 0, name: '$_id', count: 1, unique_count: 1 } },
    { $sort: { count: -1 } },
    { $limit: 20 }
  ]).toArray();
}

async function queryBadSPC(dateFrom, dateTo, lineName, stageFilter, typeFilter) {
  const m = { test_date: { $gte: dateFrom, $lte: dateTo } };
  if (lineName) m.line_name = lineName;
  const extras = buildBadFilterExtras(stageFilter, typeFilter).map(c => ({ $match: prefixAi(c) }));
  // 两阶段 $group: 先按 (test_date, barcode) 去重累计记录数, 再按 test_date 汇总
  //   count      = 全部记录数(去重前) = $sum recN
  //   unique_bad = 唯一 SN 数          = $sum 1
  const badByDay = await col.bad_repair.aggregate([
    { $match: prefixAi(m) },
    ...extras,
    _badAliasStage,
    { $group: { _id: { d: '$test_date', bc: '$barcode' }, recN: { $sum: 1 } } },
    { $group: { _id: '$_id.d', count: { $sum: '$recN' }, unique_bad: { $sum: 1 } } },
    { $project: { _id: 0, date: '$_id', count: 1, unique_bad: 1 } },
    { $sort: { date: 1 } }
  ]).toArray();
  return badByDay;
}

async function queryBadCorrelation(dateFrom, dateTo, lineName, stageFilter, typeFilter) {
  const m = { test_date: { $gte: dateFrom, $lte: dateTo } };
  if (lineName) m.line_name = lineName;
  const extras = buildBadFilterExtras(stageFilter, typeFilter).map(c => ({ $match: prefixAi(c) }));
  // 合并为单个 $facet: 旧实现 3 次 Promise.all 各自 $match 同一 ai_bad_repair 范围 = 3 次全表重扫。
  // $facet 在单次扫描内并行执行 3 个子管道, 共享同一 $match 结果集, 消除重复扫描。
  // 注: repeatSN 的 defects/lines $addToSet 按 barcode 分组, 每 SN 的集合很小, 无 16MB 风险, 保留。
  const facetRes = await col.bad_repair.aggregate([
    { $match: prefixAi(m) }, ...extras, _badAliasStage,
    { $facet: {
      byHour: [
        { $addFields: { hour: { $hour: { $toDate: '$test_time' } } } },
        { $group: { _id: { hour: '$hour', defect: '$bad_items' }, count: { $sum: 1 } } },
        { $project: { _id: 0, hour: '$_id.hour', defect: '$_id.defect', count: 1 } },
        { $sort: { count: -1 } },
        { $limit: 100 }
      ],
      byLineDefect: [
        { $group: { _id: { line: '$line_name', defect: '$bad_items' }, count: { $sum: 1 } } },
        { $project: { _id: 0, line: '$_id.line', defect: '$_id.defect', count: 1 } },
        { $sort: { count: -1 } },
        { $limit: 50 }
      ],
      repeatSN: [
        { $group: { _id: '$barcode', count: { $sum: 1 }, defects: { $addToSet: '$bad_items' }, lines: { $addToSet: '$line_name' } } },
        { $match: { count: { $gte: 2 } } },
        { $project: { _id: 0, barcode: '$_id', count: 1, defects: 1, lines: 1 } },
        { $sort: { count: -1 } },
        { $limit: 30 }
      ]
    }}
  ]).toArray();
  const f = facetRes[0] || {};
  return { byHour: f.byHour || [], byLineDefect: f.byLineDefect || [], repeatSN: f.repeatSN || [] };
}

function getDb() { return db; }

// === Exceptions ===
async function getExceptions(query={}) { return stripAi(await col.exceptions.find(prefixAi(query)).sort({ai_created_at:-1}).toArray()); }
async function insertException(data) { data.created_at=Date.now(); data.status=data.status||'open'; const r=await col.exceptions.insertOne(prefixAi(data)); return r.insertedId; }
async function updateException(id, data) { const {ObjectId}=require('mongodb'); await col.exceptions.updateOne({_id:new ObjectId(id)},{$set:{...cleanForSet(data),ai_updated_at:Date.now()}}); }
async function deleteException(id) { const {ObjectId}=require('mongodb'); await col.exceptions.deleteOne({_id:new ObjectId(id)}); }

// === Action Items ===
async function getActionItems(query={}) { return stripAi(await col.action_items.find(prefixAi(query)).sort({ai_created_at:-1}).toArray()); }
async function insertActionItem(data) { data.created_at=Date.now(); data.status=data.status||'pending'; const r=await col.action_items.insertOne(prefixAi(data)); return r.insertedId; }
async function updateActionItem(id, data) { const {ObjectId}=require('mongodb'); await col.action_items.updateOne({_id:new ObjectId(id)},{$set:{...cleanForSet(data),ai_updated_at:Date.now()}}); }
async function deleteActionItem(id) { const {ObjectId}=require('mongodb'); await col.action_items.deleteOne({_id:new ObjectId(id)}); }

// === Attendance ===
async function getAttendance(query={}) { return stripAi(await col.attendance.find(prefixAi(query)).sort({ai_date:-1}).toArray()); }
async function insertAttendance(data) { data.created_at=Date.now(); const r=await col.attendance.insertOne(prefixAi(data)); return r.insertedId; }
async function updateAttendance(id, data) { const {ObjectId}=require('mongodb'); await col.attendance.updateOne({_id:new ObjectId(id)},{$set:{...cleanForSet(data),ai_updated_at:Date.now()}}); }
async function deleteAttendance(id) { const {ObjectId}=require('mongodb'); await col.attendance.deleteOne({_id:new ObjectId(id)}); }

// === Maintenance ===
async function getMaintenance(query={}) { return stripAi(await col.maintenance.find(prefixAi(query)).sort({ai_date:-1}).toArray()); }
async function insertMaintenance(data) { data.created_at=Date.now(); data.status=data.status||'pending'; const r=await col.maintenance.insertOne(prefixAi(data)); return r.insertedId; }
async function updateMaintenance(id, data) { const {ObjectId}=require('mongodb'); await col.maintenance.updateOne({_id:new ObjectId(id)},{$set:{...cleanForSet(data),ai_updated_at:Date.now()}}); }
async function deleteMaintenance(id) { const {ObjectId}=require('mongodb'); await col.maintenance.deleteOne({_id:new ObjectId(id)}); }

// === Incoming Inspection ===
async function getInspection(query={}) { return stripAi(await col.inspection.find(prefixAi(query)).sort({ai_date:-1}).toArray()); }
async function insertInspection(data) { data.created_at=Date.now(); const r=await col.inspection.insertOne(prefixAi(data)); return r.insertedId; }
async function updateInspection(id, data) { const {ObjectId}=require('mongodb'); await col.inspection.updateOne({_id:new ObjectId(id)},{$set:{...cleanForSet(data),ai_updated_at:Date.now()}}); }
async function deleteInspection(id) { const {ObjectId}=require('mongodb'); await col.inspection.deleteOne({_id:new ObjectId(id)}); }

// === Production Plan ===
async function getProductionPlan(query={}) { return stripAi(await col.production_plan.find(prefixAi(query)).sort({ai_date:-1}).toArray()); }
async function insertProductionPlan(data) { data.created_at=Date.now(); const r=await col.production_plan.insertOne(prefixAi(data)); return r.insertedId; }
async function updateProductionPlan(id, data) { const {ObjectId}=require('mongodb'); await col.production_plan.updateOne({_id:new ObjectId(id)},{$set:{...cleanForSet(data),ai_updated_at:Date.now()}}); }
async function deleteProductionPlan(id) { const {ObjectId}=require('mongodb'); await col.production_plan.deleteOne({_id:new ObjectId(id)}); }

// === Fixture Life (治具寿命·过站反推) ===
// 治具台账(ai_fixture)本地建,MES 无此接口。
// 当前次数 = 该治具绑定工序在 [启用日, 停用日] 区间的过站记录数(production.work_operation_code 聚合)。
// 注:同工序多治具轮流使用时,启用/停用区间不应重叠,否则反推会重复计数(admin 录入时提示)。
async function getFixtures(query={}) { return stripAi(await col.fixture.find(prefixAi(query)).sort({ai_line_name:1, ai_work_operation_code:1, ai_install_date:1}).toArray()); }
async function insertFixture(data) { data.created_at=Date.now(); data.updated_at=Date.now(); const r=await col.fixture.insertOne(prefixAi(data)); return r.insertedId; }
async function updateFixture(id, data) { const {ObjectId}=require('mongodb'); await col.fixture.updateOne({_id:new ObjectId(id)},{$set:{...cleanForSet(data),ai_updated_at:Date.now()}}); }
async function deleteFixture(id) { const {ObjectId}=require('mongodb'); await col.fixture.deleteOne({_id:new ObjectId(id)}); }

async function _fixtureUsedCount(f, effEnd) {
  // 有效截止日: 优先 retire_date, 否则用调用方推断的同线同工序下一治具 install_date(effEnd),
  // 避免仍标记在用(无 retire_date)的治具把后续治具过站也计入导致重复计数
  const end = effEnd || f.retire_date;
  const m = { work_operation_code: f.work_operation_code, move_out_date: { $gte: f.install_date } };
  if (end) m.move_out_date.$lte = end;
  if (f.line_name) m.line_name = f.line_name;
  return await col.production.countDocuments(prefixAi(m));
}

// 批量预计算所有治具/线材的过站计数(单次 $group), 替代逐条 countDocuments 的 N+1 循环。
// 返回 { [fixtureKey]: count }, key = work_operation_code|line_name|install_date|end
async function _batchUsedCounts(items, getEnd) {
  if (!items.length) return {};
  // 单聚合: 按 (work_operation_code, line_name) 分组, 日期区间用 $cond 处理每条的 install/end 不同。
  // 因日期区间因条目而异, 无法一次 $group 完成 — 改为按 (code,line) 聚合每日计数, 在 JS 侧按各条区间累加。
  // 这样 1 次往返即得所有 (code,line,date) 计数, 替代 N 次 countDocuments。
  const needKeys = new Set();
  items.forEach(f => {
    if (!f.work_operation_code) return;
    needKeys.add(JSON.stringify({c:f.work_operation_code, l:f.line_name||''}));
  });
  // 求整体最早 install_date 作 $match 下限, 缩小扫描
  const minInstall = items.reduce((mn,f)=> f.install_date && (!mn || f.install_date < mn) ? f.install_date : mn, null);
  const match = { work_operation_code: { $in: [...new Set(items.map(f=>f.work_operation_code).filter(Boolean))] } };
  if (minInstall) match.move_out_date = { $gte: minInstall };
  // 仍需按 line_name 限定(避免跨线同 code 混入); 聚合按 code+line 分组
  const lines = [...new Set(items.map(f=>f.line_name).filter(Boolean))];
  if (lines.length && lines.length < 50) match.line_name = { $in: lines };
  const daily = await col.production.aggregate([
    { $match: prefixAi(match) },
    { $group: { _id: { code: '$ai_work_operation_code', line: '$ai_line_name', date: '$ai_move_out_date' }, cnt: { $sum: 1 } } }
  ]).toArray();
  // 建索引: code|line -> [{date,cnt}]
  const idx = {};
  daily.forEach(d => {
    const k = d._id.code + '|' + (d._id.line||'');
    (idx[k] = idx[k] || []).push({ date: d._id.date, cnt: d.cnt });
  });
  const out = {};
  for (const f of items) {
    if (!f.work_operation_code) { out[f._id] = 0; continue; }
    const end = getEnd(f);
    const rows = idx[f.work_operation_code + '|' + (f.line_name||'')] || [];
    let used = 0;
    for (const r of rows) {
      if (r.date < f.install_date) continue;
      if (end && r.date > end) continue;
      used += r.cnt;
    }
    out[f._id] = used;
  }
  return out;
}

// 占位未来日期规范化: install_date 超 today+90day(如 2099-12-31 台账未启用占位符)置空, 仅清洗展示用值
// 计算用真值(过站反推/effEndDate)不受影响, 仍传原始 install_date
function _sanitizeInstallDate(d) {
  if (!d) return '';
  const t = new Date(d).getTime();
  if (isNaN(t)) return '';
  if (t > Date.now() + 90 * 24 * 3600 * 1000) return '';
  return d;
}

async function queryFixtures(lineName) {
  const q = {};
  if (lineName) q.line_name = lineName;
  const fixtures = stripAi(await col.fixture.find(prefixAi(q)).sort({ai_line_name:1, ai_work_operation_code:1, ai_install_date:1}).toArray());
  // 占位未来日期(2099-12-3x 等台账未启用默认值)规范化: 仅清洗输出展示, 不改计算用真值
  // install_date 超 today+90day 视为占位符置空, 前端显示'--'(计算 effEndDate/usedMap 仍用原始 f.install_date)
  // 推断有效截止日: 无 retire_date 时取同线同工序、install_date 更晚的最近一支治具的 install_date,
  // 避免仍标记在用(无 retire_date)的治具把后续治具的过站也计入造成重复计数(治具应按时序轮流不重叠)
  const effEndDate = (f) => {
    if (f.retire_date) return f.retire_date;
    const peers = fixtures.filter(x => x !== f && x.line_name === f.line_name && x.work_operation_code === f.work_operation_code && x.install_date && x.install_date > f.install_date);
    return peers.length ? peers.reduce((mn, x) => x.install_date < mn ? x.install_date : mn, peers[0].install_date) : null;
  };
  // 批量预计算所有治具过站数(单聚合, 替代 N+1 countDocuments 循环) — op级, 用于有 work_operation_code 的治具
  const usedMap = await _batchUsedCounts(fixtures, f => f.retire_date || effEndDate(f));
  // EDO治具(无 work_operation_code, 有 match_product_model): 按机型集合反推(与线材同模型, 均摊估算)
  const fxGroups = new Map();
  for (const f of fixtures) {
    if (f.work_operation_code || !f.match_product_model) continue;
    if (!fxGroups.has(f.match_product_model)) fxGroups.set(f.match_product_model, { items: [], minInstall: null });
    const g = fxGroups.get(f.match_product_model);
    g.items.push(f);
    if (f.install_date && (!g.minInstall || f.install_date < g.minInstall)) g.minInstall = f.install_date;
  }
  const fxColl = {};
  const fxInternals = [...fxGroups.keys()];
  if (fxInternals.length) {
    const minDate = [...fxGroups.values()].reduce((mn,g)=> g.minInstall && (!mn||g.minInstall<mn)?g.minInstall:mn, null);
    const rows = await col.production.aggregate([
      { $match: prefixAi({ product_model: { $in: fxInternals }, ...(minDate ? { move_out_date: { $gte: minDate } } : {}) }) },
      { $group: { _id: '$ai_product_model', n: { $sum: 1 } } }
    ]).toArray();
    for (const r of rows) fxColl[r._id] = r.n;
  }
  const result = [];
  for (const f of fixtures) {
    const effEnd = effEndDate(f);
    const design = f.design_life || 0;
    const warnRatio = f.warn_ratio != null ? f.warn_ratio : 0.8;
    const scrapRatio = f.scrap_ratio != null ? f.scrap_ratio : 1.0;
    let used = null, level = 'untracked', usageSource = null, groupInternal = '', groupCount = 1, groupColl = 0;
    const hasEdo = f.edo_remaining != null && design > 0;
    // 客户页单根用量: EDO剩余次数(精确) 或 op级反推(精确, 手工绑定治具); 否则不展示估算(未纳入次数管控)
    // 集体过站(groupColl)仍为真值见分组视图; 均摊仅 admin 对账内部
    if (hasEdo) {
      used = Math.max(0, design - f.edo_remaining); usageSource = f.edo_assumed ? 'assumed' : 'edo';  // 钳制: EDO剩余>设计不显负; assumed=无EDO真值假定新
    } else if (f.work_operation_code) {
    } else if (f.work_operation_code) {
      used = usedMap[f._id] != null ? usedMap[f._id] : await _fixtureUsedCount(f, effEnd); usageSource = 'op';
    } else if (f.match_product_model) {
      const g = fxGroups.get(f.match_product_model);
      groupColl = fxColl[f.match_product_model] || 0;
      groupCount = g ? g.items.length : 1;
      groupInternal = f.match_product_model;
    }
    const progress = (usageSource && design > 0) ? used / design : 0;
    // level 用 raw progress 判定(不取整), 仅展示用 toFixed(3); 避免 toFixed 进位(0.9999→1.000)致边界项误归 danger
    if (usageSource) {
      level = 'ok';
      if (progress >= scrapRatio) level = 'danger';
      else if (progress >= warnRatio) level = 'warning';
    }
    // PING针/探针寿命(绑定治具本体, 用量沿用治具过站次数; ping_life=design/5, PING针到寿换针不换治具)
    // ping进度用"当前针套"(used % ping_life, 换针归零), 0-100%; 累计换针次数 = used/ping_life 取整
    const pingLife = f.ping_life || 0;
    const pingUsedCum = (usageSource && pingLife > 0) ? used : null;
    const pingUsed = (pingUsedCum != null) ? (pingUsedCum % pingLife) : null;
    const pingProgress = (pingUsed != null && pingLife > 0) ? pingUsed / pingLife : 0;
    let pingLevel = null;
    if (pingUsed != null) {
      pingLevel = 'ok';
      if (pingProgress >= scrapRatio) pingLevel = 'danger';
      else if (pingProgress >= warnRatio) pingLevel = 'warning';
      // 治具整体level = 本体与PING针更差者(PING针到寿也触发预警/报废, 提示换针)
      if (pingLevel === 'danger') level = 'danger';
      else if (pingLevel === 'warning' && level !== 'danger') level = 'warning';
    }
    const confirmed = ['exact','explicit'].includes(f.match_confidence);  // admin内部: 模糊匹配标待确认
    result.push({
      _id: f._id, code: f.code, name: f.name, type: f.type,
      product_model: f.product_model, match_product_model: f.match_product_model || '',
      match_confidence: f.match_confidence || '', confirmed,
      line_name: f.line_name, work_operation_code: f.work_operation_code || '',
      install_date: _sanitizeInstallDate(f.install_date), retire_date: f.retire_date || '', effective_end_date: effEnd || '',
      design_life: design, warn_ratio: warnRatio, scrap_ratio: scrapRatio,
      status: f.edo_status || f.status || (f.match_product_model || f.work_operation_code || hasEdo ? '在用' : '在册'),
      keeper: f.keeper || '', storage: f.storage || '',
      used_count: used, remaining: hasEdo ? Math.min(f.edo_remaining, design) : (usageSource ? Math.max(0, design - used) : null),
      progress: +progress.toFixed(3), warn_at: Math.floor(design * warnRatio), scrap_at: Math.floor(design * scrapRatio),
      level, usage_source: usageSource,
      ping_life: pingLife || null, ping_used: pingUsed, ping_progress: pingUsed!=null ? +pingProgress.toFixed(3) : null, ping_level: pingLevel,
      group_internal: groupInternal, group_count: groupCount, group_collective: groupColl,
      edo_remaining: f.edo_remaining != null ? f.edo_remaining : null,
      source: f.source || '',
      // 报废闭环字段(从 ai_fixture.scrap 子文档读; 无则 null, 不编造)
      scrap: f.scrap && typeof f.scrap === 'object' ? {
        status: f.scrap.status || '', scrap_date: f.scrap.scrap_date || '',
        reason: f.scrap.reason || '', operator: f.scrap.operator || '',
        replacement_code: f.scrap.replacement_code || ''
      } : null
    });
  }
  return result;
}

// === 治具+线材 报废统计 (真实聚合 ai_fixture.scrap + ai_aging_cable.scrap, 不编数据) ===
// 已报废: scrap.status==='scrapped' (admin 录入报废单时写入); 否则不计入
async function queryScrapStats(lineName) {
  const fixtures = await queryFixtures(lineName);
  const cables = await queryAgingCables(lineName);
  const all = fixtures.concat(cables);
  const scrapped = all.filter(x => x.scrap && x.scrap.status === 'scrapped');
  // 本月: scrap_date 落在当前自然月(YYYY-MM-DD 解析, 本地时区)
  const now = new Date();
  const ym = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  const thisMonth = scrapped.filter(x => {
    const d = x.scrap.scrap_date || '';
    return d.startsWith(ym);
  });
  const withReplacement = scrapped.filter(x => x.scrap.replacement_code).length;
  const recent = scrapped
    .slice()
    .sort((a, b) => (b.scrap.scrap_date || '').localeCompare(a.scrap.scrap_date || ''))
    .slice(0, 10)
    .map(x => ({
      code: x.code, name: x.name,
      scrap_date: x.scrap.scrap_date, replacement_code: x.scrap.replacement_code
    }));
  // 待报废: 接近/达到报废阈值(level==='danger')且尚未报废的件
  const pendingScrap = all.filter(x => (!x.scrap || x.scrap.status !== 'scrapped') && x.level === 'danger').length;
  return {
    total_scrapped: scrapped.length,
    this_month_scrapped: thisMonth.length,
    with_replacement: withReplacement,
    pending_scrap: pendingScrap,
    recent
  };
}

// === Aging Cable (老化线材·过站反推时长) ===
// 累计通电时长 = 老化工序过站次数 × 台账填的单次老化时长(分钟) / 60
async function getAgingCables(query={}) { return stripAi(await col.aging_cable.find(prefixAi(query)).sort({ai_line_name:1, ai_install_date:1}).toArray()); }
async function insertAgingCable(data) { data.created_at=Date.now(); data.updated_at=Date.now(); const r=await col.aging_cable.insertOne(prefixAi(data)); return r.insertedId; }
async function updateAgingCable(id, data) { const {ObjectId}=require('mongodb'); await col.aging_cable.updateOne({_id:new ObjectId(id)},{$set:{...cleanForSet(data),ai_updated_at:Date.now()}}); }
async function deleteAgingCable(id) { const {ObjectId}=require('mongodb'); await col.aging_cable.deleteOne({_id:new ObjectId(id)}); }

async function queryAgingCables(lineName) {
  const q = {};
  if (lineName) q.line_name = lineName;
  const cables = stripAi(await col.aging_cable.find(prefixAi(q)).sort({ai_line_name:1, ai_product_model:1, ai_install_date:1}).toArray());
  if (!cables.length) return [];
  // 按 match_product_model(内部料号) 分组做集合反推; 无 match_product_model=未在产(台账only)
  // 修掉旧逻辑 50× 重复计数 bug: 旧逻辑每根各自 countDocuments(work_operation_code), 共一工序则 N× 重复
  const groups = new Map();
  for (const c of cables) {
    const key = c.match_product_model;
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, { cables: [], minInstall: null });
    const g = groups.get(key);
    g.cables.push(c);
    if (c.install_date && (!g.minInstall || c.install_date < g.minInstall)) g.minInstall = c.install_date;
  }
  // 单聚合: 按内部料号统计自各组最早启用日至今的过站数(真值)
  const usedByInternal = {};
  const internals = [...groups.keys()];
  if (internals.length) {
    const minDate = [...groups.values()].reduce((mn,g)=> g.minInstall && (!mn||g.minInstall<mn)?g.minInstall:mn, null);
    const rows = await col.production.aggregate([
      { $match: prefixAi({ product_model: { $in: internals }, ...(minDate ? { move_out_date: { $gte: minDate } } : {}) }) },
      { $group: { _id: '$ai_product_model', n: { $sum: 1 } } }
    ]).toArray();
    for (const r of rows) usedByInternal[r._id] = r.n;
  }
  const result = [];
  for (const c of cables) {
    const key = c.match_product_model;
    const g = key ? groups.get(key) : null;
    const collective = key ? (usedByInternal[key] || 0) : 0;     // 集合过站(真值)
    const groupCount = g ? g.cables.length : 1;
    const designLife = c.design_life || 0;
    const warnRatio = c.warn_ratio != null ? c.warn_ratio : 0.8;
    const scrapRatio = c.scrap_ratio != null ? c.scrap_ratio : 1.0;
    const mapped = !!key;
    const hasEdo = c.edo_remaining != null && designLife > 0;
    // 客户页用量只取 EDO 剩余次数(精确, 可对账 EDO); 非 EDO 不展示估算(标"未纳入次数管控")
    // 集体过站(group_collective)仍为真值, 见分组视图; 单根均摊仅 admin 对账内部用(queryAgingCableReconcile)
    let usedCount = null, usageSource = null;
    if (hasEdo) { usedCount = Math.max(0, designLife - c.edo_remaining); usageSource = c.edo_assumed ? 'assumed' : 'edo'; }  // 钳制: EDO剩余>设计时不显负用量; assumed=无EDO真值假定新
    const remaining = hasEdo ? Math.min(c.edo_remaining, designLife) : null;
    const progress = hasEdo && designLife > 0 ? usedCount / designLife : 0;
    let level = 'untracked';  // 未纳入次数管控
    // level 用 raw progress 判定(不取整), 仅展示用 toFixed(3); 与 queryFixtures 同口径
    if (hasEdo) {
      level = 'ok';
      if (progress >= scrapRatio) level = 'danger';
      else if (progress >= warnRatio) level = 'warning';
    }
    const confirmed = ['exact','explicit'].includes(c.match_confidence);  // admin内部: 模糊匹配标待确认
    result.push({
      _id: c._id, code: c.code, name: c.name, spec: c.spec,
      product_model: c.product_model, cable_type: c.cable_type,
      line_name: c.line_name || '', match_product_model: key || '', match_confidence: c.match_confidence || '',
      confirmed,
      install_date: _sanitizeInstallDate(c.install_date || ''), retire_date: c.retire_date || '',
      design_life: designLife, warn_ratio: warnRatio, scrap_ratio: scrapRatio,
      status: c.edo_status || (mapped || hasEdo ? '在用' : '备用'),
      keeper: c.keeper || '', storage: c.storage || '',
      used_count: usedCount, remaining, progress: +progress.toFixed(3),
      warn_at: Math.floor(designLife * warnRatio), scrap_at: Math.floor(designLife * scrapRatio),
      level, usage_source: usageSource,
      group_internal: key || '', group_count: groupCount, group_collective: collective,
      edo_remaining: c.edo_remaining != null ? c.edo_remaining : null,
      scrap: c.scrap && typeof c.scrap === 'object' ? {
        status: c.scrap.status || '', scrap_date: c.scrap.scrap_date || '',
        reason: c.scrap.reason || '', operator: c.scrap.operator || '',
        replacement_code: c.scrap.replacement_code || ''
      } : null,
      source: c.source || 'edo'
    });
  }
  return result;
}

// 线材组集合寿命(真值): 按 match_product_model 分组 — 集体过站/设计总次数/进度, 焦点卡主指标
async function queryAgingCableGroups(lineName) {
  const cables = await queryAgingCables(lineName);
  const byInternal = new Map();
  for (const c of cables) {
    if (!c.match_product_model) continue;
    if (!byInternal.has(c.match_product_model)) {
      byInternal.set(c.match_product_model, { internal: c.match_product_model, product_model: c.product_model, line_name: c.line_name, cables: [] });
    }
    byInternal.get(c.match_product_model).cables.push(c);
  }
  const groups = [];
  for (const g of byInternal.values()) {
    const collective = g.cables[0] ? g.cables[0].group_collective : 0;
    const designTotal = g.cables.reduce((s,c)=> s + (c.design_life||0), 0);
    const progress = designTotal > 0 ? collective / designTotal : 0;
    let level = 'ok';
    if (progress >= 1.0) level = 'danger';
    else if (progress >= 0.8) level = 'warning';
    const earliest = g.cables.reduce((mn,c)=> c.install_date && (!mn||c.install_date<mn)?c.install_date:mn, '');
    groups.push({
      internal: g.internal, product_model: g.product_model, line_name: g.line_name,
      cable_count: g.cables.length, collective_used: collective,
      design_total: designTotal, progress: +progress.toFixed(3),
      per_cable: g.cables.length ? Math.round(collective / g.cables.length) : 0,
      warn_count: g.cables.filter(c=>c.level==='warning').length,
      danger_count: g.cables.filter(c=>c.level==='danger').length,
      level, keeper: g.cables[0] ? g.cables[0].keeper : '', install_date: earliest
    });
  }
  groups.sort((a,b)=> b.collective_used - a.collective_used);
  return groups;
}

// 对账(admin内部QA, 不上客户页): 反推均摊 vs EDO自带剩余次数
async function queryAgingCableReconcile(lineName) {
  const cables = await queryAgingCables(lineName);
  const withRem = cables.filter(c => c.match_product_model && c.edo_remaining != null && c.design_life > 0);
  let sumReverse = 0, sumEdo = 0;
  const rows = withRem.map(c => {
    const edoUsed = c.design_life - c.edo_remaining;
    sumReverse += c.used_count; sumEdo += edoUsed;
    return { code: c.code, product_model: c.product_model, design_life: c.design_life,
             edo_remaining: c.edo_remaining, edo_used: edoUsed, reverse_used: c.used_count,
             diff: c.used_count - edoUsed };
  });
  return { rows, count: withRem.length, sum_reverse: sumReverse, sum_edo: sumEdo,
           diff_ratio: sumEdo > 0 ? +((sumReverse - sumEdo) / sumEdo).toFixed(3) : null };
}

// === Overview (焦点卡聚合) ===
async function queryFixtureOverview(lineName) {
  const fixtures = await queryFixtures(lineName);
  const cables = await queryAgingCables(lineName);
  const fw = fixtures.filter(f=>f.level==='warning').length;
  const fd = fixtures.filter(f=>f.level==='danger').length;
  const cw = cables.filter(c=>c.level==='warning').length;
  const cd = cables.filter(c=>c.level==='danger').length;
  const fxTracked = fixtures.filter(f=>f.usage_source).length;  // 已纳入次数管控(EDO/op)
  const cbTracked = cables.filter(c=>c.usage_source).length;
  const trackedTotal = fxTracked + cbTracked;
  // 拆 EDO真值 vs 假定新(无EDO数据按新处理): 口径清晰, 防误认为全真值
  const edoTrue = fixtures.filter(f=>f.usage_source==='edo').length + cables.filter(c=>c.usage_source==='edo').length;
  const assumed = cables.filter(c=>c.usage_source==='assumed').length;  // 治具无assumed
  // 健康度只基于 EDO 真值资产(有真实磨损); 假定新(progress 0, 无真实磨损)不参与, 避免稀释健康度
  const score = edoTrue > 0 ? Math.max(0, 1 - (fd + cd + (fw + cw) * 0.5) / edoTrue) : null;
  // 报废闭环(真实计数, 不编数据): 已报废件 + 本月报废 + 待报废(danger 阈值)
  const scrapped = fixtures.filter(f => f.scrap && f.scrap.status === 'scrapped').length;
  const now = new Date();
  const ym = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  const thisMonthScrap = fixtures.filter(f => f.scrap && f.scrap.status === 'scrapped' && (f.scrap.scrap_date || '').startsWith(ym)).length;
  return {
    fixture: { total: fixtures.length, tracked: fxTracked, warn: fw, danger: fd, scrapped, this_month_scrapped: thisMonthScrap },
    cable: { total: cables.length, tracked: cbTracked, warn: cw, danger: cd },
    tracked_total: trackedTotal, edo_true: edoTrue, assumed,
    alert_count: fw + fd + cw + cd,
    health_score: score == null ? null : +(score * 100).toFixed(1)
  };
}

// === 不良×治具关联分析 (审核亮点:治具老化是否推高不良) ===
// 散点: X=治具寿命进度, Y=该治具使用区间内绑定工序的不良率。证明"治具老化→不良上升"闭环。
async function queryFixtureBadCorrelation(lineName) {
  // 用 60s 缓存的 getWorkOperations() 替代裸 find, 避免每次调用都全表扫描 ai_work_operations
  const opDocs = await getWorkOperations();
  const codeToName = {};
  opDocs.forEach(o => { if (o.code) codeToName[o.code] = o.name; });
  const fixtures = await queryFixtures(lineName);
  // 批量预取各 (work_operation_name, date) 不良计数, 替代逐治具 countDocuments N+1
  const candidates = fixtures.filter(f => f.work_operation_code && f.design_life && codeToName[f.work_operation_code]);
  const opNames = [...new Set(candidates.map(f => codeToName[f.work_operation_code]))];
  const minInstall = candidates.reduce((mn,f)=> f.install_date && (!mn || f.install_date < mn) ? f.install_date : mn, null);
  const badIdx = {}; // opName|date -> count
  if (opNames.length && minInstall) {
    const badDaily = await col.bad_repair.aggregate([
      { $match: prefixAi({ work_operation_name: { $in: opNames }, test_date: { $gte: minInstall } }) },
      { $group: { _id: { op: '$ai_work_operation_name', date: '$ai_test_date' }, cnt: { $sum: 1 } } }
    ]).toArray();
    badDaily.forEach(d => { badIdx[d._id.op + '|' + d._id.date] = d.cnt; });
  }
  const points = [];
  for (const f of candidates) {
    const opName = codeToName[f.work_operation_code];
    const output = f.used_count;
    let bad = 0;
    if (opName) {
      // 用预取索引按 f 区间累加; 索引缺失则回退单查
      const rows = Object.keys(badIdx).filter(k => k.startsWith(opName + '|'));
      if (rows.length) {
        for (const k of rows) {
          const date = k.split('|').slice(1).join('|');
          if (date < f.install_date) continue;
          if (f.retire_date && date > f.retire_date) continue;
          bad += badIdx[k];
        }
      } else {
        const bm = { work_operation_name: opName, test_date: { $gte: f.install_date } };
        if (f.retire_date) bm.test_date.$lte = f.retire_date;
        if (f.line_name) bm.line_name = f.line_name;
        bad = await col.bad_repair.countDocuments(prefixAi(bm));
      }
    }
    points.push({
      code: f.code, name: f.name, op: opName || f.work_operation_code, line: f.line_name,
      progress: f.progress, used: f.used_count, design: f.design_life, level: f.level,
      output, bad, bad_rate: output > 0 ? +((bad / output) * 100).toFixed(2) : 0
    });
  }
  return points;
}

// 3 级下钻 L3 明细:产量 SN 流水(按日/线/时 去重 SN)
async function queryOutputSns(dateFrom, dateTo, lineName, hour, opts={}) {
  const m = { move_out_date: { $gte: dateFrom, $lte: dateTo }, barcode: { $nin: [null, ''] } };
  if (lineName) m.line_name = lineName;
  if (hour != null && hour !== '') m.hour = +hour;
  // 分页(可选): opts.page/opts.pageSize → {items,total}; 不传则保留原 $limit:500 数组(向后兼容)
  if (opts.page != null) {
    const pageSize = Math.min(Math.max(parseInt(opts.pageSize, 10) || 50, 1), 500);
    const page = Math.max(parseInt(opts.page, 10) || 1, 1);
    const facet = [
      { $match: prefixAi(m) },
      { $group: { _id: { sn: '$ai_barcode', line: '$ai_line_name' }, first_time: { $min: '$ai_move_out_time' }, last_time: { $max: '$ai_move_out_time' }, model: { $first: '$ai_product_model' } } },
      { $sort: { first_time: -1 } },
      { $facet: {
          metadata: [ { $count: 'total' } ],
          items: [ { $skip: (page - 1) * pageSize }, { $limit: pageSize },
            { $project: { _id: 0, barcode: '$_id.sn', line_name: '$_id.line', product_model: '$model', first_time: 1, last_time: 1 } } ]
        } }
    ];
    const out = await col.production.aggregate(facet).toArray();
    const total = (out[0] && out[0].metadata && out[0].metadata[0]) ? out[0].metadata[0].total : 0;
    const items = (out[0] && out[0].items) ? out[0].items : [];
    return { items, total, page, pageSize };
  }
  return await col.production.aggregate([
    { $match: prefixAi(m) },
    { $group: { _id: { sn: '$ai_barcode', line: '$ai_line_name' }, first_time: { $min: '$ai_move_out_time' }, last_time: { $max: '$ai_move_out_time' }, model: { $first: '$ai_product_model' } } },
    { $sort: { first_time: -1 } },
    { $limit: 500 },
    { $project: { _id: 0, barcode: '$_id.sn', line_name: '$_id.line', product_model: '$model', first_time: 1, last_time: 1 } }
  ]).toArray();
}

// 3 级下钻 L3 明细:某 SN 全程过站轨迹
async function querySnTrace(barcode) {
  if (!barcode) return [];
  return stripAi(await col.production.find(prefixAi({ barcode }), { projection: prefixAi({ _id: 0, id: 0, synced_at: 0, source: 0 }) }).sort({ ai_move_out_time: 1 }).toArray());
}

// 3 级下钻 L3 明细:返工记录(repair_total>1)
async function queryReworkRecords(dateFrom, dateTo, lineName, opts={}) {
  // repair_total 历史可能存成字符串,用 $convert 统一转 double 防类型坑(同 computeQuality 口径)
  const m = {};
  if (dateFrom && dateTo) m.test_date = { $gte: dateFrom, $lte: dateTo };
  if (lineName) m.line_name = lineName;
  // 分页(可选): opts.page/opts.pageSize → {items,total}; 不传则保留原 $limit:500 数组(向后兼容)
  if (opts.page != null) {
    const pageSize = Math.min(Math.max(parseInt(opts.pageSize, 10) || 50, 1), 500);
    const page = Math.max(parseInt(opts.page, 10) || 1, 1);
    const out = await col.repair_report.aggregate([
      { $match: prefixAi(m) },
      { $addFields: { _rt_num: { $convert: { input: '$ai_repair_total', to: 'double', onError: 0, onNull: 0 } } } },
      { $match: { _rt_num: { $gt: 1 } } },
      { $sort: { _rt_num: -1 } },
      { $facet: {
          metadata: [ { $count: 'total' } ],
          items: [ { $skip: (page - 1) * pageSize }, { $limit: pageSize }, { $project: { _id: 0, _rt_num: 0 } } ]
        } }
    ]).toArray();
    const total = (out[0] && out[0].metadata && out[0].metadata[0]) ? out[0].metadata[0].total : 0;
    const items = (out[0] && out[0].items) ? out[0].items : [];
    return { items, total, page, pageSize };
  }
  return await col.repair_report.aggregate([
    { $match: prefixAi(m) },
    { $addFields: { _rt_num: { $convert: { input: '$ai_repair_total', to: 'double', onError: 0, onNull: 0 } } } },
    { $match: { _rt_num: { $gt: 1 } } },
    { $sort: { _rt_num: -1 } },
    { $limit: 500 },
    { $project: { _id: 0, _rt_num: 0 } }
  ]).toArray();
}

// === 班次维度下钻 (T8) ===
// 按班次聚合不良数: 用 ai_shift_config 班次时段(start/end 本地hhmm) 把每条 bad_repair 的本地 test_time 小时映射到班次
// 口径: count=该班次 bad_repair 记录数; rate=该班次 count / 总 count (占比 %), 与产量分母解耦避免双重计数歧义
// 本地小时取 new Date(test_time).getHours() — 与 production.hour 口径一致 (服务器本地时区)
// 跨天班次 (end<=start, 如夜班 20:00-08:00) 落到两段 [sMin,1440) ∪ [0,eMin) 判定
async function queryBadByShift(dateFrom, dateTo, lineName) {
  const m = { test_date: { $gte: dateFrom, $lte: dateTo } };
  if (lineName) m.line_name = lineName;
  // 只取映射所需字段, 减少内存
  const rows = stripAi(await col.bad_repair.find(prefixAi(m), { projection: prefixAi({ _id: 0, test_time: 1 }) }).toArray());
  // 班次配置: 优先 line 专属, 退回全局(line_name==null)
  const shiftConfig = await getShiftConfig(lineName || null);
  const shifts = (shiftConfig && Array.isArray(shiftConfig.shifts)) ? shiftConfig.shifts : [];
  // 构造班次时段 (本地分钟窗口); 跨天拆两段
  const buckets = shifts.map(s => {
    const name = (s && s.name) || '未命名班次';
    const sMin = _hhmmToMin(s && s.start), eMin = _hhmmToMin(s && s.end);
    if (sMin === null || eMin === null) return { name, spans: null };
    const spans = (eMin > sMin) ? [[sMin, eMin]] : [[sMin, 24*60], [0, eMin]];
    return { name, spans };
  });
  const counts = {};
  let total = 0;
  for (const r of rows) {
    let localMin = -1;
    if (r.test_time) {
      const d = new Date(r.test_time);
      if (!isNaN(d.getTime())) localMin = d.getHours()*60 + d.getMinutes();
    }
    const name = _matchShift(buckets, localMin);
    counts[name] = (counts[name] || 0) + 1;
    total++;
  }
  const data = Object.keys(counts).map(name => ({
    shift: name,
    count: counts[name],
    rate: total > 0 ? +((counts[name] / total) * 100).toFixed(2) : 0
  })).sort((a, b) => b.count - a.count);
  return { data, total };
}

// 按班次聚合产量 (去重SN, 与 queryProductionByHour/ByLine 口径一致)
// 用 production.hour (本地0-23) 映射到班次时段; 同一SN同班次多道工序只算1
async function queryOutputByShift(dateFrom, dateTo, lineName) {
  const m = { move_out_date: { $gte: dateFrom, $lte: dateTo }, barcode: { $nin: [null, ''] } };
  if (lineName) m.line_name = lineName;
  // 聚合 (shift_bucket, sn) 去重: hour 精度映射班次, 同SN同班次多工序归1
  const rows = await col.production.aggregate([
    { $match: prefixAi(m) },
    { $group: { _id: { hour: '$ai_hour', sn: '$ai_barcode' } } },
    { $project: { _id: 0, hour: '$_id.hour' } }
  ]).toArray();
  const shiftConfig = await getShiftConfig(lineName || null);
  const shifts = (shiftConfig && Array.isArray(shiftConfig.shifts)) ? shiftConfig.shifts : [];
  const buckets = shifts.map(s => {
    const name = (s && s.name) || '未命名班次';
    const sMin = _hhmmToMin(s && s.start), eMin = _hhmmToMin(s && s.end);
    if (sMin === null || eMin === null) return { name, spans: null };
    const spans = (eMin > sMin) ? [[sMin, eMin]] : [[sMin, 24*60], [0, eMin]];
    return { name, spans };
  });
  const counts = {};
  let total = 0;
  for (const r of rows) {
    // hour 精度: 分钟按 0 处理 (hour 字段本身无分钟), 用每小时中点 (h*60+30) 提升边界命中鲁棒性
    const localMin = (typeof r.hour === 'number' && !isNaN(r.hour)) ? r.hour*60 + 30 : -1;
    const name = _matchShift(buckets, localMin);
    counts[name] = (counts[name] || 0) + 1;
    total++;
  }
  const data = Object.keys(counts).map(name => ({
    shift: name,
    count: counts[name],
    rate: total > 0 ? +((counts[name] / total) * 100).toFixed(2) : 0
  })).sort((a, b) => b.count - a.count);
  return { data, total };
}

// 把本地分钟(0-1439) 匹配到班次; 落不进任何班次时段 → '其他/班外'
// buckets: [{name, spans:[[s,e],...] | null}]; localMin<0 视为班外
function _matchShift(buckets, localMin) {
  if (localMin < 0 || localMin >= 24*60) return '其他/班外';
  for (const b of buckets) {
    if (!b.spans) continue;
    for (const [s, e] of b.spans) {
      if (localMin >= s && localMin < e) return b.name;
    }
  }
  return '其他/班外';
}

module.exports = { connect, col, getDb, stripAi, prefixAi, insertProduction, insertBadRepair, insertTaskOrders, insertMoOrders, insertTaskOrderWip, insertRepairReport, queryProductionTotal, queryProductionByLine, queryProductionByHour, queryBadItems, queryBadStats, getTaskOrders, getLines, saveLine, upsertLineFromMes, getProducts, saveProduct, deleteProduct, saveCapacityData, getCapacityData, saveTaskMoveHours, getMesRunHours, getWorkOperations, getEquipment, getDowntimeRecords, insertDowntime, updateDowntime, deleteDowntime, computeOEE, getShiftConfigs, getShiftConfig, saveShiftConfig, deleteShiftConfig, getShiftOverrides, saveShiftOverride, deleteShiftOverride, getDowntimeCategories, saveDowntimeCategories, getExceptions, insertException, updateException, deleteException, getActionItems, insertActionItem, updateActionItem, deleteActionItem, getAttendance, insertAttendance, updateAttendance, deleteAttendance, getMaintenance, insertMaintenance, updateMaintenance, deleteMaintenance, getInspection, insertInspection, updateInspection, deleteInspection, getProductionPlan, insertProductionPlan, updateProductionPlan, deleteProductionPlan, queryBadSummary, queryBadTrend, queryBadPareto, queryBadSPC, queryBadCorrelation, computeOEEDaily, computeDowntimePareto, queryStationUPH, queryProductionByStage, getFixtures, insertFixture, updateFixture, deleteFixture, queryFixtures, queryAgingCables, queryAgingCableGroups, queryAgingCableReconcile, queryFixtureOverview, queryFixtureBadCorrelation, queryScrapStats, getAgingCables, insertAgingCable, updateAgingCable, deleteAgingCable, calcShiftExtras, calcShiftMinutes, queryOutputSns, querySnTrace, queryReworkRecords, queryBadByShift, queryOutputByShift, queryProductionCount, queryProductionAgg, queryProductionByStageEnd, queryProductionSummary, getStageEndOps, getProductionDataStart, queryProductionOpHour, queryProductionMatrix, getStageOpCodes, computeLineT5, queryProductionByHourEnd, queryOfflineOutput };
