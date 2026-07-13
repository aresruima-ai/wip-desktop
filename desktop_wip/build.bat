@echo off
chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion

REM ============================================================
REM WIP 桌面端构建脚本
REM 组织 node_runtime 资源 → PyInstaller 打包单文件 EXE
REM ============================================================

set ROOT=%~dp0
set MES_DIR=%ROOT%..
set RUNTIME=%ROOT%node_runtime

echo.
echo ========================================
echo  WIP 桌面端构建
echo ========================================
echo.

REM [1/8] 创建目录结构
echo [1/8] 创建 node_runtime 目录结构...
if not exist "%RUNTIME%" mkdir "%RUNTIME%"
if not exist "%RUNTIME%\logs" mkdir "%RUNTIME%\logs"
if not exist "%RUNTIME%\frontend" mkdir "%RUNTIME%\frontend"

REM [2/8] 检测并复制 Node.js
echo [2/8] 检测 Node.js...
set NODE_EXE=
if exist "C:\Program Files\nodejs\node.exe" (
    set "NODE_EXE=C:\Program Files\nodejs\node.exe"
) else (
    where node >nul 2>&1
    if !errorlevel! equ 0 (
        for /f "delims=" %%i in ('where node 2^>nul') do (
            if "!NODE_EXE!"=="" set "NODE_EXE=%%i"
        )
    )
)
if "!NODE_EXE!"=="" (
    echo [错误] 未找到 Node.js,请先安装 Node.js 或将其加入 PATH
    echo        检查位置: C:\Program Files\nodejs\node.exe 或系统 PATH
    pause
    exit /b 1
)
echo   源: !NODE_EXE!
copy /y "!NODE_EXE!" "%RUNTIME%\node.exe" >nul 2>&1
if !errorlevel! neq 0 (
    echo [错误] 复制 node.exe 失败
    pause
    exit /b 1
)
echo   已复制 node.exe → node_runtime\node.exe

REM [3/8] 复制 server.js
echo [3/8] 复制 server.js...
if not exist "%MES_DIR%\server.js" (
    echo [错误] mes_dashboard\server.js 不存在
    pause
    exit /b 1
)
copy /y "%MES_DIR%\server.js" "%RUNTIME%\server.js" >nul
echo   已复制 server.js
if not exist "%MES_DIR%\db.js" (
    echo [错误] mes_dashboard\db.js 不存在
    pause
    exit /b 1
)
copy /y "%MES_DIR%\db.js" "%RUNTIME%\db.js" >nul
echo   已复制 db.js
if not exist "%MES_DIR%\oee_external" (
    echo [警告] mes_dashboard\oee_external 不存在,OEE 外部数据源将不可用
) else (
    xcopy /e /i /y /q "%MES_DIR%\oee_external" "%RUNTIME%\oee_external" >nul 2>&1
    echo   已复制 oee_external
)

REM [4/8] 复制 node_modules
echo [4/8] 复制 node_modules...
if not exist "%MES_DIR%\node_modules" (
    echo [警告] mes_dashboard\node_modules 不存在,请先在 mes_dashboard 下 npm install
) else (
    xcopy /e /i /y /q "%MES_DIR%\node_modules" "%RUNTIME%\node_modules" >nul 2>&1
    if !errorlevel! neq 0 (
        echo [警告] 复制 node_modules 可能不完整
    ) else (
        echo   已复制 node_modules
    )
)

REM [5/8] 复制 frontend/dist
echo [5/8] 复制 frontend/dist...
if not exist "%MES_DIR%\frontend\dist" (
    echo [警告] mes_dashboard\frontend\dist 不存在
) else (
    xcopy /e /i /y /q "%MES_DIR%\frontend\dist" "%RUNTIME%\frontend\dist" >nul 2>&1
    if !errorlevel! neq 0 (
        echo [警告] 复制 frontend/dist 可能不完整
    ) else (
        echo   已复制 frontend/dist
    )
)

REM [6/8] 复制 .env
echo [6/8] 复制 .env...
if not exist "%MES_DIR%\.env" (
    echo [警告] mes_dashboard\.env 不存在,后端将使用默认配置
) else (
    copy /y "%MES_DIR%\.env" "%RUNTIME%\.env" >nul
    echo   已复制 .env
)

REM [7/8] 设置环境变量(避免 Puppeteer 重下 Chromium)
echo [7/8] 设置 PUPPETEER_SKIP_DOWNLOAD=1...
set PUPPETEER_SKIP_DOWNLOAD=1
echo   运行时用系统 Edge,不下载 Chromium

REM [7.5/8] 打包依赖完整性自检(防 db.js/oee_external 类遗漏)
echo [7.5/8] 打包依赖自检...
node -e "const fs=require('fs'),path=require('path');const files=['server.js','db.js'];let miss=[];for(const f of files){const t=fs.readFileSync(path.join('%RUNTIME%',f),'utf8');const re=[...t.matchAll(/require\(\s*['\x22]\.\/([^'\x22]+)['\x22]\s*\)/g)].map(m=>m[1]);for(const r of re){const base=path.join('%RUNTIME%',r);if(!fs.existsSync(base)&&!fs.existsSync(base+'.js')&&!fs.existsSync(path.join(base,'index.js'))){miss.push(f+' -> ./'+r);}}}if(miss.length){console.error('[FATAL] 打包缺失本地依赖:\n  '+miss.join('\n  '));process.exit(1);}else{console.log('  本地依赖自检通过');}"
if !errorlevel! neq 0 ( echo [错误] 打包依赖不完整,请检查 build.bat 复制步骤 & pause & exit /b 1 )

REM [8/8] PyInstaller 打包
echo.
echo [8/8] PyInstaller 打包...
echo ========================================
echo  资源就绪,开始打包 WipDesktop.exe
echo ========================================
echo.

cd /d "%ROOT%"
pyinstaller --noconfirm build.spec
set BUILD_RC=!errorlevel!

echo.
if !BUILD_RC! equ 0 (
    echo ========================================
    echo  打包成功!
    echo  输出: %ROOT%dist\WipDesktop.exe
    echo ========================================
) else (
    echo ========================================
    echo  [错误] PyInstaller 打包失败 (exit !BUILD_RC!)
    echo  请检查上方输出排查原因
    echo ========================================
)
echo.
pause
