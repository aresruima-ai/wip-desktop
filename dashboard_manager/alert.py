from __future__ import annotations

"""告警模块。

职责：在发生关键事件（Node 崩溃熔断、探活连续失败、MES Cookie 丢失等）时，
向钉钉/企微等 webhook 推送文本告警，并对同类告警做时间窗口去重以防刷屏。

设计要点：
- 未启用告警（alert.enabled=False）或未配置 webhook 时，仅写本地日志，不发网络请求。
- 去重由共享状态 ManagerState.should_alert(kind, min_interval) 完成：同类告警在
  min_interval_sec 冷却期内的重复触发会被跳过。
- 整个 notify 做到“绝不抛异常”：任何失败（网络错误、webhook 返回非 200、序列化异常等）
  仅 log.warning，避免告警链路反噬守护线程导致管理器崩溃。

依赖：requests（第三方）、state.ManagerState（仅类型注解，TYPE_CHECKING 下导入）。
"""

import logging
from typing import TYPE_CHECKING

import requests

if TYPE_CHECKING:
    # 仅用于类型注解，避免运行时硬依赖 state.py（也防止潜在的循环导入）。
    from state import ManagerState


class Alerter:
    """告警发送器。

    通过 ``cfg['alert']`` 读取启用状态、webhook 地址与同类告警去重冷却时长，
    所有事件经 :meth:`notify` 统一出口。线程安全由 ``ManagerState.should_alert``
    内部的 ``state.lock`` 保证；本类自身无可变状态，可在多线程间安全调用。
    """

    def __init__(self, cfg: dict, state: "ManagerState", log: logging.Logger) -> None:
        """初始化告警器。

        Args:
            cfg: 已由 :func:`config.load_config` 处理过的配置字典。
            state: 共享状态容器，提供 ``should_alert`` 做同类告警去重。
            log: 上游传入的 logger（通常为 ``manager.alert`` 子 logger）。
        """
        self.state = state
        self.log = log

        # 读取告警配置段；缺失时补默认，保证对部分配置健壮（见 CONTRACTS §4/§7.4）。
        alert_cfg: dict = cfg.get("alert", {}) or {}
        self.enabled: bool = bool(alert_cfg.get("enabled", False))
        # webhook 为 None 表示仅本地日志（钉钉/企微机器人地址未配置）。
        self.webhook: str | None = alert_cfg.get("webhook", None)
        # 同类告警去重冷却秒数（默认 600）。
        self.min_interval_sec: float = float(alert_cfg.get("min_interval_sec", 600))

    def notify(self, kind: str, message: str) -> None:
        """发送一条告警。

        流程（CONTRACTS §7.4）：
        1. 去重前置：``state.should_alert(kind, min_interval_sec)`` 为 False → 跳过
           (无论是否启用, 避免 disabled 时每轮调用刷屏)。
        2. 未启用或 webhook 为 None → 仅 ``log.info`` 后返回。
        3. 发送：``requests.post(webhook, json=..., timeout=5)``，钉钉/企微文本格式。

        整个方法用 ``try/except Exception`` 兜底，任何异常仅 ``log.warning``，绝不向上抛出，
        以确保调用方（守护线程循环体）不会被告警链路的意外错误打断。

        Args:
            kind: 告警类别，用于去重（如 ``'restart'``/``'circuit'``/``'health'``/``'cookie'``）。
            message: 告警正文，发送时会被前缀 ``[AI看板] `` 包裹。
        """
        try:
            # 1) 去重前置(无论是否启用): 同 kind 在 min_interval 内只处理一次。
            #    必须在 enabled 检查之前, 否则 disabled 时 watchdog 每轮探活都会
            #    log.info 导致日志刷屏(cookie 丢失场景)。
            if not self.state.should_alert(kind, self.min_interval_sec):
                self.log.debug("[alert] 去重跳过 kind=%s", kind)
                return

            # 2) 未启用或未配置 webhook：仅本地记录(已通过去重, 不会刷屏)。
            if (not self.enabled) or (self.webhook is None):
                self.log.info("[alert] %s: %s", kind, message)
                return

            # 3) 钉钉/企微文本消息格式发送。
            payload = {
                "msgtype": "text",
                "text": {"content": f"[AI看板] {message}"},
            }
            resp = requests.post(self.webhook, json=payload, timeout=5)
            # 部分机器人返回 200 但 body 标识失败；这里仅记录状态码，不抛。
            self.log.info(
                "[alert] 已发送 kind=%s status=%s", kind, resp.status_code
            )
        except Exception as exc:  # noqa: BLE001 — 契约要求宽兜底，仅 log 不抛
            # 任何失败（网络超时、连接拒绝、序列化错误等）都不影响守护主流程。
            self.log.warning("[alert] 发送失败 kind=%s: %s", kind, exc)
