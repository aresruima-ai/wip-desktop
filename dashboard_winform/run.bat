@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 启动 AI看板管理器 WinForm 控制面板...
pythonw main.py
