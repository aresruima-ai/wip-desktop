from __future__ import annotations

"""系统托盘常驻模块。

职责:
    提供一个 Windows 系统托盘图标(pystray + PIL), 右键菜单可:
    查看看板运行状态、重启看板(Node)、重启投屏(kiosk)、暂停/恢复守护、
    打开看板页面、打开日志目录、退出。

设计要点:
    - 托盘图标颜色随 ManagerState.node_status() 变化:
        运行中 -> 绿 #3ecf8e; 熔断 -> 红 #e05260; 已停止 -> 灰 #888。
    - 耗时回调(重启看板/重启投屏)起新 daemon 线程, 避免阻塞 pystray 的
      菜单线程。
    - on_toggle_mute 持 state.lock 翻转 state.muted。
    - tray.enabled=False 时 run() 不创建托盘, 仅以 _quit 事件阻塞做纯
      守护, 由 manager 调 stop() 唤醒退出。
"""

import os
import threading
import webbrowser
from typing import Any, Callable

from PIL import Image, ImageDraw
from pystray import Icon, Menu, MenuItem

import logging

# 本模块 logger, 命名遵循 log.py 规范
logger = logging.getLogger("manager.tray")


class TrayApp:
    """系统托盘应用。管理托盘图标、右键菜单与各菜单回调。"""

    # 状态 -> 前景色(用于绘制字母 A 与指示)。键必须与 state.node_status() 返回值一致。
    _STATUS_COLOR: dict = {
        "运行中": "#3ecf8e",
        "熔断": "#e05260",
        "已停止": "#888888",
    }
    # 托盘图标深色底色
    _BG_COLOR: str = "#1e1e1e"

    def __init__(
        self,
        cfg: dict,
        state: Any,
        log: logging.Logger,
        guard: Any,
        watchdog: Any,
        kiosk: Any,
    ) -> None:
        """保存各模块引用并初始化托盘配置。

        参数:
            cfg:      由 config.load_config 返回的配置字典。
            state:    共享状态 ManagerState 实例。
            log:      manager logger。
            guard:    NodeGuard 实例(提供 restart)。
            watchdog: Watchdog 实例(保留引用, 供后续扩展)。
            kiosk:    ScreenKiosk 实例(提供 relaunch)。
        """
        self.cfg: dict = cfg
        self.state: Any = state
        self.log: logging.Logger = log
        self.guard: Any = guard
        self.watchdog: Any = watchdog
        self.kiosk: Any = kiosk

        # 退出事件: run() 阻塞于它(纯守护模式)或 icon.stop(); stop() 置位。
        self._quit: threading.Event = threading.Event()
        # 已创建的托盘图标实例(未启用托盘时保持 None)。
        self._icon: Icon | None = None

        # 图标刷新: 颜色随状态变化, 由后台线程周期性重设图标图片实现。
        # 停止事件用于唤醒刷新线程退出。
        self._refresh_stop: threading.Event = threading.Event()
        # 图标刷新间隔(秒): 周期重画图标图片 + 刷新菜单, 使图标颜色随状态
        # (运行中绿/熔断红/已停止灰)更新, 满足契约 §7.8 颜色随状态要求。
        self._refresh_interval: float = 3.0
        self._icon_refresh_thread: threading.Thread | None = None

        # 读取 tray 配置(部分健壮: 缺失补默认)。
        tray_cfg: dict = cfg.get("tray", {}) or {}
        self.enabled: bool = bool(tray_cfg.get("enabled", True))
        self.title: str = str(tray_cfg.get("title", "AI看板管理器"))

    # ------------------------------------------------------------------
    # 图标绘制
    # ------------------------------------------------------------------
    def _status_color(self) -> str:
        """返回当前状态对应的十六进制颜色字符串(带 #)。"""
        try:
            status = self.state.node_status()
        except Exception:
            status = "已停止"
        return self._STATUS_COLOR.get(status, "#888888")

    def _make_icon_image(self) -> Image.Image:
        """绘制并返回托盘图标图片: 64x64 深色底圆 + 状态色字母 'A'。

        仅负责绘制 PIL.Image, 不创建 pystray.Icon。状态变更时可用返回的
        图片重设 self._icon.icon 以刷新图标颜色(无需重建整个 Icon)。
        """
        size: int = 64
        img: Image.Image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        draw: ImageDraw.ImageDraw = ImageDraw.Draw(img)

        # 深色背景圆(留 2px 边距)。
        margin: int = 2
        draw.ellipse(
            (margin, margin, size - margin, size - margin),
            fill=self._BG_COLOR,
        )

        # 状态色字母 'A', 居中。字体用默认位图字体即可, 64x64 下约 36px。
        fg: str = self._status_color()
        # 字母绘制: 以文本 bbox 居中。
        try:
            text = "A"
            # 用 load_default 字体绘制较大字母; bbox 计算居中位置。
            fnt = Image.load_default()  # 默认字体(各平台可用)
            bbox = draw.textbbox((0, 0), text, font=fnt)
            tw = bbox[2] - bbox[0]
            th = bbox[3] - bbox[1]
            tx = (size - tw) / 2 - bbox[0]
            ty = (size - th) / 2 - bbox[1]
            draw.text((tx, ty), text, font=fnt, fill=fg)
        except Exception:
            # 字体不可用时回退: 画一个状态色实心圆点作为指示。
            r = size // 4
            cx = size // 2
            draw.ellipse((cx - r, cx - r, cx + r, cx + r), fill=fg)

        return img

    def _make_icon(self) -> Icon:
        """构造托盘图标(Icon 实例): 用 _make_icon_image 绘制图片 + 右键菜单。"""
        menu: Menu = self._make_menu()
        icon: Icon = Icon(
            "dashboard_manager",
            self._make_icon_image(),
            self.title,
            menu,
        )
        return icon

    def _make_menu(self) -> Menu:
        """构造右键菜单(含动态状态项与动态暂停/恢复文本)。"""
        # 动态状态项: enabled=False, 仅展示。
        status_item = MenuItem(
            lambda i: f"看板: {self.state.node_status()}",
            None,
            enabled=False,
        )
        # 动态暂停/恢复守护项。
        mute_item = MenuItem(
            lambda i: "恢复守护" if self.state.muted else "暂停守护",
            self.on_toggle_mute,
        )
        return Menu(
            status_item,
            Menu.SEPARATOR,
            MenuItem("重启看板", self.on_restart_node),
            MenuItem("重启投屏", self.on_restart_kiosk),
            mute_item,
            Menu.SEPARATOR,
            MenuItem("打开看板页面", self.on_open_page),
            MenuItem("打开日志目录", self.on_open_logs),
            MenuItem("退出", self.on_quit),
        )

    # ------------------------------------------------------------------
    # 菜单回调
    # ------------------------------------------------------------------
    def on_restart_node(self, icon: Icon | None, item: MenuItem | None) -> None:
        """重启 Node 看板后端。耗时操作起新线程, 不阻塞菜单线程。"""
        try:
            threading.Thread(
                target=self.guard.restart,
                args=("托盘",),
                daemon=True,
                name="tray-restart-node",
            ).start()
            self.log.info("托盘: 已触发重启看板")
        except Exception as exc:  # 兜底, 绝不冒泡到 pystray
            self.log.error("托盘: 触发重启看板失败: %s", exc)

    def on_restart_kiosk(self, icon: Icon | None, item: MenuItem | None) -> None:
        """重启投屏浏览器。耗时操作起新线程。"""
        try:
            threading.Thread(
                target=self.kiosk.relaunch,
                daemon=True,
                name="tray-restart-kiosk",
            ).start()
            self.log.info("托盘: 已触发重启投屏")
        except Exception as exc:  # 兜底
            self.log.error("托盘: 触发重启投屏失败: %s", exc)

    def on_toggle_mute(self, icon: Icon | None, item: MenuItem | None) -> None:
        """翻转守护暂停状态。持锁修改 state.muted。"""
        try:
            with self.state.lock:
                self.state.muted = not self.state.muted
                muted = self.state.muted
            self.log.info("托盘: 守护已%s", "暂停" if muted else "恢复")
        except Exception as exc:  # 兜底
            self.log.error("托盘: 切换守护状态失败: %s", exc)

    def on_open_page(self, icon: Icon | None, item: MenuItem | None) -> None:
        """用默认浏览器打开看板页面 URL。"""
        try:
            url = self.cfg.get("kiosk", {}).get("url")
            if url:
                webbrowser.open(url)
                self.log.info("托盘: 打开看板页面 %s", url)
        except Exception as exc:  # 兜底
            self.log.error("托盘: 打开看板页面失败: %s", exc)

    def on_open_logs(self, icon: Icon | None, item: MenuItem | None) -> None:
        """在资源管理器中打开日志目录。"""
        try:
            log_dir = self.cfg.get("log", {}).get("dir")
            if log_dir and os.path.isdir(log_dir):
                os.startfile(log_dir)  # type: ignore[attr-defined]
                self.log.info("托盘: 打开日志目录 %s", log_dir)
            elif log_dir:
                self.log.warning("托盘: 日志目录不存在: %s", log_dir)
        except Exception as exc:  # 兜底
            self.log.error("托盘: 打开日志目录失败: %s", exc)

    def on_quit(self, icon: Icon | None, item: MenuItem | None) -> None:
        """退出: 置退出事件并停止托盘图标。"""
        try:
            self.log.info("托盘: 收到退出指令")
            self._quit.set()
            if icon is not None:
                icon.stop()
            elif self._icon is not None:
                self._icon.stop()
        except Exception as exc:  # 兜底
            self.log.error("托盘: 退出处理失败: %s", exc)

    # ------------------------------------------------------------------
    # 图标状态刷新
    # ------------------------------------------------------------------
    def refresh_icon(self) -> None:
        """按当前状态重设托盘图标图片并刷新菜单。

        仅重画图片(self._icon.icon = 新 Image)与调用 update_menu(), 不重建
        整个 Icon 实例, 避免中断 pystray 事件循环。颜色随 state.node_status()
        变化: 运行中绿/熔断红/已停止灰, 满足契约 §7.8。供刷新线程周期调用,
        也可由外部(NodeGuard/watchdog 状态变更后)主动触发。
        """
        icon = self._icon
        if icon is None:
            return
        try:
            # 重设图标图片: 触发 pystray 在下次渲染时使用新图片。
            icon.icon = self._make_icon_image()
            # 刷新菜单: 让动态状态项/暂停-恢复文本重新求值。
            icon.update_menu()
        except Exception as exc:  # noqa: BLE001 - 刷新失败不致管理器崩溃
            self.log.warning("托盘: 刷新图标失败: %s", exc)

    def _refresh_loop(self) -> None:
        """图标刷新守护线程主循环: 周期重设图标图片使颜色随状态更新。

        循环体 try/except 兜底, 异常仅 log 绝不冒泡; 所有 sleep 用
        _refresh_stop.wait() 以保证 stop() 时可中断退出。
        """
        while not self._refresh_stop.is_set():
            try:
                self.refresh_icon()
            except Exception as exc:  # noqa: BLE001
                self.log.warning("托盘: 图标刷新循环异常: %s", exc)
            self._refresh_stop.wait(self._refresh_interval)

    # ------------------------------------------------------------------
    # 生命周期
    # ------------------------------------------------------------------
    def run(self) -> None:
        """运行托盘。enabled=False 时纯守护阻塞, 否则阻塞于图标事件循环。"""
        if not self.enabled:
            # 无托盘纯守护模式: 阻塞至 stop() 唤醒。
            self.log.info("托盘未启用, 进入纯守护阻塞")
            self._quit.wait()
            return

        try:
            self._icon = self._make_icon()
            self.log.info("托盘已启用, 启动图标事件循环: %s", self.title)
            # 启动图标刷新守护线程: 周期重设图标图片使颜色随状态更新。
            self._icon_refresh_thread = threading.Thread(
                target=self._refresh_loop,
                daemon=True,
                name="tray-icon-refresh",
            )
            self._icon_refresh_thread.start()
            # run() 阻塞直到 icon.stop() 被调用(由 on_quit 或 stop 触发)。
            self._icon.run()
        except Exception as exc:
            # 托盘初始化/运行异常不致管理器崩溃; 降级为纯守护阻塞。
            self.log.error("托盘运行异常, 降级为纯守护阻塞: %s", exc)
            self._quit.wait()

    def stop(self) -> None:
        """停止托盘: 置退出事件, 停止图标刷新线程, 停止图标事件循环。"""
        self._quit.set()
        # 唤醒图标刷新线程退出。
        self._refresh_stop.set()
        if self._icon_refresh_thread is not None:
            try:
                self._icon_refresh_thread.join(timeout=2)
            except Exception as exc:  # noqa: BLE001
                self.log.warning("托盘: 等待图标刷新线程退出异常: %s", exc)
            self._icon_refresh_thread = None
        if self._icon is not None:
            try:
                self._icon.stop()
            except Exception as exc:
                self.log.warning("托盘: 停止图标时异常: %s", exc)
