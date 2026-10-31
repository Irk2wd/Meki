# 开发指南

[文档目录](README.md) · [项目首页](../README.md)

## 环境要求

- Windows 或 macOS，以及可用的桌面会话。
- Node.js 24、npm 和 Git。
- 首次安装依赖需要网络，Electron 运行时也会下载到本机。

基本运行不需要 Pandoc 或 PicGo。验证文档转换时使用 Pandoc 3.12.1 或更新版本；验证真实图片上传时需另行配置 PicGo。

## 获取源码并运行

```sh
git clone https://github.com/Irk2wd/Meki.git
cd Meki
npm ci
npm run build
```

开发时使用独立数据目录，以免与日常安装版共享设置、草稿和会话。在项目根目录启动：

**Windows PowerShell**

```powershell
$env:MOYE_USER_DATA = Join-Path $PWD.Path 'test-results/manual-profile'
npm start
```

**macOS**

```sh
MOYE_USER_DATA="$PWD/test-results/manual-profile" npm start
```

`MOYE_USER_DATA` 必须是绝对路径。`test-results/` 已被 Git 忽略；在其中测试时只使用临时文稿。保留 `MOYE_` 前缀是为了兼容已有启动与数据协议，见 [应用身份](architecture.md#名称与兼容标识)。

如果安装依赖时跳过了 Electron 运行时下载，补充执行：

```sh
node node_modules/electron/install.js
```

## 热更新开发

第一个终端运行：

```sh
npm run dev
```

第二个终端进入同一项目目录，再启动桌面应用：

**Windows PowerShell**

```powershell
$env:MOYE_USER_DATA = Join-Path $PWD.Path 'test-results/manual-profile'
$env:MOYE_DEV_URL = 'http://127.0.0.1:5173'
npm start
```

**macOS**

```sh
MOYE_USER_DATA="$PWD/test-results/manual-profile" \
MOYE_DEV_URL=http://127.0.0.1:5173 npm start
```

Vite 提供渲染器热更新；修改 Electron 主进程或 preload 后需要重启应用。启动已构建版本时不要设置 `MOYE_DEV_URL`；PowerShell 可执行 `Remove-Item Env:MOYE_DEV_URL -ErrorAction SilentlyContinue` 清除当前终端中的值。

## 验证修改

在项目根目录执行：

```sh
npm run build
npm test
npm run check:licenses
npm run check:assets
```

涉及桌面交互时，再运行：

```sh
npm run test:ui
```

桌面测试会启动真实 Electron 窗口，使用隔离数据目录和合成文稿，不读写日常文稿。测试记录位于 `test-results/`。也可按改动范围单独运行相应的 `tests/*-smoke.mjs`；运行前需完成构建。

测试使用模拟 PicGo 服务和临时更新签名，不向真实图床上传、不执行安装器。需要真实安装与卸载的 `npm run test:installer` 仅用于一次性 CI 用户环境，流程见 [发布与更新维护](updates.md#发布资产)。

### 验证 Pandoc 转换

要覆盖真实转换，先安装 Pandoc，并设置其绝对路径。`MOYE_REQUIRE_PANDOC=1` 让桌面导出验证在转换器不可用时失败，避免只验证未安装分支。

**Windows PowerShell**

```powershell
$env:MOYE_PANDOC_PATH = (Get-Command pandoc).Source
$env:MOYE_REQUIRE_PANDOC = '1'
npm test
npm run test:ui
```

**macOS**

```sh
export MOYE_PANDOC_PATH="$(command -v pandoc)"
export MOYE_REQUIRE_PANDOC=1
npm test
npm run test:ui
```

未设置转换器路径时，部分真实转换单元测试会跳过；检查测试结果中的跳过项。不同平台的原生菜单、快捷键与文件行为仍需在对应系统验证。

## 持续集成与构建

推送到 `main` 或提交 PR 会运行 [Source CI](../.github/workflows/checks.yml)，检查构建、单元测试、第三方声明与图标资源。它不构建安装器，也不代替桌面交互与 macOS 实机验证。

仅在准备发布时手动运行 [Desktop CI](../.github/workflows/ci.yml)，在原生 Windows/macOS 环境构建安装器并验证安装后的应用。日常源码修改不需要打包或发布版本。

安装器命令为 `npm run package:installer`，在目标操作系统执行，输出到 `release/installers/`。签名清单需要维护者配置 `MOYE_UPDATE_SIGN_KEY`，私钥不包含在仓库中。正式交付所需的安装器、代码包、签名清单及验证步骤见 [发布与更新维护](updates.md#发布资产)。

## 源码结构

| 路径 | 职责 |
| --- | --- |
| `src/` | 编辑器、工作区和界面。 |
| `electron/` | 主进程、文件访问、存储、导出和更新。 |
| `shared/` | 跨进程类型。 |
| `tests/` | 单元测试与桌面验证。 |
| `scripts/` | 构建、资源检查与发布工具。 |
| `assets/` | 图标和安装器资源。 |
| `docs/` | 使用、开发、架构与版本说明。 |
| `licenses/` | 第三方许可文本。 |

模块关系和数据流见 [应用架构](architecture.md)。
