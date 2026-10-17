/**
 * 内置音乐创作指南（模块七）。
 *
 * ## 来源与许可
 *
 * 本文件里的方法论提炼自 **bitwize-music-studio/claude-ai-music-skills**
 * （https://github.com/bitwize-music-studio/claude-ai-music-skills），
 * 该仓库以 **CC0-1.0** 释出（Public Domain）。我们只吸收了其中与「写提示词 /
 * 写歌词 / 选模型 / 定生成设置 / 母带响度目标」有关的方法论，并结合「游戏音乐」
 * 的用法（循环、短曲、纯音乐、导出）改写为中文 / 英文两版，没有搬运原仓库的
 * 代码或长段原文。原仓库版权归其作者所有，特此致谢。
 *
 * ## 为什么放在宿主侧
 *
 * 对话里的 agent 通过 `game_material_call({method:'getMusicGuide'})` 读取它。
 * 放在宿主侧的好处是：界面换语言不影响它、模型每次都能拿到**同一份**经过整理
 * 的清单，而不是靠模型记性。客户端只负责把 `guide` 原样显示在「创作技巧」里。
 */

export interface MusicGuideSource {
  name: string;
  url: string;
  license: string;
  note: string;
}

export const MUSIC_GUIDE_SOURCES: MusicGuideSource[] = [
  {
    name: "bitwize-music-studio / claude-ai-music-skills",
    url: "https://github.com/bitwize-music-studio/claude-ai-music-skills",
    license: "CC0-1.0",
    note: "音乐提示词工程、歌词写作与评审、Suno 模型选择、母带响度目标等方法论来源"
  }
];

const ZH = `# 游戏素材大师 · 音乐创作指南

> 这份指南是给你（对话里的 agent）用的，不是给用户看的操作手册。目标：把用户的一句话
> 灵感或一整首歌词，变成**能直接提交给谱乐 AI、并且适合游戏使用**的提示词与参数。
> 方法论来源：bitwize-music-studio/claude-ai-music-skills（CC0-1.0）。

## 0. 先做什么

1. 先读任务：\`getMusicJob({jobId})\`，看清 \`source\`（用户原文）、\`source.note\`（补充要求）、
   \`source.kind\`（灵感 / 完整歌词）、\`settings\`、\`reviewMode\`。
2. 判断用途：主题曲 / 战斗 / 菜单 / 环境床 / 循环 / 短 stinger / 宣传曲。
   用途决定「要不要人声、多长、能不能循环」，比风格词更重要。
3. 判断输入：用户给了**完整歌词**时，歌词是权威文本，不要重写；只在断句、结构标签、
   发音拼写上做最小修正，并在回答里说明改了什么。只给灵感时才由你写歌词。
4. 再决定引擎与模式（见第 3 节），最后才提交。不要为了「看看」重复提交。

## 1. 风格提示词（Style Prompt）怎么写

**结构（按顺序，用句号/逗号分隔，不要堆同义词）：**

\`[人声描述]. [流派 + 2–3 个限定词]. [编制与节奏]. [制作/年代]\`

- **人声描述放最前**：男/女声、音域、质感（例如 "Male baritone, gritty, intimate"）。
  纯音乐就写 "Instrumental, no vocals"。
- **流派 2–3 个就够**：越具体越好，但 5 个以上会互相稀释。例：
  "dark synthwave, retro-futuristic, mid-tempo"。
- **编制写 2–3 件真正听得到的乐器**，不要列一整个采样库。
- **节奏/密度要明确**：BPM 或 "midtempo / driving / sparse"；不写的话模型会自己猜，
  经常猜成又慢又长。
- **制作/年代**一句话即可（"modern clean production" / "80s analog warmth"）。
- **不要写真实艺人 / 乐队名**：平台会过滤/改写，且没有必要——用流派 + 编制 + 质感表达。
- 不要写 "no drums" 这种内联否定；要排除的元素放到 \`negative_tags\`（最多 2–4 个裸元素：
  \`drums\`, \`electric guitar\`, \`autotune\`，不要带 "no"）。

**长度**：Suno 的 prompt 模式只有 500 字符；需要更长的结构化描述时改用 \`custom\`
（tags 最多 1000）。不要为了塞词把一句话写成同义词堆。

## 2. 歌词怎么写 / 怎么检查

**歌词框里只能有：真正的歌词 + 结构标签。** Suno 会把括号里的制作说明也唱出来，
所以 \`(Machine-gun snare)\`、\`(Verse 1)\`、\`(Instrumental break)\` 这类内容一律不要写；
器乐段只用 \`[Instrumental]\` / \`[Guitar Solo]\` 这种标签。

**结构标签**：\`[Intro]\` \`[Verse]\` \`[Pre-Chorus]\` \`[Chorus]\` \`[Bridge]\`
\`[Outro]\` \`[End]\`；器乐段用 \`[Instrumental]\` / \`[Break]\` / \`[Guitar Solo]\`。
每段可以在标签后加 1–2 个表演提示（\`[Verse 1 - cold regal]\`），但每段括号描述
最多 3 个，多了会变成噪音。\`[End]\` 是最强的收尾信号。

**质量检查（精简 13 点）：**

1. 押韵：连续两行不押同一个词、不自己押自己、不硬凑。
2. 重音：强拍落在实词上；读起来别倒字。
3. POV / 时态：全曲一致（我 / 你 / 他，过去 / 现在）。
4. 段落长度：主歌通常 4–8 行，副歌 2–6 行；超过就先删最弱的一句。
5. 词数 vs 目标时长：普通歌曲 200–400 词（嘻哈可到 600）；太短会显得空。
6. 副歌钩子：前两行就要能记住；不要用四行铺垫才到钩子。
7. 主歌→副歌回声：别把副歌第一句写成主歌最后一句的同义重复。
8. 发音：同形异音词（live / read / lead / wind / tear / bass）、专名、缩写、生造
   缩写在 Suno 里都可能唱错；必要时用音标拼写（例如 "ree-ad"）。
9. 占位符：不允许 \`[TODO]\`、\`[PLACEHOLDER]\`、模板句。
10. 陈词滥调：heart of gold / burning bright 这类能换就换。
11. 语言一致：中文歌词就用中文写，结构标签仍用英文（Suno 认英文标签）。
12. 敏感内容：遵守平台条款；不要写真实艺人模仿、仇恨/骚扰内容。
13. 可唱性：按目标 BPM 朗读一遍，拗口的地方改短句。

## 3. 选引擎 / 选模式（谱乐 AI）

| 场景 | 推荐 | 说明 |
|---|---|---|
| 默认、完成度优先 | **Suno · chirp-v6** | 最稳；每次提交返回 2 首；短灵感用 \`prompt\`，有歌词/结构化风格用 \`custom\` |
| 想要更有个性、探索声音 | **Suno · chirp-v6-wild** | 更不可控；先用 wild 找感觉，再用 v6 重做（Cover）是常见流程 |
| 草稿 / 快速试 | **Suno · chirp-v6-mini** | 更快更省；最终成品别用它 |
| 纯音乐 / 游戏循环 | **Suno custom（instrumental）** 或 **Mureka instrumental** 或 **ACE-Step** | ACE-Step 能明确给 BPM / 调式 / 拍号，最适合循环与节奏固定的关卡 |
| 需要指定 BPM / 调式 / 拍号 | **ACE-Step custom** | 文档支持 bpm 30–300、key_scale、time_signature、vocal_language |
| 想换一种味道 | **Mureka** | prompt / custom / instrumental；n 可 1–3 |
| 需要较高音频质量、明确采样率/码率 | **MiniMax music-3.0** | 需要提示词 + 歌词（纯音乐可只给提示词） |
| 基于已有歌继续 | **Suno cover / extend / mashup / sample / concat** | 需要已有歌曲 id；先 \`listMusicHistory\` 或从当前任务找 |

**Suno 生成设置的经验值：**

- \`style_weight\` 0.5–0.8（越高越贴 tags）；\`weirdness_constraint\` 0.2–0.5；
- \`aug_creativity\` 0–4：调高让同批差异更大；
- \`is_max_mode\`：超过 ~2 分钟、Cover、声音一致性要求高时开；积分翻倍；
- \`duration\` 10–360 秒；不够就靠结构标签/段落控制，别硬塞；
- \`negative_tags\` 2–4 个裸元素。

**提交前再确认：**

- 标题非空（custom 类端点必填；80 字符内）。
- lyrics / tags / prompt 没有超过引擎上限（Suno prompt 500 / lyrics 5000 / tags 1000；
  Mureka lyrics 3000；MiniMax prompt 2000 / lyrics 3000）。
- 纯音乐时不要把歌词塞进去（Suno 可以 instrumental + 空歌词；Mureka 用 instrumental 端点；
  MiniMax 用 instrumental=true；ACE-Step 用 instrumental=true 或 \`[inst]\`）。
- 一次提交是**真实计费**的；已经有一批歌时，再提交必须由用户明确同意，并传
  \`regenerate:true\`。失败重试也一样会再计费。

## 4. 游戏音乐的特殊要求

- **循环**：先生成略长，再在编辑界面裁掉头尾、加短淡入淡出，保证首尾能接上；
  纯音乐优先，人声循环容易在接缝处露馅。
- **短曲 / stinger**：30–90 秒；段落少（\`[Intro] → [Main Theme] → [End]\`），
  不要写完整主歌副歌。Suno 可以用 \`prompt\` 里写 "short, concise"。
- **环境床**：弱旋律、少鼓、不要大起大落；留出对白/音效的频段。
- **战斗**：节奏明确、BPM 稳定；用 ACE-Step 指定 BPM 更稳。
- **菜单 / 主题**：可以有记忆点，但不要比游戏音效更抢。
- **命名**：导出文件名用「用途_情绪_版本」，例如 \`battle_tense_v1.mp3\`，方便进引擎。

## 5. 后期处理（本地 ffmpeg，免费）

- **裁剪**：去掉开头静音 / 尾巴噪声；循环曲裁到小节边界（按 BPM 算：4/4 一小节 = 240/BPM 秒）。
- **音量**：优先用「标准化」而不是硬拉增益；硬增益会削波。
- **淡入淡出**：循环曲接缝、短曲结尾、stinger 都需要；0.2–1.5 秒通常够。
- **响度目标**：流媒体默认 **-14 LUFS / -1 dBTP**；游戏内音乐按你的引擎混音总线再定
  （常见 -16 左右，但以项目混音为准）。不要在插件里假装「已经母带」——这里只做
  裁剪 / 增益 / 淡入淡出 / loudnorm。
- 处理后的每个结果都是**新版本**，原曲永远保留；可以反复试听、比较。

## 6. 对话里的交付方式

1. 生成完成后，把工具返回的 \`openUrl\` **原样**贴成 Markdown 链接，例如
   \`[回到音乐编辑](http://…/?dsh-gmm=1&module=music&job=a…&stage=generate)\`。
2. 说清楚：生成了几首、用了哪个引擎/模式、是否做了后期、下一步建议。
3. **不要伪造音频 URL**，不要说「我听过了」；你只能看元数据、歌词与用户反馈。
4. 审核模式 \`manual\`：生成后先贴链接并停下，等用户明确说「通过」再继续；
   \`auto\`：自己核对状态后继续，但失败/再生成仍要找用户确认（会再计费）。
5. 不要调用其它模块的工具（八方向图 / 图片 / 骨骼 / 地图）来做音乐任务。`;

const EN = `# Game Material Master · Music Creation Guide

> This guide is for you (the agent in the conversation), not an end-user manual. Goal: turn a
> one-line idea or a full set of lyrics into prompts and settings that can be submitted to
> Puyue AI and are actually suitable for games.
> Methodology adapted from bitwize-music-studio/claude-ai-music-skills (CC0-1.0).

## 0. Before anything else

1. Read the job: \`getMusicJob({jobId})\` — inspect \`source\` (the user's original text),
   \`source.note\` (extra requirements), \`source.kind\` (idea vs. full lyrics),
   \`settings\`, and \`reviewMode\`.
2. Decide the use: theme / battle / menu / ambience / loop / short stinger / promo.
   The use decides vocals, length, and loopability far more than genre words do.
3. Decide the input: if the user gave **full lyrics**, treat them as authoritative. Do not
   rewrite; only fix line breaks, section tags, and phonetic spelling, and say what changed.
   Write lyrics yourself only when the user gave an idea.
4. Then choose the engine and mode (section 3). Submit only once. Never submit again just to
   "check" — every submission costs credits.

## 1. Style prompt

**Structure (in order, separated by periods/commas; no synonym piles):**

\`[vocal description]. [genre + 2–3 qualifiers]. [instrumentation and rhythm]. [production/era]\`

- **Vocals first**: gender, range, texture ("Male baritone, gritty, intimate"). For
  instrumental: "Instrumental, no vocals".
- **2–3 genre terms**: specific beats generic, but 5+ dilute each other.
- **2–3 instruments you can actually hear**, not a sample-library dump.
- **State tempo/density**: BPM or "midtempo / driving / sparse". If you leave it open, the
  model often guesses slow, sparse, and long.
- **Production/era** in one phrase ("modern clean production" / "80s analog warmth").
- **Never use real artist/band names**: the platform filters or rewrites them. Describe the
  genre, instrumentation, and texture instead.
- Do not write inline negations like "no drums"; put exclusions in \`negative_tags\` (2–4 bare
  elements: \`drums\`, \`electric guitar\`, \`autotune\` — no "no").

**Length**: Suno prompt mode is limited to 500 characters. For a longer structured
description use \`custom\` (tags up to 1000).

## 2. Lyrics: writing and QC

**The lyrics box may contain only actual lyrics and section tags.** Suno sings everything
else, so \`(Machine-gun snare)\`, \`(Verse 1)\`, and \`(Instrumental break)\` will be sung.
Use tags only: \`[Instrumental]\`, \`[Guitar Solo]\`.

**Section tags**: \`[Intro]\` \`[Verse]\` \`[Pre-Chorus]\` \`[Chorus]\` \`[Bridge]\`
\`[Outro]\` \`[End]\`; instrumental tags: \`[Instrumental]\` / \`[Break]\` / \`[Guitar Solo]\`.
Add 1–2 performance cues per section (\`[Verse 1 - cold regal]\`), but no more than 3
bracketed descriptors per section. \`[End]\` is the strongest stop signal.

**Condensed 13-point QC:**

1. Rhyme: no repeated end words back-to-back, no self-rhymes, no forced rhymes.
2. Prosody: stressed syllables land on strong beats; read it aloud.
3. POV/tense: consistent throughout.
4. Section length: verses usually 4–8 lines, choruses 2–6; cut the weakest line first.
5. Word count vs. target duration: 200–400 words for a normal song (up to 600 for hip-hop).
6. Hook: the first two lines of the chorus should be memorable.
7. Verse→chorus echo: don't restate the chorus in the verse's last line.
8. Pronunciation: homographs (live / read / lead / wind / tear / bass), proper nouns,
   acronyms, invented contractions; use phonetic spelling when needed.
9. No placeholders: no \`[TODO]\` / \`[PLACEHOLDER]\` / template lines.
10. Clichés: replace "heart of gold" / "burning bright" when possible.
11. Language: keep the lyric language consistent; section tags stay in English.
12. Content policy: no real-artist imitation, hate, or harassment.
13. Singability: read at the target BPM; shorten awkward lines.

## 3. Choose engine / mode (Puyue AI)

| Situation | Recommended | Notes |
|---|---|---|
| Default, best finish | **Suno · chirp-v6** | Two songs per submission; use \`prompt\` for short ideas, \`custom\` when lyrics/tags exist |
| Explore a sound | **Suno · chirp-v6-wild** | Less predictable; a common workflow is wild first, then v6 Cover |
| Sketch / cheap | **Suno · chirp-v6-mini** | Faster/cheaper; not for final releases |
| Instrumental / game loop | **Suno custom (instrumental)**, **Mureka instrumental**, or **ACE-Step** | ACE-Step can pin BPM/key/time signature — best for loops |
| Fixed BPM/key/meter | **ACE-Step custom** | bpm 30–300, key_scale, time_signature, vocal_language |
| Different flavor | **Mureka** | prompt / custom / instrumental; n = 1–3 |
| Higher audio quality / explicit sample rate | **MiniMax music-3.0** | Prompt + lyrics (instrumental can skip lyrics) |
| Continue an existing song | **Suno cover / extend / mashup / sample / concat** | Requires a song id; use \`listMusicHistory\` or the current job |

**Suno setting heuristics:** \`style_weight\` 0.5–0.8, \`weirdness_constraint\` 0.2–0.5,
\`aug_creativity\` 0–4, \`is_max_mode\` for >2:00 / covers / consistency (2× credits),
\`duration\` 10–360s, 2–4 bare \`negative_tags\`.

**Before submitting:** title non-empty (≤80 chars for custom endpoints); prompt/lyrics/tags
within limits (Suno prompt 500 / lyrics 5000 / tags 1000; Mureka lyrics 3000; MiniMax prompt
2000 / lyrics 3000); instrumental tracks don't carry lyrics (Suno can be instrumental with
empty lyrics; Mureka has its own endpoint; MiniMax uses instrumental=true; ACE-Step uses
instrumental=true or \`[inst]\`). Every submission costs credits; after songs exist, another
batch requires explicit user consent and \`regenerate:true\`.

## 4. Game-specific guidance

- **Loops**: generate a little long, trim the head/tail in the editor, add short fades so the
  loop point is seamless; prefer instrumental.
- **Short cues / stingers**: 30–90s, fewer sections (\`[Intro] → [Main Theme] → [End]\`);
  "short, concise" in the prompt helps.
- **Ambience**: weak melody, little percussion, leave room for dialogue/SFX.
- **Battle**: steady tempo and clear rhythm; ACE-Step with a fixed BPM is more reliable.
- **Menu/theme**: memorable but not louder than gameplay SFX.
- **Naming**: \`use_mood_version\`, e.g. \`battle_tense_v1.mp3\`.

## 5. Post-processing (local ffmpeg, free)

- **Trim** silence/noise; for loops, cut on bar boundaries (4/4 bar = 240/BPM seconds).
- Prefer **normalize** over raw gain; raw gain clips.
- **Fade in/out** for loop seams, endings, stingers; 0.2–1.5s is usually enough.
- **Loudness**: streaming default **-14 LUFS / -1 dBTP**; in-game music depends on your
  engine's mix bus (often around -16, but the project mix wins). Do not claim the plugin
  "mastered" anything — it only trims / gains / fades / loudness-normalizes.
- Every processed result is a **new version**; the original is always kept.

## 6. Delivering in the chat

1. After generation, post the tool's \`openUrl\` **verbatim** as a Markdown link, e.g.
   \`[Back to music editing](http://…/?dsh-gmm=1&module=music&job=a…&stage=generate)\`.
2. State how many songs, which engine/mode, whether you processed them, and what to do next.
3. **Never invent audio URLs** and never claim you listened; you only see metadata, lyrics,
   and user feedback.
4. Review mode \`manual\`: post the link and stop until the user explicitly approves.
   \`auto\`: verify and continue, but still ask before any paid retry/regeneration.
5. Do not use other modules' tools for music tasks.`;

export function musicGuide(lang: "zh" | "en" | string | undefined): string {
  return String(lang ?? "zh").toLowerCase().startsWith("en") ? EN : ZH;
}

export function musicGuidePayload(lang: "zh" | "en" | string | undefined): {
  lang: "zh" | "en";
  guide: string;
  sources: MusicGuideSource[];
} {
  const normalized = String(lang ?? "zh").toLowerCase().startsWith("en") ? "en" : "zh";
  return {
    lang: normalized,
    guide: normalized === "en" ? EN : ZH,
    sources: MUSIC_GUIDE_SOURCES.map((entry) => ({ ...entry }))
  };
}
