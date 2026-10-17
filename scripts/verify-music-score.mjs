/**
 * 谱曲模式（本地 MIDI）自检：纯本地、零计费。
 *
 *   node scripts/verify-music-score.mjs
 *
 * 不依赖本机 scoremill / FluidSynth：
 *   · Python 用假脚本（写一份手工构造的 MIDI）；
 *   · 试听强制走内置合成器（GMM_SCORE_RENDERER=builtin）；
 *   · Suno 用本地 mock 服务端，只验证请求体与计费闸门。
 *
 * 覆盖：方案归一化、依赖探测、脚本执行/报错、MIDI 解析、试听渲染、
 * 逐版修改、波形、乐谱包、交 Suno（confirm / regenerate / scoreId）、
 * 老任务迁移与深链接。
 */

import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';

const HOME = await mkdtemp(join(tmpdir(), 'dsh-gmm-score-'));
process.env.DSH_HOME = HOME;
process.env.GMM_SCORE_RENDERER = 'builtin';

const failures = [];
let checks = 0;
function check(name, ok, detail) {
  checks++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail === undefined ? '' : ` — ${detail}`}`);
  if (!ok) failures.push(name);
}
function section(title) {
  console.log(`\n${title}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── 手工构造一份最小 MIDI（避免依赖 scoremill）──────────────────────────
function vlq(value) {
  const out = [value & 0x7f];
  let n = value >> 7;
  while (n > 0) {
    out.unshift((n & 0x7f) | 0x80);
    n >>= 7;
  }
  return out;
}
function makeMidi() {
  const track = [];
  track.push(0x00, 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08); // 4/4
  track.push(0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20); // 120 BPM
  track.push(0x00, 0x90, 60, 100); // C4
  track.push(0x00, 0x90, 64, 100); // E4
  track.push(...vlq(480), 0x80, 60, 0);
  track.push(0x00, 0x80, 64, 0);
  track.push(...vlq(480), 0x90, 67, 90); // G4 第二小节
  track.push(...vlq(480), 0x80, 67, 0);
  track.push(0x00, 0xff, 0x2f, 0x00);
  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0];
  const len = track.length;
  const trackHeader = [0x4d, 0x54, 0x72, 0x6b, (len >> 24) & 255, (len >> 16) & 255, (len >> 8) & 255, len & 255];
  return Buffer.from([...header, ...trackHeader, ...track]);
}
const fixture = join(HOME, 'fixture.mid');
await writeFile(fixture, makeMidi());

// ── 假 Python：-c 探测返回版本；否则复制 fixture 到 score.mid ─────────────
async function makeFakePython(name, body) {
  const path = join(HOME, name);
  await writeFile(path, body, 'utf8');
  await chmod(path, 0o755);
  return path;
}
const okPython = await makeFakePython(
  'python-ok',
  `#!/bin/sh
if [ "$1" = "-c" ]; then
  echo "3.12.0"
  echo "0.5.0"
  exit 0
fi
cp "${fixture}" score.mid
echo '{"tempo":120,"key":"C","sections":[{"name":"A","bars":2}],"duration_s":2}'
`
);
const failPython = await makeFakePython(
  'python-fail',
  `#!/bin/sh
if [ "$1" = "-c" ]; then
  echo "3.12.0"
  echo "0.5.0"
  exit 0
fi
echo "bar 3: has 5.0 beats, expected 4.0 — over by 1.0 beats" >&2
exit 1
`
);
const noMidiPython = await makeFakePython(
  'python-nomidi',
  `#!/bin/sh
if [ "$1" = "-c" ]; then
  echo "3.12.0"
  echo "0.5.0"
  exit 0
fi
echo "forgot to save"
exit 0
`
);

// ── 试听音源：给 mock 服务端准备一个真实 WAV ──────────────────────────────
const toneWav = join(HOME, 'tone.wav');
execFileSync(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-ac', '2', '-ar', '44100', '-y', toneWav]);

// ── mock 谱乐 AI（Suno 音频上传 / cover / query）──────────────────────────
const requests = [];
let songSeq = 0;
let uploadMode = 'ok'; // ok | copyright-reject
const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', async () => {
    const bodyText = Buffer.concat(chunks).toString('utf8');
    let body = {};
    try { body = bodyText === '' ? {} : JSON.parse(bodyText); } catch { /* ignore */ }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    requests.push({ method: req.method, path: url.pathname, body, auth: req.headers.authorization ?? '', contentType: req.headers['content-type'] ?? '', bytes: Buffer.concat(chunks).length });
    const json = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === '/audio/tone.wav') {
      res.writeHead(200, { 'Content-Type': 'audio/wav' });
      res.end(await readFile(toneWav));
      return;
    }
    if (req.headers.authorization !== 'Bearer sk-test') {
      json(401, { error: { type: 'authentication_error', message: 'bad key' } });
      return;
    }
    if (url.pathname === '/v1/suno/audio/upload') {
      if (uploadMode === 'copyright-reject' && !bodyText.includes('name="copyright_audio_flag"')) {
        json(400, { error: { type: 'copyright_detected', message: 'copyrighted audio detected' } });
        return;
      }
      if (bodyText.includes('name="copyright_audio_flag"')) {
        json(200, { task_id: 'upload-task-1', status: 'pending', stage: 'queued', songs: [] });
        return;
      }
      json(200, { id: 'upload-song-1', status: 'succeeded', title: 'uploaded' });
      return;
    }
    if (url.pathname === '/v1/suno/audio/upload/upload-task-1') {
      json(200, { task_id: 'upload-task-1', status: 'succeeded', stage: 'completed', songs: [{ id: 'upload-song-copyright', status: 'succeeded' }] });
      return;
    }
    if (url.pathname === '/v1/suno/generate/cover' || url.pathname === '/v1/suno/generate/custom') {
      songSeq += 1;
      json(202, {
        task_id: `task-${songSeq}`,
        status: 'pending',
        songs: [
          { id: `song-${songSeq}-a`, status: 'pending', title: 'Take A' },
          { id: `song-${songSeq}-b`, status: 'pending', title: 'Take B' }
        ]
      });
      return;
    }
    if (url.pathname === '/v1/music/generations/query') {
      const ids = String(url.searchParams.get('songid') ?? '').split(',').filter(Boolean);
      json(200, ids.map((id) => ({
        id,
        status: 'succeeded',
        title: `Title ${id}`,
        audio_url: `http://127.0.0.1:${port}/audio/tone.wav`,
        duration: 2
      })));
      return;
    }
    json(404, { error: { type: 'not_found_error', message: 'no route' } });
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

// ── 挂载 ────────────────────────────────────────────────────────────────
const { Context } = await import('@deepseek-ai/cordis');
const plugin = await import('../lib/index.js');
const SCORE = await import('../lib/musicscore.js');
const ctx = new Context();
ctx.provide('typert', { register: () => () => {} });
ctx.provide('webServer', { register: () => () => {} });
ctx.provide('tools', { register: () => () => {} });
ctx.provide('systemPrompt', { section: () => () => {} });
plugin.apply(ctx);
const gw = ctx.get('gameStudio');

async function waitIdle(jobId, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const view = await gw.getMusicJob({ jobId });
    if (view.busy !== true || Date.now() > deadline) return view;
    await sleep(200);
  }
}

try {
  section('1) 方案归一化 / 指南 / 依赖探测');
  const plan = SCORE.normalizeScorePlan({
    summary: '  一段方案  ',
    style: 'chiptune',
    tempo: '150',
    lengthBars: 12.4,
    instrumental: true,
    structure: [{ name: 'INTRO', bars: 4, energy: 'p' }, 'MAIN'],
    instrumentation: ['lead', { name: 'bass', program: 33, channel: 1 }],
    sunoTags: 'chiptune, battle',
    sunoPrompt: 'short',
    extraUnknown: 'dropped'
  });
  check('方案字段归一化', plan.summary === '一段方案' && plan.style === 'chiptune' && plan.tempo === 150 && plan.lengthBars === 12 && plan.structure.length === 2, JSON.stringify(plan));
  check('方案里的未知键被丢掉', plan.extraUnknown === undefined);
  check('空方案不算 ready', SCORE.scorePlanReady({}) === false && SCORE.scorePlanReady(plan) === true);
  const guide = await gw.getMusicScoreGuide({ lang: 'zh' });
  check('谱曲指南可读且带 scoremill', /scoremill/u.test(guide.guide) && guide.sources.some((entry) => /scoremill/u.test(entry.name)));
  const englishGuide = await gw.getMusicScoreGuide({ lang: 'en' });
  check('英文谱曲指南不是中文', /Fixed flow/u.test(englishGuide.guide) && !/固定流程/u.test(englishGuide.guide));
  await gw.saveConfig({
    musicPythonPath: okPython,
    musicFluidsynthPath: '/nonexistent/fluidsynth',
    musicSoundfontPath: '/nonexistent/none.sf2'
  });
  const testStatus = await gw.testMusicScore();
  check('依赖探测识别假 Python/scoremill', testStatus.python.ok === true && testStatus.scoremill.ok === true, JSON.stringify({ python: testStatus.python, scoremill: testStatus.scoremill }));
  check('GMM_SCORE_RENDERER=builtin 强制内置音源', testStatus.renderer === 'builtin');

  section('2) 建任务 / 保存方案 / 谱曲');
  const created = await gw.createMusicJob({
    name: '谱曲自检',
    workflow: 'compose',
    reviewMode: 'auto',
    source: { kind: 'prompt', prompt: '一首 chipline 战斗循环', note: '90 秒', instrumental: true }
  });
  check('compose 任务 workflow 正确', created.workflow === 'compose' && created.stages.compose !== undefined && created.compositions.length === 0, JSON.stringify(created.workflow));
  const saved = await gw.saveMusicScorePlan({ jobId: created.id, plan });
  check('方案落盘并回显', saved.scorePlan?.style === 'chiptune' && saved.scorePlan?.structure?.length === 2);
  // 另建一个没方案的任务，专门验证「先方案后谱曲」的闸门。
  const noPlanJob = await gw.createMusicJob({ name: '无方案', workflow: 'compose', source: { kind: 'prompt', prompt: 'x', instrumental: true } });
  let rejected = '';
  try {
    await gw.runMusicScore({ jobId: noPlanJob.id, title: '无方案', script: 'print(1)' });
  } catch (error) {
    rejected = String(error.message ?? error);
  }
  check('没有方案时拒绝谱曲', /方案/u.test(rejected), rejected.slice(0, 120));
  await gw.deleteMusicJob({ jobId: noPlanJob.id });

  const first = await gw.runMusicScore({
    jobId: created.id,
    title: '第一版',
    script: 'print("compose")',
    label: '第一版'
  });
  check('谱曲返回 scoreId / MIDI / 试听 / 深链接', first.ok === true && /^c/u.test(first.scoreId) && /\.mid$/u.test(first.midiUrl ?? '') && String(first.openUrl).includes('stage=compose&score='), JSON.stringify(first).slice(0, 300));
  const afterFirst = await gw.getMusicJob({ jobId: created.id });
  const firstComp = afterFirst.compositions[0];
  check('任务里有第一版', afterFirst.compositions.length === 1 && firstComp.status === 'ready' && firstComp.label === '第一版');
  check('MIDI 元数据解析正确', firstComp.midi.bars === 0.75 && Math.abs(firstComp.midi.duration - 1.5) < 0.01 && firstComp.midi.tempo === 120, JSON.stringify(firstComp.midi));
  check('试听音频已生成', typeof firstComp.audioFile === 'string' && /preview\.(mp3|wav)$/u.test(firstComp.audioFile) && firstComp.audioRenderer === 'builtin');
  check('report() JSON 被保存', firstComp.report?.tempo === 120 && firstComp.report?.sections?.[0]?.name === 'A');
  check('stages.compose=done', afterFirst.stages.compose.status === 'done');
  const midiFile = join(HOME, 'game-material-master', 'music-jobs', created.id, firstComp.midiFile);
  check('MIDI 文件真的存在', (await stat(midiFile)).size > 0);

  section('3) 修改 / 失败 / 波形 / 导出');
  const second = await gw.runMusicScore({
    jobId: created.id,
    title: '第二版',
    script: 'print("revised")',
    label: '第二版',
    basedOn: first.scoreId
  });
  const afterSecond = await gw.getMusicJob({ jobId: created.id });
  check('第二版是新版本且 currentScoreId 更新', afterSecond.compositions.length === 2 && afterSecond.currentScoreId === second.scoreId && afterSecond.compositions[1].basedOn === first.scoreId);
  check('旧版 MIDI 仍然存在', (await stat(join(HOME, 'game-material-master', 'music-jobs', created.id, firstComp.midiFile))).size > 0);

  await gw.saveConfig({ musicPythonPath: failPython });
  let failed = '';
  try {
    await gw.runMusicScore({ jobId: created.id, title: '失败版', script: 'boom' });
  } catch (error) {
    failed = String(error.message ?? error);
  }
  const afterFail = await gw.getMusicJob({ jobId: created.id });
  check('脚本报错返回 scoremill 原文', /bar 3.*expected 4\.0/u.test(failed), failed.slice(0, 160));
  check('失败不新增版本', afterFail.compositions.length === 2);
  check('stages.compose=error', afterFail.stages.compose.status === 'error');

  await gw.saveConfig({ musicPythonPath: noMidiPython });
  let noMidi = '';
  try {
    await gw.runMusicScore({ jobId: created.id, title: '空文件', script: 'nothing' });
  } catch (error) {
    noMidi = String(error.message ?? error);
  }
  check('没产出 score.mid 时给出明确错误', /score\.mid/u.test(noMidi), noMidi.slice(0, 160));
  await gw.saveConfig({ musicPythonPath: okPython });

  const peaks = await gw.musicPeaks({ jobId: created.id, scoreId: first.scoreId, buckets: 64 });
  check('谱曲版本可出波形', Array.isArray(peaks.peaks) && peaks.peaks.length === 64 && peaks.duration > 0, JSON.stringify(peaks).slice(0, 160));
  const exported = await gw.exportMusic({ jobId: created.id, scoreId: first.scoreId });
  check('乐谱包导出成功', exported.ok === true && /\.zip$/u.test(exported.file) && exported.scoreId === first.scoreId, JSON.stringify(exported).slice(0, 200));
  const zipPath = join(HOME, 'game-material-master', 'music-jobs', created.id, exported.file);
  check('乐谱包文件存在', (await stat(zipPath)).size > 0);
  check('乐谱包包含 MIDI / plan / compose.py', Array.isArray(exported.files) && exported.files.some((entry) => /score\.mid$/u.test(entry.path)) && exported.files.some((entry) => /plan\.md$/u.test(entry.path)) && exported.files.some((entry) => /compose\.py$/u.test(entry.path)), JSON.stringify(exported.files));

  section('4) 交给 Suno（mock，不真实计费）');
  await gw.saveConfig({ musicApiKey: 'sk-test', musicBaseUrl: base });
  let noConfirm = '';
  try {
    await gw.submitMusicScoreToSuno({ jobId: created.id, scoreId: first.scoreId });
  } catch (error) {
    noConfirm = String(error.message ?? error);
  }
  check('没有 confirm 时拒绝提交', /confirm/u.test(noConfirm) && /MIDI/u.test(noConfirm), noConfirm.slice(0, 160));
  const submitted = await gw.submitMusicScoreToSuno({ jobId: created.id, scoreId: first.scoreId, confirm: true });
  check('提交启动并带 scoreId', submitted.started === true && submitted.scoreId === first.scoreId && submitted.mode === 'cover', JSON.stringify(submitted).slice(0, 240));
  const rightAfter = await gw.getMusicJob({ jobId: created.id });
  check(
    '提交后立刻是 busy 或已有歌（界面据此开始轮询）',
    rightAfter.busy === true || (rightAfter.songs ?? []).length > 0,
    JSON.stringify({ busy: rightAfter.busy, songs: rightAfter.songs?.length, gens: rightAfter.generations?.map((g) => g.status) })
  );
  for (let i = 0; i < 50 && !requests.some((entry) => entry.path === '/v1/suno/generate/cover'); i++) await sleep(100);
  const uploadRequest = requests.find((entry) => entry.path === '/v1/suno/audio/upload');
  check('先把试听音频 multipart 上传给 Suno', uploadRequest !== undefined && /multipart\/form-data/.test(uploadRequest.contentType) && uploadRequest.bytes > 1000, JSON.stringify({ ct: uploadRequest?.contentType, bytes: uploadRequest?.bytes }));
  const sunoRequest = requests.find((entry) => entry.path === '/v1/suno/generate/cover');
  check('Suno 收到 cover 请求体并带参考音频 id', sunoRequest !== undefined && sunoRequest.body.cover_clip_id === 'upload-song-1' && sunoRequest.body.title === '第一版', JSON.stringify(sunoRequest?.body ?? {}).slice(0, 300));
  check('cover 带 audio_weight', typeof sunoRequest?.body.audio_weight === 'number' && sunoRequest.body.audio_weight > 0, String(sunoRequest?.body.audio_weight));
  check('cover duration 至少 10 秒', sunoRequest?.body.duration === 10, String(sunoRequest?.body.duration));
  check('Suno tags 用方案里的英文标签', String(sunoRequest?.body.tags).includes('chiptune') && String(sunoRequest?.body.tags).includes('battle'), String(sunoRequest?.body.tags));
  const settled = await waitIdle(created.id);
  check('Suno 生成完成并下载 2 首', settled.songs.length === 2 && settled.songs.every((song) => song.status === 'succeeded' && typeof song.localFile === 'string'), JSON.stringify(settled.songs).slice(0, 240));
  const generation = settled.generations.find((entry) => entry.scoreId === first.scoreId);
  check('generation 记录了来源 scoreId 与参考音频 id', generation !== undefined && generation.sourceClipId === 'upload-song-1', JSON.stringify({ scoreId: generation?.scoreId, sourceClipId: generation?.sourceClipId }));
  const submitAgain = await gw.submitMusicScoreToSuno({ jobId: created.id, scoreId: second.scoreId, confirm: true });
  check('已有歌曲时再提交必须 regenerate', submitAgain.started === false && /regenerate/u.test(submitAgain.reason ?? ''), JSON.stringify(submitAgain).slice(0, 200));
  const regenerate = await gw.submitMusicScoreToSuno({ jobId: created.id, scoreId: second.scoreId, confirm: true, regenerate: true });
  check('显式 regenerate 后可以再提交', regenerate.started === true);
  await waitIdle(created.id);

  // 版权通道：标准上传被拒 -> 需要用户确认 -> copyrightAudio:true 走付费通道
  uploadMode = 'copyright-reject';
  const needsConsent = await gw.submitMusicScoreToSuno({ jobId: created.id, scoreId: first.scoreId, confirm: true, regenerate: true });
  check('Suno 判定版权时返回 needsCopyrightConsent', needsConsent.started === false && needsConsent.needsCopyrightConsent === true && /版权/u.test(needsConsent.reason ?? ''), JSON.stringify(needsConsent).slice(0, 240));
  const consentCoverBefore = requests.filter((entry) => entry.path === '/v1/suno/generate/cover').length;
  const consent = await gw.submitMusicScoreToSuno({ jobId: created.id, scoreId: first.scoreId, confirm: true, regenerate: true, copyrightAudio: true });
  check('确认后走版权通道并提交 cover', consent.started === true && consent.copyrightAudio === true && consent.uploadedClipId === 'upload-song-copyright', JSON.stringify(consent).slice(0, 240));
  for (let i = 0; i < 50 && requests.filter((entry) => entry.path === '/v1/suno/generate/cover').length <= consentCoverBefore; i++) await sleep(100);
  const copyrightCover = requests.filter((entry) => entry.path === '/v1/suno/generate/cover').at(-1);
  check('版权音频作为 cover 参考', copyrightCover?.body.cover_clip_id === 'upload-song-copyright', JSON.stringify(copyrightCover?.body ?? {}).slice(0, 200));
  await waitIdle(created.id);
  uploadMode = 'ok';

  section('5) 验收 / 深链接 / 老任务迁移');
  const approved = await gw.setMusicApproved({ jobId: created.id, scoreId: first.scoreId, approved: true });
  check('按 scoreId 打通过', approved.compositions.find((entry) => entry.id === first.scoreId)?.approved === true);
  const link = await gw.runMusicScore({ jobId: created.id, title: '第三版', script: 'print("third")', label: '第三版' });
  check('谱曲 openUrl 带 stage=compose 与 score', String(link.openUrl).includes('dsh-gmm=1') && String(link.openUrl).includes('module=music') && String(link.openUrl).includes('stage=compose') && String(link.openUrl).includes(`score=${link.scoreId}`), link.openUrl);

  const oldDir = join(HOME, 'game-material-master', 'music-jobs', 'aoldjob1');
  await mkdir(join(oldDir, 'songs'), { recursive: true });
  await writeFile(join(oldDir, 'job.json'), JSON.stringify({
    id: 'aoldjob1', name: '老任务', createdAt: 1, updatedAt: 1,
    source: { kind: 'prompt', prompt: 'old', lyrics: '', note: '', title: '', tags: '', instrumental: true },
    settings: { engine: 'suno', mode: 'prompt', model: 'chirp-v6' },
    stages: { generate: { status: 'done' }, edit: { status: 'idle' }, export: { status: 'idle' } },
    generations: [], songs: [], versions: [], tools: [], exports: [], log: []
  }), 'utf8');
  const oldView = await gw.getMusicJob({ jobId: 'aoldjob1' });
  check('老任务默认 generate 且补出 compose 阶段', oldView.workflow === 'generate' && Array.isArray(oldView.compositions) && oldView.stages.compose !== undefined);

  section('6) 参数校验');
  await gw.saveConfig({ musicPythonPath: okPython });
  let badStage = '';
  try {
    await gw.setMusicApproved({ jobId: created.id, stage: 'nope', approved: true });
  } catch (error) {
    badStage = String(error.message ?? error);
  }
  check('未知阶段被拒绝', /未知阶段/u.test(badStage));
} catch (error) {
  console.error(error);
  failures.push('未捕获异常');
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(HOME, { recursive: true, force: true }).catch(() => undefined);
}

console.log(`\n共 ${checks} 项检查，${failures.length === 0 ? '全部通过。' : `失败 ${failures.length} 项：${failures.join('、')}`}`);
if (failures.length > 0) process.exit(1);
