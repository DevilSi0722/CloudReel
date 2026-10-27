# 开发与迁移说明

## 源码基线

此目录于 2026-10-27 从最新 CloudReel 0.3.16 整理而来。`src/`、`electron/`、`scripts/`、`tests/`、`assets/`、依赖锁文件和构建配置均来自同一版本。原开发目录保留，整理过程不修改正在运行的应用或用户资料。

导出只调整仓库说明、Git 规则、服务配置示例和 MIT 许可元数据，不改动程序逻辑。可再生成的 DLL、依赖目录、运行库、前端构建和发行包均不提交；图标源 SVG 与现有小型图标资源保留。

新目录已独立安装依赖，通过 114 项自动化测试，以及原生组件编译、图标生成、TypeScript 检查和 Vite 生产构建。该验证不涉及真实账号或用户的正式应用。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm ci` | 按锁文件安装依赖 |
| `npm run setup:desktop` | 校验或下载 Electron |
| `npm run setup:mpv` | 下载项目固定的 Windows x64 mpv 构建 |
| `npm run native:build` | 准备 TinyCC 并编译 Windows 输入组件 |
| `npm test` | 执行测试，包括隐藏窗口回归 |
| `npm run check` | 测试、TypeScript 检查与 Vite 构建 |
| `npm run dev` | 启动开发版应用 |
| `npm run dist` | 打包 Windows 便携版 |

首次准备环境需要联网下载依赖。后续安装使用 `npm ci`，更新依赖时再使用 `npm install` 并审核锁文件变更。不要把原电脑的 `node_modules` 或下载运行库当作源码提交。

## 账号与数据

- 开发版默认使用 `%APPDATA%/CloudReel-Dev`，发行版使用 `%APPDATA%/CloudReel`。可通过 `CLOUDREEL_DATA_DIR` 指定独立数据目录。
- 本仓库包含公开 Trakt 配置示例；`config/services.json` 为本机配置，已忽略。
- 百度网页登录会话、个人 Trakt／TMDB Token、片库和观看记录不包含在源码中。换电脑重新登录，进度通过 Trakt 同步。
- 不将 Cookie、加密凭据库、`Local State`、`state.json`、签名播放地址或私人的联调截图加入提交。

## 测试边界

`npm run check` 通过只表明自动化回归与构建通过，不代表真实网盘播放验收。

任何播放相关改动均须按根目录 `AGENTS.md`，使用真实百度网盘原文件，经生产会话、媒体中继和播放器验证。测试使用隔离会话，后台隐藏窗口，不修改用户的正式片库、观看进度或 Trakt 账号。验证结束清除临时会话副本；不保存凭据和签名媒体 URL。

历史私人诊断脚本和测试会话未导出。正式自动化测试与 fixtures 已全部保留；需要真实账号验收时，按上述要求创建新的本机隔离测试环境。

## 后续工作目录

后续在本目录或从 GitHub 克隆的新目录开发，避免继续修改旧目录后忘记同步到仓库。当前 `.gitignore` 会排除依赖、运行库、构建产物、截图与本机配置；提交前查看 `git diff --cached --stat`。
