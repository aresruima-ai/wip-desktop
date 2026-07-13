# WIP 看板桌面端 · 交付报告

## 1. 项目概要

| 项目 | 内容 |
|---|---|
| 项目名称 | WIP 在制品追踪桌面端 |
| 需求摘要 | 从 MES 看板抽取 WIP 页,做成 PyWebView 桌面端给客户 |
| 工作流模式 | 标准流程(PM→架构→工程师→QA)+ 修复流程(2 轮:QA 验证后 + 独立审计后)+ 真机打包验证 |
| 参与角色 | 主理人(编排)+ 工程师(Agent×3)+ QA(Agent×2)+ 独立审计员(Agent×1) |
| 交付日期 | 2026-07-13 |

## 2. 交付物清单

**新建** `desktop_wip/`:
| 文件 | 职责 |
|---|---|
| `config.py` | 端口/窗口/超时/LOG_DIR/resource_path |
| `backend.py` | NodeBackend:spawn/wait_ready(校验 hasCookie)/stop(进程树 kill,幂等) |
| `launcher.py` | pywebview 窗口 + 生命周期 + 暗色错误页 |
| `requirements.txt` | pywebview/pythonnet/pyinstaller/psutil |
| `build.bat` | 8.5 步:组织 node_runtime(含 db.js/oee_external)+ 依赖自检 + PyInstaller |
| `build.spec` | onefile/windowed/含 node_runtime 资源 |
| `DELIVERY.md` | 本报告 |

**改动**(均只增不删):
| 文件 | 改动 |
|---|---|
| `server.js` | mesLogin:系统 Edge 探测 + browser 声明外移 + finally close(根治孤儿 Edge);白名单加 `/api/delivery/detail`、`/api/shift-config` |
| `nav.js` | STANDALONE 模式:隐藏导航菜单 + 禁用 Ctrl+K 命令面板 |

**产物**:`dist/WipDesktop.exe`(93MB,windowed,内含 node.exe+server.js+db.js+oee_external+node_modules+frontend/dist+.env)

## 3. 关键决策记录

| 决策 | 依据 |
|---|---|
| PyWebView 壳(WebView2) | 用户选,原生窗口体验 |
| 连远程 MongoDB+MES yangning | 用户选,零部署 |
| 仅 wip.html 单页(STANDALONE) | 用户选,纯净 |
| 便携 node.exe+node_modules(非 pkg) | puppeteer 打包坑规避 |
| Puppeteer 用系统 Edge + skip Chromium | 省 ~300MB |
| MES 登录失败(hasCookie=false)立即报错不开窗 | D1 修复,符合 F7 |
| 日志落 %APPDATA%\WipDesktop\logs | D4 修复,崩溃可排查 |
| mesLogin browser finally close | A3 修复,根治孤儿 Edge |
| build.bat 加打包依赖自检 | 审计建议,根治 db.js/oee_external 类遗漏 |

## 4. 质量验证结果

| 关卡 | 结果 | 说明 |
|---|---|---|
| G1 PRD | ✅ | 7 模块齐全,用户批准 |
| G2 架构 | ✅ | 8 模块齐全,用户批准 |
| G3 代码完整性 | ✅ | 3 轮(初版+QA 修复后+审计修复后),无占位符,接口一致 |
| G4 验收 | ✅ | QA 22 用例 → 3 P1+2 P2 修复 → 回归全过 |
| **独立审计** | ✅ | 10 项发现(0 P0/0 P1/4 P2/5 P3),A1/A3/A4/A6/A7+自检已修 |
| 真机打包 | ✅ | exe 内 Node 完整启动,MongoDB/MES 连接成功,hasCookie=true,D1/D2/D4/D5 验证 |
| G5 交付 | ✅ | 本报告 |
| GUI 窗口 | ⚠️ 需用户桌面验 | 开发环境无头,pywebview 无法显示窗口(非打包缺陷,console exe 0 字节 stderr 证实) |

## 5. 审计与修复记录(独立审计员发现)

| ID | 严重 | 问题 | 状态 |
|---|---|---|---|
| A1 | P2 | oee_external/ 目录未打包(与 db.js 同类遗漏) | ✅ 修(build.bat 加 xcopy + node_runtime 补) |
| A3 | P2 | mesLogin catch 不 close browser → 孤儿 Edge 根因 | ✅ 修(browser 声明外移 + finally close) |
| A4 | P2 | requirements.txt 缺 pythonnet(WebView2 后端依赖) | ✅ 修(加 pythonnet>=3.0) |
| A9 | P2 | 无交付报告(G5 缺失) | ✅ 修(本报告) |
| A6 | P3 | config.py EDGE_PATHS 死代码 | ✅ 修(删) |
| A7 | P3 | server.js Edge 回退注释误导 | ✅ 修(注释修正) |
| — | — | build.bat 加打包依赖自检(根治未来遗漏) | ✅ 加([7.5/8] 步) |
| A2 | P3 | scripts/ 未打包(EDO 导入) | 已知(WIP 白名单挡,无影响) |
| A5 | P3 | favicon.ico 不存在(WHITELIST 引用) | 已知(404 无影响) |
| A8 | P3 | ADMIN_KEY 弱口令(12345678) | 已知(建议改 ≥16 位) |

## 6. 已知问题(不阻塞,后续迭代)

| ID | 问题 | 级别 | 建议 |
|---|---|---|---|
| D6 | WebView2 缺失无兜底(老 Win10) | P2 | 需 Win10 1903+,老系统提示装 WebView2 |
| D7 | load_dotenv 冗余(当前不触发) | P3 | 后续删,让 Node dotenv 独自加载 |
| D8 | standalone 未隐藏 persona/mobNav 残留 | P3 | wip.html 未引 master-ui,隐患 |
| D9 | Node 崩溃后孤儿 Edge 清理(stop 兜底) | P2 | A3 已治 mesLogin 根因;stop() 仍可加进程名兜底 |
| F8 | 系统托盘最小化未实现 | P2 | 后续加 pystray |
| A2 | scripts/ 未打包 | P3 | WIP 桌面端不支持 EDO 导入(白名单挡) |
| A5 | favicon.ico 缺失 | P3 | 404 无影响,可选补 |
| A8 | ADMIN_KEY 弱口令 | P3 | 桌面端不用 admin 后门,建议改 |

## 7. 使用说明

**构建**(打包机,需 Node+Python+内网):
```
cd E:\AI\AI\MONGODB\AI数据看板\mes_dashboard\desktop_wip
build.bat
```
build.bat 流程:复制 node.exe→server.js→db.js→oee_external→node_modules→frontend/dist→.env → **[7.5/8] 打包依赖自检**(扫 server.js/db.js 本地 require,缺则终止)→ PyInstaller 生成 `dist\WipDesktop.exe`

**分发给客户**:拷 `desktop_wip\dist\WipDesktop.exe` 单文件(内含 Node+后端+前端+.env)

**客户运行**:双击 exe → 自动起 Node 后端连远程库/MES → 弹原生窗口显示 WIP 看板。关窗即退出。崩溃日志:`%APPDATA%\WipDesktop\logs\node.stdout.log`

**前提**:客户机 Win10 1903+(WebView2)+ 内网可达 10.50.55.39(MongoDB)+ lh-cmes.cviauto.cn(MES)+ 8080 端口空闲

**真机验证清单**:
- [ ] build.bat 成功生成 WipDesktop.exe(依赖自检通过)
- [ ] 双击弹原生窗口,标题"WIP 在制品追踪",加载 wip.html 数据正常
- [ ] 无导航菜单;按 Ctrl+K 无反应
- [ ] 点"在制周期"KPI 弹抽屉(不跳 login)
- [ ] 关窗后任务管理器无残留 node.exe/msedge.exe(A3 finally close 验证)
- [ ] 断 MES → 重启 exe → 显示"MES 登录失败"错误页(非白屏)
- [ ] 崩溃后 %APPDATA%\WipDesktop\logs\ 有日志

## 8. 流程改进(沉淀)

本次独立审计(用户质疑"没有审计吗"触发)发现 db.js 修复后仍存在 oee_external 同类遗漏,证明静态审查(G3/G4)无法覆盖运行时依赖完整性。改进:

1. **独立审计纳入标准流程**:G4(验收)后、G5(交付)前加独立审计关卡,重点查打包完整性 + 流程合规
2. **build.bat 依赖自检**:已加 [7.5/8] 步,扫 server.js/db.js 本地 require,构建时自动捕获遗漏(根治 db.js/oee_external 类问题)
3. **真机冒烟测试纳入 QA**:QA 不止静态审查,应含最小冒烟(health+hasCookie+/api/wip+关窗无残留)
4. **G5 交付报告强制化**:每次交付必须产出框架 6.1 六模块报告(本报告)

## 9. 协作总结

| 阶段 | 角色 | 产出 | 关卡 |
|---|---|---|---|
| 需求 | 主理人+用户 | PRD(4 决策澄清) | G1 ✅ |
| 设计 | 主理人 | 架构文档 | G2 ✅ |
| 实现 | 工程师 Agent | 6 新建+2 改动 | G3 ✅ |
| 验证 | QA Agent | 22 用例,挖出 3 P1+2 P2 | G4 ❌→修复 |
| 修复1 | 工程师 Agent | D1-D5(+try 吞 raise 隐患) | G3 ✅ |
| 回归 | QA Agent | 5 项全过 | G4 ✅ |
| 真机打包 | 主理人 | db.js 遗漏暴露+修+后端全链路验证 | — |
| **独立审计** | **审计员 Agent** | **10 项发现(A1-A10)+ 流程缺失** | **审计 ✅** |
| 修复2 | 工程师 Agent | A1/A3/A4/A6/A7+自检 | G3 ✅ |
| 交付 | 主理人 | 本报告 | G5 ✅ |

**关键教训**:db.js 打包遗漏 → QA 两轮未抓 → 真机暴露 → 修后独立审计又发现 oee_external 同类遗漏。说明"主理人+QA 都是编排方自己人",需独立审计 + 构建时依赖自检兜底。
