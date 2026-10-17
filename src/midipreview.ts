/**
 * 谱曲模式的内置试听合成器（FluidSynth / SoundFont 不可用时的兜底）。
 *
 * 目标不是「好听」，而是**任何机器上都能听出曲式、节奏、和声与力度变化**：
 *   · 按 General MIDI 的 program family 选波形与包络；
 *   · 通道 9 按 GM 鼓映射合成 kick / snare / hihat / tom / crash / ride；
 *   · 读取 CC7 音量、CC10 声像；
 *   · 峰值归一到 -1 dBFS，不做压缩（保留力度弧）。
 *
 * 合成是确定性的：噪声用固定种子，同一份 MIDI 重复渲染结果一致。
 * 超过 `maxSeconds` 的曲子只渲染前段并标记 `truncated`，避免一次吃掉几百 MB。
 */

import { writeWavPcm16, type MidiNote, type ParsedMidi } from "./midifile.js";

export interface PreviewOptions {
  sampleRate?: number;
  /** 默认 480 秒；超过就截断。 */
  maxSeconds?: number;
}

export interface PreviewResult {
  wav: Buffer;
  sampleRate: number;
  duration: number;
  peak: number;
  truncated: boolean;
  notes: number;
}

const DEFAULT_SAMPLE_RATE = 44100;
const DEFAULT_MAX_SECONDS = 480;
const BLOCK_FRAMES = 4096;

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** 确定性 PRNG（mulberry32）：同一个 seed 每次渲染出同样的噪声。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface VoiceProfile {
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  gain: number;
  /** 使用指数衰减（拨弦 / 钢琴）；false 时是持续音。 */
  pluck: boolean;
}

function profileFor(program: number): VoiceProfile {
  const p = ((program % 128) + 128) % 128;
  if (p < 8) return { attack: 0.004, decay: 0.9, sustain: 0.12, release: 0.35, gain: 0.9, pluck: true };
  if (p < 16) return { attack: 0.002, decay: 0.45, sustain: 0.05, release: 0.5, gain: 0.8, pluck: true };
  if (p < 24) return { attack: 0.03, decay: 0.1, sustain: 0.8, release: 0.25, gain: 0.55, pluck: false };
  if (p < 32) return { attack: 0.006, decay: 0.5, sustain: 0.2, release: 0.25, gain: 0.85, pluck: true };
  if (p < 40) return { attack: 0.01, decay: 0.2, sustain: 0.7, release: 0.2, gain: 0.95, pluck: false };
  if (p < 48) return { attack: 0.08, decay: 0.2, sustain: 0.75, release: 0.5, gain: 0.55, pluck: false };
  if (p < 56) return { attack: 0.12, decay: 0.2, sustain: 0.8, release: 0.6, gain: 0.5, pluck: false };
  if (p < 64) return { attack: 0.04, decay: 0.2, sustain: 0.75, release: 0.35, gain: 0.6, pluck: false };
  if (p < 72) return { attack: 0.03, decay: 0.2, sustain: 0.8, release: 0.3, gain: 0.55, pluck: false };
  if (p < 80) return { attack: 0.05, decay: 0.15, sustain: 0.8, release: 0.4, gain: 0.6, pluck: false };
  if (p < 88) return { attack: 0.01, decay: 0.25, sustain: 0.6, release: 0.3, gain: 0.55, pluck: false };
  if (p < 96) return { attack: 0.25, decay: 0.3, sustain: 0.8, release: 0.8, gain: 0.45, pluck: false };
  if (p < 104) return { attack: 0.01, decay: 0.4, sustain: 0.2, release: 0.4, gain: 0.6, pluck: true };
  if (p < 112) return { attack: 0.02, decay: 0.35, sustain: 0.2, release: 0.35, gain: 0.6, pluck: true };
  if (p < 120) return { attack: 0.005, decay: 0.2, sustain: 0.1, release: 0.2, gain: 0.55, pluck: true };
  return { attack: 0.005, decay: 0.3, sustain: 0.2, release: 0.3, gain: 0.45, pluck: true };
}

/** program family 的波形。phase 是弧度，freq 只在需要频率相关的音色里用。 */
function waveFor(program: number, phase: number): number {
  const p = ((program % 128) + 128) % 128;
  if (p < 8) {
    // 钢琴：基音 + 二三次谐波，高次衰减靠包络
    return Math.sin(phase) + 0.34 * Math.sin(phase * 2) + 0.14 * Math.sin(phase * 3);
  }
  if (p < 16) {
    // 色彩打击：非整数谐波，钟琴感
    return Math.sin(phase) + 0.45 * Math.sin(phase * 3.01) + 0.2 * Math.sin(phase * 4.98);
  }
  if (p < 24) {
    // 风琴：加法合成
    return Math.sin(phase) + 0.5 * Math.sin(phase * 2) + 0.28 * Math.sin(phase * 3) + 0.16 * Math.sin(phase * 4);
  }
  if (p < 32) {
    // 吉他：锯齿感 + 拨弦瞬态
    return 0.55 * Math.sin(phase) + 0.3 * Math.sin(phase * 2) + 0.12 * Math.sin(phase * 3);
  }
  if (p < 40) {
    // 贝斯：基音 + 少量二次
    return Math.sin(phase) + 0.25 * Math.sin(phase * 2);
  }
  if (p < 48) {
    // 弦乐：两个微微失谐的锯齿
    return 0.42 * Math.sin(phase) + 0.3 * Math.sin(phase * 2.01) + 0.16 * Math.sin(phase * 3.02) + 0.1 * Math.sin(phase * 4.03);
  }
  if (p < 56) {
    // 合奏：更宽的失谐
    return 0.3 * Math.sin(phase) + 0.26 * Math.sin(phase * 2.02) + 0.2 * Math.sin(phase * 3.03) + 0.12 * Math.sin(phase * 4.04) + 0.08 * Math.sin(phase * 5.05);
  }
  if (p < 64) {
    // 铜管：锯齿 + 二次
    return 0.5 * Math.sin(phase) + 0.3 * Math.sin(phase * 2) + 0.16 * Math.sin(phase * 3) + 0.08 * Math.sin(phase * 4);
  }
  if (p < 72) {
    // 簧片：方波感
    return Math.sin(phase) + 0.38 * Math.sin(phase * 3) + 0.18 * Math.sin(phase * 5);
  }
  if (p < 80) {
    // 管乐：柔和基音 + 二次
    return Math.sin(phase) + 0.18 * Math.sin(phase * 2) + 0.06 * Math.sin(phase * 3);
  }
  if (p < 88) {
    // 合成主音：锯齿
    return 0.5 * Math.sin(phase) + 0.28 * Math.sin(phase * 2) + 0.14 * Math.sin(phase * 3) + 0.07 * Math.sin(phase * 4);
  }
  if (p < 96) {
    // 合成垫：慢起音 + 三角感
    return 0.45 * Math.sin(phase) + 0.2 * Math.sin(phase * 2) + 0.08 * Math.sin(phase * 3);
  }
  if (p < 104) {
    return Math.sin(phase) + 0.3 * Math.sin(phase * 2.01);
  }
  if (p < 112) {
    return 0.6 * Math.sin(phase) + 0.25 * Math.sin(phase * 2) + 0.12 * Math.sin(phase * 3.01);
  }
  if (p < 120) {
    return 0.7 * Math.sin(phase) + 0.2 * Math.sin(phase * 2);
  }
  return 0.5 * Math.sin(phase) + 0.25 * Math.sin(phase * 2.5);
}

/** 包络：attack → decay 到 sustain → note 结束后的 release。 */
function envelopeAt(profile: VoiceProfile, elapsed: number, noteDuration: number): number {
  if (elapsed < 0) return 0;
  if (elapsed < noteDuration) {
    const attack = Math.max(0.001, profile.attack);
    if (elapsed < attack) return elapsed / attack;
    if (profile.pluck) {
      const decay = Math.max(0.02, profile.decay);
      const t = elapsed - attack;
      return profile.sustain + (1 - profile.sustain) * Math.exp(-t / decay);
    }
    const decay = Math.max(0.02, profile.decay);
    const t = elapsed - attack;
    return profile.sustain + (1 - profile.sustain) * Math.exp(-t / decay);
  }
  const release = Math.max(0.03, profile.release);
  const atEnd = envelopeAt({ ...profile, release }, noteDuration - 1e-6, noteDuration);
  return atEnd * Math.exp(-(elapsed - noteDuration) / release);
}

function noteFrequency(note: number): number {
  return 440 * Math.pow(2, (note - 69) / 12);
}

function panGains(pan: number): { left: number; right: number } {
  const clamped = clamp(pan, -1, 1);
  // 等功率声像
  const angle = ((clamped + 1) / 2) * (Math.PI / 2);
  return { left: Math.cos(angle), right: Math.sin(angle) };
}

/** GM 鼓：返回一个 0..1 的包络值；不同 note 用不同合成方式。 */
function drumSample(note: number, elapsed: number, noise: () => number): number {
  if (elapsed < 0) return 0;
  const n = note;
  if (n === 35 || n === 36) {
    // kick：音高从 120Hz 快速下探到 45Hz
    const f = 45 + 75 * Math.exp(-elapsed / 0.035);
    const env = Math.exp(-elapsed / 0.22);
    return Math.sin(2 * Math.PI * f * elapsed) * env * 1.1;
  }
  if (n === 38 || n === 40) {
    // snare：噪声 + 180Hz 鼓身
    const env = Math.exp(-elapsed / 0.13);
    return (noise() * 0.7 + Math.sin(2 * Math.PI * 180 * elapsed) * 0.35) * env;
  }
  if (n === 39) {
    // clap：三连击噪声
    const burst = (t: number) => (t >= 0 && t < 0.05 ? Math.exp(-t / 0.018) : 0);
    const env = Math.max(burst(elapsed), burst(elapsed - 0.035), burst(elapsed - 0.07)) + Math.exp(-elapsed / 0.12) * 0.25;
    return noise() * env;
  }
  if (n === 42 || n === 44) {
    return noise() * Math.exp(-elapsed / 0.035) * 0.55;
  }
  if (n === 46) {
    return noise() * Math.exp(-elapsed / 0.28) * 0.5;
  }
  if (n === 49 || n === 57) {
    return noise() * Math.exp(-elapsed / 0.9) * 0.42;
  }
  if (n === 51 || n === 59) {
    return (noise() * 0.35 + Math.sin(2 * Math.PI * 6000 * elapsed) * 0.15) * Math.exp(-elapsed / 0.45);
  }
  if (n >= 41 && n <= 50) {
    const base = 90 + (n - 41) * 18;
    const f = base + 60 * Math.exp(-elapsed / 0.08);
    return Math.sin(2 * Math.PI * f * elapsed) * Math.exp(-elapsed / 0.3) * 0.8;
  }
  if (n === 37) return Math.sin(2 * Math.PI * 800 * elapsed) * Math.exp(-elapsed / 0.08) * 0.6; // side stick
  if (n === 56) return Math.sin(2 * Math.PI * 800 * elapsed) * Math.exp(-elapsed / 0.18) * 0.5; // cowbell
  if (n === 54 || n === 69 || n === 70) return noise() * Math.exp(-elapsed / 0.12) * 0.45;
  // 其它鼓：短噪声，保证听得到
  return noise() * Math.exp(-elapsed / 0.1) * 0.4;
}

function noteGain(note: MidiNote): number {
  const velocity = clamp(note.velocity / 127, 0, 1);
  const volume = clamp(note.volume / 127, 0, 1);
  const profile = profileFor(note.program);
  return profile.gain * (0.25 + 0.75 * velocity) * (0.35 + 0.65 * volume);
}

function notePan(note: MidiNote): number {
  if (note.channel === 9) return 0;
  return clamp((note.pan - 64) / 64, -1, 1);
}

/**
 * 把解析后的 MIDI 渲染成 WAV。
 *
 * 返回的 `peak` 是归一化前的最大绝对采样值，便于调用方诊断「是不是整首太轻」。
 */
export function renderMidiToWav(parsed: ParsedMidi, options: PreviewOptions = {}): PreviewResult {
  const sampleRate = Math.max(8000, Math.min(96000, Math.round(options.sampleRate ?? DEFAULT_SAMPLE_RATE)));
  const maxSeconds = Math.max(1, Math.min(900, options.maxSeconds ?? DEFAULT_MAX_SECONDS));
  const sourceDuration = Math.max(0, parsed.meta.duration);
  const truncated = sourceDuration > maxSeconds;
  const duration = Math.min(sourceDuration + 0.8, maxSeconds);
  const totalFrames = Math.max(1, Math.ceil(duration * sampleRate));
  const notes = parsed.notes.filter((note) => note.start < duration && note.velocity > 0);
  if (notes.length > 80_000) throw new Error(`音符太多（${notes.length}），内置试听合成器拒绝渲染；请安装 FluidSynth + SoundFont。`);

  const out = Buffer.alloc(totalFrames * 4);
  const mixL = new Float32Array(BLOCK_FRAMES);
  const mixR = new Float32Array(BLOCK_FRAMES);
  // 每个音符一个固定噪声种子，保证同一份 MIDI 每次渲染一致。
  const noiseSeeds = notes.map((note, index) => {
    let seed = (note.channel + 1) * 73856093 ^ (note.note + 1) * 19349663 ^ Math.round(note.start * 1000) * 83492791 ^ index;
    return seed >>> 0;
  });
  let peak = 0;

  for (let blockStart = 0; blockStart < totalFrames; blockStart += BLOCK_FRAMES) {
    const blockLength = Math.min(BLOCK_FRAMES, totalFrames - blockStart);
    mixL.fill(0, 0, blockLength);
    mixR.fill(0, 0, blockLength);
    const blockTime = blockStart / sampleRate;
    const blockEnd = (blockStart + blockLength) / sampleRate;

    for (let index = 0; index < notes.length; index++) {
      const note = notes[index];
      const profile = profileFor(note.program);
      const releaseEnd = note.end + profile.release + 0.05;
      if (releaseEnd <= blockTime) continue;
      if (note.start >= blockEnd) break; // notes 按 start 排序
      const fromFrame = Math.max(blockStart, Math.floor(note.start * sampleRate));
      const toFrame = Math.min(blockStart + blockLength, Math.ceil(releaseEnd * sampleRate));
      if (toFrame <= fromFrame) continue;

      const pan = notePan(note);
      const gains = panGains(pan);
      const baseGain = noteGain(note) * 0.16;
      const frequency = noteFrequency(note.note);
      const isDrum = note.channel === 9;
      const noise = isDrum ? mulberry32(noiseSeeds[index]) : null;
      const noteDuration = note.end - note.start;
      // release 段的起点包络只算一次，避免每个采样递归。
      const atEnd = isDrum ? 1 : envelopeAt(profile, Math.max(0, noteDuration - 1e-6), noteDuration);

      for (let frame = fromFrame; frame < toFrame; frame++) {
        const elapsed = frame / sampleRate - note.start;
        let sample: number;
        if (isDrum) {
          sample = drumSample(note.note, elapsed, noise as () => number) * baseGain * 1.6;
        } else {
          let env: number;
          if (elapsed < noteDuration) {
            env = envelopeAt(profile, elapsed, noteDuration);
          } else {
            const release = Math.max(0.03, profile.release);
            env = atEnd * Math.exp(-(elapsed - noteDuration) / release);
          }
          if (env <= 0.00001) continue;
          const phase = 2 * Math.PI * frequency * Math.max(0, elapsed);
          sample = waveFor(note.program, phase) * env * baseGain;
        }
        if (!Number.isFinite(sample) || sample === 0) continue;
        const offset = frame - blockStart;
        mixL[offset] += sample * gains.left;
        mixR[offset] += sample * gains.right;
      }
    }

    for (let i = 0; i < blockLength; i++) {
      // 软限幅：多声部叠加时不至于硬削成方波
      const left = Math.tanh(mixL[i] * 1.15);
      const right = Math.tanh(mixR[i] * 1.15);
      const absolute = Math.max(Math.abs(left), Math.abs(right));
      if (absolute > peak) peak = absolute;
      const offset = (blockStart + i) * 4;
      out.writeInt16LE(Math.round(clamp(left, -1, 1) * 32767), offset);
      out.writeInt16LE(Math.round(clamp(right, -1, 1) * 32767), offset + 2);
    }
  }

  // 归一化到 -1 dBFS：太响压下来，太轻提上去（最多 8 倍，避免把底噪拉爆）。
  if (peak > 0) {
    const target = 0.89;
    const desired = target / Math.max(peak, 1e-6);
    const scale = desired < 1 ? desired : Math.min(desired, 8);
    if (Math.abs(scale - 1) > 0.01) {
      for (let offset = 0; offset < out.length; offset += 2) {
        const value = out.readInt16LE(offset) * scale;
        out.writeInt16LE(Math.round(clamp(value, -32768, 32767)), offset);
      }
    }
  }

  return {
    wav: writeWavPcm16(new Int16Array(out.buffer, out.byteOffset, out.length / 2), sampleRate, 2),
    sampleRate,
    duration,
    peak,
    truncated,
    notes: notes.length
  };
}
