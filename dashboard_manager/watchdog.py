from __future__ import annotations

"""看板探活自愈守护线程 (watchdog)。

职责:
- 周期性请求 Node 后端的 /api/health, 判断看板是否存活。
- 连续 failure_threshold 次探活失败 -> 调用 NodeGuard.restart 重启 Node 进程。
- MES Cookie 丢失(hasCookie=false)仅告警, 不重启(重启 Node 无用, 需重新登录MES)。
- 暂停守护(muted)或熔断(circuit_open)期间跳过探活。
- 所有 sleep 可被 stop_event 中断; 循环体异常仅 log, 绝不冒泡。
"""

import threading
import time
from typing import Any

import requests


class Watchdog(threading.Thread):
    """看板探活自愈守护线程。"""

    def __init__(self, cfg: dict, state: Any, log: Any, guard: Any, alerter: Any) -> None:
        super().__init__(daemon=True, name="Watchdog")
        self.stop_event = threading.Event()
        self.cfg = cfg
        self.state = state
        self.log = log
        self.guard = guard
        self.alerter = alerter

        # 读取 watchdog 配置(部分健壮: 缺失子字段用默认补齐)
        wd = cfg.get("watchdog", {}) if isinstance(cfg, dict) else {}
        self.enabled: bool = bool(wd.get("enabled", True))
        self.health_url: str = wd.get("health_url", "http://127.0.0.1:8080/api/health")
        self.interval_sec: int = int(wd.get("interval_sec", 15))
        self.failure_threshold: int = int(wd.get("failure_threshold", 3))
        self.timeout_sec: int = int(wd.get("timeout_sec", 8))
        self.grace_after_start_sec: int = int(wd.get("grace_after_start_sec", 30))
        # 慢启动窗口: Node 进程存活但 health 还没 ok 的宽限(覆盖 MES 登录/sync 慢启动)。
        # 窗口内探活失败只告警不重启; 窗口外仍不健康才视作卡死重启。
        # 必须定义——否则 _maybe_restart 引用 self.startup_window_sec 抛 AttributeError,
        # 被外层 except 当"探活异常"吞掉, 致 watchdog 永远不重启 Node(server 反复 DOWN 不自愈)。
        self.startup_window_sec: int = int(wd.get("startup_window_sec", 120))
        self.cookie_loss_alert: bool = bool(wd.get("cookie_loss_alert", True))

    def _maybe_restart(self, streak: int, reason: str) -> None:
        """探活失败达阈值时视情况重启 Node。

        若 Node 进程仍存活且在慢启动窗口(startup_window_sec)内, 说明 server 还在
        db.connect→mesLogin→sync→prewarm→listen 慢启动, 不是真崩, 跳过重启——
        避免 server 启动需要 >2 分钟(MES 登录慢)时被 watchdog 每 75s 重启一次
        打成永远 listen 不了的死循环。窗口外仍存活则视为卡死, 正常重启。
        """
        with self.state.lock:
            proc = self.state.node_proc
            started = self.state.node_started_at
        node_alive = proc is not None and proc.poll() is None
        if node_alive and started is not None:
            age = time.time() - started
            if age < self.startup_window_sec:
                self.log.warning(
                    "探活连续失败 %s 次但 Node 存活且启动中(%.0fs < %ss), 跳过重启",
                    streak, age, self.startup_window_sec,
                )
                return
        self.log.warning("探活连续失败达阈值(%s), 触发Node重启", self.failure_threshold)
        self.alerter.notify(
            "health", f"看板探活连续失败 {streak} 次, 已自动重启Node进程"
        )
        try:
            self.guard.restart(reason)
        except Exception as e:
            self.log.error("watchdog 触发的 Node 重启异常: %s", e)

    def run(self) -> None:
        """探活主循环。"""
        # 未启用直接返回
        if not self.enabled:
            self.log.info("watchdog 未启用, 跳过探活守护")
            return

        self.log.info(
            "watchdog 启动: health_url=%s interval=%ss threshold=%s timeout=%ss grace=%ss",
            self.health_url, self.interval_sec, self.failure_threshold,
            self.timeout_sec, self.grace_after_start_sec,
        )

        # Node 刚启动后给予宽限, 避免误判探活失败
        if self.stop_event.wait(self.grace_after_start_sec):
            # 宽限期内收到停止信号, 直接退出
            return

        while not self.stop_event.is_set():
            try:
                # 暂停守护或熔断中(冷却未到期) : 跳过探活
                # 注: 仅当熔断确实在冷却期内(circuit_until 未过期)才跳过;
                # 熔断到期但 proc_guard 尚未置 False 的窗口里仍正常探活,
                # 避免 watchdog 与 guard 恢复逻辑错位。
                with self.state.lock:
                    muted = self.state.muted
                    circuit_open = self.state.circuit_open
                    circuit_until = self.state.circuit_until
                now = time.time()
                in_circuit = (
                    circuit_open
                    and circuit_until is not None
                    and now < circuit_until
                )

                if muted or in_circuit:
                    # 跳过本轮探活, 等待下一周期
                    self.stop_event.wait(self.interval_sec)
                    continue

                # 探活请求
                r = requests.get(self.health_url, timeout=self.timeout_sec)
                # 判定 ok: HTTP 状态码 <500 且 JSON body 的 status=='ok'
                ok = False
                has_cookie: bool | None = None
                try:
                    body = r.json()
                    ok = r.status_code < 500 and body.get("status") == "ok"
                    has_cookie = body.get("hasCookie")
                except Exception:
                    # JSON 解析失败视为探活失败(不 ok)
                    ok = False

                # 持锁更新共享状态
                now = time.time()
                with self.state.lock:
                    self.state.last_health_ok = ok
                    self.state.last_health_at = now
                    self.state.last_has_cookie = has_cookie

                if ok:
                    # 探活成功, 清零失败计数
                    with self.state.lock:
                        self.state.health_fail_streak = 0
                    # Cookie 丢失仅告警(去重), 不重启
                    if self.cookie_loss_alert and (has_cookie is False):
                        self.alerter.notify(
                            "cookie",
                            "MES Cookie 已失效, 数据API将无返回, 请重新登录MES",
                        )
                else:
                    # 探活失败, 累加失败计数
                    with self.state.lock:
                        self.state.health_fail_streak += 1
                        streak = self.state.health_fail_streak
                    self.log.warning(
                        "探活失败 health_url=%s status_code=%s 连续失败 %s/%s",
                        self.health_url, r.status_code, streak, self.failure_threshold,
                    )
                    if streak >= self.failure_threshold:
                        self._maybe_restart(streak, "watchdog: health连续失败")
                        # 重启或跳过后清零失败计数
                        with self.state.lock:
                            self.state.health_fail_streak = 0
                        # 给予宽限, 避免立刻又探活失败误判
                        if self.stop_event.wait(self.grace_after_start_sec):
                            return

            except Exception as e:
                # 网络异常/超时/其它异常均视为探活失败
                self.log.warning("探活异常 health_url=%s: %s", self.health_url, e)
                with self.state.lock:
                    self.state.health_fail_streak += 1
                    streak = self.state.health_fail_streak
                if streak >= self.failure_threshold:
                    self._maybe_restart(streak, "watchdog: health连续异常")
                    with self.state.lock:
                        self.state.health_fail_streak = 0
                    if self.stop_event.wait(self.grace_after_start_sec):
                        return

            # 本轮结束, 等待下一探活周期
            self.stop_event.wait(self.interval_sec)

    def stop(self) -> None:
        """请求守护线程退出。"""
        self.stop_event.set()
