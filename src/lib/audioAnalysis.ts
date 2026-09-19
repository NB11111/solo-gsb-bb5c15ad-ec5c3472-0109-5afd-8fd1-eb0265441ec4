import { SILENCE_WINDOW, windowedMaxRms } from './silence';

/** 一次静音分析的产物：窗口 RMS 序列 + 元信息（不含原始 PCM，解码后即释放） */
export interface RmsProfile {
  /** 每个窗口各声道 RMS 的最大值 */
  rms: Float32Array;
  /** 窗口宽度（秒） */
  windowSize: number;
  /** 音频时长（秒） */
  duration: number;
  /** 采样率（Hz） */
  sampleRate: number;
}

/**
 * 分析句柄。promise  resolve 为 null 表示「已取消」；
 * cancel() 会关闭解码上下文打断进行中的解码，并保证旧结果不再回写。
 */
export interface AnalysisHandle {
  promise: Promise<RmsProfile | null>;
  cancel: () => void;
}

/**
 * 用 Web Audio API 解码本地音频文件并计算窗口 RMS 序列。
 * 解码在独立 AudioContext 中进行，与播放用的 <audio> 元素互不影响。
 */
export function analyzeAudioFile(file: File, windowSize: number = SILENCE_WINDOW): AnalysisHandle {
  let cancelled = false;

  const AudioCtx: typeof AudioContext | undefined =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

  let ctx: AudioContext | null = null;
  const closeCtx = () => {
    if (ctx) {
      void ctx.close().catch(() => undefined);
      ctx = null;
    }
  };

  const promise = (async (): Promise<RmsProfile | null> => {
    if (!AudioCtx) throw new Error('当前浏览器不支持 Web Audio API');
    ctx = new AudioCtx();
    try {
      const buf = await file.arrayBuffer();
      if (cancelled) return null;
      let audio: AudioBuffer;
      try {
        audio = await ctx.decodeAudioData(buf);
      } catch (err) {
        // 取消时关闭上下文会中断解码，属正常取消而非错误
        if (cancelled) return null;
        throw err;
      }
      if (cancelled) return null;
      const channels: Float32Array[] = [];
      for (let c = 0; c < audio.numberOfChannels; c++) {
        channels.push(audio.getChannelData(c));
      }
      const rms = windowedMaxRms(channels, audio.sampleRate, windowSize);
      if (cancelled) return null;
      return {
        rms,
        windowSize,
        duration: audio.duration,
        sampleRate: audio.sampleRate
      };
    } finally {
      closeCtx();
    }
  })();

  return {
    promise,
    cancel: () => {
      cancelled = true;
      closeCtx();
    }
  };
}
