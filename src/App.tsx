import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Toolbar from './components/Toolbar';
import Timeline from './components/Timeline';
import CueList from './components/CueList';
import type { Constraints, Cue } from './types';
import { parseSrt, serializeSrt } from './lib/srt';
import {
  commitHistory,
  initHistory,
  redoHistory,
  replaceHistory,
  undoHistory
} from './lib/cues';
import { detectSilence, MERGE_GAP, MIN_SILENCE } from './lib/silence';
import { analyzeAudioFile, type AnalysisHandle, type RmsProfile } from './lib/audioAnalysis';

interface Toast {
  id: number;
  kind: 'warn' | 'info' | 'error';
  text: string;
}

export default function App() {
  const [history, setHistory] = useState(() => initHistory([]));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [constraints, setConstraints] = useState<Constraints>({
    minDuration: 0.5,
    minGap: 0.08
  });
  const [pps, setPps] = useState(80);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [srtName, setSrtName] = useState<string | null>(null);
  const [audioName, setAudioName] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  // 静音吸附：RMS 序列（解码产物）、可调阈值、吸附开关、分析状态
  const [rmsProfile, setRmsProfile] = useState<RmsProfile | null>(null);
  const [silenceThreshold, setSilenceThreshold] = useState(0.01);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const analysisRef = useRef<AnalysisHandle | null>(null);
  const toastId = useRef(0);

  const cues = history.present;

  // 阈值变化时基于已算好的 RMS 序列即时重新分段，无需重新解码
  const silenceSegments = useMemo(() => {
    if (!rmsProfile) return [];
    return detectSilence(rmsProfile.rms, rmsProfile.windowSize, {
      threshold: silenceThreshold,
      minSilence: MIN_SILENCE,
      mergeGap: MERGE_GAP
    });
  }, [rmsProfile, silenceThreshold]);

  const pushToast = useCallback((kind: Toast['kind'], text: string) => {
    toastId.current += 1;
    const id = toastId.current;
    setToasts((t) => [...t, { id, kind, text }]);
    window.setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id));
    }, 4200);
  }, []);

  /* ---------------- 音频 ---------------- */

  const ensureAudio = useCallback(() => {
    if (!audioRef.current) {
      const el = new Audio();
      el.preload = 'auto';
      el.addEventListener('timeupdate', () => setCurrentTime(el.currentTime));
      el.addEventListener('loadedmetadata', () => setDuration(el.duration || 0));
      el.addEventListener('play', () => setIsPlaying(true));
      el.addEventListener('pause', () => setIsPlaying(false));
      el.addEventListener('ended', () => setIsPlaying(false));
      audioRef.current = el;
    }
    return audioRef.current;
  }, []);

  useEffect(() => {
    return () => {
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
      audioRef.current?.pause();
      analysisRef.current?.cancel();
    };
  }, []);

  const handleImportAudio = useCallback(
    (file: File) => {
      const el = ensureAudio();
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
      const url = URL.createObjectURL(file);
      audioUrlRef.current = url;
      el.src = url;
      el.load();
      setAudioName(file.name);
      setCurrentTime(0);

      // 更换音频：取消旧分析并阻止旧结果回写
      analysisRef.current?.cancel();
      setRmsProfile(null);
      setAnalyzing(true);
      const handle = analyzeAudioFile(file);
      analysisRef.current = handle;
      handle.promise
        .then((profile) => {
          if (analysisRef.current !== handle) return; // 已被更新的分析取代
          analysisRef.current = null;
          setAnalyzing(false);
          if (!profile) return; // 已取消
          setRmsProfile(profile);
          pushToast('info', `静音分析完成：${file.name}`);
        })
        .catch(() => {
          if (analysisRef.current !== handle) return;
          analysisRef.current = null;
          setAnalyzing(false);
          pushToast('warn', `无法解码音频，静音吸附不可用：${file.name}`);
        });

      pushToast('info', `已加载音频：${file.name}`);
    },
    [ensureAudio, pushToast]
  );

  const seek = useCallback(
    (t: number, play = false) => {
      const el = audioRef.current;
      if (!el || !audioUrlRef.current) {
        // 未导入音频时仍允许播放头移动，便于纯字幕检查
        setCurrentTime(Math.max(0, t));
        return;
      }
      const target = Math.max(0, Math.min(t, el.duration || t));
      el.currentTime = target;
      setCurrentTime(target);
      if (play) {
        void el.play().catch(() => pushToast('error', '浏览器拒绝了自动播放，请再点一次播放'));
      }
    },
    [pushToast]
  );

  const seekAndPlay = useCallback((t: number) => seek(t, true), [seek]);

  const togglePlay = useCallback(() => {
    const el = audioRef.current;
    if (!el || !audioUrlRef.current) {
      pushToast('warn', '请先导入浏览器可播放的音频文件');
      return;
    }
    if (el.paused) void el.play();
    else el.pause();
  }, [pushToast]);

  /* ---------------- SRT ---------------- */

  const handleImportSrt = useCallback(
    (file: File) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = parseSrt(String(reader.result ?? ''));
        if (result.cues.length === 0) {
          pushToast('error', '未从该文件解析出任何有效字幕');
          return;
        }
        setHistory((h) => replaceHistory(h, result.cues));
        setSrtName(file.name);
        setSelectedId(result.cues[0]?.id ?? null);
        pushToast('info', `已导入 ${result.cues.length} 条字幕：${file.name}`);
        result.warnings.forEach((w) => pushToast('warn', w));
      };
      reader.onerror = () => pushToast('error', `读取文件失败：${file.name}`);
      reader.readAsText(file, 'utf-8');
    },
    [pushToast]
  );

  /* ---------------- 历史 ---------------- */

  const commit = useCallback((next: Cue[]) => {
    setHistory((h) => commitHistory(h, next));
  }, []);

  const undo = useCallback(() => setHistory((h) => undoHistory(h)), []);
  const redo = useCallback(() => setHistory((h) => redoHistory(h)), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      } else if (e.key === ' ') {
        e.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, togglePlay]);

  /* ---------------- 导出 ---------------- */

  const exportSrt = useCallback(() => {
    if (cues.length === 0) {
      pushToast('warn', '没有可导出的字幕');
      return;
    }
    const blob = new Blob([serializeSrt(cues)], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const base = (srtName ?? 'subtitles.srt').replace(/\.srt$/i, '');
    a.href = url;
    a.download = `${base}.fixed.srt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    pushToast('info', '已导出按时间顺序重新编号的 SRT');
  }, [cues, srtName, pushToast]);

  const statusText = useMemo(() => {
    const base =
      cues.length === 0
        ? '等待导入：先选择 SRT，再选择音频'
        : `${cues.length} 条字幕 · 已记录 ${history.past.length} 次调整`;
    if (analyzing) return `${base} · 静音分析中…`;
    if (rmsProfile) {
      return `${base} · 检测到 ${silenceSegments.length} 段静音（吸附${snapEnabled ? '开' : '关'}）`;
    }
    return base;
  }, [cues.length, history.past.length, analyzing, rmsProfile, silenceSegments.length, snapEnabled]);

  return (
    <div className="app">
      <Toolbar
        audioName={audioName}
        srtName={srtName}
        isPlaying={isPlaying}
        currentTime={currentTime}
        duration={duration}
        canUndo={history.past.length > 0}
        canRedo={history.future.length > 0}
        pps={pps}
        constraints={constraints}
        onImportSrt={handleImportSrt}
        onImportAudio={handleImportAudio}
        onTogglePlay={togglePlay}
        onSeek={seekAndPlay}
        onUndo={undo}
        onRedo={redo}
        onZoom={setPps}
        onConstraintsChange={setConstraints}
        onExport={exportSrt}
        canExport={cues.length > 0}
        snapEnabled={snapEnabled}
        onSnapEnabledChange={setSnapEnabled}
        silenceThreshold={silenceThreshold}
        onSilenceThresholdChange={setSilenceThreshold}
      />

      <main className="main">
        <section className="stage">
          <div className="status-bar">
            <span>{statusText}</span>
            <span className="status-hint">
              拖动字幕块左右边界校对 · 靠近静音边缘自动吸附 · 越界自动回弹并提示原因 · 点击字幕块定位播放
            </span>
          </div>
          <Timeline
            cues={cues}
            duration={duration}
            currentTime={currentTime}
            isPlaying={isPlaying}
            pps={pps}
            constraints={constraints}
            selectedId={selectedId}
            silenceSegments={silenceSegments}
            snapEnabled={snapEnabled}
            onSelect={setSelectedId}
            onSeek={seekAndPlay}
            onCommit={commit}
          />
        </section>
        <CueList
          cues={cues}
          currentTime={currentTime}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onSeek={seekAndPlay}
        />
      </main>

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
