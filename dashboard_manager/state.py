from __future__ import annotations

"""共享状态容器。

本模块定义 :class:`ManagerState`，作为看板运维管理器各守护线程
（NodeGuard / Watchdog / ScreenKiosk / TrayApp）之间共享的、线程安全的
状态容器。所有字段访问须持 :attr:`ManagerState.lock`（``threading.RLock``，
可重入），避免在多线程读写时出现竞态。

职责：
  * 记录 Node 进程句柄 / PID / 启动时间 / 重启计数。
  * 记录连续崩溃计数与熔断状态，供 ``NodeGuard`` 决定退避与冷却。
  * 记录探活结果（健康状态 / 连续失败次数 / MES Cookie 在位情况）。
  * 记录托盘“暂停守护”开关（``muted``）与投屏进程 PID。
  * 提供告警去重（``should_alert``），按告警类别在最小间隔内去重。
  * 提供 ``node_status()`` 给托盘与日志统一查询当前看板状态文字。
"""

import subprocess
import threading
import time


class ManagerState:
    """线程安全的看板运维共享状态。

    所有字段的读/写都应在 ``with self.lock:`` 块内完成。``self.lock`` 为
    :class:`threading.RLock`（可重入），因此同一线程持锁后再次获取不会
    死锁，便于在已加锁的方法内调用其它加锁方法。
    """

    def __init__(self) -> None:
        # RLock 可重入：同一线程内嵌套加锁不会死锁，方便方法互调。
        self.lock: threading.RLock = threading.RLock()

        # --- Node 进程相关 ---
        # Node 子进程句柄（subprocess.Popen 实例）；无进程时为 None。
        self.node_proc: subprocess.Popen | None = None
        # Node 进程 PID；便于在句柄失效后按 PID 检索/终止。
        self.node_pid: int | None = None
        # 最近一次成功拉起 Node 的时间戳（time.time()）。
        self.node_started_at: float | None = None
        # 累计成功重启次数（含首次启动后每次 _launch）。
        self.restart_count: int = 0
        # 连续崩溃计数：进程非预期退出累加，稳定运行 60s 后重置。
        self.consecutive_crashes: int = 0

        # --- 熔断相关 ---
        # 是否处于熔断（冷却）状态。
        self.circuit_open: bool = False
        # 熔断恢复时间戳；到期后 circuit_open 置 False 并重置崩溃计数。
        self.circuit_until: float | None = None

        # --- 探活相关（Watchdog 维护）---
        # 最近一次 /api/health 是否成功；None=尚未探活过。
        self.last_health_ok: bool | None = None
        # 最近一次探活时间戳。
        self.last_health_at: float | None = None
        # 健康探活连续失败次数；达到阈值则触发重启。
        self.health_fail_streak: int = 0
        # 最近一次探活解析到的 MES Cookie 在位情况；None=未解析/未探活。
        self.last_has_cookie: bool | None = None

        # --- 守护开关与投屏 ---
        # 暂停守护（托盘切换）：为 True 时 NodeGuard 不拉起、Watchdog 不探活。
        self.muted: bool = False
        # 投屏浏览器（Edge/Chrome kiosk）PID。
        self.kiosk_pid: int | None = None

        # --- 告警去重 ---
        # kind -> time.time()，记录各类告警最近一次触发时间。
        self.last_alert_at: dict = {}

    def node_status(self) -> str:
        """返回当前看板状态的中文描述。

        判定优先级：
          1. 熔断中（``circuit_open`` 为真且当前时间早于 ``circuit_until``）
             → ``"熔断"``。
          2. Node 进程在运行（``node_proc`` 非 None 且 ``poll() is None``）
             → ``"运行中"``。
          3. 其它情况 → ``"已停止"``。

        Returns:
            ``"运行中"`` / ``"已停止"`` / ``"熔断"`` 三者之一。
        """
        with self.lock:
            # 1) 熔断冷却期内优先报告熔断。
            if self.circuit_open and self.circuit_until is not None and time.time() < self.circuit_until:
                return "熔断"
            # 2) 进程句柄存在且未退出视为运行中。
            if self.node_proc is not None and self.node_proc.poll() is None:
                return "运行中"
            # 3) 其余（无句柄、已退出、熔断已过期等）视为已停止。
            return "已停止"

    def record_crash(self) -> None:
        """记录一次崩溃：``consecutive_crashes`` 自增 1。

        由 ``NodeGuard`` 在检测到 Node 进程非预期退出后调用。
        """
        with self.lock:
            self.consecutive_crashes += 1

    def reset_crashes(self) -> None:
        """重置连续崩溃计数为 0。

        触发时机：Node 稳定运行超过 60s；手动重启；熔断恢复。
        """
        with self.lock:
            self.consecutive_crashes = 0

    def should_alert(self, kind: str, min_interval: float) -> bool:
        """告警去重判断。

        若同一 ``kind`` 的告警在最近 ``min_interval`` 秒内已触发过，则返回
        ``False``（应跳过本次告警）；否则把当前时间记入
        ``last_alert_at[kind]`` 并返回 ``True``（应发送告警）。

        Args:
            kind: 告警类别（如 ``"restart"``/``"health"``/``"cookie"``/
                ``"circuit"``）。
            min_interval: 同类告警去重冷却秒数。

        Returns:
            是否应当发送本次告警。
        """
        now = time.time()
        with self.lock:
            last = self.last_alert_at.get(kind)
            if last is not None and (now - last) < min_interval:
                # 冷却期内，去重：不更新时间戳，直接跳过。
                return False
            # 冷却已过（或首次触发）：记录本次时间并允许告警。
            self.last_alert_at[kind] = now
            return True
