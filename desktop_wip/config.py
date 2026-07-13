# -*- coding: utf-8 -*-
"""WIP 桌面端全局配置常量与资源路径工具。

定义后端端口、窗口尺寸、Edge 浏览器候选路径、健康探活参数等,
并提供 resource_path() 兼容 PyInstaller 打包(_MEIPASS)与源码运行。
"""
from __future__ import annotations

import os
import sys

# ===== 后端连接 =====
PORT: int = 8080
HOST: str = '127.0.0.1'
HEALTH_URL: str = f'http://{HOST}:{PORT}/api/health'
STARTUP_TIMEOUT: int = 120          # 后端就绪超时(秒)— mesLogin 含 Puppeteer goto30s+waitForSelector10s+waitForFunction10s 共约 50s,listen 在其后,需留余量
HEALTH_POLL_INTERVAL: float = 0.5   # 健康轮询间隔(秒)

# ===== 日志目录(持久化,避免 PyInstaller _MEIPASS 退出即删导致崩溃日志丢失) =====
# 跨平台:Windows 用 %APPDATA%,macOS 用 ~/Library/Logs(Apple 标准)
if os.name == 'nt':
    _APPDATA = os.environ.get('APPDATA')
    LOG_DIR: str = (
        os.path.join(_APPDATA, 'WipDesktop', 'logs')
        if _APPDATA
        else os.path.join(os.path.expanduser('~'), '.wipdesktop', 'logs')
    )
else:
    LOG_DIR: str = os.path.join(os.path.expanduser('~'), 'Library', 'Logs', 'WipDesktop')

# ===== 窗口 =====
WINDOW_TITLE: str = 'WIP 在制品追踪'
WINDOW_WIDTH: int = 1440
WINDOW_HEIGHT: int = 900
MIN_WIDTH: int = 1200
MIN_HEIGHT: int = 750

def resource_path(rel: str) -> str:
    """获取资源绝对路径,兼容 PyInstaller 打包与源码运行。

    PyInstaller --onefile 模式下,资源解包到 sys._MEIPASS 临时目录;
    源码运行时,资源相对本文件所在目录。

    Args:
        rel: 相对路径片段,如 'node_runtime/server.js'。

    Returns:
        拼接后的绝对路径。
    """
    base: str = getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, rel)
