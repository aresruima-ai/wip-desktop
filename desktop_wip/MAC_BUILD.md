# macOS 桌面端打包说明(GitHub Actions 云端 Mac)

给同事用的 macOS 版 WipDesktop.app,通过 GitHub Actions 在云端 Mac 上打包,**不需要你有 Mac 设备**。

## 原理

```
你的 Win 机            GitHub 云(自动)              同事 Mac
─────────              ──────────────                ────────
git push 代码    →    macOS runner 自动:
                        装 Node/Python/依赖
                        从 Secret 注入 .env
                        PyInstaller 打包 → WipDesktop.app
                        上传为 artifact
你网页下载 .app  ────────────────────────→  拷给同事,双击运行
```

公开仓库的 macOS runner 不计费(免费无限)。

## 一次性准备(你做一次)

### 1. 在 GitHub 建公开仓库
- 登录 github.com → New repository
- 名字随便(如 `wip-desktop`),**Public**(公开才免费 macOS)
- **不要**勾选 Initialize with README(我们已有代码)

### 2. 把 .env 内容存为 GitHub Secret(关键!不进代码)
- 仓库 → Settings → Secrets and variables → Actions → New repository secret
- Name 填 `DESKTOP_ENV`
- Value 填 .env 的**完整内容**(直接复制 .env 文件全部文本,含 MES_USERNAME/MES_PASSWORD/MONGO_URI 等)
- 这个 Secret 加密存储,只有你的账号能看到,不会进 git 历史

### 3. 配置 git 身份 + push 代码
在本机 `mes_dashboard` 目录跑(我已 git init 的话):
```bash
git config --global user.name "你的名字"
git config --global user.email "你的邮箱"
git remote add origin https://github.com/你的用户名/wip-desktop.git
git push -u origin main
```
首次 push 会要 GitHub 登录(用浏览器授权或 Personal Access Token)。

## 打包

push 到 main/master 会**自动触发**打包(见 .github/workflows/build-mac.yml)。
也可手动触发:仓库 → Actions → Build macOS App → Run workflow。

打包约 15-20 分钟。进度在 Actions 页面实时看。

## 下载 .app

- 仓库 → Actions → 点最新一次成功的 run
- 拉到底 → Artifacts → `WipDesktop-macOS` → 下载(得到 zip)
- 解压得 `WipDesktop.app`

## 同事运行

1. 拷 `WipDesktop.app` 给同事(Mac 同内网,能访问 10.50.55.39 + lh-cmes.cviauto.cn)
2. 首次打开(未签名,Gatekeeper 会拦):
   - 右键 WipDesktop.app → 打开 → 弹窗点"打开"
   - 或:系统设置 → 隐私与安全性 → 底部"仍要打开"
3. 双击运行 → 弹原生窗口"WIP 在制品追踪" → 加载 WIP 看板(连 MES 真实数据)
4. 崩溃日志:`~/Library/Logs/WipDesktop/node.stdout.log`

## 常见问题

| 现象 | 排查 |
|------|------|
| Actions 打包失败 | 看 run 日志,常见:Secret DESKTOP_ENV 没配 / .env 缺字段 / npm install 失败 |
| 同事打开提示"已损坏" | 终端跑 `xattr -cr /路径/WipDesktop.app` 清隔离属性(未签名 app 常见) |
| 同事打开白屏/无数据 | 确认同事能访问内网(浏览器开 lh-cmes.cviauto.cn);MES 登录失败看日志 |
| 想改代码重新打包 | 改完 `git push`,自动重新打包,再下载新 artifact |

## 安全说明

- .env(MES 密码/MongoDB 凭据)存在 GitHub Secret,不进 git 历史,公开仓也看不到
- 产出的 .app 里含 .env(运行需要),同事拿到 .app 等于拿到凭据 —— 同事是可信方
- 若要进一步隔离,后续可改"同事自带 .env"
