# -*- coding: utf-8 -*-
"""Node 后端进程管理。

封装 server.js 子进程的启动、健康探活、优雅终止,供 launcher 调用。
WIP_DESKTOP_MODE=1 时 server.js 仅暴露白名单路由,绑定 127.0.0.1。
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
import urllib.request
from typing import Optional

import psutil

from config import HEALTH_URL, HEALTH_POLL_INTERVAL, STARTUP_TIMEOUT, LOG_DIR


class NodeBackend:
    """管理 Node server.js 子进程的生命周期。

    Attributes:
        runtime_dir: node_runtime 目录绝对路径(含 node.exe/server.js/node_modules)。
        env: 额外注入子进程的环境变量 dict(.env 解析结果)。
        node_exe: node.exe 绝对路径。
        server_js: server.js 绝对路径。
    """

    def __init__(self, runtime_dir: str, env: dict | None = None) -> None:
        """初始化后端管理器,定位 node.exe 与 server.js。

        Args:
            runtime_dir: node_runtime 目录绝对路径。
            env: 注入子进程的环境变量(.env 解析结果),可为 None。

        Raises:
            RuntimeError: server.js 或 node.exe 未找到。
        """
        self.runtime_dir: str = runtime_dir
        self.env: dict = env or {}
        self.node_exe: str = self._locate_node()
        self.server_js: str = os.path.join(runtime_dir, 'server.js')
        self._proc: Optional[subprocess.Popen] = None
        self._log_fp = None  # stdout 日志文件句柄,stop 时关闭

        if not os.path.isfile(self.server_js):
            raise RuntimeError(f'server.js 未找到: {self.server_js}')

    def _locate_node(self) -> str:
        """定位 node 可执行文件:优先 runtime_dir 内,回退系统 PATH。

        跨平台:Windows 找 node.exe,macOS/Linux 找 node。打包时 node 二进制随平台,
        开发时回退系统 PATH(虚拟机里用 brew 装的 node)。

        Returns:
            node 可执行文件绝对路径。

        Raises:
            RuntimeError: 两个位置都找不到 node。
        """
        # Windows: node.exe;macOS/Linux: node
        candidates = []
        if os.name == 'nt':
            candidates.append(os.path.join(self.runtime_dir, 'node.exe'))
        else:
            candidates.append(os.path.join(self.runtime_dir, 'node'))
            candidates.append(os.path.join(self.runtime_dir, 'node.exe'))  # 兼容意外带的 win 二进制
        for c in candidates:
            if os.path.isfile(c):
                return c
        # 回退系统 PATH(macOS 虚拟机里 brew 装的 node)
        system_node = shutil.which('node')
        if system_node:
            return system_node
        raise RuntimeError(
            f'未找到 node:既不在 {self.runtime_dir} 内,也不在系统 PATH。'
            f'(macOS 请 brew install node)'
        )

    def _log_path(self) -> str:
        """返回 stdout/stderr 合并日志路径(持久化目录,不随 _MEIPASS 退出删除)。"""
        return os.path.join(LOG_DIR, 'node.stdout.log')

    def _read_log_tail(self, lines: int = 30) -> str:
        """读取日志尾部 N 行(用于错误诊断)。

        Args:
            lines: 读取行数。

        Returns:
            日志尾部文本;读取失败返回提示。
        """
        try:
            with open(self._log_path(), 'r', encoding='utf-8', errors='replace') as f:
                tail = f.readlines()[-lines:]
            return ''.join(tail)
        except Exception:
            return '(无法读取日志)'

    def start(self) -> None:
        """启动 Node server.js 子进程。

        子进程工作目录为 runtime_dir,环境变量合并 os.environ + .env + WIP_DESKTOP_MODE=1,
        stdout/stderr 合并写入 logs/node.stdout.log。Windows 下用 CREATE_NO_WINDOW
        隐藏控制台窗口。

        Raises:
            RuntimeError: 启动失败,附原因。
        """
        log_dir = LOG_DIR
        os.makedirs(log_dir, exist_ok=True)

        # 合并环境变量:系统环境 + .env 解析结果 + 桌面模式标记
        merged_env = {**os.environ, **self.env, 'WIP_DESKTOP_MODE': '1'}
        try:
            self._log_fp = open(self._log_path(), 'a', encoding='utf-8')
            self._proc = subprocess.Popen(
                [self.node_exe, 'server.js'],
                cwd=self.runtime_dir,
                env=merged_env,
                stdout=self._log_fp,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                # Windows:不弹出控制台窗口
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0,
            )
        except Exception as e:
            raise RuntimeError(f'启动 Node 后端失败: {e}') from e

    def wait_ready(self, timeout: int = STARTUP_TIMEOUT) -> bool:
        """轮询健康检查接口,等待后端就绪。

        用 urllib.request 轮询 /api/health,直到 JSON 含 status=='ok' 且 hasCookie=true。
        hasCookie=false 表示 MES 登录失败(mesLogin 在 listen 前已完成,不重试),
        立即抛错提示用户,而非静默等超时。期间若进程意外退出(poll() 非 None)立即失败。

        Args:
            timeout: 超时秒数,默认 120(STARTUP_TIMEOUT)。

        Returns:
            True 表示后端已就绪(MES 登录态正常)。

        Raises:
            RuntimeError: hasCookie=false / 超时 / 进程意外退出,附日志尾部。
        """
        if self._proc is None:
            raise RuntimeError('后端尚未启动,请先调用 start()')

        deadline = time.monotonic() + timeout
        last_error: str = ''

        while time.monotonic() < deadline:
            # 进程意外退出立即失败
            if self._proc.poll() is not None:
                code = self._proc.returncode
                raise RuntimeError(
                    f'Node 后端进程意外退出(returncode={code})\n'
                    f'--- 日志尾部 ---\n{self._read_log_tail()}'
                )

            # 轮询健康检查接口(网络/解析异常仅记录,继续轮询)
            data = None
            try:
                req = urllib.request.Request(
                    HEALTH_URL, headers={'Connection': 'close'}
                )
                with urllib.request.urlopen(req, timeout=5) as resp:
                    data = json.loads(resp.read().decode('utf-8'))
            except Exception as e:
                last_error = str(e)

            # hasCookie 校验放在 try 之外,确保失败时立即向上抛出而非被 except 吞掉
            if data is not None and data.get('status') == 'ok':
                # hasCookie 反映 MES 登录态:mesLogin 在 server.listen 之前已完成,
                # 且不重试,hasCookie 不会由 false 变 true。false 即 MES 登录失败,
                # 窗口虽能开但数据无法实时同步,立即抛错提示用户而非静默等超时。
                if data.get('hasCookie'):
                    return True
                raise RuntimeError(
                    'MES 登录失败(hasCookie=false),数据无法实时同步。'
                    '请检查内网到 MES(lh-cmes.cviauto.cn)连通性或账号。\n'
                    f'--- 日志尾部 ---\n{self._read_log_tail()}'
                )

            time.sleep(HEALTH_POLL_INTERVAL)

        # 超时:附最后错误与日志尾部便于诊断
        raise RuntimeError(
            f'后端在 {timeout}s 内未就绪 (最后错误: {last_error})\n'
            f'--- 日志尾部 ---\n{self._read_log_tail()}'
        )

    def stop(self) -> None:
        """优雅终止进程树(terminate 子孙→父,等 5s,超时 kill)。幂等。

        多次调用安全:无进程时直接返回。on_closed 回调与 atexit 均会调用此方法。
        """
        if self._proc is None:
            return

        try:
            parent = psutil.Process(self._proc.pid)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            self._close_log()
            self._proc = None
            return

        # 先 terminate 所有子孙,再 terminate 父进程
        try:
            children = parent.children(recursive=True)
            for child in children:
                try:
                    child.terminate()
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pass
            parent.terminate()

            # 等待最多 5s,仍未退出则 kill
            gone, alive = psutil.wait_procs(children + [parent], timeout=5)
            for p in alive:
                try:
                    p.kill()
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pass
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass

        # 回收 Popen 资源
        try:
            self._proc.wait(timeout=2)
        except Exception:
            pass

        self._close_log()
        self._proc = None

    def _close_log(self) -> None:
        """关闭 stdout 日志文件句柄。"""
        if self._log_fp is not None:
            try:
                self._log_fp.close()
            except Exception:
                pass
            self._log_fp = None

    def is_alive(self) -> bool:
        """返回子进程是否仍在运行。"""
        return self._proc is not None and self._proc.poll() is None
