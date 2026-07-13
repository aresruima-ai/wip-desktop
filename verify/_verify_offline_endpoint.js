// 端点级验证: 登录后查 3 个端点的 offline 字段透传是否正确
// 认证方式复用 _verify_scroll_thorough.js (POST /api/login 拿 session)
require('dotenv').config();
const BASE = 'http://localhost:8080';
const USER = 'yangning', PWD = 'Yn@20250908';
async function login() {
  const r = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: USER, password: PWD }) });
  const m = (r.headers.get('set-cookie') || '').match(/session=([^;]+)/);
  if (!m) throw new Error('login failed: ' + await r.text());
  return 'session=' + m[1];
}
(async () => {
  const cookie = await login();
  const d = new Date();
  const today = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

  // dashboard-kpi (cockpit 用)
  const r1 = await fetch(`${BASE}/api/dashboard-kpi?dateFrom=${today}&dateTo=${today}`, { headers: { Cookie: cookie } });
  const kpi = await r1.json();
  // dashboard (portal/kanban 用, ...d 展开 + productionOffline)
  const r2 = await fetch(`${BASE}/api/dashboard?dateFrom=${today}&dateTo=${today}`, { headers: { Cookie: cookie } });
  const dash = await r2.json();
  // board-snapshot (scroll-board 用)
  const r3 = await fetch(`${BASE}/api/board-snapshot`, { headers: { Cookie: cookie } });
  const snap = await r3.json();

  console.log('dashboard-kpi:        output=', kpi.output, ' output_offline=', kpi.output_offline);
  console.log('dashboard:            productionTotal=', dash.productionTotal, ' productionOffline=', dash.productionOffline, ' upph.offline_output=', dash.upph && dash.upph.offline_output);
  console.log('board-snapshot.kpi:   output=', snap.kpi && snap.kpi.output, ' output_offline=', snap.kpi && snap.kpi.output_offline);
  console.log('board-snapshot.dashAll.upph.offline_output=', snap.dashAll && snap.dashAll.upph && snap.dashAll.upph.offline_output);

  let ok = 0, fail = 0;
  const ck = (n, c, x) => { if (c) { ok++; console.log('  ✓', n, x || ''); } else { fail++; console.log('  ✗', n, x || ''); } };
  ck('dashboard-kpi 含 output_offline', kpi.output_offline != null, 'output_offline=' + kpi.output_offline);
  ck('dashboard 含 productionOffline', dash.productionOffline != null, 'productionOffline=' + dash.productionOffline);
  ck('dashboard.upph.offline_output 存在', dash.upph && dash.upph.offline_output != null, 'val=' + (dash.upph && dash.upph.offline_output));
  ck('board-snapshot.kpi 含 output_offline', snap.kpi && snap.kpi.output_offline != null, 'val=' + (snap.kpi && snap.kpi.output_offline));
  ck('board-snapshot.dashAll 透传 offline', snap.dashAll && snap.dashAll.upph && snap.dashAll.upph.offline_output != null, 'val=' + (snap.dashAll && snap.dashAll.upph && snap.dashAll.upph.offline_output));
  ck('dashboard-kpi output_offline<=output', (kpi.output_offline || 0) <= (kpi.output || 0), 'offline=' + kpi.output_offline + ' output=' + kpi.output);
  ck('productionOffline<=productionTotal', (dash.productionOffline || 0) <= (dash.productionTotal || 0), 'offline=' + dash.productionOffline + ' total=' + dash.productionTotal);

  console.log('\n结果: ' + ok + ' PASS / ' + fail + ' FAIL');
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('[ERR]', e.message); process.exit(1); });
