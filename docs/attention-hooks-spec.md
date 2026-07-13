# AI 数据看板 · 注意力钩子设计规范 (Attention Hooks Spec)

> 全站从"大卡片大文字的尺寸堆砌"转向"注意力工程"的纲领。
> 源自 8 分身深度研发：6 技术栈研究（原生CSS/JS动效 · ECharts视觉 · 3D/WebGL · 数据活力 · 微交互感知 · 注意力设计理论）+ 总设计师合成 + 驾驶舱标杆蓝图。
> 所有方案基于原生技术栈（无框架无构建 · ECharts 5 + liquidfill · WebSocket · 暗色默认），代码可直接粘贴运行。

---

## 心法

**做减法降权 → 衬托焦点 → 让焦点活起来。**

"大"是显眼不是吸引。注意力靠**势能差与张力**勾引视线，不靠尺寸堆砌。先让周边安静下来，单一焦点才浮得起；再让焦点带着生命感呼吸跳动。绝不堆满钩子——所有元素都抓人等于没抓人，那是另一种"大声喊叫"。

---

## 一、8 条设计准绳

### 1. 做减法优先：先降权周边，再点亮焦点（势能差而非尺寸堆砌）
- **理由**：当前病根是"全是大卡"——同明度、同尺寸、同动效的卡片互相竞争，注意力被均摊稀释。人眼靠"差异梯度"聚焦，不是靠"谁更大声"。
- **执行**：每屏只允许 1 个 `data-focal=true` 元素；JS（`enforceFocal`）自动给同壳层兄弟节点加 `filter: brightness(.84) saturate(.7)`，焦点卡径向高光 +1px 顶辉光 +`translateY(-2px)`。明度差锁定 12%——刚好越过人眼 JND 又不过曝。多焦点场景按左右半屏各 1 个分区，明度差 ≥8%。

### 2. 强调色 1+1 稀缺调度：危险永远在，警告最多 2，成功只留 1
- **理由**：暗色背景上高饱和色灼烧视网膜，多个并列则互相抵消成"彩色噪音"。把强调色当稀缺资源，出现即意味"这里必须看"。
- **执行**：`enforceAccentScarcity()` 在 load + WS 推送后（500ms 节流）扫描全页 danger/warning/success 用量：danger 全留（安全优先），warning 超 2 处把视口外的降级为 `.accent-muted`（saturate .15），success 只留首屏第一处。其余数据走 S≤30% 灰阶色域。

### 3. 动效三段节奏：入场一次性、呼吸常态、触发瞬时——三者绝不混周期
- **理由**：动效本质是"时间维度的对比"。若所有元素都在动，动等于不动。三段分离让"持续呼吸"成低噪底，"触发"才能在底噪中突变被前额叶捕获。
- **执行**：CSS token 强制分区——`--dur-enter`(280ms ease-out 1次)、`--dur-breath`(2.6-3.6s ease-in-out infinite)、`--dur-hit`(150ms 带过冲)。呼吸走 transform/opacity 合成层；触发用 Web Animations API 一次性播放后清理。同元素同时只挂一种节奏，`pulse-hit` 200ms 防抖避免连击。

### 4. 数据活起来：数字滚动 + 方向闪光，只在真变时发生
- **理由**：实时看板核心张力是"数据在动"。死数字→textContent 赋值是视觉断层；滚动 + 涨绿跌红闪光让每次 WS 推送成为微事件，200ms 内完成"变了↔变好/坏"双重判断。
- **执行**：统一 `LiveNum.animate(el, val, {format, dur:850, easing:easeOutExpo})` 替换全站 setKPI 内的 `el.textContent=value`；`flashNode(el, old, new)` 在 WS onMessage 路由按 `data.id` 触发，500ms 内同节点 debounce。闪光用 background+box-shadow keyframe 900ms 自动消退，不持续占注意力。

### 5. Z 轴景深替代尺寸差：浮起靠阴影深度 + 明度阶差，不靠变大
- **理由**：尺寸堆砌让所有卡同等重要；真实世界注意力靠"近大远小+明暗"分层。
- **执行**：`z-focal`(shadow-3 + surface-1-hi + translateY-2px) / `z-data`(shadow-1 + surface-1) / `z-base`(none + surface-0) 三层。单一光源左上 45°（`--light-depth-1/2/3`）。full-stack 容器内 JS 自动把首卡升 focal、末卡降 base。hover 时该层向上一层靠拢，制造可探索暗示。

### 6. 对比必须达阈值，否则不算强调
- **理由**：阈值以下的"强调"在暗色低饱和环境里会被背景吞掉，反而增噪。量化后杜绝主观判断。
- **执行**：硬阈值——明度对比 ≥4.5:1（WCAG AAA）、焦点元素尺寸 ≥全页最大字号 0.6x、强调色元素必须带动效或边框二选一。`?audit=1` 开发期校验器扫描全页 `.kpi-value/.focus-title/.kpi-change`，不达标红框 + console.warn。上线前每页过一遍。

### 7. 钩子密度克制：一屏同时运行的动画 ≤5-6 个，每页只配 2-3 个强钩子
- **理由**：钩子满铺变成另一种"大声喊叫"。克制美学要求动效是点缀而非炫技。
- **执行**：每页 primaryHooks 限 2-3 个（投屏 3 米外可见的强信号），secondaryHooks 限 2-4 个（近场细节）。常驻呼吸动画（radarSweep/orbAlarm/heartbeat）每屏 ≤3 个；effectScatter/custom 流光等高耗图每页 ≤2 图；`prefers-reduced-motion` 全程 @media 守护降级为静态色变。

### 8. 对比靠留白配比托举，不靠边框加粗
- **理由**：留白是隐形钩子——用户不会"看到"留白但会"感到"舒展和层次。1:3 焦点留白律让焦点从"被堆叠"变成"被托举"。
- **执行**：`balanceWhitespace()` 测留白比：focal 6:1、data 3:1、base 2:1，不足自动补 padding（上限 1.4x 避免破布局）。同级卡间距 ≤自身宽 1/4（关联），跨层级 ≥1/2（分割）。触屏/窄屏（<900px）关闭 gaze-river 明度河流，避免阶差失效。

---

## 二、动效 Token 体系（20 个，注入 common.css :root）

### 时长 / 缓动（三段节奏）
| Token | 值 | 用途 |
|------|----|------|
| `--dur-enter` | 280ms | 入场动效（reveal cascade / sweep 光流），ease-out 1次性 |
| `--dur-breath` | 2.8s | 常态呼吸周期（radarSweep/orbWarn/liquidfill wave），ease-in-out infinite |
| `--dur-breath-fast` | 0.8s | 报警态快脉冲（orbAlarm/edgePulse），频率编码警觉级别 |
| `--dur-hit` | 150ms | 触发动效（pulse-hit/flash-on-change/磁吸回弹），带过冲 |
| `--ease-hit` | cubic-bezier(0.34,1.56,0.64,1) | 触发过冲缓动，"弹一下"的物理感 |
| `--ease-expo` | cubic-bezier(0.16,1,0.3,1) | 数字滚动/入场专用（easeOutExpo 等价） |

### 辉光（克制使用，暗色看板唯一允许的 glow）
| Token | 值 | 用途 |
|------|----|------|
| `--glow-brand` | 0 0 18px rgba(1,102,177,.45) | 品牌色辉光（焦点卡顶辉光/雷达环/磁吸按钮 hover） |
| `--glow-success` | 0 0 16px rgba(16,185,129,.40) | 涨势/正常态（flash-up/liquidfill 正常色） |
| `--glow-danger` | 0 0 18px rgba(239,68,68,.45) | 报警（flash-down/orbAlarm/Alert Sweep/EdgeAlarm） |
| `--glow-amber` | 0 0 14px rgba(245,158,11,.38) | 预警（orbWarn/markLine 脉冲/瓶颈光环） |

### Z 轴景深（单一光源左上 45°）
| Token | 值 | 用途 |
|------|----|------|
| `--light-depth-1` | 0 8px 24px rgba(0,0,0,.50), 0 2px 6px rgba(0,0,0,.30) | z-focal 焦点卡投影 |
| `--light-depth-2` | 0 3px 10px rgba(0,0,0,.35), 0 1px 3px rgba(0,0,0,.20) | z-data 数据卡投影 |
| `--light-depth-3` | 0 1px 2px rgba(0,0,0,.20) | z-base 衬底投影（近无阴影，退后感） |

### 稀缺调度 / 其他
| Token | 值 | 用途 |
|------|----|------|
| `--focal-dim` | brightness(0.84) saturate(0.70) | 焦点激活时兄弟节点压暗滤镜，12% 明度差势能 |
| `--accent-muted-sat` | 0.15 | 稀缺调度降级饱和度（.accent-muted） |
| `--halo-radius` | 220px | 光标跟随光晕半径 |
| `--scan-period` | 3.6s | 雷达/全息扫描线周期，统一常驻扫描节奏 |
| `--stagger-step` | 40ms | reveal cascade 错峰步长，上限 min(i%6*40,200)ms |
| `--ring-circumference` | 62.83px | BeatBar 倒计时环 SVG dasharray（2πr, r=10） |
| `--edge-alarm-width` | 3px | EdgeAlarm 边缘红光条厚度，fixed 四边 |

---

## 三、钩子目录（32 个）

### 对比类（破"全是大卡"第一招）
1. **焦点单点高光晕** Lone Spotlight — 全页唯一 `data-focal` 卡径向高光+顶辉光+微抬升，兄弟节点自动压暗成衬底
2. **强调色 1+1 稀缺调度** Scarlet Accent — JS 扫描全页强调色用量，超阈值视口外降级灰阶
3. **Z 轴景深层级** Depth Strata — z-focal/z-data/z-base 三层靠阴影+明度阶差模拟景深
4. **历史对比虚影** Ghost Overlay — KPI 旁叠半透明"昨日 N"，超则虚影下沉淡出，未超则上浮高亮
5. **对比阈值校验器** Contrast Auditor — `?audit=1` 扫描强调元素明度/尺寸/动效，不达标红框

### 活力类（让数据活起来）
6. **数字滚动引擎** LiveNum countUp — RAF+easeOutExpo 平滑爬值，支持千分位/小数/百分号，复用 setKPI 全站生效
7. **WS 推送瞬时跳变高亮** flash-on-change — 收新值闪一帧：涨绿/跌红/平蓝，900ms 自动消退，500ms debounce
8. **三态呼吸光效** Status Orb — 正常静止绿/预警 2s 慢呼吸 amber/报警 0.8s 快脉冲 red+扩散环
9. **边缘红光告警** Edge Alarm Bar — 越阈值时 viewport 四边 3px 红色呼吸条+顶部 toast，余光可感知
10. **心跳节拍器+倒计时环** BeatBar — 顶栏 liveDot：WS 心跳弹一下+SVG 环形倒计时显示距下次刷新
11. **骨架屏 Shimmer** — fetch 期间覆盖骨架层，光流横扫 1.8s，数据到达淡出
12. **OEE 雷达扫描环** Radar Ring — conic-gradient 环形进度+缓慢旋转扫描扇区，`@property` 注册可动画
13. **liquidfill 呼吸水球 KPI** — 百分比 KPI 升级为水球，三层波形动画，水位=百分比，阈值色变
14. **实时 appendData 流式增长** — WS 推送增量追加新点，旧点左滑，dataZoom 跟随，曲线右端长新尾巴
15. **3D Shader 辉光呼吸工位** — factory-3d 工位 fresnel 边缘自发光+sin(time) 呼吸，过载急促喘气转红

### 层次类（信息层次重构）
16. **卡片错峰级联入场** Reveal Cascade — IO 监听卡片进视口，按 index 40-55ms 错峰 translateY+opacity 入场
17. **graphic 径向光晕打光最差柱** — 柱图最差项后方叠 RadialGradient 光晕，该柱浮起其余灰化退后
18. **顶栏滚动进度标尺** Scroll Ruler — `animation-timeline: scroll()` 让 brand 色高亮随页面向右生长
19. **3D 体积光锥投光瓶颈** — 半透明圆锥+AdditiveBlending+噪声 shader 模拟投光灯柱，告警点击光锥飞向新瓶颈
20. **2D↔3D 光柱连线** Light Bridge — 告警卡 hover 时 SVG 贝塞尔光柱射向 3D 工位，跨维度整体感

### 动效类（微交互与流光）
21. **effectScatter 异常点涟漪** — 折线/柱图叠加 effectScatter，只放 1-2 个最差点持续涟漪，静态图海唯一动点
22. **custom series 流光粒子** — renderItem 画 1 个沿曲线移动的发光头，模拟"数据在管道流动"
23. **markLine 脉冲阈值线** — SPC UCL/LCL、OEE 目标线加呼吸色带，持续提醒"我在盯这条红线"
24. **瓶颈流光+旋转光环** Flow Stream — 产线主管道叠加沿流向流动光带，瓶颈节点 conic 旋转光环
25. **告警边框追光扫描** Alert Sweep — 告警卡 conic-gradient+mask 沿边框跑高亮光带，替代整框闪烁
26. **光标跟随光晕** Cursor Spotlight — 卡片 mousemove 写入 --mx/--my，radial-gradient 跟随光标柔光晕
27. **状态切换光流** State Sweep — tab/筛选切换时顶部注入品牌色光条横扫 520ms，扫过处内容淡入
28. **3D 空闲巡游+鼠标视差** — 8 秒无操作相机椭圆环绕，鼠标叠加微小视差，任意交互打断
29. **3D 数据驱动震颤+扫描线** — 过载工位垂直微震颤±0.03+红色扫描线从底向上扫，高度随 count 缓动
30. **3D 全息扫描线 Floor+Glitch** — 地面 shader 水平扫描线网格+RGB 色散，每 25s 触发 0.3s glitch

### 交互类
31. **dispatchAction 跨图联动** — 悬停主图某点→副图对应点 highlight+showTip，其余 downplay，"主图说话副图回应"
32. **3D Hover 描边+X 光透视** — raycast 命中后法线外扩 BackSide 描边+前方遮挡工位降透明 0.15，"破墙而出"

---

## 四、4 阶段落地计划

### Phase 1 — 地基与全站通用钩子（1 周）
**目标**：建立"做减法降权→衬托焦点→让焦点活起来"的演进基底。在 common 层注入全站通用钩子，cockpit 作为标杆页满配示范，portal/design-master 同步落地。
- **页面**：common.css/common.js（全站注入）、cockpit.html、portal.html、design-master.html
- **钩子**：焦点单点高光晕、强调色稀缺调度、Z 轴景深、数字滚动引擎、WS 跳变高亮、卡片错峰级联入场、光标跟随光晕、心跳节拍器、对比阈值校验器

### Phase 2 — 实时监控类页面（1.5 周）
**目标**：把"看板"变"监控"。实时页配流式增长+异常涟漪+水球+雷达环；对比页配光晕打光+脉冲阈值+联动；告警页配 Alert Sweep+EdgeAlarm。
- **页面**：dashboard、line-monitor、wip、oee、**bad（已自主落地）**、health
- **钩子**：appendData 流式增长、effectScatter 涟漪、custom 流光、liquidfill 水球、雷达环、markLine 脉冲、光晕打光最差柱、跨图联动、瓶颈流光、Alert Sweep、EdgeAlarm、三态呼吸、历史对比虚影、骨架屏

### Phase 3 — 3D 数字孪生深度（1 周）
**目标**：把静态 3D 模型变"活的数字孪生"。Shader 辉光工位锁死视线，体积光锥聚光换主角，震颤+扫描线过载隐喻，2D↔3D 光柱跨维度整体感。
- **页面**：factory-3d.html
- **钩子**：3D Shader 辉光呼吸、3D 体积光锥、3D 空闲巡游+视差、3D Hover 描边+X 光、3D 震颤+扫描线、3D 全息 Floor+Glitch、2D↔3D 光柱连线

### Phase 4 — 辅助页与收口（0.5 周）
**目标**：辅助页克制配钩子维持全站一致性。操作型只配切换光流+骨架+轻 hover；展示型配焦点高光+stagger+三态。上线前每页过 `?audit=1`。
- **页面**：line-balance、kanban、ai-center、admin、settings、production-config、login
- **钩子**：状态切换光流、卡片错峰级联入场、骨架屏、三态呼吸、光标跟随光晕、磁吸焦点、Z 轴景深

---

## 五、实施纪律

- **焦点唯一**：每屏 1 个 `data-focal=true`，JS 自动压暗兄弟节点
- **密度克制**：一屏同时动画 ≤5-6；每页 primaryHooks 2-3、secondaryHooks 2-4；常驻呼吸 ≤3/屏；effectScatter/custom 流光 ≤2 图/页
- **强调色稀缺**：danger 全留、warning ≤2、success 仅首屏第一处，超阈值降级灰阶
- **动效三段不混周期**：入场 280ms / 呼吸 2.8s / 触发 150ms，同元素同时只挂一种
- **无障碍**：`prefers-reduced-motion` 全程 @media 守护，降级为静态色变；LiveNum/animate 检测并跳过
- **性能**：动效走 transform/opacity/box-shadow 合成层，零重排；effectScatter 走 ECharts 内置 GPU 路径
- **审计**：`?audit=1` 开发期校验明度对比 ≥4.5:1、焦点尺寸 ≥最大字号 0.6x、强调色必带动效/边框
- **Z 轴景深**：浮起靠阴影深度+明度阶差，不靠变大；单一光源左上 45°
- **留白托举**：focal 6:1、data 3:1、base 2:1，对比靠留白不靠边框加粗

---

## 附：技术栈约束
- 纯原生 HTML/CSS/JS，无框架无构建（直接编辑 `frontend/dist/`）
- ECharts 5 + echarts-liquidfill；WebSocket 实时推送；Poppins 字体；PWA
- 暗色默认（强制不跟随系统）；复用现有 CSS 变量与 `--kpi-color`/`setKPI` 路径
- 共享文件 `common.css/common.js/chart-theme.js/nav.js/filter-bar.js` 的改动须统一收口，禁止多分身并发写
