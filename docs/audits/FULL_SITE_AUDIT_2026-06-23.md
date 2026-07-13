# 全站五维审计报告 · 2026-06-23

审计维度：代码审计 / UI设计 / 数据 / 业务逻辑 / 视觉。每维度独立深读源码后汇总去重。
范围：server.js(2074) · db.js(1377) · frontend/dist 15 页 + common.css(1858)/common.js(883)/nav.js/filter-bar.js/chart-theme.js + 根目录脚本。
方法：5 路并行专家深读 → 汇总 → 对 7 个 headline P0 逐行回读核验（均属实）。

> 严重度校准说明：各维度 agent 对"P0"门槛不一。本报告按**真实后果**重排为 4 档：
> **T1 安全&数据正确性**（会出事/会误导决策）｜**T2 健壮性&一致性**｜**T3 UI/交互/无障碍**｜**T4 视觉/设计系统**。

---

## T1 — 安全 & 数据正确性（必须先修）

### 安全

| # | 位置 | 问题 | 影响 | 建议 |
|---|---|---|---|---|
| S1 | `.env:1-6` + `.gitignore` | MES/MongoDB 凭据 + `ADMIN_KEY=12345678` 明文，且 .env 未入 .gitignore | `git add .` 即全量泄露；ADMIN_KEY 8 位弱口令可秒破 admin | .env 入 .gitignore；ADMIN_KEY 改强随机+启动校验长度；轮换已暴露口令；`git log --all -- .env` 查历史 |
| S2 | `db.js:302,1213-1294`（所有 `updateXxx`） | `{$set:{...data}}` 直接展开 POST body | 普通用户可发 `{"$inc":...}`/`{"$unset":...}` 或污染 `_id/status/role`，NoSQL 注入+字段污染 | 过滤 `$` 开头键；可写字段白名单；`_id/created_at` 强制忽略 |
| S3 | `server.js:838` | `readBody` 无大小限制，`b+=c` 全量进内存；`/api/bad-manual` 按 `parseInt(qty)` 循环插入无上限 | 单请求耗尽内存 / 写入放大 DoS | readBody 累加字节超阈值(1MB)返 413；qty 加 `Math.min(qty,1000)` |

### 数据/业务计算正确性

| # | 位置 | 问题 | 影响 | 建议 |
|---|---|---|---|---|
| D1 | `server.js:912` | `oee:d.oee.oee||null` —— OEE 合法真值 0 被吞成 null | 产线停机/班次配置异常时首页显示"暂无数据"而非报警，掩盖严重异常 | `oee: d.oee.oee != null ? d.oee.oee : null`（或直接传值） |
| D2 | `db.js:699` | `mesGapMin = (idleGaps[ln]\|\|0) * numDays` 多日查询把 MES 微停机放大 N 倍 | 多日 OEE 稼动率被严重低估，决策误判产能 | 去 `* numDays`，直接 `idleGaps[ln]\|\|0` |
| D3 | `db.js:742-876` vs `573-739` | `computeOEEDaily` 完全没接入 MES 微停机，与 `computeOEE` 口径不一致 | 日报/趋势图与汇总卡 OEE 打架，数据可信度崩塌 | Daily 路径逐天调用 `_lineIdleGaps` 或按天切分 idleGaps |
| D4 | `server.js:758,978-985,826` | 多线 OEE/MTTR 简单算术平均未产量加权；`mtbf_mttr` 只取 `oeeData[0]` | 小产量/0 产量线与主力线等权，综合 OEE 失真；MTBF 只展示第一条线 | 改 `Σ(oee×output)/Σoutput` 加权；MTBF/MTTR 取产量最大线或返回 by_line |
| D5 | `db.js:1255-1259` | 治具反推按工序 code 计数，同工序多治具轮流会重复/漏计 | 寿命进度虚高或虚低，预警/报废判断错误 | 过站记录携带 fixture_code，或台账按换装时间点归属 |
| D6 | `server.js:1090` | `badByDay` 用 `testTime.slice(0,10)`（UTC 日）分桶，与全站运营日(`test_date`)口径冲突 | 夜班跨零点不良落错日，趋势图与 summary 对不上 | 改用 `item.test_date`（运营日）；映射时带上该字段 |
| D7 | `server.js:695-700` vs `1952-1956` | "计划达成率"双口径：`computeDelivery` 用 ai_mo_orders 全量；快照 `plan_rate` 用 ai_task_orders 截断 200 | 同指标两处数字差数倍，用户无法判断真假 | 统一为 mo_orders 全量；或同时存两口径并前端标注 |

---

## T2 — 健壮性 & 一致性（应修）

| # | 位置 | 问题 | 建议 |
|---|---|---|---|
| R1 | `server.js:1940` | 30s 定时 `syncAndNotify` 无重入锁，syncData(含 puppeteer 重登录)常 >30s 会重叠 | 加 `syncBusy` 守卫 try/finally |
| R2 | `common.js:47-55` | `Confirm` 对话框 title/message 拼进 innerHTML，XSS（项目已有 escHtml 未用） | 用 textContent 或 escHtml 转义 |
| R3 | `server.js:1838-1856` | `/api/production-manual`、`/api/bad-manual` 仅普通用户权限即可注入数据，无 source 标记混入真实流 | 挪到 `/api/admin/` 或打 `source:'manual'` 并在真实 KPI 查询排除 |
| R4 | `server.js:1034,1109` | `badFastCache` 无 TTL/容量上限，枚举日期参数可致 Map 无限增长 | 改 LRU(限 100) 或每条 setTimeout 过期；sync 失败也清缓存 |
| R5 | `db.js:714` + `server.js:985` | MTTR 无故障时返回 0（非 null），与 MTBF 返回 null 不对称，拉低均值 | bdCount=0 时 MTTR 返 null，前端显示 -- |
| R6 | `server.js:876-905` | `/api/dashboard-all` 对 badItems 二次查询，与 computeDashboard 内查询间可能因同步不一致 | 复用 computeDashboard 已查结果 |
| R7 | `server.js:882-892` vs `1103` | `badByProcess` 记录数计数 vs KPI/bad-fast 唯一 SN 计数，柏拉图占比可 >100% | 统一唯一 SN Set 计数 |
| R8 | `server.js:763,780` | UPPH 出勤只取 dateFrom 单天，产量跨区间；公式 `totalOutput/(totalPeople*(totalHours/numLines))` 语义混乱 | 出勤按区间日均；UPPH 用 `Σ(linePeople×lineHours)` |
| R9 | `db.js:1107` | P50/P90 `vals[Math.floor(p*len)]`，P90 恒取最大值，off-by-one | 线性插值 `(len-1)*p` 或 `ceil(p*len)-1` |
| R10 | `db.js:390` | `_operationalDateStr` 用本地时区 `getHours()`，UTC 服务器夜班归天错误 | 显式 Asia/Shanghai 时区 |
| R11 | `server.js:966` | 环比守卫 `prevRate>0` 错误，prevRate=0(全不良)是有效基线却返回 null | 改 `prevRate!=null` |
| R12 | `server.js:848-858` | CORS `*` 全开配合 cookie 会话；WHITELIST 把 bad-*.js/wip-ui.js/filter-bar.js 业务脚本设为免登录可读 | CORS 收敛白名单；业务 JS 移出白名单 |
| R13 | `server.js:842-859` | 静态文件 `fs.readFileSync` 同步阻塞 + 路径无遍历防护 | 改 createReadStream；校验 filePath 在 dist 内 |
| R14 | `server.js` 全局 | 缺 `unhandledRejection`/`uncaughtException` 兜底 | 注册 process 级兜底日志 |
| R15 | 根目录 | 27 个 `_probe*/_verify*/_v_*` 临时脚本散落，多个含明文凭据(_probe_visibility.js 等) | 移到 docs/scripts/ 或删；.gitignore 增补 |
| R16 | `db.js:324` | `getShiftOverrides` 顶层 `line_name` 与 `$or:[{line_name},{line_name:null}]` 并存，$or 的 null 分支永不命中 | 去顶层 line_name，改 `$in:[ln,null]` |
| R17 | `server.js:1322` | `/api/wip/overview` `exceededCount:null` 硬编码 not_configured，前端按真实计数展示风险 | 实现阈值或 null 时前端强制"未配置" |
| R18 | `db.js:681,1039` | numDays `Math.round+1` 跨天边界含糊；产量按 code 分组、不良按 name 分组 stage 映射口径不一 | 日期字符串直接相减；统一 stage 映射源 |

---

## T3 — UI / 交互 / 无障碍

| # | 位置 | 问题 | 建议 |
|---|---|---|---|
| U1 | `nav.js:43`+`common.js:176` / `scroll-board.html:837` | 顶栏"退出"及投屏退出均无确认，大屏误触即掉线/丢屏序 | 加二次确认；投屏退出记忆屏序 |
| U2 | 全站(除 portal) | 投屏入口仅 `portal.html:174` 可达，cockpit/wip/oee 等无法直达核心大屏场景 | 顶栏常驻"投屏"入口 |
| U3 | 全站(除 portal) | focus-mini 焦点壳侧卡无 tabindex/role/keydown，键盘+屏幕阅读器不可达（portal.html:204 是标杆） | common 层统一封装 focus-mini a11y |
| U4 | `settings.html:202` | 仍提供"浅色"主题，违反"默认暗色不跟随系统"策略，且组件按暗色设计切浅色未验证 | 删 light 选项 |
| U5 | wip/kanban/bad/fixture-life/line-balance | 子导航三套属性混用(`onclick`/`data-target`/`data-anchor`) | 统一到 `data-target` 一套 |
| U6 | oee/wip/cockpit/kanban vs bad/oee/line-balance | 筛选机制三套并行(FilterBar vs period-select vs 手写)，oee 同页两套 | FilterBar 为唯一层，period-select 降为快捷预设 |
| U7 | `oee.html:2019`/`admin.html:502` | 原生 confirm() 亮色阻塞，与暗色主题冲突 | 实现暗色自定义 modal confirmAction |
| U8 | cockpit/wip/kanban/bad/oee/ai-center/line-balance | drawer 无 ESC 关闭 | 加 keydown Escape 监听 |
| U9 | portal/oee/cockpit/bad/wip/line-balance/health/fixture-life | 导出动词 7 种混乱(📷/⬇/↻ + 导出/导出CSV/导出报告)，cockpit ↻导出与↻刷新撞图标 | 统一 ⬇ + 格式后缀文案 |
| U10 | wip/kanban/portal/ai-center/line-balance/cockpit | 无统一 Toast/loading-mask，操作反馈缺失或各自为政 | common 层全局 Toast + loading-mask |
| U11 | `common.css:64` + chart 轴标签 | `--text-muted #4d5868` on 暗底仅 3.5:1 不达 AA(4.5)，轴标签 10px 远距离难辨 | 提一档到 `--text-secondary` 或字号≥12px |
| U12 | 全站表格(除 bad) | 仅 bad.html:464 表头有完整键盘 a11y，其余排序表只能鼠标 | bad 的 th a11y 抽到 common 全站复用 |
| U13 | settings 全表单 | 无前端字段级校验，错误要到提交后才报 | 加 required/pattern + 字段级错误提示 |

---

## T4 — 视觉 / 设计系统

| # | 位置 | 问题 | 建议 |
|---|---|---|---|
| V1 | `common.css:64` | `--text-muted:#4d5868` 3.5:1 不达 AA（轴标签/kpi-label/source-pill.empty/emptyState 全依赖） | 按 01-color.md CR-02 升至 #5d6a7c(4.6:1) |
| V2 | `common.css:7-195` | `:root` 未声明 `color-scheme:dark`，原生控件(滚动条/select/date picker)可能渲染亮色 | 加 `color-scheme:dark` |
| V3 | `chart-theme.js:34` | accentRed fallback `'#f04f5f'` 与 `--danger:#ef4444` 不一致 | 改 `'#ef4444'`，同步 refresh() fallback |
| V4 | `manifest.json:8-9` | theme_color `#0ea5e9`/bg `#0a1025` 与全站 `#0166B1`/`#0a0d12` 不符 | 改品牌色 |
| V5 | cockpit/oee/login/wip | 硬编码颜色绕过 token：cockpit:1000 rateColor 三元、oee:148 `var(--success,#10b981)`、login:346 渐变、wip:258 `--info,#22d3ee` | 去 fallback 字面量，统一走 token |
| V6 | wip.html:142 等 | 内联 `font-size:13/12/11/10px` 30+ 处绕过 `--fs-*` token | 逐处替换为 token |
| V7 | common.css 多处 | 圆角实际 6 档(xs/sm/md/lg/xl/2xl)，超 spec"3 档"约束；focus-title line-height 1.18 vs spec 1.12 | 收敛使用面；对齐 --lh-tight |
| V8 | bad.html:26 / common.css:918 / ai-center:31 | 白字/黑字 on 品牌蓝/紫底对比度临界(2.6~3.2:1)不达 AA | 文字改 --text-primary 或加深底色 |

---

## 横切洞察

1. **"规范已写、落地未完"是主旋律**：`.claude/specs/` 24 份规范完备，但 color-scheme、--text-muted 升级、圆角 3 档、内联 font-size 清零等多处 CR 标注"未执行"。建议把 spec 的 CR 项做成 checklist 跟进。
2. **共享基础设施强、采用率参差**：common.css/js 质量高，但 FilterBar/period-select/手写三套筛选、子导航三套属性、Toast 仅 5 页有——同一能力多套并行实现是 bug 温床。收敛到 common 单一实现是最大杠杆。
3. **OEE 时间模型双路径并存是数据可信度最大隐患**：computeOEE 与 computeOEEDaily 口径不一致(D2/D3)、多线未加权(D4)、MES gap 双重放大——同一指标三个口径打架，建议优先统一。
4. **手动补数缺标记是"假数据审计"复发风险点**：R3 的 manual 路由无 source 标记混入真实流，与项目历史"曾因假数据被审计"同类。建议所有手动写入打 `source:'manual'` 并在真实 KPI 排除。
5. **根目录 27 个临时脚本含明文凭据**：开发期产物混在生产目录且未 gitignore，是 S1 之外的第二泄露面。

---

## 建议修复顺序

1. **立刻**：S1(凭据+gitignore) → S2(NoSQL注入过滤) → S3(readBody限制) —— 三条都是可被利用的安全洞。
2. **本周**：D1/D2/D3/D4(OEE 口径统一) → D6/D7(数据打架) —— 直接影响看板可信度。
3. **两周内**：R1-R18 健壮性批次 + R15 根目录清理。
4. **持续**：U/V 设计系统收口，按 spec CR checklist 逐项落地。
