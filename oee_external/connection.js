// 统一OEE外部数据源 — 连接层
// 同台MongoDB(10.50.55.39:27017)上的4个产线OEE库(功放1/2线·整机1/3线OEE),
// 与mes_dashboard库隔离: mes_user默认无权访问(not authorized)。
// 本层用独立连接串OEE_EXTERNAL_URI(管理员/授权账号); 未配置则回退MONGO_URI(需DBA已给mes_user授予4库read)。
// 铁律: 连不上/未授权只告警返回null, 绝不抛错 — 外部库不可用时主链回退estimated口径, 不影响全站14调用点。
const { MongoClient } = require('mongodb');

// 4个外部OEE库名(产线维度)
const OEE_DB_NAMES = ['功放1线OEE', '功放2线OEE', '整机1线OEE', '整机3线OEE'];

let _client = null, _dbs = null, _failWarned = false;

// 返回 {库名: Db实例} 或 null(未启用/连不上)
async function getExternalDbs() {
  if (process.env.OEE_EXTERNAL_ENABLED !== '1') return null; // 默认关
  if (_dbs) return _dbs;
  const uri = process.env.OEE_EXTERNAL_URI || process.env.MONGO_URI;
  if (!uri) return null;
  try {
    _client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000, socketTimeoutMS: 10000, maxPoolSize: 10 });
    await _client.connect();
    _dbs = {};
    for (const dn of OEE_DB_NAMES) _dbs[dn] = _client.db(dn);
    return _dbs;
  } catch (e) {
    if (!_failWarned) { console.log('[oee_external] 连接失败,主链回退estimated:', e.message.substring(0, 80)); _failWarned = true; }
    return null;
  }
}

// mes_dashboard产线line_name → 外部OEE库名 映射
// 据 ai_line_config.ai_line_display 对齐(仅4条ASS_整机/功放线有外部OEE库; QJG_/PKG_无,维持estimated)
const LINE_TO_DB = {
  'ASS_Line1': '整机1线OEE',     // display 整机1线
  'ASS_Line3': '整机3线OEE',     // display 整机3线
  'ASS_Line2-1': '功放2线OEE',   // display 功放2线
  'ASS_Line2': '功放1线OEE',     // display 功放线 — 推断为功放1线, Phase2授权后核对
};

function dbForLine(lineName) {
  const dn = LINE_TO_DB[lineName];
  return dn && OEE_DB_NAMES.includes(dn) ? dn : null;
}

module.exports = { getExternalDbs, OEE_DB_NAMES, LINE_TO_DB, dbForLine };
