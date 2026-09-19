import type { SilenceSegment } from '../types';

/** 分析窗口宽度（秒）：20ms */
export const SILENCE_WINDOW = 0.02;
/** 最短静音段时长（秒）：连续低于阈值至少 200ms 才算静音段 */
export const MIN_SILENCE = 0.2;
/** 相邻静音段间隔小于该值（秒）时先合并：80ms */
export const MERGE_GAP = 0.08;
/** 拖动吸附范围（秒）：边界进入静音段边缘 ±150ms 内触发吸附 */
export const SNAP_RANGE = 0.15;

/** 秒 -> 毫秒精度（静音段边界统一对齐到 1ms，保证等距判断稳定） */
function toMs(t: number): number {
  return Math.round(t * 1000) / 1000;
}

/**
 * 按固定窗口计算「各声道 RMS 的最大值」序列。
 * 每个窗口取所有声道 RMS 中的最大值，任一声道有声即不算静音。
 * 末尾不足一个窗口的剩余样本也计入最后一个窗口。
 */
export function windowedMaxRms(
  channels: Float32Array[],
  sampleRate: number,
  windowSize: number = SILENCE_WINDOW
): Float32Array {
  if (channels.length === 0 || sampleRate <= 0 || windowSize <= 0) {
    return new Float32Array(0);
  }
  const windowSamples = Math.max(1, Math.round(windowSize * sampleRate));
  const length = Math.min(...channels.map((c) => c.length));
  if (length === 0) return new Float32Array(0);

  const windowCount = Math.ceil(length / windowSamples);
  const out = new Float32Array(windowCount);

  for (const ch of channels) {
    // 平方前缀和：每个窗口 O(1) 求得均方
    const prefix = new Float64Array(length + 1);
    for (let i = 0; i < length; i++) {
      prefix[i + 1] = prefix[i] + ch[i] * ch[i];
    }
    for (let w = 0; w < windowCount; w++) {
      const start = w * windowSamples;
      const end = Math.min(length, start + windowSamples);
      const mean = (prefix[end] - prefix[start]) / (end - start);
      const rms = Math.sqrt(mean);
      if (rms > out[w]) out[w] = rms;
    }
  }
  return out;
}

export interface SilenceDetectOptions {
  /** RMS 阈值（线性振幅 0..1），严格低于该值视为静音 */
  threshold: number;
  /** 最短静音时长（秒），合并后达到该时长才保留 */
  minSilence: number;
  /** 间隔严格小于该值（秒）的相邻静音段先合并 */
  mergeGap: number;
}

/**
 * 从窗口 RMS 序列提取静音段：
 * 1. 低于阈值的连续窗口组成原始静音游程；
 * 2. 间隔 < mergeGap 的相邻游程先合并（小缺口被吸收进段内）；
 * 3. 合并后时长 >= minSilence 的段才保留。
 * 边界比较带 1e-9 容差，避免毫秒舍入的浮点噪声误判边界值。
 */
export function detectSilence(
  rms: ArrayLike<number>,
  windowSize: number,
  opts: SilenceDetectOptions
): SilenceSegment[] {
  const EPS = 1e-9;
  const runs: SilenceSegment[] = [];
  let runStart = -1;
  for (let i = 0; i < rms.length; i++) {
    const silent = rms[i] < opts.threshold;
    if (silent && runStart < 0) runStart = i;
    if (!silent && runStart >= 0) {
      runs.push({ start: toMs(runStart * windowSize), end: toMs(i * windowSize) });
      runStart = -1;
    }
  }
  if (runStart >= 0) {
    runs.push({ start: toMs(runStart * windowSize), end: toMs(rms.length * windowSize) });
  }

  const merged: SilenceSegment[] = [];
  for (const seg of runs) {
    const last = merged[merged.length - 1];
    if (last && seg.start - last.end < opts.mergeGap - EPS) {
      last.end = seg.end;
    } else {
      merged.push({ ...seg });
    }
  }

  return merged.filter((s) => s.end - s.start >= opts.minSilence - EPS);
}

/**
 * 静音边缘吸附：在 t 的 ±snapRange 范围内找最近的静音段边缘（段首或段尾）。
 * 等距时取时间更早的边缘；范围内没有边缘时返回 null。
 */
export function snapToSilenceEdge(
  t: number,
  segments: SilenceSegment[],
  snapRange: number = SNAP_RANGE
): number | null {
  const EPS = 1e-9;
  let best: number | null = null;
  let bestDist = Infinity;
  for (const seg of segments) {
    for (const edge of [seg.start, seg.end]) {
      const dist = Math.abs(edge - t);
      if (dist > snapRange + EPS) continue;
      if (dist < bestDist - EPS || (dist <= bestDist + EPS && best !== null && edge < best)) {
        best = edge;
        bestDist = dist;
      }
    }
  }
  return best;
}
