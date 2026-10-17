/**
 * 音乐生成编辑（模块七）· **走真实网关**的自检（不联网、不花钱）。
 *
 *   node scripts/verify-music-gateway.mjs
 *
 * 与 verify-music.mjs 的分工：
 *   · verify-music.mjs        任务/音频/工具/路由的完整链路（直接调 gateway）
 *   · **本脚本**              wire payload schema、工具面、深链接、隐藏模块、配置字段
 *
 * 重点是 **payload schema 静默丢键**：typert 按 wire.ts 声明校验 payload，
 * schema 里没写的键会被无声丢掉，界面表现是「点了没反应」。所以每个方法都先按
 * schema 解析一遍，再断言解析结果与原始 payload 逐键一致。
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { deepStrictEqual } from "node:assert";

const HOME = await mkdtemp(join(tmpdir(), "dsh-music-gw-"));
process.env.DSH_HOME = HOME;
const failures = [];
let checks = 0;
function check(name, ok, detail = "") {
  checks++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail === "" ? "" : ` — ${detail}`}`);
  if (!ok) failures.push(name);
}
function section(title) {
  console.log(`\n── ${title} ──`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const toneWav = join(HOME, "tone.wav");
execFileSync(process.env.FFMPEG_PATH ?? "ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-ac", "2", "-ar", "44100", "-y", toneWav]);

// ── mock 谱乐 AI ────────────────────────────────────────────────────────
const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", async () => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const json = (status, value) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (url.pathname === "/audio/tone.wav") { res.writeHead(200, { "Content-Type": "audio/wav" }); res.end(await readFile(toneWav)); return; }
    if (req.headers.authorization !== "Bearer sk-test") { json(401, { error: { type: "authentication_error", message: "bad key" } }); return; }
    if (url.pathname === "/v1/music/generations/history") { json(200, { data: [], total: 3, page: 1, size: 1, total_pages: 3 }); return; }
    if (url.pathname === "/v1/suno/generate/prompt") {
      json(202, { task_id: "t1", status: "pending", songs: [{ id: "s1", status: "pending" }, { id: "s2", status: "pending" }] });
      return;
    }
    if (url.pathname === "/v1/music/generations/query") {
      const ids = String(url.searchParams.get("songid") ?? "").split(",").filter(Boolean);
      json(200, ids.map((id) => ({ id, status: "succeeded", title: "T", audio_url: `http://127.0.0.1:${port}/audio/tone.wav`, duration: 3 })));
      return;
    }
    if (url.pathname === "/v1/music/generations/wav") { json(200, { id: "s1", audio_wav_url: `http://127.0.0.1:${port}/audio/tone.wav` }); return; }
    if (url.pathname === "/v1/suno/lrc/generate") { json(200, { results: [{ id: "s1", success: true, lrc_alignment: { aligned_words: [] } }] }); return; }
    if (url.pathname === "/v1/tools/stems/instruments") { json(200, { categories: [{ category_code: "vocals", name: "Vocals", sort: 1, instruments: [] }] }); return; }
    if (url.pathname === "/v1/tools/style-analysis") { json(200, { task_id: "style-1", status: "succeeded", type: "style_analysis", result: { instruments: ["synth"], genres: ["chiptune"], tags: ["bright"], description: "test" } }); return; }
    json(404, { error: { type: "not_found_error", message: "no route" } });
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

// ── 挂载 ────────────────────────────────────────────────────────────────
const { Context } = await import("@deepseek-ai/cordis");
const plugin = await import("../lib/index.js");
const wire = await import("../lib/wire.js");
const links = await import("../lib/links.js");
const toolsurface = await import("../lib/tools.js");
const captured = { tools: [], routes: [], sections: [] };
const ctx = new Context();
ctx.provide("typert", { register: (manifest) => { captured.manifest = manifest; return () => {}; } });
ctx.provide("webServer", { register: (route) => { captured.routes.push(route); return () => {}; } });
ctx.provide("tools", { register: (definition) => { captured.tools.push(definition); return () => {}; } });
ctx.provide("systemPrompt", { section: (section) => { captured.sections.push(section); return () => {}; } });
plugin.apply(ctx);
const gw = ctx.get("gameStudio");
const tool = (name) => captured.tools.find((entry) => entry.name === name);
const run = async (name, args) => tool(name).execute(args, { signal: undefined });
const base = `http://127.0.0.1:${port}`;

/** 走一遍 wire schema，并断言「解析后一个键都没少」。 */
const losses = [];
function schemaOf(method) {
  return wire.METHODS.find((entry) => entry.method === method);
}
function assertPayload(method, payload) {
  const spec = schemaOf(method);
  if (spec?.payload === undefined) return;
  const parsed = spec.payload.parse(payload);
  try {
    deepStrictEqual(parsed, payload);
  } catch (error) {
    losses.push(`${method}: ${String(error.message).slice(0, 240)}`);
  }
}
async function call(method, payload) {
  if (payload !== undefined) assertPayload(method, payload);
  return payload === undefined ? gw[method]() : gw[method](payload);
}

async function waitIdle(jobId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const view = await gw.getMusicJob({ jobId });
    if (view.busy !== true || Date.now() > deadline) return view;
    await sleep(200);
  }
}

try {
  section("1) 清单与 schema");
  check("manifest 里有 27 个音乐方法", wire.METHODS.filter((entry) => toolsurface.METHOD_MODULE[entry.method] === "music").length === 25 && wire.METHODS.some((entry) => entry.method === "testMusic") && wire.METHODS.some((entry) => entry.method === "testMusicScore"), String(wire.METHODS.filter((entry) => toolsurface.METHOD_MODULE[entry.method] === "music").length));
  const clientSource = readFileSync("src/client.ts", "utf8");
  check("浏览器半区方法清单包含全部音乐方法", wire.METHODS.filter((entry) => toolsurface.METHOD_MODULE[entry.method] === "music").every((entry) => clientSource.includes(`["${entry.method}", ${entry.payload === undefined ? "false" : "true"}]`)));
  check("moduleForId(a…) = music", toolsurface.moduleForId("a1234") === "music");
  check("MUSIC_STAGES 与界面一致", links.MUSIC_STAGES.join(",") === "compose,generate,edit,export", links.MUSIC_STAGES.join(","));
  for (const method of ["getMusicScoreGuide", "testMusicScore", "saveMusicScorePlan", "runMusicScore", "submitMusicScoreToSuno"]) {
    check(`清单里有 ${method}`, wire.METHODS.some((entry) => entry.method === method));
  }

  section("2) 配置字段过 schema 不丢");
  const cfg = await call("saveConfig", { musicApiKey: "sk-test", musicBaseUrl: base, musicProvider: "puyue", musicModel: "chirp-v6", musicTimeoutMs: 30000, musicPollTimeoutMs: 60000, musicPythonPath: "/tmp/py", musicFluidsynthPath: "/tmp/fs", musicSoundfontPath: "/tmp/sf2" });
  check("音乐配置写入并脱敏", cfg.musicApiKeySet === true && cfg.musicApiKey === undefined && cfg.musicModel === "chirp-v6");
  check("谱曲依赖路径过 schema", cfg.musicPythonPath === "/tmp/py" && cfg.musicFluidsynthPath === "/tmp/fs" && cfg.musicSoundfontPath === "/tmp/sf2");
  check("配置视图带 musicScoreStatus", cfg.musicScoreStatus !== undefined && cfg.musicScoreStatus !== null);
  const scoreGuide = await call("getMusicScoreGuide", { lang: "zh" });
  check("getMusicScoreGuide 返回谱曲指南", /scoremill/.test(scoreGuide.guide) && scoreGuide.sources.some((entry) => /scoremill/.test(entry.name)));
  const scoreTest = await call("testMusicScore");
  check("testMusicScore 返回探测结果", typeof scoreTest.ok === "boolean" && scoreTest.python !== undefined);

  section("3) 音乐方法走网关");
  const created = await call("createMusicJob", { name: "网关自检", source: { kind: "lyrics", lyrics: "[Verse]\nla la", adaptedPrompt: "keep", adaptedTags: "pop", note: "90s" }, settings: { engine: "suno", mode: "custom", vocalGender: "female", styleWeight: 0.7 }, reviewMode: "auto" });
  check("createMusicJob 返回视图", created.id?.startsWith("a") === true && created.source?.adaptedPrompt === "keep", JSON.stringify({ id: created.id, source: created.source?.adaptedPrompt }));
  check("createMusicJob 的 settings 字段没丢", created.settings?.vocalGender === "female" && created.settings?.styleWeight === 0.7, JSON.stringify(created.settings));
  const listed = await call("listMusicJobs");
  check("listMusicJobs 含新任务", listed.jobs.some((entry) => entry.id === created.id));
  const read = await call("getMusicJob", { jobId: created.id, lang: "zh" });
  check("getMusicJob.lang 过 schema", read.id === created.id);
  check("getMusicJob 带 workflow / compositions / scorePlan 字段", read.workflow === "generate" && Array.isArray(read.compositions) && read.scorePlan === null, JSON.stringify({ workflow: read.workflow, compositions: read.compositions?.length }));

  // 谱曲模式的 schema 穿透：这些 payload 只解析、不执行（执行会跑 Python）。
  assertPayload("createMusicJob", { name: "方案", workflow: "compose", source: { kind: "prompt", prompt: "x", instrumental: true }, reviewMode: "manual" });
  assertPayload("saveMusicScorePlan", { jobId: created.id, plan: { summary: "s", style: "chiptune", mood: "tense", key: "D minor", tempo: 150, timeSignature: "4/4", lengthBars: 32, durationTarget: 90, instrumental: true, structure: [{ name: "INTRO", bars: 8, energy: "p", description: "sparse" }], instrumentation: [{ name: "lead", program: 80, channel: 1, role: "theme" }], motif: "m", notes: "n", lyrics: "l", sunoTags: "t", sunoPrompt: "p", negativeTags: "x" } });
  assertPayload("runMusicScore", { jobId: created.id, title: "T", plan: { style: "chiptune" }, script: "from scoremill import Song\n", basedOn: "c1", label: "第一版" });
  assertPayload("submitMusicScoreToSuno", { jobId: created.id, scoreId: "c1", confirm: true, model: "chirp-v6", params: { title: "T", tags: "x" }, regenerate: true, copyrightAudio: true, audioWeight: 0.8 });
  assertPayload("musicPeaks", { jobId: created.id, scoreId: "c1", buckets: 64 });
  assertPayload("exportMusic", { jobId: created.id, scoreId: "c1" });
  assertPayload("setMusicApproved", { jobId: created.id, scoreId: "c1", approved: true });

  const composeJob = await call("createMusicJob", { name: "谱曲网关", workflow: "compose", source: { kind: "prompt", prompt: "battle", instrumental: true }, reviewMode: "auto" });
  check("createMusicJob 的 workflow=compose 过 schema", composeJob.workflow === "compose" && composeJob.stages.compose !== undefined, JSON.stringify(composeJob.workflow));
  const savedPlan = await call("saveMusicScorePlan", { jobId: composeJob.id, plan: { summary: "一段方案", style: "chiptune", tempo: 150, structure: [{ name: "INTRO", bars: 8 }], instrumental: true } });
  check("saveMusicScorePlan 的嵌套字段没丢", savedPlan.scorePlan?.summary === "一段方案" && savedPlan.scorePlan?.structure?.[0]?.bars === 8 && savedPlan.scorePlan?.tempo === 150, JSON.stringify(savedPlan.scorePlan));
  const composeRead = await call("getMusicJob", { jobId: composeJob.id, lang: "zh" });
  check("谱曲任务快照带方案与空版本列表", composeRead.workflow === "compose" && composeRead.scorePlan?.style === "chiptune" && Array.isArray(composeRead.compositions) && composeRead.compositions.length === 0);
  const scoreLink = links.buildOpenLink({ module: "music", jobId: composeJob.id, stage: "compose", scoreId: "c123" });
  check("深链接带 score", /stage=compose/.test(scoreLink) && /score=c123/.test(scoreLink), scoreLink);
  await call("deleteMusicJob", { jobId: composeJob.id });
  const saved = await call("saveMusicJob", { jobId: created.id, name: "改名", source: { adaptedLyrics: "[Verse]\nla la la", adaptedNote: "90s, loop" }, settings: { bpm: 120, keyScale: "C major" }, reviewMode: "manual" });
  check("saveMusicJob 局部合并且字段不丢", saved.name === "改名" && saved.reviewMode === "manual" && saved.settings?.bpm === 120 && saved.source?.adaptedNote === "90s, loop", JSON.stringify({ name: saved.name, mode: saved.reviewMode, bpm: saved.settings?.bpm }));
  const guide = await call("getMusicGuide", { lang: "en" });
  check("getMusicGuide 返回英文指南", /streaming/i.test(guide.guide));
  const gen = await call("runMusicGeneration", { jobId: created.id, engine: "suno", mode: "prompt", params: { prompt: "gateway test", vocalGender: "female", styleWeight: 0.6, isMaxMode: true } });
  check("runMusicGeneration 的 params 过 schema", gen.started === true, JSON.stringify(gen));
  const settled = await waitIdle(created.id);
  check("网关生成 2 首并下载", settled.songs.length === 2 && settled.songs.every((song) => song.status === "succeeded" && song.file), JSON.stringify(settled.songs.map((song) => [song.status, song.file])));
  const wav = await call("getMusicWav", { jobId: created.id, songId: settled.songs[0].id });
  check("getMusicWav 过 schema", wav.ok === true);
  const lrc = await call("getMusicLrc", { jobId: created.id, songIds: [settled.songs[0].id] });
  check("getMusicLrc 过 schema", lrc.ok === true);
  const peaks = await call("musicPeaks", { jobId: created.id, songId: settled.songs[0].id, buckets: 64 });
  check("musicPeaks 过 schema", Array.isArray(peaks.peaks) && peaks.peaks.length === 64, JSON.stringify(peaks).slice(0, 200));
  const edit = await call("renderMusicEdit", { jobId: created.id, songId: settled.songs[0].id, ops: { start: 0.2, end: 2.8, gainDb: -3, fadeIn: 0.2, fadeOut: 0.2, normalize: true, lufs: -16, truePeak: -1, format: "mp3", bitrate: 192, channels: 2, sampleRate: 44100 }, label: "网关版本", preview: false, by: "ai" });
  check("renderMusicEdit 的 ops 一个键都没丢", edit.started === true && edit.versionId !== undefined, JSON.stringify(edit));
  const afterEdit = await waitIdle(created.id);
  const version = afterEdit.versions.find((entry) => entry.id === edit.versionId);
  check("版本渲染完成", version?.status === "ready", version?.error);
  const savedVersion = await call("saveMusicVersion", { jobId: created.id, versionId: version.id, label: "最终版" });
  check("saveMusicVersion 过 schema", savedVersion.versions.find((entry) => entry.id === version.id)?.label === "最终版");
  const exported = await call("exportMusic", { jobId: created.id, versionId: version.id, format: "mp3", name: "网关导出" });
  check("exportMusic 过 schema 且返回下载 URL", exported.ok === true && String(exported.downloadUrl).includes("download=1"), JSON.stringify(exported).slice(0, 200));
  const approved = await call("setMusicApproved", { jobId: created.id, songId: settled.songs[0].id, approved: true });
  check("setMusicApproved 过 schema", approved.songs.find((song) => song.id === settled.songs[0].id)?.approved === true);
  const refreshed = await call("refreshMusicJob", { jobId: created.id });
  check("refreshMusicJob 过 schema", refreshed.id === created.id);
  const cancelled = await call("cancelMusicGeneration", { jobId: created.id });
  check("cancelMusicGeneration 过 schema", cancelled.ok === true);
  const history = await call("listMusicHistory", { page: 1, size: 1, filters: ["covers"] });
  check("listMusicHistory 过 schema", history.total === 3);
  const instruments = await call("listMusicStemInstruments");
  check("listMusicStemInstruments 返回分类", Array.isArray(instruments.categories));
  const toolResult = await call("runMusicTool", { jobId: created.id, kind: "style-analysis", params: { songId: settled.songs[0].id, outputFormat: "mp3" } });
  check("runMusicTool 的 params 过 schema", toolResult.started === true, JSON.stringify(toolResult));

  section("4) 工具面 / 深链接 / 隐藏模块");
  const callTool = tool("game_material_call");
  check("game_material_call 描述覆盖音乐方法", ["getMusicGuide", "getMusicScoreGuide", "runMusicGeneration", "runMusicScore", "submitMusicScoreToSuno", "renderMusicEdit", "exportMusic"].every((method) => String(callTool.description).includes(method)));
  const callResult = await run("game_material_call", { method: "getMusicJob", payload: { jobId: created.id } });
  check("game_material_call 返回音乐 openUrl", /module=music/.test(callResult.openUrl ?? "") && /job=/.test(callResult.openUrl ?? ""), callResult.openUrl);
  const status = await run("game_material_status", {});
  check("status 列表含音乐任务", Array.isArray(status.musicJobs) && status.musicJobs.some((entry) => entry.id === created.id));
  const review = await run("game_material_review", { module: "music", id: created.id });
  check("review 音乐任务不抛异常且带歌曲", Array.isArray(review.songs) && review.songs.length === 2, `songs=${review.songs?.length}`);
  const intake = await run("game_material_intake", { module: "music" });
  check("intake 音乐有固定流程问题 + 审核模式", intake.reviewModeQuestion !== undefined && intake.questions.some((question) => question.key === "musicSource"), JSON.stringify(intake.questions.map((q) => q.key)));
  const approve = await run("game_material_approve", { module: "music", id: created.id, stage: "generate", approved: true });
  check("approve 音乐阶段", approve.approved === true);
  const hidden = await call("saveConfig", { hiddenModules: ["music"] });
  check("hiddenModules 收敛含 music", hidden.hiddenModules.includes("music"));
  let hiddenRejected = false;
  try { await run("game_material_call", { method: "listMusicJobs" }); } catch (error) { hiddenRejected = /隐藏/.test(String(error.message)); }
  check("隐藏音乐后工具面拒绝", hiddenRejected);
  let guideRejected = false;
  try { await run("game_material_call", { method: "getMusicGuide", payload: { lang: "zh" } }); } catch (error) { guideRejected = /隐藏/.test(String(error.message)); }
  check("隐藏音乐后 getMusicGuide 也拒绝", guideRejected);
  await call("saveConfig", { hiddenModules: [] });

  check("payload schema 没有静默丢键", losses.length === 0, losses.slice(0, 3).join(" | "));
  check("系统提示词里有音乐模块段", captured.sections.some((section) => /音乐生成编辑/.test(section.text)));

  await call("deleteMusicJob", { jobId: created.id });
} finally {
  server.close();
  await rm(HOME, { recursive: true, force: true }).catch(() => undefined);
}

console.log("");
if (failures.length > 0) {
  console.error(`失败 ${failures.length} 项：${failures.join("、")}`);
  process.exit(1);
}
console.log(`共 ${checks} 项检查，全部通过。`);
