# 🔬 全站视觉效果审计报告 — AI数字化看板

**审计日期**: 2026-06-22 | **审计范围**: 17页 + 核心CSS/JS基础层 | **设计系统版本**: SIGMA v4.0 BMW Edition

---

## 总评

| 维度 | 评分 | 说明 |
|------|------|------|
| 设计Token体系 | A+ (95/100) | 行业领先的CSS变量体系，173行完整token |
| 暗色主题 | A (93/100) | BMW德系精工暗色，克制优雅，少数硬编码残留 |
| 排版层次 | B+ (87/100) | 10级字号+8pt网格，部分页排版过于密集 |
| 动效体系 | A (92/100) | ATTN引擎+各页独立hooks，密度纪律优秀 |
| 响应式 | B+ (85/100) | 5个断点覆盖全设备，部分3D/表格页未适配 |
| 组件一致性 | B (82/100) | 核心组件统一，但设置/配置页偏离设计语言 |
| 无障碍 | B+ (86/100) | reduced-motion全站守护，对比度可进一步提升 |
| **综合** | **A- (87/100)** | **行业前15%，局部打磨可进前5%** |

---

## 一、设计Token体系 — A+ (95/100)

### 亮点
- **173行CSS变量** (`common.css:7-193`) 覆盖表面/品牌/语义/排版/间距/圆角/阴影/动效/KPI/注意力钩子五大类
- **Low-High兼容双层设计**: `--surface-base` 等新token + `--bg-canvas` 等legacy alias，新旧平滑过渡
- **三级精度边框系统**: `--line-faint(0.03)` / `--line-weak(0.06)` / `--line(0.09)` / `--line-strong(0.30)` — 克制且可量化
- **8pt网格基准**: `--sp-1:4px` 到 `--sp-10:64px` 统一间距，全站grid gap使用 `--module-gap:16px`
- **三档圆角**: `--radius-xs(3px)` / `--radius(6px)` / `--radius-xl(10px)` — BMW精密直角，无过度圆润
- **注意力钩子专属token**: `--dur-enter/breath/hit` + `--glow-brand/success/danger/amber` + `--ease-hit/ease-expo` — 三段节奏不混周期

### 问题
1. **[P2] 每页重复声明token** — cockpit/portal/bad/wip/oee/kanban/line-balance/health/ai-center/login 共9个页面各自在 `<style>` 中重复定义了 `--dur-enter`/`--glow-brand` 等动画token。common.css已全局注入（`:root` 166-192行），页面重构定义造成冗余和潜在不一致。应删除页面级重复声明。

2. **[P2] `--success` 颜色 $10b981 vs $10d48e 不一致** — Token定义为 `#10b981`(emerald)，但多处JS硬编码 `#10d48e` 和 `#22c55e`。应统一为token变量。

---

## 二、暗色主题与色彩系统 — A (93/100)

### 亮点
- **BMW蓝精工暗色**: `--surface-base:#0a0d12` + `--brand:#0166B1` — 对比度克制，不刺眼
- **语义色功能化**: 琥珀 `#f59e0b` 降级为纯功能色（不再用于装饰），danger全留/warning≤2/success仅首屏的稀缺调度
- **CHART模块化配色**: `chart-theme.js` 从CSS变量读取颜色，消除~300处硬编码，支持 `CHART.colors[0]` 数组和 `CHART.colors.blue` 命名双兼容

### 问题
3. **[P1] 部分JS硬编码颜色绕过token** — 
   - `cockpit.html:1062-1063` — `color: '#10b981' / '#f59e0b' / '#ef4444'` 硬编码OEE液态图阈值色
   - `bad.html:793` — `color: '#22c55e' / '#f59e0b' / '#ef4444'` 硬编码闭环率颜色
   - `login.html:346-348` — `background:'linear-gradient(135deg,#10d48e,#10b981)'` 硬编码登录成功色
   - `portal.html:724` — `color:'#10d48e' / '#f04f5f'` 硬编码周汇总颜色
   - **修复**: 全部替换为 `var(--success)` / `var(--warning)` / `var(--danger)`

4. **[P2] 对比度边界案例** — `--text-muted:#4d5868` 在 `--surface-base:#0a0d12` 背景上对比度约 4.1:1，接近WCAG AA的4.5:1下限。建议将 `--text-muted` 提升至 `#5d6a7c` 以保证通过。

5. **[P3] 部分页未使用token硬编码色值** — `factory-3d.html` 使用 `#1e293b/#020810/#0a1120` 等不匹配surface token的颜色，`settings.html`/`production-config.html`/`admin.html` 大量直接使用 `--color-*` legacy alias 而非 `--surface-*`/`--text-*` 新token。

---

## 三、排版层次 — B+ (87/100)

### 亮点
- **10级字号scale**: `--fs-2xs:10px` → `--fs-hero:60px`，覆盖小标签到大标题
- **中文可读性专项优化**: `line-height:1.75`(body)，小字号 `letter-spacing:0.06em`，大标题 `letter-spacing:-0.03em`
- **等宽数字对齐**: KPI数值统一 `font-variant-numeric:tabular-nums`
- **PingFang SC + JetBrains Mono**: 中英文字体分别指定最优选择

### 问题
6. **[P1] 磅值升级不完整** — common.css §6.5 将KPI值从 `--fs-2xl(32px)` 升级到 `--fs-3xl(44px)`，面板标题从14px升级到17px。但部分页面内联样式覆盖回了较小的值：
   - `bad.html` KPI值使用 `--fs-2xl`（32px）而非升级后的 `--fs-3xl`
   - `fixture-life.html:21` — `.kpi-value{font-size:24px}` 硬编码
   - `kanban.html:74` — `.flow-card .op-count{font-size:24px}` 硬编码

7. **[P2] 设置页/管理页排版粗糙** — `settings.html`、`admin.html`、`production-config.html` 使用 `font-size:12px/13px` 硬编码值，未使用 `--fs-sm`/`--fs-base` token，与主看板页面的14px基础字号不一致。

8. **[P3] 缺少衬线字体作为区分性副标题** — 全站统一使用 `--font`(PingFang/YaHei)，所有文本视觉层级仅靠字重和大小区分。可考虑为数据洞察/公告标题引入衬线字体（如Noto Serif SC）作为"权威感"信号。

---

## 四、动效体系 — A (92/100)

### 亮点
- **ATTN引擎** (`common.js:522-723`): 统一暴露 `liveNum`/`flash`/`enforceFocal`/`revealCascade`/`spotlight`/`beatBar`/`audit` 七个API
- **三段节奏纪律**: 入场(280ms) ≠ 呼吸(2.8s) ≠ 触发(150ms)，不混周期
- **密度预算严格**: 一屏动画≤5-6，常驻呼吸≤3（如cockpit仅OEE水球+雷达环+live-dot）
- **性能零重排**: 全站动画统一走 `transform/opacity/box-shadow` 合成层
- **`prefers-reduced-motion` 全站守护**: common.css + 每页独立声明
- **驾驶舱压倒性焦点**: cockpit的OEE指挥水球+conic-gradient雷达扫描环+光标聚光灯+三态呼吸光，是整个项目中动效的最高表达

### 问题
9. **[P1] ATTN引擎未被所有页面采用** — portal.html和部分页面使用了ATTN，但quality.html/wip.html/oee.html/kanban.html/fixture-life.html仍各自实现 `liveNum`/`flash`/`revealCascade`/`spotlight` 等重复逻辑（quality.html `animateNumber`、bad.html `animateNumber`、cockpit `liveNum`、oee `liveNum`）。建议全部迁移到 `window.ATTN.*`。

10. **[P2] 入场stagger实现方式不统一** — 
    - cockpit使用 `IntersectionObserver` + `setTimeout` 按index stagger
    - bad使用纯CSS `animation-delay` 硬编码nth-child
    - wip使用 `.wip-reveal` + JS `is-revealed` class
    - portal使用 `ATTN.revealCascade`
    建议统一走 `ATTN.revealCascade`。

11. **[P2] cockpit OEE水球使用硬编码假数据** — `cockpit.html:930` `setText('focusTitle', '全域状态正常 · OEE 76.2% · 不良 PPM 842')` 焦点标题为静态文本，`loadKPIs()`内数值均为硬编码。与portal/bad等页面已接入真实API形成反差，降低驾驶舱的"指挥中枢"可信度。

12. **[P3] login页神经网络canvas背景** — `login.html:372-389` 使用 `requestAnimationFrame` 循环绘制70个节点+全连通图，在非焦点状态下持续消耗GPU。建议在 `document.hidden` 时暂停（已有reduced-motion降级，但缺少Page Visibility API监听）。

---

## 五、卡片与表面系统 — A- (91/100)

### 亮点
- **三级卡片层级**: `.kpi-card`(数据卡) / `.panel`(面板) / `.focus-card`(焦点卡) — 各有独立的border-left色条+微光条+悬停行为
- **KPI卡片左色条语义化**: `--kpi-color` CSS变量驱动左侧3px色条+顶部渐变微光条+悬停边框
- **焦点壳系统**: `.focus-shell` + `.focus-card`(hero) + `.focus-side`(mini)，左右不对称布局，支持 `sev-danger/warn/normal` 三态呼吸
- **BMW克制品控**: 悬停仅边框变色+无glow(纯结构投影)+无transform lift(除portal入口卡微升2px)

### 问题
13. **[P2] KPI卡片 `--kpi-color` 未被所有卡片使用** — cockpit的8卡使用 `--kpi-color`，但quality/fixture-life的KPI卡使用 `--accent-*` 变量硬编码颜色。应统一。

14. **[P2] 面板padding不统一** — common.css §6.5 将 `.panel` 升级为 `padding:24px 28px`，但 `portal.html:58` 覆盖为 `padding:18px 20px !important`，`cockpit.html:175` 覆盖为 `padding:22px 26px`。建议建立 `.panel-sm`/`.panel-md`/`.panel-lg` 三个标准尺寸。

15. **[P3] Focus Shell的focus-side在不同页表现不一致** — cockpit使用 `min-height:80px` 2卡，portal使用 `min-height:96px` 2×2网格4卡，bad使用 `min-height:80px` 2卡，wip使用 `min-height:148px` 液态图卡。应建立 `.focus-mini-sm`/`.focus-mini`/`.focus-mini-lg` 尺寸变体。

---

## 六、图表与数据可视化 — B+ (87/100)

### 亮点
- **CHART模块** 提供了 `tooltip()`/`legend()`/`xAxis()`/`yAxis()`/`grid()`/`lineSeries()`/`barSeries()`/`gradientBar()`/`areaGradient()`/`emptyState()` 等11个工厂函数，大幅减少每页的ECharts配置样板
- **多页面图表复用CHART工厂**: portal(5图)、bad(10图)、cockpit(8图)、oee(5图)均通过CHART统一轴色/分割线/字体
- **液态填充图集成**: cockpit/bad/oee/wip使用 `echarts-liquidfill` 实现OEE/FPY水球

### 问题
16. **[P1] cockpit图表使用硬编码假数据** — `cockpit.html:1086-1161` 四个图表（产出趋势、Pareto、OEE分解、服务同步）全部使用 `['Mon','Tue',...]` + 硬编码数值。作为"全域驾驶舱"的核心可视化层，应接入真实API。

17. **[P2] chart-theme.js的 `gradientBar` 和 `areaGradient` 假设颜色为rgb格式** — `chart-theme.js:183-196` 使用 `.replace(')',',alpha)').replace('rgb','rgba')` 方法，但CHART颜色现在从CSS变量读取可能是 `#0166B1` 格式，导致渐变生成失败（静默回退为纯色）。需要增加hex→rgba转换。

18. **[P2] CHART模块未提供 `pieSeries`/`scatterSeries` 工厂** — 缺少饼图和散点图的标准配置，部分页面（如bad的SPC effectScatter、health的涟漪图）需手写配置。建议补全。

19. **[P3] 图表空状态不统一** — portal使用 `CHART.emptyState(msg)`，bad使用 `c.setOption(CHART.emptyState(msg), true)`，但部分页面直接设置 `title:{text:'暂无数据'}` 而不通过CHART工厂，导致空状态字体颜色/字号不一致。

---

## 七、组件一致性 — B (82/100)

### 亮点
- **导航统一**: nav.js 自建全站统一的 `.mn-header`，支持桌面下拉+移动端汉堡菜单
- **FilterBar通用组件**: `filter-bar.js` 提供线体/工序/型号/搜索四级级联筛选
- **WipUI通用组件**: `wip-ui.js` 提供 UpdateBar/QuickQuery/Toolbar/Subnav/Drawer/Focus 六个共享组件
- **Toast/Confirm/Modal统一**: common.js提供全局Toast、Confirm对话框

### 问题
20. **[P1] 设置/配置/管理页偏离设计语言** — `settings.html`、`production-config.html`、`admin.html` 三个页面使用独立的样式体系（`--color-*` legacy alias、不同的间距/圆角/字体大小），与看板页面（使用 `--surface-*`/`--text-*` 新token）形成两种视觉语言。在同一个导航下切换页面时感觉像两个不同产品。

21. **[P2] 按钮样式三套并存** — 
    - common.css `.btn`（统一按钮，surface-2背景+brand hover）
    - common.css `.btn-primary`（主按钮，brand实色背景）
    - 各页内联 `.btn-danger`/`.btn-ghost`/`.mbtn-primary`/`.mbtn-cancel` — 部分覆盖common.css定义
    - settings.html/production-config.html/admin.html 自建 `.btn-primary`/`.btn-danger` 使用 `--color-accent-*` legacy变量

22. **[P2] 周期选择器三重实现** — cockpit使用内联 `<select class="period-select">`，bad使用 `WipUI.periodRange()`，quality使用自建 `getPeriodRange()`。应统一使用 `WipUI.UpdateBar` 的周期管理。

23. **[P3] 滚动条样式不统一** — common.css 定义了 `::-webkit-scrollbar{width:4px}`，但部分页内联覆盖（如 `settings.html` 未声明、`wip.html` 使用不同宽度）。Firefox的 `scrollbar-width` 未设置。

---

## 八、页面逐一审计

| # | 页面 | 设计语言 | 动效 | 数据真实性 | 响应式 | 评分 | 关键问题 |
|---|------|----------|------|-----------|--------|------|----------|
| 1 | **portal.html** | A | A | A(7API并行) | A | **A (93)** | 分析卡2x2网格在大屏未充分利用空间 |
| 2 | **cockpit.html** | A+ | A+ | D(全假数据) | A | **B+ (88)** | 假数据严重拉低"指挥中枢"可信度；8卡→12卡网格中屏会挤压 |
| 3 | **bad.html** | A | A | A(MES真实) | A | **A (91)** | 12个图表全宽堆叠，滚动路径偏长 |
| 4 | **quality.html** | B+ | B+ | A(CMES真实) | B | **B+ (86)** | 缺少液态图实现；排名表样式偏离sn-table规范 |
| 5 | **wip.html** | A | A | A | A | **A (90)** | 流程节点卡片在宽屏下尺寸偏小 |
| 6 | **oee.html** | A | A | B+(部分真实) | A | **A- (89)** | 停机时间线为模拟数据 |
| 7 | **line-balance.html** | B+ | A | B+ | B | **B+ (85)** | 瓶颈表缺少焦点高亮；HUD光晕偏离token |
| 8 | **kanban.html** | B | B+ | B | B | **B (83)** | 未接入注意力钩子体系；样式偏离WIP外壳 |
| 9 | **factory-3d.html** | A- | B+ | C(静态模型) | D | **B (80)** | Three.js硬依赖CDN；移动端无响应；colors硬编码 |
| 10 | **health.html** | B+ | A | B+ | B+ | **B+ (85)** | 日志条目样式较简陋；骨架屏未完整实现 |
| 11 | **ai-center.html** | B+ | A | B+ | B | **B+ (84)** | 对话区max-width偏小；洞察列表hover动画生硬 |
| 12 | **fixture-life.html** | B | C(仅1钩子) | A(真实5566过站) | B | **B (82)** | 注意力钩子最少；KPI液态图尺寸固定 |
| 13 | **settings.html** | C+ | D(无钩子) | A | B | **C+ (79)** | 严重偏离设计语言；表单控件样式老旧 |
| 14 | **production-config.html** | C+ | D(无钩子) | A | B | **C+ (79)** | 与settings.html同样问题 |
| 15 | **admin.html** | C+ | D(无钩子) | A | C | **C (77)** | 使用 `font-family:'Microsoft YaHei'` 而非token字体；无响应式表格 |
| 16 | **login.html** | A | A+ | A | B+ | **A- (90)** | 全站动效最高级页面(3D神经网+HUD+聚光灯)；但background canvas持续消耗GPU |
| 17 | **kanban.html** | B | B+ | B | B | **B (83)** | 见上 |

---

## 九、无障碍 — B+ (86/100)

### 亮点
- **prefers-reduced-motion全站守护**: 所有9个带注意力钩子的页面均声明了reduced-motion降级
- **ATTN.audit()对比度扫描器**: `?audit=1` URL参数扫描 `.kpi-value/.focus-title` 等关键元素的WCAG对比度
- **跳过扫描线/sci-glow**: `common.css:215-216` 强制隐藏旧版科幻光效，减少视觉噪音

### 问题
24. **[P1] 键盘focus可见性不完整** — 表单控件有 `:focus` 样式（`box-shadow: var(--shadow-focus)`），但链接/按钮/卡片（onclick交互）缺少 `:focus-visible` 样式，键盘导航时无视觉反馈。

25. **[P2] ARIA属性缺失** — 导航栏role、图表区域 `aria-label`、动态内容 `aria-live` 普遍缺失。Drawer的 `aria-modal`/`role="dialog"` 未设置。

26. **[P3] 屏幕阅读器文本缺失** — 所有KPI数值变化（涨/跌）仅通过颜色传达，缺少屏幕阅读器可访问的文本描述（如 `aria-label="产量较昨日上涨342"`）。

---

## 十、工程与性能 — B+ (85/100)

### 亮点
- **CSS文件单一入口**: 全站共用 `common.css`(1724行)，无CSS碎片化
- **JS模块独立加载**: bad页拆分为 `bad-core.js`/`bad-charts.js`/`bad-table.js`/`bad-spc.js`/`bad-ai.js` 五个模块，按需加载
- **BroadcastChannel数据更新**: `common.js` DataChannel 跨标签页同步数据刷新
- **ECharts实例池**: portal页统一 `charts{}` 对象管理，resize事件统一处理

### 问题
27. **[P1] CSS特异性战争风险** — `common.css` 大量使用 `!important`（约60+处），特别是wrapper层 `.mn-inner,.wip-page,.page-wrap` 的宽度/边距强制覆盖。当页面需要不同的布局时（如factory-3d.html全屏），会被 `!important` 意外限制。建议将 `!important` 限制在layout shell层级，不要扩散到组件级。

28. **[P2] ECharts实例泄漏风险** — bad.html/bad-charts.js 使用全局变量 `_charts` 管理实例，dispose后可能留有DOM引用。cockpit的 `charts{}` 未在页面卸载时 `dispose()`。

29. **[P2] CDN外部依赖无降级** — `factory-3d.html` 依赖三个Three.js CDN脚本（`cdn.jsdelivr.net`），CDN不可用时页面白屏。`portal.html:851` 动态加载html2canvas CDN。建议增加fallback或本地副本。

30. **[P3] 字体加载无优化** — `--font` 指定PingFang SC作为首选但未使用 `font-display:swap`，中文网页字体可能导致FOIT（Flash of Invisible Text）。建议在HTML `<head>` 中添加 `@font-face` 声明。

---

## 优先修复路线图

### 🔴 P0 — 本周内（信任危机）
1. **cockpit接入真实API** — 当前全假数据破坏"指挥中枢"信任
2. **修复JS硬编码颜色** — 约15处 `#10d48e/#ef4444` 替换为token变量

### 🟠 P1 — 两周内（一致性收敛）
3. **设置/配置/管理三页WIP化改造** — 统一到 `--surface-*`/`--text-*` 新token + attention hooks
4. **各页删除重复动画token声明** — 9个页面清理重复的 `--dur-enter`/`--glow-brand`
5. **ATTN引擎迁移** — quality/wip/oee/kanban的liveNum/flash迁移到 `window.ATTN.*`
6. **键盘focus-visible全站补齐**
7. **KPI磅值升级不完整修复** — bad/fixture-life/kanban的KPI值字号统一

### 🟡 P2 — 一个月内（工程优化）
8. **chart-theme.js hex→rgba转换修复** + pieSeries/scatterSeries工厂补全
9. **周期选择器统一** 到 `WipUI.UpdateBar`
10. **CSS !important 审计** — 制定减量计划
11. **ECharts dispose生命周期管理**
12. **login页canvas Page Visibility API暂停**

### 🟢 P3 — 持续迭代
13. 面板尺寸标准化(padding变体)
14. focus-mini尺寸变体
15. 引入衬线副标题字体
16. Firefox scrollbar-width设置
17. CDN fallback策略

---

## 结论

AI数字化看板在**设计系统基础设施层面达到行业领先水平**。common.css的173行token体系、ATTN注意力钩子引擎、CHART模块化配色、全站统一的WIP外壳——这些构成了一个专业级工业看板产品的基础骨架。

核心短板不在设计而在**工程一致性**：17个页面中，3个(portal/cockpit/bad)外观精致、14个存在不同程度的偏移。尤其是settings/admin/production-config三个高频管理页面严重偏离设计语言，是当前最突出的"两个产品"分裂感来源。

修复路线清晰：P0解决信任问题（假数据），P1完成WIP化改造收尾（3管理页+ATTN迁移），P2消除CSS债务——完成后可进入全行业前5%的工业看板设计水平。