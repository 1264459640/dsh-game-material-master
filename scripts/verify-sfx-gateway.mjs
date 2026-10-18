/**
 * 音效生成（模块八）· **走真实网关**的自检（不联网、不花钱）。
 *
 *   node scripts/verify-sfx-gateway.mjs
 *
 * 与 verify-sfx.mjs 的分工：
 *   · verify-sfx.mjs          任务/参考/生成/导出/路由的完整链路（直接调 gateway）
 *   · **本脚本**              wire payload schema、工具面、深链接、隐藏模块、配置字段
 *
 * 重点是 **payload schema 静默丢键**：typert 按 wire.ts 声明校验 payload，
 * schema 里没写的键会被无声丢掉，界面表现是「点了没反应」。所以每个方法都先按
 * schema 解析一遍，再断言解析结果与原始 payload 逐键一致。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deepStrictEqual } from "node:assert";

const HOME = await mkdtemp(join(tmpdir(), "dsh-sfx-gw-"));
process.env.DSH_HOME = HOME;

const { Context } = await import("@deepseek-ai/cordis");
const plugin = await import("../lib/index.js");
const wire = await import("../lib/wire.js");
const links = await import("../lib/links.js");
const toolsurface = await import("../lib/tools.js");
const { encodePng } = await import("../lib/png.js");
const { writeFile } = await import("node:fs/promises");

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

const ctx = new Context();
const captured = { tools: [], sections: [], routes: [] };
ctx.provide("typert", { register: () => () => {} });
ctx.provide("webServer", { register: (route) => { captured.routes.push(route); return () => {}; } });
ctx.provide("tools", { register: (definition) => { captured.tools.push(definition); return () => {}; } });
ctx.provide("systemPrompt", { section: (section) => { captured.sections.push(section); return () => {}; } });
plugin.apply(ctx);
const studio = ctx.get("gameStudio");
const tool = (name) => captured.tools.find((entry) => entry.name === name);
const call = async (name, args) => tool(name).execute(args, {});

function parsed(method, payload) {
  const spec = wire.METHODS.find((entry) => entry.method === method);
  if (spec?.payload === undefined) throw new Error(`方法没有 payload schema：${method}`);
  return spec.payload.parse(payload);
}

try {
  section("1) wire schema 不丢键");
  const createPayload = {
    name: "撞击声",
    prompt: "金属撞击，短促，约 1 秒",
    settings: { format: "mp3", sampleRate: 44100, speechRate: 0, loudnessRate: 0, pitchRate: 0, watermark: false },
    reviewMode: "manual"
  };
  deepStrictEqual(parsed("createSfxJob", createPayload), createPayload);
  check("createSfxJob 全部字段都过 schema", true);

  const savePayload = { jobId: "f1234", name: "改名", prompt: "新的声音", settings: { format: "wav", sampleRate: 24000 }, reviewMode: "auto" };
  deepStrictEqual(parsed("saveSfxJob", savePayload), savePayload);
  check("saveSfxJob 全部字段都过 schema", true);

  const uploadPayload = { jobId: "f1234", kind: "audio", name: "a.wav", data: "AAAA" };
  deepStrictEqual(parsed("uploadSfxRef", uploadPayload), uploadPayload);
  check("uploadSfxRef 全部字段都过 schema", true);

  const removePayload = { jobId: "f1234", kind: "audio", file: "refs/a.wav" };
  deepStrictEqual(parsed("removeSfxRef", removePayload), removePayload);
  check("removeSfxRef 全部字段都过 schema", true);

  const approvePayload = { jobId: "f1234", stage: "generate", approved: true };
  deepStrictEqual(parsed("setSfxApproved", approvePayload), approvePayload);
  check("setSfxApproved 全部字段都过 schema", true);

  const exportPayload = { jobId: "f1234", takeId: "k1234", zip: false };
  deepStrictEqual(parsed("exportSfx", exportPayload), exportPayload);
  check("exportSfx 全部字段都过 schema", true);

  deepStrictEqual(parsed("runSfxGeneration", { jobId: "f1234" }), { jobId: "f1234" });
  deepStrictEqual(parsed("setReviewMode", { id: "f1234", module: "sfx", reviewMode: "manual" }), { id: "f1234", module: "sfx", reviewMode: "manual" });
  check("setReviewMode 接受 sfx 模块", true);

  section("2) 方法清单与工具归类");
  const sfxMethods = wire.METHODS.filter((entry) => toolsurface.METHOD_MODULE[entry.method] === "sfx").map((entry) => entry.method);
  check("12 个模块方法都归到 sfx", sfxMethods.length === 12, sfxMethods.join("、"));
  check("testSfx 是共享方法", toolsurface.SHARED_TOOL_METHODS.has("testSfx"));
  check("模块名与界面一致", toolsurface.MODULE_LABELS.sfx === "音效生成", toolsurface.MODULE_LABELS.sfx);
  check("f 前缀判成 sfx", toolsurface.moduleForId("fabc123") === "sfx");
  check("sfx 出现在 STUDIO_MODULES 末尾", links.STUDIO_MODULES.at(-1) === "sfx", links.STUDIO_MODULES.join(","));

  const link = links.buildOpenLink({ module: "sfx", jobId: "fabc123", stage: "generate" }, "http://127.0.0.1:43120");
  const intent = links.parseIntentQuery(link.split("?")[1]);
  check("深链接带 module=sfx&job&stage", link.includes("module=sfx") && link.includes("job=fabc123") && link.includes("stage=generate"), link);
  check("深链接能解析回来", intent?.module === "sfx" && intent?.jobId === "fabc123" && intent?.stage === "generate", JSON.stringify(intent));

  const sectionText = captured.sections.map((entry) => entry.text ?? "").join("\n");
  check("系统提示词讲清音效流程", sectionText.includes("音效生成") && sectionText.includes("seed-audio-1.0") && sectionText.includes("runSfxGeneration"), "");

  section("3) 配置字段");
  const saved = await studio.saveConfig({ sfxApiKey: "test-key", sfxBaseUrl: "https://example.test", sfxModel: "seed-audio-1.0", sfxFormat: "mp3", sfxSampleRate: 44100 });
  check("保存 Key 后脱敏", saved.sfxApiKeySet === true && saved.sfxApiKey === undefined, JSON.stringify({ set: saved.sfxApiKeySet, hint: saved.sfxApiKeyHint }));
  check("非凭据字段原样保存", saved.sfxBaseUrl === "https://example.test" && saved.sfxFormat === "mp3" && saved.sfxSampleRate === 44100, JSON.stringify({ base: saved.sfxBaseUrl, format: saved.sfxFormat, rate: saved.sfxSampleRate }));
  check("配置视图带 sfxBlocker 与限制", saved.sfxBlocker === null && saved.sfxLimits?.promptChars === 2048, JSON.stringify(saved.sfxBlocker));
  const cleared = await studio.saveConfig({ clearSfxApiKey: true });
  check("clearSfxApiKey 能清空", cleared.sfxApiKeySet === false);
  await studio.saveConfig({ sfxApiKey: "test-key" });

  section("4) 工具面：intake / status / review / approve / upload");
  const job = await studio.createSfxJob({ name: "网关测试", prompt: "森林清晨，鸟鸣与微风，舒缓，约 8 秒", settings: { format: "wav", sampleRate: 24000 }, reviewMode: "auto" });
  const listed = await call("game_material_status", {});
  check("status 清单里有 sfxJobs", Array.isArray(listed.sfxJobs) && listed.sfxJobs.some((entry) => entry.id === job.id), `${listed.sfxJobs?.length}`);
  const detail = await call("game_material_status", { module: "sfx", id: job.id });
  check("status 详情带提示词与 takes", detail.prompt === job.prompt && Array.isArray(detail.takes), detail.prompt);

  const intake = await call("game_material_intake", { module: "sfx", id: job.id });
  check("intake 对已有提示词不再追问", intake.questions.every((question) => question.key !== "sfxPrompt"), intake.questions.map((entry) => entry.key).join("、"));
  check("intake 讲清模型 / 计费 / 参考规则", intake.known?.["默认模型"] === "seed-audio-1.0" && String(intake.known?.计费 ?? "").includes("计费") && String(intake.known?.参考规则 ?? "").includes("参考图"), JSON.stringify(Object.keys(intake.known ?? {})));
  check("intake 带 openUrl", typeof intake.openUrl === "string" && intake.openUrl.includes("module=sfx"), intake.openUrl);

  const review = await call("game_material_review", { module: "sfx", id: job.id });
  check("review 返回 takes / stages / nextActions", Array.isArray(review.takes) && Array.isArray(review.stages) && Array.isArray(review.nextActions), JSON.stringify({ takes: review.takes?.length, stages: review.stages?.length }));
  check("review 的 openUrl 落在 sfx", typeof review.openUrl === "string" && review.openUrl.includes("module=sfx"), review.openUrl);

  const approved = await call("game_material_approve", { module: "sfx", id: job.id, stage: "generate", approved: true });
  check("approve 打 generate 阶段", approved.approved === true && approved.stage === "generate");
  const afterApprove = await studio.getSfxJob({ jobId: job.id });
  check("通过状态落到任务", afterApprove.stages.generate.approved === true);

  const png = join(HOME, "ref.png");
  await writeFile(png, encodePng(Buffer.alloc(8 * 8 * 4, 255), 8, 8));
  const uploaded = await call("game_material_upload", { module: "sfx", id: job.id, kind: "referenceImage", path: png });
  check("upload 支持 referenceImage", uploaded.kind === "referenceImage", JSON.stringify(uploaded));
  const afterUpload = await studio.getSfxJob({ jobId: job.id });
  check("参考图进了任务", afterUpload.refs.image?.name === "ref.png", JSON.stringify(afterUpload.refs.image));

  const callTool = await call("game_material_call", { method: "getSfxJob", payload: { jobId: job.id } });
  check("万能通道能调 getSfxJob", callTool?.value?.id === job.id && callTool.value.module === "sfx", JSON.stringify(callTool).slice(0, 200));

  section("5) 功能管理：隐藏 sfx 后工具面拒绝");
  await studio.saveConfig({ hiddenModules: ["sfx"] });
  await expectThrow("call 被拒绝", () => call("game_material_call", { method: "listSfxJobs" }), "隐藏");
  await expectThrow("intake 被拒绝", () => call("game_material_intake", { module: "sfx" }), "隐藏");
  await expectThrow("status 被拒绝", () => call("game_material_status", { module: "sfx" }), "隐藏");
  await expectThrow("upload 被拒绝", () => call("game_material_upload", { module: "sfx", id: job.id, kind: "referenceImage", path: png }), "隐藏");
  const hiddenConfig = await studio.getConfig();
  check("hiddenModules 收敛后含 sfx", hiddenConfig.hiddenModules.includes("sfx"), JSON.stringify(hiddenConfig.hiddenModules));
  await studio.saveConfig({ hiddenModules: [] });

  section("6) 审阅模式与删除");
  const reviewMode = await call("game_material_reviewMode", { module: "sfx", id: job.id, reviewMode: "manual" });
  check("reviewMode 记录到任务", reviewMode.reviewMode === "manual", JSON.stringify(reviewMode));
  const afterMode = await studio.getSfxJob({ jobId: job.id });
  check("任务上读到 manual", afterMode.reviewMode === "manual");
  await studio.deleteSfxJob({ jobId: job.id });
  check("删除任务成功", (await import("../lib/sfxgen.js")).sfxJobExists(job.id) === false);

  console.log(`\n共 ${checks} 项检查，失败 ${failures.length} 项。`);
  if (failures.length > 0) {
    console.error(`失败项：${failures.join("、")}`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
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
