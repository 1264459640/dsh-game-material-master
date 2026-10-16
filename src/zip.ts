/**
 * 极简 ZIP 打包器（store / deflate），只做**写**这一个方向。
 *
 * 为什么不引第三方库：整个插件零运行时依赖（见 AGENTS.md），而这里要的只是
 * 「把几个文件装进一个 .zip」—— `node:zlib` 的 `deflateRawSync` 加 ~80 行够了。
 * 解包方向一件都不需要（验收是浏览器下载、引擎自己解压）。
 *
 * ⚠️ 三个必须守住的点，每个都对应一类真机上才看得出来的坏法：
 *
 * 1. **时间戳写死**（1980-01-01 00:00，DOS 纪元）。用真实时间的话，同一份地图
 *    导出两次的 zip 逐字节不同 —— `verify-map-pipeline.mjs` 的「同文档两次导出
 *    逐字节一致」当场挂掉，而那条契约正是「导出是可复现的」的兜底。
 * 2. **条目路径一律正斜杠**。Windows 的 `join()` 会给 `tilesets\ts1.png`，
 *    原样写进 zip 就是「解压出来一个名字里带反斜杠的怪文件」（macOS 上更明显）。
 * 3. **非 ASCII 路径要置 UTF-8 标志位**（通用位标记 bit 11 = `0x0800`）。
 *    不置位的话 Windows 自带解压按本地码页解，中文名直接变乱码。
 *    本模块目前的条目都是 ASCII（`map.png` / `tilesets/ts….png`），但这条不能省。
 */

import { deflateRawSync } from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 1980-01-01 00:00（DOS 时间戳的最小值）—— 固定值，见文件头第 1 条。 */
const DOS_DATE = 0x0021;
const DOS_TIME = 0x0000;
/** 通用位标记 bit 11：文件名是 UTF-8。 */
const FLAG_UTF8 = 0x0800;

function u16(value: number): Buffer {
  const out = Buffer.alloc(2);
  out.writeUInt16LE(value & 0xffff, 0);
  return out;
}

function u32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value >>> 0, 0);
  return out;
}

export interface ZipEntry {
  /** zip 内的路径（正斜杠；反斜杠会被就地换成正斜杠）。 */
  path: string;
  data: Buffer;
}

/**
 * 把若干文件打成一个 zip 的字节。
 *
 * 每个条目**单独决定**压缩还是原样存：deflate 之后没变小就存原始字节
 * （PNG 已经是压缩过的，再 deflate 一次只会更大更慢）。
 * 同一份输入永远给同一份输出（没有时间戳、没有随机数、没有并发顺序）。
 */
export function zipEntries(entries: readonly ZipEntry[]): Buffer {
  if (entries.length > 0xffff) throw new Error(`ZIP 条目太多：${entries.length}（上限 65535）`);
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const path = entry.path.replace(/\\/gu, "/").replace(/^\/+/u, "");
    if (path === "") throw new Error("ZIP 条目的路径不能为空");
    if (entry.data.length > 0xffffffff) throw new Error(`ZIP 单个条目超过 4GB：${path}`);
    const name = Buffer.from(path, "utf8");
    if (name.length > 0xffff) throw new Error(`ZIP 条目名太长：${path}`);
    const deflated = deflateRawSync(entry.data, { level: 6 });
    const stored = deflated.length >= entry.data.length;
    const payload = stored ? entry.data : deflated;
    const method = stored ? 0 : 8;
    const crc = crc32(entry.data);
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(FLAG_UTF8),
      u16(method),
      u16(DOS_TIME),
      u16(DOS_DATE),
      u32(crc),
      u32(payload.length),
      u32(entry.data.length),
      u16(name.length),
      u16(0),
      name
    ]);
    locals.push(local, payload);
    central.push(
      Buffer.concat([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(FLAG_UTF8),
        u16(method),
        u16(DOS_TIME),
        u16(DOS_DATE),
        u32(crc),
        u32(payload.length),
        u32(entry.data.length),
        u16(name.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        name
      ])
    );
    offset += local.length + payload.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(directory.length),
    u32(offset),
    u16(0)
  ]);
  return Buffer.concat([...locals, directory, end]);
}
