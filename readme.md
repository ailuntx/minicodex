# minicodex

个人用 Codex 多账号切换工具。每个账号一个独立 `CODEX_HOME`，`auth.json` 不共享；会话、技能、配置等可以软链到统一位置。

## 使用

安装：

```bash
npm install -g @ailuntz/minicodex
minicodex setup
```

`setup` 会安装 `~/.local/bin/codex` shim。确认 `~/.local/bin` 在 PATH 前面后，日常直接用：

```bash
codex
codex resume <session-id>
```

常用命令：

```bash
minicodex status
minicodex use codex001
minicodex next
minicodex prev
minicodex fallback on
minicodex fallback off
minicodex login codex001          # 默认 device-auth
minicodex login codex001 --browser
minicodex logout codex001
minicodex check codex001 --since-min 180
minicodex check codex001 --live
```

添加已经登录好的账号：

```bash
minicodex add codex109 /Users/ailuntz/.minicodex/profiles/codex109 user@example.com
minicodex use codex109
```

只要这个 home 里已经有可用的 `auth.json`，就不需要再 `login`。如果没有登录：

```bash
minicodex login codex109
```

`use/next/prev` 会进入手动模式：固定当前账号，限额也不自动跳走，方便 `logout/login`。需要自动遇到限额就换下一个时：

```bash
minicodex fallback on
```

## 主 Codex

接管开关：

```bash
minicodex on
minicodex off
minicodex doctor
```

`on` 会安装 shim 并开启本地 proxy；`off` 会停用 shim，让 `codex` 回到系统里的真实 Codex。

## 共享目录

按需设置：

```bash
minicodex sessions /Volumes/usb_main/home/index_ailuntz/codex_macmini/sessions
minicodex skills /Volumes/usb_main/home/index_ailuntz/codex_macmini/skills
minicodex config /Volumes/usb_main/home/index_ailuntz/codex_macmini/config.toml
minicodex history /Volumes/usb_main/home/index_ailuntz/codex_macmini/history.jsonl
minicodex pets /Volumes/usb_main/home/index_ailuntz/codex_macmini/pets
minicodex archived_sessions /Volumes/usb_main/home/index_ailuntz/codex_macmini/archived_sessions
minicodex agent /Volumes/usb_main/home/index_ailuntz/codex_macmini/agent
```

如果手动改了 `~/.minicodex/state.json` 里的 shared 路径，需要重建 profile 里的软链：

```bash
minicodex relink
```

## 状态

- `ready`：最近可用。
- `unknown`：本地有账号，但没确认额度。
- `limited`：识别到额度用完；有 reset 时间就到期后自动恢复为 `unknown`。
- `invalid_auth`：refresh token 失效，需要重新登录；不会自动换下一个账号。
- `disabled`：手动禁用。

`status` 和默认 `check` 不消耗 token。`check --live` 会发真实请求，优先复用该账号自己的 `probeSessionId`。

## 原理

链路：

```text
codex 命令
-> ~/.local/bin/codex shim
-> minicodex
-> 选择账号并设置 CODEX_HOME
-> 用 -c 临时把 provider 指到 127.0.0.1 本地 proxy
-> 真实 codex
-> minicodex proxy
-> 官方后端
```

本地 proxy 只能看到经过它的请求。没有 shim 时，真实 `codex` 会用自己的 `CODEX_HOME/config.toml` 直连官方后端，minicodex 看不到 `401/429/quota headers`，也不能写回 `state.json`。

本地 proxy 默认监听 `127.0.0.1:18087`，可用 `MINICODEX_PROXY_PORT` 覆盖。

## 开发

```bash
npm run check
node bin/minicodex.mjs --help
```
