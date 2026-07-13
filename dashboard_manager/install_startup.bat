@echo off
chcp 65001 >nul
echo ============================================
echo   AI看板管理器 - 安装开机自启
echo ============================================
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
copy /Y "%~dp0run.vbs" "%STARTUP%\AI看板管理器.vbs" >nul
if errorlevel 1 (
    echo [失败] 无法复制到 %STARTUP%
    pause
    exit /b 1
)
echo [成功] 已安装开机自启
echo   位置: %STARTUP%\AI看板管理器.vbs
echo.
echo 取消自启: 运行 uninstall_startup.bat 或直接删除上述 .vbs
pause
