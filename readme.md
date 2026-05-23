# minicodex

个人用 Codex 多账号切换工具。每个账号一个独立 `CODEX_HOME`，`auth.json` 不共享；常用数据目录可以软链到统一位置。

## 安装

```bash
npm install -g @ailuntz/minicodex
```

## 现在状态

- 普通 `codex` / `codex resume`：已接管，默认走本地 proxy。
- 账号切换：按当前账号和环形游标选择，限额或登录失效后下次跳过。
- 状态识别：非 TUI 可直接读输出；TUI 退出后用 `check` 扫本地日志和 session，0 额外 token。
- proxy：默认开启，会自动使用 `http_proxy/https_proxy`，识别到 `401/429` 会更新 `state.json`。

## 常用命令

```bash
node bin/minicodex.mjs status
node bin/minicodex.mjs next
node bin/minicodex.mjs prev
node bin/minicodex.mjs check codex001 --since-min 180
node bin/minicodex.mjs check codex001 --live
node bin/minicodex.mjs login codex001
node bin/minicodex.mjs disable codex004
node bin/minicodex.mjs enable codex004
```

启用 shim 后日常只用：

```bash
codex
codex resume <session-id>
```

## 初始化

```bash
node bin/minicodex.mjs sessions ~/codex-shared/sessions
node bin/minicodex.mjs skills ~/codex-shared/skills
node bin/minicodex.mjs config ~/codex-shared/config.toml
node bin/minicodex.mjs history ~/codex-shared/history.jsonl
node bin/minicodex.mjs pets ~/codex-shared/pets
node bin/minicodex.mjs archived_sessions ~/codex-shared/archived_sessions
node bin/minicodex.mjs agent ~/codex-shared/agent
npm run setup
```

`npm run setup` 只负责安装 `codex` shim，让日常 `codex` 命令先进 minicodex；不会登录，也不会发模型请求。

账号 home 默认在：

```text
~/.minicodex/profiles/codex001
~/.minicodex/profiles/codex002
...
```

## 状态规则

- `ready`：最近可用。
- `unknown`：本地有账号，但没确认额度。
- `limited`：识别到额度用完；有 reset 时间就到期后自动恢复为 `unknown`。
- `invalid_auth`：refresh token 失效，需要重新登录。
- `disabled`：手动禁用。

登录失效时：

```bash
node bin/minicodex.mjs login codex004
```

登录成功只代表认证恢复，不代表额度恢复，所以账号会回到 `unknown`，下次真实使用再判断。

## token 消耗

- `status`：0 token。
- `check` 默认：0 token，只读本地 `auth.json`、`models_cache.json`、日志和 session。
- `check --live`：优先 resume 该账号自己的 `probeSessionId`；没有就新建一个探测会话并写回账号状态。
- `check --live --fresh`：强制新建探测会话并覆盖该账号的 `probeSessionId`。
- TUI 中正常使用的消耗来自官方 Codex 自己带的系统提示、工具、环境上下文，不是 minicodex 额外加的。

## proxy

```bash
codex
```

proxy 会临时生成 shadow `CODEX_HOME/config.toml`，把 provider 指到 `127.0.0.1` 本地代理，从 HTTP 层识别 `401/429` 和 `x-codex-primary-*` 响应头。

当前 proxy 已跑通 `codex exec`。需要临时关闭时：

```bash
node bin/minicodex.mjs proxy off
```

## 设计边界

- 不共享、不复制 `auth.json`。
- 不默认主动探测所有账号。
- 不做桌面 app bind。
- `codex-multi-auth/` 和 `multi-cli/` 不进 git。
