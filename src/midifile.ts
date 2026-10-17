/**
 * 标准 MIDI 文件（SMF）解析与 WAV 写出。
 *
 * 这里只做两件事：
 *   ① 把 scoremill 写出的 `.mid` 解析成「音符 + 速度图 + 拍号」；
 *   ② 把浮点采样写成 16-bit PCM WAV。
 *
 * 为什么不用第三方库：插件没有任何运行时依赖（见 AGENTS.md），
 * 而预览渲染需要拿到逐音符的起止时间。解析器刻意只覆盖 SMF 0/1 里
 * 真正会用到的部分（note / program / CC / tempo / time-signature），
 * 遇到 SysEx / SMPTE 时间码这类用不到的东西直接跳过或报错。
 */

export class MidiParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MidiParseError";
  }
}

export interface MidiMeta {
  /** 总时长（秒），按速度图积分。 */
  duration: number;
  /** 总小节数（支持拍号变化；末尾不足一小节按小数计）。 */
  bars: number;
  /** 开头速度（BPM）。 */
  tempo: number;
  /** 开头拍号（例如 "4/4"）。 */
  timeSignature: string;
  /** 轨道数（MTrk 块数）。 */
  tracks: number;
  /** 出现过事件的通道数。 */
  channels: number;
  /** note-on（力度 > 0）的数量。 */
  notes: number;
}

export interface MidiNote {
  channel: number;
  note: number;
  velocity: number;
  /** 秒。 */
  start: number;
  /** 秒；同音重触发时取前一个 note-on 的结束。 */
  end: number;
  program: number;
  /** CC7（0–127），没写过就是 100。 */
  volume: number;
  /** CC10（0–127），没写过就是 64（居中）。 */
  pan: number;
}

export interface ParsedMidi {
  meta: MidiMeta;
  notes: MidiNote[];
  /** 每个通道最终生效的 program（给界面展示）。 */
  programs: Record<number, number>;
}

const DEFAULT_TEMPO_US = 500000; // 120 BPM

interface RawEvent {
  tick: number;
  /** 同一 tick 内先处理 note-off / program / CC，再处理 note-on。 */
  order: number;
  kind: "noteOn" | "noteOff" | "program" | "control" | "tempo" | "timeSignature" | "trackName" | "end";
  channel: number;
  data1: number;
  data2: number;
  /** tempo：每四分音符微秒数；timeSignature：分子/分母。 */
  value?: number;
  denominator?: number;
}

interface TempoPoint {
  tick: number;
  seconds: number;
  usPerQuarter: number;
}

function readUint16(buffer: Buffer, offset: number): number {
  return (buffer[offset] << 8) | buffer[offset + 1];
}

function readUint32(buffer: Buffer, offset: number): number {
  return ((buffer[offset] << 24) | (buffer[offset + 1] << 16) | (buffer[offset + 2] << 8) | buffer[offset + 3]) >>> 0;
}

/** 可变长度整数（MIDI 的 delta time / meta length）。最多 4 字节。 */
function readVarInt(buffer: Buffer, offset: number): { value: number; offset: number } {
  let value = 0;
  for (let i = 0; i < 4; i++) {
    if (offset >= buffer.length) throw new MidiParseError("MIDI 数据在可变长度整数处截断");
    const byte = buffer[offset++];
    value = (value << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) return { value, offset };
  }
  throw new MidiParseError("MIDI 可变长度整数超过 4 字节");
}

function parseTracks(buffer: Buffer): { format: number; division: number; tracks: RawEvent[][]; noteCount: number } {
  if (buffer.length < 14 || buffer.toString("ascii", 0, 4) !== "MThd") {
    throw new MidiParseError("不是标准 MIDI 文件（缺少 MThd 头）");
  }
  const headerLength = readUint32(buffer, 4);
  if (headerLength < 6 || buffer.length < 8 + headerLength) throw new MidiParseError("MIDI 头长度不合法");
  const format = readUint16(buffer, 8);
  if (format !== 0 && format !== 1) throw new MidiParseError(`不支持的 MIDI 格式：${format}（只支持 0 / 1）`);
  const trackCount = readUint16(buffer, 10);
  const division = readUint16(buffer, 12);
  if ((division & 0x8000) !== 0) throw new MidiParseError("不支持 SMPTE 时间码 MIDI（需要 PPQ 类型）");
  if (division === 0) throw new MidiParseError("MIDI 时间分辨率不能为 0");

  const tracks: RawEvent[][] = [];
  let noteCount = 0;
  let offset = 8 + headerLength;
  for (let index = 0; index < trackCount; index++) {
    if (offset + 8 > buffer.length) throw new MidiParseError(`第 ${index + 1} 条轨道头截断`);
    if (buffer.toString("ascii", offset, offset + 4) !== "MTrk") {
      throw new MidiParseError(`第 ${index + 1} 条轨道不是 MTrk（偏移 ${offset}）`);
    }
    const length = readUint32(buffer, offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (end > buffer.length) throw new MidiParseError(`第 ${index + 1} 条轨道数据截断`);
    const events: RawEvent[] = [];
    let cursor = start;
    let tick = 0;
    let runningStatus = 0;
    let order = 0;
    while (cursor < end) {
      const delta = readVarInt(buffer, cursor);
      tick += delta.value;
      cursor = delta.offset;
      if (cursor >= end) break;
      let status = buffer[cursor];
      if (status === 0xff) {
        // meta
        cursor++;
        if (cursor >= end) throw new MidiParseError("MIDI meta 事件截断");
        const type = buffer[cursor++];
        const len = readVarInt(buffer, cursor);
        cursor = len.offset;
        const dataStart = cursor;
        const dataEnd = cursor + len.value;
        if (dataEnd > end) throw new MidiParseError("MIDI meta 事件数据截断");
        if (type === 0x51 && len.value === 3) {
          const us = (buffer[dataStart] << 16) | (buffer[dataStart + 1] << 8) | buffer[dataStart + 2];
          if (us > 0) events.push({ tick, order: order++, kind: "tempo", channel: 0, data1: 0, data2: 0, value: us });
        } else if (type === 0x58 && len.value >= 2) {
          const numerator = buffer[dataStart];
          const denominator = 1 << buffer[dataStart + 1];
          if (numerator > 0 && denominator > 0) {
            events.push({ tick, order: order++, kind: "timeSignature", channel: 0, data1: numerator, data2: denominator, denominator });
          }
        } else if (type === 0x03) {
          // 轨道名对预览没用，记下来只是为了让排序里保留一个位置。
          events.push({ tick, order: order++, kind: "trackName", channel: 0, data1: 0, data2: 0 });
        } else if (type === 0x2f) {
          events.push({ tick, order: order++, kind: "end", channel: 0, data1: 0, data2: 0 });
        }
        cursor = dataEnd;
        continue;
      }
      if (status === 0xf0 || status === 0xf7) {
        // SysEx：长度 + 数据，跳过。
        cursor++;
        const len = readVarInt(buffer, cursor);
        cursor = len.offset + len.value;
        if (cursor > end) throw new MidiParseError("MIDI SysEx 数据截断");
        continue;
      }
      if (status < 0x80) {
        // running status：这个字节其实是第一个 data byte。
        if (runningStatus === 0) throw new MidiParseError("MIDI running status 没有前置状态字节");
        status = runningStatus;
      } else {
        cursor++;
        runningStatus = status;
      }
      const type = status & 0xf0;
      const channel = status & 0x0f;
      const need = type === 0xc0 || type === 0xd0 ? 1 : 2;
      if (cursor + need > end) throw new MidiParseError("MIDI 通道事件数据截断");
      const data1 = buffer[cursor++];
      const data2 = need === 2 ? buffer[cursor++] : 0;
      if (type === 0x90) {
        if (data2 > 0) {
          noteCount++;
          events.push({ tick, order: order++, kind: "noteOn", channel, data1, data2 });
        } else {
          events.push({ tick, order: order++, kind: "noteOff", channel, data1, data2: 0 });
        }
      } else if (type === 0x80) {
        events.push({ tick, order: order++, kind: "noteOff", channel, data1, data2 });
      } else if (type === 0xc0) {
        events.push({ tick, order: order++, kind: "program", channel, data1, data2: 0 });
      } else if (type === 0xb0) {
        events.push({ tick, order: order++, kind: "control", channel, data1, data2 });
      }
      // 0xA0 / 0xD0 / 0xE0 对预览没用，直接跳过。
    }
    tracks.push(events);
    offset = end;
  }
  return { format, division, tracks, noteCount };
}

function buildTempoMap(events: RawEvent[], division: number): TempoPoint[] {
  const tempos = events.filter((event) => event.kind === "tempo").sort((a, b) => a.tick - b.tick || a.order - b.order);
  const points: TempoPoint[] = [];
  let usPerQuarter = DEFAULT_TEMPO_US;
  let lastTick = 0;
  let lastSeconds = 0;
  points.push({ tick: 0, seconds: 0, usPerQuarter });
  for (const event of tempos) {
    if (event.tick <= lastTick) {
      // 同一 tick 上后写的速度覆盖前面的。
      usPerQuarter = event.value ?? usPerQuarter;
      points[points.length - 1] = { tick: 0, seconds: 0, usPerQuarter };
      continue;
    }
    lastSeconds += ((event.tick - lastTick) / division) * (usPerQuarter / 1_000_000);
    lastTick = event.tick;
    usPerQuarter = event.value ?? usPerQuarter;
    points.push({ tick: event.tick, seconds: lastSeconds, usPerQuarter });
  }
  return points;
}

function tickToSeconds(tick: number, division: number, tempos: TempoPoint[]): number {
  let lo = 0;
  let hi = tempos.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tempos[mid].tick <= tick) lo = mid;
    else hi = mid - 1;
  }
  const point = tempos[lo];
  return point.seconds + ((tick - point.tick) / division) * (point.usPerQuarter / 1_000_000);
}

function computeBars(events: RawEvent[], division: number, endTick: number): number {
  const signatures = events
    .filter((event) => event.kind === "timeSignature")
    .sort((a, b) => a.tick - b.tick || a.order - b.order);
  const points: Array<{ tick: number; numerator: number; denominator: number }> = [];
  for (const event of signatures) {
    const numerator = event.data1 > 0 ? event.data1 : 4;
    const denominator = event.denominator ?? (event.data2 > 0 ? event.data2 : 4);
    if (points.length > 0 && points[points.length - 1].tick === event.tick) {
      points[points.length - 1] = { tick: event.tick, numerator, denominator };
    } else {
      points.push({ tick: event.tick, numerator, denominator });
    }
  }
  if (points.length === 0 || points[0].tick > 0) points.unshift({ tick: 0, numerator: 4, denominator: 4 });
  let bars = 0;
  for (let i = 0; i < points.length; i++) {
    const from = points[i].tick;
    const to = i + 1 < points.length ? points[i + 1].tick : endTick;
    if (to <= from) continue;
    // 一小节 = numerator 个 1/denominator 音符；换算成四分音符数。
    const quarterNotesPerBar = points[i].numerator * (4 / points[i].denominator);
    const ticksPerBar = quarterNotesPerBar * division;
    bars += (to - from) / ticksPerBar;
  }
  return Math.round(bars * 100) / 100;
}

/**
 * 解析 MIDI。
 *
 * 事件按 tick 排序；同一 tick 内 note-off 先于 note-on（避免同音重触发
 * 把新音立刻关掉），program / CC 先于 note-on。
 */
export function parseMidiFile(buffer: Buffer): ParsedMidi {
  if (buffer.length > 10 * 1024 * 1024) throw new MidiParseError("MIDI 文件超过 10MB，拒绝解析");
  const parsed = parseTracks(buffer);
  const allEvents = parsed.tracks.flat();
  const endTick = allEvents.reduce((max, event) => Math.max(max, event.tick), 0);
  const tempos = buildTempoMap(allEvents, parsed.division);
  const firstTempo = tempos[0]?.usPerQuarter ?? DEFAULT_TEMPO_US;
  const signatureEvents = allEvents
    .filter((event) => event.kind === "timeSignature")
    .sort((a, b) => a.tick - b.tick || a.order - b.order);
  const firstSignature = signatureEvents[0];
  const timeSignature = firstSignature === undefined
    ? "4/4"
    : `${firstSignature.data1}/${firstSignature.denominator ?? (firstSignature.data2 || 4)}`;

  const sorted = [...allEvents].sort((a, b) => {
    if (a.tick !== b.tick) return a.tick - b.tick;
    const priority = (kind: RawEvent["kind"]): number => {
      if (kind === "noteOff") return 0;
      if (kind === "program") return 1;
      if (kind === "control") return 2;
      if (kind === "tempo" || kind === "timeSignature") return 3;
      if (kind === "noteOn") return 4;
      return 5;
    };
    return priority(a.kind) - priority(b.kind) || a.order - b.order;
  });

  const notes: MidiNote[] = [];
  const open = new Map<string, Array<{ startTick: number; velocity: number; program: number; volume: number; pan: number }>>();
  const programOf = new Map<number, number>();
  const volumeOf = new Map<number, number>();
  const panOf = new Map<number, number>();
  const usedChannels = new Set<number>();
  for (const event of sorted) {
    if (event.kind === "program") {
      usedChannels.add(event.channel);
      programOf.set(event.channel, event.data1);
    } else if (event.kind === "control") {
      usedChannels.add(event.channel);
      if (event.data1 === 7) volumeOf.set(event.channel, event.data2);
      else if (event.data1 === 10) panOf.set(event.channel, event.data2);
    } else if (event.kind === "noteOn") {
      usedChannels.add(event.channel);
      const key = `${event.channel}:${event.data1}`;
      const stack = open.get(key) ?? [];
      stack.push({
        startTick: event.tick,
        velocity: event.data2,
        program: programOf.get(event.channel) ?? 0,
        volume: volumeOf.get(event.channel) ?? 100,
        pan: panOf.get(event.channel) ?? 64
      });
      open.set(key, stack);
    } else if (event.kind === "noteOff") {
      const key = `${event.channel}:${event.data1}`;
      const stack = open.get(key);
      const current = stack?.pop();
      if (stack !== undefined && stack.length === 0) open.delete(key);
      if (current === undefined) continue;
      const start = tickToSeconds(current.startTick, parsed.division, tempos);
      const end = tickToSeconds(event.tick, parsed.division, tempos);
      if (end <= start) continue;
      notes.push({
        channel: event.channel,
        note: event.data1,
        velocity: current.velocity,
        start,
        end,
        program: current.program,
        volume: current.volume,
        pan: current.pan
      });
    }
  }
  // 没有 note-off 的音：按文件结尾收掉（不丢音）。
  const endSeconds = tickToSeconds(endTick, parsed.division, tempos);
  for (const [key, stack] of open) {
    const [channelText, noteText] = key.split(":");
    const channel = Number(channelText);
    const note = Number(noteText);
    for (const current of stack) {
      const start = tickToSeconds(current.startTick, parsed.division, tempos);
      const end = Math.max(endSeconds, start + 0.05);
      notes.push({
        channel,
        note,
        velocity: current.velocity,
        start,
        end,
        program: current.program,
        volume: current.volume,
        pan: current.pan
      });
    }
  }
  notes.sort((a, b) => a.start - b.start || a.note - b.note);
  if (notes.length > 200_000) throw new MidiParseError(`MIDI 音符过多：${notes.length}（上限 200000）`);
  const duration = Math.max(
    endSeconds,
    notes.reduce((max, note) => Math.max(max, note.end), 0)
  );
  if (!Number.isFinite(duration) || duration <= 0) throw new MidiParseError("MIDI 没有有效时长");
  const programs: Record<number, number> = {};
  for (const [channel, program] of programOf) programs[channel] = program;
  return {
    meta: {
      duration,
      bars: computeBars(allEvents, parsed.division, endTick),
      tempo: Math.round((60_000_000 / firstTempo) * 100) / 100,
      timeSignature,
      tracks: parsed.tracks.length,
      channels: usedChannels.size,
      notes: notes.length
    },
    notes,
    programs
  };
}

/** 写 16-bit PCM WAV（RIFF / fmt / data）。samples 是交错的双声道 int16。 */
export function writeWavPcm16(samples: Int16Array, sampleRate: number, channels: number): Buffer {
  if (channels !== 1 && channels !== 2) throw new Error(`只支持 1 / 2 声道，收到 ${channels}`);
  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * 2, 28);
  buffer.writeUInt16LE(channels * 2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) buffer.writeInt16LE(samples[i], 44 + i * 2);
  return buffer;
}
