"""supervise_manager.py — manager 自拉 supervisor。

由 Windows 计划任务每 1min 调用(见 install_supervisor.bat)。
探活 manager panel(8081); 任何 HTTP 响应(200/401/404 都算存活, 仅连接拒绝/超时算死)
→ 死了就用 pythonw 无窗口拉起 manager.py。
"""
import os
import sys
import subprocess

import requests

HERE = os.path.dirname(os.path.abspath(__file__))


def manager_alive() -> bool:
    try:
        r = requests.get("http://127.0.0.1:8081/api/status", timeout=3)
        # 200/401/404 都说明 manager 在响应(401=未带 key); 只有连不上/超时才算死
        return r.status_code < 500
    except Exception:
        return False


def relaunch() -> None:
    # pythonw 无窗口; CREATE_NO_WINDOW 兜底; cwd=HERE 让相对日志路径正确
    try:
        subprocess.Popen(
            ["pythonw.exe", "manager.py"],
            cwd=HERE,
            creationflags=0x08000000,  # CREATE_NO_WINDOW
        )
    except Exception as e:
        # pythonw 不在 PATH 时退回 python
        try:
            subprocess.Popen(["python.exe", "manager.py"], cwd=HERE, creationflags=0x08000000)
        except Exception:
            sys.stderr.write("supervise_manager relaunch 失败: %s\n" % e)


if __name__ == "__main__":
    if manager_alive():
        sys.exit(0)
    relaunch()
