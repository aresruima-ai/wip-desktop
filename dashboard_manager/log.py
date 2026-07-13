from __future__ import annotations

"""日志配置模块。

职责：
    为 AI 看板运维管理器配置名为 ``manager`` 的统一日志器。按 CONTRACTS §5 / §7.2
    规范，向 ``{cfg['log']['dir']}/manager.log`` 写入轮转文件日志，同时输出到
    stdout；格式统一为 ``时间 [级别] 名称: 消息``，级别 INFO，禁止向 root 传播
    以免重复输出。各子模块可取 ``logging.getLogger('manager.<module>')`` 或直接
    使用传入的 ``log`` 参数。

契约要点：
    - ``setup_logging(cfg) -> logging.Logger`` 为唯一对外函数，签名/返回不可改。
    - 日志目录不存在则 ``os.makedirs``（含父目录）。
    - 返回 ``logging.getLogger('manager')``。
"""

import logging
import os
import sys
from logging.handlers import RotatingFileHandler

# 统一日志格式（CONTRACTS §5）
_LOG_FORMAT = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"
# 统一 logger 名称
_LOGGER_NAME = "manager"


def setup_logging(cfg: dict) -> logging.Logger:
    """配置并返回名为 ``manager`` 的日志器。

    依据 ``cfg['log']`` 段：
        - dir          : 日志目录（已是绝对路径，见 config.load_config）；不存在则创建。
        - max_bytes    : 单个日志文件最大字节数，超出后轮转。
        - backup_count : 保留的旧日志份数。
        - manager.log  : 轮转文件路径。

    同时挂载一个输出到 stdout 的 StreamHandler。logger 级别 INFO、propagate=False，
    避免向 root logger 冒泡导致重复输出。

    Args:
        cfg: 已由 ``config.load_config`` 解析过的配置字典，其中 ``cfg['log']`` 各
            路径字段须为绝对路径。

    Returns:
        logging.Logger: 名为 ``manager`` 的日志器实例。
    """
    log_cfg = cfg.get("log", {}) or {}

    log_dir = log_cfg.get("dir")
    max_bytes = log_cfg.get("max_bytes", 5 * 1024 * 1024)
    backup_count = log_cfg.get("backup_count", 7)

    # 取得目标 logger 并清空既有 handler，保证重复调用幂等（不残留旧 handler）
    logger = logging.getLogger(_LOGGER_NAME)
    logger.setLevel(logging.INFO)
    logger.propagate = False
    for handler in list(logger.handlers):
        logger.removeHandler(handler)
        try:
            handler.close()
        except Exception:
            # 关闭旧 handler 失败不应阻断日志初始化
            pass

    formatter = logging.Formatter(_LOG_FORMAT)

    # 文件 handler：目录不存在则创建。log_dir 可能为 None（极端配置缺失），此时跳过文件日志，
    # 仅保留 stdout，避免因目录缺失而无法启动管理器。
    if log_dir:
        try:
            os.makedirs(log_dir, exist_ok=True)
            file_path = os.path.join(log_dir, "manager.log")
            file_handler = RotatingFileHandler(
                filename=file_path,
                maxBytes=max_bytes,
                backupCount=backup_count,
                encoding="utf-8",
            )
            file_handler.setLevel(logging.INFO)
            file_handler.setFormatter(formatter)
            logger.addHandler(file_handler)
        except Exception as exc:
            # 文件 handler 创建失败时，至少保证 stdout 可用；记录到 stderr 以便排查
            # （此刻 logger 尚未挂载文件 handler，故用 print 输出到 stderr）。
            print(
                f"[log.py] 警告: 创建文件日志失败({log_dir!r}): {exc!r}",
                file=sys.stderr,
            )

    # stdout handler
    stream_handler = logging.StreamHandler(stream=sys.stdout)
    stream_handler.setLevel(logging.INFO)
    stream_handler.setFormatter(formatter)
    logger.addHandler(stream_handler)

    return logging.getLogger(_LOGGER_NAME)
