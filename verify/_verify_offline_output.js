// 验证今日产量"末道下线"对照口径: queryOfflineOutput vs queryProductionTotal
// 复用 _verify_uph_db.js 的 env+connect 模式; 不依赖 server 重启, 直连 MongoDB 测函数
require('dotenv').config();
const db = require('../db');
function localDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
(async () => {
  await db.connect();
  let ok = 0, fail = 0;
  const ck = (name, cond, extra) => { if (cond) { ok++; console.log('  ✓', name, extra || ''); } else { fail++; console.log('  ✗', name, extra || ''); } };

  const today = localDate();
  const refDay = '2026-06-25'; // 已知有数据日(_verify_uph_db 同款)

  // 1. getStageEndOps 全线 packaging 末道
  console.log('\n[1] getStageEndOps(null) packaging 末道');
  const endOps = await db.getStageEndOps(null);
  ck('packaging末道非空', endOps.packaging.length > 0, 'packaging=' + endOps.packaging.join(','));

  // 2. queryOfflineOutput 历史日(应有数据)
  console.log('\n[2] queryOfflineOutput 历史日 ' + refDay);
  const offlineRef = await db.queryOfflineOutput(refDay, refDay, '');
  const totalRef = await db.queryProductionTotal(refDay, refDay, '');
  ck('历史日末道下线>0', offlineRef > 0, 'offline=' + offlineRef);
  ck('历史日活跃>0', totalRef > 0, 'total=' + totalRef);
  ck('下线<=活跃(末道是活跃子集)', offlineRef <= totalRef, 'offline=' + offlineRef + ' total=' + totalRef);

  // 3. queryOfflineOutput 今日
  console.log('\n[3] queryOfflineOutput 今日 ' + today);
  const offlineToday = await db.queryOfflineOutput(today, today, '');
  const totalToday = await db.queryProductionTotal(today, today, '');
  ck('今日末道下线>=0', offlineToday != null && offlineToday >= 0, 'offline=' + offlineToday);
  ck('今日活跃>=0', totalToday != null && totalToday >= 0, 'total=' + totalToday);
  ck('今日下线<=活跃', offlineToday <= totalToday, 'offline=' + offlineToday + ' total=' + totalToday);

  // 4. 无末道配置场景(不存在的线) → 0 不报错
  console.log('\n[4] 无末道配置兜底');
  const emptyOffline = await db.queryOfflineOutput(today, today, '__NO_SUCH_LINE__');
  ck('无配置返回0不报错', emptyOffline === 0, 'val=' + emptyOffline);

  console.log('\n结果: ' + ok + ' PASS / ' + fail + ' FAIL');
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('[ERR]', e); process.exit(1); });
