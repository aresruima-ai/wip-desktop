# -*- coding: utf-8 -*-
"""WIP 桌面端启动器。

流程:加载 .env → 启动 Node 后端 → 等待就绪 → pywebview 窗口加载 wip.html。
启动失败时显示暗色错误页。关窗时优雅终止后端(atexit + on_closed 双保险)。
"""
from __future__ import annotations

import atexit
import os

import webview

from backend import NodeBackend
from config import (
    HOST,
    PORT,
    WINDOW_TITLE,
    WINDOW_WIDTH,
    WINDOW_HEIGHT,
    MIN_WIDTH,
    MIN_HEIGHT,
    LOG_DIR,
    resource_path,
)


def load_dotenv(runtime_dir: str) -> dict:
    """解析 .env 文件为环境变量 dict(手写解析,不加依赖)。

    查找顺序:runtime_dir/.env(打包后) → 上级 mes_dashboard/.env(开发时)。
    支持 KEY=VALUE、# 注释、空行;值不去引号(保留原样,与 dotenv 行为一致)。

    Args:
        runtime_dir: node_runtime 目录绝对路径。

    Returns:
        环境变量 dict;未找到 .env 则返回空 dict。
    """
    candidates = [
        os.path.join(runtime_dir, '.env'),
        # 开发时:.env 在上级 mes_dashboard 目录
        os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '.env'),
    ]
    env: dict = {}
    for path in candidates:
        if os.path.isfile(path):
            with open(path, 'r', encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith('#'):
                        continue
                    if '=' not in line:
                        continue
                    key, _, value = line.partition('=')
                    env[key.strip()] = value.strip()
            break  # 用第一个找到的 .env
    return env


def build_error_html(message: str) -> str:
    """构建暗色错误页 HTML。

    配色:#010510 底,#e2e8f0 文,#e05260 错误红,#161b22 卡片,#30363d 边框。

    Args:
        message: 异常消息文本。

    Returns:
        完整 HTML 字符串。
    """
    # HTML 转义,防止异常消息中的 < > & 破坏页面
    safe_msg = (
        message
        .replace('&', '&amp;')
        .replace('<', '&lt;')
        .replace('>', '&gt;')
    )
    log_hint = f'请查看日志: {os.path.join(LOG_DIR, "node.stdout.log")}'
    return f'''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>启动失败</title>
<style>
  * {{ margin:0; padding:0; box-sizing:border-box; }}
  body {{
    background:#010510; color:#e2e8f0;
    font-family:'Microsoft YaHei UI','Segoe UI',sans-serif;
    display:flex; align-items:center; justify-content:center;
    min-height:100vh; padding:40px;
  }}
  .box {{ max-width:720px; width:100%; }}
  h1 {{ color:#e05260; font-size:22px; margin-bottom:20px; font-weight:600; }}
  .msg {{
    background:#161b22; border:1px solid #30363d; border-radius:8px;
    padding:16px 18px; font-family:Consolas,'Courier New',monospace;
    font-size:13px; line-height:1.6; white-space:pre-wrap;
    word-break:break-all; color:#c9d1d9; max-height:320px; overflow:auto;
  }}
  .hint {{ color:#8b949e; font-size:13px; margin-top:16px; }}
</style>
</head>
<body>
<div class="box">
  <h1>启动失败</h1>
  <div class="msg">{safe_msg}</div>
  <div class="hint">{log_hint}</div>
</div>
</body>
</html>'''


def show_error_page(message: str) -> None:
    """显示暗色错误页(独立 pywebview 窗口)。

    Args:
        message: 异常消息文本。
    """
    html = build_error_html(message)
    webview.create_window(
        'WIP 在制品追踪 - 启动失败',
        html=html,
        width=WINDOW_WIDTH,
        height=WINDOW_HEIGHT,
    )
    webview.start()


def main() -> None:
    """入口:启动后端 → 开窗加载 wip.html → 关窗清理后端。

    异常处理:后端启动/就绪失败或窗口异常时,停止后端并显示错误页。
    资源清理:atexit 兜底;关窗用 Window.events.closed 回调(pywebview 6.x 无 on_closed 参数)。
    """
    runtime_dir = resource_path('node_runtime')
    env = load_dotenv(runtime_dir)
    backend = NodeBackend(runtime_dir=runtime_dir, env=env)
    # atexit 兜底:无论正常退出还是异常崩溃,都尝试停止后端
    atexit.register(backend.stop)

    try:
        backend.start()
        backend.wait_ready()
        url = f'http://{HOST}:{PORT}/wip.html?standalone=1'
        # pywebview 6.x:create_window 返回 Window 对象,关窗回调改用 Window.events.closed
        # (旧版 on_closed 参数在 6.x 已移除,会抛 create_window() got unexpected keyword argument 'on_closed')
        window = webview.create_window(
            WINDOW_TITLE,
            url,
            width=WINDOW_WIDTH,
            height=WINDOW_HEIGHT,
            min_size=(MIN_WIDTH, MIN_HEIGHT),
        )
        window.events.closing += lambda: backend.stop()
        webview.start()
    except Exception as e:
        # 后端可能已启动但未就绪,确保停止
        try:
            backend.stop()
        except Exception:
            pass
        show_error_page(str(e))


if __name__ == '__main__':
    main()
