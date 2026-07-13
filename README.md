# AI生产数字看板 - 六环知识城整机加工厂

## 快速启动

双击 `启动看板.bat`，浏览器访问 http://localhost:8080

## 登录账号

- **MES账号**: yangning / Yn@20250908
- **管理员后门**: 登录页底部连点5次，输入Key: 12345678

## 技术架构

```
┌─────────────────────────────────────────────┐
│  前端 (HTML + ECharts + LiquidFill)         │
│  login → portal → dashboard/oee/bad/settings│
├─────────────────────────────────────────────┤
│  后端 (Node.js HTTP Server)                 │
│  认证 + API路由 + 定时同步                   │
├─────────────────────────────────────────────┤
│  数据库 (MongoDB Remote)                     │
│  10.50.55.39 / mes_dashboard / ai_前缀       │
├─────────────────────────────────────────────┤
│  数据源 (MES API via Puppeteer Cookie)       │
│  lh-cmes.cviauto.cn                         │
└─────────────────────────────────────────────┘
```

## 页面列表

| 页面 | 路径 | 功能 |
|------|------|------|
| 登录 | /login.html | 科幻风登录界面+AI对话 |
| 门户 | /portal.html | 导航入口 |
| 驾驶舱 | /dashboard.html | 领导驾驶舱(综合KPI+AI洞察) |
| OEE | /oee.html | 设备综合效率/MTBF/MTTR |
| 不良分析 | /bad.html | 直通率/误测率/PPM/Pareto |
| 配置 | /settings.html | 产线/产品/停机记录 |
| 后台 | /admin.html | 系统管理 |

## API列表

| 路径 | 方法 | 说明 |
|------|------|------|
| /api/login | POST | 登录认证 |
| /api/admin-login | POST | 管理员登录 |
| /api/dashboard | GET | 看板综合数据 |
| /api/oee | GET | OEE计算结果 |
| /api/bad | GET | 不良维修数据 |
| /api/production | GET | 产出统计 |
| /api/task-orders | GET | 工单列表 |
| /api/lines | GET/POST | 产线配置 |
| /api/products | GET/POST | 产品配置 |
| /api/downtime | GET/POST | 停机记录 |
| /api/sync | GET | 触发MES数据同步 |
| /api/db-info | GET | 数据库统计 |

## 数据同步

- 启动时自动同步当天数据
- 每5分钟自动增量同步
- 手动触发: GET /api/sync?date=2026-05-30

## 目录结构

```
├── .env                 # 环境变量(MongoDB/MES账号)
├── server.js            # Node.js服务(认证+路由+同步)
├── db.js                # MongoDB数据层(OEE计算)
├── 启动看板.bat          # 一键启动
├── package.json
└── frontend/dist/       # 前端页面
    ├── login.html       # 登录
    ├── portal.html      # 门户
    ├── dashboard.html   # 驾驶舱
    ├── oee.html         # OEE专题
    ├── bad.html         # 不良分析
    ├── settings.html    # 配置管理
    ├── admin.html       # 后台管理
    ├── common.css       # 统一样式
    ├── common.js        # 公共逻辑
    ├── nav.js           # 导航组件
    ├── filter-bar.js    # 筛选栏
    ├── libs/            # ECharts等库
    └── images/          # 图标资源
```
