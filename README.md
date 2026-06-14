# Pi Agent Configuration

可复现的 Pi agent 配置仓库，用于安装 Pi、恢复 agent/chains/extensions，并启用 SDD/OpenSpec 工作流。

当前子代理栈：

- `npm:@tintinweb/pi-subagents`：Claude Code 风格 `Agent` / `get_subagent_result` / `steer_subagent` runner。
- `git:github.com/leontismaro/gentle-pi@b9cb6a31c3075d4fefe5cc503e3713e97f3b5135`：公开 fork，修复 SDD agent assets 的 tool frontmatter，使其兼容 `@tintinweb/pi-subagents`。
- `agents/scout.md`、`agents/worker.md`、`agents/reviewer.md` 等：旧 `pi-subagents`/Gentle AI 角色名的兼容 custom agents。

## 快速开始

远程安装：

```bash
curl -fsSL https://raw.githubusercontent.com/leontismaro/lies-pi-agent-config/main/scripts/install.sh \
  | sh
```

指定 tag、分支或 commit：

```bash
curl -fsSL https://raw.githubusercontent.com/leontismaro/lies-pi-agent-config/main/scripts/install.sh \
  | sh -s -- --ref <tag-or-commit>
```

本地安装：

```bash
git clone https://github.com/leontismaro/lies-pi-agent-config.git pi-agent-config
cd pi-agent-config
./scripts/install.sh
```

预览安装动作：

```bash
./scripts/install.sh --dry-run
```

## 仓库内容

```text
agents/                 Agent 定义
chains/                 Chain 定义
extensions/             Pi 扩展源码和配置
gentle-ai/              Gentle AI / SDD 支持文件
openspec/               OpenSpec 配置和规格目录
npm/package.json        Pi 插件依赖声明
npm/package-lock.json   Pi 插件依赖锁定文件
models.example.json     模型配置范本
settings.example.json   Pi 全局设置范本；真实 settings.json 为本机运行态文件，已忽略
keybindings.json        快捷键配置
zentui.json             UI 配置
scripts/install.sh      安装脚本
```

## 安装脚本

`scripts/install.sh` 默认安装到 `~/.pi/agent`，可通过 `PI_AGENT_DIR` 或 `--target` 指定目标目录。

默认执行内容：

1. 安装或更新 Pi CLI。
2. 同步仓库中的 agents、chains、extensions、Gentle AI 和 OpenSpec 配置。
3. 从 `settings.example.json` 初始化或覆盖目标 `settings.json`（已有文件默认保留，`--force` 才覆盖）。
4. 安装 `npm/` 中声明的插件依赖。
5. 执行 `pi update --extensions` 对齐 Pi packages。
6. 从 `models.example.json` 创建本机 `models.json` 初始文件。

参数：

```bash
./scripts/install.sh --target ~/.pi/agent
./scripts/install.sh --skip-pi
./scripts/install.sh --skip-packages
./scripts/install.sh --force
./scripts/install.sh --dry-run
```

## SDD/OpenSpec

仓库包含 SDD/OpenSpec 工作流所需的 agent、chain 和配置。

SDD agent 的源头来自 `gentle-pi`。本仓库现在使用 `leontismaro/gentle-pi` fork，原因是上游 `gentle-pi@0.5.0` 的 SDD agent frontmatter 仍使用旧工具名：

```text
glob
webfetch
```

`@tintinweb/pi-subagents` 认可的 built-in 工具名是：

```text
read bash edit write grep find ls
```

因此 fork 中的 SDD agent assets 将：

```diff
- glob
+ find
```

并将 `sdd-explore` 的旧 `webfetch` 改为兼容的本地探索工具集：

```diff
- tools: read, grep, glob, webfetch
+ tools: read, grep, find, bash
```

不要把本地 runtime 目录里被 package 刷新的 `agents/sdd-*.md` 当作唯一源头；长期源头是 fork 中的 `assets/agents/sdd-*.md`。

阶段结构：

```text
init → explore → proposal → spec → design → tasks → apply → verify → sync → archive
```

安装后，Pi 从 `~/.pi/agent/agents`、`~/.pi/agent/chains` 和相关配置加载这些资源。

## 模型配置

`models.example.json` 是模型配置模板。安装后编辑本机 `~/.pi/agent/models.json`，填入实际 provider、model 和 API key。

```json
{
  "apiKey": "${EXAMPLE_PROVIDER_API_KEY}"
}
```

## 依赖

- POSIX shell
- `git`
- `npm`
- `rsync`
- `pi`

`pi` 可由安装脚本自动安装，也可通过 `--skip-pi` 跳过。

## License

MIT
