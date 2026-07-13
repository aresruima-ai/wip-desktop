# AI看板运维管理器 — 接口契约

> 本文件是所有 Python 模块的**唯一接口真相源**。生成代码时类名/函数名/签名/字段名必须与此完全一致；实现细节可自行决定，但不得违反此处的约定与不变量。

## 1. 概述

守护一个 Node.js 看板后端（`server.js`，端口 8080）+ Edge/Chrome kiosk 投屏，7×24 运行。职责：
1. 守护 Node 进程：崩了拉起，指数退避，连续崩溃熔断冷却。
2. 探活自愈：连续 N 次 `/api/health` 失败 → 重启 Node；MES Cookie 丢失只告警不重启（重启无用）。
3. 投屏管理：Edge kiosk 全屏，窗口消失自动重开，每天定时重开防内存泄漏。
4. 托盘常驻：右键菜单重启看板/重启投屏/暂停守护/打开页面/打开日志/退出。
5. 日志轮转 + 可选 webhook 告警 + 开机自启。

模块文件（均位于 `dashboard_manager/`）：
`config.py` `log.py` `state.py` `alert.py` `proc_guard.py` `watchdog.py` `screen_kiosk.py` `tray.py` `manager.py`

配置：`config.yaml`（同目录）。辅助：`requirements.txt` `run.vbs` `install_startup.bat`。

## 2. 运行环境

- Windows 10/11，**Python 3.8+**（系统装有 3.8.6 与 3.14，代码须兼容 3.8）。
- 因此：类型注解用 `from __future__ import annotations` 置于文件顶部，可用 `int | None` 写法（注解延迟求值，不报错）；**不要**在运行时上下文（isinstance、变量默认赋值的真值处）依赖 `X | Y`。
- 第三方依赖仅限：`psutil` `pystray` `pillow` `pyyaml` `requests`；其余用标准库。

## 3. 路径与配置约定

- `CONFIG_DIR` = `os.path.dirname(os.path.abspath(config.yaml 路径))` = `dashboard_manager/`
- `PROJECT_ROOT` = `os.path.dirname(CONFIG_DIR)` = `AI数据看板/`
- `config.py::load_config()` 须把 `config.yaml` 中以下相对路径字段解析为**绝对路径**（基于 `CONFIG_DIR`）：`node.cwd`、`node.env_file`、`log.dir`。若原值为 `null` 则保持 `None`。
- 在返回的 dict 中注入元字段 `_config_dir`、`_project_root`，供其他模块引用。
- 其他模块从 `cfg` 读取上述字段时，它们**已是绝对路径**，直接使用即可。

## 4. config.yaml schema（字段 → 类型 → 默认）

```
node.command            list[str]   必填非空
node.cwd                str|None    解析为绝对
node.env_file           str|None    解析为绝对; None=不加载
node.restart.backoff_sec        list[int]   必填非空, 元素>0
node.restart.max_consecutive_crashes int    默认 8
node.restart.cooldown_sec       int         默认 300

watchdog.enabled                bool        默认 True
watchdog.health_url             str         默认 http://127.0.0.1:8080/api/health
watchdog.interval_sec           int         默认 15
watchdog.failure_threshold      int         默认 3, >=1
watchdog.timeout_sec            int         默认 8
watchdog.grace_after_start_sec  int         默认 30
watchdog.cookie_loss_alert      bool        默认 True

kiosk.enabled                   bool        默认 True
kiosk.url                       str         默认 http://localhost:8080/portal.html
kiosk.browser                   str         "edge"|"chrome"
kiosk.browser_path              str|None    None=自动探测
kiosk.check_interval_sec        int         默认 30
kiosk.daily_reload_time         str         "HH:MM"

log.dir                         str         解析为绝对
log.max_bytes                   int         默认 5MB
log.backup_count                int         默认 7

alert.enabled                   bool        默认 False
alert.webhook                   str|None    None=仅本地日志
alert.min_interval_sec          int         默认 600

tray.enabled                    bool        默认 True
tray.title                      str         默认 "AI看板管理器"
```

`load_config` 必须对**部分配置健壮**：缺失的整段用默认 dict 补齐；缺失的子字段补默认。仅当 `node.command` 为空 list、`backoff_sec` 为空/含非正数、`failure_threshold<1` 时抛 `ValueError`（带清晰中文消息）。

## 5. 日志规范（log.py）

- `setup_logging(cfg: dict) -> logging.Logger`：配置名为 `manager` 的 logger。
- 文件：`{cfg['log']['dir']}/manager.log`，`RotatingFileHandler(maxBytes=cfg['log']['max_bytes'], backupCount=cfg['log']['backup_count'], encoding='utf-8')`。目录不存在则 `os.makedirs`。
- 同时加 `StreamHandler` 输出到 stdout。
- 格式：`"%(asctime)s [%(levelname)s] %(name)s: %(message)s"`，级别 INFO。
- `logger.propagate = False` 避免重复输出。
- 返回 `logging.getLogger('manager')`。各子模块可用 `logging.getLogger('manager.<module>')` 或直接用传入的 `log` 参数。

## 6. 共享状态 ManagerState（state.py）

线程安全的共享状态容器。访问字段应持 `self.lock`（`threading.RLock`，可重入）。

```python
class ManagerState:
    def __init__(self):
        self.lock = threading.RLock()
        self.node_proc: subprocess.Popen | None = None
        self.node_pid: int | None = None
        self.node_started_at: float | None = None        # time.time()
        self.restart_count: int = 0                       # 累计成功重启次数
        self.consecutive_crashes: int = 0                 # 连续崩溃计数
        self.circuit_open: bool = False
        self.circuit_until: float | None = None           # 熔断恢复时间戳
        self.last_health_ok: bool | None = None
        self.last_health_at: float | None = None
        self.health_fail_streak: int = 0
        self.last_has_cookie: bool | None = None
        self.muted: bool = False                          # 暂停守护(托盘切换)
        self.kiosk_pid: int | None = None
        self.last_alert_at: dict = {}                     # kind -> time.time(), 告警去重

    def node_status(self) -> str:        # "运行中" | "已停止" | "熔断"
        ...
    def record_crash(self) -> None:      # consecutive_crashes += 1
        ...
    def reset_crashes(self) -> None:     # consecutive_crashes = 0
        ...
    def should_alert(self, kind: str, min_interval: float) -> bool:
        # 去重判断: 若 kind 在 last_alert_at 且 now-last < min_interval 返回 False; 否则更新 last_alert_at[kind]=now 并返回 True
        ...
```

`node_status()` 逻辑：`circuit_open` 为真且 `time.time() < circuit_until` → "熔断"；`node_proc is not None and node_proc.poll() is None` → "运行中"；否则 "已停止"。需持锁。

## 7. 各模块规格

### 7.1 config.py
- `load_config(path: str) -> dict`：见 §3 §4。
- `resolve(cfg: dict, path: str) -> str`：便捷函数，相对路径基于 `cfg['_config_dir']` 解析为绝对；已是绝对则原样返回。

### 7.2 log.py
- `setup_logging(cfg: dict) -> logging.Logger`：见 §5。

### 7.3 state.py
- `class ManagerState`：见 §6。

### 7.4 alert.py
- `class Alerter`
  - `__init__(self, cfg: dict, state: ManagerState, log: logging.Logger)`：读 `cfg['alert']`。
  - `notify(self, kind: str, message: str) -> None`：
    - 去重前置：`state.should_alert(kind, min_interval_sec)` 为 `False` 则跳过（**无论是否启用**，避免 disabled 时每轮调用刷屏）。
    - `not enabled` 或 `webhook is None` → 仅 `log.info` 后返回。
    - 发送：`requests.post(webhook, json={"msgtype":"text","text":{"content": f"[AI看板] {message}"}}, timeout=5)`。
    - 整个方法 `try/except Exception`，任何异常仅 `log.warning`，**不抛**。

### 7.5 proc_guard.py — `class NodeGuard(threading.Thread)`
- `__init__(self, cfg, state, log, alerter)`：`super().__init__(daemon=True, name='NodeGuard')`；`self.stop_event = threading.Event()`；读取 `cfg['node']`（command, cwd, env_file, restart.*）。
- `run(self)`：主循环 `while not stop_event.is_set()`：
  - `state.muted` 为真 → `stop_event.wait(2)` 继续（暂停守护不拉起）。
  - 熔断中（`state.circuit_open and time.time() < state.circuit_until`）→ `stop_event.wait(10)` 继续。
  - 进程不在（`node_proc is None or node_proc.poll() is not None`）：
    - 若之前有进程（刚崩）→ `state.record_crash()`。
    - 若 `consecutive_crashes > max_consecutive_crashes`：开熔断 `circuit_open=True`、`circuit_until=time.time()+cooldown_sec`，`alerter.notify('circuit', ...)`，`stop_event.wait(10)` 继续。
    - 否则计算退避 `wait_sec = backoff[min(consecutive_crashes-1, len-1)]`（首次启动 consecutive_crashes=0，退避 0 即 `backoff[0]`？约定：**首次启动不退避直接拉起**；崩溃后再起的退避用 `backoff[min(consecutive_crashes-1, len-1)]`），`stop_event.wait(wait_sec)` 后 `_launch()`。
  - 进程在：若稳定运行超 60s 且 `consecutive_crashes>0` → `state.reset_crashes()`；`stop_event.wait(2)`。
  - 整个循环体 `try/except Exception`：异常 `log.error` + `stop_event.wait(5)`。
- `_launch(self) -> None`：构造 `env = os.environ.copy()`；若 `env_file` 存在，解析 `KEY=VALUE`（跳过 `#` 注释与空行）注入。`Popen(command, cwd=cwd, env=env, stdout=<追加打开 node.stdout.log>, stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NO_WINDOW)`。stdout 文件放 `cfg['log']['dir']/node.stdout.log`，以 `'ab'` 打开（注意：长期持有句柄，可在 `_launch` 内打开并在新进程结束后由 GC；或保存到 `self._node_log_fh`，下次 `_launch` 前关闭）。更新 `state.node_proc/pid/node_started_at`，`state.restart_count += 1`，`log.info` + `alerter.notify('restart', ...)`。`try/except`：启动失败 `log.error` + `alerter`，不抛。
- `restart(self, reason: str) -> bool`：外部触发（托盘/watchdog）。持锁 terminate 当前进程（`terminate()`，等最多 5s，仍活 `kill()`），置 `node_proc=None`，`state.reset_crashes()`（手动重启视为期望行为），`_launch()`。返回是否成功启动（`node_proc` 非 None 且 `poll() is None`）。耗时操作可在调用方新起线程。
- `stop(self) -> None`：`stop_event.set()`；若 `node_proc` 活着 `terminate`+`kill`。

不变量：退避序列用尽后保持末值；熔断恢复后 `consecutive_crashes` 重置为 0 重新计数（在 `run` 检测到熔断到期时置 `circuit_open=False` 并 `reset_crashes()`）。

### 7.6 watchdog.py — `class Watchdog(threading.Thread)`
- `__init__(self, cfg, state, log, guard: NodeGuard, alerter)`：`super(daemon=True, name='Watchdog')`；`stop_event=Event()`；读 `cfg['watchdog']`。
- `run(self)`：`not enabled` 直接 return。启动先 `stop_event.wait(grace_after_start_sec)` 宽限。`while not stop_event.is_set()`：
  - `try`：
    - `state.muted` 或 `state.circuit_open` → 跳过探活。
    - `r = requests.get(health_url, timeout=timeout_sec)`；`ok = r.status_code < 500` 且 JSON `status=='ok'`。
    - 持锁更新 `last_health_ok/last_health_at`；解析 `hasCookie` 存 `last_has_cookie`。
    - `ok`：`health_fail_streak = 0`。若 `cookie_loss_alert and not hasCookie`：`alerter.notify('cookie', 'MES Cookie 已失效, 数据API将无返回, 请重新登录MES')`（去重保证不刷屏）。
    - `not ok`：`health_fail_streak += 1`；若 `>= failure_threshold`：`log.warning` + `alerter.notify('health', ...)` + `guard.restart('watchdog: health连续失败')` + 持锁 `health_fail_streak=0` + `stop_event.wait(grace_after_start_sec)`（重启后宽限）。
  - `except Exception`：`log.warning`，视为失败，`health_fail_streak += 1`，同样判断阈值。
  - `stop_event.wait(interval_sec)`。
- `stop(self)`：`stop_event.set()`。

### 7.7 screen_kiosk.py — `class ScreenKiosk(threading.Thread)`
- `__init__(self, cfg, state, log, alerter)`：`super(daemon=True, name='ScreenKiosk')`；`stop_event=Event()`；读 `cfg['kiosk']`；解析 `daily_reload_time` "HH:MM" 为 `(h,m)`；`self._last_reload_date = None`；`self._browser_exe = None`（缓存）。
- `run(self)`：`not enabled` return。`_ensure_running()`。`while not stop_event.is_set()`：`try`：`not state.muted` 时 `_ensure_running()`；`_maybe_daily_reload()`。`except Exception: log.error`。`stop_event.wait(check_interval_sec)`。
- `_detect_browser(self) -> str`：若 `browser_path` 非空且存在用它；否则按 `browser` 探测常见路径。edge：`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`、`C:\Program Files\Microsoft\Edge\Application\msedge.exe`。chrome：`C:\Program Files\Google\Chrome\Application\chrome.exe`、`C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`。找不到 `raise RuntimeError`。缓存到 `self._browser_exe`。
- `_is_kiosk_alive(self) -> bool`：用 `psutil.process_iter(['pid','name','cmdline'])`，存在进程名匹配（msedge.exe / chrome.exe）且 cmdline 含 `--kiosk` 与本 `url` → True。也可辅助用 `state.kiosk_pid`。异常返回 False。
- `_launch(self) -> None`：`exe=_detect_browser()`；`args=[exe, '--kiosk', url, '--no-first-run', '--no-default-browser-check']`；edge 追加 `'--edge-kiosk-type=fullscreen'`。`Popen(args, creationflags=CREATE_NO_WINDOW)`。记 `state.kiosk_pid`。`try/except`：失败 `log.error` + `alerter`。
- `_ensure_running(self)`：`if not _is_kiosk_alive(): _launch()`。
- `relaunch(self) -> None`：外部触发。杀当前 kiosk（按 `state.kiosk_pid` 或按 url 匹配的 psutil 进程，`terminate` 后等 2s，仍活 `kill`），再 `_launch()`。
- `_maybe_daily_reload(self)`：`now=datetime.now()`；`reload_dt = now.replace(hour=h, minute=m, second=0, microsecond=0)`；若 `now >= reload_dt` 且 `self._last_reload_date != now.date()`：`relaunch()`；`self._last_reload_date = now.date()`。保证每天只重开一次。
- `stop(self)`：`stop_event.set()`。**不杀 kiosk**（管理器退出时让大屏保持显示）。

### 7.8 tray.py — `class TrayApp`
- `__init__(self, cfg, state, log, guard, watchdog, kiosk)`：保存引用；`self._quit = threading.Event()`；`self._icon = None`；读 `cfg['tray']`。
- 菜单（pystray.Menu）：
  - 状态项：`MenuItem(lambda i: f'看板: {state.node_status()}', None, enabled=False)`
  - 分隔
  - `'重启看板'` → `on_restart_node`
  - `'重启投屏'` → `on_restart_kiosk`
  - 动态文本：`MenuItem(lambda i: '恢复守护' if state.muted else '暂停守护', on_toggle_mute)`
  - 分隔
  - `'打开看板页面'` → `on_open_page`（`webbrowser.open(cfg['kiosk']['url'])`）
  - `'打开日志目录'` → `on_open_logs`（`os.startfile(cfg['log']['dir'])`）
  - `'退出'` → `on_quit`
- 回调（耗时操作起新线程，避免阻塞 pystray 线程）：
  - `on_restart_node`：`threading.Thread(target=guard.restart, args=('托盘',), daemon=True).start()`
  - `on_restart_kiosk`：`threading.Thread(target=kiosk.relaunch, daemon=True).start()`
  - `on_toggle_mute`：持锁翻转 `state.muted`，`log.info`。
  - `on_open_page` / `on_open_logs`：直接调用，`try/except`。
  - `on_quit`：`self._quit.set()`；`self._icon.stop()`。
- 图标：用 `PIL.Image` + `ImageDraw` 画一个简单图标（深色底圆 + 字母 "A" 或状态色块）。颜色随状态：运行中绿(#3ecf8e)/熔断红(#e05260)/停止灰(#888)。
- `run(self) -> None`：`not tray.enabled` → 阻塞 `self._quit.wait()`（纯守护，由 manager 信号 `stop()` 唤醒）。否则 `self._icon = self._make_icon()`；`self._icon.run()`（阻塞至 `icon.stop()`）。
- `stop(self) -> None`：`self._quit.set()`；`if self._icon: self._icon.stop()`。

### 7.9 manager.py — 入口
- `main() -> None`：
  - `CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'config.yaml')`
  - `cfg = load_config(CONFIG_PATH)`；`log = setup_logging(cfg)`；`log.info('AI看板管理器启动')`
  - 建 `state = ManagerState()`；`alerter = Alerter(cfg, state, log)`
  - 建 `guard = NodeGuard(...)`；`watchdog = Watchdog(cfg, state, log, guard, alerter)`；`kiosk = ScreenKiosk(cfg, state, log, alerter)`；`tray = TrayApp(cfg, state, log, guard, watchdog, kiosk)`
  - `guard.start()`；`watchdog.start()`；`kiosk.start()`
  - 信号处理：`signal.signal(signal.SIGINT, _handler)`；Windows 额外 `signal.signal(signal.SIGBREAK, _handler)`（包 try/except，无该信号则跳过）。`_handler(signum, frame)`：`log.info('收到退出信号')`；`tray.stop()`。
  - `tray.run()`（阻塞）
  - 退出清理：`guard.stop()`；`watchdog.stop()`；`kiosk.stop()`；`guard.join(timeout=10)`；`watchdog.join(timeout=5)`；`kiosk.join(timeout=5)`；`log.info('已退出')`。
- `if __name__ == '__main__': main()`

### 7.10 panel.py — `class PanelServer(threading.Thread)`
- `__init__(self, cfg, state, log, guard, kiosk)`：读 `cfg['panel']`(enabled/port/key)。
- `run(self)`：`not enabled` return；起 `HTTPServer(('0.0.0.0', port), Handler)`，`serve_forever()` 阻塞。路由：`GET /`→panel.html、`GET /api/status`→JSON快照、`GET /api/logs`→最近200行manager.log、`POST /api/restart-node`/`/api/restart-kiosk`/`/api/toggle-mute`。鉴权：`key` 非 None 时需 `?key=`。
- `_snapshot(self) -> dict`：持 `state.lock` 读字段生成状态快照。
- `stop(self)`：起 shutdown 线程唤醒 `serve_forever` 退出。
- HTML 在 `panel.html`(同目录)，`run` 读之返回 `GET /`。控制操作起新线程调 `guard.restart`/`kiosk.relaunch`，不阻塞 HTTP。

## 8. 总则（所有模块遵守）

- **线程安全**：访问 `state` 字段持 `state.lock`（RLock 可重入）。
- **守护线程异常兜底**：`run()` 循环体 `try/except Exception`，异常仅 `log`，绝不冒泡导致管理器崩溃。
- **可中断 sleep**：每个守护线程持有 `stop_event: threading.Event()`；循环 `while not stop_event.is_set()`；**所有** sleep 用 `stop_event.wait(sec)`；`stop()` 调 `stop_event.set()`。
- **Windows**：子进程加 `creationflags=subprocess.CREATE_NO_WINDOW`；路径用 `pathlib`/`os.path`；文件/源码 UTF-8。
- **退出顺序**：manager 退出时 `kiosk.stop()` → `watchdog.stop()` → `guard.stop()`，各 `join(timeout)`。
- **编码规范**：中文注释，文件顶部模块 docstring，类型提示齐全，`from __future__ import annotations` 置顶。

## 9. 模块依赖

`manager` → 全部；`tray` → `guard/watchdog/kiosk/state`；`watchdog` → `guard/state/alerter`；`guard/kiosk` → `state/alerter`；`alert` → `state`；所有 → `config/log/state`。
