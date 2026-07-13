# -*- coding: utf-8 -*-
"""PyInstaller 打包配置:WIP 桌面端(跨平台)。

Windows: 单文件 WipDesktop.exe(onefile,资源解包到 _MEIPASS)
macOS:   WipDesktop.app bundle(onedir + COLLECT,windowed 自动出 .app)
  注:Mac 上 onefile+windowed 只出单文件可执行(不包 .app),双击无窗口;
      要双击运行必须 onedir,PyInstaller 在 Mac 对 windowed+onedir 自动生成 .app bundle。
"""
import os
import sys as _sys
from PyInstaller.utils.hooks import collect_submodules

# spec 文件所在目录(即 desktop_wip/)
SPEC_DIR = os.path.dirname(os.path.abspath(SPEC))

_IS_MAC = _sys.platform == 'darwin'

# 图标:Windows 用 .ico;Mac 用 .icns(.ico 在 Mac .app 不规范,故 Mac 跳过自定义图标)
icon_arg = None
if not _IS_MAC:
    ICON_PATH = os.path.normpath(os.path.join(SPEC_DIR, '..', '..', '..', 'laoliu.ico'))
    if os.path.exists(ICON_PATH):
        icon_arg = ICON_PATH

# pywebview 后端依赖(跨平台)
hiddenimports = ['webview', 'webview.util', 'webview.event', 'backend', 'config']
if _sys.platform == 'win32':
    hiddenimports += [
        'webview.platforms.edgechromium',
        'webview.platforms.winforms',
        'clr_loader', 'clr_loader.ffi',
        'clr_loader.ffi.netfx',
        'pythoncom', 'pywintypes', 'win32timezone',
    ]
    _collect_pkgs = ('webview', 'clr_loader')
else:
    # macOS: cocoa(PyObjC)后端
    hiddenimports += ['webview.platforms.cocoa']
    _collect_pkgs = ('webview',)

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

if _IS_MAC:
    # macOS:onedir + COLLECT + BUNDLE → WipDesktop.app(可双击运行)
    # .spec 文件需显式 BUNDLE() 才出 .app(命令行 --windowed 会自动加,spec 不会)
    exe = EXE(
        pyz,
        a.scripts, [],
        exclude_binaries=True,
        name='WipDesktop',
        debug=False,
        strip=False,
        upx=False,             # Mac 上 upx 无效
        console=False,         # windowed
        disable_windowed_traceback=False,
        target_arch=None,      # 跟随 runner 架构(workflow 用 macos-13 Intel runner 出 x86_64,Apple 芯片 Mac 经 Rosetta 也能跑,通吃)
        codesign_identity=None,
        entitlements_file=None,
    )
    coll = COLLECT(
        exe,
        a.binaries,
        a.zipfiles,
        a.datas,
        name='WipDesktop',
    )
    app = BUNDLE(
        coll,
        name='WipDesktop.app',
        icon=None,                           # Mac 用 .icns,此处用默认图标
        bundle_identifier='com.cviauto.wipdesktop',
        info_plist={
            'CFBundleName': 'WIP 在制品追踪',
            'CFBundleDisplayName': 'WIP 在制品追踪',
            'CFBundleShortVersionString': '1.0.0',
            'NSHighResolutionCapable': True,
            'LSMinimumSystemVersion': '10.13',
        },
    )
else:
    # Windows:onefile 单文件 WipDesktop.exe
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
        console=False,
        disable_windowed_traceback=False,
        target_arch=None,
        codesign_identity=None,
        entitlements_file=None,
        **({'icon': icon_arg} if icon_arg else {}),
    )

