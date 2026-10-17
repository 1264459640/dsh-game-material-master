/**
 * 音乐生成编辑（模块七）自检：纯本地、零计费。
 *
 *   node scripts/verify-music.mjs
 *
 * 起一个 mock 谱乐 AI 服务，把生成 → 轮询 → 下载 → 编辑 → 导出整条链路真跑一遍；
 * 音频处理用 ffmpeg 生成的正弦波，不碰真实 API。覆盖：
 *   · 14 种引擎/模式的端点与请求体映射、鉴权、401/402/429；
 *   · 任务状态机、重复提交闸门、刷新/取消；
 *   · 裁剪 / 增益 / 淡入淡出 / loudnorm / 格式转换 / 波形；
 *   · 资源路由（200/206/403/目录穿越/下载头）；
 *   · 配置脱敏、musicBlocker、指南与 CC0 来源。
 */

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";

const HOME = await mkdtemp(join(tmpdir(), "dsh-gmm-music-"));
process.env.DSH_HOME = HOME;

const { Context } = await import("@deepseek-ai/cordis");
const plugin = await import("../lib/index.js");
const G = await import("../lib/musicgen.js");
const API = await import("../lib/musicapi.js");
const AUDIO = await import("../lib/musicaudio.js");
const MODELS = await import("../lib/musicmodels.js");
const LINKS = await import("../lib/links.js");
const { encodePng } = await import("../lib/png.js");
const { runFfmpeg } = await import("../lib/media.js");

const failures = [];
let checks = 0;
function check(name, ok, detail) {
  checks++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  if (!ok) failures.push(name);
}
function section(title) {
  console.log(`\n${title}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── 测试音频 ────────────────────────────────────────────────────────────
const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
const toneWav = join(HOME, "tone.wav");
const toneMp3 = join(HOME, "tone.mp3");
try {
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-ac", "2", "-ar", "44100", "-y", toneWav]);
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", toneWav, "-b:a", "192k", "-y", toneMp3]);
} catch (error) {
  console.error(`需要 ffmpeg 才能跑音乐自检：${error.message}`);
  process.exit(1);
}

// ── mock 谱乐 AI ────────────────────────────────────────────────────────
const requests = [];
let songSeq = 0;
const mock = createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", async () => {
    const bodyText = Buffer.concat(chunks).toString("utf8");
    let body = {};
    try { body = bodyText === "" ? {} : JSON.parse(bodyText); } catch { /* ignore */ }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    requests.push({ method: req.method, path: url.pathname, body, auth: req.headers.authorization ?? "" });
    const json = (status, value) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === "/audio/tone.wav") {
      res.writeHead(200, { "Content-Type": "audio/wav" });
      res.end(await readFile(toneWav));
      return;
    }
    if (url.pathname === "/audio/tone.mp3" || url.pathname === "/audio/vocals.mp3" || url.pathname === "/audio/instrumental.mp3") {
      res.writeHead(200, { "Content-Type": "audio/mpeg" });
      res.end(await readFile(toneMp3));
      return;
    }
    if (url.pathname === "/audio/cover.png") {
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(encodePng(Buffer.alloc(4 * 4 * 4, 255), 4, 4));
      return;
    }
    if (url.pathname === "/audio/score.pdf") {
      res.writeHead(200, { "Content-Type": "application/pdf" });
      res.end(Buffer.from("%PDF-1.4\n%test\n"));
      return;
    }
    if (req.headers.authorization !== "Bearer sk-test") {
      json(401, { error: { type: "authentication_error", code: "invalid_api_key", message: "bad key", request_id: "req_1" } });
      return;
    }
    if (url.pathname === "/v1/suno/generate/prompt") {
      if (body.prompt === "trigger-402") return json(402, { error: { type: "insufficient_credits", message: "no credits" } });
      if (body.prompt === "trigger-429") return json(429, { error: { type: "rate_limit_error", message: "slow down" } });
      if (body.prompt === "trigger-bad-json") { res.writeHead(202); res.end("not json"); return; }
      songSeq += 1;
      json(202, { task_id: `task-${songSeq}`, status: "pending", songs: [
        { id: `song-${songSeq}-a`, status: "pending", title: "Take A" },
        { id: `song-${songSeq}-b`, status: "pending", title: "Take B" }
      ] });
      return;
    }
    if (/^\/v1\/(suno|mureka|minimax|ace-step)\/generate\//u.test(url.pathname)) {
      songSeq += 1;
      json(202, { task_id: `task-${songSeq}`, status: "pending", songs: [{ id: `song-${songSeq}`, status: "pending", title: "Take" }] });
      return;
    }
    if (url.pathname === "/v1/music/generations/query") {
      const ids = String(url.searchParams.get("songid") ?? "").split(",").filter(Boolean);
      json(200, ids.map((id) => ({
        id,
        status: "succeeded",
        title: `Title ${id}`,
        audio_url: `http://127.0.0.1:${port}/audio/tone.mp3`,
        image_url: `http://127.0.0.1:${port}/audio/cover.png`,
        duration: 3,
        lyric: "[Verse]\nla la",
        tags: "test, sine",
        model_name: "chirp-v6"
      })));
      return;
    }
    if (url.pathname === "/v1/music/generations/history") {
      json(200, { data: [], total: 7, page: 1, size: 1, total_pages: 7 });
      return;
    }
    if (url.pathname === "/v1/music/generations/wav") {
      json(200, { id: body.songid, audio_wav_url: `http://127.0.0.1:${port}/audio/tone.wav` });
      return;
    }
    if (url.pathname === "/v1/suno/lrc/generate") {
      json(200, { results: (body.clip_ids ?? []).map((id) => ({ id, success: true, is_lrc_active: 1, lrc_alignment: { aligned_words: [{ word: "la", start_s: 0, end_s: 0.2 }] } })) });
      return;
    }
    if (url.pathname === "/v1/tools/stems/split" || url.pathname === "/v1/tools/stems/professional/split") {
      json(202, { task_id: "stem-task", status: "pending", type: "stem_split", created_at: "2026" });
      return;
    }
    if (url.pathname === "/v1/tools/stems/instruments") {
      json(200, { categories: [{ category_code: "vocals", name: "Vocals", sort: 1, instruments: [{ code: "vocal", name: "Vocals", credits: 20, output_track_count: 2, output_tracks: ["vocals", "instrumental"], task_type: "IS", icon_url: "x", track_labels: { vocals: "Vocals" } }] }] });
      return;
    }
    if (url.pathname === "/v1/tools/stems/stem-task") {
      json(200, { task_id: "stem-task", status: "succeeded", type: "stem_split", result: { tracks: [
        { type: "vocals", url: `http://127.0.0.1:${port}/audio/vocals.mp3` },
        { type: "instrumental", url: `http://127.0.0.1:${port}/audio/instrumental.mp3` }
      ] } });
      return;
    }
    if (url.pathname === "/v1/tools/midi/convert") {
      json(200, { task_id: "midi-1", status: "succeeded", type: "audio_to_midi", result: { midi_url: `http://127.0.0.1:${port}/audio/tone.wav` } });
      return;
    }
    if (url.pathname === "/v1/tools/sheet-music/convert") {
      json(200, { task_id: "sheet-1", status: "succeeded", type: "midi_to_sheet_music", result: { files: { pdf_url: `http://127.0.0.1:${port}/audio/score.pdf`, xml_url: `http://127.0.0.1:${port}/audio/tone.wav` } } });
      return;
    }
    if (url.pathname === "/v1/tools/style-analysis") {
      json(200, { task_id: "style-1", status: "succeeded", type: "style_analysis", result: { instruments: ["synth"], genres: ["chiptune"], tags: ["bright"], description: "A bright test tone." } });
      return;
    }
    if (url.pathname === "/v1/tools/audio/convert") {
      json(202, { task_id: "convert-task", status: "pending", type: "audio_convert", created_at: "2026" });
      return;
    }
    if (url.pathname === "/v1/tools/audio/convert/convert-task") {
      json(200, { task_id: "convert-task", status: "succeeded", type: "audio_convert", result: { url: `http://127.0.0.1:${port}/audio/tone.wav` } });
      return;
    }
    json(404, { error: { type: "not_found_error", message: `no route ${url.pathname}` } });
  });
});
await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
const port = mock.address().port;

// ── 挂载插件 ────────────────────────────────────────────────────────────
const ctx = new Context();
const routes = [];
ctx.provide("typert", { register: () => () => {} });
ctx.provide("webServer", { register: (route) => { routes.push(route); return () => {}; } });
plugin.apply(ctx);
const gw = ctx.get("gameStudio");
const base = `http://127.0.0.1:${port}`;

async function waitIdle(jobId, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const view = await gw.getMusicJob({ jobId });
    if (view.busy !== true) return view;
    if (Date.now() > deadline) return view;
    await sleep(200);
  }
}

try {
  section("1) 配置与脱敏");
  const cfg = await gw.saveConfig({ musicApiKey: "sk-test", musicBaseUrl: `${base}/`, musicModel: "chirp-v6", musicPollTimeoutMs: 60000 });
  check("Key 已配置且脱敏", cfg.musicApiKeySet === true && cfg.musicApiKey === undefined && cfg.musicApiKeyHint !== "", JSON.stringify({ set: cfg.musicApiKeySet, hint: cfg.musicApiKeyHint }));
  check("Base URL 去掉尾斜杠", cfg.musicBaseUrl === base, cfg.musicBaseUrl);
  check("配置视图带引擎/模型预设", Array.isArray(cfg.musicEngines) && cfg.musicEngines.length >= 4, `${cfg.musicEngines?.length}`);
  check("未配置时 musicBlocker 有可读原因", API.musicBlocker({ musicApiKey: "" }).includes("谱乐 AI"));
  check("已配置时 musicBlocker 为 undefined", API.musicBlocker({ musicApiKey: "x" }) === undefined);
  check("normalizeMusicBaseUrl 会剥掉 /v1", API.normalizeMusicBaseUrl("https://api.yourmusic.fun/v1/") === "https://api.yourmusic.fun");

  section("2) 引擎/模式 → 端点映射");
  const cases = [
    ["suno", "prompt", "/v1/suno/generate/prompt", { prompt: "short pop", title: "T", tags: "pop" }],
    ["suno", "custom", "/v1/suno/generate/custom", { title: "T", tags: "pop", lyrics: "la la" }],
    ["suno", "cover", "/v1/suno/generate/cover", { title: "T", tags: "pop", coverClipId: "c1" }],
    ["suno", "extend", "/v1/suno/generate/extend", { title: "T", tags: "pop", continueClipId: "c1" }],
    ["suno", "mashup", "/v1/suno/generate/mashup", { title: "T", tags: "pop", sourceSongIds: ["a", "b"] }],
    ["suno", "sample", "/v1/suno/generate/sample", { title: "T", tags: "pop", sourceSongId: "a", startTime: 1, endTime: 4 }],
    ["suno", "concat", "/v1/suno/generate/concat", { title: "T", clipId: "c1" }],
    ["mureka", "prompt", "/v1/mureka/generate/prompt", { prompt: "pop" }],
    ["mureka", "custom", "/v1/mureka/generate/custom", { title: "T", lyrics: "la la", tags: "pop" }],
    ["mureka", "instrumental", "/v1/mureka/generate/instrumental", { title: "T", prompt: "warm piano" }],
    ["minimax", "custom", "/v1/minimax/generate/custom", { prompt: "pop", lyrics: "la la la la", title: "T" }],
    ["aceStep", "prompt", "/v1/ace-step/generate/prompt", { title: "T", prompt: "pop" }],
    ["aceStep", "custom", "/v1/ace-step/generate/custom", { title: "T", tags: "pop", lyrics: "la la", bpm: 120, keyScale: "C major", timeSignature: "4/4" }]
  ];
  for (const [engine, mode, endpoint, extra] of cases) {
    const request = API.buildGenerationRequest({ engine, mode, model: MODELS.defaultModelOf(engine), ...extra });
    check(`${engine}/${mode} → ${endpoint}`, request.endpoint === endpoint, request.endpoint);
  }
  check("Suno custom 缺 title 报错", (() => { try { API.buildGenerationRequest({ engine: "suno", mode: "custom", tags: "pop" }); return false; } catch (error) { return /标题/.test(String(error.message)); } })());
  check("非法模式报错", (() => { try { API.buildGenerationRequest({ engine: "suno", mode: "instrumental" }); return false; } catch (error) { return /不支持/.test(String(error.message)); } })());
  check("超长 prompt 明确报错（不静默截断）", (() => { try { API.buildGenerationRequest({ engine: "suno", mode: "prompt", prompt: "x".repeat(501) }); return false; } catch (error) { return /太长/.test(String(error.message)); } })());
  check("ACE-Step 非法 key_scale 报错", (() => { try { API.buildGenerationRequest({ engine: "aceStep", mode: "custom", title: "T", tags: "pop", keyScale: "H minor" }); return false; } catch (error) { return /key_scale/.test(String(error.message)); } })());

  section("3) 网络错误映射");
  const bad = { baseUrl: base, apiKey: "bad", timeoutMs: 5000 };
  try { await API.musicHistory(bad); check("401 映射成 Key 无效", false); } catch (error) { check("401 映射成 Key 无效", error instanceof API.MusicApiError && error.status === 401 && /无效/.test(error.message), error.message); }
  const good = { baseUrl: base, apiKey: "sk-test", timeoutMs: 5000 };
  const test = await API.testMusicConnection(good);
  check("测试连接读到历史", test.ok === true && test.total === 7, JSON.stringify(test));
  const history = await API.musicHistory(good, { page: 2, size: 5 });
  check("history 分页参数保留", history.page === 1 && history.total === 7, JSON.stringify(history));

  section("4) 任务生命周期");
  const made = await gw.createMusicJob({ name: "自检歌曲", source: { kind: "prompt", prompt: "a short bright test tone", note: "90 秒" }, reviewMode: "auto" });
  check("任务 id 以 a 开头", /^a[a-z0-9]+$/u.test(made.id), made.id);
  check("任务落盘", (await stat(join(HOME, "game-material-master", "music-jobs", made.id, "job.json"))).isFile());
  check("新建任务视图带 assetBase", made.assetBase === `/dsh-game-material-master/music-assets/${made.id}/`, made.assetBase);
  check("新建任务无歌曲", made.songs.length === 0 && made.songsTotal === 0);
  const gen = await gw.runMusicGeneration({ jobId: made.id, engine: "suno", mode: "prompt", params: { prompt: "a short bright test tone" } });
  check("提交返回 started", gen.started === true, JSON.stringify(gen));
  const again = await gw.runMusicGeneration({ jobId: made.id, engine: "suno", mode: "prompt", params: { prompt: "a short bright test tone" } });
  check("并发/已提交时拒绝重复提交", again.started === false && /已有|在跑|计费/.test(again.reason ?? ""), again.reason);
  let settled = await waitIdle(made.id);
  check("生成结束且不再是 busy", settled.busy === false);
  check("Suno 返回 2 首并下载到本地", settled.songs.length === 2 && settled.songs.every((song) => song.status === "succeeded" && song.file), JSON.stringify(settled.songs.map((song) => [song.id, song.status, song.file])));
  check("歌曲 URL 走 music-assets 路由", settled.songs.every((song) => String(song.url).includes(`/music-assets/${made.id}/songs/`)));
  const blocked = await gw.runMusicGeneration({ jobId: made.id, engine: "suno", mode: "prompt", params: { prompt: "again" } });
  check("已有歌曲后再提交必须 regenerate:true", blocked.started === false && /regenerate/.test(blocked.reason ?? ""), blocked.reason);
  check("歌曲已下载文件可读", (await stat(join(HOME, "game-material-master", "music-jobs", made.id, settled.songs[0].file))).isFile());

  section("5) WAV / LRC / 波形");
  const wav = await gw.getMusicWav({ jobId: made.id, songId: settled.songs[0].id });
  check("获取 WAV 并落盘", wav.ok === true && wav.file?.endsWith(".wav"), JSON.stringify(wav).slice(0, 200));
  const wavAgain = await gw.getMusicWav({ jobId: made.id, songId: settled.songs[0].id });
  check("WAV 已存在时复用、不重复请求", wavAgain.reused === true, JSON.stringify(wavAgain));
  const lrc = await gw.getMusicLrc({ jobId: made.id, songIds: [settled.songs[0].id] });
  check("滚动歌词保存为 JSON", lrc.ok === true && lrc.saved.length === 1, JSON.stringify(lrc).slice(0, 200));
  const peaks = await gw.musicPeaks({ jobId: made.id, songId: settled.songs[0].id, buckets: 64 });
  check("波形 64 桶且归一化", peaks.peaks.length === 64 && Math.max(...peaks.peaks) === 1, `${peaks.peaks.length}/${Math.max(...peaks.peaks)}`);

  section("6) 编辑 / 版本 / 导出");
  const render = await gw.renderMusicEdit({ jobId: made.id, songId: settled.songs[0].id, ops: { start: 0.5, end: 2.5, gainDb: -6, fadeIn: 0.2, fadeOut: 0.2, normalize: true, format: "mp3" }, preview: true });
  check("编辑返回预分配 versionId", render.started === true && /^v/u.test(render.versionId ?? ""), JSON.stringify(render));
  const edited = await waitIdle(made.id);
  const version = edited.versions.find((entry) => entry.id === render.versionId);
  check("版本渲染成功", version?.status === "ready" && version?.duration > 1.9 && version?.duration < 2.1, JSON.stringify(version));
  check("版本文件存在", (await stat(join(HOME, "game-material-master", "music-jobs", made.id, version.file))).isFile());
  check("版本为试听（preview）", version.preview === true);
  const same = await gw.renderMusicEdit({ jobId: made.id, songId: settled.songs[0].id, ops: { start: 0.5, end: 2.5, gainDb: -6, fadeIn: 0.2, fadeOut: 0.2, normalize: true, format: "mp3" } });
  check("相同参数复用已有版本", same.started === false && same.reused === true && same.versionId === version.id, JSON.stringify(same));
  const afterPromote = await gw.getMusicJob({ jobId: made.id });
  check("试听版在「保存为版本」时直接转正（不重复渲染）", afterPromote.versions.find((entry) => entry.id === version.id)?.preview === false && /转/.test(same.reason ?? ""), JSON.stringify({ preview: afterPromote.versions.find((entry) => entry.id === version.id)?.preview, reason: same.reason }));
  const saved = await gw.saveMusicVersion({ jobId: made.id, versionId: version.id, label: "自检版本" });
  check("保存版本后 preview=false", saved.versions.find((entry) => entry.id === version.id)?.preview === false);
  const exported = await gw.exportMusic({ jobId: made.id, versionId: version.id, format: "wav" });
  check("导出单文件并返回可下载 URL", exported.ok === true && /\.wav$/u.test(exported.file) && String(exported.downloadUrl).includes("download=1"), JSON.stringify(exported).slice(0, 300));
  const zip = await gw.exportMusic({ jobId: made.id });
  check("导出全部自动打 zip", zip.zip === true && String(zip.file).endsWith(".zip"), String(zip.file));
  const zipBytes = await readFile(join(HOME, "game-material-master", "music-jobs", made.id, zip.file));
  check("zip 以 PK 开头", zipBytes[0] === 0x50 && zipBytes[1] === 0x4b);

  section("6.5) 音频内核（裁剪 / 增益 / 淡入淡出 / 响度）");
  const audioProbe = await AUDIO.probeAudio(toneWav);
  check("probeAudio 读到 3 秒 / 双声道", Math.abs(audioProbe.duration - 3) < 0.1 && audioProbe.channels === 2, JSON.stringify(audioProbe));
  const editedFile = join(HOME, "edited.wav");
  const rendered = await AUDIO.renderAudioEdit({ source: toneWav, dest: editedFile, ops: { start: 0.5, end: 2.5, gainDb: -6, fadeIn: 0.3, fadeOut: 0.3, format: "wav" } });
  check("裁剪后时长约 2 秒", Math.abs(rendered.duration - 2) < 0.1, String(rendered.duration));
  const edgePeaks = await AUDIO.audioPeaks(editedFile, 64);
  const mid = edgePeaks.peaks.slice(20, 44);
  check("淡入淡出让两端明显低于中段", edgePeaks.peaks[0] < Math.max(...mid) * 0.6 && edgePeaks.peaks[63] < Math.max(...mid) * 0.6, `${edgePeaks.peaks[0]} / ${edgePeaks.peaks[63]} / ${Math.max(...mid)}`);
  const normalizedFile = join(HOME, "normalized.wav");
  await AUDIO.renderAudioEdit({ source: toneWav, dest: normalizedFile, ops: { normalize: true, lufs: -20, truePeak: -1, format: "wav" } });
  const loud = await runFfmpeg(["-hide_banner", "-nostdin", "-i", normalizedFile, "-af", "loudnorm=print_format=json", "-f", "null", "-"]);
  const loudJson = /\{[\s\S]*\}/u.exec(loud.stderr);
  const measured = loudJson === null ? NaN : Number(JSON.parse(loudJson[0]).input_i);
  check("loudnorm 输出接近目标 -20 LUFS", Number.isFinite(measured) && Math.abs(measured + 20) < 3, String(measured));
  check("非法裁剪区间报错", (() => { try { AUDIO.normalizeEditOps({ start: 2, end: 1 }, 3); return false; } catch (error) { return /终点/.test(String(error.message)); } })());
  check("淡入淡出超长按比例缩到段长", (() => { const ops = AUDIO.normalizeEditOps({ start: 0, end: 1, fadeIn: 5, fadeOut: 5 }, 3); return ops.fadeIn + ops.fadeOut <= 1.01; })());
  const mp3File = join(HOME, "edited.mp3");
  const mp3Out = await AUDIO.renderAudioEdit({ source: toneWav, dest: mp3File, ops: { format: "mp3", bitrate: 128 } });
  check("MP3 输出可探测", mp3Out.format === "mp3" && (await AUDIO.probeAudio(mp3File)).duration > 2.9);

  section("6.6) 资源路由");
  const routeServer = createServer((req, res) => routes[0].handler(req, res));
  await new Promise((resolve) => routeServer.listen(0, "127.0.0.1", resolve));
  const routePort = routeServer.address().port;
  const songPath = `/dsh-game-material-master/music-assets/${made.id}/${settled.songs[0].file}`;
  const full = await fetch(`http://127.0.0.1:${routePort}${songPath}`);
  check("音乐资源 200 + audio/mpeg", full.status === 200 && String(full.headers.get("content-type")).startsWith("audio/"), `${full.status} ${full.headers.get("content-type")}`);
  const range = await fetch(`http://127.0.0.1:${routePort}${songPath}`, { headers: { Range: "bytes=0-99" } });
  check("音乐资源支持 Range（206）", range.status === 206 && (await range.arrayBuffer()).byteLength === 100, String(range.status));
  const download = await fetch(`http://127.0.0.1:${routePort}${songPath}?download=1`);
  check("?download=1 带 Content-Disposition", String(download.headers.get("content-disposition")).includes("attachment"), download.headers.get("content-disposition"));
  const forbidden = await fetch(`http://127.0.0.1:${routePort}/dsh-game-material-master/music-assets/${made.id}/job.json`);
  check("未列入白名单的子目录 403", forbidden.status === 403, String(forbidden.status));
  const traversal = await fetch(`http://127.0.0.1:${routePort}/dsh-game-material-master/music-assets/${made.id}/songs/%2e%2e%2fjob.json`);
  check("目录穿越被拒绝", traversal.status === 400 || traversal.status === 403, String(traversal.status));
  routeServer.close();

  section("7) 工具任务");
  const stems = await gw.runMusicTool({ jobId: made.id, kind: "stems", params: { songId: settled.songs[0].id, stemCount: 4, outputFormat: "mp3" } });
  check("分轨提交", stems.started === true, JSON.stringify(stems));
  const afterStems = await waitIdle(made.id);
  const stemTool = afterStems.tools.find((entry) => entry.id === stems.toolId);
  check("分轨下载 2 个音轨", stemTool?.status === "succeeded" && stemTool.files?.length === 2, JSON.stringify(stemTool).slice(0, 300));
  const style = await gw.runMusicTool({ jobId: made.id, kind: "style-analysis", params: { songId: settled.songs[0].id } });
  const afterStyle = await waitIdle(made.id);
  check("风格分析结果入库", afterStyle.tools.find((entry) => entry.id === style.toolId)?.result?.genres?.[0] === "chiptune");
  const midi = await gw.runMusicTool({ jobId: made.id, kind: "midi", params: { songId: settled.songs[0].id } });
  const afterMidi = await waitIdle(made.id);
  check("音频转 MIDI 产物入库", afterMidi.tools.find((entry) => entry.id === midi.toolId)?.status === "succeeded");
  const convert = await gw.runMusicTool({ jobId: made.id, kind: "convert", params: { songId: settled.songs[0].id, targetFormat: "wav" } });
  const afterConvert = await waitIdle(made.id);
  check("转码任务完成", afterConvert.tools.find((entry) => entry.id === convert.toolId)?.status === "succeeded");

  section("7.5) 平台错误落到任务状态");
  const errorJob = await gw.createMusicJob({ name: "错误自检", source: { kind: "prompt", prompt: "trigger-402" } });
  await gw.runMusicGeneration({ jobId: errorJob.id, engine: "suno", mode: "prompt", params: { prompt: "trigger-402" } });
  const errorView = await waitIdle(errorJob.id);
  check("402 变成 failed + 积分不足", errorView.stages.generate.status === "error" && /积分不足/.test(errorView.stages.generate.error ?? ""), JSON.stringify(errorView.stages.generate));
  const rateJob = await gw.createMusicJob({ name: "限流自检", source: { kind: "prompt", prompt: "trigger-429" } });
  await gw.runMusicGeneration({ jobId: rateJob.id, engine: "suno", mode: "prompt", params: { prompt: "trigger-429" } });
  const rateView = await waitIdle(rateJob.id);
  check("429 变成 failed + 请求过频", rateView.stages.generate.status === "error" && /频繁/.test(rateView.stages.generate.error ?? ""), JSON.stringify(rateView.stages.generate));
  const badJsonJob = await gw.createMusicJob({ name: "坏 JSON 自检", source: { kind: "prompt", prompt: "trigger-bad-json" } });
  await gw.runMusicGeneration({ jobId: badJsonJob.id, engine: "suno", mode: "prompt", params: { prompt: "trigger-bad-json" } });
  const badJsonView = await waitIdle(badJsonJob.id);
  check("坏 JSON 有可读错误", badJsonView.stages.generate.status === "error" && /JSON/.test(badJsonView.stages.generate.error ?? ""), JSON.stringify(badJsonView.stages.generate));
  await gw.deleteMusicJob({ jobId: errorJob.id });
  await gw.deleteMusicJob({ jobId: rateJob.id });
  await gw.deleteMusicJob({ jobId: badJsonJob.id });

  section("7.8) 重启后的工具续跑不重新提交");
  const resumeJob = await gw.createMusicJob({ name: "续跑自检", source: { kind: "prompt", prompt: "resume" } });
  await G.patchMusicJob(resumeJob.id, (job) => {
    job.tools.push({ id: "tool-resume", kind: "stems", status: "polling", params: { songId: settled.songs[0].id, stemCount: 4, outputFormat: "mp3" }, remoteTaskId: "stem-task", startedAt: Date.now(), updatedAt: Date.now() });
  });
  const splitPosts = requests.filter((entry) => entry.path === "/v1/tools/stems/split").length;
  await gw.refreshMusicJob({ jobId: resumeJob.id });
  const resumed = await waitIdle(resumeJob.id);
  const resumedTool = resumed.tools.find((entry) => entry.id === "tool-resume");
  check("续跑只查询并下载，不重新提交", resumedTool?.status === "succeeded" && requests.filter((entry) => entry.path === "/v1/tools/stems/split").length === splitPosts, JSON.stringify({ status: resumedTool?.status, delta: requests.filter((entry) => entry.path === "/v1/tools/stems/split").length - splitPosts }).slice(0, 200));
  await gw.deleteMusicJob({ jobId: resumeJob.id });

  section("8) 取消 / 刷新 / 删除");
  check("空闲时 cancel 返回 canceled=false", (await gw.cancelMusicGeneration({ jobId: made.id })).canceled === false);
  const refreshed = await gw.refreshMusicJob({ jobId: made.id });
  check("refreshMusicJob 返回任务视图", refreshed.id === made.id && Array.isArray(refreshed.songs));
  const approved = await gw.setMusicApproved({ jobId: made.id, songId: settled.songs[0].id, approved: true });
  check("歌曲验收打勾", approved.songs.find((song) => song.id === settled.songs[0].id)?.approved === true);
  await gw.saveConfig({ hiddenModules: ["music"] });
  try { await gw.getMusicJob({ jobId: made.id }); check("隐藏音乐模块后网关仍可读（界面/工具面拦）", true); } catch { check("隐藏音乐模块后网关仍可读（界面/工具面拦）", false); }
  await gw.saveConfig({ hiddenModules: [] });
  await gw.deleteMusicJob({ jobId: made.id });
  let removed = false;
  try {
    await stat(join(HOME, "game-material-master", "music-jobs", made.id));
  } catch {
    removed = true;
  }
  check("删除任务后目录不存在", removed);

  section("9) 配置/路由");
  const cfg2 = await gw.getConfig();
  check("Key 不回传明文", cfg2.musicApiKey === undefined && cfg2.musicApiKeySet === true);
  const cleared = await gw.saveConfig({ clearMusicApiKey: true });
  check("clearMusicApiKey 生效", cleared.musicApiKeySet === false);
  await gw.saveConfig({ musicApiKey: "sk-test", musicBaseUrl: base });

  section("10) 指南 / 来源");
  const zh = await gw.getMusicGuide({ lang: "zh" });
  const en = await gw.getMusicGuide({ lang: "en" });
  check("中文指南包含关键技巧", /LUFS/.test(zh.guide) && /结构标签/.test(zh.guide) && /Suno/.test(zh.guide));
  check("英文指南不是中文", /streaming/i.test(en.guide) && !/结构标签/.test(en.guide));
  check("指南带 CC0 来源", zh.sources?.some((entry) => /CC0-1.0/.test(entry.license) && /claude-ai-music-skills/.test(entry.url)));
} finally {
  mock.close();
  await rm(HOME, { recursive: true, force: true }).catch(() => undefined);
}

console.log("");
if (failures.length > 0) {
  console.error(`失败 ${failures.length} 项：${failures.join("、")}`);
  process.exit(1);
}
console.log(`共 ${checks} 项检查，全部通过。`);
