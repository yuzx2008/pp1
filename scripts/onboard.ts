#!/usr/bin/env -S deno run -A
/**
 * pp1 onboard — prepare the all-in-one pp stack.
 *
 *   deno run -A scripts/onboard.ts all        # doctor + fetch + env + build
 *   deno run -A scripts/onboard.ts doctor     # check docker / GPU / disk
 *   deno run -A scripts/onboard.ts fetch      # clone components, download weights
 *   deno run -A scripts/onboard.ts env        # write/update .env
 *   deno run -A scripts/onboard.ts build      # build images
 *   deno run -A scripts/onboard.ts up         # docker compose up -d
 *   deno run -A scripts/onboard.ts smoke      # end-to-end checks
 *
 * Everything it downloads is public; nothing is uploaded anywhere.
 */

import * as NM from "https://github.com/thautwarm/nomake/raw/v0.1.12/mod.ts";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

const VERSION = "0.1.0";

// ── pinned components ─────────────────────────────────────────────────────────
// Bump these two SHAs together with the code, not at runtime.
const COMPONENTS = {
  tts: {
    dir: "moss-tts-windowed",
    repo: "https://github.com/thautwarm/moss-tts-windowed.git",
    ref: "26304ca4e4f0acdb8d96ae00a9940b4b644f9be9",
  },
  brain: {
    dir: "pp-brain-server",
    repo: "https://github.com/thautwarm/pp-brain-server.git",
    ref: "37682aaf9a93235f463e8bb5ba5ae8d620d9e06b",
  },
};

// ── model sources (all public) ────────────────────────────────────────────────
const TTS_REPO = "thaut/moss-tts-windowed-gguf";
const TTS_MODELS = [
  {
    file: "moss_tts_v15_firstclass_q4_k_m_aq8.gguf",
    size: 5334385280,
    sha256: "2805b9889f63e2f8aa681361b2b1127b101d9c64610918b26fca488d44a0a2a6",
  },
  {
    file: "moss_tts_audio_decoder_f16.gguf",
    size: 1775741728,
    sha256: "84034fa745ee38bc0bacfde5904e19c2db3fb402e5fe079c655550b1f9b189c4",
  },
  {
    file: "moss_tts_audio_encoder_f16.gguf",
    size: 1776008768,
    sha256: "8ca93e721ac95a56a64661b1fddfd990a8054abec58ac522a0103b8923902b46",
  },
];

const ASR_REPO = "Qwen/Qwen3-ASR-1.7B";
const ASR_DIR = "Qwen3-ASR-1.7B";

// ── small utilities ───────────────────────────────────────────────────────────
const tty = Deno.stdout.isTerminal();
const enc = new TextEncoder();

const paint = {
  dim: (s: string) => (tty ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (tty ? `\x1b[1m${s}\x1b[0m` : s),
  green: (s: string) => (tty ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s: string) => (tty ? `\x1b[33m${s}\x1b[0m` : s),
  red: (s: string) => (tty ? `\x1b[31m${s}\x1b[0m` : s),
};

function info(msg: string): void {
  console.log(`[pp1] ${msg}`);
}
function ok(msg: string): void {
  console.log(`  ${paint.green("✓")} ${msg}`);
}
function warn(msg: string): void {
  console.log(`  ${paint.yellow("!")} ${msg}`);
}
function step(msg: string): void {
  console.log(`\n${paint.bold(`== ${msg} ==`)}`);
}
function die(msg: string): never {
  console.error(`\n${paint.red("✗")} ${msg}`);
  Deno.exit(1);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const msgOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  }
}

function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i >= 3 ? 2 : 1)} ${units[i]}`;
}

// ── process helpers ───────────────────────────────────────────────────────────
interface RunOpts {
  cwd?: string;
  env?: Record<string, string>;
  stream?: boolean;
  allowFail?: boolean;
}

async function run(cmd: string[], opts: RunOpts = {}): Promise<string> {
  const command = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd: opts.cwd,
    env: opts.env,
    stdin: "null",
    stdout: opts.stream ? "inherit" : "piped",
    stderr: opts.stream ? "inherit" : "piped",
  });

  // `.output()` only works with piped streams; streamed commands use spawn().
  if (opts.stream) {
    const status = await command.spawn().status;
    if (status.code !== 0 && !opts.allowFail) {
      throw new Error(`${cmd.join(" ")} 失败（exit ${status.code}）`);
    }
    return "";
  }

  const out = await command.output();
  const stdout = new TextDecoder().decode(out.stdout);
  const stderr = new TextDecoder().decode(out.stderr);
  if (out.code !== 0 && !opts.allowFail) {
    throw new Error(
      `${cmd.join(" ")} 失败（exit ${out.code}）` +
        (stderr.trim() ? `\n${stderr.trim().split("\n").slice(-25).join("\n")}` : ""),
    );
  }
  return stdout;
}

async function capture(cmd: string[], opts: RunOpts = {}): Promise<string> {
  return (await run(cmd, opts)).trim();
}

async function commandExists(cmd: string): Promise<boolean> {
  try {
    await new Deno.Command(cmd, {
      args: ["--version"],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).output();
    return true;
  } catch {
    return false;
  }
}

// ── detection ─────────────────────────────────────────────────────────────────
interface Gpu {
  present: boolean;
  name?: string;
  cc?: string;
  memMiB?: number;
}

interface Diag {
  ok: boolean;
  gpu: Gpu;
  docker?: string;
  compose?: string;
  gpuRuntime?: boolean;
  freeGiB?: number;
}

async function detectGpu(): Promise<Gpu> {
  try {
    const out = await capture([
      "nvidia-smi",
      "--query-gpu=name,compute_cap,memory.total",
      "--format=csv,noheader,nounits",
    ]);
    const line = out.split("\n").map((s) => s.trim()).filter(Boolean)[0];
    if (!line) return { present: false };
    const [name, cc, mem] = line.split(",").map((s) => s.trim());
    return { present: true, name, cc, memMiB: Number(mem) || undefined };
  } catch {
    return { present: false };
  }
}

/** How many resident TTS daemons fit next to the ASR model. */
function daemonsFor(memMiB?: number): number {
  if (!memMiB) return 1;
  const usable = memMiB - 7000; // ASR (~5 GB), CUDA contexts, driver
  return Math.max(1, Math.min(3, Math.floor(usable / 7000)));
}

async function freeGiB(path: string): Promise<number | undefined> {
  if (Deno.build.os === "windows") return undefined;
  try {
    const out = await capture(["df", "-Pk", path]);
    const line = out.split("\n")[1];
    if (!line) return undefined;
    const kb = Number(line.split(/\s+/)[3]);
    if (!Number.isFinite(kb)) return undefined;
    return Math.round((kb / 1024 / 1024) * 10) / 10;
  } catch {
    return undefined;
  }
}

// ── downloads ─────────────────────────────────────────────────────────────────
async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  const file = await Deno.open(path, { read: true });
  const buf = new Uint8Array(1 << 20);
  try {
    while (true) {
      const n = await file.read(buf);
      if (n === null) break;
      hash.update(buf.subarray(0, n));
    }
  } finally {
    file.close();
  }
  return hash.digest("hex");
}

function progressLine(name: string, done: number, total: number, rate: number): void {
  const pct = total > 0 ? `${((done / total) * 100).toFixed(1)}%` : "";
  const line = `  ${name}  ${pct}  ${humanBytes(done)}${total > 0 ? "/" + humanBytes(total) : ""}  ${humanBytes(rate)}/s`;
  Deno.stdout.writeSync(enc.encode(`\r${line.padEnd(76).slice(0, 76)}`));
}

async function fetchToFile(part: string, url: string, expectedSize: number): Promise<void> {
  let offset = (await exists(part)) ? (await Deno.stat(part)).size : 0;
  if (expectedSize > 0 && offset > expectedSize) {
    await Deno.remove(part);
    offset = 0;
  }

  const headers: Record<string, string> = { "user-agent": `pp1/${VERSION}` };
  if (offset > 0) headers["range"] = `bytes=${offset}-`;

  const res = await fetch(url, {
    headers,
    redirect: "follow",
    // The signal covers the whole body; keep it generous (slow links, big files).
    signal: AbortSignal.timeout(6 * 60 * 60 * 1000),
  });
  if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}：${url}`);
  if (offset > 0 && res.status !== 206) {
    // server ignored the range request — restart from zero
    offset = 0;
    await Deno.remove(part).catch(() => {});
  }

  const total = expectedSize > 0
    ? expectedSize
    : offset + Number(res.headers.get("content-length") ?? 0);
  const name = basename(part).replace(/\.part$/, "");

  if (!tty) console.log(`  下载 ${name} ...`);
  const file = await Deno.open(part, {
    write: true,
    create: true,
    append: offset > 0,
    truncate: offset === 0,
  });
  let done = offset;
  let lastPrint = 0;
  const t0 = Date.now();
  try {
    for await (const chunk of res.body!) {
      await file.write(chunk);
      done += chunk.length;
      const now = Date.now();
      if (tty && now - lastPrint > 400) {
        lastPrint = now;
        const secs = (now - t0) / 1000;
        progressLine(name, done, total, secs > 0 ? (done - offset) / secs : 0);
      }
    }
  } finally {
    file.close();
    if (tty) Deno.stdout.writeSync(enc.encode("\n"));
  }
}

async function downloadFile(
  url: string,
  dest: string,
  sha256 = "",
  size = 0,
  force = false,
): Promise<void> {
  await Deno.mkdir(dirname(dest), { recursive: true });

  if (!force && (await exists(dest))) {
    const st = await Deno.stat(dest);
    const sizeOk = size <= 0 || st.size === size;
    const hashOk = !sha256 || (await sha256File(dest)) === sha256;
    if (sizeOk && hashOk) {
      ok(`${basename(dest)} 已存在（${humanBytes(st.size)}）`);
      return;
    }
    warn(`${basename(dest)} 不完整或校验失败，重新下载`);
    await Deno.remove(dest);
  }

  const part = `${dest}.part`;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await fetchToFile(part, url, size);
      lastErr = undefined;
      break;
    } catch (e) {
      lastErr = e;
      warn(`下载中断（第 ${attempt}/3 次）：${msgOf(e)}`);
      await sleep(1500 * attempt);
    }
  }
  if (lastErr) throw lastErr;

  const st = await Deno.stat(part);
  if (size > 0 && st.size !== size) {
    await Deno.remove(part).catch(() => {});
    throw new Error(`大小不匹配：${basename(dest)} ${st.size} != ${size}`);
  }
  if (sha256) {
    const got = await sha256File(part);
    if (got !== sha256) {
      await Deno.remove(part).catch(() => {});
      throw new Error(`sha256 不匹配：${basename(dest)}\n  got  ${got}\n  want ${sha256}`);
    }
  }
  await Deno.rename(part, dest);
  ok(`${basename(dest)}（${humanBytes(st.size)}）`);
}

async function getJson(url: string, tries = 3): Promise<any> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { "user-agent": `pp1/${VERSION}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}：${url}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      await sleep(1000 * (i + 1));
    }
  }
  throw lastErr;
}

function encodePath(path: string): string {
  return path.split("/").map((s) => encodeURIComponent(s)).join("/");
}

/** Download a whole model snapshot from ModelScope (fast in CN) or HuggingFace. */
async function downloadSnapshot(repo: string, dest: string, o: Opts): Promise<void> {
  const order: ("ms" | "hf")[] = o.source === "hf"
    ? ["hf"]
    : o.source === "modelscope"
    ? ["ms"]
    : ["ms", "hf"];
  let lastErr: unknown;
  for (const kind of order) {
    try {
      if (kind === "ms") {
        const api =
          `https://modelscope.cn/api/v1/models/${repo}/repo/files?Revision=master&Recursive=true`;
        const data = await getJson(api);
        const files = (data?.Data?.Files ?? []).filter((f: any) => f.Type === "blob");
        if (files.length === 0) throw new Error("ModelScope 返回空文件列表");
        for (const f of files) {
          if (f.Path === ".gitattributes") continue;
          await downloadFile(
            `https://modelscope.cn/models/${repo}/resolve/master/${encodePath(f.Path)}`,
            join(dest, f.Path),
            String(f.Sha256 ?? "").toLowerCase(),
            Number(f.Size ?? 0),
            o.force,
          );
        }
      } else {
        const endpoint = (o.hfEndpoint ?? Deno.env.get("HF_ENDPOINT") ??
          "https://huggingface.co").replace(/\/+$/, "");
        const files = await getJson(`${endpoint}/api/models/${repo}/tree/main?recursive=true`);
        if (!Array.isArray(files) || files.length === 0) throw new Error("HuggingFace 返回空文件列表");
        for (const f of files) {
          if (f.type !== "file" || f.path === ".gitattributes") continue;
          const sha = String(f.lfs?.oid ?? "").replace(/^sha256:/, "");
          await downloadFile(
            `${endpoint}/${repo}/resolve/main/${encodePath(f.path)}`,
            join(dest, f.path),
            sha,
            Number(f.size ?? 0),
            o.force,
          );
        }
      }
      return;
    } catch (e) {
      lastErr = e;
      warn(`${kind === "ms" ? "ModelScope" : "HuggingFace"} 失败：${msgOf(e)}`);
    }
  }
  throw lastErr ?? new Error(`无法下载 ${repo}`);
}

// ── git ───────────────────────────────────────────────────────────────────────
async function ensureRepo(dir: string, repo: string, ref: string, force: boolean): Promise<void> {
  if (force && (await exists(dir))) await Deno.remove(dir, { recursive: true });
  await Deno.mkdir(dir, { recursive: true });

  if (!(await exists(join(dir, ".git")))) {
    await run(["git", "init", "-q"], { cwd: dir });
    await run(["git", "remote", "add", "origin", repo], { cwd: dir });
  } else {
    await run(["git", "remote", "set-url", "origin", repo], { cwd: dir });
  }

  try {
    await run(["git", "-C", dir, "fetch", "-q", "--depth", "1", "origin", ref]);
  } catch {
    warn(`按提交 ${ref.slice(0, 12)} 拉取失败，改拉 main`);
    await run(["git", "-C", dir, "fetch", "-q", "--depth", "1", "origin", "main"]);
  }
  await run(["git", "-C", dir, "reset", "-q", "--hard", "FETCH_HEAD"]);
  const head = await capture(["git", "-C", dir, "log", "-1", "--format=%h %s"]);
  ok(`${basename(dir)} @ ${head}`);
}

// ── .env ──────────────────────────────────────────────────────────────────────
async function readEnvFile(path: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const text = await Deno.readTextFile(path);
    for (const line of text.split(/\r?\n/)) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
      if (m) map.set(m[1], m[2].trim());
    }
  } catch {
    // no .env yet
  }
  return map;
}

async function writeEnvFile(
  path: string,
  values: Record<string, string>,
  remove: string[] = [],
): Promise<void> {
  let text = "";
  try {
    text = await Deno.readTextFile(path);
  } catch {
    // first run
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (m && remove.includes(m[1])) continue;
    if (m && values[m[1]] !== undefined) {
      if (!seen.has(m[1])) {
        out.push(`${m[1]}=${values[m[1]]}`);
        seen.add(m[1]);
      }
      continue;
    }
    out.push(line);
  }
  if (!out[0]?.includes("pp1")) {
    out.unshift("# pp1 runtime config — generated by `pp1 onboard env`, safe to edit");
  }
  for (const [k, v] of Object.entries(values)) {
    if (!seen.has(k)) out.push(`${k}=${v}`);
  }
  while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
  await Deno.writeTextFile(path, out.join("\n") + "\n");
  if (Deno.build.os !== "windows") {
    try {
      await Deno.chmod(path, 0o600);
    } catch {
      // best effort
    }
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────────
interface Opts {
  targets: string[];
  root: string;
  dir?: string;
  ports: { tts?: number; stt?: number; brain?: number };
  daemons?: number;
  chat: { baseUrl?: string; apiKey?: string; model?: string };
  hfEndpoint?: string;
  source: "auto" | "hf" | "modelscope";
  jobs?: number;
  force: boolean;
  skipBuild: boolean;
  skipModels: boolean;
}

function parseArgs(argv: string[]): Opts {
  const o: Opts = {
    targets: [],
    root: Deno.cwd(),
    ports: {},
    chat: {},
    source: "auto",
    force: false,
    skipBuild: false,
    skipModels: false,
  };

  const valueFlags = new Set([
    "--dir",
    "--tts-port",
    "--stt-port",
    "--brain-port",
    "--daemons",
    "--chat-base-url",
    "--chat-api-key",
    "--chat-model",
    "--hf-endpoint",
    "--source",
    "--jobs",
  ]);

  const setValue = (flag: string, value: string) => {
    switch (flag) {
      case "--dir":
        o.dir = value;
        break;
      case "--tts-port":
        o.ports.tts = Number(value);
        break;
      case "--stt-port":
        o.ports.stt = Number(value);
        break;
      case "--brain-port":
        o.ports.brain = Number(value);
        break;
      case "--daemons":
        o.daemons = Number(value);
        break;
      case "--chat-base-url":
        o.chat.baseUrl = value;
        break;
      case "--chat-api-key":
        o.chat.apiKey = value;
        break;
      case "--chat-model":
        o.chat.model = value;
        break;
      case "--hf-endpoint":
        o.hfEndpoint = value;
        break;
      case "--source":
        if (value !== "auto" && value !== "hf" && value !== "modelscope") {
          die(`--source 只能是 auto / hf / modelscope（收到 ${value}）`);
        }
        o.source = value;
        break;
      case "--jobs":
        o.jobs = Number(value);
        break;
    }
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      o.targets.push("usage");
      continue;
    }
    if (arg === "--force") {
      o.force = true;
      continue;
    }
    if (arg === "--skip-build") {
      o.skipBuild = true;
      continue;
    }
    if (arg === "--skip-models") {
      o.skipModels = true;
      continue;
    }
    if (arg.startsWith("--") && arg.includes("=")) {
      const [flag, ...rest] = arg.split("=");
      if (!valueFlags.has(flag)) die(`未知参数 ${flag}`);
      setValue(flag, rest.join("="));
      continue;
    }
    if (valueFlags.has(arg)) {
      const value = argv[++i];
      if (value === undefined) die(`${arg} 需要一个值`);
      setValue(arg, value);
      continue;
    }
    if (arg.startsWith("-")) die(`未知参数 ${arg}`);
    o.targets.push(arg);
  }

  return o;
}

const HELP = `pp1 ${VERSION} — all-in-one voice-assistant stack

用法:
  pp1-setup [targets] [options]
  deno run -A scripts/onboard.ts [targets] [options]

targets（nomake 依赖图；\`pp1-setup help\` 列出全部 target）:
  all          doctor + components + models + images + .env（默认）
  doctor       docker / GPU / 磁盘检查
  components   拉取/更新 .components/ 下的组件
  models       下载 TTS / ASR 权重
  images       构建 pp1/asr、pp1/brain、pp1/tts
  .env         生成/更新 .env
  fetch        components + models
  build        images
  up / down    docker compose 起停
  status       容器 + HTTP 探活
  smoke        TTS / ASR / brain 端到端
  dist         编译 pp1-setup-{os}-{arch}
  version      版本
  usage        这个帮助

options:
  --dir <path>            仓库根目录（默认当前目录）
  --tts-port <n>          TTS 对外端口（默认 6677）
  --stt-port <n>          ASR 对外端口（默认 8082）
  --brain-port <n>        brain 对外端口（默认 8787）
  --daemons <n>           TTS 常驻 daemon 数（默认按显存算）
  --chat-base-url <url>   brain 的 chat 端点（必填，须原生支持音频输入）
  --chat-api-key <key>    chat 端点的 key（无鉴权就随便填，默认 none）
  --chat-model <name>     chat 模型名（不填则沿用 .env / brain 默认）
  --hf-endpoint <url>     HuggingFace 镜像（如 https://hf-mirror.com）
  --source <auto|hf|modelscope>   ASR 模型来源（默认 auto：先 ModelScope）
  --jobs <n>              TTS 编译并行度
  --force                 重新下载/重新克隆
  --skip-models           跳过模型下载
  --skip-build            跳过镜像构建
`;

// ── commands ──────────────────────────────────────────────────────────────────
async function resolveRoot(dir: string): Promise<string> {
  const root = resolve(dir);
  const looksRight = (await exists(join(root, "docker-compose.yml"))) &&
    (await exists(join(root, "docker/asr/Dockerfile")));
  if (!looksRight) {
    die(
      `这里不是 pp1 仓库根目录：${root}\n` +
        `请先 git clone https://github.com/thautwarm/pp1 && cd pp1，或用 --dir 指定。`,
    );
  }
  return root;
}

async function cmdDoctor(o: Opts): Promise<Diag> {
  step("环境检查");

  const docker = (await commandExists("docker"))
    ? (await capture(["docker", "version", "--format", "{{.Server.Version}}"], { allowFail: true }))
    : "";
  if (docker) ok(`docker ${docker}`);
  else warn("找不到 docker（或 daemon 没启动）");

  let compose = "";
  if (docker) {
    compose = await capture(["docker", "compose", "version", "--short"], { allowFail: true });
    if (compose) ok(`compose ${compose}`);
    else warn("缺少 docker compose 插件");
  }

  if (await commandExists("git")) ok("git"); else warn("找不到 git");

  const gpu = await detectGpu();
  if (gpu.present) {
    ok(`GPU ${gpu.name}`);
    ok(
      `compute cap ${gpu.cc}${
        gpu.cc ? paint.dim(`  (CUDA_ARCH=${gpu.cc.replace(".", "")})`) : ""
      }`,
    );
    if (gpu.memMiB) ok(`VRAM ${(gpu.memMiB / 1024).toFixed(1)} GiB → MOSS_DAEMONS=${daemonsFor(gpu.memMiB)}`);
  } else {
    warn("找不到 nvidia-smi —— TTS/ASR 都需要 NVIDIA GPU");
  }

  let gpuRuntime = false;
  if (docker) {
    const runtimes = await capture(["docker", "info", "--format", "{{json .Runtimes}}"], {
      allowFail: true,
    });
    gpuRuntime = runtimes.includes("nvidia");
    if (gpuRuntime) ok("NVIDIA container runtime");
    else warn("docker 没有 nvidia runtime（装 nvidia-container-toolkit 后重启 docker）");
  }

  const free = await freeGiB(o.root);
  if (free !== undefined) {
    const need = 35;
    if (free >= need) ok(`磁盘剩余 ${free} GiB`);
    else warn(`磁盘只剩 ${free} GiB，建议 ≥ ${need} GiB（模型 ~14 GB + 镜像 ~20 GB）`);
  }

  if (Deno.build.os === "windows" && !(await commandExists("bash"))) {
    warn("Windows 上构建 TTS 需要 bash（WSL 或 Git Bash）");
  }

  return {
    ok: Boolean(docker && compose && gpu.present),
    gpu,
    docker,
    compose,
    gpuRuntime,
    freeGiB: free,
  };
}

async function fetchComponents(o: Opts): Promise<void> {
  step("组件源码");
  const components = join(o.root, ".components");
  await ensureRepo(
    join(components, COMPONENTS.tts.dir),
    COMPONENTS.tts.repo,
    COMPONENTS.tts.ref,
    o.force,
  );
  await ensureRepo(
    join(components, COMPONENTS.brain.dir),
    COMPONENTS.brain.repo,
    COMPONENTS.brain.ref,
    o.force,
  );
}

async function cmdEnv(o: Opts, gpu: Gpu): Promise<void> {
  step("生成 .env");
  const path = join(o.root, ".env");
  const existing = await readEnvFile(path);
  const pick = (key: string, fallback: string) => existing.get(key) ?? fallback;

  // The brain's revision pass sends recent audio as `input_audio` parts, so its
  // chat endpoint must natively accept audio. pp1 does not bundle one: which
  // model/API to use is a deployment decision (the brain itself is model-agnostic).
  const chatBase = o.chat.baseUrl || existing.get("MIGHT_CHAT_API_BASE_URL") || "";
  if (!chatBase || chatBase.startsWith("http://chat:")) {
    die(
      "缺少 chat 端点。brain 的 revise 会把最近几条音频以 input_audio 发给它，\n" +
        "所以必须是一个原生支持音频输入的 OpenAI 兼容端点（纯文本模型不行）。\n" +
        "\n" +
        "  例：pp1-setup env --chat-base-url https://api.example.com/v1 \\\n" +
        "        --chat-api-key sk-... --chat-model qwen-omni\n" +
        "\n" +
        "  可用的部署：Qwen2.5-Omni / Voxtral / Gemini / GPT-4o-audio 等，\n" +
        "  或你自己的 vLLM/SGLang 音频模型端点。",
    );
  }
  const chatKey = o.chat.apiKey || pick("MIGHT_CHAT_API_KEY", "") || "none";
  const chatModel = o.chat.model ?? existing.get("MIGHT_CHAT_MODEL");
  if (!o.chat.apiKey && !pick("MIGHT_CHAT_API_KEY", "")) {
    warn("chat 端点没有 key：已写入占位值 `none`（brain 要求非空；不鉴权的服务随便给）");
  }

  const uid = Deno.build.os === "windows" ? "1000" : String(Deno.uid() ?? 1000);
  const gid = Deno.build.os === "windows" ? "1000" : String(Deno.gid() ?? 1000);
  const daemons = String(
    o.daemons ??
      (Number(pick("MOSS_DAEMONS", "0")) || daemonsFor(gpu.memMiB)),
  );

  const values: Record<string, string> = {
    // ports
    "PP1_TTS_PORT": String(o.ports.tts ?? pick("PP1_TTS_PORT", "6677")),
    "PP1_STT_PORT": String(o.ports.stt ?? pick("PP1_STT_PORT", "8082")),
    "PP1_BRAIN_PORT": String(o.ports.brain ?? pick("PP1_BRAIN_PORT", "8787")),

    // images
    "PP1_TTS_IMAGE": pick("PP1_TTS_IMAGE", "pp1/tts:latest"),
    "PP1_ASR_IMAGE": pick("PP1_ASR_IMAGE", "pp1/asr:latest"),
    "PP1_BRAIN_IMAGE": pick("PP1_BRAIN_IMAGE", "pp1/brain:latest"),

    // TTS (moss-tts-windowed) — tuning knobs keep whatever is already in .env
    "MOSS_UID": uid,
    "MOSS_GID": gid,
    "MOSS_MODELS_HOST": "./models/tts",
    "MOSS_MODEL_FILE": pick("MOSS_MODEL_FILE", "moss_tts_v15_firstclass_q4_k_m_aq8.gguf"),
    "MOSS_DECODER_FILE": pick("MOSS_DECODER_FILE", "moss_tts_audio_decoder_f16.gguf"),
    "MOSS_DAEMONS": daemons,
    "MOSS_LANGUAGE": pick("MOSS_LANGUAGE", "zh"),
    "MOSS_AUDIO_TEMPERATURE": pick("MOSS_AUDIO_TEMPERATURE", "1.7"),
    "MOSS_AUDIO_TOP_P": pick("MOSS_AUDIO_TOP_P", "0.8"),
    "MOSS_AUDIO_TOP_K": pick("MOSS_AUDIO_TOP_K", "25"),
    "MOSS_AUDIO_REPETITION_PENALTY": pick("MOSS_AUDIO_REPETITION_PENALTY", "1.0"),
    "MOSS_STREAM_WINDOW": pick("MOSS_STREAM_WINDOW", "32"),
    "MOSS_STREAM_OVERLAP": pick("MOSS_STREAM_OVERLAP", "40"),
    "MOSS_CTX_ROWS": pick("MOSS_CTX_ROWS", "6000"),
    "MOSS_CTX_KEEP": pick("MOSS_CTX_KEEP", "2048"),
    "MOSS_PREFILL_UBATCH": pick("MOSS_PREFILL_UBATCH", "384"),
    "MOSS_PREFILL_BUDGET_MIB": pick("MOSS_PREFILL_BUDGET_MIB", "1000"),
    "MOSS_MAX_INPUT_CHARS": pick("MOSS_MAX_INPUT_CHARS", "2048"),
    "MOSS_QUEUE_MAX": pick("MOSS_QUEUE_MAX", "8"),
    "MOSS_QUEUE_WAIT": pick("MOSS_QUEUE_WAIT", "60"),
    "MOSS_LOG_TEXT": pick("MOSS_LOG_TEXT", "0"),
    "MOSS_DISABLE_NONSTREAM": pick("MOSS_DISABLE_NONSTREAM", "1"),

    // ASR
    "STT_API_BASE_URL": "http://asr:8082/v1",
    "STT_API_KEY": pick("STT_API_KEY", ""),
    "STT_MODEL": pick("STT_MODEL", "qwen-asr"),

    // TTS endpoint + default voice
    "TTS_API_BASE_URL": "http://tts:8080/v1",
    "TTS_API_KEY": pick("TTS_API_KEY", ""),
    "TTS_VOICE": pick("TTS_VOICE", "male-fun"),

    // brain
    "MIGHT_CHAT_API_BASE_URL": chatBase,
    "MIGHT_CHAT_API_KEY": chatKey,
    ...(chatModel ? { "MIGHT_CHAT_MODEL": chatModel } : {}),
    "MIGHT_BRAINS_TOKEN": pick("MIGHT_BRAINS_TOKEN", ""),
    "MIGHT_BRAINS_PORT": "8787",
    "MIGHT_BRAINS_POLL_TIMEOUT_MS": pick("MIGHT_BRAINS_POLL_TIMEOUT_MS", "25000"),
  };

  await writeEnvFile(path, values, [
    // keys from the old "bundled chat model" layout
    "COMPOSE_PROFILES",
    "PP1_CHAT_PORT",
    "PP1_CHAT_IMAGE",
    "PP1_CHAT_GGUF",
    "PP1_CHAT_BRIDGE_IMAGE",
  ]);
  ok(`.env（daemons ${daemons}）`);

  // Bind mounts must exist and be owned by the invoking user: the TTS container
  // runs as MOSS_UID/GID and writes its unix socket and logs there.
  for (const dir of ["run", "logs/tts", "logs/brains"]) {
    await Deno.mkdir(join(o.root, dir), { recursive: true });
  }
}

async function buildTts(o: Opts, gpu: Gpu): Promise<void> {
  const dir = join(o.root, ".components", COMPONENTS.tts.dir);
  if (!(await exists(dir))) throw new Error("缺少 TTS 源码，先跑 pp1 fetch");

  if (Deno.build.os === "windows" && !(await commandExists("bash"))) {
    throw new Error("TTS 构建脚本是 bash：请在 WSL 里运行，或安装 Git Bash 并把它加进 PATH");
  }

  const env: Record<string, string> = { IMAGE: "pp1/tts:latest" };
  if (gpu.cc) env.CUDA_ARCH = gpu.cc.replace(".", "");
  if (o.jobs) env.JOBS = String(o.jobs);

  for (const script of [
    "fetch-ffmpeg.sh",
    "fetch-llama-cpp.sh",
    "build-base.sh",
    "build-llama.sh",
    "build-image.sh",
  ]) {
    info(`bash scripts/${script}`);
    await run(["bash", `scripts/${script}`], { cwd: dir, env, stream: true });
  }
}

async function buildAsrImage(o: Opts): Promise<void> {
  step("ASR 镜像（首次 ~10 分钟）");
  await run(["docker", "build", "-t", "pp1/asr:latest", join(o.root, "docker/asr")], {
    stream: true,
  });
}

async function buildBrainImage(o: Opts): Promise<void> {
  step("brain 镜像");
  const brainDir = join(o.root, ".components", COMPONENTS.brain.dir);
  if (!(await exists(brainDir))) throw new Error("缺少 brain 源码，先跑 pp1 components");
  await run(
    ["docker", "build", "-f", "Dockerfile.brains", "-t", "pp1/brain:latest", "."],
    { cwd: brainDir, stream: true },
  );
}

async function cmdUp(o: Opts): Promise<void> {
  step("启动");
  for (const dir of ["run", "logs/tts", "logs/brains"]) {
    await Deno.mkdir(join(o.root, dir), { recursive: true });
  }
  await run(["docker", "compose", "up", "-d"], { cwd: o.root, stream: true });
  ok("已启动；端口见 .env（PP1_*_PORT）");
}

async function cmdDown(o: Opts): Promise<void> {
  await run(["docker", "compose", "down"], { cwd: o.root, stream: true });
}

async function cmdStatus(o: Opts): Promise<void> {
  await run(["docker", "compose", "ps"], { cwd: o.root, stream: true });

  const env = await readEnvFile(join(o.root, ".env"));
  const probes: [string, number, string][] = [
    ["TTS", Number(env.get("PP1_TTS_PORT") ?? 6677), "/health"],
    ["ASR", Number(env.get("PP1_STT_PORT") ?? 8082), "/health"],
    ["brain", Number(env.get("PP1_BRAIN_PORT") ?? 8787), "/"],
  ];
  for (const [name, port, path] of probes) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        signal: AbortSignal.timeout(5000),
      });
      ok(`${name} :${port} → HTTP ${res.status}`);
    } catch (e) {
      warn(`${name} :${port} 无响应（${msgOf(e)}）`);
    }
  }
}

async function waitHttp(name: string, url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.status < 500) {
        ok(`${name} 就绪（HTTP ${res.status}）`);
        return;
      }
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = msgOf(e);
    }
    await sleep(2000);
  }
  throw new Error(`${name} 在 ${Math.round(timeoutMs / 1000)}s 内没有就绪（${last}）`);
}

async function cmdSmoke(o: Opts): Promise<void> {
  step("冒烟测试");
  const env = await readEnvFile(join(o.root, ".env"));
  const ttsPort = Number(env.get("PP1_TTS_PORT") ?? 6677);
  const sttPort = Number(env.get("PP1_STT_PORT") ?? 8082);
  const brainPort = Number(env.get("PP1_BRAIN_PORT") ?? 8787);
  const voice = env.get("TTS_VOICE") || "male-fun";

  await waitHttp("TTS", `http://127.0.0.1:${ttsPort}/health`, 180_000);
  await waitHttp("ASR", `http://127.0.0.1:${sttPort}/health`, 180_000);
  await waitHttp("brain", `http://127.0.0.1:${brainPort}/`, 60_000);

  // 1. TTS: synthesize a short sentence, expect an Ogg/Opus stream.
  const t0 = Date.now();
  const tts = await fetch(`http://127.0.0.1:${ttsPort}/v1/audio/speech/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "你好，世界。", voice, audio_format: "opus" }),
    signal: AbortSignal.timeout(180_000),
  });
  const audio = new Uint8Array(await tts.arrayBuffer());
  if (!tts.ok) throw new Error(`TTS ${tts.status}: ${new TextDecoder().decode(audio)}`);
  const ogg = audio.length > 4 && new TextDecoder().decode(audio.slice(0, 4)) === "OggS";
  ok(
    `TTS ${humanBytes(audio.length)}，${ogg ? "Ogg/Opus" : "非 Ogg"}，${
      ((Date.now() - t0) / 1000).toFixed(2)
    } s`,
  );
  if (!ogg) throw new Error("TTS 返回的不是 Ogg/Opus");

  // 2. ASR: transcribe the demo voice reference.
  const wavPath = join(o.root, "voices", "male-fun.wav");
  if (await exists(wavPath)) {
    const wav = await Deno.readFile(wavPath);
    const form = new FormData();
    form.append("file", new Blob([wav], { type: "audio/wav" }), "male-fun.wav");
    form.append("model", "qwen-asr");
    const stt = await fetch(`http://127.0.0.1:${sttPort}/v1/audio/transcriptions`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(180_000),
    });
    const text = await stt.text();
    if (!stt.ok) throw new Error(`ASR ${stt.status}: ${text}`);
    const parsed = JSON.parse(text) as { text?: string };
    if (!parsed.text) throw new Error("ASR 返回空文本");
    ok(`ASR “${parsed.text.slice(0, 60)}${parsed.text.length > 60 ? "…" : ""}”`);
  } else {
    warn("没有 voices/male-fun.wav，跳过 ASR 测试");
  }

  // 3. brain: the agent-side write endpoint.
  const brain = await fetch(`http://127.0.0.1:${brainPort}/agent-to-brain`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ brain_id: "hw", text: "hello from pp1 smoke test" }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!brain.ok) throw new Error(`brain ${brain.status}: ${await brain.text()}`);
  ok(`brain /agent-to-brain → ${(await brain.text()).trim()}`);

  console.log(`\n${paint.green("全部通过")}`);
}

// ── main ──────────────────────────────────────────────────────────────────────
/** Record that a non-file artifact (component checkout, image) is up to date. */
async function markStamp(path: string): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, `${new Date().toISOString()}\n`);
}

// ── nomake targets ────────────────────────────────────────────────────────────
//
// The setup is a dependency graph, not a sequence:
//
//   doctor ─┬─ components ─┐
//           ├─ models ─────┼─ images ─┐
//           └─ .env ───────┘          ├─ all
//                                     │
//   scripts/onboard.ts ── dist/pp1-setup-{os}-{arch} ── dist
//
// `all` is just the virtual target that pulls the four branches together, so a
// failed download or image build can be resumed with the same command.

const TARGETS = [
  ["x86_64-unknown-linux-gnu", "linux-x64"],
  ["aarch64-unknown-linux-gnu", "linux-arm64"],
  ["x86_64-apple-darwin", "darwin-x64"],
  ["aarch64-apple-darwin", "darwin-arm64"],
  ["x86_64-pc-windows-msvc", "windows-x64.exe"],
] as const;

function defineTargets(o: Opts, gpu: Gpu): void {
  const hf = (o.hfEndpoint ?? Deno.env.get("HF_ENDPOINT") ?? "https://huggingface.co")
    .replace(/\/+$/, "");

  NM.target({
    name: "doctor",
    virtual: true,
    rebuild: "always",
    doc: "check docker / GPU / disk",
    async build() {
      const d = await cmdDoctor(o);
      if (!d.ok) die("环境检查未通过（见上面的 ! 项）");
    },
  });

  // A stamp whose name contains the pinned refs: bumping a ref creates a new
  // target, so the checkout is refreshed exactly when the pin changes.
  const componentsStamp =
    `.stamps/components-${COMPONENTS.tts.ref.slice(0, 8)}-${COMPONENTS.brain.ref.slice(0, 8)}`;
  NM.target({
    name: componentsStamp,
    rebuild: o.force ? "always" : "never",
    doc: "clone/update the pinned component checkouts",
    deps: ["doctor"],
    async build() {
      await fetchComponents(o);
      await markStamp(componentsStamp);
    },
  });

  // Downloads are real file targets: `never` means "build only when missing",
  // which is exactly the cache we want. `--force` flips them to `always`, and
  // nomake then removes the file before rebuilding it.
  const ttsFiles = TTS_MODELS.map((m) => `models/tts/${m.file}`);
  TTS_MODELS.forEach((m) => {
    NM.target({
      name: `models/tts/${m.file}`,
      rebuild: o.force ? "always" : "never",
      doc: `download ${m.file}`,
      deps: ["doctor"],
      async build({ target }) {
        await downloadFile(
          `${hf}/${TTS_REPO}/resolve/main/${m.file}`,
          String(target),
          m.sha256,
          m.size,
          o.force,
        );
      },
    });
  });

  // The ASR snapshot is a directory, so it gets a stamp instead of a file target.
  const asrStamp = ".stamps/asr-model";
  NM.target({
    name: asrStamp,
    rebuild: o.force ? "always" : "never",
    doc: "download the Qwen3-ASR-1.7B snapshot",
    deps: ["doctor"],
    async build() {
      await downloadSnapshot(ASR_REPO, join(o.root, "models/asr", ASR_DIR), o);
      await markStamp(asrStamp);
    },
  });

  NM.target({
    name: "components",
    virtual: true,
    rebuild: "always",
    doc: "clone/update the pinned component checkouts",
    deps: [componentsStamp],
    build() {},
  });

  NM.target({
    name: "models",
    virtual: true,
    rebuild: "always",
    doc: "all model weights",
    deps: o.skipModels ? [] : [...ttsFiles, asrStamp],
    build() {
      if (o.skipModels) warn("--skip-models：跳过模型下载");
    },
  });

  // One stamp per image, keyed by the files that determine its contents.
  const asrImage = ".stamps/image-asr";
  NM.target({
    name: asrImage,
    rebuild: o.force ? "always" : "onChanged",
    doc: "build pp1/asr",
    deps: ["doctor", "docker/asr/Dockerfile", "docker/asr/server.py"],
    async build() {
      if (o.skipBuild) {
        warn("--skip-build：跳过镜像构建");
        return;
      }
      await buildAsrImage(o);
      await markStamp(asrImage);
    },
  });

  const brainImage = ".stamps/image-brain";
  NM.target({
    name: brainImage,
    rebuild: o.force ? "always" : "onChanged",
    doc: "build pp1/brain",
    deps: ["components", ".components/pp-brain-server/Dockerfile.brains"],
    async build() {
      if (o.skipBuild) {
        warn("--skip-build：跳过镜像构建");
        return;
      }
      await buildBrainImage(o);
      await markStamp(brainImage);
    },
  });

  const ttsImage = ".stamps/image-tts";
  NM.target({
    name: ttsImage,
    rebuild: o.force ? "always" : "onChanged",
    doc: "build pp1/tts",
    deps: [
      "components",
      "models",
      ".components/moss-tts-windowed/docker/Dockerfile",
      ".components/moss-tts-windowed/server.py",
    ],
    async build() {
      if (o.skipBuild) {
        warn("--skip-build：跳过镜像构建");
        return;
      }
      await buildTts(o, gpu);
      await markStamp(ttsImage);
    },
  });

  NM.target({
    name: "images",
    virtual: true,
    rebuild: "always",
    doc: "build pp1/asr, pp1/brain and pp1/tts",
    deps: [asrImage, brainImage, ttsImage],
    build() {},
  });

  NM.target({
    name: "env",
    virtual: true,
    rebuild: "always",
    doc: "write/refresh .env",
    deps: ["doctor"],
    async build() {
      await cmdEnv(o, gpu);
    },
  });

  for (const [triple, name] of TARGETS) {
    NM.target({
      name: `dist/pp1-setup-${name}`,
      doc: `deno compile for ${triple}`,
      deps: { source: "scripts/onboard.ts" },
      async build({ deps, target }) {
        await NM.Shell.runChecked(
          [
            Deno.execPath(),
            "compile",
            "--allow-all",
            "--target",
            triple,
            "--output",
            String(target),
            deps.source,
          ],
          { printCmd: true, logError: true },
        );
      },
    });
  }

  NM.target({
    name: "dist",
    virtual: true,
    rebuild: "always",
    doc: "cross-compile pp1-setup-{os}-{arch}",
    deps: TARGETS.map(([, name]) => `dist/pp1-setup-${name}`),
    build() {
      NM.Log.msg("binaries: dist/");
    },
  });

  NM.target({
    name: "fetch",
    virtual: true,
    rebuild: "always",
    doc: "components + models",
    deps: ["components", "models"],
    build() {},
  });

  NM.target({
    name: "build",
    virtual: true,
    rebuild: "always",
    doc: "images",
    deps: ["images"],
    build() {},
  });

  NM.target({
    name: "all",
    virtual: true,
    rebuild: "always",
    doc: "doctor + components + models + images + .env",
    deps: ["components", "models", "images", "env"],
    build() {
      console.log(`\n${paint.bold("下一步")}`);
      console.log("  docker compose up -d");
      console.log("  # 然后 pp1-setup status / pp1-setup smoke");
    },
  });

  NM.target({
    name: "up",
    virtual: true,
    rebuild: "always",
    doc: "docker compose up -d",
    deps: ["env"],
    build: () => cmdUp(o),
  });

  NM.target({
    name: "down",
    virtual: true,
    rebuild: "always",
    doc: "docker compose down",
    build: () => cmdDown(o),
  });

  NM.target({
    name: "status",
    virtual: true,
    rebuild: "always",
    doc: "container state + HTTP probes",
    build: () => cmdStatus(o),
  });

  NM.target({
    name: "smoke",
    virtual: true,
    rebuild: "always",
    doc: "end-to-end TTS / ASR / brain",
    build: () => cmdSmoke(o),
  });

  NM.target({
    name: "usage",
    virtual: true,
    rebuild: "always",
    doc: "show options and targets",
    build() {
      console.log(HELP);
    },
  });

  NM.target({
    name: "version",
    virtual: true,
    rebuild: "always",
    doc: "print the version",
    build() {
      console.log(VERSION);
    },
  });

  NM.target({
    name: "clean",
    virtual: true,
    rebuild: "always",
    doc: "remove dist/ (not the weights)",
    async build() {
      await Deno.remove(join(o.root, "dist"), { recursive: true }).catch(() => {});
    },
  });
}

// ── bootstrap ─────────────────────────────────────────────────────────────────
try {
  const opts = parseArgs(Deno.args);
  const requested = opts.targets.length > 0 ? opts.targets : ["all"];
  const needsRepo = requested.some((t) => !["usage", "version", "help"].includes(t));
  if (needsRepo) {
    opts.root = await resolveRoot(opts.dir ?? Deno.cwd());
    // nomake resolves target paths against the process cwd
    Deno.chdir(opts.root);
  }
  const gpu = await detectGpu();
  defineTargets(opts, gpu);
  await NM.makefile(requested);
} catch (e) {
  die(msgOf(e));
}
