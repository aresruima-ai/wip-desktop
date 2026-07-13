# AI看板运维管理器

用 Python 守护 Node.js 看板后端 + Edge 投屏，让工厂大屏 7×24 稳定跑，不用人盯。

## 它管什么

| 职责 | 说明 |
|------|------|
| **Node 进程守护** | 拉起 `node server.js`，崩了指数退避重启（5→10→20→30s），连续崩 8 次进熔断冷却 5 分钟 |
| **探活自愈** | 每 15s 探 `/api/health`，连续 3 次失败自动重启 Node；MES Cookie 丢失只告警不重启（重启没用，要重新登录 MES） |
| **投屏管理** | Edge kiosk 全屏打开 `portal.html`，窗口消失自动重开，每天 03:17 定时重开防内存泄漏 |
| **托盘常驻** | 右下角图标，右键：重启看板 / 重启投屏 / 暂停守护 / 打开页面 / 打开日志 / 退出 |
| **日志轮转** | `logs/manager.log` 5MB 轮转留 7 份 |
| **可选告警** | 配 webhook 后，崩溃/熔断/Cookie失效/探活失败发钉钉/企微（同类 600s 去重） |
| **开机自启** | `install_startup.bat` 装到启动项，断电恢复自动拉起 |

## 文件结构

```
dashboard_manager/
├── manager.py          # 入口：串联所有模块 + 信号处理 + 优雅退出
├── config.py           # 加载校验 config.yaml，解析相对路径
├── log.py              # 日志（控制台 + 轮转文件）
├── state.py            # 线程安全共享状态
├── alert.py            # webhook 告警 + 去重
├── proc_guard.py       # ① Node 进程守护线程
├── watchdog.py         # ② 探活自愈线程
├── screen_kiosk.py     # ③ 投屏浏览器管理线程
├── tray.py             # ④ 系统托盘
├── config.yaml         # 配置
├── requirements.txt    # 依赖
├── run.vbs             # 静默启动（无黑窗）
├── install_startup.bat # 装开机自启
├── uninstall_startup.bat
├── CONTRACTS.md        # 接口契约（模块间唯一真相源）
└── _verify_manager.py  # 端到端验证脚本
```

## 安装依赖

```bash
cd dashboard_manager
python -m pip install -r requirements.txt
```

依赖：`psutil` `pystray` `pillow` `pyyaml` `requests`。需要 Python 3.8+（开发验证用 3.8.6）。

## 启动

**方式一（推荐，工厂机）**：双击 `run.vbs`（静默无黑窗），托盘出图标即运行。
**方式二**：命令行 `pythonw manager.py`。
**方式三（开机自启）**：双击 `install_startup.bat`，以后开机自动起。取消跑 `uninstall_startup.bat`。

退出：托盘右键 → 退出（会优雅停掉所有守护线程并杀 Node；投屏窗口保留显示）。

## 配置（config.yaml）

关键项：

```yaml
node:
  command: ["node", "server.js"]     # 看板启动命令
  cwd: ".."                           # 项目根（本目录上级）
  env_file: "../.env"                 # 注入子进程环境
  restart:
    backoff_sec: [5, 10, 20, 30, 30, 30]
    max_consecutive_crashes: 8        # 连续崩这么多次 → 熔断
    cooldown_sec: 300

watchdog:
  health_url: "http://127.0.0.1:8080/api/health"
  interval_sec: 15
  failure_threshold: 3                # 连续失败这么多次才重启
  cookie_loss_alert: true             # Cookie 丢失告警（不重启）

kiosk:
  url: "http://localhost:8080/portal.html"
  browser: "edge"                     # edge | chrome
  browser_path: null                  # null=自动探测；找不到时填绝对路径
  daily_reload_time: "03:17"

alert:
  enabled: false                      # true 后填 webhook 才发
  webhook: null                       # 钉钉/企微机器人地址
  min_interval_sec: 600
```

路径相对 `dashboard_manager/` 解析。

## 日志

- `logs/manager.log` — 管理器自身日志（轮转）
- `logs/node.stdout.log` — Node 后端 stdout/stderr（追加）

托盘右键「打开日志目录」直接打开。

## 故障排查

| 现象 | 排查 |
|------|------|
| Node 反复崩、托盘显示「熔断」 | 看 `logs/node.stdout.log`；常见是 8080 被占（EADDRINUSE）或 MongoDB/MES 连不上。熔断 5 分钟后自动恢复 |
| 托盘显示「运行中」但大屏白屏 | 大概率 MES Cookie 失效，看日志有无「Cookie 已失效」告警，去登录页重新登录 MES |
| 投屏没起来 | 确认 Edge 已装；或在 config 填 `kiosk.browser_path` 绝对路径 |
| 托盘图标颜色 | 绿=运行中 / 红=熔断 / 灰=已停止 |
| 想暂停自愈 | 托盘右键「暂停守护」（muted 期间不拉起不探活，方便手动处理） |

## 打包成 exe（可选，免装 Python）

```bash
pip install pyinstaller
pyinstaller --noconsole --onefile manager.py
# 产物 dist/manager.exe，连同 config.yaml 一起放现场
```

## 验证

```bash
python _verify_manager.py   # 41 项逻辑断言，不启动真 Node/Edge
```
