from __future__ import annotations

"""AI看板运维管理器 — 入口模块。

职责:
  - 加载配置(config.yaml)、初始化日志、构建共享状态与各功能模块。
  - 串联守护链: NodeGuard(守护Node进程) + Watchdog(探活自愈) + ScreenKiosk(投屏管理) + TrayApp(托盘)。
  - 注册系统退出信号(SIGINT/SIGBREAK)处理, 收到信号时唤醒托盘退出。
  - 托盘 run() 阻塞主线程; 退出时按 kiosk -> watchdog -> guard 顺序 stop() 并 join(timeout)。

模块依赖见 CONTRACTS §9: manager 依赖全部子模块。
"""

import os
import signal
import threading
from os.path import abspath, dirname, join

from config import load_config
from log import setup_logging
from state import ManagerState
from alert import Alerter
from proc_guard import NodeGuard
from watchdog import Watchdog
from screen_kiosk import ScreenKiosk
from tray import TrayApp
from panel import PanelServer

# 类型提示用的前向引用(仅注解, 运行时不依赖)
from typing import Any


def _make_signal_handler(log: Any, tray: TrayApp):
    """构造信号处理函数。

    信号回调里只做两件事: 记日志 + 唤醒托盘退出(tray.stop 会 set _quit 并 stop icon,
    从而让 tray.run() 解除阻塞, 进入 manager 的退出清理流程)。
    所有动作都包在 try/except 中, 防止信号上下文抛异常导致进程僵死。

    Args:
        log: logging.Logger 实例。
        tray: TrayApp 实例。

    Returns:
        可注册给 signal.signal 的回调 handler(signum, frame)。
    """

    def _handler(signum, frame) -> None:  # noqa: ANN001 信号回调签名固定
        try:
            log.info('收到退出信号')
        except Exception:
            # 日志本身异常也不能让信号处理崩溃
            pass
        try:
            tray.stop()
        except Exception:
            pass

    return _handler


def main() -> None:
    """管理器主入口。

    严格按 CONTRACTS §7.9 串联各模块并阻塞至退出信号。
    """

    # 1. 配置与日志
    CONFIG_PATH = join(dirname(abspath(__file__)), 'config.yaml')
    cfg = load_config(CONFIG_PATH)
    log = setup_logging(cfg)
    log.info('AI看板管理器启动')

    # 2. 共享状态与告警器
    state = ManagerState()
    alerter = Alerter(cfg, state, log)

    # 3. 各功能模块实例化(顺序: guard -> watchdog(依赖guard) -> kiosk -> tray(依赖前三者))
    guard = NodeGuard(cfg, state, log, alerter)
    watchdog = Watchdog(cfg, state, log, guard, alerter)
    kiosk = ScreenKiosk(cfg, state, log, alerter)
    tray = TrayApp(cfg, state, log, guard, watchdog, kiosk)
    panel = PanelServer(cfg, state, log, guard, kiosk)

    # 4. 启动守护线程(Node守护 / 探活 / 投屏 / 控制面板)
    guard.start()
    watchdog.start()
    kiosk.start()
    panel.start()

    # 控制面板自动打开浏览器(panel HTTP 起来需 1-2s, 延迟开)
    if (cfg.get('panel', {}) or {}).get('auto_open', True):
        import webbrowser
        threading.Timer(2.0, lambda: webbrowser.open('http://localhost:%s' % panel.port)).start()

    # 5. 注册退出信号处理
    #    _handler 内部会调用 tray.stop() 唤醒阻塞的 tray.run()
    _handler = _make_signal_handler(log, tray)
    signal.signal(signal.SIGINT, _handler)
    # Windows 独有的 Ctrl+Break 信号; 非Windows平台无此属性则跳过
    try:
        signal.signal(signal.SIGBREAK, _handler)
    except AttributeError:
        pass

    # 6. 托盘阻塞主线程(无托盘时 _quit.wait 阻塞, 由信号 stop 唤醒)
    tray.run()

    # 7. 退出清理: 按 panel -> kiosk -> watchdog -> guard 顺序 stop, 再 join(timeout)
    #    kiosk.stop 只 set stop_event, 不杀投屏窗口(让大屏保持显示)
    panel.stop()
    kiosk.stop()
    watchdog.stop()
    guard.stop()
    panel.join(timeout=5)
    guard.join(timeout=10)
    watchdog.join(timeout=5)
    kiosk.join(timeout=5)
    log.info('已退出')


if __name__ == '__main__':
    main()
