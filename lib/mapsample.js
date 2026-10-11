/**
 * 地图编辑器（模块六）· **内置示例素材的纹理覆盖表**（接口占位 + 文档）。
 *
 * ## 这个文件是干什么的
 *
 * 内置示例素材（草地 / 土路 / 水 / 石墙 / 道具）默认**纯程序化**生成，零成本、
 * 确定性、像素精确 —— 实现在 `src/mapsamplegen.ts` 的 `renderLocalTexture()`。
 *
 * 如果想让内置素材更有「手绘感」，可以用火山方舟 Seedream 生成纹理替换掉程序化纹理：
 *
 * ```bash
 * node scripts/make-map-sample-tileset.mjs --ark --yes   # ★真实计费
 * ```
 *
 * 那个脚本会为每种地貌调一次生图（无缝平铺、俯视、无光照方向的像素画纹理），
 * 把结果**降采样成 32×32** 后写回本文件的 `SAMPLE_TEXTURE_OVERRIDE`（base64 PNG）。
 * 运行时 `textureFor()` 见到某个地貌有覆盖就用它，没有就回退程序化 ——
 * 也就是说即使只覆盖了「水」，其余三张图照旧程序化生成，不会因为缺一张就跑不起来。
 *
 * ## 约定
 *
 * - 键 = 地貌种类：`grass` / `dirt` / `water` / `stone`。
 * - 值 = PNG 的 base64（不带 `data:` 前缀），32×32 的纹理（多则居中裁剪、少则平铺）。
 *   解码走 `bitmap.ts` 的统一入口 `decodeFile`（ffmpeg），所以**色深 / 调色板 / 隔行都无所谓**。
 * - 值非空时，调用方必须先 `await primeSampleTextures()` 一次（`src/mapsamplegen.ts`）——
 *   解码是异步的，而 `renderSampleTilesets()` 是同步契约。忘了 prime 会**明确抛错**，
 *   不会悄悄回退成程序化纹理（那样会出现「界面看着能用、纹理却不是他生成的那张」）。
 * - `SAMPLE_VERSION`：覆盖表的版本号。改了程序化纹理的画法、或者重新生成了覆盖图，
 *   就把它 +1，方便排查「用户机器上是旧素材」这一类问题。
 *
 * 依赖：无。本文件不 import 任何东西，也不做任何计算 —— 它只是**数据占位**。
 */
/** 由 `scripts/make-map-sample-tileset.mjs --ark` 生成；空对象 = 全部用程序化纹理。 */
export const SAMPLE_TEXTURE_OVERRIDE = {};
/** 内置示例素材的版本号；纹理画法或覆盖表变了就 +1。 */
export const SAMPLE_VERSION = 1;
