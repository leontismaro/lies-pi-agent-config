# Pi Agent Configuration

可复现的 Pi agent 配置仓库，用于安装 Pi、恢复 agent/chains/extensions，并启用 SDD/OpenSpec 工作流。

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
settings.json           Pi 全局设置范本
keybindings.json        快捷键配置
zentui.json             UI 配置
scripts/install.sh      安装脚本
```

## 安装脚本

`scripts/install.sh` 默认安装到 `~/.pi/agent`，可通过 `PI_AGENT_DIR` 或 `--target` 指定目标目录。

默认执行内容：

1. 安装或更新 Pi CLI。
2. 同步仓库中的 agents、chains、extensions、Gentle AI 和 OpenSpec 配置。
3. 安装 `npm/` 中声明的插件依赖。
4. 执行 `pi update --extensions` 对齐 Pi packages。
5. 从 `models.example.json` 创建本机 `models.json` 初始文件。

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
