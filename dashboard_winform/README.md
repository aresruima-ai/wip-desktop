# AI看板管理器 — 桌面控制面板

原生桌面窗口版控制面板(替代浏览器 web 面板)。通过 HTTP 调用 `dashboard_manager` 的控制面板 API(8081)显示守护状态 + 控制操作 + 日志。

用 **tkinter**(Python 标准库 GUI,零依赖、稳定)。初版曾用 pythonnet 调 .NET WinForm,但本机 Crash(`Control.set_Text` 抛 NullReferenceException,pythonnet 3.0.5 兼容问题),改 tkinter,功能/外观一致。

## 与 dashboard_manager 的关系

```
dashboard_manager/manager.py  ← 后端: Node守护 + 探活 + 投屏 + panel(8081 API) + 托盘
dashboard_winform/main.py     ← 前端: 桌面窗口, 调 8081 API 显示状态/控制
```

manager 必须先跑(提供 8081 API),本程序是它的 GUI 客户端。

## 依赖

```bash
python -m pip install -r requirements.txt
```
仅 `requests`(tkinter 是 Python 标准库,自带)。

## 运行

先启动 manager(在 dashboard_manager 目录):
```bash
pythonw manager.py   # 或双击 run.vbs
```

再启动桌面面板(本目录):
```bash
python main.py       # 或双击 run.bat
```

## 功能

- **状态区**(每 3 秒自动刷新):看板状态(●绿/红/灰)、Node PID、累计重启、连续崩溃、探活、MES Cookie、熔断、投屏 PID、运行时长、暂停标记
- **按钮**:重启看板 / 重启投屏 / 暂停守护(切换) / 刷新日志
- **日志区**:最近 200 行 manager.log,每 ~9 秒刷新,自动滚到底

## 打包 exe(可选)

```bash
pip install pyinstaller
pyinstaller --noconsole --onefile main.py
# 产物 dist/main.exe, 双击即用
```

## 配置

`main.py` 顶部 `MANAGER_URL = "http://127.0.0.1:8081"`,若 manager 在别的机器/端口改这里。若 panel 设了 key,在请求 URL 加 `?key=xxx`。
