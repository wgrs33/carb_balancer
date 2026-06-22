import { adcToKpa } from './signal_processor';
import type { RawWaveMessage } from './types';

export function defaultRecordingFilename(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `carb_balancer_${date}-${time}.csv`;
}

/** Buffers per-sample kPa values for the active channels and downloads them as a CSV on stop(). */
export class CsvRecorder {
  private rows: string[] = [];
  private channels: number[] = [];

  start(channelMask: number): void {
    this.channels = [];
    for (let c = 0; c < 4; c++) if (channelMask & (1 << c)) this.channels.push(c);
    this.rows = [this.channels.map((c) => `Ch${c + 1}`).join(',')];
  }

  append(msg: RawWaveMessage): void {
    const arrays = this.channels.map((c) => msg.chs[c]);
    if (arrays.some((a) => !a)) return;

    const n = Math.min(...(arrays as number[][]).map((a) => a.length));
    for (let i = 0; i < n; i++) {
      this.rows.push((arrays as number[][]).map((a) => adcToKpa(a[i]).toFixed(2)).join(','));
    }
  }

  stop(filename: string): void {
    const blob = new Blob([this.rows.join('\n')], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    this.rows = [];
  }
}
