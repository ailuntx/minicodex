# minicodex

个人用 Codex 多账号切换工具。每个账号一个独立 `CODEX_HOME`，`auth.json` 不共享；会话、技能、配置等目录可以软链到统一位置。

## 使用

安装：

```bash
npm install -g @ailuntz/minicodex
minicodex setup
```

`setup` 会安装 `~/.local/bin/codex` shim。之后日常直接用：

```bash
codex
codex resume <session-id>
```

常用命令：

```bash
minicodex status
minicodex next
minicodex prev
minicodex login codex001
minicodex check codex001 --since-min 180
minicodex check codex001 --live
```

接管开关：

```bash
minicodex on
minicodex off
minicodex doctor
```

`on` 等同于重新安装 shim；`off` 会停用 shim，让 `codex` 回到系统里的真实 Codex。

## 初始化

共享目录按需设置：

```bash
minicodex sessions ~/codex-shared/sessions
minicodex skills ~/codex-shared/skills
minicodex config ~/codex-shared/config.toml
minicodex history ~/codex-shared/history.jsonl
minicodex pets ~/codex-shared/pets
minicodex archived_sessions ~/codex-shared/archived_sessions
minicodex agent ~/codex-shared/agent
```

账号 home 默认在：

```text
~/.minicodex/profiles/codex001
~/.minicodex/profiles/codex002
...
```

## 状态

- `ready`：最近可用。
- `unknown`：本地有账号，但没确认额度。
- `limited`：识别到额度用完；有 reset 时间就到期后自动恢复为 `unknown`。
- `invalid_auth`：refresh token 失效，需要重新登录；不会自动换下一个账号。
- `disabled`：手动禁用。

规则：

- `limited/429`：自动换下一个账号。
- `invalid_auth/refresh_token_reused`：停住并提示登录当前账号。
- `status` 和默认 `check` 不消耗 token。
- `check --live` 会发真实请求，优先复用该账号自己的 `probeSessionId`。

## 升级 Codex

如果 Codex 提示升级后下次仍是旧版本，一般是多 Node/PATH 问题。先看：

```bash
which -a codex
which -a npm
minicodex doctor
```

然后重新执行：

```bash
minicodex setup
hash -r
```

`setup` 会重新扫描真实 Codex，并记录版本最高的那个，避免继续指向旧的 `/opt/homebrew/bin/codex`。

## 原理

链路：

```text
codex 命令
-> ~/.local/bin/codex shim
-> minicodex
-> 选择账号并设置 CODEX_HOME
-> 生成 shadow CODEX_HOME/config.toml
-> 把 provider 指到 127.0.0.1 本地 proxy
-> 真实 codex
-> minicodex proxy
-> 官方后端
```

本地 proxy 只能看到经过它的请求。没有 shim 时，真实 `codex` 会用自己的 `CODEX_HOME/config.toml` 直连官方后端，minicodex 看不到 `401/429/quota headers`，也不能写回 `state.json`。

本地 proxy 默认监听：

```text
127.0.0.1:18087
```

可用 `MINICODEX_PROXY_PORT` 覆盖。默认端口被占用时会临时退回随机端口；如果显式设置了 `MINICODEX_PROXY_PORT`，端口被占用会直接报错。

## 开发

```bash
npm run check
node bin/minicodex.mjs --help
```

发布包只包含：

```text
bin/minicodex.mjs
package.json
readme.md
```
