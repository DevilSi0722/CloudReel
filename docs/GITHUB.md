# 首次上传 GitHub

本目录已初始化为本地 Git 仓库，分支为 `main`；尚未提交、设置远程地址或上传。源码采用 MIT 许可证，已准备好公开开源所需的 README、LICENSE 和忽略规则。

## 1. 创建空仓库

登录 GitHub，打开 <https://github.com/new>：

- Repository name 填 `CloudReel`。
- Visibility 选 `Public`，公开开源。
- 不添加 README、`.gitignore` 或 License，因为本地已经准备好文件。
- 点击 `Create repository`，记下 HTTPS 地址，如 `https://github.com/你的用户名/CloudReel.git`。

## 2. 在本机提交并推送

打开 PowerShell：

```powershell
Set-Location 'E:\Files\Code\CloudReel'
git status --short
git add .
git diff --cached --stat
git commit -m "Import CloudReel 0.3.16 source"
git remote add origin https://github.com/你的用户名/CloudReel.git
git push -u origin main
```

将地址中的 `你的用户名` 换成自己的 GitHub 用户名，或直接粘贴刚创建的仓库地址。

若提交时提示没有作者信息，只为这个仓库设置即可，然后重新执行 `git commit`：

```powershell
git config user.name "你的 GitHub 显示名"
git config user.email "你的 GitHub 提交邮箱"
```

可在 GitHub 的 `Settings → Emails` 中找到自己的 `noreply` 提交邮箱。该邮箱只用于提交作者信息。

首次 `git push` 通常由 Git Credential Manager 引导浏览器登录 GitHub。若提示输入密码，GitHub HTTPS Git 操作使用个人访问令牌而非账号密码；不要把令牌写进远程 URL 或源码。

推送成功后刷新仓库网页，应能看到 `src/`、`electron/`、`scripts/`、`tests/`、`README.md` 和锁文件。`node_modules/`、`.runtime/`、`release/`、个人服务配置、账号数据不应出现在仓库中。

## 3. 换电脑继续开发

在新电脑安装 Git 和 Node.js 24 LTS，然后：

```powershell
git clone https://github.com/你的用户名/CloudReel.git
Set-Location CloudReel
npm ci
npm run setup:desktop
npm run setup:mpv
Copy-Item config/services.example.json config/services.json
npm run check
npm run dev
```

在应用中重新登录百度网盘和 Trakt，并填写 TMDB Token。Windows 加密的登录凭据不能靠复制源码跨电脑恢复。

## 4. 以后同步改动

开始开发前，先确认本地改动已提交或妥善保存，再更新：

```powershell
git pull --ff-only
```

完成改动后：

```powershell
git status --short
git add .
git diff --cached --stat
git commit -m "说明本次修改"
git push
```

换电脑前记得提交和推送。若两台电脑分别产生了提交，先保留各自改动并解决分支差异，不使用强制推送覆盖另一台电脑的工作。
