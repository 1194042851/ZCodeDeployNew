# ZCode-Deploy

一个修改本机 ZCode 客户端 `zcode.cjs` 的工具，用 `人格.txt` 接管 system prompt 的主要注入入口。

本仓库同时提供两套部署脚本：

| 平台 | 入口 | 补丁策略 | 当前状态 |
|---|---|---|---|
| Ubuntu / Linux | `deploy-linux.js`、`deploy-linux.sh` | 2 个补丁，保留会话初始化所需片段 | 已在 ZCode 3.17.2 Linux 版验证 |
| Windows | `deploy.ps1`、`.bat` | 6 个补丁，完整移除各类注入片段 | 来自上游 v2，需按目标版本自行验证 |

> 本仓库 fork 自 [zzooymc-source/ZCode-Deploy](https://github.com/zzooymc-source/ZCode-Deploy)。原项目定位了 `customSystemPrompt` 注入点；后续版本补齐了语义锚点、失败即中止、语法校验和备份轮转，本仓库再补充 Ubuntu 适配。

---

## 1. 快速开始

### Ubuntu / Linux（推荐用于本机）

环境要求：Node.js 可运行 `node --check`；对 `/opt/ZCode` 写入时可能需要 sudo。

```bash
cd ZCode-Deploy
./deploy-linux.sh install
```

然后**重启 ZCode，新建对话**（旧会话可能保留旧状态）。首次写入系统目录时，脚本会提示 sudo；无人值守场景可设置 `SUDO_PASSWORD`。

常用命令：

```bash
./deploy-linux.sh install    # 部署
./deploy-linux.sh status     # 查看当前 cjs 是否已打补丁
./deploy-linux.sh verify     # 验证人格入口与会话结构
./deploy-linux.sh diag       # 列出 zcode.cjs 的注入片段
./deploy-linux.sh restore    # 从 zcode.cjs.bak 还原原版
```

也可以直接调用 Node 入口：

```bash
node deploy-linux.js install
```

脚本默认按以下顺序定位文件：

| 变量 | 默认值 / 回退逻辑 |
|---|---|
| `ZCODE_DIR` | 探测 `/opt/ZCode`、`/usr/lib/ZCode`、`~/.local/share/ZCode` 等 |
| `ZCODE_CJS` | `$ZCODE_DIR/resources/glm/zcode.cjs` |
| `ZCODE_PERSONA` | 脚本同目录的 `人格.txt` |
| `SUDO_PASSWORD` | 未设置时走交互式 sudo |

### Windows

```powershell
powershell -ExecutionPolicy Bypass -File deploy.ps1 install
powershell -ExecutionPolicy Bypass -File deploy.ps1 restore
powershell -ExecutionPolicy Bypass -File deploy.ps1 status
powershell -ExecutionPolicy Bypass -File deploy.ps1 diag
```

或双击 `部署.bat` / `恢复.bat` / `查看状态.bat` / `验证.bat`。`deploy.ps1` 含中文，必须保持 **UTF-8 with BOM**。

---

## 2. 人格文件

[`ZCode-Deploy/人格.txt`](ZCode-Deploy/人格.txt) 是唯一需要日常编辑的文件，UTF-8 编码。脚本会把它的**绝对路径**写进 `zcode.cjs`。

- 只改内容：保存后开新对话即可，不需要重跑部署。
- 移动项目目录：必须重跑 `install`，因为路径已写死。
- ZCode 升级覆盖 `zcode.cjs`：必须重跑 `install`。
- 想恢复原版：执行 `restore`（Linux）或 `恢复.bat`（Windows）。

---

## 3. 两套补丁的区别

### Linux 版：2 个补丁

| # | 修改 | 作用 |
|---|---|---|
| 1 | CLI Prefix 的产品身份声明置空 | 去掉 `You are ZCode` 前缀 |
| 2 | `ContextBuilder.build()` 的 `customSystemPrompt` 改为 `readFileSync(人格.txt)` | 让 `人格.txt` 成为主要 system 内容 |

ZCode 在 `customSystemPrompt` 有值时，会自行跳过 System Context / Environment Info / Memory / Agent Identity 等大部分分支，因此不需要逐个清空片段函数。

**为什么不做 6 补丁**：实测 ZCode 3.17.2 Linux 版在恢复会话时依赖 `Current Date` / `Skills` / `Request User Context` 三个片段的结构。把它们改成 `return null;` 后，客户端报：

```text
Cannot read properties of null (reading 'length')
```

界面显示「初始化失败，暂时无法发送」。Linux 版因此保留这些函数结构，只替换主要 system 入口；代价是日期 / Skills / User Context 等元数据片段仍可能存在，效果不等于 Windows 六补丁版本的“整层清空”。

### Windows 版：6 个补丁

上游 v2 用语义字面量 + 花括号配平定位函数，覆盖：

1. CLI Prefix 身份声明
2. `customSystemPrompt`
3. Agent Identity
4. Current Date
5. Skills
6. Request User Context

这套逻辑针对 Windows 打包版本整理；不同 ZCode 版本的压缩变量名、身份声明文案、片段结构都可能变化。任一锚点未命中时脚本会中止并打印诊断，不会静默写入。

---

## 4. 安全与恢复

两套脚本都遵循相同原则：

| 机制 | 行为 |
|---|---|
| 失败即中止 | 补丁未命中就不写入 |
| 语法校验 | 写入前执行 `node --check` |
| 先备份 | 当前 `zcode.cjs` 归档到 `backups/`，保留最近若干份 |
| 原版保鲜 | 未打补丁时刷新 `zcode.cjs.bak`，避免 `restore` 把应用降级 |
| 保留权限 | Linux 版通过 sudo 写入后恢复原文件的 uid / gid / mode |
| 不入库 | `backups/`、`*.bak`、`zcode-dir.txt` 由 `.gitignore` 排除 |

若部署后出现「初始化失败」，先执行 `./deploy-linux.sh restore` 并重启 ZCode；原始安装文件仍可从 `zcode.cjs.bak` 或 `backups/` 恢复。

---

## 5. 验证与排障

Linux 版：

```bash
./deploy-linux.sh status   # 是否部署、人格路径、备份状态
./deploy-linux.sh verify   # 注入表达式能否读到人格、三个片段结构是否保留、语法是否通过
./deploy-linux.sh diag     # 打印 cjs 内全部 name/source/injectionTarget 片段
```

Windows 版可运行 `验证.bat`：先 `deploy.ps1 diag`，再 `verify-patch.cjs` 执行补丁后的函数。注意 `verify-patch.cjs` 检查的是六补丁结果，不适用于 Linux 双补丁部署。

也可以查看模型请求日志：

```text
~/.zcode/cli/rollout/model-io-*.jsonl
```

检查 system 层是否包含 `人格.txt` 内容，以及是否还带有产品身份声明或其他注入片段。

---

## 6. 文件清单

| 文件 | 用途 |
|---|---|
| `ZCode-Deploy/deploy-linux.js` | Ubuntu / Linux 主脚本：install / restore / status / diag / verify |
| `ZCode-Deploy/deploy-linux.sh` | Linux 一键入口 |
| `ZCode-Deploy/deploy.ps1` | Windows PowerShell 主脚本 |
| `ZCode-Deploy/部署.bat` / `恢复.bat` / `查看状态.bat` / `验证.bat` | Windows 批处理入口 |
| `ZCode-Deploy/verify-patch.cjs` | Windows 六补丁功能验证器 |
| `ZCode-Deploy/人格.txt` | 人格 / system prompt 内容 |
| `ZCode-Deploy/build-release.ps1` | Windows 发布打包与 SHA256 清单 |
| `ZCode-Deploy/修改记录.md` | 上游补丁分析与变更记录 |
| `ZCode-Deploy/backups/` | 本机自动生成的原版/补丁归档，不入库 |

---

## 7. 版本演进

| 能力 | 原仓库 v1 | 上游 v2 | 本仓库 |
|---|---|---|---|
| 锚点定位 | 压缩变量名硬编码 | 语义字面量 + 花括号配平 | 沿用，兼容 Linux bundle 的两种 `customSystemPrompt` 写法 |
| 补丁失败 | 警告后仍写入 | 中止、退出码 1、诊断 | 沿用 |
| 写入前校验 | 无 | `node --check` | 沿用 |
| 备份 | 固定 `.bak` | 自动刷新、轮转 | 沿用并排除入库 |
| 验证 | 人工翻日志 | `verify-patch.cjs` | Linux 增加 `status/verify/diag` |
| Ubuntu | 不支持 | 不支持 | 双补丁部署，保留会话初始化结构 |

---

## 免责声明

本工具仅修改本地安装的软件文件；请遵守 ZCode 服务条款，自行承担使用与升级兼容风险。
