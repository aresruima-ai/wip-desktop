@echo off
chcp 65001 >nul
REM ============================================================
REM install_supervisor.bat — 安装 dashboard_manager 自拉 supervisor
REM 每 1min 跑 supervise_manager.py: 探活 manager panel(8081), 死了拉起 pythonw manager.py。
REM 解决 manager 自身无 supervisor 的缺口(进程死了没人拉, 仅靠开机自启)。
REM 需管理员权限(右键以管理员身份运行)。
REM 卸载: schtasks /delete /tn DashboardManagerSupervisor /f
REM ============================================================
setlocal
set PY=C:\Program Files\python\python.exe
set WATCHER=%~dp0supervise_manager.py

if not exist "%WATCHER%" (echo [X] 找不到 supervise_manager.py & pause & exit /b 1)

echo 注册计划任务 DashboardManagerSupervisor (每 1min 探活)...
schtasks /create /tn "DashboardManagerSupervisor" /tr "\"%PY%\" \"%WATCHER%\"" /sc minute /mo 1 /rl HIGHEST /f
if errorlevel 1 (echo [X] 注册失败, 请以管理员身份运行 & pause & exit /b 1)

echo.
echo [OK] 已安装。立即触发一次探活...
"%PY%" "%WATCHER%"
echo 完成。manager 现在由计划任务守护, 死了会在 1 分钟内自动拉起。
echo.
pause
