from __future__ import annotations

"""Node.js 看板后端进程守护模块。

职责:
- 以 daemon 线程常驻, 拉起并守护 Node.js 看板后端(server.js, 端口 8080)。
- 进程崩溃后按指数退避序列重新拉起; 连续崩溃超阈值则开熔断冷却, 期间不重启。
- 熔断到期自动恢复, 清零连续崩溃计数重新计数。
- 进程稳定运行超 60s 则清零连续崩溃计数。
- 支持外部主动 restart(托盘/看门狗触发)与 stop(管理器退出)。
- 所有 sleep 可被 stop_event 中断; 循环体异常仅记日志不冒泡。

接口契约见 dashboard_manager/CONTRACTS.md §7.5。
"""

import os
import subprocess
import threading
import time
from typing import Optional

import psutil

# 标准库 typing.Optional 用于运行时安全; 注解处因 future annotations 可用 X | None。


class NodeGuard(threading.Thread):
    """Node.js 看板后端守护线程。

    通过监控 state.node_proc 的存活状态决定是否拉起/退避/熔断。
    所有共享状态访问持 state.lock(RLock 可重入)。
    """

    def __init__(self, cfg, state, log, alerter):
        # type: (dict, "ManagerState", "logging.Logger", "Alerter") -> None
        super().__init__(daemon=True, name="NodeGuard")
        self.cfg = cfg
        self.state = state
        self.log = log
        self.alerter = alerter

        # 可中断停止信号
        self.stop_event = threading.Event()

        # 拉起专用互斥锁: 串行化 run() 循环与 restart() 的 _launch() 调用,
        # 防止探活失败触发 restart 与崩溃自愈同时拉起两个 Node 进程导致
        # 第二个绑定 8080 失败(EADDRINUSE)僵死。与 state.lock 分离, 不影响
        # 其他线程读写 state 字段。
        self._launch_lock = threading.Lock()

        # 读取 node 配置段
        node_cfg = cfg.get("node", {}) or {}
        self.command = list(node_cfg.get("command", []))
        self.cwd = node_cfg.get("cwd")  # 已由 load_config 解析为绝对路径(或 None)
        self.env_file = node_cfg.get("env_file")  # 绝对路径或 None
        self.port = int(node_cfg.get("port", 8080))  # node 监听端口, 用于启动前清理孤儿进程

        restart_cfg = node_cfg.get("restart", {}) or {}
        self.backoff = list(restart_cfg.get("backoff_sec", [5]))
        self.max_consecutive_crashes = int(
            restart_cfg.get("max_consecutive_crashes", 8)
        )
        self.cooldown_sec = int(restart_cfg.get("cooldown_sec", 300))

        # 持有的 Node stdout 日志文件句柄, 每次 _launch 前关闭避免泄漏
        self._node_log_fh = None  # type: Optional[object]

        self.log.debug(
            "NodeGuard 初始化: command=%r cwd=%r env_file=%r backoff=%r "
            "max_crashes=%d cooldown=%ds",
            self.command,
            self.cwd,
            self.env_file,
            self.backoff,
            self.max_consecutive_crashes,
            self.cooldown_sec,
        )

    # ------------------------------------------------------------------
    # 主循环
    # ------------------------------------------------------------------
    def run(self) -> None:
        """守护主循环: 暂停/熔断/进程不在判断, 退避后拉起, 稳定运行清零计数。

        循环体 try/except 兜底, 异常仅 log, 绝不冒泡导致管理器崩溃。
        所有 sleep 用 stop_event.wait() 以保证可被 stop() 中断。
        """
        self.log.info("NodeGuard 守护线程启动")
        while not self.stop_event.is_set():
            try:
                # 1) 暂停守护: 托盘切换 muted, 不拉起也不杀进程
                if self.state.muted:
                    self.stop_event.wait(2)
                    continue

                now = time.time()

                # 2) 熔断状态判定
                with self.state.lock:
                    circuit_open = self.state.circuit_open
                    circuit_until = self.state.circuit_until

                # 2a) 不一致兜底: circuit_open=True 但 circuit_until=None,
                #     视为熔断已过期直接恢复(避免熔断失效或后续比较 TypeError)
                if circuit_open and circuit_until is None:
                    with self.state.lock:
                        self.state.circuit_open = False
                        self.state.reset_crashes()
                        self.state.health_fail_streak = 0
                    self.log.warning("熔断状态不一致(circuit_until=None), 已恢复守护")
                    circuit_open = False

                # 2b) 熔断中且未到期: 等待冷却, 不重启
                if circuit_open and now < circuit_until:
                    self.stop_event.wait(10)
                    continue

                # 2c) 熔断到期: 恢复并清零连续崩溃计数与探活失败计数, 重新计数
                #     (清零 health_fail_streak 防止熔断期间残留的探活失败在恢复后
                #      叠加触发不必要的二次重启)
                if circuit_open and now >= circuit_until:
                    with self.state.lock:
                        self.state.circuit_open = False
                        self.state.circuit_until = None
                        self.state.reset_crashes()
                        self.state.health_fail_streak = 0
                    self.log.info("熔断冷却已到期, 恢复守护并清零计数")

                # 4) 判断 Node 进程是否存活
                with self.state.lock:
                    proc = self.state.node_proc
                proc_alive = proc is not None and proc.poll() is None

                if not proc_alive:
                    # 4a) 进程不在: 若之前有进程说明刚崩, 计一次崩溃
                    had_proc = proc is not None
                    if had_proc:
                        with self.state.lock:
                            self.state.record_crash()
                            crashes = self.state.consecutive_crashes
                        exitcode = proc.poll() if proc is not None else None
                        self.log.warning("Node 进程已退出, 退出码=%s, 连续崩溃计数=%d", exitcode, crashes)

                    # 4b) 连续崩溃超阈值: 开熔断, 告警, 不重启
                    with self.state.lock:
                        crashes = self.state.consecutive_crashes
                    if crashes >= self.max_consecutive_crashes:
                        with self.state.lock:
                            self.state.circuit_open = True
                            self.state.circuit_until = time.time() + self.cooldown_sec
                        self.log.error(
                            "连续崩溃 %d 次达到阈值 %d, 开启熔断冷却 %ds",
                            crashes,
                            self.max_consecutive_crashes,
                            self.cooldown_sec,
                        )
                        self.alerter.notify(
                            "circuit",
                            f"Node 连续崩溃 {crashes} 次, 已熔断冷却 "
                            f"{self.cooldown_sec}s, 期间不再自动重启",
                        )
                        # 标记已无进程
                        with self.state.lock:
                            self.state.node_proc = None
                            self.state.node_pid = None
                        self.stop_event.wait(10)
                        continue

                    # 4c) 计算退避: 首次启动(consecutive_crashes==0)不退避直接拉起;
                    #     崩溃后再起用 backoff[min(consecutive_crashes-1, len-1)]
                    if crashes == 0:
                        wait_sec = 0
                    else:
                        idx = min(crashes - 1, len(self.backoff) - 1)
                        wait_sec = int(self.backoff[idx])

                    if wait_sec > 0:
                        self.log.info(
                            "等待退避 %ds 后拉起 Node (连续崩溃=%d)", wait_sec, crashes
                        )
                        self.stop_event.wait(wait_sec)
                        if self.stop_event.is_set():
                            break

                    self._launch()
                    # 拉起后短歇, 让进程有机会启动
                    self.stop_event.wait(2)
                    continue

                # 5) 进程在: 稳定运行超 60s 且曾崩溃过则清零计数
                with self.state.lock:
                    started_at = self.state.node_started_at
                    crashes = self.state.consecutive_crashes
                if (
                    started_at is not None
                    and crashes > 0
                    and (now - started_at) > 60
                ):
                    with self.state.lock:
                        self.state.reset_crashes()
                    self.log.info("Node 稳定运行超 60s, 清零连续崩溃计数")

                self.stop_event.wait(2)

            except Exception as e:  # noqa: BLE001 - 守护线程兜底, 绝不冒泡
                self.log.error("NodeGuard 主循环异常: %r", e, exc_info=True)
                self.stop_event.wait(5)

        self.log.info("NodeGuard 守护线程退出")

    # ------------------------------------------------------------------
    # 启动 Node 子进程
    # ------------------------------------------------------------------
    def _kill_orphan_node_on_port(self, port=8080) -> None:
        """拉起前若 port 已被别的 node 占(上个 manager 死后遗留的孤儿进程),
        杀掉防 EADDRINUSE 崩溃循环。本进程刚要拉新 node, 任何占 port 的 node 都不是
        自己刚起的(state.node_proc 已死才会到 _launch), 故可安全清。
        """
        own_pid = None
        with self.state.lock:
            own_pid = self.state.node_pid
        try:
            for c in psutil.net_connections(kind='tcp'):
                if c.laddr and c.laddr.port == port and c.status == 'LISTEN' and c.pid:
                    if c.pid == own_pid or c.pid == os.getpid():
                        continue
                    try:
                        p = psutil.Process(c.pid)
                        if 'node' in (p.name() or '').lower():
                            p.terminate()
                            try:
                                p.wait(timeout=3)
                            except psutil.TimeoutExpired:
                                p.kill()
                            self.log.warning("启动前清理 %s 上的遗留孤儿 node 进程 pid=%s", port, c.pid)
                    except (psutil.NoSuchProcess, psutil.AccessDenied, OSError):
                        pass
        except Exception as e:  # noqa: BLE001
            self.log.warning("清理 %s 遗留 node 异常(忽略): %s", port, e)

    def _launch(self) -> None:
        """拉起 Node 子进程。

        - 入口持 self._launch_lock 串行化: run() 主循环与 restart() 可能并发
          调用 _launch(), 此锁确保同一时刻只有一个拉起动作, 避免双开 Node
          导致 EADDRINUSE 僵死。
        - env = os.environ.copy(); 若 env_file 存在解析 KEY=VALUE(跳过 # 注释与空行)注入。
        - Popen(command, cwd, env, stdout 追加到 node.stdout.log, stderr=STDOUT,
          creationflags=CREATE_NO_WINDOW)。
        - 持久化 stdout 文件句柄到 self._node_log_fh, 下次 _launch 前 close 避免泄漏。
        - 更新 state.node_proc/pid/node_started_at, restart_count+=1, log + 告警。
        - 启动失败仅 log + 告警, 不抛。
        """
        # 串行化拉起: 防止 run() 循环与 restart() 并发各自 _launch 双开。
        with self._launch_lock:
            try:
                # 复检: 若已有 Node 进程存活(别的路径刚拉起), 跳过避免双开。
                # 防止 restart() 置 node_proc=None 期间 run() 循环误判该拉起,
                # 与 restart 的 _launch 并发拉出两个 Node(实测会双开)。
                with self.state.lock:
                    existing = self.state.node_proc
                if existing is not None and existing.poll() is None:
                    self.log.info("Node 进程已存活, 跳过本次拉起(防双开)")
                    return
                # 清理 8080 上的孤儿 node(上个 manager 遗留), 防 EADDRINUSE 崩溃循环
                self._kill_orphan_node_on_port(self.port)
                # 关闭上次的 stdout 句柄, 避免文件句柄泄漏
                if self._node_log_fh is not None:
                    try:
                        self._node_log_fh.close()
                    except Exception as e:  # noqa: BLE001
                        self.log.warning("关闭上次 Node stdout 句柄失败: %r", e)
                    self._node_log_fh = None

                # 构造环境
                env = os.environ.copy()
                if self.env_file and os.path.isfile(self.env_file):
                    self._load_env_file(self.env_file, env)

                # 打开 Node stdout 日志(追加, 二进制, 长期持有句柄)
                log_dir = self.cfg.get("log", {}).get("dir")
                if not log_dir:
                    # log.dir 缺失时退化为当前目录, 避免 _launch 整体失败
                    log_dir = os.getcwd()
                os.makedirs(log_dir, exist_ok=True)
                node_log_path = os.path.join(log_dir, "node.stdout.log")
                self._node_log_fh = open(node_log_path, "ab")

                self.log.info(
                    "拉起 Node 进程: command=%r cwd=%r stdout=%s",
                    self.command,
                    self.cwd,
                    node_log_path,
                )

                proc = subprocess.Popen(
                    self.command,
                    cwd=self.cwd if self.cwd else None,
                    env=env,
                    stdout=self._node_log_fh,
                    stderr=subprocess.STDOUT,
                    creationflags=subprocess.CREATE_NO_WINDOW,
                )

                with self.state.lock:
                    self.state.node_proc = proc
                    self.state.node_pid = proc.pid
                    self.state.node_started_at = time.time()
                    self.state.restart_count += 1
                    count = self.state.restart_count

                self.log.info("Node 进程已拉起, pid=%s, 累计重启次数=%d", proc.pid, count)
                self.alerter.notify(
                    "restart",
                    f"Node 看板后端已拉起, pid={proc.pid}, 累计重启 {count} 次",
                )

            except Exception as e:  # noqa: BLE001 - 启动失败不抛, 仅记日志告警
                self.log.error("拉起 Node 进程失败: %r", e, exc_info=True)
                self.alerter.notify("restart", f"Node 看板后端拉起失败: {e}")
                # 确保状态一致: 启动失败则无进程
                with self.state.lock:
                    self.state.node_proc = None
                    self.state.node_pid = None

    @staticmethod
    def _load_env_file(path: str, env: dict) -> None:
        """解析 KEY=VALUE 环境文件, 跳过 # 注释与空行, 注入到 env(dict)。

        行内无 '=' 的行视为无效跳过; 值不去引号(保持原样, 与常见 .env 行为一致)。
        """
        try:
            with open(path, "r", encoding="utf-8") as f:
                for raw in f:
                    line = raw.strip()
                    if not line or line.startswith("#"):
                        continue
                    if "=" not in line:
                        continue
                    key, _, value = line.partition("=")
                    key = key.strip()
                    if not key:
                        continue
                    env[key] = value
        except Exception:
            # 解析失败由调用方上下文(_launch try/except)兜底; 此处不抛
            raise

    # ------------------------------------------------------------------
    # 外部主动重启
    # ------------------------------------------------------------------
    def restart(self, reason: str) -> bool:
        """外部主动重启 Node(托盘/看门狗触发)。

        持锁仅取出 proc 引用并置 node_proc=None(立即释放锁), 再在锁外做
        terminate/等最多 5s/kill 等耗时操作(避免长占 state.lock 卡住托盘菜单
        与 watchdog 探活); reset_crashes(手动重启视为期望行为); 再 _launch()。
        返回是否启动成功(node_proc 非 None 且 poll() is None)。
        耗时操作可在调用方新起线程。
        """
        self.log.info("外部触发重启 Node, 原因: %s", reason)

        # 1) 持锁极短: 取出 proc 引用并立即清空 state.node_proc, 释放锁后再
        #    做耗时终止等待。这样托盘菜单调 node_status()、watchdog 更新探活
        #    状态等读 state 的线程不会被卡 5s。
        with self.state.lock:
            proc = self.state.node_proc
            self.state.node_proc = None
            self.state.node_pid = None

        # 2) 锁外终止旧进程: terminate 后轮询最多 5s, 仍活 kill。
        #    用 stop_event.wait 代替 time.sleep 以便 stop() 时可中断等待。
        if proc is not None and proc.poll() is None:
            try:
                proc.terminate()
            except Exception as e:  # noqa: BLE001
                self.log.warning("terminate 当前 Node 进程失败: %r", e)
            for _ in range(50):
                if proc.poll() is not None:
                    break
                self.stop_event.wait(0.1)
            if proc.poll() is None:
                self.log.warning("Node 进程 5s 未退出, 强制 kill")
                try:
                    proc.kill()
                except Exception as e:  # noqa: BLE001
                    self.log.warning("kill 当前 Node 进程失败: %r", e)

        # 3) 手动重启视为期望行为, 清零连续崩溃计数(reset_crashes 自带锁)。
        self.state.reset_crashes()

        # 4) 拉起(经 _launch_lock 串行化, 与 run() 循环互斥)。
        self._launch()

        with self.state.lock:
            proc = self.state.node_proc
            success = proc is not None and proc.poll() is None
        self.log.info("重启 Node 完成, 原因=%s, 成功=%s", reason, success)
        return success

    # ------------------------------------------------------------------
    # 停止守护
    # ------------------------------------------------------------------
    def stop(self) -> None:
        """停止守护: 置 stop_event 唤醒主循环; 杀掉存活的 Node 进程。

        持 _launch_lock 串行化: 防止 stop 与 run() 自愈 _launch() 竞态——
        若 stop 杀旧进程时 run 恰好检测到崩溃并在 _launch 新进程, 新进程会
        逃过 stop 的 terminate 成为孤儿。持锁确保 stop 看到并杀掉最新的 node_proc。
        """
        self.log.info("NodeGuard 停止中")
        with self._launch_lock:
            self.stop_event.set()

            with self.state.lock:
                proc = self.state.node_proc
            if proc is not None and proc.poll() is None:
                try:
                    proc.terminate()
                    # 等待退出, 最多 5s; 用 stop_event.wait 以便 stop() 时可中断等待
                    for _ in range(50):
                        if proc.poll() is not None:
                            break
                        self.stop_event.wait(0.1)
                    if proc.poll() is None:
                        proc.kill()
                except Exception as e:  # noqa: BLE001
                    self.log.warning("stop 时杀 Node 进程失败: %r", e)

            with self.state.lock:
                self.state.node_proc = None
                self.state.node_pid = None

        # 关闭 stdout 句柄
        if self._node_log_fh is not None:
            try:
                self._node_log_fh.close()
            except Exception as e:  # noqa: BLE001
                self.log.warning("stop 时关闭 Node stdout 句柄失败: %r", e)
            self._node_log_fh = None
