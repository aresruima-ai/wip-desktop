@echo off
chcp 65001 >nul
echo ============================================
echo   AI生产数字看板 - 六环知识城整机加工厂
echo   访问地址: http://localhost:8080
echo ============================================
echo.
cd /d "%~dp0"
node server.js
pause
