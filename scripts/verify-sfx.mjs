/**
 * 音效生成（模块八）自检：纯本地、零计费。
 *
 *   node scripts/verify-sfx.mjs
 *
 * 起一个 mock 火山引擎语音服务，把「建任务 → 参考上传 → 生成 → 落盘 → 导出 →
 * 资源路由」整条链路真跑一遍；音频用 ffmpeg 生成的正弦波，不碰真实 API。
 * 覆盖：
 *   · 请求路径 / Header（X-Api-Key / X-Api-Request-Id，且没有 X-Api-Resource-Id）；
 *   · 短模型名、audio_config、references、watermark；
 *   · base64 / URL 两种返回、伪音频拒绝、401 / 10074 / 空响应；
 *   · 任务状态机、重复提交闸门、取消、重启恢复；
 *   · 参考图/音频互斥与数量/大小/时长上限；
 *   · 导出（单条 / zip）与资源路由 200 / 403 / 目录穿越；
 *   · 配置脱敏、sfxBlocker、testSfx。
 */

import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";

const HOME = await mkdtemp(join(tmpdir(), "dsh-gmm-sfx-"));
process.env.DSH_HOME = HOME;

const { Context } = await import("@deepseek-ai/cordis");
const plugin = await import("../lib/index.js");
const G = await import("../lib/sfxgen.js");
const API = await import("../lib/sfxapi.js");
const { encodePng } = await import("../lib/png.js");

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
const longWav = join(HOME, "long.wav");
try {
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-ac", "1", "-ar", "24000", "-y", toneWav]);
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=31", "-ac", "1", "-ar", "24000", "-y", longWav]);
} catch (error) {
  console.error(`需要 ffmpeg 才能跑音效自检：${error.message}`);
  process.exit(1);
}
const toneBytes = await readFile(toneWav);
const pngBytes = encodePng(Buffer.alloc(8 * 8 * 4, 255), 8, 8);

// ── mock 火山引擎语音 ───────────────────────────────────────────────────
const requests = [];
let port = 0;
const mock = createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const bodyText = Buffer.concat(chunks).toString("utf8");
    let body = {};
    try {
      body = bodyText === "" ? {} : JSON.parse(bodyText);
    } catch {
      // ignore
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    requests.push({
      path: url.pathname,
      headers: req.headers,
      body
    });
    const json = (status, value) => {
      res.writeHead(status, { "Content-Type": "application/json", "X-Tt-Logid": "log-test-1" });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === "/audio/tone.wav") {
      res.writeHead(200, { "Content-Type": "audio/wav" });
      res.end(toneBytes);
      return;
    }
    if (req.headers["x-api-key"] !== "test-key") {
      json(401, { code: 401, message: "invalid api key" });
      return;
    }
    if (url.pathname !== "/api/v3/tts/create") {
      json(404, { code: 404, message: "no route" });
      return;
    }
    const prompt = String(body.text_prompt ?? "");
    if (prompt.includes("GRANT")) {
      json(200, { code: 10074, message: "resource not granted for volc.service_type.10074" });
      return;
    }
    if (prompt.includes("CORRUPT")) {
      json(200, { audio: Buffer.from("this is definitely not an audio container").toString("base64"), duration: 1 });
      return;
    }
    if (prompt.includes("NOAUDIO")) {
      json(200, { code: 0, message: "empty result" });
      return;
    }
    if (prompt.includes("SLOW")) {
      setTimeout(() => json(200, { audio: toneBytes.toString("base64"), duration: 3, original_duration: 3 }), 3000);
      return;
    }
    if (prompt.includes("URL")) {
      json(200, {
        url: `http://127.0.0.1:${port}/audio/tone.wav`,
        duration: 3,
        original_duration: 3.1
      });
      return;
    }
    json(200, { audio: toneBytes.toString("base64"), duration: 3, original_duration: 3 });
  });
});
await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
port = mock.address().port;
const base = `http://127.0.0.1:${port}`;

// ── 挂载 ────────────────────────────────────────────────────────────────
const ctx = new Context();
const routes = [];
ctx.provide("typert", { register: () => () => {} });
ctx.provide("webServer", { register: (route) => { routes.push(route); return () => {}; } });
plugin.apply(ctx);
const gw = ctx.get("gameStudio");

async function waitIdle(jobId, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const view = await gw.getSfxJob({ jobId });
    if (view.busy !== true) return view;
    if (Date.now() > deadline) return view;
    await sleep(150);
  }
}

try {
  section("1) 配置与脱敏");
  const cfg = await gw.saveConfig({ sfxApiKey: "test-key", sfxBaseUrl: `${base}/`, sfxModel: "seed-audio-1.0", sfxFormat: "wav", sfxSampleRate: 24000 });
  check("Key 已配置且不回传明文", cfg.sfxApiKeySet === true && cfg.sfxApiKey === undefined && cfg.sfxApiKeyHint !== "", JSON.stringify({ set: cfg.sfxApiKeySet, hint: cfg.sfxApiKeyHint }));
  check("Base URL 去尾斜杠", cfg.sfxBaseUrl === base, cfg.sfxBaseUrl);
  check("默认模型是 seed-audio-1.0", cfg.sfxModel === "seed-audio-1.0", cfg.sfxModel);
  check("配置视图带格式 / 采样率 / 限制", Array.isArray(cfg.sfxFormats) && cfg.sfxFormats.length === 3 && cfg.sfxLimits.promptChars === 2048, JSON.stringify(cfg.sfxLimits));
  check("未配置时 sfxBlocker 有可读原因", (API.sfxBlocker({ sfxApiKey: "" }) ?? "").includes("语音"));
  check("已配置时 sfxBlocker 为 undefined", API.sfxBlocker({ sfxApiKey: "x" }) === undefined);
  check("normalizeSfxBaseUrl 会剥掉完整端点", API.normalizeSfxBaseUrl("https://openspeech.bytedance.com/api/v3/tts/create/") === "https://openspeech.bytedance.com");

  section("2) 建任务与参数校验");
  const job = await gw.createSfxJob({
    name: "测试音效",
    prompt: "暴雨中的金属撞击，短促有力，约 1 秒",
    settings: { format: "wav", sampleRate: 24000 },
    reviewMode: "auto"
  });
  check("任务 id 形如 f…", /^f[a-z0-9]{4,40}$/u.test(job.id), job.id);
  check("assetBase 指向 sfx-assets", String(job.assetBase).includes("sfx-assets"), job.assetBase);
  check("默认阶段是 generate / export", job.stages.generate.status === "idle" && job.stages.export.status === "idle", JSON.stringify(job.stages));
  await expectThrow("空提示词不能建任务", () => gw.createSfxJob({ prompt: "   " }), "提示词不能为空");
  await expectThrow("非法格式被拒绝", () => gw.createSfxJob({ prompt: "x", settings: { format: "flac" } }), "格式不合法");
  await expectThrow("非法采样率被拒绝", () => gw.createSfxJob({ prompt: "x", settings: { sampleRate: 12345 } }), "采样率不合法");

  section("3) 生成：请求体与落盘");
  const started = await gw.runSfxGeneration({ jobId: job.id });
  check("提交返回 started", started.started === true, JSON.stringify(started));
  const after = await waitIdle(job.id);
  check("任务完成且没有错误", after.status === "ready" && after.takes.length === 1, `${after.status} / ${after.takes.length}`);
  const take = after.takes[0];
  check("take 是 WAV（按文件头）", take.format === "wav", take.format);
  check("take 有绝对 URL", typeof take.url === "string" && take.url.startsWith("http"), take.url);
  check("take 有时长", Number(take.duration) > 2.5 && Number(take.duration) < 3.5, String(take.duration));
  check("落盘文件存在", (await stat(G.sfxAssetPath(job.id, take.file))).size > 1000, take.file);
  const createReq = requests.filter((entry) => entry.path === "/api/v3/tts/create").at(-1);
  check("请求 Header 带 X-Api-Key", createReq.headers["x-api-key"] === "test-key");
  check("请求 Header 带 X-Api-Request-Id", typeof createReq.headers["x-api-request-id"] === "string" && createReq.headers["x-api-request-id"].length > 10);
  check("没有发 X-Api-Resource-Id", createReq.headers["x-api-resource-id"] === undefined);
  check("body.model 是短名", createReq.body.model === "seed-audio-1.0", createReq.body.model);
  check("body.text_prompt 是提示词", createReq.body.text_prompt === job.prompt);
  check("audio_config 带 format / sample_rate", createReq.body.audio_config?.format === "wav" && createReq.body.audio_config?.sample_rate === 24000, JSON.stringify(createReq.body.audio_config));
  check("没有参考时不发 references", createReq.body.references === undefined);
  check("没有水印时不发 watermark", createReq.body.watermark === undefined);

  section("4) 再次生成：新增 take，不覆盖");
  await gw.runSfxGeneration({ jobId: job.id });
  const after2 = await waitIdle(job.id);
  check("两条 take 都保留", after2.takes.length === 2 && after2.takes[0].id !== after2.takes[1].id, `${after2.takes.length}`);
  check("take 内保留生成时提示词", after2.takes[0].prompt === job.prompt);
  // 用一个慢任务来测并发闸门。
  const slow = await gw.createSfxJob({ prompt: "SLOW 慢任务", settings: { format: "wav", sampleRate: 24000 } });
  const first = await gw.runSfxGeneration({ jobId: slow.id });
  const second = await gw.runSfxGeneration({ jobId: slow.id });
  check("并发提交被闸门挡住", first.started === true && second.started === false, JSON.stringify(second));
  check("取消接口能找到任务", (await gw.cancelSfxGeneration({ jobId: slow.id })).canceled === true);
  const canceled = await waitIdle(slow.id);
  check("取消后任务进入 error 且没有新 take", canceled.status === "error" && canceled.takes.length === 0, `${canceled.status} / ${canceled.takes.length}`);

  section("5) 参考素材");
  const refJob = await gw.createSfxJob({ prompt: "参考图生成声线", settings: { format: "mp3", sampleRate: 16000 } });
  await gw.uploadSfxRef({ jobId: refJob.id, kind: "image", name: "角色.png", data: pngBytes.toString("base64") });
  const withImage = await gw.getSfxJob({ jobId: refJob.id });
  check("参考图已入库并带 URL", withImage.refs.image?.name === "角色.png" && typeof withImage.refs.image.url === "string", JSON.stringify(withImage.refs.image));
  await expectThrow("参考图与参考音频互斥", () => gw.uploadSfxRef({ jobId: refJob.id, kind: "audio", name: "a.wav", data: toneBytes.toString("base64") }), "不能同时使用");
  await gw.runSfxGeneration({ jobId: refJob.id });
  await waitIdle(refJob.id);
  const imageReq = requests.filter((entry) => entry.path === "/api/v3/tts/create").at(-1);
  check("请求里带 image_data", typeof imageReq.body.references?.[0]?.image_data === "string", JSON.stringify(Object.keys(imageReq.body.references?.[0] ?? {})));
  await gw.removeSfxRef({ jobId: refJob.id, kind: "image" });

  await gw.uploadSfxRef({ jobId: refJob.id, kind: "audio", name: "a.wav", data: toneBytes.toString("base64") });
  const withAudio = await gw.getSfxJob({ jobId: refJob.id });
  check("参考音频已入库并量出时长", withAudio.refs.audios.length === 1 && Number(withAudio.refs.audios[0].duration) > 2.5, JSON.stringify(withAudio.refs.audios[0]));
  await gw.runSfxGeneration({ jobId: refJob.id });
  await waitIdle(refJob.id);
  const audioReq = requests.filter((entry) => entry.path === "/api/v3/tts/create").at(-1);
  check("请求里带 audio_data", typeof audioReq.body.references?.[0]?.audio_data === "string", JSON.stringify(Object.keys(audioReq.body.references?.[0] ?? {})));
  await expectThrow("参考音频最多 3 条", async () => {
    await gw.uploadSfxRef({ jobId: refJob.id, kind: "audio", name: "b.wav", data: toneBytes.toString("base64") });
    await gw.uploadSfxRef({ jobId: refJob.id, kind: "audio", name: "c.wav", data: toneBytes.toString("base64") });
    await gw.uploadSfxRef({ jobId: refJob.id, kind: "audio", name: "d.wav", data: toneBytes.toString("base64") });
  }, "最多 3 条");
  await gw.removeSfxRef({ jobId: refJob.id, kind: "audio" });
  await expectThrow("超长参考音频被拒绝", async () => {
    const longBytes = await readFile(longWav);
    await gw.uploadSfxRef({ jobId: refJob.id, kind: "audio", name: "long.wav", data: longBytes.toString("base64") });
  }, "参考音频太长");
  await expectThrow("参考图格式限制", () => gw.uploadSfxRef({ jobId: refJob.id, kind: "image", name: "x.gif", data: Buffer.from("GIF89a").toString("base64") }), "无法识别");

  section("6) 错误处理");
  const grantJob = await gw.createSfxJob({ prompt: "GRANT 测试" });
  await gw.runSfxGeneration({ jobId: grantJob.id });
  const grantView = await waitIdle(grantJob.id);
  check("10074 给出开通提示", grantView.status === "error" && /开通/u.test(grantView.error ?? ""), grantView.error);
  check("失败不新增 take", grantView.takes.length === 0);
  const corruptJob = await gw.createSfxJob({ prompt: "CORRUPT 测试" });
  await gw.runSfxGeneration({ jobId: corruptJob.id });
  const corruptView = await waitIdle(corruptJob.id);
  check("伪音频被拒绝", corruptView.status === "error" && /不是可识别的音频/u.test(corruptView.error ?? ""), corruptView.error);
  const emptyJob = await gw.createSfxJob({ prompt: "NOAUDIO 测试" });
  await gw.runSfxGeneration({ jobId: emptyJob.id });
  const emptyView = await waitIdle(emptyJob.id);
  check("空响应报错", emptyView.status === "error" && /没有返回音频/u.test(emptyView.error ?? ""), emptyView.error);
  const urlJob = await gw.createSfxJob({ prompt: "URL 回退测试" });
  await gw.runSfxGeneration({ jobId: urlJob.id });
  const urlView = await waitIdle(urlJob.id);
  check("URL 返回也能下载落盘", urlView.status === "ready" && urlView.takes.length === 1 && urlView.takes[0].format === "wav", urlView.error ?? `${urlView.takes.length}`);

  section("7) 导出与资源路由");
  const exported = await gw.exportSfx({ jobId: job.id, takeId: after2.takes[0].id });
  check("单条导出返回本机路径", exported.ok === true && typeof exported.path === "string" && (await stat(exported.path)).size > 1000, exported.path);
  const zip = await gw.exportSfx({ jobId: job.id, zip: true });
  check("全部打包 zip", zip.zip === true && (await stat(zip.path)).size > 1000, zip.path);
  const routeServer = createServer((req, res) => routes[0].handler(req, res));
  await new Promise((resolve) => routeServer.listen(0, "127.0.0.1", resolve));
  const routePort = routeServer.address().port;
  const takePath = `/dsh-game-material-master/sfx-assets/${job.id}/${after2.takes[0].file}`;
  const full = await fetch(`http://127.0.0.1:${routePort}${takePath}`);
  check("音效资源 200 + audio", full.status === 200 && String(full.headers.get("content-type")).startsWith("audio/"), `${full.status} ${full.headers.get("content-type")}`);
  const forbidden = await fetch(`http://127.0.0.1:${routePort}/dsh-game-material-master/sfx-assets/${job.id}/job.json`);
  check("任务根文件不走资源路由（403）", forbidden.status === 403, String(forbidden.status));
  const traversal = await fetch(`http://127.0.0.1:${routePort}/dsh-game-material-master/sfx-assets/${job.id}/takes/%2e%2e%2fjob.json`);
  check("目录穿越被拒绝", traversal.status === 400 || traversal.status === 403, String(traversal.status));
  routeServer.close();

  section("8) testSfx / 重启恢复 / 删除");
  const test = await gw.testSfx();
  check("testSfx 返回统计", test.ok === true && Number(test.bytes) > 1000 && String(test.endpoint).endsWith("/api/v3/tts/create"), JSON.stringify(test));
  await G.patchSfxJob(job.id, (current) => { current.status = "running"; });
  await G.resumeSfxJobs();
  const resumed = await gw.getSfxJob({ jobId: job.id });
  check("重启恢复把 running 标失败", resumed.status === "error" && /重启/u.test(resumed.error ?? ""), resumed.error);
  await expectThrow("运行中不能删除", async () => {
    await G.patchSfxJob(slow.id, (current) => { current.status = "running"; });
    await gw.deleteSfxJob({ jobId: slow.id });
  }, "正在生成");
  await G.patchSfxJob(slow.id, (current) => { current.status = "error"; });
  await gw.deleteSfxJob({ jobId: slow.id });
  check("删除后查不到", await G.readSfxJob(slow.id) === undefined);

  console.log(`\n共 ${checks} 项检查，失败 ${failures.length} 项。`);
  if (failures.length > 0) {
    console.error(`失败项：${failures.join("、")}`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  mock.close();
  await rm(HOME, { recursive: true, force: true }).catch(() => undefined);
}

async function expectThrow(name, run, expected) {
  try {
    await run();
    check(name, false, "没有抛错");
  } catch (error) {
    const message = String(error?.message ?? error);
    check(name, message.includes(expected), message.slice(0, 160));
  }
}
