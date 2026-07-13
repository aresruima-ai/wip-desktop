from __future__ import annotations

"""控制面板 HTTP 服务模块。

职责: 提供网页控制台, 实时展示 manager 守护状态(node 进程/探活/重启次数/熔断/
日志)并提供控制操作(重启看板/重启投屏/暂停守护)。端口避开看板 8080, 用 8081。

设计:
- 标准库 http.server, 无新增第三方依赖。
- GET /            → 控制面板 HTML(panel.html)
- GET /api/status  → JSON 状态快照(读 state, 持锁)
- GET /api/logs    → 最近 200 行 manager.log
- POST /api/restart-node   → guard.restart('panel')(异步线程, 不阻塞 HTTP)
- POST /api/restart-kiosk  → kiosk.relaunch()(异步线程)
- POST /api/toggle-mute    → 翻转 state.muted
- 鉴权: panel.key 非 None 时, 需 ?key=xxx; null=不鉴权(仅内网)
- serve_forever 阻塞, stop() 起 shutdown 线程唤醒退出。

接口契约见 dashboard_manager/CONTRACTS.md §7.10。
"""

import json
import os
import threading
import time
from http.server import HTTPServer, BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs


class PanelServer(threading.Thread):
    """控制面板 HTTP 服务线程。"""

    def __init__(self, cfg, state, log, guard, kiosk):
        super().__init__(daemon=True, name="PanelServer")
        self.cfg = cfg
        self.state = state
        self.log = log
        self.guard = guard
        self.kiosk = kiosk
        p = cfg.get("panel", {}) or {}
        self.enabled = bool(p.get("enabled", True))
        self.port = int(p.get("port", 8081))
        self.key = p.get("key")  # None=不鉴权
        self._httpd = None
        self._html_path = os.path.join(
            os.path.dirname(os.path.abspath(__file__)), "panel.html"
        )
        self._started_at = time.time()

    def _snapshot(self) -> dict:
        """读 state 生成状态快照(持锁)。"""
        with self.state.lock:
            return {
                "node_status": self.state.node_status(),
                "node_pid": self.state.node_pid,
                "node_started_at": self.state.node_started_at,
                "restart_count": self.state.restart_count,
                "consecutive_crashes": self.state.consecutive_crashes,
                "circuit_open": self.state.circuit_open,
                "circuit_until": self.state.circuit_until,
                "last_health_ok": self.state.last_health_ok,
                "last_health_at": self.state.last_health_at,
                "last_has_cookie": self.state.last_has_cookie,
                "health_fail_streak": self.state.health_fail_streak,
                "muted": self.state.muted,
                "kiosk_pid": self.state.kiosk_pid,
                "uptime": int(time.time() - self._started_at),
            }

    def _check_key(self, params) -> bool:
        if self.key is None:
            return True
        return params.get("key", [None])[0] == self.key

    def run(self) -> None:
        if not self.enabled:
            self.log.info("PanelServer 未启用, 跳过")
            return
        panel = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _params(self):
                return parse_qs(urlparse(self.path).query)

            def _send(self, code, body, ctype="application/json; charset=utf-8"):
                b = body.encode("utf-8") if isinstance(body, str) else body
                self.send_response(code)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(b)))
                self.end_headers()
                try:
                    self.wfile.write(b)
                except Exception:
                    pass

            def do_GET(self):
                if not panel._check_key(self._params()):
                    self._send(401, '{"error":"unauthorized"}')
                    return
                path = urlparse(self.path).path
                if path in ("/", "/index.html"):
                    try:
                        with open(panel._html_path, "r", encoding="utf-8") as f:
                            html = f.read()
                    except Exception as e:
                        html = "<html><body>面板HTML读取失败: %s</body></html>" % e
                    self._send(200, html, "text/html; charset=utf-8")
                    return
                if path == "/api/status":
                    self._send(200, json.dumps(panel._snapshot(), ensure_ascii=False))
                    return
                if path == "/api/logs":
                    try:
                        params = self._params()
                        source = params.get("source", ["manager"])[0]
                        lines_n = int(params.get("lines", ["500"])[0])
                        fname = "node.stdout.log" if source == "node" else "manager.log"
                        log_path = os.path.join(panel.cfg["log"]["dir"], fname)
                        with open(log_path, "r", encoding="utf-8", errors="replace") as f:
                            all_lines = f.readlines()
                        lines = all_lines[-lines_n:] if lines_n > 0 else all_lines
                        self._send(200, "".join(lines), "text/plain; charset=utf-8")
                    except Exception as e:
                        self._send(200, "日志读取失败: %s" % e, "text/plain; charset=utf-8")
                    return
                self._send(404, '{"error":"not found"}')

            def do_POST(self):
                if not panel._check_key(self._params()):
                    self._send(401, '{"error":"unauthorized"}')
                    return
                path = urlparse(self.path).path
                if path == "/api/restart-node":
                    threading.Thread(
                        target=panel.guard.restart, args=("panel",), daemon=True
                    ).start()
                    self._send(200, "已触发重启看板")
                    return
                if path == "/api/restart-kiosk":
                    threading.Thread(target=panel.kiosk.relaunch, daemon=True).start()
                    self._send(200, "已触发重启投屏")
                    return
                if path == "/api/toggle-mute":
                    with panel.state.lock:
                        panel.state.muted = not panel.state.muted
                        m = panel.state.muted
                    panel.log.info("控制面板切换守护 muted=%s", m)
                    self._send(200, "已" + ("暂停" if m else "恢复") + "守护")
                    return
                self._send(404, '{"error":"not found"}')

        try:
            self._httpd = ThreadingHTTPServer(("0.0.0.0", self.port), Handler)
            self.log.info("控制面板已启动: http://localhost:%s", self.port)
            self._httpd.serve_forever()
        except Exception as e:
            self.log.error("控制面板启动失败: %s", e)

    def stop(self) -> None:
        """停止 HTTP 服务(起 shutdown 线程唤醒 serve_forever)。"""
        if self._httpd:
            try:
                threading.Thread(target=self._httpd.shutdown, daemon=True).start()
            except Exception:
                pass
