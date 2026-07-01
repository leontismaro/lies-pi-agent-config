# Pi Agent Configuration

可复现的 Pi agent 配置仓库，用于安装 Pi、恢复 agents/chains/extensions，并启用 Gentle AI / SDD / OpenSpec 工作流。

## 当前子代理栈

- `npm:@tintinweb/pi-subagents`：提供 `Agent` / `get_subagent_result` / `steer_subagent` 子代理运行器。
- `npm:gentle-pi`：Gentle AI / SDD / OpenSpec harness，跟 npm release channel 更新。
- `npm:gentle-engram@0.1.8`：Engram 记忆工具，提供 `mem_*` 工具。
- `npm:pi-web-access`：web search / fetch 工具，提供 `fetch_content`。
- `extensions/sdd-tintinweb-fix.ts`：本仓库的兼容层，在 gentle-pi 注入 agent assets 后修正 `tools:` frontmatter，使其适配 `@tintinweb/pi-subagents`。

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
agents/                 Agent 定义；包含 gentle-pi 注入后、已修正 tools 字段的 SDD/JD/4R agents
chains/                 Chain 定义；包含 SDD chains 和 4R review chain
extensions/             Pi 扩展源码和配置
  sdd-tintinweb-fix.ts  gentle-pi agent tools 兼容补丁
gentle-ai/              Gentle AI / SDD 支持文件
openspec/               OpenSpec 配置和规格目录
npm/package.json        Pi 插件依赖声明
npm/package-lock.json   Pi 插件依赖锁定文件
models.example.json     模型配置范本
settings.example.json   Pi 全局设置范本；真实 settings.json 为本机运行态文件，已忽略
keybindings.json        快捷键配置
zentui.json             UI 配置
scripts/install.sh      安装脚本
scripts/sync-gentle-pi-config.sh
                        安全 staging/commit/push 当前 gentle-pi+tintinweb 配置变更
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

## 同步配置仓库

本仓库会忽略本机敏感/运行态文件，例如：

```text
settings.json
auth.json
mcp.json
models.json
trust.json
sessions/
npm/node_modules/
git/
```

同步本次 gentle-pi / tintinweb 配置变更时，使用：

```bash
cd ~/.pi/agent
./scripts/sync-gentle-pi-config.sh --commit --push
```

只预览将要 stage 的文件：

```bash
./scripts/sync-gentle-pi-config.sh --dry-run
```

只 stage 并检查，不 commit：

```bash
./scripts/sync-gentle-pi-config.sh
```

自定义 commit message：

```bash
./scripts/sync-gentle-pi-config.sh --commit --push \
  -m "config: sync gentle-pi tintinweb setup"
```

脚本会 stage 公共安全文件：

- `extensions/sdd-tintinweb-fix.ts`
- `agents/sdd-*.md`
- `agents/jd-*.md`
- `agents/review-*.md`
- `chains/*.chain.md`
- `gentle-ai/support/*.md`
- `npm/package.json`
- `npm/package-lock.json`
- `settings.example.json`
- `README.md`

并拒绝提交 `settings.json`、`auth.json`、`models.json` 等本机文件。

## Gentle Pi / tintinweb 兼容层

`gentle-pi` 会在启动时把 package 内的 agent assets 强制注入到：

```text
~/.pi/agent/agents/
~/.pi/agent/chains/
~/.pi/agent/gentle-ai/support/
```

上游 agent frontmatter 使用的部分工具名并非 `@tintinweb/pi-subagents` 的内置工具名：

```text
glob
webfetch
mem_search
mem_get_observation
mem_save
mem_update
```

`tintinweb` 的 built-in 工具名来自 Pi 本体：

```text
read write edit bash grep find ls
```

扩展工具必须写成：

```text
ext:<extension-name>/<tool-name>
```

因此 `extensions/sdd-tintinweb-fix.ts` 会在 `session_start`、`tool_call` 和 `before_agent_start` 时幂等修正所有 `~/.pi/agent/agents/*.md` 的 `tools:` frontmatter：

```text
glob                  -> find
webfetch              -> ext:pi-web-access/fetch_content
mem_search            -> ext:gentle-engram/mem_search
mem_get_observation   -> ext:gentle-engram/mem_get_observation
mem_save              -> ext:gentle-engram/mem_save
mem_update            -> ext:gentle-engram/mem_update
```

可以手动触发：

```text
/gentle-ai:fix-tintinweb-tools
```

验证命令：

```bash
python - <<'PY'
from pathlib import Path
bad=[]
allowed={'read','write','edit','bash','grep','find','ls','*','all','none'}
for p in Path.home().joinpath('.pi/agent/agents').glob('*.md'):
    s=p.read_text()
    if not s.startswith('---\n'): continue
    end=s.find('\n---\n',4)
    if end<0: continue
    fm=s[4:end].splitlines()
    tools=[]
    for i,line in enumerate(fm):
        if line.startswith('tools:'):
            rest=line.split(':',1)[1].strip().strip('"\'')
            if rest:
                tools=[x.strip().strip('"\'') for x in rest.split(',') if x.strip()]
            else:
                j=i+1
                while j<len(fm) and fm[j].lstrip().startswith('- '):
                    tools.append(fm[j].split('-',1)[1].strip().strip('"\''))
                    j+=1
            break
    for t in tools:
        if t.startswith('ext:'): continue
        if t not in allowed:
            bad.append((p.name,t))
print('bad bare tools:', bad if bad else 'none')
PY
```

期望输出：

```text
bad bare tools: none
```

## SDD/OpenSpec

阶段结构：

```text
init → explore → proposal → spec → design → tasks → apply → verify → sync → archive
```

安装后，Pi 从 `~/.pi/agent/agents`、`~/.pi/agent/chains` 和相关配置加载这些资源。`gentle-pi` 是上游来源，`sdd-tintinweb-fix.ts` 是本仓库维护的 runtime 兼容层。

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
