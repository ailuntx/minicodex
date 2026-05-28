#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import process from "node:process";
import { connect as tlsConnect } from "node:tls";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const invokedName = basename(process.argv[1] ?? "");
const rawArgs = process.argv.slice(2);
const VERSION = readPackageVersion();
const STATE_FILE = "state.json";
const SHARE_TARGETS = {
  sessions: { name: "sessions", kind: "dir" },
  skills: { name: "skills", kind: "dir" },
  config: { name: "config.toml", kind: "file" },
  history: { name: "history.jsonl", kind: "file" },
  pets: { name: "pets", kind: "dir" },
  archived_sessions: { name: "archived_sessions", kind: "dir" },
  agent: { name: "agent", kind: "dir" },
};
const STATUSES = new Set(["ready", "unknown", "limited", "invalid_auth", "disabled"]);
const REAL_CODEX_ENV = "MINICODEX_REAL_CODEX";
const SHIM_ENV = "MINICODEX_AS_CODEX";
const OUTPUT_BUFFER_LIMIT = 64 * 1024;
const DEFAULT_PROBE_MODEL = "gpt-5.4-mini";
const DEFAULT_LIVE_PROBE_TIMEOUT_MS = 60_000;
const DEFAULT_PROXY_FETCH_TIMEOUT_MS = 45_000;
const DEFAULT_TUI_BANNER_DELAY_MS = 3000;
const DEFAULT_PROXY_PORT = 18087;
const PROXY_PROVIDER_ID = "minicodex-proxy";
const CODEX_BACKEND_BASE_URL = "https://chatgpt.com/backend-api";
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "expect",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function maybeReexecWithEnvProxy() {
  const hasProxy = Boolean(process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY);
  if (!hasProxy || process.env.MINICODEX_ENV_PROXY_REEXEC === "1") return;
  if (process.execArgv.includes("--use-env-proxy")) return;
  if (!process.allowedNodeEnvironmentFlags?.has("--use-env-proxy")) return;
  const child = spawnSync(process.execPath, ["--use-env-proxy", ...process.execArgv, scriptPath, ...rawArgs], {
    stdio: "inherit",
    env: { ...process.env, MINICODEX_ENV_PROXY_REEXEC: "1" },
  });
  process.exit(child.status ?? 1);
}

maybeReexecWithEnvProxy();

function readPackageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(scriptPath), "..", "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function abort(message, code = 1) {
  console.error(`minicodex: ${message}`);
  process.exit(code);
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolveResult) => setTimeout(resolveResult, ms));
}

function expandPath(input) {
  const value = String(input ?? "").trim();
  if (!value) return "";
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

function stateRoot() {
  return expandPath(process.env.MINICODEX_HOME || "~/.minicodex");
}

function statePath() {
  return join(stateRoot(), STATE_FILE);
}

function defaultState() {
  return {
    version: 1,
    active: null,
    lastUsed: null,
    cursor: null,
    order: [],
    realCodex: null,
    proxyEnabled: true,
    profiles: {},
    shared: {},
  };
}

function normalizeState(value) {
  const state = { ...defaultState(), ...(value && typeof value === "object" ? value : {}) };
  state.profiles = state.profiles && typeof state.profiles === "object" ? state.profiles : {};
  state.shared = state.shared && typeof state.shared === "object" ? state.shared : {};
  state.proxyEnabled = value?.proxyEnabled !== false;
  state.order = Array.isArray(state.order) ? state.order.filter((name) => typeof name === "string") : [];

  for (const name of Object.keys(state.profiles)) {
    if (!state.order.includes(name)) state.order.push(name);
    const profile = state.profiles[name] ?? {};
    const status = STATUSES.has(profile.status) ? profile.status : "unknown";
    state.profiles[name] = {
      home: expandPath(profile.home || join(stateRoot(), "profiles", name)),
      email: typeof profile.email === "string" ? profile.email : "",
      status,
      resetAt: profile.resetAt ?? null,
      lastError: profile.lastError ?? null,
      lastQuota: profile.lastQuota ?? null,
      probeSessionId: typeof profile.probeSessionId === "string" ? profile.probeSessionId : null,
      probeSessionAt: profile.probeSessionAt ?? null,
      lastSuccessAt: profile.lastSuccessAt ?? null,
      lastTriedAt: profile.lastTriedAt ?? null,
      createdAt: profile.createdAt ?? nowIso(),
      updatedAt: profile.updatedAt ?? nowIso(),
    };
  }

  state.order = state.order.filter((name) => state.profiles[name]);
  for (const key of Object.keys(state.shared)) {
    if (!SHARE_TARGETS[key] || typeof state.shared[key] !== "string") delete state.shared[key];
    else state.shared[key] = expandPath(state.shared[key]);
  }
  return state;
}

function loadState() {
  const path = statePath();
  if (!existsSync(path)) return defaultState();
  try {
    return normalizeState(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    abort(`状态文件读取失败：${path} (${error.message})`);
  }
}

function saveState(state) {
  const root = stateRoot();
  mkdirSync(root, { recursive: true });
  const path = statePath();
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(normalizeState(state), null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

function validateName(name) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name ?? "")) {
    abort("账号名只能包含字母、数字、下划线、短横线，并且必须以字母或数字开头");
  }
}

function ensureProfile(state, name) {
  const profile = state.profiles[name];
  if (!profile) abort(`账号不存在：${name}`);
  return profile;
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function ensureShareTarget(path, kind) {
  if (kind === "dir") {
    mkdirSync(path, { recursive: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, "", { mode: 0o600 });
}

function sameRealPath(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

function backupPath(path) {
  return `${path}.minicodex.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

function linkSharedItem(profileHome, key, targetPath) {
  const spec = SHARE_TARGETS[key];
  if (!spec) abort(`未知共享项：${key}`);
  ensureShareTarget(targetPath, spec.kind);
  ensureDir(profileHome);

  const linkPath = join(profileHome, spec.name);
  if (existsSync(linkPath) || lstatExists(linkPath)) {
    const stat = lstatSync(linkPath);
    if (stat.isSymbolicLink() && sameRealPath(linkPath, targetPath)) return;
    const dest = backupPath(linkPath);
    renameSync(linkPath, dest);
    console.error(`minicodex: 已备份 ${linkPath} -> ${dest}`);
  }
  symlinkSync(targetPath, linkPath, spec.kind === "dir" ? "dir" : "file");
}

function lstatExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function applySharedLinks(state, profileNames = state.order) {
  for (const name of profileNames) {
    const profile = state.profiles[name];
    if (!profile) continue;
    for (const [key, target] of Object.entries(state.shared)) {
      linkSharedItem(profile.home, key, target);
    }
  }
}

function clearExpiredLimits(state) {
  const now = Date.now();
  for (const name of state.order) {
    const profile = state.profiles[name];
    if (!profile || profile.status !== "limited" || !profile.resetAt) continue;
    const reset = Date.parse(profile.resetAt);
    if (Number.isFinite(reset) && reset <= now) {
      profile.status = "unknown";
      profile.lastError = null;
      profile.resetAt = null;
      profile.updatedAt = nowIso();
    }
  }
}

function profileRank(profile) {
  if (profile.status === "ready") return 0;
  if (profile.status === "unknown") return 1;
  if (profile.status === "limited") return 2;
  return 9;
}

function isUsableProfile(profile) {
  if (!profile || profile.status === "disabled") return false;
  if (profile.status === "limited" && profile.resetAt) {
    const reset = Date.parse(profile.resetAt);
    if (Number.isFinite(reset) && reset > Date.now()) return false;
  }
  return true;
}

function orderedNamesFromCursor(state, exclude = new Set()) {
  const names = state.order.filter((name) => state.profiles[name]);
  if (names.length === 0) return [];
  const cursor = state.active || state.cursor || state.lastUsed;
  const cursorIndex = names.indexOf(cursor);
  const ordered = cursorIndex < 0 ? names : [...names.slice(cursorIndex + 1), ...names.slice(0, cursorIndex + 1)];
  return ordered.filter((name) => !exclude.has(name));
}

function pickProfile(state, exclude = new Set(), options = {}) {
  clearExpiredLimits(state);
  if (options.preferCurrent !== false) {
    const preferredNames = state.active ? [state.active] : [state.lastUsed];
    for (const preferred of preferredNames) {
      if (!preferred || exclude.has(preferred)) continue;
      const profile = state.profiles[preferred];
      if (isUsableProfile(profile)) return { name: preferred, profile };
    }
  }

  const candidates = orderedNamesFromCursor(state, exclude)
    .filter((name) => isUsableProfile(state.profiles[name]));
  const name = candidates[0];
  return name ? { name, profile: state.profiles[name] } : null;
}

function splitPath(pathValue) {
  return pathValue.split(":").filter(Boolean);
}

function resolveRealCodex(state, options = {}) {
  const explicit = expandPath(process.env[REAL_CODEX_ENV] || (!options.ignoreSaved ? state.realCodex : "") || "");
  if (explicit && existsSync(explicit)) return explicit;

  const candidates = codexCandidates();
  if (options.preferNewest) {
    const ranked = candidates
      .map((path) => ({ path, version: codexVersion(path) }))
      .filter((item) => item.version)
      .sort((a, b) => compareVersions(b.version, a.version));
    if (ranked[0]) return ranked[0].path;
  }

  return candidates[0] || abort("找不到真实 codex。可设置 MINICODEX_REAL_CODEX=/path/to/codex");
}

function codexCandidates() {
  const selfReal = safeRealpath(process.argv[1] || scriptPath);
  const seen = new Set();
  const paths = [
    ...splitPath(process.env.PATH || "").map((dir) => join(dir, "codex")),
    ...nvmCodexCandidates(),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    "/usr/bin/codex",
  ];
  const result = [];
  for (const candidate of paths) {
    if (!existsSync(candidate)) continue;
    const real = safeRealpath(candidate);
    if (!real || seen.has(real)) continue;
    seen.add(real);
    if (real === selfReal || real === safeRealpath(scriptPath) || isMinicodexShim(candidate)) continue;
    result.push(candidate);
  }
  return result;
}

function nvmCodexCandidates() {
  const root = join(homedir(), ".nvm", "versions", "node");
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name, "bin", "codex"));
  } catch {
    return [];
  }
}

function isMinicodexShim(path) {
  try {
    return readFileSync(path, "utf8").includes(SHIM_ENV);
  } catch {
    return false;
  }
}

function codexVersion(path) {
  try {
    const result = spawnSync(path, ["--version"], {
      encoding: "utf8",
      timeout: 3000,
      env: { ...process.env, [SHIM_ENV]: "", [REAL_CODEX_ENV]: "" },
    });
    const text = `${result.stdout || ""} ${result.stderr || ""}`;
    return text.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

function compareVersions(a, b) {
  const left = String(a).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = String(b).split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function safeRealpath(path) {
  try {
    return realpathSync(path);
  } catch {
    return "";
  }
}

function detectFailure(text) {
  const compact = text.replace(/\s+/g, " ");
  const lower = compact.toLowerCase();
  const githubRateLimit = lower.includes("api.github.com") && lower.includes("rate limit");
  if (
    lower.includes("you've hit your usage limit") ||
    lower.includes("you have hit your usage limit") ||
    lower.includes("usage limit") ||
    lower.includes("codex_runtime_rotation_pool_exhausted") ||
    lower.includes("429 too many requests") ||
    lower.includes("http error: 429") ||
    lower.includes("status 429") ||
    (!githubRateLimit && lower.includes("rate limit") && lower.includes("codex"))
  ) {
    return { type: "usage_limit", resetAt: parseResetAt(compact) };
  }
  if (
    lower.includes("refresh token was already used") ||
    lower.includes("access token could not be refreshed") ||
    lower.includes("failed to refresh token") ||
    lower.includes("401 unauthorized") ||
    lower.includes("authentication session could not be refreshed")
  ) {
    return { type: "refresh_token_invalid" };
  }
  return null;
}

function recentFilePaths(root, options = {}) {
  const { sinceMs = 0, maxDepth = 3, extensions = null } = options;
  const paths = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth || !existsSync(dir)) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      let stat = null;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (entry.isDirectory()) {
        walk(path, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (extensions && !extensions.some((suffix) => entry.name.endsWith(suffix))) continue;
      if (sinceMs > 0 && stat.mtimeMs < sinceMs) continue;
      paths.push(path);
    }
  };
  walk(root, 0);
  return paths;
}

function readTail(path, maxBytes = 512 * 1024) {
  try {
    const text = readFileSync(path, "utf8");
    return text.length > maxBytes ? text.slice(-maxBytes) : text;
  } catch {
    return "";
  }
}

function quotaFromTokenCount(payload, filePath) {
  const limits = payload?.rate_limits;
  const primary = limits?.primary;
  const usage = payload?.info?.last_token_usage ?? payload?.info?.total_token_usage ?? null;
  if (!limits && !usage) return null;
  const resetSeconds = primary?.resets_at;
  return {
    file: filePath,
    updatedAt: nowIso(),
    planType: limits?.plan_type ?? null,
    usedPercent: typeof primary?.used_percent === "number" ? primary.used_percent : null,
    windowMinutes: typeof primary?.window_minutes === "number" ? primary.window_minutes : null,
    resetAt: typeof resetSeconds === "number" ? new Date(resetSeconds * 1000).toISOString() : null,
    inputTokens: usage?.input_tokens ?? null,
    cachedInputTokens: usage?.cached_input_tokens ?? null,
    outputTokens: usage?.output_tokens ?? null,
    reasoningOutputTokens: usage?.reasoning_output_tokens ?? null,
    totalTokens: usage?.total_tokens ?? null,
  };
}

function scanSessionFile(path) {
  const text = readTail(path, 1024 * 1024);
  let lastQuota = null;
  for (const line of text.split(/\n/)) {
    if (!line.includes("token_count")) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed?.type === "event_msg" && parsed?.payload?.type === "token_count") {
        lastQuota = quotaFromTokenCount(parsed.payload, path) ?? lastQuota;
      }
    } catch {
      // 忽略半写入 JSONL 行。
    }
  }
  return lastQuota;
}

function scanProfileArtifacts(profile, state, options = {}) {
  const sinceMs = options.sinceMs ?? 0;
  const findings = { failure: null, quota: null, files: 0 };

  for (const path of recentFilePaths(join(profile.home, "log"), { sinceMs, maxDepth: 1, extensions: [".log"] })) {
    findings.files += 1;
    const failure = detectFailure(readTail(path));
    if (failure) findings.failure = failure;
  }

  if (options.scanSessions !== false) {
    const sessionsRoot = state.shared.sessions || join(profile.home, "sessions");
    for (const path of recentFilePaths(sessionsRoot, { sinceMs, maxDepth: 4, extensions: [".jsonl"] })) {
      findings.files += 1;
      const quota = scanSessionFile(path);
      if (quota) findings.quota = quota;
    }
  }

  return findings;
}

function applyScanFindings(profile, findings) {
  let changed = false;
  if (findings.quota) {
    profile.lastQuota = findings.quota;
    changed = true;
    if (typeof findings.quota.usedPercent === "number" && findings.quota.usedPercent >= 100) {
      profile.status = "limited";
      profile.lastError = "usage_limit";
      profile.resetAt = findings.quota.resetAt ?? profile.resetAt ?? null;
      changed = true;
    }
  }

  if (findings.failure?.type === "usage_limit") {
    profile.status = "limited";
    profile.lastError = "usage_limit";
    profile.resetAt = findings.failure.resetAt ?? profile.resetAt ?? null;
    changed = true;
  } else if (findings.failure?.type === "refresh_token_invalid") {
    profile.status = "invalid_auth";
    profile.lastError = "refresh_token_invalid";
    changed = true;
  }

  if (changed) profile.updatedAt = nowIso();
  return changed;
}

function headerNumber(headers, name) {
  const raw = headers.get(name);
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function quotaFromHeaders(headers) {
  const usedPercent = headerNumber(headers, "x-codex-primary-used-percent");
  const windowMinutes = headerNumber(headers, "x-codex-primary-window-minutes");
  const resetAfter = headerNumber(headers, "x-codex-primary-reset-after-seconds");
  const resetAtRaw = headers.get("x-codex-primary-reset-at");
  if (usedPercent === null && windowMinutes === null && resetAfter === null && !resetAtRaw) return null;

  let resetAt = null;
  if (resetAfter && resetAfter > 0) {
    resetAt = new Date(Date.now() + resetAfter * 1000).toISOString();
  } else if (resetAtRaw) {
    const numeric = /^\d+$/.test(resetAtRaw.trim()) ? Number(resetAtRaw.trim()) : null;
    const parsed = numeric ? (numeric < 10_000_000_000 ? numeric * 1000 : numeric) : Date.parse(resetAtRaw);
    resetAt = Number.isFinite(parsed) ? new Date(parsed).toISOString() : resetAtRaw;
  }

  return {
    updatedAt: nowIso(),
    planType: headers.get("x-codex-plan-type") || null,
    usedPercent,
    windowMinutes,
    resetAt,
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    totalTokens: null,
  };
}

function applyQuota(profile, quota) {
  if (!quota) return false;
  profile.lastQuota = quota;
  if (typeof quota.usedPercent === "number" && quota.usedPercent >= 100) {
    profile.status = "limited";
    profile.lastError = "usage_limit";
    profile.resetAt = quota.resetAt ?? profile.resetAt ?? null;
  }
  profile.updatedAt = nowIso();
  return true;
}

function readAuth(profile) {
  return readJsonFile(join(profile.home, "auth.json"));
}

function profileAuthHeaders(profile, incomingHeaders) {
  const auth = readAuth(profile);
  const accessToken = auth?.tokens?.access_token;
  const accountId = auth?.tokens?.account_id;
  if (!accessToken || !accountId) return null;
  const headers = new Headers(incomingHeaders);
  for (const name of HOP_BY_HOP_HEADERS) headers.delete(name);
  headers.delete("host");
  headers.delete("x-api-key");
  headers.set("authorization", `Bearer ${accessToken}`);
  headers.set("chatgpt-account-id", accountId);
  headers.set("accept-encoding", "identity");
  headers.set("OpenAI-Beta", "responses=experimental");
  headers.set("originator", "codex_cli_rs");
  return headers;
}

function headersFromRequest(req) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }
  return headers;
}

function readRequestBody(req, maxBytes = 64 * 1024 * 1024) {
  return new Promise((resolveResult, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveResult(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function writeJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(`${JSON.stringify(payload)}\n`);
}

function responseHeadersForClient(headers) {
  const result = {};
  for (const [key, value] of headers.entries()) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (lower === "content-encoding") continue;
    result[key] = value;
  }
  return result;
}

function nodeHeadersToHeaders(rawHeaders) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(rawHeaders || {})) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, String(item));
    } else {
      headers.set(key, String(value));
    }
  }
  return headers;
}

function headersToObject(headers) {
  const result = {};
  for (const [key, value] of headers.entries()) result[key] = value;
  return result;
}

function proxyEnvFor(url) {
  const host = url.hostname.toLowerCase();
  const noProxy = process.env.no_proxy || process.env.NO_PROXY || "";
  for (const item of noProxy.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean)) {
    if (item === "*") return "";
    const pattern = item.split("/")[0].replace(/:\d+$/, "");
    if (!pattern) continue;
    if (pattern.startsWith(".") && host.endsWith(pattern)) return "";
    if (pattern.includes("*")) {
      const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      if (new RegExp(`^${escaped}$`).test(host)) return "";
    }
    if (host === pattern || host.endsWith(`.${pattern}`)) return "";
  }
  if (url.protocol === "https:") return process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY || "";
  return process.env.http_proxy || process.env.HTTP_PROXY || "";
}

function publicProxyInfo() {
  const raw = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY || "";
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}`;
  } catch {
    return "set";
  }
}

function requestWithNode(url, init, socket = null) {
  return new Promise((resolveResult, reject) => {
    const isHttps = url.protocol === "https:";
    const requestFn = isHttps ? httpsRequest : httpRequest;
    const createConnection = socket
      ? () => (isHttps ? tlsConnect({ socket, servername: url.hostname }) : socket)
      : undefined;
    const req = requestFn({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: init.method,
      headers: headersToObject(init.headers),
      servername: isHttps ? url.hostname : undefined,
      createConnection,
    }, (res) => {
      resolveResult({
        status: res.statusCode || 0,
        headers: nodeHeadersToHeaders(res.headers),
        stream: res,
      });
    });
    req.setTimeout(init.timeoutMs, () => req.destroy(new Error(`upstream timeout after ${init.timeoutMs}ms`)));
    req.on("error", reject);
    if (init.body?.length) req.write(init.body);
    req.end();
  });
}

function requestThroughHttpProxy(url, proxyRaw, init) {
  return new Promise((resolveResult, reject) => {
    let settled = false;
    const done = (error, result) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolveResult(result);
    };

    let proxy;
    try {
      proxy = new URL(proxyRaw);
    } catch {
      done(new Error(`invalid proxy url: ${proxyRaw}`));
      return;
    }

    const isProxyHttps = proxy.protocol === "https:";
    const requestFn = isProxyHttps ? httpsRequest : httpRequest;
    const headers = {};
    if (proxy.username || proxy.password) {
      headers["proxy-authorization"] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`;
    }
    const connect = requestFn({
      hostname: proxy.hostname,
      port: proxy.port || (isProxyHttps ? 443 : 80),
      method: "CONNECT",
      path: `${url.hostname}:${url.port || 443}`,
      headers,
    });
    connect.setTimeout(init.timeoutMs, () => connect.destroy(new Error(`proxy timeout after ${init.timeoutMs}ms`)));
    connect.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        done(new Error(`proxy CONNECT ${res.statusCode}`));
        return;
      }
      requestWithNode(url, init, socket).then((result) => done(null, result), done);
    });
    connect.on("error", done);
    connect.end();
  });
}

async function requestUpstream(url, init) {
  const proxy = proxyEnvFor(url);
  if (proxy && url.protocol === "https:") return requestThroughHttpProxy(url, proxy, init);
  return requestWithNode(url, init);
}

function readUpstreamText(upstream) {
  return new Promise((resolveResult, reject) => {
    const chunks = [];
    upstream.stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    upstream.stream.on("end", () => resolveResult(Buffer.concat(chunks).toString("utf8")));
    upstream.stream.on("error", reject);
  });
}

function upstreamPathFor(localPath) {
  if (localPath === "/responses" || localPath === "/v1/responses") return "/codex/responses";
  if (localPath === "/codex/responses" || localPath === "/v1/codex/responses") return "/codex/responses";
  if (localPath === "/models" || localPath === "/v1/models") return "/models";
  if (localPath === "/thread/goal/get" || localPath === "/codex/thread/goal/get") return "/codex/thread/goal/get";
  if (localPath === "/thread/goal/set" || localPath === "/codex/thread/goal/set") return "/codex/thread/goal/set";
  return null;
}

async function forwardResponse(upstream, res) {
  res.writeHead(upstream.status, responseHeadersForClient(upstream.headers));
  upstream.stream.on("error", (error) => {
    if (!res.destroyed) res.destroy(error instanceof Error ? error : undefined);
  });
  upstream.stream.pipe(res);
}

function tomlValue(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function proxyConfigArgs(proxy) {
  const base = `model_providers.${PROXY_PROVIDER_ID}`;
  return [
    "-c", `model_provider=${tomlValue(PROXY_PROVIDER_ID)}`,
    "-c", `${base}.name="minicodex"`,
    "-c", `${base}.base_url=${tomlValue(proxy.baseUrl)}`,
    "-c", `${base}.requires_openai_auth=false`,
    "-c", `${base}.experimental_bearer_token=${tomlValue(proxy.clientKey)}`,
    "-c", `${base}.wire_api="responses"`,
  ];
}

async function startProxyServer(state) {
  const clientKey = randomBytes(24).toString("hex");
  const debug = process.env.MINICODEX_PROXY_DEBUG === "1";
  const preferredPort = proxyPort();
  const server = createServer(async (req, res) => {
    const startedState = loadState();
    const incomingUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    if (["/", "/health", "/healthz"].includes(incomingUrl.pathname)) {
      writeJson(res, 200, {
        ok: true,
        name: "minicodex proxy",
        version: VERSION,
        time: nowIso(),
        upstream: CODEX_BACKEND_BASE_URL,
        upstreamProxy: publicProxyInfo(),
        profiles: startedState.order.length,
        active: startedState.active,
        cursor: startedState.cursor,
      });
      return;
    }
    const upstreamPath = upstreamPathFor(incomingUrl.pathname);
    if (debug) console.error(`minicodex proxy: ${req.method} ${incomingUrl.pathname} -> ${upstreamPath || "-"}`);
    if (!upstreamPath) {
      writeJson(res, 404, { error: { message: "minicodex proxy unsupported path", code: "not_found" } });
      return;
    }

    const auth = req.headers.authorization || "";
    if (!String(auth).includes(clientKey)) {
      writeJson(res, 401, { error: { message: "minicodex proxy unauthorized", code: "unauthorized" } });
      return;
    }

    let body = Buffer.alloc(0);
    try {
      body = req.method === "GET" ? Buffer.alloc(0) : await readRequestBody(req);
    } catch (error) {
      writeJson(res, 413, { error: { message: error.message, code: "payload_too_large" } });
      return;
    }

    const tried = new Set();
    let lastStatus = 503;
    let lastBody = "";
    while (tried.size < startedState.order.length) {
      const picked = pickProfile(startedState, tried, { preferCurrent: tried.size === 0 });
      if (!picked) break;
      const { name, profile } = picked;
      tried.add(name);
      if (profile.status === "invalid_auth") {
        const message = `账号 ${name}${profile.email ? ` <${profile.email}>` : ""} 需要重新登录：minicodex login ${name}`;
        startedState.cursor = name;
        saveState(startedState);
        console.error(`minicodex: ${message}`);
        writeJson(res, 401, { error: { message, code: "refresh_token_invalid" } });
        return;
      }
      const headers = profileAuthHeaders(profile, headersFromRequest(req));
      if (!headers) {
        profile.status = "invalid_auth";
        profile.lastError = "refresh_token_invalid";
        profile.updatedAt = nowIso();
        startedState.cursor = name;
        saveState(startedState);
        const message = `账号 ${name}${profile.email ? ` <${profile.email}>` : ""} 需要重新登录：minicodex login ${name}`;
        console.error(`minicodex: ${message}`);
        writeJson(res, 401, { error: { message, code: "refresh_token_invalid" } });
        return;
      }

      const upstreamUrl = new URL(CODEX_BACKEND_BASE_URL);
      upstreamUrl.pathname = `${upstreamUrl.pathname.replace(/\/$/, "")}${upstreamPath}`;
      upstreamUrl.search = incomingUrl.search;

      let upstream;
      try {
        upstream = await requestUpstream(upstreamUrl, {
          method: req.method,
          headers,
          body: req.method === "GET" ? null : body,
          timeoutMs: DEFAULT_PROXY_FETCH_TIMEOUT_MS,
        });
      } catch (error) {
        lastBody = error instanceof Error ? error.message : String(error);
        lastStatus = 503;
        break;
      }

      if (debug) console.error(`minicodex proxy: ${name} upstream ${upstream.status}`);

      const quota = quotaFromHeaders(upstream.headers);
      applyQuota(profile, quota);

      if (upstream.status === 429 || upstream.status === 401) {
        lastStatus = upstream.status;
        lastBody = await readUpstreamText(upstream);
        if (upstream.status === 429) {
          profile.status = "limited";
          profile.lastError = "usage_limit";
          profile.resetAt = quota?.resetAt ?? profile.resetAt ?? null;
          console.error(`minicodex: 账号 ${name}${profile.email ? ` <${profile.email}>` : ""} 已限额，尝试下一个账号`);
        } else {
          profile.status = "invalid_auth";
          profile.lastError = "refresh_token_invalid";
          const message = `账号 ${name}${profile.email ? ` <${profile.email}>` : ""} 需要重新登录：minicodex login ${name}`;
          console.error(`minicodex: ${message}`);
          profile.updatedAt = nowIso();
          startedState.cursor = name;
          saveState(startedState);
          writeJson(res, 401, { error: { message, code: "refresh_token_invalid" } });
          return;
        }
        profile.updatedAt = nowIso();
        startedState.cursor = name;
        saveState(startedState);
        continue;
      }

      profile.status = "ready";
      profile.lastError = null;
      profile.resetAt = null;
      profile.lastSuccessAt = nowIso();
      profile.updatedAt = nowIso();
      startedState.active = name;
      startedState.cursor = name;
      startedState.lastUsed = name;
      saveState(startedState);
      await forwardResponse(upstream, res);
      return;
    }

    saveState(startedState);
    writeJson(res, lastStatus, {
      error: {
        message: lastBody || "minicodex proxy has no usable account",
        code: "minicodex_proxy_pool_exhausted",
      },
    });
  });

  server.on("upgrade", (req, socket) => {
    if (debug) console.error(`minicodex proxy: upgrade ${req.url ?? ""}`);
    socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    socket.destroy();
  });

  let port = preferredPort;
  try {
    await listenProxyServer(server, port);
  } catch (error) {
    if (error?.code !== "EADDRINUSE" || process.env.MINICODEX_PROXY_PORT) throw error;
    port = 0;
    await listenProxyServer(server, port);
  }
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : 0;
  return {
    clientKey,
    baseUrl: `http://127.0.0.1:${actualPort}`,
    close: () => new Promise((resolveResult) => server.close(() => resolveResult())),
  };
}

function proxyPort() {
  const value = Number.parseInt(process.env.MINICODEX_PROXY_PORT || String(DEFAULT_PROXY_PORT), 10);
  return Number.isFinite(value) && value >= 0 && value <= 65535 ? value : DEFAULT_PROXY_PORT;
}

function listenProxyServer(server, port) {
  return new Promise((resolveResult, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveResult();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function formatAge(iso) {
  if (!iso) return "-";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return iso;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function inspectLocalProfile(profile) {
  const authPath = join(profile.home, "auth.json");
  const modelsPath = join(profile.home, "models_cache.json");
  const auth = existsSync(authPath) ? readJsonFile(authPath) : null;
  const models = existsSync(modelsPath) ? readJsonFile(modelsPath) : null;
  const mode = existsSync(authPath) ? statSync(authPath).mode & 0o777 : null;
  const reasons = [];

  if (!auth) reasons.push("missing-auth");
  if (auth && auth.auth_mode !== "chatgpt") reasons.push("auth-mode");
  if (mode !== null && mode !== 0o600) reasons.push(`auth-mode-${mode.toString(8)}`);
  if (!auth?.tokens?.refresh_token) reasons.push("missing-refresh-token");
  if (!auth?.tokens?.access_token) reasons.push("missing-access-token");
  if (!models?.models?.length) reasons.push("missing-model-cache");
  if (profile.status === "limited") reasons.push("marked-limited");
  if (profile.status === "invalid_auth") reasons.push("marked-invalid-auth");

  return {
    ok: reasons.length === 0,
    reasons,
    lastRefresh: auth?.last_refresh ?? null,
    modelCacheAt: models?.fetched_at ?? null,
    modelCount: Array.isArray(models?.models) ? models.models.length : 0,
  };
}

function parseResetAt(text) {
  const match = text.match(/try again at\s+([^.\n\r]+)/i);
  if (!match) return null;
  const raw = match[1].trim();
  const normalized = raw.replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, "$1");
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : raw;
}

function appendBuffer(current, chunk) {
  const next = current + chunk;
  return next.length > OUTPUT_BUFFER_LIMIT ? next.slice(-OUTPUT_BUFFER_LIMIT) : next;
}

function codexEnv(home) {
  const env = { ...process.env, CODEX_HOME: home };
  mirrorEnv(env, "http_proxy", "HTTP_PROXY");
  mirrorEnv(env, "https_proxy", "HTTPS_PROXY");
  mirrorEnv(env, "all_proxy", "ALL_PROXY");
  mirrorEnv(env, "no_proxy", "NO_PROXY");
  return env;
}

function mirrorEnv(env, lower, upper) {
  if (env[lower] && !env[upper]) env[upper] = env[lower];
  if (env[upper] && !env[lower]) env[lower] = env[upper];
}

function runCodexOnce(codexBin, profile, args, options = {}) {
  return new Promise((resolveResult) => {
    const env = codexEnv(options.home || profile.home);
    const child = spawn(codexBin, args, { stdio: ["inherit", "pipe", "pipe"], env });
    let output = "";

    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      output = appendBuffer(output, chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      output = appendBuffer(output, chunk.toString("utf8"));
    });
    child.on("error", (error) => resolveResult({ code: 1, signal: null, output, spawnError: error }));
    child.on("close", (code, signal) => resolveResult({ code: code ?? 1, signal, output }));
  });
}

function runCodexInteractive(codexBin, profile, args, options = {}) {
  return new Promise((resolveResult) => {
    const env = codexEnv(options.home || profile.home);
    const child = spawn(codexBin, args, { stdio: "inherit", env });
    child.on("error", (error) => resolveResult({ code: 1, signal: null, spawnError: error }));
    child.on("close", (code, signal) => resolveResult({ code: code ?? 1, signal }));
  });
}

function runPassthrough(codexBin, args) {
  return new Promise((resolveResult) => {
    const child = spawn(codexBin, args, { stdio: "inherit", env: process.env });
    child.on("error", (error) => resolveResult({ code: 1, signal: null, spawnError: error }));
    child.on("close", (code, signal) => resolveResult({ code: code ?? 1, signal }));
  });
}

function hasHelpOrVersionArg(args) {
  return args.some((arg) => ["help", "--help", "-h", "version", "--version", "-V"].includes(arg));
}

function shouldRunInteractive(args) {
  if (hasHelpOrVersionArg(args)) return false;
  const first = args.find((arg) => !arg.startsWith("-")) ?? "";
  return first === "" || first === "resume" || first === "fork" || first === "app";
}

function forwardedCommand(args) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("-")) return arg;
    if (["-c", "--config", "-m", "--model", "-s", "--sandbox"].includes(arg)) i += 1;
  }
  return "";
}

function shouldUseProxyForArgs(args, state) {
  const override = (process.env.MINICODEX_PROXY ?? "").trim().toLowerCase();
  if (["0", "false", "off", "no"].includes(override)) return false;
  if (["1", "true", "on", "yes"].includes(override)) return isProxyRequestArgs(args);
  return state.proxyEnabled === true && isProxyRequestArgs(args);
}

function isProxyRequestArgs(args) {
  if (hasHelpOrVersionArg(args)) return false;
  const command = forwardedCommand(args);
  if (!command) return true;
  if (["help", "--help", "-h", "version", "--version", "-v"].includes(command)) return false;
  if (["login", "logout", "mcp", "mcp-server", "sandbox", "debug", "completion", "apply", "cloud", "features"].includes(command)) {
    return false;
  }
  return true;
}

function runCodexOnceWithTimeout(codexBin, profile, args, timeoutMs) {
  return new Promise((resolveResult) => {
    const env = codexEnv(profile.home);
    const child = spawn(codexBin, args, { stdio: ["ignore", "pipe", "pipe"], env });
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      output = appendBuffer(output, chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk) => {
      output = appendBuffer(output, chunk.toString("utf8"));
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolveResult({ code: 1, signal: null, output, spawnError: error });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveResult({ code: code ?? 1, signal, output });
    });
  });
}

function tuiBannerDelayMs() {
  const raw = process.env.MINICODEX_TUI_DELAY_MS;
  if (raw === undefined) return DEFAULT_TUI_BANNER_DELAY_MS;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

async function runCodex(args, options = {}) {
  const state = loadState();
  if (state.order.length === 0) abort("还没有账号。先运行 minicodex add <name> <CODEX_HOME> 或 minicodex new <name>");

  const codexBin = resolveRealCodex(state);
  const command = forwardedCommand(args);
  const currentName = state.active || state.cursor || state.lastUsed;
  const currentProfile = currentName ? state.profiles[currentName] : null;
  if (currentProfile?.status === "invalid_auth" && command !== "login" && command !== "logout") {
    const email = currentProfile.email ? ` <${currentProfile.email}>` : "";
    abort(`账号 ${currentName}${email} 需要重新登录：minicodex login ${currentName}`);
  }
  const interactive = shouldRunInteractive(args);
  const tried = new Set();
  let lastCode = 1;

  while (tried.size < state.order.length) {
    const picked = pickProfile(state, tried, { preferCurrent: tried.size === 0 });
    if (!picked) break;
    const { name } = picked;
    let profile = picked.profile;
    tried.add(name);
    if (profile.status === "invalid_auth" && command !== "login" && command !== "logout") {
      const email = profile.email ? ` <${profile.email}>` : "";
      state.cursor = name;
      saveState(state);
      abort(`账号 ${name}${email} 需要重新登录：minicodex login ${name}`);
    }
    profile.lastTriedAt = nowIso();
    profile.updatedAt = nowIso();
    saveState(state);
    profile = state.profiles[name];

    console.error(`minicodex: 使用账号 ${name}${profile.email ? ` <${profile.email}>` : ""}`);
    const scanStartMs = Date.now() - 5000;
    let proxy = null;
    let runArgs = args;
    let result;
    try {
      if (options.proxy) {
        proxy = await startProxyServer(state);
        runArgs = [...proxyConfigArgs(proxy), ...args];
        console.error(`minicodex: proxy ${proxy.baseUrl}`);
      }
      if (interactive && process.stderr.isTTY) await sleep(tuiBannerDelayMs());
      result = interactive
        ? await runCodexInteractive(codexBin, profile, runArgs)
        : await runCodexOnce(codexBin, profile, runArgs);
    } finally {
      if (proxy) await proxy.close();
    }
    lastCode = result.code;

    if (result.spawnError) abort(`启动真实 codex 失败：${result.spawnError.message}`);
    if (options.proxy) process.exit(result.code);
    if (interactive) {
      const findings = scanProfileArtifacts(profile, state, { sinceMs: scanStartMs });
      const scannedFailure = findings.failure;
      applyScanFindings(profile, findings);
      if (scannedFailure?.type === "usage_limit") {
        state.cursor = name;
        saveState(state);
        console.error(`minicodex: 已从 TUI 运行日志识别到 ${name}${profile.email ? ` <${profile.email}>` : ""} 限额，下次会跳过`);
      } else if (scannedFailure?.type === "refresh_token_invalid") {
        state.cursor = name;
        saveState(state);
        console.error(`minicodex: 已从 TUI 运行日志识别到 ${name}${profile.email ? ` <${profile.email}>` : ""} 需要重新登录：minicodex login ${name}`);
      } else if (result.code === 0) {
        profile.status = "ready";
        profile.lastError = null;
        profile.resetAt = null;
        profile.lastSuccessAt = nowIso();
        profile.updatedAt = nowIso();
        state.active = name;
        state.lastUsed = name;
        state.cursor = name;
        saveState(state);
      }
      process.exit(result.code);
    }
    const failure = detectFailure(result.output);
    if (result.code === 0) {
      profile.status = "ready";
      profile.lastError = null;
      profile.resetAt = null;
      profile.lastSuccessAt = nowIso();
      profile.updatedAt = nowIso();
      state.active = name;
      state.lastUsed = name;
      state.cursor = name;
      saveState(state);
      process.exit(result.code);
    }

    if (!failure) {
      profile.lastError = "codex_error";
      profile.updatedAt = nowIso();
      saveState(state);
      process.exit(result.code);
    }

    if (failure.type === "usage_limit") {
      profile.status = "limited";
      profile.lastError = "usage_limit";
      profile.resetAt = failure.resetAt ?? profile.resetAt ?? null;
      profile.updatedAt = nowIso();
      state.cursor = name;
      saveState(state);
      console.error(`minicodex: 账号 ${name}${profile.email ? ` <${profile.email}>` : ""} 已限额，尝试下一个账号`);
      continue;
    }

    if (failure.type === "refresh_token_invalid") {
      profile.status = "invalid_auth";
      profile.lastError = "refresh_token_invalid";
      profile.updatedAt = nowIso();
      state.cursor = name;
      saveState(state);
      console.error(`minicodex: 账号 ${name}${profile.email ? ` <${profile.email}>` : ""} 需要重新登录：minicodex login ${name}`);
      process.exit(result.code || 1);
    }

    process.exit(result.code);
  }

  printUnavailableSummary(state);
  process.exit(lastCode || 1);
}

function printUnavailableSummary(state) {
  console.error("minicodex: 没有可用账号");
  for (const name of state.order) {
    const p = state.profiles[name];
    if (!p) continue;
    const detail = p.status === "limited" && p.resetAt ? `，恢复时间 ${p.resetAt}` : "";
    const email = p.email ? ` <${p.email}>` : "";
    console.error(`  ${name}${email}: ${p.status}${detail}`);
  }
}

function cmdNew(args) {
  const [name, homeArg] = args;
  validateName(name);
  const state = loadState();
  if (state.profiles[name]) abort(`账号已存在：${name}`);
  const home = expandPath(homeArg || join(stateRoot(), "profiles", name));
  ensureDir(home);
  state.profiles[name] = {
    home,
    email: "",
    status: "unknown",
    resetAt: null,
    lastError: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  state.order.push(name);
  state.active ??= name;
  state.cursor ??= name;
  applySharedLinks(state, [name]);
  saveState(state);
  console.log(`已创建账号 ${name}: ${home}`);
}

function cmdAdd(args) {
  const [name, homeArg, email = ""] = args;
  validateName(name);
  if (!homeArg) abort("用法：minicodex add <name> <CODEX_HOME> [email]");
  const state = loadState();
  if (state.profiles[name]) abort(`账号已存在：${name}`);
  const home = expandPath(homeArg);
  ensureDir(home);
  state.profiles[name] = {
    home,
    email,
    status: "unknown",
    resetAt: null,
    lastError: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  state.order.push(name);
  state.active ??= name;
  state.cursor ??= name;
  applySharedLinks(state, [name]);
  saveState(state);
  console.log(`已导入账号 ${name}: ${home}`);
}

function shortReset(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${month}-${day} ${hour}:${minute}`;
}

function profileSummary(name, profile) {
  const email = profile.email ? ` <${profile.email}>` : "";
  const quota = profile.lastQuota && typeof profile.lastQuota.usedPercent === "number" ? ` quota=${profile.lastQuota.usedPercent}%` : "";
  const reset = profile.resetAt ? ` reset=${shortReset(profile.resetAt)}` : "";
  return `${name}${email} ${profile.status}${quota}${reset}`;
}

function cmdStatus(args = []) {
  if (args.length > 0) abort("用法：minicodex status");
  const state = loadState();
  clearExpiredLimits(state);
  saveState(state);
  if (state.order.length === 0) {
    console.log("暂无账号");
    return;
  }

  const current = state.active || state.cursor || state.lastUsed;
  const currentProfile = current ? state.profiles[current] : null;
  const picked = pickProfile(state, new Set([current].filter(Boolean)), { preferCurrent: false });
  const problems = state.order
    .filter((name) => {
      const p = state.profiles[name];
      return p?.status === "limited" || p?.status === "invalid_auth" || p?.status === "disabled";
    })
    .slice(0, 8);
  const counts = {};
  for (const name of state.order) {
    const status = state.profiles[name]?.status || "unknown";
    counts[status] = (counts[status] || 0) + 1;
  }

  console.log(`账号 ${state.order.length} 个，proxy=${state.proxyEnabled ? "on" : "off"}`);
  console.log(`状态 ready=${counts.ready || 0} unknown=${counts.unknown || 0} limited=${counts.limited || 0} invalid_auth=${counts.invalid_auth || 0} disabled=${counts.disabled || 0}`);
  if (currentProfile) console.log(`当前 ${profileSummary(current, currentProfile)}`);
  if (picked) console.log(`下个 ${profileSummary(picked.name, picked.profile)}`);
  if (problems.length > 0) {
    console.log("问题");
    for (const name of problems) {
      console.log(`  ${profileSummary(name, state.profiles[name])}`);
    }
    if (problems.length < state.order.filter((name) => {
      const p = state.profiles[name];
      return p?.status === "limited" || p?.status === "invalid_auth" || p?.status === "disabled";
    }).length) {
      console.log("  ...");
    }
  }
}

function cmdList(args = []) {
  cmdStatus(args);
}

function cmdUse(args) {
  const [name] = args;
  const state = loadState();
  ensureProfile(state, name);
  state.active = name;
  state.cursor = name;
  saveState(state);
  console.log(`当前账号：${name}`);
}

function cmdStep(direction) {
  const state = loadState();
  if (state.order.length === 0) abort("还没有账号。先运行 minicodex add/new");
  const current = state.active || state.cursor || state.lastUsed || state.order[0];
  const start = Math.max(0, state.order.indexOf(current));
  for (let offset = 1; offset <= state.order.length; offset += 1) {
    const index = (start + direction * offset + state.order.length) % state.order.length;
    const name = state.order[index];
    const profile = state.profiles[name];
    if (!profile || profile.status === "disabled") continue;
    state.active = name;
    state.cursor = name;
    saveState(state);
    const email = profile.email ? ` <${profile.email}>` : "";
    const reset = profile.resetAt ? ` reset=${profile.resetAt}` : "";
    console.log(`当前账号：${name}${email} ${profile.status}${reset}`);
    return;
  }
  abort("没有可切换账号");
}

function cmdNext() {
  cmdStep(1);
}

function cmdPrev() {
  cmdStep(-1);
}

function cmdSetEmail(args) {
  const [name, email = ""] = args;
  const state = loadState();
  const profile = ensureProfile(state, name);
  profile.email = email;
  profile.updatedAt = nowIso();
  saveState(state);
  console.log(`已更新 ${name} 邮箱`);
}

function cmdMark(args) {
  const [name, status, resetAt = null] = args;
  if (!STATUSES.has(status)) abort(`状态必须是：${[...STATUSES].join(", ")}`);
  const state = loadState();
  const profile = ensureProfile(state, name);
  profile.status = status;
  profile.lastError = status === "limited" ? "usage_limit" : status === "invalid_auth" ? "refresh_token_invalid" : null;
  profile.resetAt = status === "limited" ? resetAt : null;
  profile.updatedAt = nowIso();
  saveState(state);
  console.log(`已标记 ${name}: ${status}`);
}

function cmdDisable(args) {
  const [name] = args;
  if (!name) abort("用法：minicodex disable <name>");
  const state = loadState();
  const profile = ensureProfile(state, name);
  profile.status = "disabled";
  profile.lastError = null;
  profile.resetAt = null;
  profile.updatedAt = nowIso();
  saveState(state);
  console.log(`已禁用 ${name}`);
}

function cmdEnable(args) {
  const [name] = args;
  if (!name) abort("用法：minicodex enable <name>");
  const state = loadState();
  const profile = ensureProfile(state, name);
  profile.status = "unknown";
  profile.lastError = null;
  profile.resetAt = null;
  profile.updatedAt = nowIso();
  saveState(state);
  console.log(`已启用 ${name}`);
}

function cmdShared(key, args) {
  const [targetArg] = args;
  if (!targetArg) abort(`用法：minicodex ${key} <path>`);
  const spec = SHARE_TARGETS[key];
  const state = loadState();
  const target = expandPath(targetArg);
  ensureShareTarget(target, spec.kind);
  state.shared[key] = target;
  applySharedLinks(state);
  saveState(state);
  console.log(`已设置 ${key}: ${target}`);
}

function parseCheckBaseArgs(args) {
  const options = {
    live: false,
    all: false,
    max: 1,
    model: DEFAULT_PROBE_MODEL,
    prompt: "只输出数字 1",
    fresh: false,
    timeoutMs: DEFAULT_LIVE_PROBE_TIMEOUT_MS,
    names: [],
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--live") options.live = true;
    else if (arg === "--all") options.all = true;
    else if (arg === "--max") options.max = Number.parseInt(args[++i] ?? "1", 10);
    else if (arg === "-m" || arg === "--model") options.model = args[++i] ?? options.model;
    else if (arg === "--prompt") options.prompt = args[++i] ?? options.prompt;
    else if (arg === "--fresh") {
      options.fresh = true;
    }
    else if (arg === "--timeout-ms") options.timeoutMs = Number.parseInt(args[++i] ?? String(options.timeoutMs), 10);
    else if (arg.startsWith("--")) abort(`未知 check 参数：${arg}`);
    else options.names.push(arg);
  }
  if (!Number.isFinite(options.max) || options.max <= 0) options.max = 1;
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) options.timeoutMs = DEFAULT_LIVE_PROBE_TIMEOUT_MS;
  return options;
}

function resolveCheckNames(state, options) {
  if (options.names.length > 0) {
    for (const name of options.names) ensureProfile(state, name);
    return options.names;
  }
  if (options.all) return state.order;
  const picked = pickProfile(state);
  return picked ? [picked.name] : [];
}

function parseCheckArgs(args) {
  const options = parseCheckBaseArgs(args);
  options.sinceMinutes = 180;
  const names = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--since-min") {
      options.sinceMinutes = Number.parseInt(args[++i] ?? "180", 10);
    } else if (arg === "--max" || arg === "-m" || arg === "--model" || arg === "--prompt" || arg === "--timeout-ms") {
      i += 1;
    } else if (arg === "--live" || arg === "--all" || arg === "--fresh") {
      // 已由 parseCheckBaseArgs 处理。
    } else if (arg.startsWith("--")) {
      abort(`未知 check 参数：${arg}`);
    } else {
      names.push(arg);
    }
  }
  options.names = names;
  if (!Number.isFinite(options.sinceMinutes) || options.sinceMinutes <= 0) options.sinceMinutes = 180;
  return options;
}

function liveProbeArgs(profile, options) {
  const sessionId = !options.fresh ? profile.probeSessionId : null;
  if (sessionId) {
    const args = ["exec", "resume", "-m", options.model, "--skip-git-repo-check"];
    args.push(sessionId);
    args.push(options.prompt);
    return args;
  }
  return ["exec", "-m", options.model, "--skip-git-repo-check", "--sandbox", "read-only", "--color", "never", "--", options.prompt];
}

function extractSessionId(output) {
  const text = String(output || "");
  const jsonMatch = text.match(/"session_id"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i);
  if (jsonMatch) return jsonMatch[1];
  const textMatch = text.match(/session id:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return textMatch ? textMatch[1] : null;
}

async function cmdCheck(args) {
  const options = parseCheckArgs(args);
  const state = loadState();
  const limit = options.names.length > 0 || options.all ? state.order.length : options.max;
  const names = resolveCheckNames(state, options).slice(0, limit);
  if (names.length === 0) abort("没有可检查账号");
  const sinceMs = Date.now() - options.sinceMinutes * 60_000;

  for (const name of names) {
    const profile = state.profiles[name];
    const email = profile.email ? ` <${profile.email}>` : "";
    const local = inspectLocalProfile(profile);
    const findings = scanProfileArtifacts(profile, state, { sinceMs, scanSessions: names.length === 1 });
    applyScanFindings(profile, findings);
    const reasonText = local.reasons.length ? local.reasons.join(",") : "ok";
    const quota = profile.lastQuota;
    const quotaText = quota && typeof quota.usedPercent === "number" ? ` quota=${quota.usedPercent}% reset=${quota.resetAt ?? "-"}` : "";
    const failureText = findings.failure ? ` failure=${findings.failure.type}` : "";
    console.log(`${name}${email}: local=${local.ok ? "ok" : "warn"} status=${profile.status}${quotaText}${failureText} refresh=${formatAge(local.lastRefresh)} models=${local.modelCount} cache=${formatAge(local.modelCacheAt)} reason=${reasonText}`);

    if (!options.live) continue;
    const codexBin = resolveRealCodex(state);
    const result = await runCodexOnceWithTimeout(
      codexBin,
      profile,
      liveProbeArgs(profile, options),
      options.timeoutMs,
    );
    const failure = detectFailure(result.output);
    if (result.code === 0) {
      const sessionId = extractSessionId(result.output);
      if (sessionId) {
        profile.probeSessionId = sessionId;
        profile.probeSessionAt = nowIso();
      }
      profile.status = "ready";
      profile.lastError = null;
      profile.resetAt = null;
      profile.lastSuccessAt = nowIso();
      profile.updatedAt = nowIso();
      state.active = name;
      state.cursor = name;
      state.lastUsed = name;
      console.log(`${name}${email}: live=ready${profile.probeSessionId ? ` probe=${profile.probeSessionId}` : ""}`);
    } else if (failure?.type === "usage_limit") {
      profile.status = "limited";
      profile.lastError = "usage_limit";
      profile.resetAt = failure.resetAt ?? profile.resetAt ?? null;
      profile.updatedAt = nowIso();
      console.log(`${name}${email}: live=limited${profile.resetAt ? ` reset=${profile.resetAt}` : ""}`);
    } else if (failure?.type === "refresh_token_invalid") {
      profile.status = "invalid_auth";
      profile.lastError = "refresh_token_invalid";
      profile.updatedAt = nowIso();
      console.log(`${name}${email}: live=invalid_auth`);
    } else {
      profile.lastError = "codex_error";
      profile.updatedAt = nowIso();
      const short = result.output.replace(/\s+/g, " ").trim().slice(-180);
      console.log(`${name}${email}: live=error code=${result.code}${short ? ` msg=${short}` : ""}`);
    }
  }
  saveState(state);
}

async function cmdLogin(args) {
  const first = args[0] ?? "";
  const hasName = first.length > 0 && !first.startsWith("-");
  const name = hasName ? first : "";
  const state = loadState();
  const targetName = name || state.active || state.cursor;
  if (!targetName) abort("还没有当前账号。先运行 minicodex add/new/use");
  const profile = ensureProfile(state, targetName);
  const codexBin = resolveRealCodex(state);
  const passArgs = args.slice(hasName ? 1 : 0);
  const browser = passArgs.includes("--browser");
  const cleanArgs = passArgs.filter((arg) => arg !== "--browser");
  if (!browser && !cleanArgs.includes("--device-auth")) cleanArgs.unshift("--device-auth");
  const loginArgs = ["login", ...cleanArgs];
  const result = await runCodexOnce(codexBin, profile, loginArgs);
  if (result.code === 0) {
    profile.status = "unknown";
    profile.lastError = null;
    profile.resetAt = null;
    profile.updatedAt = nowIso();
    state.active = targetName;
    saveState(state);
  }
  process.exit(result.code);
}

function cmdInstallShim() {
  const state = loadState();
  const realCodex = resolveRealCodex(state, { ignoreSaved: true, preferNewest: true });
  state.realCodex = realCodex;
  state.proxyEnabled = true;
  saveState(state);

  const binDir = expandPath(process.env.MINICODEX_BIN_DIR || "~/.local/bin");
  ensureDir(binDir);
  const target = join(binDir, "codex");
  if (existsSync(target) || lstatExists(target)) {
    const real = safeRealpath(target);
    if (real !== safeRealpath(scriptPath)) {
      const dest = backupPath(target);
      renameSync(target, dest);
      console.error(`minicodex: 已备份旧 codex shim: ${dest}`);
    } else {
      rmSync(target);
    }
  }
  const content = [
    "#!/usr/bin/env bash",
    `export ${REAL_CODEX_ENV}=${shellQuote(realCodex)}`,
    `export ${SHIM_ENV}=1`,
    `exec ${shellQuote(process.execPath)} ${shellQuote(scriptPath)} "$@"`,
    "",
  ].join("\n");
  writeFileSync(target, content, { mode: 0o755 });
  chmodSync(target, 0o755);
  console.log(`已安装 shim: ${target}`);
  console.log(`真实 codex: ${realCodex}`);
  console.log(`确认 ${binDir} 在 PATH 前面`);
}

function cmdTakeover(mode = "status") {
  const binDir = expandPath(process.env.MINICODEX_BIN_DIR || "~/.local/bin");
  const target = join(binDir, "codex");
  if (mode === "on") {
    cmdInstallShim();
    return;
  }
  if (mode === "off") {
    if (!lstatExists(target)) {
      console.log("接管: off");
      return;
    }
    if (!isMinicodexShim(target)) abort(`${target} 不是 minicodex shim，不自动处理`);
    const dest = `${target}.minicodex.off-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    renameSync(target, dest);
    console.log("接管: off");
    console.log(`已停用 shim: ${target} -> ${dest}`);
    return;
  }
  const active = lstatExists(target) && isMinicodexShim(target);
  console.log(`接管: ${active ? "on" : "off"}`);
  if (active) console.log(`shim: ${target}`);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function cmdDoctor() {
  const state = loadState();
  console.log(`minicodex ${VERSION}`);
  console.log(`state: ${statePath()}`);
  console.log(`profiles: ${state.order.length}`);
  console.log(`proxy: ${state.proxyEnabled ? "on" : "off"}`);
  cmdTakeover("status");
  try {
    console.log(`real codex: ${resolveRealCodex(state)}`);
    console.log(`推荐 codex: ${resolveRealCodex(state, { ignoreSaved: true, preferNewest: true })}`);
  } catch (error) {
    console.log(`real codex: ${error.message}`);
  }
  for (const [key, value] of Object.entries(state.shared)) {
    console.log(`${key}: ${value}`);
  }
}

function cmdProxy(args) {
  const [mode = "status"] = args;
  const state = loadState();
  if (["on", "enable", "enabled", "1", "true"].includes(mode)) {
    state.proxyEnabled = true;
    saveState(state);
    console.log("proxy: on");
    return;
  }
  if (["off", "disable", "disabled", "0", "false"].includes(mode)) {
    state.proxyEnabled = false;
    saveState(state);
    console.log("proxy: off");
    return;
  }
  if (["status", "show"].includes(mode)) {
    console.log(`proxy: ${state.proxyEnabled ? "on" : "off"}`);
    return;
  }
  abort("用法：minicodex proxy on|off|status");
}

function printHelp() {
  console.log(`minicodex ${VERSION}

用法:
  minicodex new <name> [home]
  minicodex add <name> <CODEX_HOME> [email]
  minicodex status
  minicodex use <name>
  minicodex next
  minicodex prev
  minicodex email <name> <email>
  minicodex disable <name>
  minicodex enable <name>
  minicodex mark <name> <ready|unknown|limited|invalid_auth|disabled> [resetAt]
  minicodex check [name...] [--all] [--since-min N] [--live] [--fresh] [--max N] [-m model]
  minicodex proxy on|off|status
  minicodex on|off
  minicodex setup
  minicodex login [name] [codex login args...]
  minicodex run -- <codex args...>
  minicodex sessions <path>
  minicodex skills <path>
  minicodex config <path-or-config.toml>
  minicodex history <path-or-history.jsonl>
  minicodex pets <path>
  minicodex archived_sessions <path>
  minicodex agent <path>
  minicodex doctor

作为 codex shim 调用时，所有参数都会转发给真实 codex。`);
}

async function main() {
  if (invokedName === "codex" || process.env[SHIM_ENV] === "1") {
    const state = loadState();
    if (hasHelpOrVersionArg(rawArgs)) {
      const result = await runPassthrough(resolveRealCodex(state), rawArgs);
      if (result.spawnError) abort(`启动真实 codex 失败：${result.spawnError.message}`);
      process.exit(result.code);
    }
    if (forwardedCommand(rawArgs) === "login") {
      const index = rawArgs.indexOf("login");
      await cmdLogin(rawArgs.slice(index + 1));
      return;
    }
    await runCodex(rawArgs, { proxy: shouldUseProxyForArgs(rawArgs, state) });
    return;
  }

  const cmd = rawArgs[0] ?? "";
  const args = rawArgs.slice(1);
  switch (cmd) {
    case "new":
      cmdNew(args);
      break;
    case "add":
      cmdAdd(args);
      break;
    case "list":
    case "status":
      cmdStatus(args);
      break;
    case "use":
      cmdUse(args);
      break;
    case "next":
      cmdNext();
      break;
    case "prev":
      cmdPrev();
      break;
    case "email":
      cmdSetEmail(args);
      break;
    case "mark":
      cmdMark(args);
      break;
    case "disable":
      cmdDisable(args);
      break;
    case "enable":
      cmdEnable(args);
      break;
    case "check":
      await cmdCheck(args);
      break;
    case "proxy":
      cmdProxy(args);
      break;
    case "on":
      cmdTakeover("on");
      break;
    case "off":
      cmdTakeover("off");
      break;
    case "sessions":
    case "skills":
    case "config":
    case "history":
    case "pets":
    case "archived_sessions":
    case "agent":
      cmdShared(cmd, args);
      break;
    case "login":
      await cmdLogin(args);
      break;
    case "run":
      {
        const forwarded = args[0] === "--" ? args.slice(1) : args;
        const state = loadState();
        await runCodex(forwarded, { proxy: shouldUseProxyForArgs(forwarded, state) });
      }
      break;
    case "setup":
      cmdInstallShim();
      break;
    case "doctor":
      cmdDoctor();
      break;
    case "version":
    case "--version":
    case "-v":
      console.log(VERSION);
      break;
    case "help":
    case "--help":
    case "-h":
    case "":
      printHelp();
      break;
    default:
      abort(`未知命令：${cmd}`);
  }
}

main().catch((error) => abort(error instanceof Error ? error.message : String(error)));
