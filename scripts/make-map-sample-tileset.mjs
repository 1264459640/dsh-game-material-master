#!/usr/bin/env node
/**
 * 内置示例素材的**开发脚本**：把 `lib/mapsamplegen.js` 生成的 5 张图落盘，
 * 或者用火山方舟 Seedream 生成纹理替换程序化纹理。
 *
 *   node scripts/make-map-sample-tileset.mjs              # 等价于 --local：不联网、不花钱
 *   node scripts/make-map-sample-tileset.mjs --local      # 同上（显式）
 *   node scripts/make-map-sample-tileset.mjs --check      # 自检：确定性 + 尺寸/形态断言
 *   node scripts/make-map-sample-tileset.mjs --ark --yes  # ★真实调用计费 API，生成纹理覆盖表
 *
 * 默认产物目录 `<仓库>/research/map-sample/`，5 个文件：
 *   sample-grass.png / sample-dirt.png / sample-water.png / sample-stone.png（4 张 A2 图，64×160）
 *   sample-props.png（道具网格图，256×160 = 8 列 × 5 行 32px 图块）
 *
 * `--ark` 会额外把原图留在 `research/map-sample/ark-<时间戳>/`，并**改写
 * `src/mapsample.ts` 的 `SAMPLE_TEXTURE_OVERRIDE`**（只替换那一个 export 块；
 * 文件里其它内容一律不动。改写前会检查 `SAMPLE_VERSION` 标记，认不出来就拒绝写盘）。
 *
 * ⚠️ 这个脚本需要先 `npm run build`（它 import 的是 `lib/`）。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

/** 命令行开关。 */
const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const mode = has("--check") ? "check" : has("--ark") ? "ark" : "local";
const yes = has("--yes");
/** `--out=<目录>` 覆盖默认输出目录。 */
const outArg = argv.find((item) => item.startsWith("--out="));
const OUT_DIR = outArg === undefined ? join(REPO, "research", "map-sample") : resolve(outArg.slice("--out=".length));

const step = (n, text) => console.log(`\n[${n}] ${text}`);
const fail = (message) => {
  console.error(`\n✗ ${message}`);
  process.exit(1);
};

// ---------------------------------------------------------------------------
// 先确认 lib/ 是新的 —— 否则会拿旧代码生成素材，而且不报任何错
// ---------------------------------------------------------------------------

let mapsamplegen;
let bitmap;
try {
  mapsamplegen = await import(join(REPO, "lib", "mapsamplegen.js"));
  // 图片编解码**一律走 bitmap.ts 的统一入口**（内部是 ffmpeg）：它能吃任意色深 / 调色板 /
  // 隔行的 PNG，而手写解码器在真实生成图上一跑就炸（见 bitmap.ts 顶部注释）。
  bitmap = await import(join(REPO, "lib", "bitmap.js"));
} catch (error) {
  fail(
    `无法加载 lib/mapsamplegen.js：${error instanceof Error ? error.message : String(error)}\n` +
      `  先跑一次 \`npm run build\`（也可能是仓库里别的文件编译不过，与内置素材无关）。`
  );
}
if (typeof mapsamplegen.renderSampleTilesets !== "function" || !Array.isArray(mapsamplegen.SAMPLE_KINDS)) {
  fail(
    "lib/mapsamplegen.js 里没有 renderSampleTilesets / SAMPLE_KINDS —— " +
      "lib/ 与 src/ 不同步（跑 `npm run build`），或者这个文件被别人改写了。"
  );
}

if (typeof mapsamplegen.primeSampleTextures === "function") {
  // 覆盖表为空时这是空操作；配了覆盖（跑过 --ark）时它把 base64 PNG 交给 ffmpeg 解码。
  await mapsamplegen.primeSampleTextures();
}

console.log(`仓库：${REPO}`);
console.log(`模式：${mode}${mode === "ark" ? (yes ? "（已带 --yes）" : "（缺 --yes，稍后会退出）") : ""}`);
console.log(`输出：${OUT_DIR}`);

step(1, "生成内置示例素材（纯程序化，确定性）");
const first = mapsamplegen.renderSampleTilesets();
console.log(`  ${first.length} 张：`);
for (const item of first) {
  console.log(
    `  · ${item.name.padEnd(12, " ")} ${item.file.padEnd(18, " ")} ` +
      `${bitmap.pngSize(item.bytes).width}×${bitmap.pngSize(item.bytes).height}  ${item.shape.padEnd(7, " ")} ` +
      `cell ${item.cell.width}×${item.cell.height}  ${item.bytes.length} 字节`
  );
}

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------

/**
 * 照 `src/maptiles.ts` 的 `detectLayout` 契约内联一份识别逻辑。
 *
 * 为什么不直接 import `lib/maptiles.js` 的 `detectLayout`：模块六正在重做，
 * 识别函数在另一个文件里，**可能还没落地**；而内置素材的形态是硬契约，
 * 不能因为别的文件还没写完就跳过断言。等 `lib/maptiles.js` 有 `detectLayout` 了，
 * 这个脚本会自动切过去用它，那时两边口径不一致会立刻暴露出来。
 */
export function detectLayoutLikeSpec(imageWidth, imageHeight, realDetect) {
  if (typeof realDetect === "function") {
    const guess = realDetect(imageWidth, imageHeight);
    if (guess !== undefined && guess !== null) return guess;
  }
  const SIZES = [8, 16, 24, 32, 48, 64];
  for (const size of SIZES) {
    if (imageHeight === 5 * size && imageWidth % size === 0) {
      const variants = imageWidth / size;
      return {
        cell: { width: size, height: size },
        shape: "a2quad",
        cols: Math.floor(imageWidth / size),
        rows: Math.floor(imageHeight / size),
        count: Math.floor(imageWidth / size) * 5,
        variants,
        reason: `识别到：拼块自动连接（${variants} 种变体 × 5 种形状）`
      };
    }
  }
  let best = 0;
  for (const size of SIZES) {
    if (size > best && imageWidth % size === 0 && imageHeight % size === 0) best = size;
  }
  if (best === 0) {
    return {
      cell: { width: 32, height: 32 },
      shape: "plain",
      cols: Math.floor(imageWidth / 32),
      rows: Math.floor(imageHeight / 32),
      count: Math.floor(imageWidth / 32) * Math.floor(imageHeight / 32),
      variants: 1,
      reason: "尺寸不是常见格宽高比的整数倍，按 32×32 处理"
    };
  }
  return {
    cell: { width: best, height: best },
    shape: "plain",
    cols: Math.floor(imageWidth / best),
    rows: Math.floor(imageHeight / best),
    count: Math.floor(imageWidth / best) * Math.floor(imageHeight / best),
    variants: 1,
    reason: `识别到：普通网格（格 ${best}）`
  };
}

/**
 * 内置素材的**手工登记表**：文件名 → 形态。
 *
 * 为什么需要它：道具图（256×160 = 8 列 × 5 行 32px）恰好也满足 a2quad 的尺寸判据
 * （高 = 5×32、宽能被 32 整除），所以「只看尺寸」的识别必然二义。内置素材是**我们自己
 * 生成的**，形态由生成器写死在 `SampleTileset.shape` 里，自检就该断言那一份；
 * 识别函数只用来断言「格尺寸对不对」。
 */
const MANUAL_SHAPE = {
  "sample-grass.png": "a2quad",
  "sample-dirt.png": "a2quad",
  "sample-water.png": "a2quad",
  "sample-stone.png": "a2quad",
  "sample-props.png": "plain"
};

// 5 张图先落盘：后面的像素断言用 `bitmap.decodeFile`（ffmpeg）读盘，而不是自己解析 PNG。
await mkdir(OUT_DIR, { recursive: true });
for (const item of first) {
  await writeFile(join(OUT_DIR, item.file), item.bytes);
}

if (mode === "check") {
  step(2, "自检 ①：两次生成逐字节一致");
  const second = mapsamplegen.renderSampleTilesets();
  if (second.length !== first.length) fail(`两次渲染张数不同：${first.length} vs ${second.length}`);
  for (let i = 0; i < first.length; i++) {
    const a = first[i];
    const b = second[i];
    if (a.file !== b.file) fail(`第 ${i + 1} 张的文件名不同：${a.file} vs ${b.file}`);
    if (!a.bytes.equals(b.bytes)) {
      fail(
        `${a.file}：两次生成的 PNG **不是逐字节一致**（${a.bytes.length} vs ${b.bytes.length} 字节）—— ` +
          `说明某处用了 Math.random / Date.now / 非确定遍历顺序。`
      );
    }
    console.log(`  ✓ ${a.file.padEnd(18, " ")} ${a.bytes.length} 字节 × 2 次逐字节一致`);
  }

  step(3, "自检 ②：尺寸与识别形态");
  let realDetect;
  try {
    const maptiles = await import(join(REPO, "lib", "maptiles.js"));
    if (typeof maptiles.detectLayout === "function") realDetect = maptiles.detectLayout;
  } catch {
    realDetect = undefined;
  }
  console.log(`  形态识别：${realDetect === undefined ? "内联规则（lib/maptiles.js 还没导出 detectLayout）" : "lib/maptiles.js 的 detectLayout"}`);

  const a2 = first.filter((item) => item.shape === "a2quad");
  const plain = first.filter((item) => item.shape === "plain");
  if (a2.length !== 4) fail(`A2 图应该是 4 张，实际 ${a2.length} 张`);
  if (plain.length !== 1) fail(`道具网格图应该是 1 张，实际 ${plain.length} 张`);

  for (const item of a2) {
    const size = bitmap.pngSize(item.bytes);
    if (size.width !== 64 || size.height !== 160) {
      fail(`${item.file}：A2 图应该是 64×160，实际 ${size.width}×${size.height}`);
    }
    const guess = detectLayoutLikeSpec(size.width, size.height, realDetect);
    if (guess.shape !== "a2quad") fail(`${item.file}：识别成 ${guess.shape}，应为 a2quad`);
    // 识别实现里「变体数」可能叫 variants，也可能只给了 cols（每列 = 1 个变体），两种都认。
    const variants = guess.variants ?? guess.cols;
    if (variants !== 2) fail(`${item.file}：识别出 ${variants} 种变体，应为 2`);
    if (guess.cell.width !== 32 || guess.cell.height !== 32) {
      fail(`${item.file}：识别出的格尺寸 ${guess.cell.width}×${guess.cell.height}，应为 32×32`);
    }
    console.log(
      `  ✓ ${item.file.padEnd(18, " ")} 64×160 → a2quad / 2 变体 / 格 32×32 / ` +
        `${typeof guess.reason === "string" ? guess.reason : ""}`
    );
  }

  for (const item of plain) {
    const size = bitmap.pngSize(item.bytes);
    if (size.width !== 8 * 32) fail(`${item.file}：道具网格图宽应为 ${8 * 32}，实际 ${size.width}`);
    if (size.height % 32 !== 0 || size.height / 32 < 1) {
      fail(`${item.file}：道具网格图高应为 32 的整数倍，实际 ${size.height}`);
    }
    const guess = detectLayoutLikeSpec(size.width, size.height, realDetect);
    // 道具图 256×160 同时满足 a2quad 的判据（高 = 5×32、宽能被 32 整除），所以「纯看尺寸」
    // 的自动识别会把它认成「8 变体 × 5 形状」—— 这是**识别本身的歧义**，不是素材坏了
    // （7×5 个 32px 块的道具图也确实可以当真 A2 用）。所以自检不拿它当断言，
    // 改成按**手工登记表**断言形态，并把识别结论打出来备查。
    const expected = MANUAL_SHAPE[item.file];
    if (expected === undefined) fail(`${item.file}：手工登记表里没有它的形态`);
    if (item.shape !== expected) fail(`${item.file}：素材声明 ${item.shape}，但手工登记为 ${expected}`);
    if (guess.cell.width !== 32 || guess.cell.height !== 32) {
      fail(`${item.file}：识别出的格尺寸 ${guess.cell.width}×${guess.cell.height}，应为 32×32`);
    }
    console.log(
      `  ✓ ${item.file.padEnd(18, " ")} ${size.width}×${size.height} → 声明 ${item.shape}` +
        `（尺寸自动识别会给 ${guess.shape}，见下方说明）/ ${size.height / 32} 行 32px 图块`
    );
  }

  step(4, "自检 ③：5 个形状必须真的不一样 / 变体必须真的不一样 / 形状 0 必须带过渡带");
  // 这三条是「自动连接看起来生效了」的最小保证。少了它们，素材会退化成
  // 「5 个形状长得一模一样」—— 界面能跑、没有报错，但用户完全看不出 A2 在起作用。
  // 阈值 6 来自实测：形状差异若只是噪声，逐像素平均绝对差只有 1~3 色阶。
  const A2_MAD_MIN = 6;
  const A2_BAND_RATIO_MIN = 0.05;

  for (const item of a2) {
    const pixels = await bitmap.decodeFile(join(OUT_DIR, item.file));
    const sheetWidth = pixels.width;
    const kinds = mapsamplegen.SAMPLE_KINDS;
    const spec = kinds.find((entry) => entry.file === item.file);
    if (spec === undefined) fail(`${item.file}：SAMPLE_KINDS 里找不到它的地貌定义`);
    const neighborSpec = kinds.find((entry) => entry.kind === spec.neighbor);
    // 「本体基色」/「邻接地貌基色」都从各自的图里取，且避开过渡带：
    // 形状 4 的变体 0 块（右上，x=32..63 / y=128..159）是纯本体；
    // 邻接地貌的本体取它「形状 0 变体 0」块（x=0..31 / y=0..31）的**中心 8×8**
    // ——形状 0 的带都在四周 5px 里，中心一定是纯本体。
    const base = centerAverage(pixels.rgba, sheetWidth, 0, 128); // 形状 4 / 变体 0 = 纯本体
    const neighborColor =
      neighborSpec === undefined
        ? [20, 18, 26] // 石墙没有邻接地貌，过渡带是深色阴影（见 renderShapeBlock 的 shadow）
        : centerAverage(
            (await bitmap.decodeFile(join(OUT_DIR, neighborSpec.file))).rgba,
            sheetWidth,
            0,
            0
          );

    // ① 5 个形状两两比较。⚠️ 形状号 = **行**（y），变体号 = **列**（x）—— 别写反：
    //    写反了比的是两个变体，形状之间哪怕一模一样也会显示「差异很大」。
    let minShape = Number.POSITIVE_INFINITY;
    let worst = "";
    for (let a = 0; a < 5; a++) {
      for (let b = a + 1; b < 5; b++) {
        const mad = blockMad(pixels.rgba, 0, a * 32, pixels.rgba, 0, b * 32, sheetWidth);
        if (mad < minShape) {
          minShape = mad;
          worst = `形状 ${a} vs 形状 ${b}`;
        }
      }
    }
    if (minShape <= A2_MAD_MIN) {
      fail(`${item.file}：${worst} 的逐像素平均绝对差只有 ${minShape.toFixed(2)}（要求 > ${A2_MAD_MIN}）—— 形状之间看不出区别`);
    }

    // ② 两个变体（变体号 = 列 / x）
    const variantMad = blockMad(pixels.rgba, 0, 0, pixels.rgba, 32, 0, sheetWidth);
    if (variantMad <= A2_MAD_MIN) {
      fail(`${item.file}：变体 0 与变体 1 的逐像素平均绝对差只有 ${variantMad.toFixed(2)}（要求 > ${A2_MAD_MIN}）`);
    }

    // ③ 形状 0 必须有非空的过渡带
    const ratio = bandRatio(pixels.rgba, sheetWidth, 0, 0, neighborColor);
    if (ratio <= A2_BAND_RATIO_MIN) {
      fail(
        `${item.file}：形状 0 里与邻接地貌基色 ${neighborColor.join(",")} 相近的像素只有 ` +
          `${(ratio * 100).toFixed(2)}%（要求 > ${A2_BAND_RATIO_MIN * 100}%）—— 孤岛四周没有过渡带`
      );
    }

    console.log(
      `  ✓ ${item.file.padEnd(18, " ")} 形状两两最小差 ${minShape.toFixed(2)}（${worst}）/ ` +
        `变体差 ${variantMad.toFixed(2)} / 形状 0 带 ${(ratio * 100).toFixed(2)}% ` +
        `（阈值 > ${A2_MAD_MIN} / > ${A2_MAD_MIN} / > ${A2_BAND_RATIO_MIN * 100}%）`
    );
    console.log(
      `      本体基色 ${base.join(",")} · 邻接地貌（${spec.neighbor ?? "无，用阴影"}）基色 ${neighborColor.join(",")}`
    );
  }

  const overrideCount = Object.keys(mapsamplegen.SAMPLE_TEXTURE_OVERRIDE ?? {}).length;
  console.log(`\n  覆盖表：${overrideCount === 0 ? "空对象（全部走程序化纹理）" : `${overrideCount} 个地貌用了 Seedream 纹理`}`);
  console.log(`  形态：renderSampleTilesets() 给的 shape / cell —— ` + first.map((item) => `${item.file}=${item.shape} ${item.cell.width}×${item.cell.height}`).join(" | "));
  console.log("\n✓ 内置示例素材自检通过");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 落盘（--local / --ark 都要先把程序化那一套写出来，方便对照）
// ---------------------------------------------------------------------------

step(2, "写盘");
for (const item of first) {
  const target = join(OUT_DIR, item.file);
  console.log(`  · ${relative(REPO, target)}  ${item.bytes.length} 字节`);
}

if (mode === "local") {
  console.log(`\n✓ 完成。5 张图在 ${OUT_DIR}`);
  console.log("  用图片浏览器直接看即可：4 张 A2 图按「块列 = 变体、块行 = 形状」排布；道具图 8 列 × 5 行。");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// --ark：真实计费
// ---------------------------------------------------------------------------

console.log("\n" + "★".repeat(30));
console.log("★ 这一步会真实调用火山方舟 Seedream **计费 API**：4 个地貌各 1 次 = 4 次生图。");
console.log("★".repeat(30));

if (!yes) {
  console.error(
    [
      "",
      "缺 `--yes`：为防误触，计费调用必须显式确认。",
      "",
      "用法：",
      "  node scripts/make-map-sample-tileset.mjs --ark --yes",
      "",
      "前置条件：先在 DSH 的「设置 → 游戏素材大师」里填好火山方舟 API Key",
      "（也可以直接写数据目录里的 config.json 的 arkApiKey 字段），",
      "并且已经跑过 `npm run build`。"
    ].join("\n")
  );
  process.exit(1);
}

const { loadConfig } = await import(join(REPO, "lib", "config.js"));
const { generateImage } = await import(join(REPO, "lib", "ark.js"));

const config = await loadConfig();
if (config.arkApiKey.trim() === "") {
  fail(
    [
      "没有读到火山方舟 API Key（arkApiKey 为空）。",
      "",
      "怎么配：打开 DSH → 「设置 → 游戏素材大师」→ 填「火山方舟 API Key」并保存；",
      "或者直接编辑数据目录里的 config.json 的 `arkApiKey` 字段。",
      "",
      "这个脚本**不会静默降级**去用程序化纹理 —— 那样你会以为覆盖表已经生成好了。"
    ].join("\n")
  );
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "");
const arkDir = join(OUT_DIR, `ark-${stamp}`);
await mkdir(arkDir, { recursive: true });
console.log(`\n模型：${config.arkModel}（尺寸 ${config.arkSize}）`);
console.log(`原图目录：${relative(REPO, arkDir)}`);

const KIND_LABELS = {
  grass: "草地",
  dirt: "土路",
  water: "水",
  stone: "石墙"
};
const KIND_PROMPTS = {
  grass: "俯视视角的短草地表纹理，茂密均匀的绿草，",
  dirt: "俯视视角的干燥泥土小路地表纹理，褐色土壤与细碎砂石，",
  water: "俯视视角的浅水水面纹理，蓝色水面与细微波纹，",
  stone: "俯视视角的灰色石砖墙顶纹理，方正的石块砌缝，"
};

const overrides = {};
for (const spec of mapsamplegen.SAMPLE_KINDS) {
  step(3, `生成纹理：${spec.name}`);
  const prompt =
    `${KIND_PROMPTS[spec.kind]}` +
    "无缝平铺的游戏地图 texture，正上方正交俯视，光照均匀、没有方向性阴影，没有透视，" +
    "像素画风格，32×32 像素的细节密度，画面里不要有任何物体、文字或边框";
  const result = await generateImage({
    baseUrl: config.arkBaseUrl,
    apiKey: config.arkApiKey,
    model: config.arkModel,
    prompt,
    images: [],
    size: config.arkSize,
    watermark: config.arkWatermark,
    timeoutMs: config.arkTimeoutMs
  });
  const rawPath = join(arkDir, `${spec.kind}${result.ext === "png" ? ".png" : `.${result.ext}`}`);
  await writeFile(rawPath, result.bytes);
  const decoded = await bitmap.decodeFile(rawPath);
  const small = downsampleTo(decoded, 32, 32);
  const png = bitmap.encodeBitmap(small);
  await writeFile(join(arkDir, `${spec.kind}-32.png`), png);
  overrides[spec.kind] = png.toString("base64");
  console.log(`  · 原图 ${rel(REPO, rawPath)} ${decoded.width}×${decoded.height} ${result.bytes.length} 字节`);
  console.log(`  · 降采样 ${rel(REPO, join(arkDir, `${spec.kind}-32.png`))} 32×32 ${png.length} 字节`);
}

step(4, "改写 src/mapsample.ts 的 SAMPLE_TEXTURE_OVERRIDE");
const sampleFile = join(REPO, "src", "mapsample.ts");
const current = await readFile(sampleFile, "utf8");
// 锚点 = 「空对象」那一行。只认这一种形状，认不出来就拒绝写盘 ——
// 计费调用已经花掉了，绝不能因为「块形状和预期不一致」把文件写坏。
const EMPTY_BLOCK = "export const SAMPLE_TEXTURE_OVERRIDE: Record<string, string> = {};";
if (!current.includes(EMPTY_BLOCK)) {
  fail(
    `${rel(REPO, sampleFile)} 里找不到「空对象」那一行：\n  ${EMPTY_BLOCK}\n` +
      "  可能它已经被 --ark 生成过（先把覆盖表还原成空对象再跑），也可能被人改写过 —— 拒绝改写。"
  );
}
const lines = Object.entries(overrides).map(([kind, base64]) => `  ${kind}: "${base64}",`);
const replacement = [
  "export const SAMPLE_TEXTURE_OVERRIDE: Record<string, string> = {",
  ...lines,
  "};"
].join("\n");
const next = current.replace(EMPTY_BLOCK, replacement);
if (next === current) fail("改写没有产生任何变化，拒绝写盘。");
await writeFile(sampleFile, next, "utf8");
console.log(`  · 已写入 ${Object.keys(overrides).length} 个地貌的纹理覆盖（base64 PNG）`);
console.log(`  · 别忘了 \`npm run build\`，然后 \`node scripts/make-map-sample-tileset.mjs --check\` 复验确定性`);
console.log(`\n✓ 完成。原图与 32×32 纹理都在 ${arkDir}`);

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function rel(base, target) {
  const text = relative(base, target);
  return text === "" ? "." : text;
}

/**
 * 两块 32×32 块的**逐像素平均绝对差**（RGB 三通道平均；不看 alpha）。
 *
 * 用平均绝对差而不是「差异像素比例」：形状之间的差别主要是「一条 5px 带」，
 * 差异像素比例会很小，但色阶差很实在 —— 平均绝对差才分得出「噪声」和「真的画了东西」。
 */
function blockMad(aPixels, ax, ay, bPixels, bx, by, imageWidth, size = 32) {
  let sum = 0;
  let n = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const ia = ((y + ay) * imageWidth + x + ax) * 4;
      const ib = ((y + by) * imageWidth + x + bx) * 4;
      sum += Math.abs(aPixels[ia] - bPixels[ib]) + Math.abs(aPixels[ia + 1] - bPixels[ib + 1]) + Math.abs(aPixels[ia + 2] - bPixels[ib + 2]);
      n += 3;
    }
  }
  return sum / n;
}

/** 32×32 块正中心 8×8 的平均色 —— 块的「本体基色」（过渡带都在四周 5px 里，中心一定是本体）。 */
function centerAverage(pixels, imageWidth, x, y) {
  const sum = [0, 0, 0];
  let n = 0;
  for (let j = 12; j < 20; j++) {
    for (let i = 12; i < 20; i++) {
      const index = ((y + j) * imageWidth + x + i) * 4;
      sum[0] += pixels[index];
      sum[1] += pixels[index + 1];
      sum[2] += pixels[index + 2];
      n++;
    }
  }
  return sum.map((value) => Math.round(value / n));
}

/** 32×32 块里「与参考色相近」的像素占比（曼哈顿距离 ≤ 60）。形状 0 的过渡带靠它断言。 */
function bandRatio(pixels, imageWidth, x, y, reference, size = 32) {
  let hit = 0;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const index = ((y + j) * imageWidth + x + i) * 4;
      const distance =
        Math.abs(pixels[index] - reference[0]) + Math.abs(pixels[index + 1] - reference[1]) + Math.abs(pixels[index + 2] - reference[2]);
      if (distance <= 60) hit++;
    }
  }
  return hit / (size * size);
}
