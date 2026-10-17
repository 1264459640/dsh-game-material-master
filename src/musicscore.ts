/**
 * 谱曲模式的宿主侧核心：方案归一化、依赖探测、scoremill 脚本执行、
 * MIDI 试听渲染、Suno 交接参数、乐谱导出包。
 *
 * 这个文件**不碰任务目录**（那是 `musicgen.ts` 的事），只接收路径与配置，
 * 这样 `musicgen.ts` 可以单向依赖它，避免循环 import。
 *
 * ## 依赖
 *
 * 谱曲本身依赖本机 `python3 + scoremill`（插件不打包 Python，也不把
 * scoremill 改写成 JS）。试听优先 FluidSynth + SoundFont；缺失时用
 * `midipreview.ts` 的内置合成器兜底。两者都没有时仍然保留 MIDI 供下载。
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { ffmpegPath, runFfmpeg } from "./media.js";
import { parseMidiFile, type ParsedMidi } from "./midifile.js";
import { renderMidiToWav } from "./midipreview.js";
import type { ZipEntry } from "./zip.js";

// ── 数据模型（musicgen.ts 直接复用这些类型）────────────────────────────

export interface MusicScorePlan {
  /** 给用户看的完整方案（用户语言）。 */
  summary?: string;
  style?: string;
  mood?: string;
  key?: string;
  tempo?: number;
  timeSignature?: string;
  lengthBars?: number;
  durationTarget?: number;
  instrumental?: boolean;
  structure?: Array<{ name: string; bars?: number; energy?: string; description?: string }>;
  instrumentation?: Array<{ name: string; program?: number; channel?: number; role?: string }>;
  motif?: string;
  notes?: string;
  lyrics?: string;
  /** 英文 Suno 风格标签（优先于从其它字段拼）。 */
  sunoTags?: string;
  /** 英文 Suno 提示词（≤500 字符）。 */
  sunoPrompt?: string;
  negativeTags?: string;
}

export interface MusicScoreMeta {
  duration: number;
  bars: number;
  tempo: number;
  timeSignature: string;
  tracks: number;
  channels: number;
  notes: number;
}

export interface MusicComposition {
  id: string;
  label: string;
  title: string;
  plan: MusicScorePlan;
  /** compose.py 全文（agent 续改时直接读它）。 */
  script: string;
  scriptFile: string;
  midiFile: string;
  audioFile?: string;
  audioRenderer?: "fluidsynth" | "builtin";
  audioError?: string;
  midi: MusicScoreMeta;
  report?: Record<string, unknown>;
  stdout?: string;
  status: "ready" | "error";
  error?: string;
  basedOn?: string;
  approved?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ScoreDepsConfig {
  musicPythonPath?: string;
  musicFluidsynthPath?: string;
  musicSoundfontPath?: string;
}

export interface ProbeResult {
  ok: boolean;
  path?: string;
  /** 启动参数（Windows 的 `py -3` 这类候选需要）。 */
  args?: string[];
  version?: string;
  error?: string;
}

export interface ScoreDepsStatus {
  ok: boolean;
  renderer: "fluidsynth" | "builtin";
  python: ProbeResult;
  scoremill: ProbeResult;
  fluidsynth: ProbeResult;
  soundfont: ProbeResult;
  ffmpeg: ProbeResult;
  blocker: string | null;
  warnings: string[];
  checkedAt: number;
}

// ── 小工具 ──────────────────────────────────────────────────────────────

function clampString(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function finite(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function clampNumber(value: unknown, min: number, max: number): number | undefined {
  const number = finite(value);
  if (number === undefined) return undefined;
  return Math.min(max, Math.max(min, number));
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
  return value;
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// ── 方案归一化 ──────────────────────────────────────────────────────────

/** 把 agent 传来的方案收敛成稳定结构；缺失字段留空，由界面/提示词兜底。 */
export function normalizeScorePlan(input: unknown): MusicScorePlan {
  const raw = (input ?? {}) as Record<string, any>;
  const plan: MusicScorePlan = {};
  const summary = clampString(raw.summary, 20000).trim();
  if (summary !== "") plan.summary = summary;
  const style = clampString(raw.style, 300).trim();
  if (style !== "") plan.style = style;
  const mood = clampString(raw.mood, 300).trim();
  if (mood !== "") plan.mood = mood;
  const key = clampString(raw.key, 80).trim();
  if (key !== "") plan.key = key;
  const tempo = clampNumber(raw.tempo, 20, 400);
  if (tempo !== undefined) plan.tempo = tempo;
  const timeSignature = clampString(raw.timeSignature, 20).trim();
  if (timeSignature !== "") plan.timeSignature = timeSignature;
  const lengthBars = clampNumber(raw.lengthBars, 1, 2000);
  if (lengthBars !== undefined) plan.lengthBars = Math.round(lengthBars);
  const durationTarget = clampNumber(raw.durationTarget, 1, 900);
  if (durationTarget !== undefined) plan.durationTarget = durationTarget;
  if (typeof raw.instrumental === "boolean") plan.instrumental = raw.instrumental;
  if (Array.isArray(raw.structure)) {
    const structure: NonNullable<MusicScorePlan["structure"]> = [];
    for (const entry of raw.structure.slice(0, 64)) {
      if (typeof entry === "string") {
        const name = entry.trim().slice(0, 80);
        if (name !== "") structure.push({ name });
        continue;
      }
      if (entry === null || typeof entry !== "object") continue;
      const name = clampString(entry.name, 80).trim();
      if (name === "") continue;
      const bars = clampNumber(entry.bars, 1, 512);
      const energy = clampString(entry.energy, 80).trim();
      const description = clampString(entry.description, 500).trim();
      structure.push({
        name,
        ...(bars === undefined ? {} : { bars: Math.round(bars) }),
        ...(energy === "" ? {} : { energy }),
        ...(description === "" ? {} : { description })
      });
    }
    if (structure.length > 0) plan.structure = structure;
  } else if (typeof raw.structure === "string" && raw.structure.trim() !== "") {
    // 容错：agent 把段落表写成一整段文字时，别再丢掉它。
    plan.notes = [clampString(raw.notes, 4000), raw.structure.slice(0, 4000)].filter((entry) => entry.trim() !== "").join("\n");
  }
  if (Array.isArray(raw.instrumentation)) {
    const instrumentation: NonNullable<MusicScorePlan["instrumentation"]> = [];
    for (const entry of raw.instrumentation.slice(0, 64)) {
      if (typeof entry === "string") {
        const name = entry.trim().slice(0, 80);
        if (name !== "") instrumentation.push({ name });
        continue;
      }
      if (entry === null || typeof entry !== "object") continue;
      const name = clampString(entry.name, 80).trim();
      if (name === "") continue;
      const program = clampNumber(entry.program, 0, 127);
      const channel = clampNumber(entry.channel, 0, 15);
      const role = clampString(entry.role, 80).trim();
      instrumentation.push({
        name,
        ...(program === undefined ? {} : { program: Math.round(program) }),
        ...(channel === undefined ? {} : { channel: Math.round(channel) }),
        ...(role === "" ? {} : { role })
      });
    }
    if (instrumentation.length > 0) plan.instrumentation = instrumentation;
  }
  const motif = clampString(raw.motif, 2000).trim();
  if (motif !== "") plan.motif = motif;
  const notes = clampString(raw.notes, 8000).trim();
  if (notes !== "") plan.notes = notes;
  const lyrics = clampString(raw.lyrics, 10000).trim();
  if (lyrics !== "") plan.lyrics = lyrics;
  const sunoTags = clampString(raw.sunoTags ?? raw.suno_tags, 1000).trim();
  if (sunoTags !== "") plan.sunoTags = sunoTags;
  const sunoPrompt = clampString(raw.sunoPrompt ?? raw.suno_prompt, 500).trim();
  if (sunoPrompt !== "") plan.sunoPrompt = sunoPrompt;
  const negativeTags = clampString(raw.negativeTags ?? raw.negative_tags, 1000).trim();
  if (negativeTags !== "") plan.negativeTags = negativeTags;
  return plan;
}

/** 方案是否足够开始谱曲（至少得有点方向，不然只是空任务）。 */
export function scorePlanReady(plan: MusicScorePlan | undefined): boolean {
  if (plan === undefined) return false;
  return (
    (plan.summary ?? "").trim() !== "" ||
    (plan.style ?? "").trim() !== "" ||
    (plan.structure ?? []).length > 0 ||
    (plan.notes ?? "").trim() !== ""
  );
}

// ── 进程执行 ────────────────────────────────────────────────────────────

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
  timedOut: boolean;
}

/** 白名单环境：绝不让 compose.py 看到任何 API Key / 凭据。 */
function scoreEnv(): NodeJS.ProcessEnv {
  const keep = [
    "PATH",
    "HOME",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "SYSTEMROOT",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "COMSPEC",
    "PATHEXT"
  ];
  const env: Record<string, string> = {};
  for (const key of keep) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.PYTHONIOENCODING = "utf-8";
  env.PYTHONDONTWRITEBYTECODE = "1";
  env.PYTHONHASHSEED = "0";
  env.MPLBACKEND = "Agg";
  return env;
}

function killTree(child: ReturnType<typeof spawn>): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch { /* ignore */ }
  }
}

function runProcess(
  command: string,
  args: string[],
  options: { timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv; maxBytes?: number; detached?: boolean } = {}
): Promise<ProcessResult> {
  const timeoutMs = Math.max(1000, options.timeoutMs ?? 30000);
  const maxBytes = Math.max(4096, options.maxBytes ?? 1_000_000);
  return new Promise((resolvePromise) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? scoreEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: options.detached === true
      });
    } catch (error) {
      resolvePromise({ code: null, stdout: "", stderr: "", error: error instanceof Error ? error.message : String(error), timedOut: false });
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    const finish = (code: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        error,
        timedOut
      });
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutBytes >= maxBytes) return;
      const remaining = maxBytes - stdoutBytes;
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      stdout.push(slice);
      stdoutBytes += slice.length;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBytes >= maxBytes) return;
      const remaining = maxBytes - stderrBytes;
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      stderr.push(slice);
      stderrBytes += slice.length;
    });
    child.on("error", (error) => finish(null, error.message));
    child.on("close", (code) => finish(code));
  });
}

function firstLine(text: string): string {
  return text.split(/\r?\n/u).map((line) => line.trim()).find((line) => line !== "") ?? "";
}

// ── 依赖探测 ────────────────────────────────────────────────────────────

interface PythonCandidate {
  command: string;
  args: string[];
  path: string;
}

function pythonCandidates(config: ScoreDepsConfig): PythonCandidate[] {
  const list: PythonCandidate[] = [];
  const add = (command: string, args: string[] = [], path = command) => {
    if (command.trim() === "") return;
    if (!list.some((entry) => entry.command === command && entry.args.join("\u0000") === args.join("\u0000"))) {
      list.push({ command, args, path });
    }
  };
  const configured = (config.musicPythonPath ?? "").trim();
  if (configured !== "") add(expandHome(configured), [], configured);
  const fromEnv = (process.env.GMM_PYTHON ?? process.env.PYTHON_PATH ?? "").trim();
  if (fromEnv !== "") add(expandHome(fromEnv), [], fromEnv);
  add("python3", [], "python3");
  add("python", [], "python");
  if (process.platform === "win32") add("py", ["-3"], "py -3");
  return list;
}

async function probePython(config: ScoreDepsConfig): Promise<{ python: ProbeResult; scoremill: ProbeResult }> {
  let lastError = "没有找到可用的 Python";
  for (const candidate of pythonCandidates(config)) {
    const result = await runProcess(
      candidate.command,
      [...candidate.args, "-c", "import sys, scoremill; print(sys.version.split()[0]); print(getattr(scoremill, '__version__', 'unknown'))"],
      { timeoutMs: 15000 }
    );
    if (result.code === 0) {
      const lines = result.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
      return {
        python: { ok: true, path: candidate.command, args: candidate.args, version: lines[0] ?? "" },
        scoremill: { ok: true, version: lines[1] ?? "unknown" }
      };
    }
    lastError = (result.error ?? firstLine(result.stderr) ?? "").trim() || `Python 退出码 ${result.code}`;
  }
  return {
    python: { ok: false, error: lastError },
    scoremill: { ok: false, error: "找不到可导入 scoremill 的 Python" }
  };
}

function fluidSynthCandidates(config: ScoreDepsConfig): string[] {
  const list: string[] = [];
  const add = (value: string | undefined) => {
    const trimmed = (value ?? "").trim();
    if (trimmed !== "" && !list.includes(trimmed)) list.push(trimmed);
  };
  add(config.musicFluidsynthPath);
  add(process.env.GMM_FLUIDSYNTH);
  add(process.env.FLUIDSYNTH_PATH);
  if (process.platform === "darwin") {
    add("/opt/homebrew/bin/fluidsynth");
    add("/usr/local/bin/fluidsynth");
  }
  add("/usr/bin/fluidsynth");
  add("/usr/local/bin/fluidsynth");
  if (process.platform === "win32") {
    const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
    add(join(programFiles, "fluid-synth", "bin", "fluidsynth.exe"));
    add("C:\\Program Files (x86)\\fluid-synth\\bin\\fluidsynth.exe");
  }
  add("fluidsynth");
  return list;
}

async function probeFluidSynth(config: ScoreDepsConfig): Promise<ProbeResult> {
  let lastError = "找不到 fluidsynth";
  for (const candidate of fluidSynthCandidates(config)) {
    const isAbsoluteCandidate = isAbsolute(candidate);
    if (isAbsoluteCandidate && !existsSync(candidate)) continue;
    const result = await runProcess(candidate, ["--version"], { timeoutMs: 8000 });
    if (result.code === 0) {
      const match = /FluidSynth(?:\s+runtime)?\s+version\s+([0-9.]+)/iu.exec(`${result.stdout}\n${result.stderr}`);
      return { ok: true, path: candidate, version: match?.[1] ?? firstLine(result.stdout) };
    }
    lastError = result.error ?? firstLine(result.stderr) ?? `退出码 ${result.code}`;
  }
  return { ok: false, error: lastError };
}

function soundfontCandidates(config: ScoreDepsConfig): string[] {
  const list: string[] = [];
  const add = (value: string | undefined) => {
    const trimmed = (value ?? "").trim();
    if (trimmed === "") return;
    const expanded = expandHome(trimmed);
    if (!list.includes(expanded)) list.push(expanded);
  };
  add(config.musicSoundfontPath);
  add(process.env.GMM_SF2);
  add(process.env.SF);
  const dirs = [
    join(homedir(), "Library", "Audio", "SoundFonts"),
    join(homedir(), ".local", "share", "soundfonts"),
    join(homedir(), "soundfonts"),
    "/usr/share/sounds/sf2",
    "/usr/share/soundfonts",
    "/usr/local/share/soundfonts"
  ];
  if (process.platform === "win32") {
    const profile = process.env.USERPROFILE ?? "";
    if (profile !== "") dirs.push(join(profile, "soundfonts"));
    dirs.push("C:\\soundfonts");
  }
  for (const dir of dirs) {
    for (const name of listDir(dir)) {
      if (/\.sf2$/iu.test(name)) add(join(dir, name));
    }
  }
  // Homebrew 自带的 FluidSynth 会带一个很小的 SF2；有大的用户音源时优先用大的。
  const cellar = "/opt/homebrew/Cellar/fluid-synth";
  for (const version of listDir(cellar).slice(0, 4)) {
    const dir = join(cellar, version, "share", "fluid-synth", "sf2");
    for (const name of listDir(dir)) {
      if (/\.sf2$/iu.test(name)) add(join(dir, name));
    }
  }
  const ranked = [...list].sort((a, b) => {
    const score = (value: string): number => {
      const lower = value.toLowerCase();
      if (lower.includes("fluidr3")) return 3;
      if (/(^|[\\/])gm|general.?midi/u.test(lower)) return 2;
      if (lower.includes("vintage")) return 1;
      return 0;
    };
    return score(b) - score(a);
  });
  return ranked;
}

function findSoundfont(config: ScoreDepsConfig): ProbeResult {
  for (const candidate of soundfontCandidates(config)) {
    try {
      const info = existsSync(candidate) ? statSync(candidate) : undefined;
      if (info !== undefined && info.isFile() && info.size > 0) return { ok: true, path: candidate };
    } catch {
      /* ignore */
    }
  }
  return { ok: false, error: "找不到 SoundFont（.sf2）" };
}

async function probeFfmpeg(): Promise<ProbeResult> {
  const path = ffmpegPath();
  const result = await runProcess(path, ["-version"], { timeoutMs: 8000 });
  if (result.code !== 0) return { ok: false, path, error: result.error ?? firstLine(result.stderr) ?? `退出码 ${result.code}` };
  const match = /ffmpeg version\s+([^\s]+)/iu.exec(result.stdout);
  return { ok: true, path, version: match?.[1] ?? firstLine(result.stdout) };
}

let depsCache: { key: string; at: number; status: ScoreDepsStatus } | undefined;
let depsPending: { key: string; promise: Promise<ScoreDepsStatus> } | undefined;

/** 探测谱曲依赖。缓存 30 秒；`force` 用于设置页「重新检测」。 */
export async function detectScoreDeps(config: ScoreDepsConfig = {}, options: { force?: boolean } = {}): Promise<ScoreDepsStatus> {
  const key = `${config.musicPythonPath ?? ""}|${config.musicFluidsynthPath ?? ""}|${config.musicSoundfontPath ?? ""}`;
  const now = Date.now();
  if (!options.force && depsCache !== undefined && depsCache.key === key && now - depsCache.at < 30000) return depsCache.status;
  if (!options.force && depsPending !== undefined && depsPending.key === key) return depsPending.promise;
  const promise = (async (): Promise<ScoreDepsStatus> => {
    const [{ python, scoremill }, fluidsynth, ffmpeg] = await Promise.all([
      probePython(config),
      probeFluidSynth(config),
      probeFfmpeg()
    ]);
    const soundfont = findSoundfont(config);
    const warnings: string[] = [];
    let blocker: string | null = null;
    if (!python.ok) {
      blocker = "找不到可用的 Python 3。请安装 Python 3，或在「设置 → 游戏素材大师 → 谱曲模式」里指定 python3 的绝对路径。";
    } else if (!scoremill.ok) {
      const pythonLabel = [python.path ?? "python3", ...(python.args ?? [])].join(" ");
      blocker = `Python 可用（${pythonLabel}），但没有安装 scoremill。请运行：${pythonLabel} -m pip install scoremill`;
    }
    if (!fluidsynth.ok) warnings.push("没找到 FluidSynth：试听会用插件内置的简易音源（能听清曲式，但音色不如 SoundFont）。");
    if (!soundfont.ok) warnings.push("没找到 SoundFont（.sf2）：即使有 FluidSynth 也会退回内置简易音源。可把 FluidR3_GM.sf2 放到 ~/Library/Audio/SoundFonts/。");
    if (!ffmpeg.ok) warnings.push("没找到 ffmpeg：试听会保留 WAV，MP3/导出可能不可用。");
    // 自检 / 排障时可以强制用内置音源，避免依赖本机 SoundFont。
    const forceBuiltin = (process.env.GMM_SCORE_RENDERER ?? "").trim().toLowerCase() === "builtin";
    if (forceBuiltin) warnings.push("已按 GMM_SCORE_RENDERER=builtin 强制使用内置简易音源。");
    const renderer: "fluidsynth" | "builtin" = !forceBuiltin && fluidsynth.ok && soundfont.ok ? "fluidsynth" : "builtin";
    const status: ScoreDepsStatus = {
      ok: blocker === null,
      renderer,
      python,
      scoremill,
      fluidsynth,
      soundfont,
      ffmpeg,
      blocker,
      warnings,
      checkedAt: Date.now()
    };
    depsCache = { key, at: Date.now(), status };
    return status;
  })();
  depsPending = { key, promise };
  try {
    return await promise;
  } finally {
    if (depsPending?.promise === promise) depsPending = undefined;
  }
}

/** 设置页改了路径后清缓存，下一次 getConfig 立即重新探测。 */
export function clearScoreDepsCache(): void {
  depsCache = undefined;
}

// ── 脚本执行 ────────────────────────────────────────────────────────────

export interface ScoreScriptResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  midiPath: string;
  parsed: ParsedMidi;
  report?: Record<string, unknown>;
}

export interface RunScoreScriptInput {
  scoreDir: string;
  script: string;
  pythonPath: string;
  /** 例如 Windows 的 `py -3` 需要 `["-3"]`。 */
  pythonArgs?: string[];
  timeoutMs?: number;
}

function parseReportFromStdout(stdout: string): Record<string, unknown> | undefined {
  const lines = stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith("{")) continue;
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // 不是 JSON 的普通日志行，继续往前找。
    }
  }
  return undefined;
}

function findMidiFile(scoreDir: string): string | undefined {
  const exact = join(scoreDir, "score.mid");
  if (existsSync(exact)) return exact;
  const candidates = listDir(scoreDir).filter((name) => /\.mid$/iu.test(name) && !/-mix\.mid$/iu.test(name));
  if (candidates.length === 1) return join(scoreDir, candidates[0]);
  return undefined;
}

/**
 * 写 compose.py 并执行。
 *
 * 约定：脚本必须在 cwd 里 `s.save("score.mid")`；不自己渲染音频。
 * 输出上限 1MB，超时杀进程组；失败时保留脚本与日志供 agent 修正。
 */
export async function runScoreScript(input: RunScoreScriptInput): Promise<ScoreScriptResult> {
  const { scoreDir, script, pythonPath } = input;
  if (script.trim() === "") throw new Error("compose.py 是空的：请先写一份 scoremill 记谱脚本。");
  if (script.length > 200_000) throw new Error(`compose.py 太大（${script.length} 字符，上限 200000）。`);
  await mkdir(scoreDir, { recursive: true });
  await writeFile(join(scoreDir, "compose.py"), script, "utf8");
  const result = await runProcess(pythonPath, [...(input.pythonArgs ?? []), "compose.py"], {
    cwd: scoreDir,
    env: scoreEnv(),
    timeoutMs: input.timeoutMs ?? 180000,
    maxBytes: 1_000_000,
    detached: process.platform !== "win32"
  });
  await writeFile(
    join(scoreDir, "run.log"),
    [
      `python: ${pythonPath}`,
      `exit: ${result.code}${result.timedOut ? " (timeout)" : ""}`,
      result.error === undefined ? "" : `error: ${result.error}`,
      "",
      "--- stdout ---",
      result.stdout,
      "",
      "--- stderr ---",
      result.stderr
    ].join("\n"),
    "utf8"
  );
  if (result.timedOut) {
    throw new Error(`谱曲脚本超时（${Math.round((input.timeoutMs ?? 180000) / 1000)} 秒）。请缩短曲子或检查脚本里是否有死循环。\n${result.stderr.slice(-2000)}`);
  }
  if (result.code !== 0) {
    const detail = (result.stderr.trim() !== "" ? result.stderr : result.stdout).slice(-4000);
    throw new Error(`谱曲脚本运行失败（退出码 ${result.code ?? "?"}）：\n${detail || "（没有输出）"}`);
  }
  const midiPath = findMidiFile(scoreDir);
  if (midiPath === undefined) {
    throw new Error(
      `脚本跑完了，但没有找到 score.mid。请确认脚本最后调用了 s.save("score.mid")。\n` +
        `stdout：${result.stdout.slice(-1500) || "（空）"}\nstderr：${result.stderr.slice(-1500) || "（空）"}`
    );
  }
  const buffer = await readFile(midiPath);
  const parsed = parseMidiFile(buffer);
  if (parsed.meta.duration > 600) {
    throw new Error(`MIDI 时长 ${parsed.meta.duration.toFixed(1)} 秒，超过 10 分钟上限；请缩短曲子。`);
  }
  const report = parseReportFromStdout(result.stdout);
  if (report !== undefined) await writeFile(join(scoreDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { ok: true, code: result.code, stdout: result.stdout, stderr: result.stderr, timedOut: false, midiPath, parsed, report };
}

// ── 试听渲染 ────────────────────────────────────────────────────────────

export interface RenderScoreAudioInput {
  midiPath: string;
  outDir: string;
  deps: ScoreDepsStatus;
  parsed: ParsedMidi;
  /** 相对任务目录的目录前缀，例如 `scores/cabc/`。 */
  relativePrefix: string;
  timeoutMs?: number;
}

export interface RenderScoreAudioResult {
  audioFile?: string;
  renderer?: "fluidsynth" | "builtin";
  error?: string;
  warnings: string[];
  duration: number;
}

async function fileHasBytes(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

/** 用 ffmpeg 量峰值并归一化到 -1 dBFS；失败时原样返回。 */
async function normalizePeak(wavPath: string): Promise<string[]> {
  const warnings: string[] = [];
  let measured;
  try {
    measured = await runFfmpeg(["-hide_banner", "-i", wavPath, "-af", "volumedetect", "-f", "null", "-"], 60000);
  } catch {
    return warnings;
  }
  const text = `${measured.stderr}\n${measured.stdout.toString("utf8")}`;
  const match = /max_volume:\s*(-?[0-9.]+)\s*dB/iu.exec(text);
  if (match === null) return warnings;
  const maxVolume = Number(match[1]);
  if (!Number.isFinite(maxVolume)) return warnings;
  const gain = -1 - maxVolume;
  if (Math.abs(gain) < 1) return warnings;
  const gainClamped = Math.max(-12, Math.min(12, gain));
  const temp = `${wavPath}.norm.wav`;
  try {
    await runFfmpeg(["-hide_banner", "-loglevel", "error", "-y", "-i", wavPath, "-af", `volume=${gainClamped.toFixed(2)}dB`, temp], 120000);
  } catch {
    warnings.push("试听峰值归一化失败，按原始音量播放。");
    return warnings;
  }
  if (await fileHasBytes(temp)) {
    await rm(wavPath, { force: true });
    await rename(temp, wavPath);
  } else {
    warnings.push("试听峰值归一化失败，按原始音量播放。");
  }
  return warnings;
}

/** 渲染试听音频：FluidSynth 优先，内置合成器兜底，再转 MP3。 */
export async function renderScoreAudio(input: RenderScoreAudioInput): Promise<RenderScoreAudioResult> {
  const warnings: string[] = [];
  const wavPath = join(input.outDir, "preview.wav");
  const mp3Path = join(input.outDir, "preview.mp3");
  let renderer: "fluidsynth" | "builtin" | undefined;
  let renderError: string | undefined;

  if (input.deps.renderer === "fluidsynth" && input.deps.fluidsynth.ok && input.deps.soundfont.ok) {
    const result = await runProcess(
      input.deps.fluidsynth.path ?? "fluidsynth",
      [
        "-ni",
        "-F",
        wavPath,
        "-r",
        "44100",
        "-g",
        "0.75",
        "-o",
        "synth.reverb.active=1",
        "-o",
        "synth.reverb.room-size=0.78",
        "-o",
        "synth.reverb.damp=0.5",
        "-o",
        "synth.reverb.width=0.9",
        "-o",
        "synth.reverb.level=0.7",
        input.deps.soundfont.path as string,
        input.midiPath
      ],
      { timeoutMs: input.timeoutMs ?? 180000, maxBytes: 500_000 }
    );
    if (result.code === 0 && (await fileHasBytes(wavPath))) {
      renderer = "fluidsynth";
      warnings.push(...(await normalizePeak(wavPath)));
    } else {
      renderError = (result.stderr || result.stdout || result.error || "FluidSynth 渲染失败").slice(-1500);
      warnings.push("FluidSynth 渲染失败，已改用内置简易音源。");
    }
  }

  if (renderer === undefined) {
    try {
      const builtin = renderMidiToWav(input.parsed, { sampleRate: 44100, maxSeconds: 480 });
      await writeFile(wavPath, builtin.wav);
      renderer = "builtin";
      if (builtin.truncated) warnings.push(`曲子超过 ${Math.round(builtin.duration)} 秒，内置试听只渲染了前 ${Math.round(builtin.duration)} 秒；完整音频请装 FluidSynth 或下载 MIDI。`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: `试听渲染失败：${message}${renderError === undefined ? "" : `；FluidSynth：${renderError}`}`, warnings, duration: input.parsed.meta.duration };
    }
  }

  // WAV → MP3；失败就保留 WAV。
  try {
    await runFfmpeg(["-hide_banner", "-loglevel", "error", "-y", "-i", wavPath, "-codec:a", "libmp3lame", "-b:a", "192k", mp3Path], 180000);
  } catch {
    warnings.push("MP3 转码失败，试听保留 WAV。");
  }
  if (await fileHasBytes(mp3Path)) {
    await rm(wavPath, { force: true });
    return { audioFile: `${input.relativePrefix}preview.mp3`, renderer, warnings, duration: input.parsed.meta.duration };
  }
  return { audioFile: `${input.relativePrefix}preview.wav`, renderer, warnings, duration: input.parsed.meta.duration };
}

// ── Suno 交接 ───────────────────────────────────────────────────────────

export interface ScoreJobLike {
  name: string;
  source?: {
    title?: string;
    lyrics?: string;
    instrumental?: boolean;
  };
  settings?: {
    model?: string;
    negativeTags?: string;
  };
}

export interface ScoreSunoInput {
  job: ScoreJobLike;
  composition: MusicComposition;
  /** 已上传到 Suno 的参考音频 id（有值时走 cover）。 */
  coverClipId?: string;
  audioWeight?: number;
  overrides?: Record<string, unknown>;
}

export interface ScoreSunoOutput {
  engine: "suno";
  mode: "custom" | "cover";
  model?: string;
  params: Record<string, unknown>;
  warnings: string[];
}

function dedupeWords(values: Array<string | undefined>, max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = (value ?? "").trim();
    if (trimmed === "") continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= max) break;
  }
  return out;
}

function tagsFromPlan(plan: MusicScorePlan): string {
  const structure = (plan.structure ?? []).map((section) => `${section.name}${section.energy ? ` ${section.energy}` : ""}`);
  const parts = dedupeWords(
    [
      plan.style,
      plan.mood,
      plan.instrumental === false ? undefined : "instrumental",
      ...(plan.instrumentation ?? []).map((entry) => entry.name),
      plan.tempo === undefined ? undefined : `${Math.round(plan.tempo)} BPM`,
      plan.key,
      plan.timeSignature,
      "game soundtrack",
      ...structure
    ],
    24
  );
  const text = parts.join(", ");
  if (text.length <= 1000) return text;
  // 逐项丢弃，别在词中间截断。
  const kept: string[] = [];
  for (const part of parts) {
    const next = [...kept, part].join(", ");
    if (next.length > 1000) break;
    kept.push(part);
  }
  return kept.join(", ").slice(0, 1000);
}

function promptFromPlan(plan: MusicScorePlan): string {
  const structure = (plan.structure ?? [])
    .map((section) => `${section.name}${section.bars ? ` (${section.bars} bars)` : ""}${section.energy ? ` ${section.energy}` : ""}`)
    .join(" → ");
  const instruments = (plan.instrumentation ?? []).map((entry) => entry.name).join(", ");
  const lines = [
    plan.instrumental === false ? "Vocal game soundtrack." : "Instrumental game soundtrack.",
    plan.style ? `${plan.style}.` : "",
    plan.mood ? `${plan.mood}.` : "",
    [plan.tempo ? `${Math.round(plan.tempo)} BPM` : "", plan.key, plan.timeSignature].filter(Boolean).join(", ") + ".",
    structure ? `Structure: ${structure}.` : "",
    instruments ? `Instrumentation: ${instruments}.` : "",
    plan.motif ? `Motif: ${plan.motif}.` : ""
  ].filter((line) => line.trim() !== "");
  const text = lines.join(" ");
  if (text.length <= 500) return text;
  const cut = text.slice(0, 500);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 300 ? cut.slice(0, lastSpace) : cut).trim();
}

/**
 * 把谱曲方案翻译成 Suno 请求。
 *
 * Suno 不接受 MIDI 原文件，但接受音频：`submitMusicScoreToSuno` 会先把这一版的
 * 试听音频上传到 `/v1/suno/audio/upload`，再用返回的 song id 走 cover。这里负责
 * 把方案翻译成 cover 的 tags / lyrics / 时长 / audio_weight；结果不会逐音一致。
 */
export function buildScoreSunoParams(input: ScoreSunoInput): ScoreSunoOutput {
  const plan = input.composition.plan;
  const overrides = input.overrides ?? {};
  const requestedInstrumental = typeof overrides.instrumental === "boolean" ? overrides.instrumental : undefined;
  const lyrics = clampString(overrides.lyrics ?? plan.lyrics ?? input.job.source?.lyrics, 5000).trim();
  const instrumental = requestedInstrumental ?? (plan.instrumental !== false && lyrics === "");
  const title = clampString(overrides.title ?? input.composition.title ?? input.job.name, 80).trim() || input.job.name;
  const tags = clampString(overrides.tags ?? plan.sunoTags, 1000).trim() || tagsFromPlan(plan) || "instrumental game soundtrack";
  const prompt = clampString(overrides.prompt ?? plan.sunoPrompt, 500).trim() || promptFromPlan(plan);
  const negativeTags = clampString(overrides.negativeTags ?? plan.negativeTags ?? input.job.settings?.negativeTags, 1000).trim();
  const requestedDuration = finite(overrides.duration) ?? plan.durationTarget ?? input.composition.midi.duration;
  const duration = Math.max(10, Math.min(360, Math.round(requestedDuration)));
  const warnings: string[] = [];
  if (requestedDuration > 360) {
    warnings.push(`原曲约 ${Math.round(requestedDuration)} 秒，超过 Suno 的 360 秒上限；提交时按 360 秒。`);
  }
  if (!instrumental && lyrics === "") {
    warnings.push("方案里没有歌词：Suno 会按纯音乐处理。");
  }
  const coverClipId = clampString(input.coverClipId ?? overrides.coverClipId, 200).trim();
  if (coverClipId !== "") {
    // 音频条件生成：把本地渲染的 MIDI 试听上传成参考音频，再让 Suno cover。
    // CoverDto 没有 instrumental 字段；纯音乐参考通常保持纯音乐，但平台不保证。
    const coverInstrumental = instrumental || lyrics === "";
    const params: Record<string, unknown> = {
      title,
      tags,
      duration,
      negativeTags,
      prompt,
      coverClipId,
      audioWeight: clampNumber(input.audioWeight ?? overrides.audioWeight, 0, 1) ?? 0.75
    };
    if (!coverInstrumental) params.lyrics = lyrics;
    if (coverInstrumental) warnings.push("Suno cover 没有 instrumental 开关；参考音频是纯音乐，通常结果也是纯音乐，若出现人声可用 negativeTags 约束。");
    return {
      engine: "suno",
      mode: "cover",
      model: typeof overrides.model === "string" && overrides.model.trim() !== "" ? overrides.model.trim() : input.job.settings?.model,
      params,
      warnings
    };
  }
  const params: Record<string, unknown> = {
    title,
    tags,
    instrumental: instrumental || lyrics === "",
    duration,
    negativeTags,
    prompt
  };
  if (!(params.instrumental as boolean)) params.lyrics = lyrics;
  return {
    engine: "suno",
    mode: "custom",
    model: typeof overrides.model === "string" && overrides.model.trim() !== "" ? overrides.model.trim() : input.job.settings?.model,
    params,
    warnings
  };
}

// ── 乐谱导出包 ──────────────────────────────────────────────────────────

function formatPlanMarkdown(job: ScoreJobLike, composition: MusicComposition): string {
  const plan = composition.plan;
  const lines = [
    `# ${composition.title || job.name}`,
    "",
    `- 版本：${composition.label}`,
    `- 风格：${plan.style ?? "—"}`,
    `- 情绪：${plan.mood ?? "—"}`,
    `- 调性：${plan.key ?? "—"}`,
    `- 速度：${plan.tempo ?? "—"} BPM`,
    `- 拍号：${plan.timeSignature ?? "—"}`,
    `- 时长：${composition.midi.duration.toFixed(1)} 秒 · ${composition.midi.bars} 小节`,
    `- 纯音乐：${plan.instrumental === false ? "否" : "是"}`,
    ""
  ];
  if ((plan.structure ?? []).length > 0) {
    lines.push("## 段落", "", "| 段落 | 小节 | 能量 | 说明 |", "|---|---:|---|---|");
    for (const section of plan.structure ?? []) {
      lines.push(`| ${section.name} | ${section.bars ?? "—"} | ${section.energy ?? "—"} | ${section.description ?? ""} |`);
    }
    lines.push("");
  }
  if ((plan.instrumentation ?? []).length > 0) {
    lines.push("## 配器", "");
    for (const entry of plan.instrumentation ?? []) {
      const extras = [entry.program === undefined ? "" : `GM ${entry.program}`, entry.channel === undefined ? "" : `通道 ${entry.channel}`, entry.role ?? ""].filter(Boolean);
      lines.push(`- ${entry.name}${extras.length > 0 ? `（${extras.join(" · ")}）` : ""}`);
    }
    lines.push("");
  }
  if (plan.motif) lines.push("## 主题动机", "", plan.motif, "");
  if (plan.notes) lines.push("## 备注", "", plan.notes, "");
  if (plan.summary) lines.push("## 方案原文", "", plan.summary, "");
  lines.push(
    "## 文件",
    "",
    "- `score.mid`：MIDI 总谱（Type 0/1，PPQ 480）",
    "- `preview.mp3` / `preview.wav`：试听",
    "- `compose.py`：scoremill 记谱脚本（可继续改）",
    "",
    "Suno 交接说明：Suno 不接受 MIDI 原文件，但接受音频；插件会先把本方案的试听音频上传为参考（标准上传免费），再用 cover 生成。若 Suno 判定版权，需要走付费版权上传通道。结果不会逐音一致。",
    ""
  );
  return lines.join("\n");
}

export interface ScoreBundleInput {
  job: ScoreJobLike;
  composition: MusicComposition;
  readFile: (relative: string) => Promise<Buffer>;
}

/** 生成乐谱包条目（调用方负责写 zip）。 */
export async function buildScoreBundle(input: ScoreBundleInput): Promise<ZipEntry[]> {
  const entries: ZipEntry[] = [];
  const base = input.composition.label.replace(/[\\/:*?"<>|]/gu, "_").slice(0, 40) || "score";
  const read = async (relative: string | undefined): Promise<Buffer | undefined> => {
    if (relative === undefined || relative === "") return undefined;
    try {
      return await input.readFile(relative);
    } catch {
      return undefined;
    }
  };
  const midi = await read(input.composition.midiFile);
  if (midi === undefined) throw new Error("这一版没有可导出的 MIDI");
  entries.push({ path: `${base}/score.mid`, data: midi });
  const audio = await read(input.composition.audioFile);
  if (audio !== undefined) {
    const ext = input.composition.audioFile?.split(".").pop() ?? "mp3";
    entries.push({ path: `${base}/preview.${ext}`, data: audio });
  }
  entries.push({ path: `${base}/plan.md`, data: Buffer.from(formatPlanMarkdown(input.job, input.composition), "utf8") });
  entries.push({ path: `${base}/compose.py`, data: Buffer.from(input.composition.script, "utf8") });
  entries.push({
    path: `${base}/README.txt`,
    data: Buffer.from(
      [
        `# ${input.composition.title || input.job.name}`,
        "",
        "score.mid      MIDI 总谱",
        "preview.*      试听",
        "plan.md        曲式 / 配器 / 段落说明",
        "compose.py     scoremill 记谱脚本",
        "",
        "这是本地用 scoremill 写出的 MIDI；交给 Suno 时插件会先把 preview 音频上传为参考，再走 cover（不上传 MIDI 原文件）。",
        ""
      ].join("\n"),
      "utf8"
    )
  });
  return entries;
}

/** 把相对路径安全地拼到任务目录下（导出前再挡一次目录穿越）。 */
export function resolveJobRelative(jobDir: string, relative: string): string {
  const base = resolve(jobDir);
  const target = resolve(base, relative);
  if (target !== base && !target.startsWith(base + "/") && !target.startsWith(base + "\\")) {
    throw new Error(`非法的任务内路径：${relative}`);
  }
  return target;
}
