import type { Constraints } from '../types';
import { formatClock } from '../lib/srt';

interface ToolbarProps {
  audioName: string | null;
  srtName: string | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  canUndo: boolean;
  canRedo: boolean;
  pps: number;
  constraints: Constraints;
  onImportSrt: (file: File) => void;
  onImportAudio: (file: File) => void;
  onTogglePlay: () => void;
  onSeek: (t: number) => void;
  onUndo: () => void;
  onRedo: () => void;
  onZoom: (pps: number) => void;
  onConstraintsChange: (next: Constraints) => void;
  onExport: () => void;
  canExport: boolean;
  /** 静音吸附开关 */
  snapEnabled: boolean;
  onSnapEnabledChange: (on: boolean) => void;
  /** 静音 RMS 阈值（线性振幅） */
  silenceThreshold: number;
  onSilenceThresholdChange: (v: number) => void;
}

export default function Toolbar(p: ToolbarProps) {
  return (
    <header className="toolbar">
      <div className="brand">🎬 字幕节奏校对台</div>

      <div className="group file-group">
        <label className="btn">
          导入 SRT
          <input
            type="file"
            accept=".srt,text/plain"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) p.onImportSrt(f);
              e.target.value = '';
            }}
          />
        </label>
        <label className="btn">
          导入音频
          <input
            type="file"
            accept="audio/*,.m4a,.aac,.ogg,.opus,.webm"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) p.onImportAudio(f);
              e.target.value = '';
            }}
          />
        </label>
        <span className="file-names" title={[p.srtName, p.audioName].filter(Boolean).join(' / ')}>
          {p.srtName ?? '未选择字幕'} · {p.audioName ?? '未选择音频'}
        </span>
      </div>

      <div className="group transport">
        <button className="btn icon" onClick={p.onTogglePlay} disabled={!p.audioName} title="播放/暂停（空格）">
          {p.isPlaying ? '⏸' : '▶'}
        </button>
        <span className="clock">
          {formatClock(p.currentTime)} / {formatClock(p.duration)}
        </span>
      </div>

      <div className="group zoom-group">
        <span>缩放</span>
        <input
          type="range"
          min={10}
          max={400}
          step={5}
          value={p.pps}
          onChange={(e) => p.onZoom(Number(e.target.value))}
        />
      </div>

      <div className="group constraint-group">
        <label>
          最短时长
          <input
            type="number"
            min={0}
            step={0.1}
            value={p.constraints.minDuration}
            onChange={(e) =>
              p.onConstraintsChange({ ...p.constraints, minDuration: Math.max(0, Number(e.target.value) || 0) })
            }
          />
          s
        </label>
        <label>
          最小间隔
          <input
            type="number"
            min={0}
            step={0.1}
            value={p.constraints.minGap}
            onChange={(e) =>
              p.onConstraintsChange({ ...p.constraints, minGap: Math.max(0, Number(e.target.value) || 0) })
            }
          />
          s
        </label>
      </div>

      <div className="group snap-group">
        <label className="snap-toggle" title="拖动边界进入静音段边缘 ±150ms 时吸附到最近边缘（等距取更早者）">
          <input
            type="checkbox"
            checked={p.snapEnabled}
            onChange={(e) => p.onSnapEnabledChange(e.target.checked)}
          />
          静音吸附
        </label>
        <label title="各声道 20ms 窗口 RMS 最大值低于该阈值视为静音，调整后即时重新分段">
          静音阈值
          <input
            type="number"
            min={0.0001}
            max={0.5}
            step={0.005}
            value={p.silenceThreshold}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (!Number.isFinite(v)) return;
              p.onSilenceThresholdChange(Math.min(0.5, Math.max(0.0001, v)));
            }}
          />
        </label>
      </div>

      <div className="group history-group">
        <button className="btn" onClick={p.onUndo} disabled={!p.canUndo} title="撤销（Ctrl/⌘+Z）">
          ↶ 撤销
        </button>
        <button className="btn" onClick={p.onRedo} disabled={!p.canRedo} title="重做（Ctrl/⌘+Shift+Z）">
          ↷ 重做
        </button>
      </div>

      <button className="btn primary" onClick={p.onExport} disabled={!p.canExport}>
        导出 SRT
      </button>
    </header>
  );
}
