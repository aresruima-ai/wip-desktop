@echo off
chcp 65001 >nul
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
del /F "%STARTUP%\AI看板管理器.vbs" 2>nul
if exist "%STARTUP%\AI看板管理器.vbs" (
    echo [失败] 删除未成功, 请手动删除: %STARTUP%\AI看板管理器.vbs
) else (
    echo [成功] 已取消开机自启
)
pause
