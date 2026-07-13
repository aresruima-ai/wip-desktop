# 全站数据幻觉排查报告

> 排查日期: 2026-06-22 | 排查范围: 全站 (server.js 2353行 + db.js 1122行 + 17个前端页面 + 共享JS)

---

## 总览

| 严重级别 | 数量 | 影响范围 |
|----------|------|----------|
| **CRITICAL** | 5 | 维修次数/产能效率/手工数据/驾驶舱监控图 全站造假 |
| **HIGH** | 12 | 零值掩盖缺数、硬编码KPI目标、OEE计算Bug、假趋势图、DB时间戳造假 |
| **MEDIUM** | 14 | 字段映射不一致、admin假数据、空响应伪装、命名冲突 |
| **LOW** | 6 | 舍入不一致、骨架屏假数据、MTBF语义 |

**总幻觉点: 37 个**

---

## 一、CRITICAL (5个) — 必须立即修复

### C1. [server.js:947] `repairTotal:1` 强制覆盖所有维修次数

```js
badItems: badItems.map(b=>({...b, repairTotal:1, ...}))
```

**问题**: `{...b}` 先展开DB真实字段(含 `repair_total`)，但紧接着 `repairTotal:1` 无条件把所有记录维修次数写成 **1**。每个不良品的真实维修次数(0/2/3/...)被丢弃，门户页、驾驶舱、全部 `/api/dashboard-all` 消费者看到的维修数恒为 1。

**修复**: 改为 `repairTotal: b.repair_total ?? null`

---

### C2. [server.js:862-863] UPPH 分母完全伪造

```js
const people = Math.max(scopedProdByLine.length*12, 1);  // 假设每条线12人
const upph = totalOutput>0 ? +(totalOutput/(people*10.5)).toFixed(2) : null;  // 10.5h固定
```

**问题**: 假设每条产线 12 个操作员、每天 10.5 小时 — 两个数字均无数据来源。门户首页 KPI 卡上的 UPPH 值来自纯粹的假设，并非真实人效。

**修复**: 从 `ai_attendance` 取真实出勤人数，从班次配置取真实工作时长；若无数据则返回 `null` 并打 `data_quality: 'missing_attendance'`。

---

### C3. [server.js:2037] 手工录入产量时间戳注入随机分钟

```js
moveOutTime: new Date(b.date+'T'+...String(Math.floor(Math.random()*60)).padStart(2,'0')+':00').toISOString()
```

**问题**: `/api/production-manual` POST 端点用 `Math.random()*60` 随机生成分钟数。手工数据的时间戳是半随机的，与真实过站数据外观无法区分。

**修复**: 去掉 `Math.random()`，用固定 `:00` 或要求用户指定精确时间。

---

### C4. [cockpit.html:1157] 驾驶舱"同步延迟"图全假数据

```js
data: times.map(function(){return Math.floor(Math.random()*200+50);})
```

**问题**: "服务状态"Tab 的"同步延迟(ms)"折线图 24 个数据点全是 `Math.random()*200+50` (50~250ms 随机值)。每次刷新图表都变，与实际 MES 同步延迟毫无关系。

**修复**: 接入 `/api/admin/server-status` 中真实同步时间，或删除此图表。

---

### C5. [cockpit.html:1158] 驾驶舱"错误数"柱状图全假数据

```js
data: times.map(function(){return Math.floor(Math.random()*3);})
```

**问题**: 同上图，24 个柱子每个用 `Math.random()*3` (0~2 随机错误数)。假错误数配假延迟，组成了一张完全伪造的"系统健康监控"图。

**修复**: 接入真实错误日志统计，或删除此图表。

---

## 二、HIGH (12个) — 尽快修复

### H1. [server.js:853] 误测率缺数时返回 `0`

```js
const mistestRate = badItems.length>0 ? ... : 0;
```

**问题**: 无不良数据时误测率显示 `0%`(看起来像"零误测")，实际是"无数据可算"。前端无法区分。

**修复**: 返回 `null`。

---

### H2. [server.js:854] PPM 缺数时返回 `0`

```js
const ppm = totalProd>0 ? ... : 0;
```

**问题**: PPM=0 代表"零缺陷"世界级品质，但实际是产量为空。门户页显示 `0 PPM — 达标` 极具误导性。

**修复**: 返回 `null`。

---

### H3. [server.js:858] OEE 无数据时返回全零对象

```js
let oee = {availability:0,performance:0,quality:0,oee:0};
if(oeeData.length>0){ ... }
```

**问题**: OEE=0% 是紧急停机级别告警，却用于表示"无数据"。可能触发 WebSocket 假告警(line 2320 检查 `oee < 60`)。

**修复**: 返回 `{availability:null, performance:null, quality:null, oee:null}` 并打 `data_quality: 'empty'`。

---

### H4. [server.js:1732-1733] KPI 目标值硬编码

```js
const defaults={daily_output:1500, fpy:95, oee:85, ppm:3000};
json({success:true, data:doc?.value||defaults});
```

**问题**: 未配置 KPI 目标时返回写死的 `1500/95/85/3000`。这些数字控制告警阈值和颜色指示器，在错误的工厂环境会触发假达标/假超标。

**修复**: 未配置时返回空对象，要求管理员完成配置后才启用阈值比较。

---

### H5. [db.js:141] DB 入库时 `repair_total` 默认 `1`

```js
repair_total: item.repairTotal || 1,
```

**问题**: MES 未返回维修次数时数据库静默存 `1`。无法区分"维修1次"和"次数未知"。这是 C1 的根源。

**修复**: `item.repairTotal ?? null`

---

### H6. [db.js:864-871] `queryBadTrend` 粒度参数死代码

```js
const groupId = granularity==='week' ? {$substr:['$test_date',0,8]} : '$test_date';
// ... groupId 从未被使用!
{ $group: { _id: '$test_date', ... } }  // 硬编码按天分组
```

**问题**: `granularity` 参数被计算但从不使用。所有不良趋势查询永远按天聚合，周粒度请求静默返回日数据。

**修复**: 在 `$group` 中使用 `groupId`。

---

### H7. [db.js:484] `computeOEE` 班次覆盖忽略日期

```js
overrides.find(o => (o.line_name===pl.line_name || !o.line_name))
```

**问题**: 多日 OEE 查询时取第一个匹配的覆盖值应用到整个期间。6月5日的加班覆盖被错误地应用到6月1-30日全月数据。

**修复**: 参照 `computeOEEDaily`(line 588)按日期范围过滤覆盖值。

---

### H8. [db.js:89-91等6处] 缺失时间戳用 `new Date()` 静默填补

```js
let d = ts ? new Date(ts) : new Date();
if (isNaN(d.getTime())) d = new Date();
```

**问题**: 所有 6 个 insert 函数在 MES 不返回时间戳时用**当前同步时间**填补。长期运行后，时间序列分析(趋势/SPC/OEE)被污染 — 实际发生在上周的事件被记录为同步时间。

**修复**: 缺失时间戳存 `null`，打 `data_quality` 标记，前端可排除或标注这些记录。

---

### H9. [cockpit.html:1190-1195] Drawer 明细永远加载中

```js
body.innerHTML = 
  '<div class="drawer-stat"><div class="val">--</div>...' +
  '<p>详细数据加载中，请稍候…</p>';
```

**问题**: OEE/产量/不良/FPY 的 drawer 打开后显示 `--` + "加载中"，但 `openDrawer()` 函数从不发起 fetch 请求加载真实明细。永久显示假加载状态。

**修复**: 在 `openDrawer()` 中根据 type 发起对应的 API 请求填充数据。

---

### H10. [factory-3d.html:767] Mini 趋势图全部伪造

```js
function renderMiniChart(count){
    for(let i=0;i<8;i++){
        const val = Math.max(1, count + Math.round((Math.random()-0.5)*count*0.3));
        bars.push(val);  // ±15% 随机噪声伪造成"历史趋势"
    }
    bars.push(count);  // 最后一个点是真数据
}
```

**问题**: 3D 工厂选中工站后，详情面板显示一条"mini 趋势图"包含 9 根柱子。前 8 根是从当前 WIP 数量加 ±15% 随机噪声生成的，第 9 根是真实值。用户看到的"趋势"完全虚假。

**修复**: 去掉假历史柱，只显示当前值；或接入真实历史 WIP 数据。

---

### H11. [db.js:496-498] 未知停机类别静默归入"非计划停机"

```js
if (plannedCodes.includes(cat)) { plannedDt += dur; }
else if (unplannedCodes.includes(cat)) { unplannedDt += dur; }
else { unplannedDt += dur; }  // 未知类别→非计划
```

**问题**: 空值、拼写错误、未配置的停机类别全部被静默归入非计划停机，虚增非计划停机时间拉低可用率。

**修复**: 新增 `unknown` 桶，打数据质量告警。

---

### H12. [db.js:505] 性能率上限 1.0 掩盖配置错误

```js
const performance = Math.min(perfRaw, 1.0);
```

**问题**: 当节拍时间配置过高(如 90s 对应实际 45s)，`perfRaw` 会是 2.0(200%)。`Math.min(..., 1.0)` 静默吞掉错误显示 100%。运维者看不到配置问题。

**修复**: 当 `perfRaw > 1.0` 时标记 `data_quality: 'suspicious_ct'` 而非静默裁剪。

---

## 三、MEDIUM (14个) — 计划修复

### M1. [server.js:1128] `repairStateCode: b.repair_state_code||0`
缺维修状态码时默认 0，"未知"与"未关闭"混淆。改为 `?? null`。

### M2. [server.js:1613] `/api/admin/users` 硬编码用户列表
返回写死的 `[{id:'admin',...}, {id:'mes-user',...}]` — 无法反映真实用户。

### M3. [server.js:1617] `/api/admin/log-stats` 假统计数据
`errorsToday:0, requestsLastHour:0` 写死。要么实现真实计数，要么返回 501。

### M4. [server.js:1618] `/api/admin/logs` 空分页响应伪装
返回 `{rows:[], total:0, page:1, pageSize:100, totalPages:1}` — 伪装成"今天无日志"，实为无日志存储。

### M5. [server.js:1746] `/api/escalation/list` 响应格式不一致
返回裸 `[]` 而非 `{success:true, data:[]}`。前端若检查 `response.success` 会静默失败。

### M6. [server.js:850/1005/1015] PPM 三处计算方式不一致
`toFixed(0)` vs `Math.round`，`0` vs `null` fallback。同一指标不同端点返回微小差异值。

### M7. [db.js:126 vs 250] `work_operation_name` vs `work_opration_name`
`bad_repair` 正确拼写，`repair_report` 沿用 MES 拼写错误。跨集合 JOIN 静默丢数据。

### M8. [db.js:130 vs 255] `repair_man` vs `maintainer_name`
同一语义(维修人)两个集合不同字段名。

### M9. [db.js:840-848] `queryBadSummary` 内存爆炸风险
所有闭单时长 `$push` 到一个 BSON 数组，数据量大时突破 16MB 限制。应用 `$percentile` 聚合算子。

### M10. [db.js:352] `queryBadStats` 计数的是维修记录而非唯一产品
Pareto 用 `{ $sum: 1 }` 算维修次数，OEE 用 `distinct barcode` 算不良产品数。两个"不良数"口径不一致。

### M11. [db.js:116-118] `test_time`(UTC) vs `test_date`(本地) 午夜偏移
北京时间 01:00 的记录 `test_time` UTC 显示前一天，`test_date` 显示当天。外部工具按 `test_time` 取日期会错天。

### M12. [db.js:93] 空 `moveOutTime` 导致 ID 碰撞
两个同产品同工站缺时间戳的记录共享同一 ID，后者覆盖前者，数据静默丢失。

### M13. [db.js:131-135] `repair_time` 字段格式不统一
MES 有值时存 ISO，无值时存原始格式。下游解析需处理多格式。

### M14. [db.js:473] 硬编码 `defaultCT = 48` 秒
无产品配置时节拍默认 48s，驱动假 OEE 性能率。虽打了 `data_quality` 标记但数字仍参与计算。

---

## 四、LOW (6个)

| # | 位置 | 问题 |
|---|------|------|
| L1 | db.js:510 | MTBF 无故障时=T5(可用时间)，应返回 null |
| L2 | db.js:682 | 低频工站阈值 `Math.max(10, maxTotal*0.1)` 无文档说明 |
| L3 | db.js:417-426 | 默认停机类别硬编码，MES 类别名变更时全部归入"非计划" |
| L4 | server.js:421-425 | `\|\| ''` 长链在 MES 字段变更时静默吞错 |
| L5 | server.js:643/809/944 | `\|\| '未知'` 将不同缺失项聚合成一个"未知"桶 |
| L6 | admin.html:601/production-config.html:305/settings.html:414 | 骨架屏 `Math.random()` 用于占位宽度(可接受) |

---

## 五、已确认真实数据(无幻觉)

以下端点/页面通过了审计，数据来自 MongoDB 或 MES API 真实查询:

- `/api/dashboard-all` — 核心逻辑走 `computeDashboard()` → MongoDB
- `/api/dashboard-kpi` — 同上
- `/api/dashboard-trend` — MongoDB 聚合
- `/api/oee` — `db.computeOEE()` (有上述Bug但非假数据)
- `/api/bad/pareto` — `db.queryBadPareto()` → MongoDB
- `/api/bad/heatmap` — `db.queryBadHeatmap()` → MongoDB
- `/api/bad/spc` — `db.queryBadSPC()` + 生产数据 → P控制图
- `/api/bad/fast` — MongoDB 直读
- `/api/wip` / `/api/wip/detail` / `/api/wip/cycle-detail` / `/api/wip/snapshots` — MongoDB
- `/api/process-routes` — MongoDB
- `/api/work-order-progress` — MongoDB
- `/api/lines` — MongoDB+MES
- `/api/fixtures` / `/api/aging-cables` / `/api/fixtures/overview` — MongoDB
- `/api/production-by-stage` — MongoDB
- `/api/sync` — MES → MongoDB
- **bad.html + bad-*.js** — 全部数据来自 API
- **wip.html + wip-ui.js** — 全部数据来自 API
- **portal.html** (除UPPH被C2污染外) — 7个API并行真实查询
- **quality.html / oee.html / kanban.html / health.html** — API数据
- **fixture-life.html** — 真实过站反推数据
- **common.js / nav.js / filter-bar.js / chart-theme.js** — 无任何假数据

**"AI"命名透明度说明**: `/api/ai-insights` 和 `/api/ai-chat` 实际为规则引擎(明确标记 `source:'rule-engine'`)，非大模型。`ai-center.html` 是功能入口页无假数据。

---

## 六、修复优先级

### 第一批(立即): C1~C5
移除 5 个 CRITICAL 级别的直接造假:
- **C1** `repairTotal:1` → 修复一行代码，影响所有页面的维修统计
- **C2** UPPH 假分母 → 改返回 `null` 或接入真实出勤
- **C3** 手工录入随机分钟 → 去 `Math.random()`
- **C4+C5** 驾驶舱假监控图 → 去 `Math.random()` 或删图

### 第二批(本周): H1~H8
零值缺数陷阱 + DB 数据污染 + OEE 计算Bug

### 第三批(本月): H9~H12 + M1~M14
drawer/3D假图 + 字段一致性 + 响应规范

---

## 七、深度融合建议

1. **增加 `data_quality` 字段覆盖**: 当前仅 OEE 相关有 `data_quality` 标记。建议为所有 KPI 返回值增加 `data_quality: 'real'|'estimated'|'empty'|'default'`，前端据此渲染不同视觉提示(如 estimated 值加虚线边框)。

2. **前后端字段名校验**: 建议建一个共享的 `field-map.json`，前后端共同引用，CI 环节用脚本校验一致性。

3. **假数据检测 Lint 规则**: 在 pre-commit hook 中添加 `Math.random` 检测(排除骨架屏)，禁止在非视觉效果的逻辑中使用。

4. **时间戳规范**: 统一所有 collection 使用 UTC ISO 存储 + 本地日期冗余字段的模式，在 `db.js` 加一个 `normalizeTimestamp()` 工具函数。