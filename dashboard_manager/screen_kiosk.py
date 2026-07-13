from __future__ import annotations

"""投屏 kiosk 管理模块。

职责：
1. 探测并启动 Edge / Chrome kiosk 全屏投屏窗口，加载看板 URL。
2. 周期性检查投屏窗口是否存活，消失则自动重开。
3. 每天到指定时刻重开一次 kiosk，防止浏览器长期运行内存泄漏。
4. 支持外部（托盘）触发 relaunch 手动重开。
5. 管理器退出时不杀 kiosk，保持大屏持续显示。

守护线程 run() 循环体异常兜底仅 log，绝不冒泡；所有 sleep 用
stop_event.wait()，循环用 while not stop_event.is_set()。
"""

import os
import subprocess
import threading
import datetime
from typing import Optional, Tuple

import psutil

import logging


class ScreenKiosk(threading.Thread):
    """投屏 kiosk 守护线程。

    周期探活浏览器 kiosk 进程，丢失则拉起；每日定时重开。
    """

    # Edge 常见安装路径
    _EDGE_PATHS = (
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    )
    # Chrome 常见安装路径
    _CHROME_PATHS = (
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    )
    # 进程名匹配（小写）
    _EDGE_NAMES = ("msedge.exe",)
    _CHROME_NAMES = ("chrome.exe",)

    def __init__(self, cfg: dict, state, log: logging.Logger, alerter) -> None:
        super().__init__(daemon=True, name="ScreenKiosk")
        self.stop_event = threading.Event()
        self.cfg = cfg
        self.state = state
        self.log = log
        self.alerter = alerter

        # 读取 kiosk 配置（缺失健壮处理）
        kiosk = cfg.get("kiosk", {}) or {}
        self.enabled: bool = bool(kiosk.get("enabled", True))
        self.url: str = kiosk.get("url", "http://localhost:8080/portal.html")
        self.browser: str = (kiosk.get("browser", "edge") or "edge").lower()
        self.browser_path: Optional[str] = kiosk.get("browser_path") or None
        self.check_interval_sec: int = int(kiosk.get("check_interval_sec", 30))

        # 解析 daily_reload_time "HH:MM" 为 (h, m)
        self._daily_reload: Optional[Tuple[int, int]] = None
        raw_time = kiosk.get("daily_reload_time")
        if raw_time:
            try:
                parts = str(raw_time).strip().split(":")
                h, m = int(parts[0]), int(parts[1])
                if 0 <= h <= 23 and 0 <= m <= 59:
                    self._daily_reload = (h, m)
                else:
                    self.log.warning("kiosk.daily_reload_time 越界已忽略: %s", raw_time)
            except (ValueError, IndexError):
                self.log.warning("kiosk.daily_reload_time 解析失败已忽略: %s", raw_time)

        # 每日重开标记：记录上次重开的日期，确保每天只重开一次
        self._last_reload_date: Optional[datetime.date] = None
        # 浏览器可执行文件缓存
        self._browser_exe: Optional[str] = None
        # 拉起/重开互斥锁: 串行化 _ensure_running 与 relaunch, 防止托盘手动
        # 重开与自动补开并发拉起两个 kiosk 窗口
        self._kiosk_lock = threading.Lock()
        # 启动时间戳, 用于 daily_reload 启动冷却(避免启动即重开打断投屏)
        self._started_at: Optional[datetime.datetime] = None

        self.log.info(
            "ScreenKiosk 初始化完成 enabled=%s browser=%s url=%s check=%ss reload=%s",
            self.enabled, self.browser, self.url, self.check_interval_sec,
            self._daily_reload,
        )

    # ------------------------------------------------------------------
    # 浏览器探测
    # ------------------------------------------------------------------
    def _detect_browser(self) -> str:
        """探测浏览器可执行文件路径并缓存。

        优先级：browser_path 非空且存在 → 用之；否则按 browser 字段探测
        edge/chrome 常见路径。找不到 raise RuntimeError。结果缓存到
        self._browser_exe。
        """
        if self._browser_exe and os.path.isfile(self._browser_exe):
            return self._browser_exe

        # 显式指定的 browser_path 优先
        if self.browser_path and os.path.isfile(self.browser_path):
            self._browser_exe = self.browser_path
            self.log.info("使用配置指定的浏览器路径: %s", self._browser_exe)
            return self._browser_exe

        # 按 browser 字段探测
        if self.browser == "edge":
            candidates = self._EDGE_PATHS
        elif self.browser == "chrome":
            candidates = self._CHROME_PATHS
        else:
            raise RuntimeError(f"不支持的 kiosk.browser: {self.browser}")

        for path in candidates:
            if os.path.isfile(path):
                self._browser_exe = path
                self.log.info("探测到浏览器可执行文件: %s", path)
                return path

        raise RuntimeError(
            f"未找到浏览器可执行文件(browser={self.browser})，"
            f"尝试路径: {candidates}；请在 config.yaml 配置 kiosk.browser_path"
        )

    # ------------------------------------------------------------------
    # 存活检测
    # ------------------------------------------------------------------
    def _kiosk_proc_names_lower(self) -> tuple:
        if self.browser == "edge":
            names = self._EDGE_NAMES
        elif self.browser == "chrome":
            names = self._CHROME_NAMES
        else:
            names = self._EDGE_NAMES + self._CHROME_NAMES
        return tuple(n.lower() for n in names)

    def _iter_kiosk_procs(self):
        """枚举匹配本 URL 的 kiosk 进程(返回 psutil.Process 列表)。

        用 psutil.pids() + 单独 Process(pid) 取代 process_iter(info_cache) ——
        process_iter 在 Windows 上偶发 WinError 998(内存位置访问无效, 进程退出竞态致
        info 缓存损坏), 一抛异常整个枚举返回空 → _is_kiosk_alive 误判未存活 → 反复
        拉起重复 kiosk 窗口。逐 pid 构造 + 广谱 except 把单进程故障隔离, 不影响整体枚举。
        """
        names_lower = self._kiosk_proc_names_lower()
        url_lower = self.url.lower()
        out = []
        try:
            pids = psutil.pids()
        except Exception as e:
            self.log.warning("psutil.pids() 异常: %s", e)
            return out
        for pid in pids:
            try:
                proc = psutil.Process(pid)
                name = (proc.name() or "").lower()
                if name not in names_lower:
                    continue
                cmdline = proc.cmdline() or []
                if not cmdline:
                    continue
                joined = " ".join(str(a) for a in cmdline).lower()
                if "--kiosk" in joined and url_lower in joined:
                    out.append(proc)
            except (psutil.NoSuchProcess, psutil.AccessDenied, OSError):
                continue
            except Exception:
                continue
        return out

    def _is_kiosk_alive(self) -> bool:
        """检测当前是否有 kiosk 进程在运行本 URL。

        优先按 state.kiosk_pid 单点判定(可靠); 失败再走枚举。枚举本身抛异常时
        返回 True(假定存活)——避免误判未存活而反复拉起重复 kiosk 窗口(重复比漏拉更糟)。
        """
        # 1. 优先单点 PID 判定
        pid = None
        with self.state.lock:
            pid = self.state.kiosk_pid
        if pid:
            try:
                p = psutil.Process(pid)
                if p.is_running() and (p.name() or "").lower() in self._kiosk_proc_names_lower():
                    return True
            except (psutil.NoSuchProcess, psutil.AccessDenied, OSError):
                pass
            except Exception:
                pass
        # 2. 枚举兜底
        try:
            return len(self._iter_kiosk_procs()) > 0
        except Exception as e:
            self.log.warning("kiosk 存活检测枚举异常, 假定存活避免重复拉起: %s", e)
            return True

    # ------------------------------------------------------------------
    # 启动 / 重开
    # ------------------------------------------------------------------
    def _launch(self) -> None:
        """启动一个新的 kiosk 进程。失败仅告警，不抛。"""
        try:
            exe = self._detect_browser()
            args = [exe, "--kiosk", self.url,
                    "--no-first-run", "--no-default-browser-check"]
            # Edge 追加全屏 kiosk 类型参数
            if self.browser == "edge":
                args.append("--edge-kiosk-type=fullscreen")

            self.log.info("启动投屏 kiosk: %s", " ".join(args))
            proc = subprocess.Popen(
                args,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
            with self.state.lock:
                self.state.kiosk_pid = proc.pid
            self.log.info("投屏 kiosk 已启动 pid=%s", proc.pid)
        except Exception as e:
            self.log.error("启动投屏 kiosk 失败: %s", e)
            try:
                self.alerter.notify("kiosk", f"投屏启动失败: {e}")
            except Exception:
                pass

    def _ensure_running(self) -> None:
        """若 kiosk 未存活则启动一个。持锁内复检, 防止与 relaunch 并发双开。"""
        with self._kiosk_lock:
            if not self._is_kiosk_alive():
                self.log.info("投屏未运行，尝试拉起")
                self._launch()

    def _kill_current_kiosk(self) -> None:
        """杀掉当前 kiosk 进程。

        优先按 state.kiosk_pid；同时兜底按 url 匹配的 psutil 进程。
        terminate 后等 2s，仍活 kill。
        """
        targets = []  # psutil.Process 列表

        # 按 pid
        pid = None
        with self.state.lock:
            pid = self.state.kiosk_pid
        if pid:
            try:
                p = psutil.Process(pid)
                targets.append(p)
            except (psutil.NoSuchProcess, psutil.AccessDenied, OSError):
                pass

        # 按 url 匹配兜底(防止 pid 失效或与实际进程对不上)。用 _iter_kiosk_procs
        # 逐 pid 枚举, 避免 process_iter 的 WinError 998 整体抛空。
        for proc in self._iter_kiosk_procs():
            if not any(t.pid == proc.pid for t in targets):
                targets.append(proc)

        if not targets:
            self.log.info("未发现需要关闭的 kiosk 进程")
            return

        # terminate
        for p in targets:
            try:
                p.terminate()
            except (psutil.NoSuchProcess, psutil.AccessDenied, OSError):
                pass

        # 等待最多 2s
        try:
            gone, alive = psutil.wait_procs(targets, timeout=2)
        except Exception as e:
            self.log.warning("wait_procs 异常: %s", e)
            alive = []
        for p in alive:
            try:
                p.kill()
            except (psutil.NoSuchProcess, psutil.AccessDenied, OSError):
                pass

        with self.state.lock:
            self.state.kiosk_pid = None
        self.log.info("已关闭 %d 个 kiosk 进程", len(targets))

    def relaunch(self) -> None:
        """外部触发重开：杀当前 kiosk 后重新启动。持 _kiosk_lock 与 _ensure_running 互斥。"""
        with self._kiosk_lock:
            try:
                self.log.info("手动/定时 relaunch 投屏")
                self._kill_current_kiosk()
            except Exception as e:
                self.log.warning("relaunch 关闭旧 kiosk 异常(忽略继续启动): %s", e)
            try:
                self._launch()
            except Exception as e:
                self.log.error("relaunch 启动新 kiosk 失败: %s", e)

    # ------------------------------------------------------------------
    # 每日定时重开
    # ------------------------------------------------------------------
    def _maybe_daily_reload(self) -> None:
        """到点且当天尚未重开，则 relaunch 一次并记录日期。

        启动后 5 分钟内不触发, 避免"启动即重开"打断刚拉起的投屏。
        """
        if self._daily_reload is None:
            return
        h, m = self._daily_reload
        now = datetime.datetime.now()
        if self._started_at is None:
            self._started_at = now
        if (now - self._started_at).total_seconds() < 300:
            return
        reload_dt = now.replace(hour=h, minute=m, second=0, microsecond=0)
        if now >= reload_dt and self._last_reload_date != now.date():
            self.log.info("每日定时重开投屏(目标 %02d:%02d)", h, m)
            self.relaunch()
            self._last_reload_date = now.date()

    # ------------------------------------------------------------------
    # 线程主循环
    # ------------------------------------------------------------------
    def run(self) -> None:
        if not self.enabled:
            self.log.info("ScreenKiosk 未启用，跳过")
            return

        # 启动时先确保有一个投屏窗口
        try:
            self._ensure_running()
        except Exception as e:
            self.log.error("ScreenKiosk 初始拉起异常: %s", e)

        while not self.stop_event.is_set():
            try:
                # 暂停守护时不操作投屏（避免与用户手动操作冲突）
                muted = False
                with self.state.lock:
                    muted = self.state.muted
                if not muted:
                    self._ensure_running()
                self._maybe_daily_reload()
            except Exception as e:
                self.log.error("ScreenKiosk 循环异常: %s", e)
            self.stop_event.wait(self.check_interval_sec)

    def stop(self) -> None:
        """停止守护线程。不杀 kiosk，保持大屏显示。"""
        self.stop_event.set()
