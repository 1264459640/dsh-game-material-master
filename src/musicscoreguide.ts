/**
 * 谱曲模式的内置指南（中 / 英）。
 *
 * 内容改写自用户提供的 `scoremill-skill/SKILL.md` 与 scoremill 官方文档，
 * 并结合本插件的「方案先落盘 → 宿主跑脚本 → 本地渲染试听 → 逐版修改 →
 * 可选交 Suno」流程。scoremill 以 MIT 许可发布，特此致谢：
 * https://github.com/CharlesCNorton/scoremill
 *
 * 这份文件是给对话里的 agent 读的，不是用户手册。宿主通过
 * `getMusicScoreGuide` 返回它；界面「创作技巧」也直接展示。
 */

export interface MusicScoreGuideSource {
  name: string;
  url: string;
  license: string;
  note: string;
}

export const MUSIC_SCORE_GUIDE_SOURCES: MusicScoreGuideSource[] = [
  {
    name: "CharlesCNorton / scoremill",
    url: "https://github.com/CharlesCNorton/scoremill",
    license: "MIT",
    note: "文本记谱 → MIDI 的库与记谱约定；本指南的语法与避坑清单据此改写"
  },
  {
    name: "XIAODUOLU / Midra",
    url: "https://github.com/XIAODUOLU/Midra",
    license: "见原仓库",
    note: "「prompt-to-code MIDI、可编辑、再决定是否生成音频」的产品思路参考"
  }
];

const ZH = `# 游戏素材大师 · 谱曲模式指南（scoremill）

> 这份指南是给**对话里的 agent** 用的。目标：把用户的想法变成一份**可读、可改、
> 可试听**的 MIDI，用户满意后再可选交给 Suno 生成正式音频。
> scoremill 是 MIT 许可的文本记谱库（https://github.com/CharlesCNorton/scoremill）。

## 0. 固定流程（不要跳步）

1. \`getMusicJob({jobId})\` 读任务：用户原文、补充要求、纯音乐、审核模式、\`scorePlan\`。
2. 分析用户的想法，写一份**方案**（曲风、情绪、调性、BPM、拍号、段落表、配器、主题动机、
   力度弧、循环/收尾），用**用户的语言**在回答里输出。
3. \`saveMusicScorePlan({jobId, plan})\` 把方案落盘。
4. 审核模式 \`manual\`：**停在这里**等用户确认或改方案；\`auto\`：可以继续。
5. 写 \`compose.py\`（scoremill），调 \`runMusicScore({jobId, title, plan, script, label?})\`。
6. 宿主会跑 Python、解析 \`score.mid\`、渲染试听，返回 \`openUrl\`。把链接原样贴给用户，
   说清 BPM / 调性 / 时长 / 段落，让用户点开试听。
7. 用户提意见 → 改方案/脚本的**对应段落** → 再调 \`runMusicScore\`（\`basedOn\` 指上一版）。
8. 只有用户**明确要求**「用 Suno 生成正式版」时，才调
   \`submitMusicScoreToSuno({jobId, scoreId, confirm:true})\`。这会真实计费；先说明。
   提交后 \`game_material_wait\`，再把新的 \`openUrl\` 贴回来。

⚠️ **永远不要自动提交 Suno。** 谱曲和试听都是本地免费；Suno 才花钱。
⚠️ **每版都是新版本**：不要覆盖旧 MIDI/试听；用户可能想回到上一版。
⚠️ **报错按 scoremill 的小节号修**，不要整段重写；连续 3 次失败就停下说明原因。

## 1. 先分析，再规划（方案要写给人看）

在写任何音符之前，先回答这几个问题：

- **用途**：主题曲 / 战斗 / 菜单 / 环境床 / 循环 / 短 stinger / 过场。用途决定长度、
  情绪强度、能不能循环，比堆曲风词更重要。
- **情绪弧**：从什么情绪到什么情绪？哪一段是高潮？安静段落在哪里？
- **调性与主音**：大调/小调/调式；全曲尽量围绕一个主音，转调要写清目的。
- **速度与拍号**：BPM、4/4 还是 3/4 / 6/8；循环曲建议固定 BPM。
- **段落表**：每段名字、小节数、能量、配器变化。例：
  \`INTRO 8（p，古筝 + 垫音）→ MAIN 16（f，弦乐主题 + 鼓）→ CLIMAX 12（ff，全奏）→ CODA 6（mp，回到主音）\`。
- **配器**：GM 音色名 + program + 通道；一条通道一个音色，鼓在通道 9。
- **主题动机**：一句话说清旋律的性格（跳进/级进、节奏型、落音）。
- **循环/收尾**：循环曲要回到开头能接上；有结尾的曲子写清最后落哪个和弦。

**方案 JSON**（传给 \`saveMusicScorePlan\` / \`runMusicScore\`）：

\`\`\`json
{
  "summary": "给用户看的完整方案（用户语言，可多段）",
  "style": "仙侠、管弦、战斗配乐",
  "mood": "压抑到爆发，最后 unresolved",
  "key": "D minor / D 弗里几亚",
  "tempo": 150,
  "timeSignature": "4/4",
  "lengthBars": 42,
  "instrumental": true,
  "structure": [
    { "name": "INTRO", "bars": 8, "energy": "p", "description": "古筝提问，垫音铺底" },
    { "name": "MAIN", "bars": 16, "energy": "f", "description": "弦乐主题 + 鼓" }
  ],
  "instrumentation": [
    { "name": "弦乐", "program": 48, "channel": 1, "role": "主题" },
    { "name": "暖垫", "program": 89, "channel": 2, "role": "和声" }
  ],
  "motif": "D 为中心，三度与小三度争夺，最后落到 D",
  "notes": "循环曲，最后 2 小节回到开头",
  "sunoTags": "xianxia, orchestral battle, instrumental, erhu, taiko, 150 BPM, D minor, game soundtrack",
  "sunoPrompt": "Instrumental xianxia battle soundtrack, 150 BPM, D minor, 4/4. Intro sparse, main theme soaring strings, climax full orchestra and taiko.",
  "negativeTags": "vocals, edm drop"
}
\`\`\`

\`sunoTags\` / \`sunoPrompt\` / \`negativeTags\` 尽量用**英文**（Suno 更认英文标签），
其余字段可以用用户的语言。没有歌词时 \`instrumental\` 设 \`true\`。

## 2. scoremill 三十秒骨架

\`\`\`python
from scoremill import Song
import json

s = Song(tempo=120, time="4/4", key="Dm",
         humanize=2, expressive=True, pitch_range=(0, 127))

A = s.section("A")
lead = A.voice("lead", vel=60, octave=5, program=48, channel=1)   # 弦乐
lead.bars("!mf a4q d5q f#5h | e5q d5q bn4h |")
bass = A.voice("bass", vel=45, octave=2, program=89, channel=5)   # 垫音
bass.bars("!mp [d2 a2]w | [d2 a2]w |")
kit = A.drums(vel=70)
kit.bars("bdq bde sne bdq [sn hh]e hhe | bdq bde sne bdq hhe hhe |")

s.arrange("A")
s.save("score.mid")
print(json.dumps(s.report(), ensure_ascii=False))
\`\`\`

## 3. 三条铁律

1. **每个小节必须正好是该段拍号的拍数，并且以 \`|\` 结尾**。
2. **同一 section 里所有声部必须一样长**（短的用 \`rw\` 休止补齐）。
3. **一个 MIDI 通道 = 一个音色，全曲不变**；鼓固定通道 9。

## 4. 记谱速查

### 4.1 音高

- \`c4\` \`d4\` \`e4\` … 字母 + 八度；\`b\` 在 \`key="Dm"\` 里是 B♭，要还原写 \`bn\`，升号写 \`f#\`。
- 八度和时值都是 **sticky**：同一 voice 里 \`d4q e f\` 都是 4 八度、四分音符。
- 建议多声部密集写作时每个音都写全八度（\`e4\` 而不是 \`e\`）。

### 4.2 时值 / 休止 / 和弦 / 连音

| 写法 | 含义 |
|---|---|
| \`c4w\` \`c4h\` \`c4q\` \`c4e\` \`c4s\` \`c4t\` | 全 / 二 / 四 / 八 / 十六 / 三十二分音符 |
| \`c4q.\` | 附点四分 |
| \`r\` | 休止（时值 sticky；**永远写 \`rq\` / \`rh\` / \`rw\`**） |
| \`[c4 e g]h\` | 和弦 |
| \`{c4 d4 e4}q\` | 连音（成员平分这一拍） |
| \`+d5\` | 倚音（不带时值，音高写全） |
| \`c5h~\` | 连线；下一个音必须同音高；voice 末尾的 \`~\` 是自由延长 |
| \`c5q>\` \`c5q'\` \`c5q_\` \`c5q^\` \`c5q&\` \`c5q%\` | 重音 / 断奏 / 连奏 / 延长 / 滚奏 / 颤音（写在时值后面） |
| \`!pp\` … \`!fff\` | 力度（sticky） |
| \`cresc\` / \`dim\` | 渐强 / 渐弱；**必须落到下一个力度记号**，段落最后一小节也要落 |
| \`s.tempo_change("MAIN", 1, 150)\` | 该段从第 1 小节起 150 BPM |
| \`s.ritardando("CODA", 5, 8, 66)\` | 5→8 小节线性变化到 66 BPM |

### 4.3 鼓（通道 9）

\`\`\`python
kit = A.drums(vel=70)
kit.bars("bdq bde sne bdq [sn hh]e hhe | bdq bde sne bdq hhe hhe |")
\`\`\`

可用名字（前缀匹配，时值紧贴其后；叠击用方括号）：
\`bd bd2 sn esn rim clap lt mt ht lft hft hh hc ho hp cr cr2 sp ch rd rb cb tamb clave wood tri\`。

**名字和时值必须粘在一起**：\`bdq\` / \`bde\` / \`sne\`，不能写 \`bd q\`。

### 4.4 通道 / GM 音色

可用通道 0–8 + 10–15（9 固定鼓），一共 15 个音色。常用 GM program：

| 音色 | program | 音色 | program |
|---|---:|---|---:|
| 竖琴 | 46 | 弦乐 | 48 |
| 人声/合唱 | 52 | 铜管 | 61 |
| 定音鼓 | 47 | 暖垫 | 89 |
| 古筝/Koto | 107 | 尺八 | 77 |
| 竹笛 | 73 | 钢琴 | 0 |
| 贝斯 | 32–39 | 合成主音 | 80–87 |

## 5. 高频报错 → 改法

| 报错片段 | 原因 | 改法 |
|---|---|---|
| \`has 64.0 beats, expected 4.0 — over by 60.0 beats\` | 用空格拼小节，丢了 \`|\` | \`" | ".join(bars) + " |"\` |
| \`bar 9: has 0.0 beats, expected 4.0\` | 尾部已经有 \`|\`，又加了一个 | 只补空格，不要补竖线 |
| \`unrecognized token '|a5q'\` | 字符串直接粘在 \`|\` 后面 | 加一个空格 |
| \`voices differ in length\` | 某声部少写小节 | 用 \`rw |\` 补齐到最长声部 |
| \`cresc never reaches a dynamic mark\` | 写了 cresc 但后面没有力度记号 | 1–4 小节内落 \`!f\` 等 |
| \`cresc while an earlier one is still open\` | 上一个 cresc 没落目标力度 | 先收口再开 |
| \`tie: next note must repeat the pitch\` | \`~\` 后面不是同音高 | 删掉 \`~\` 或改成同音 |
| \`note would leave the range 21-108\` | 默认钢琴音域 | 构造时传 \`pitch_range=(0, 127)\` |
| \`unknown drum token 'e'\` | 鼓写成 \`bd q\` | 粘成 \`bdq\` |
| \`trailing partial bar\` | 最后没写 \`|\` | 补上 |

有些错误（cresc 未收口、声部不等长）要到 \`report()\` / \`save()\` 才触发；
写完一段就跑一次 \`s.report()\`。

## 6. 游戏配乐的建议

- **循环**：固定 BPM；最后 1–2 小节回到开头能接上；避免在接缝处留长混响尾。
- **短曲 / stinger**：30–90 秒，段落少（INTRO → MAIN → END），不要写完整主歌副歌。
- **战斗**：节奏明确、低频扎实；主题要在中高音区能听出来；不要让固定音型吃掉主题。
- **环境床**：弱旋律、少鼓、留出对白/音效频段。
- **力度弧**：引子 p → 主题 f → 高潮 ff → 尾声 mp；不要 16 小节全 ff。
- **重复段落靠配器/鼓/力度区分**，不要靠改旋律。
- **两个主题要能叠**：共享主音；对立写在一个具体的音（三度、三全音）上。
- **音区就是立场**：不要把两条旋律塞进同一八度，否则会硬撞。
- **扩大（augmentation）比换旋律有用**：\`stretch(theme, 2)\` + \`rebar(..., 4)\` 能得到更宽的高潮主题。

## 7. 脚本输出契约（宿主怎么跑）

- 脚本必须放在任务目录里由宿主执行；你只需要通过 \`runMusicScore\` 传 \`script\` 全文。
- **必须**在 cwd 里产出 \`score.mid\`：\`s.save("score.mid")\`。
- **不要**自己渲染音频、不要联网、不要写任务目录以外的文件。
- 推荐最后 \`print(json.dumps(s.report(), ensure_ascii=False))\`，宿主会把这段 JSON 存进 report。
- 建议 \`pitch_range=(0, 127)\`；鼓在通道 9；一条通道一个 program。
- 曲子控制在 **10 分钟以内**（宿主上限 600 秒；内置试听合成器上限 480 秒）。
- 需要随机时用固定种子（例如 \`random.Random(20)\`），保证同一份谱重复渲染一致。
- 出错时宿主会把 stderr 尾部原样返回给你；按小节号只改那一处。

## 8. 修改协议

用户说「太吵 / 太慢 / 鼓太多 / 主题不明显 / 第二段太长」时：

1. 先判断改**哪一段**、改什么（配器/力度/旋律/速度/段落长度）。
2. 改方案里的对应字段（段落表、配器、力度）与脚本里的对应小节。
3. 调 \`runMusicScore({jobId, ..., basedOn: "<上一版 scoreId>"})\`。
4. 在回答里说清「改了什么、为什么、听感上应该有什么变化」。
5. 不要顺手改用户没提的段落；不要整首重写。

## 9. 交给 Suno（可选，★计费）

- Suno **不接受 MIDI 原文件，但接受音频**。正确链路是：插件先把这一版 MIDI 渲染成
  试听音频（\`preview.mp3\` / \`preview.wav\`），上传到 \`/v1/suno/audio/upload\` 拿到参考
  song id，再走 **cover** 生成。这样 Suno 听到的是你的配器、节奏和段落，而不是只看文字标签。
- 标准音频上传免费；如果 Suno 判定音频有版权，需要走**付费版权通道**（会扣积分），
  必须由用户确认后传 \`copyrightAudio:true\`。
- 结果**不会逐音一致**；它是「按这段音频重新演奏/编曲」，不是把 MIDI 原样合成。
- 只有用户明确说「用 Suno 生成正式版 / 交给 Suno」才调：
  \`submitMusicScoreToSuno({jobId, scoreId, confirm:true, model?, regenerate?, copyrightAudio?, audioWeight?})\`
- 返回 \`needsCopyrightConsent:true\` 时，先把原因告诉用户，确认后再传 \`copyrightAudio:true\` 重试。
- 已有歌曲时再提交会再计费：先问用户，并传 \`regenerate:true\`。
- 提交后 \`game_material_wait\`；把新的 \`openUrl\` 贴回来，说清生成了几首。
- 原曲超过 360 秒时，Suno 只能按 360 秒提交；在回答里说明。
- 参考音频权重 \`audioWeight\` 默认 0.75；想更贴 MIDI 可以调高（0–1），想更像 Suno 的编曲可以调低。

## 10. 提交前自检

- [ ] 方案已保存，用户看得到；manual 模式已等用户确认。
- [ ] 每个 section 的声部等长；每小节拍数正确；最后有 \`|\`。
- [ ] 一条通道一个 program；鼓在通道 9。
- [ ] \`s.report()\` 的 bars 与方案一致（不一致要在回答里说明）。
- [ ] 没有卡音（\`note-off\` 成对）；没有空白段；主题能听出来。
- [ ] 力度弧有层次；循环曲最后能接回开头。
- [ ] 试听链接已贴给用户；没有伪造音频 URL，没有说「我听过了」。
`;

const EN = `# Game Material Master · Compose Mode Guide (scoremill)

> This guide is for **the agent in the conversation**. Goal: turn the user's idea into a
> **readable, editable, auditionable** MIDI, then optionally hand it to Suno for a produced track.
> scoremill is an MIT-licensed text-notation MIDI library
> (https://github.com/CharlesCNorton/scoremill).

## 0. Fixed flow (do not skip)

1. \`getMusicJob({jobId})\` — read the user's text, extra requirements, instrumental flag,
   review mode, and \`scorePlan\`.
2. Analyse the idea and write a **plan** (style, mood, key, BPM, meter, section map,
   instrumentation, motif, dynamic arc, loop/ending). Output it in the **user's language**.
3. \`saveMusicScorePlan({jobId, plan})\` — persist the plan.
4. Review mode \`manual\`: **stop here** and wait for confirmation. \`auto\`: continue.
5. Write \`compose.py\` (scoremill) and call \`runMusicScore({jobId, title, plan, script, label?})\`.
6. The host runs Python, parses \`score.mid\`, renders a preview, and returns \`openUrl\`.
   Paste the link verbatim; state BPM / key / duration / sections so the user can audition.
7. User feedback → change the **specific section** in the plan and script → call
   \`runMusicScore\` again with \`basedOn\` pointing at the previous version.
8. Only when the user **explicitly asks** for "Suno version" call
   \`submitMusicScoreToSuno({jobId, scoreId, confirm:true})\`. It costs credits; say so first.
   Then \`game_material_wait\` and paste the new \`openUrl\`.

⚠️ **Never auto-submit to Suno.** Composing and auditioning are local/free; Suno is paid.
⚠️ **Every revision is a new version**; never overwrite old MIDI/preview.
⚠️ **Fix the exact bar named by the error**; do not rewrite the whole piece. After 3 failures, stop and explain.

## 1. Analyse, then plan (the plan is for the user)

Before writing any notes, answer:

- **Use**: theme / battle / menu / ambience / loop / short stinger / cutscene. The use decides
  length, intensity, and loopability far more than genre words.
- **Emotional arc**: from what to what? Where is the climax? Where is the quiet section?
- **Key / tonic**: major, minor, or mode; keep one tonic unless a modulation has a purpose.
- **Tempo / meter**: BPM, 4/4 vs 3/4 / 6/8; loops should keep a fixed BPM.
- **Section map**: name, bars, energy, instrumentation changes. Example:
  \`INTRO 8 (p, koto + pad) → MAIN 16 (f, strings theme + drums) → CLIMAX 12 (ff, tutti) → CODA 6 (mp, back to tonic)\`.
- **Instrumentation**: GM name + program + channel; one program per channel; drums on channel 9.
- **Motif**: one sentence about the melodic character (leaps/steps, rhythm, landing note).
- **Loop / ending**: loops must connect back to the start; endings must state the final chord.

**Plan JSON** (for \`saveMusicScorePlan\` / \`runMusicScore\`):

\`\`\`json
{
  "summary": "The full plan in the user's language, may be multi-paragraph",
  "style": "xianxia, orchestral battle",
  "mood": "suppressed to explosive, unresolved ending",
  "key": "D minor / D phrygian",
  "tempo": 150,
  "timeSignature": "4/4",
  "lengthBars": 42,
  "instrumental": true,
  "structure": [
    { "name": "INTRO", "bars": 8, "energy": "p", "description": "koto question, pad bed" },
    { "name": "MAIN", "bars": 16, "energy": "f", "description": "strings theme + drums" }
  ],
  "instrumentation": [
    { "name": "strings", "program": 48, "channel": 1, "role": "theme" },
    { "name": "warm pad", "program": 89, "channel": 2, "role": "harmony" }
  ],
  "motif": "D-centric, third vs minor third, resolves to D",
  "notes": "loop track; last 2 bars lead back to the top",
  "sunoTags": "xianxia, orchestral battle, instrumental, erhu, taiko, 150 BPM, D minor, game soundtrack",
  "sunoPrompt": "Instrumental xianxia battle soundtrack, 150 BPM, D minor, 4/4. Intro sparse, main theme soaring strings, climax full orchestra and taiko.",
  "negativeTags": "vocals, edm drop"
}
\`\`\`

Write \`sunoTags\` / \`sunoPrompt\` / \`negativeTags\` in **English** (Suno understands English tags best);
the other fields may be in the user's language. Set \`instrumental: true\` when there are no vocals.

## 2. scoremill in 30 seconds

\`\`\`python
from scoremill import Song
import json

s = Song(tempo=120, time="4/4", key="Dm",
         humanize=2, expressive=True, pitch_range=(0, 127))

A = s.section("A")
lead = A.voice("lead", vel=60, octave=5, program=48, channel=1)   # strings
lead.bars("!mf a4q d5q f#5h | e5q d5q bn4h |")
bass = A.voice("bass", vel=45, octave=2, program=89, channel=5)   # pad
bass.bars("!mp [d2 a2]w | [d2 a2]w |")
kit = A.drums(vel=70)
kit.bars("bdq bde sne bdq [sn hh]e hhe | bdq bde sne bdq hhe hhe |")

s.arrange("A")
s.save("score.mid")
print(json.dumps(s.report(), ensure_ascii=False))
\`\`\`

## 3. Three iron rules

1. **Every bar must contain exactly the meter's beats and end with \`|\`.**
2. **All voices in a section must have the same length** (pad short ones with \`rw\`).
3. **One MIDI channel = one program for the whole piece**; drums are channel 9.

## 4. Notation cheat sheet

### 4.1 Pitch

- \`c4\` \`d4\` \`e4\` … letter + octave; with \`key="Dm"\`, \`b\` is B♭. Write \`bn\` for B natural, \`f#\` for F♯.
- Octave and duration are **sticky** within a voice: \`d4q e f\` are all octave 4 quarter notes.
- In dense multi-voice writing, write the octave on every note (\`e4\`, not \`e\`).

### 4.2 Duration / rests / chords / tuplets

| Syntax | Meaning |
|---|---|
| \`c4w\` \`c4h\` \`c4q\` \`c4e\` \`c4s\` \`c4t\` | whole / half / quarter / eighth / sixteenth / 32nd |
| \`c4q.\` | dotted quarter |
| \`r\` | rest (duration is sticky; **always write \`rq\` / \`rh\` / \`rw\`**) |
| \`[c4 e g]h\` | chord |
| \`{c4 d4 e4}q\` | tuplet (members share the beat) |
| \`+d5\` | grace note (no duration; write the full pitch) |
| \`c5h~\` | tie; the next note must repeat the pitch; a trailing \`~\` is a free fermata |
| \`c5q>\` \`c5q'\` \`c5q_\` \`c5q^\` \`c5q&\` \`c5q%\` | accent / staccato / legato / tenuto / roll / trill (after the duration) |
| \`!pp\` … \`!fff\` | dynamics (sticky) |
| \`cresc\` / \`dim\` | crescendo / diminuendo; **must land on a dynamic**; close it even in the last bar |
| \`s.tempo_change("MAIN", 1, 150)\` | section starts at 150 BPM from bar 1 |
| \`s.ritardando("CODA", 5, 8, 66)\` | linear 5→8 bar change to 66 BPM |

### 4.3 Drums (channel 9)

\`\`\`python
kit = A.drums(vel=70)
kit.bars("bdq bde sne bdq [sn hh]e hhe | bdq bde sne bdq hhe hhe |")
\`\`\`

Names (prefix match, duration attached; stack with brackets):
\`bd bd2 sn esn rim clap lt mt ht lft hft hh hc ho hp cr cr2 sp ch rd rb cb tamb clave wood tri\`.

**Name and duration must be glued**: \`bdq\` / \`bde\` / \`sne\`, never \`bd q\`.

### 4.4 Channels / GM programs

Channels 0–8 + 10–15 (9 is drums) = 15 programs. Common GM programs:

| Instrument | program | Instrument | program |
|---|---:|---|---:|
| Harp | 46 | Strings | 48 |
| Choir | 52 | Brass | 61 |
| Timpani | 47 | Warm pad | 89 |
| Koto | 107 | Shakuhachi | 77 |
| Flute | 73 | Piano | 0 |
| Bass | 32–39 | Synth lead | 80–87 |

## 5. Common errors → fixes

| Error fragment | Cause | Fix |
|---|---|---|
| \`has 64.0 beats, expected 4.0 — over by 60.0 beats\` | bars joined without \`|\` | \`" | ".join(bars) + " |"\` |
| \`bar 9: has 0.0 beats, expected 4.0\` | already ended with \`|\`, added another | add a space, not a barline |
| \`unrecognized token '|a5q'\` | string glued to \`|\` | add a space |
| \`voices differ in length\` | a voice is short | pad with \`rw |\` |
| \`cresc never reaches a dynamic mark\` | no target dynamic | add \`!f\` within 1–4 bars |
| \`cresc while an earlier one is still open\` | previous cresc not closed | close it first |
| \`tie: next note must repeat the pitch\` | \`~\` followed by a different pitch | remove \`~\` or repeat the pitch |
| \`note would leave the range 21-108\` | default piano range | pass \`pitch_range=(0, 127)\` |
| \`unknown drum token 'e'\` | wrote \`bd q\` | glue to \`bdq\` |
| \`trailing partial bar\` | missing final \`|\` | add it |

Some errors (open cresc, unequal voices) only surface at \`report()\` / \`save()\`;
call \`s.report()\` after each section.

## 6. Game-music guidance

- **Loops**: fixed BPM; last 1–2 bars lead back to the top; avoid a long reverb tail at the seam.
- **Short cues / stingers**: 30–90s, few sections (INTRO → MAIN → END).
- **Battle**: clear rhythm, solid low end; the theme must be audible in the mid/high register;
  don't let an ostinato eat the theme.
- **Ambience**: weak melody, little percussion, leave room for dialogue/SFX.
- **Dynamic arc**: intro p → theme f → climax ff → coda mp; don't stay ff for 16 bars.
- **Differentiate repeated sections with orchestration/drums/dynamics**, not new melodies.
- **Two themes must stack**: share a tonic; write the conflict on a specific note (third, tritone).
- **Register is stance**: don't put two melodies in the same octave; they will collide.
- **Augmentation beats new material**: \`stretch(theme, 2)\` + \`rebar(..., 4)\` widens a climax theme.

## 7. Script contract (how the host runs it)

- You pass the full \`script\` via \`runMusicScore\`; the host writes and runs it in the job directory.
- **Must** produce \`score.mid\` in the cwd: \`s.save("score.mid")\`.
- **Do not** render audio yourself, access the network, or write outside the job directory.
- Recommended: end with \`print(json.dumps(s.report(), ensure_ascii=False))\`; the host stores that JSON.
- Use \`pitch_range=(0, 127)\`; drums on channel 9; one program per channel.
- Keep the piece under **10 minutes** (host cap 600s; built-in preview synth cap 480s).
- Use a fixed seed for any randomness (\`random.Random(20)\`), so re-renders match.
- On failure the host returns the stderr tail; fix the exact bar.

## 8. Revision protocol

When the user says "too loud / too slow / too many drums / theme not clear / second section too long":

1. Decide **which section** and what to change (orchestration/dynamics/melody/tempo/length).
2. Change the plan fields and the matching bars in the script.
3. Call \`runMusicScore({jobId, ..., basedOn: "<previous scoreId>"})\`.
4. Explain what changed, why, and what the user should hear differently.
5. Don't change sections the user didn't mention; don't rewrite the whole piece.

## 9. Handing to Suno (optional, paid)

- Suno **does not accept MIDI files, but it does accept audio**. The correct chain is: the plugin
  renders this version's MIDI to a preview (\`preview.mp3\` / \`preview.wav\`), uploads it to
  \`/v1/suno/audio/upload\` to get a reference song id, and then generates a **cover**. Suno therefore
  hears your instrumentation, rhythm, and structure instead of only text tags.
- Standard audio upload is free. If Suno flags the audio as copyrighted, the **paid copyright upload
  channel** is required (credits are deducted); only use it after the user confirms and pass
  \`copyrightAudio:true\`.
- The result is **not note-for-note**; it is a re-performance / re-arrangement based on that audio.
- Only call this when the user explicitly asks for a Suno version:
  \`submitMusicScoreToSuno({jobId, scoreId, confirm:true, model?, regenerate?, copyrightAudio?, audioWeight?})\`.
- If it returns \`needsCopyrightConsent:true\`, explain why to the user first; retry with
  \`copyrightAudio:true\` only after confirmation.
- If songs already exist, another batch costs credits: ask first and pass \`regenerate:true\`.
- After submitting, \`game_material_wait\`; paste the new \`openUrl\` and say how many songs were produced.
- If the piece is longer than 360s, Suno is submitted at 360s; state that in the answer.
- \`audioWeight\` defaults to 0.75; raise it (0–1) to stay closer to the MIDI, lower it to let Suno
  arrange more freely.

## 10. Pre-submit checklist

- [ ] Plan saved and visible to the user; manual mode waited for confirmation.
- [ ] Every section's voices are equal length; every bar has the right beats; final \`|\`.
- [ ] One program per channel; drums on channel 9.
- [ ] \`s.report()\` bars match the plan (if not, explain in the answer).
- [ ] No stuck notes (note-off pairs); no empty sections; the theme is audible.
- [ ] The dynamic arc has layers; loops connect back to the start.
- [ ] The preview link is posted; no fake audio URLs; never claim you listened.
`;

export function musicScoreGuide(lang: "zh" | "en" | string | undefined): string {
  return String(lang ?? "zh").toLowerCase().startsWith("en") ? EN : ZH;
}

export function musicScoreGuidePayload(lang: "zh" | "en" | string | undefined): {
  lang: "zh" | "en";
  guide: string;
  sources: MusicScoreGuideSource[];
} {
  const normalized = String(lang ?? "zh").toLowerCase().startsWith("en") ? "en" : "zh";
  return {
    lang: normalized,
    guide: normalized === "en" ? EN : ZH,
    sources: MUSIC_SCORE_GUIDE_SOURCES.map((entry) => ({ ...entry }))
  };
}
