# -*- coding: utf-8 -*-
"""PyInstaller 打包配置:WIP 桌面端单文件 EXE。

将 launcher.py/backend.py/config.py + node_runtime 资源打包为 WipDesktop.exe。
windowed 模式(无控制台),单文件,资源解包到 _MEIPASS 临时目录。
"""
import os
from PyInstaller.utils.hooks import collect_submodules

# spec 文件所在目录(即 desktop_wip/)
SPEC_DIR = os.path.dirname(os.path.abspath(SPEC))

# 图标(laoliu.ico 在上级 MONGODB 目录,若存在则引用)
ICON_PATH = os.path.normpath(os.path.join(SPEC_DIR, '..', '..', '..', 'laoliu.ico'))
icon_arg = ICON_PATH if os.path.exists(ICON_PATH) else None

# pywebview 后端依赖(跨平台:Windows 用 WebView2/pythonnet,macOS 用 cocoa/PyObjC)
# PyInstaller 会忽略当前平台不存在的模块,这里按平台列出以减少 warning
import sys as _sys
hiddenimports = ['webview', 'webview.util', 'webview.event', 'backend', 'config']
if _sys.platform == 'win32':
    # Windows: WebView2(EdgeChrome)后端 + pythonnet
    hiddenimports += [
        'webview.platforms.edgechromium',
        'webview.platforms.winforms',
        'clr_loader', 'clr_loader.ffi',
        'clr_loader.ffi.netfx',   # 实际存在的子模块(netfx/mono/hostfxr)
        'pythoncom', 'pywintypes', 'win32timezone',
    ]
    _collect_pkgs = ('webview', 'clr_loader')
else:
    # macOS: cocoa(PyObjC)后端
    hiddenimports += ['webview.platforms.cocoa']
    _collect_pkgs = ('webview',)

# 动态收集子模块(避免遗漏)
for pkg in _collect_pkgs:
    try:
        hiddenimports += collect_submodules(pkg)
    except Exception:
        pass

# node_runtime 整目录打包(.env 已在 node_runtime 内,不重复)
datas = [
    ('node_runtime', 'node_runtime'),
]

block_cipher = None

a = Analysis(
    ['launcher.py'],
    pathex=[SPEC_DIR],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='WipDesktop',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    runtime_tmpdir=None,
    console=False,          # windowed 模式,无控制台(最终交付版)
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    **({'icon': icon_arg} if icon_arg else {}),
)
