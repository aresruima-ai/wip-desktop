from __future__ import annotations
"""配置加载与路径解析。

职责:
- load_config(path): 用 pyyaml 读取 config.yaml, 按 CONTRACTS §3 §4 解析相对路径为绝对路径,
  注入元字段 _config_dir / _project_root, 对部分配置健壮(缺失整段/子字段补默认),
  仅在 node.command 空 / backoff_sec 空或含非正 / failure_threshold<1 时抛 ValueError。
- resolve(cfg, path): 便捷函数, 相对路径基于 cfg['_config_dir'] 解析为绝对, 已绝对则原样返回。

路径约定 (§3):
- CONFIG_DIR = config.yaml 所在目录的绝对路径 = dashboard_manager/
- PROJECT_ROOT = CONFIG_DIR 的上级目录 = AI数据看板/
- node.cwd / node.env_file / log.dir 相对 CONFIG_DIR 解析为绝对; 原值 None 保持 None。
"""

import os
from typing import Any, Dict

import yaml


# ============================================================
# 默认值 (参照 config.yaml), 用于部分配置健壮补齐
# ============================================================
_DEFAULTS: Dict[str, Any] = {
    "node": {
        "command": ["node", "server.js"],
        "cwd": None,        # None 保持 None (不强制默认)
        "env_file": None,
        "restart": {
            "backoff_sec": [5, 10, 20, 30, 30, 30],
            "max_consecutive_crashes": 8,
            "cooldown_sec": 300,
        },
    },
    "watchdog": {
        "enabled": True,
        "health_url": "http://127.0.0.1:8080/api/health",
        "interval_sec": 15,
        "failure_threshold": 3,
        "timeout_sec": 8,
        "grace_after_start_sec": 30,
        "startup_window_sec": 120,
        "cookie_loss_alert": True,
    },
    "kiosk": {
        "enabled": True,
        "url": "http://localhost:8080/portal.html",
        "browser": "edge",
        "browser_path": None,
        "check_interval_sec": 30,
        "daily_reload_time": "03:17",
    },
    "log": {
        "dir": "logs",
        "max_bytes": 5242880,
        "backup_count": 7,
    },
    "alert": {
        "enabled": False,
        "webhook": None,
        "min_interval_sec": 600,
    },
    "tray": {
        "enabled": True,
        "title": "AI看板管理器",
    },
}


def _merge_defaults(user: Dict[str, Any], defaults: Dict[str, Any]) -> Dict[str, Any]:
    """递归合并: 用户配置覆盖默认, 缺失的整段/子字段补默认。

    对 dict 类型递归; 非 dict 类型用户值优先(包括 None, 用户显式给 None 即用 None)。
    返回新 dict, 不修改入参。
    """
    result: Dict[str, Any] = {}
    # 先拷贝默认
    for key, dval in defaults.items():
        if isinstance(dval, dict):
            # 默认是 dict, 用用户的同 key 值(若存在且为 dict)递归合并, 否则用默认深拷贝
            uval = user.get(key)
            if isinstance(uval, dict):
                result[key] = _merge_defaults(uval, dval)
            else:
                # 用户缺失该段或类型不对 -> 用默认
                result[key] = _merge_defaults({}, dval) if isinstance(dval, dict) else dval
        else:
            # 默认是标量/列表, 用户有则用用户的(含 None), 没有则用默认
            result[key] = user.get(key, dval) if key in user else dval
    # 用户中存在但默认没有的 key 也保留
    for key, uval in user.items():
        if key not in result:
            result[key] = uval
    return result


def _deep_copy_value(value: Any) -> Any:
    """对 dict/list 做深拷贝(浅层递归), 标量原样返回。避免默认值被后续修改污染。"""
    if isinstance(value, dict):
        return {k: _deep_copy_value(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_deep_copy_value(v) for v in value]
    return value


def _to_abs(base_dir: str, value: Any) -> Any:
    """把相对路径基于 base_dir 解析为绝对路径; None 保持 None; 已绝对则原样。

    使用 os.path.join + os.path.normpath 规范化。
    """
    if value is None:
        return None
    if not isinstance(value, str):
        # 非字符串(理论上不该发生), 原样返回, 不做猜测
        return value
    if os.path.isabs(value):
        return os.path.normpath(value)
    return os.path.normpath(os.path.join(base_dir, value))


def _validate(cfg: Dict[str, Any]) -> None:
    """校验关键字段, 不合法抛 ValueError(中文消息)。

    仅当:
    - node.command 为空 list
    - backoff_sec 为空 或 含非正数
    - failure_threshold < 1
    时抛 ValueError。其余字段不做强制校验(部分配置健壮)。
    """
    # node.command 必填非空
    node = cfg.get("node", {})
    command = node.get("command")
    if not command or (isinstance(command, list) and len(command) == 0):
        raise ValueError("node.command 不能为空: 必须提供看板后端启动命令 (如 ['node', 'server.js'])")

    # backoff_sec 必填非空且元素>0
    restart = node.get("restart", {})
    backoff = restart.get("backoff_sec")
    if not backoff or (isinstance(backoff, list) and len(backoff) == 0):
        raise ValueError("node.restart.backoff_sec 不能为空: 必须提供退避序列 (如 [5, 10, 20, 30, 30, 30])")
    if isinstance(backoff, list):
        for i, sec in enumerate(backoff):
            if not isinstance(sec, (int, float)) or sec <= 0:
                raise ValueError(
                    f"node.restart.backoff_sec 第 {i} 个元素非法 ({sec!r}): 退避序列元素必须为正数"
                )

    # failure_threshold >= 1
    watchdog = cfg.get("watchdog", {})
    threshold = watchdog.get("failure_threshold")
    if not isinstance(threshold, (int, float)) or isinstance(threshold, bool) or threshold < 1:
        raise ValueError(
            f"watchdog.failure_threshold 非法 ({threshold!r}): 必须 >= 1 (连续失败这么多次才判死)"
        )


def load_config(path: str) -> dict:
    """加载并规范化 config.yaml。

    步骤 (§3 §4):
    1. 用 pyyaml 读取 YAML 文件 (文件不存在抛 FileNotFoundError)。
    2. 计算 CONFIG_DIR (path 所在目录绝对路径) 与 PROJECT_ROOT (其上级)。
    3. 与默认值递归合并, 缺失整段/子字段补默认 (默认值参照 config.yaml)。
    4. 把 node.cwd / node.env_file / log.dir 相对 CONFIG_DIR 解析为绝对; None 保持 None。
    5. 注入元字段 _config_dir / _project_root。
    6. 校验关键字段, 不合法抛 ValueError(中文消息)。

    Args:
        path: config.yaml 的路径 (相对或绝对均可)。

    Returns:
        规范化后的配置 dict, 其中 _config_dir / _project_root 为绝对路径,
        node.cwd / node.env_file / log.dir 已是绝对路径(或 None)。
    """
    abs_path = os.path.abspath(path)
    if not os.path.isfile(abs_path):
        raise FileNotFoundError(f"配置文件不存在: {abs_path}")

    with open(abs_path, "r", encoding="utf-8") as f:
        raw = yaml.safe_load(f)

    # raw 可能为 None (空文件) 或非 dict
    if not isinstance(raw, dict):
        raw = {}

    # 深拷贝默认值避免污染模块级常量
    defaults_copy = _deep_copy_value(_DEFAULTS)

    # 递归合并: 缺失整段/子字段补默认
    cfg = _merge_defaults(raw, defaults_copy)

    # 计算 CONFIG_DIR / PROJECT_ROOT
    config_dir = os.path.dirname(abs_path)
    project_root = os.path.dirname(config_dir)

    # 解析相对路径为绝对 (基于 CONFIG_DIR); None 保持 None
    node = cfg.get("node", {})
    node["cwd"] = _to_abs(config_dir, node.get("cwd"))
    node["env_file"] = _to_abs(config_dir, node.get("env_file"))

    log_cfg = cfg.get("log", {})
    log_cfg["dir"] = _to_abs(config_dir, log_cfg.get("dir"))

    # 注入元字段
    cfg["_config_dir"] = config_dir
    cfg["_project_root"] = project_root

    # 校验关键字段
    _validate(cfg)

    return cfg


def resolve(cfg: dict, path: str) -> str:
    """便捷函数: 相对路径基于 cfg['_config_dir'] 解析为绝对, 已绝对则原样返回。

    供其他模块处理配置之外的运行时相对路径使用。

    Args:
        cfg: 已加载的配置 dict (含 _config_dir 元字段)。
        path: 待解析的路径。

    Returns:
        规范化后的绝对路径字符串。
    """
    base = cfg.get("_config_dir")
    if base is None:
        # 兜底: 取 cfg 之外无 base, 用 cwd
        base = os.getcwd()
    if os.path.isabs(path):
        return os.path.normpath(path)
    return os.path.normpath(os.path.join(base, path))
