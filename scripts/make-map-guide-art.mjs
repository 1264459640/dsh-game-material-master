#!/usr/bin/env node
/**
 * 地图编辑器（模块六）「素材说明」窗口的**三张示例图生成器**。
 *
 *   node scripts/make-map-guide-art.mjs            # 生成并写回 src/client.ts 的标记块
 *   node scripts/make-map-guide-art.mjs --check    # 自检：确定性 + 「写进去的那一份是最新的」
 *   node scripts/make-map-guide-art.mjs --out=DIR  # 顺带把三张 PNG 落到 DIR（人眼验收用）
 *
 * ## 为什么要把 PNG 变成 base64 塞进 `src/client.ts`
 *
 * 浏览器半区（`src/client.ts`）必须是**经典脚本**（不能有 import / export），宿主也没有
 * 「随便给个静态文件」的路由 —— 所以说明图只能以内联 data URI 的形式跟着束走。
 * 三张图合计约 3 KB，base64 之后约 4 KB，比再开一条宿主路由（改 wire / 网关 / 重启 DSH）
 * 便宜得多。
 *
 * ## 两个必须钉住的不变量
 *
 * 1. **确定性**：同一份代码两次生成必须逐字节一致（否则每次跑这个脚本都会改一大段
 *    base64，diff 里全是噪声）。
 * 2. **写进去的那一份 == 生成器现在产出的那一份**：图不是手改的，但块会被 `--check`
 *    比出来 —— 图改了却忘了跑生成器，界面上的说明图就和代码对不上了。
 *
 * 表里除了图本身还带 `cols` / `rows` / `cell` / `sub`：界面**按这几个数现算**网格线的
 * 位置和图注里的数字，所以「图是几列几行、一格多少像素」只有一个来源（这里）。
 *
 * ⚠️ 这个脚本 import 的是 `lib/`，所以改了 `src/mapsamplegen.ts` 要先 `npm run build`。
 *
 * ⚠️ 还有一条**只在模块六才成立**的约束：写进 `src/client.ts` 的那段文字会被自检的
 * 术语黑名单扫到（`chunk` / `Tiled` 这类词按文本命中）。base64 是随机字母，理论上可能
 * 碰巧拼出这些词，所以生成前**显式断言一次**，碰到了就直接失败、换一张图重来 ——
 * 让它在生成时炸，而不是在半年后的自检里莫名其妙地红。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const CLIENT = join(REPO, "src", "client.ts");

/** 标记块（`src/client.ts` 里那一段被生成器整块覆盖的内容；缩进跟着模块六那一层）。 */
const BEGIN = "    // MAP_GUIDE_ART:BEGIN";
const END = "    // MAP_GUIDE_ART:END";

/** 每行 base64 的字符数（太长的一行读不动，也太容易让编辑器卡）。 */
const WRAP = 108;
/** 模块六的术语黑名单里**可能被 base64 拼出来**的那几个（汉字不可能出现，不用管）。 */
const FORBIDDEN = ["chunk", "Tiled", "SPR_"];

const argv = process.argv.slice(2);
const check = argv.includes("--check");
const outArg = argv.find((item) => item.startsWith("--out="));
const outDir = outArg === undefined ? null : resolve(outArg.slice("--out=".length));

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. 生成（并证明它是确定性的）
// ---------------------------------------------------------------------------

let mapsamplegen;
try {
  mapsamplegen = await import(join(REPO, "lib", "mapsamplegen.js"));
} catch (error) {
  fail(`无法加载 lib/mapsamplegen.js：${error instanceof Error ? error.message : String(error)}\n  先跑一次 \`npm run build\`。`);
}
if (typeof mapsamplegen.renderGuideSheets !== "function") {
  fail("lib/mapsamplegen.js 里没有 renderGuideSheets —— lib/ 与 src/ 不同步（跑 `npm run build`）。");
}

const sheets = mapsamplegen.renderGuideSheets();
const again = mapsamplegen.renderGuideSheets();
if (sheets.length !== 3) fail(`期望三张示例图（普通 / 整格 / 拼块），实际 ${sheets.length} 张`);
for (const [index, sheet] of sheets.entries()) {
  if (again[index] === undefined || !sheet.png.equals(again[index].png)) {
    fail(`「${sheet.shape}」两次生成的结果不一致：生成器里混进了不确定性（不要用 Math.random / Date.now）`);
  }
  // 几何必须自洽：图有多大、能排几块、每块再分几小格，三者对得上网格线才算数。
  const cell = sheet.width / sheet.cols;
  if (!Number.isInteger(cell) || sheet.height !== cell * sheet.rows) {
    fail(`「${sheet.shape}」的几何自相矛盾：${sheet.width}×${sheet.height} 排 ${sheet.cols} 列 × ${sheet.rows} 行`);
  }
  if (sheet.sub !== 0 && cell % sheet.sub !== 0) {
    fail(`「${sheet.shape}」每块 ${cell}px 分不成 ${sheet.sub} 小格`);
  }
}

// ---------------------------------------------------------------------------
// 2. 拼出待写入的那段源码
// ---------------------------------------------------------------------------

/** base64 折行：`[...]` 里一行一段，可读且 diff 稳定。 */
function base64Literal(buffer) {
  const text = buffer.toString("base64");
  const rows = [];
  for (let index = 0; index < text.length; index += WRAP) rows.push(`          ${JSON.stringify(text.slice(index, index + WRAP))}`);
  return rows.join(" +\n");
}

const entries = sheets
  .map((sheet) => {
    return [
      `      ${JSON.stringify(sheet.shape)}: {`,
      `        // ${sheet.width}×${sheet.height}：${sheet.cols} 列 × ${sheet.rows} 行，每块 ${sheet.width / sheet.cols}px${
        sheet.sub > 0 ? `，每块再分 ${sheet.sub}×${sheet.sub} 小格` : ""
      }`,
      `        src:`,
      `          ${JSON.stringify("data:image/png;base64,")} +`,
      base64Literal(sheet.png) +
        `,`,
      `        cols: ${sheet.cols},`,
      `        rows: ${sheet.rows},`,
      `        cell: ${sheet.width / sheet.cols},`,
      `        sub: ${sheet.sub}`,
      `      }`
    ].join("\n");
  })
  .join(",\n");

const block = [
  BEGIN,
  "    /**",
  "     * 「素材说明」窗口里的三张示例图（普通图块 / 整格自动连接 / 拼块自动连接）。",
  "     *",
  "     * ⚠️ **整块由 `node scripts/make-map-guide-art.mjs` 生成**（`--check` 会断言它是新的）。",
  "     * 手改这里没有意义：下次生成会被整块覆盖。",
  "     *",
  "     * 图全部来自本机的内置示例素材生成器：普通 / 整格两张是现画的，拼块那张就是内置草地",
  "     * —— 说明与用户真能拿到的东西同源。界面按 `cols` / `rows` / `sub` 现算网格线的位置，",
  "     * 所以不存在「图改了、网格线还在老位置」这种错位。",
  "     */",
  "    const MAP_GUIDE_ART = {",
  entries,
  "    };",
  END
].join("\n");

for (const word of FORBIDDEN) {
  if (block.includes(word)) {
    fail(
      `生成的这一段里出现了「${word}」—— 模块六的术语黑名单会命中它（它会连 base64 一起扫）。\n` +
        `  改一下 mapsamplegen 里说明图的画法（换个种子 / 换个尺寸）重新生成即可。`
    );
  }
}

// ---------------------------------------------------------------------------
// 3. 方向位序：说明窗口照着这张图教用户排「整格自动连接」的 16 块，
//    所以「行优先第 i 块 = 加起来等于 i 的那一种接法」是**契约**。
//    画错了不会有任何报错，只会让照做的人排出一张连不上的图 —— 只能在这里量。
// ---------------------------------------------------------------------------

/** 截图里的一个像素是不是不透明的（墙画在透明底上）。 */
function alphaAt(bitmap, x, y) {
  const offset = (y * bitmap.width + x) * 4;
  return bitmap.rgba[offset + 3];
}

/**
 * 把整格那张图解回来，逐块量四条边中点。
 *
 * PNG 解码走 `bitmap.ts` 的统一入口（内部是 ffmpeg）—— 手写解码器在真实生成图上会炸，
 * 这个脚本产出的虽然是本机 PNG，也没必要再养一份解码实现。
 */
async function checkCorner16Bits(sheet) {
  const { decodeFile } = await import(join(REPO, "lib", "bitmap.js"));
  const cell = sheet.width / sheet.cols;
  const dir = mkdtempSync(join(tmpdir(), "dsh-guide-"));
  const file = join(dir, "corner16.png");
  writeFileSync(file, sheet.png);
  try {
    const bitmap = await decodeFile(file);
    if (bitmap.width !== sheet.width || bitmap.height !== sheet.height) {
      fail(`解回来的整格图是 ${bitmap.width}×${bitmap.height}，与生成时的 ${sheet.width}×${sheet.height} 不一致`);
    }
    const problems = [];
    for (let mask = 0; mask < 16; mask++) {
      const ox = (mask % 4) * cell;
      const oy = Math.floor(mask / 4) * cell;
      const half = Math.floor(cell / 2);
      // 四条边中点：有邻居的那条边必须连到格子边缘，没有的必须空着。
      const edges = [
        ["上", 1, ox + half, oy],
        ["右", 2, ox + cell - 1, oy + half],
        ["下", 4, ox + half, oy + cell - 1],
        ["左", 8, ox, oy + half]
      ];
      for (const [name, bit, x, y] of edges) {
        const solid = alphaAt(bitmap, x, y) > 8;
        const want = (mask & bit) !== 0;
        if (solid !== want) problems.push(`第 ${mask} 块（${name}=${want ? 1 : 0}）的${name}边${solid ? "接出来了" : "没接出来"}`);
      }
      if (alphaAt(bitmap, ox + half, oy + half) <= 8) problems.push(`第 ${mask} 块正中间是空的`);
    }
    if (problems.length > 0) {
      fail(`整格那张图的方向与图块序号对不上（应当：上=1 / 右=2 / 下=4 / 左=8，行优先第 i 块就是加起来等于 i 的那种）：\n  ${problems.slice(0, 6).join("\n  ")}`);
    }
    return `16 块的方向位序逐块量过（上=1 / 右=2 / 下=4 / 左=8）`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 普通那张图里的每一块都得是**不一样的**（八个道具各不相同，重复了说明画错了）。 */
async function checkPlainTiles(sheet) {
  const { decodeFile } = await import(join(REPO, "lib", "bitmap.js"));
  const cell = sheet.width / sheet.cols;
  const dir = mkdtempSync(join(tmpdir(), "dsh-guide-"));
  const file = join(dir, "plain.png");
  writeFileSync(file, sheet.png);
  try {
    const bitmap = await decodeFile(file);
    const seen = new Map();
    for (let index = 0; index < sheet.cols * sheet.rows; index++) {
      const ox = (index % sheet.cols) * cell;
      const oy = Math.floor(index / sheet.cols) * cell;
      let key = "";
      let ink = 0;
      for (let y = 0; y < cell; y++) {
        for (let x = 0; x < cell; x++) {
          const alpha = alphaAt(bitmap, ox + x, oy + y);
          if (alpha > 8) ink++;
          key += alpha > 8 ? "#" : ".";
        }
      }
      if (ink === 0) fail(`普通那张图的第 ${index} 块是空的`);
      if (seen.has(key)) fail(`普通那张图的第 ${index} 块与第 ${seen.get(key)} 块长得一模一样（八个道具应当各不相同）`);
      seen.set(key, index);
    }
    return `${sheet.cols * sheet.rows} 块互不相同`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 4. 写回 / 比对
// ---------------------------------------------------------------------------

const source = readFileSync(CLIENT, "utf8");
const from = source.indexOf(BEGIN);
const to = source.indexOf(END, from === -1 ? 0 : from);
if (from === -1 || to === -1) fail(`src/client.ts 里找不到标记块（${BEGIN} … ${END}）`);
if (source.indexOf(BEGIN, from + 1) !== -1) fail(`${BEGIN} 出现了不止一次，不敢动`);
const current = source.slice(from, to + END.length);

if (outDir !== null) {
  mkdirSync(outDir, { recursive: true });
  for (const sheet of sheets) {
    const file = join(outDir, `${sheet.shape}.png`);
    writeFileSync(file, sheet.png);
    console.log(`  · ${file}`);
  }
}

if (check) {
  const ok = current === block;
  const cells = sheets.map((sheet) => `${sheet.shape} ${sheet.width}×${sheet.height}=${sheet.cols}×${sheet.rows}`).join(" / ");
  console.log(`  · ${cells}`);
  // 方向位序与「每块都不一样」只能把图解出来量（纯字节比对看不出来）。
  console.log(`  · ${await checkCorner16Bits(sheets.find((sheet) => sheet.shape === "corner16"))}`);
  console.log(`  · 普通那张图：${await checkPlainTiles(sheets.find((sheet) => sheet.shape === "plain"))}`);
  if (!ok) {
    fail("src/client.ts 里的说明图不是最新的：跑 `node scripts/make-map-guide-art.mjs` 重新生成（再 `npm run build`）");
  }
  // 顺带盯一眼「构建过了没有」：束里应当找得到同一段 base64（否则界面还是旧的）。
  // ⚠️ 逐**折行块**比，不能拿整串去 `includes`：base64 在源码里是折行 + 字符串相加的，
  // 整串在文件里根本不连续（这条一开始就是这么写错的，永远判不过）。
  const bundle = join(REPO, "lib", "client.js");
  if (existsSync(bundle)) {
    const built = readFileSync(bundle, "utf8");
    const missing = sheets.filter((sheet) => {
      const text = sheet.png.toString("base64");
      for (let index = 0; index < text.length; index += WRAP) {
        if (!built.includes(text.slice(index, index + WRAP))) return true;
      }
      return false;
    });
    if (missing.length > 0) fail(`lib/client.js 里没有最新的说明图（${missing.map((sheet) => sheet.shape).join(" / ")}）：跑一次 \`npm run build\``);
  }
  console.log("✓ 说明图是最新的（且已经构建进 lib/client.js）");
} else {
  writeFileSync(CLIENT, source.slice(0, from) + block + source.slice(to + END.length));
  console.log(`✓ 已写入 src/client.ts（${sheets.map((sheet) => `${sheet.shape} ${sheet.png.length}B`).join(" / ")}），接着跑 npm run build`);
}
