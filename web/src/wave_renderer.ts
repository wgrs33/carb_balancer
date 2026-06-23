import type { RawWaveMessage, WavePoint } from './types';
import { adcToKpa } from './signal_processor';

const WAVE_MAX  = 1200;
const CH_COLORS = ['#4caf50', '#42a5f5', '#ffc107', '#ef5350'];

function niceStep(rough: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(rough || 1)));
  const f = rough / p;
  return f < 1.5 ? p : f < 3.5 ? 2 * p : f < 7.5 ? 5 * p : 10 * p;
}

export class WaveRenderer {
  private waveChs: WavePoint[][] = [[], [], [], []];
  private visibleChs = [true, true, true, true];
  private viewPts    = window.matchMedia('(max-width: 520px)').matches ? 100 : 400;
  private viewOffset = 0;
  private waveSpan   = 200;
  private channels: number[] = [];

  private active = false;  // collecting live data + rendering
  private frozen = false;  // data frozen, still rendering last frame

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  start(): void {
    this.waveChs    = [[], [], [], []];
    this.viewOffset = 0;
    this.active     = true;
    this.frozen     = false;
  }

  stop(): void {
    this.active = false;
    this.frozen = true;
  }

  reset(): void {
    this.active = false;
    this.frozen = false;
  }

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  setChannels(mask: number): void {
    this.channels = [];
    for (let c = 0; c < 4; c++) if (mask & (1 << c)) this.channels.push(c);
  }
  setViewPts(n: number): void  { this.viewPts = n; }
  setWaveSpan(n: number): void { this.waveSpan = n; }

  onScroll(sliderVal: number, sliderMax: number): void {
    this.viewOffset = sliderMax - sliderVal;
  }

  buildControls(): void {
    const ctrl = document.getElementById('wave-ch-btns')!;
    ctrl.innerHTML = '';
    for (const ch of this.channels) {
      const btn = document.createElement('button');
      btn.textContent = `Cyl ${ch + 1}`;
      btn.style.color = CH_COLORS[ch];
      btn.style.borderColor = CH_COLORS[ch];
      btn.className = this.visibleChs[ch] ? '' : 'off';
      btn.onclick = () => {
        this.visibleChs[ch] = !this.visibleChs[ch];
        btn.className = this.visibleChs[ch] ? '' : 'off';
      };
      ctrl.appendChild(btn);
    }
    const zoom = document.getElementById('wave-zoom') as HTMLInputElement;
    zoom.value = String(this.viewPts);
    (document.getElementById('wave-zoom-val') as HTMLElement).textContent = String(this.viewPts);
  }

  // ---------------------------------------------------------------------------
  // Data ingestion (called from onmessage — no DOM touches)
  // ---------------------------------------------------------------------------

  append(msg: RawWaveMessage): void {
    if (!this.active) return;
    for (let c = 0; c < 4; c++) {
      const ch = msg.chs[c];
      if (!ch) continue;
      const pts = this.waveChs[c];
      for (let i = 0; i < ch.length; i++)
        pts.push({ t: msg.t0 + i * msg.dt, v: adcToKpa(ch[i]) });
      if (pts.length > WAVE_MAX)
        this.waveChs[c] = pts.slice(pts.length - WAVE_MAX);
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering (called from RAF tick — owns all DOM work for this module)
  // ---------------------------------------------------------------------------

  drawFrame(): void {
    this.updateScrollSlider();
    this.draw();
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private maxDataLen(): number {
    let n = 0;
    for (const ch of this.channels) n = Math.max(n, this.waveChs[ch]?.length ?? 0);
    return n;
  }

  private updateScrollSlider(): void {
    const maxOff = Math.max(0, this.maxDataLen() - this.viewPts);
    const row = document.getElementById('wave-scroll-row') as HTMLElement;
    const sl  = document.getElementById('wave-scroll') as HTMLInputElement;
    if (maxOff > 0) {
      sl.max = String(maxOff);
      this.viewOffset = Math.min(this.viewOffset, maxOff);
      sl.value = String(maxOff - this.viewOffset);
      row.style.display = '';
    } else {
      this.viewOffset = 0;
      row.style.display = 'none';
    }
  }

  private draw(): void {
    const canvas = document.getElementById('wave-canvas') as HTMLCanvasElement;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#1a1a1a'; ctx.fillRect(0, 0, w, h);

    const mobile = window.matchMedia('(max-width: 520px)').matches;
    const ml = mobile ? 34 : 46, mr = 8, mt = 14, mb = mobile ? 16 : 22;
    const pw = w - ml - mr, ph = h - mt - mb;

    const showLines = this.active || this.frozen;
    const slices: WavePoint[][] = [];
    let yMin = Infinity, yMax = -Infinity;

    if (showLines) {
      for (const ch of this.channels) {
        const d   = this.waveChs[ch] ?? [];
        const end   = d.length - this.viewOffset;
        const start = Math.max(0, end - this.viewPts);
        const sl    = d.slice(start, end);
        slices.push(sl);
        if (!this.visibleChs[ch]) continue;
        for (const pt of sl) { yMin = Math.min(yMin, pt.v); yMax = Math.max(yMax, pt.v); }
      }
    }

    const center = isFinite(yMin) ? (yMin + yMax) / 2 : 70;
    yMin = center - this.waveSpan / 2;
    yMax = center + this.waveSpan / 2;

    const tx = (off: number) => ml + (off / this.viewPts) * pw;
    const ty = (v: number)   => mt + (1 - (v - yMin) / (yMax - yMin)) * ph;

    // Grid lines + Y labels
    const step = niceStep((yMax - yMin) / 4);
    ctx.lineWidth = 1;
    for (let y = Math.ceil(yMin / step) * step; y <= yMax; y += step) {
      const yy = ty(y);
      ctx.strokeStyle = '#2a2a2a'; ctx.beginPath(); ctx.moveTo(ml, yy); ctx.lineTo(ml + pw, yy); ctx.stroke();
      ctx.fillStyle = '#555'; ctx.font = `${mobile ? 9 : 10}px sans-serif`; ctx.textAlign = 'right';
      ctx.fillText(y.toFixed(0), ml - 4, yy + 3);
    }
    ctx.fillStyle = '#444'; ctx.font = '9px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText('kPa', 2, mt + 9);

    // Channel legend
    this.channels.forEach((ch, pos) => {
      const lx = ml + 6 + pos * 58;
      ctx.fillStyle = CH_COLORS[ch]; ctx.fillRect(lx, mt + 2, 12, 2);
      ctx.fillStyle = '#999'; ctx.font = '10px sans-serif'; ctx.textAlign = 'left';
      ctx.fillText(`Cyl ${ch + 1}`, lx + 15, mt + 6);
    });

    // Waveforms
    if (showLines && slices.length > 0) {
      for (let pos = 0; pos < this.channels.length; pos++) {
        const ch = this.channels[pos];
        const sl = slices[pos];
        if (!this.visibleChs[ch] || sl.length < 2) continue;
        const off = this.viewPts - sl.length;
        ctx.strokeStyle = CH_COLORS[ch]; ctx.lineWidth = 1.5; ctx.beginPath();
        for (let i = 0; i < sl.length; i++) {
          const px = tx(off + i), py = ty(sl[i].v);
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
      if (this.frozen) {
        ctx.fillStyle = '#666'; ctx.font = '11px sans-serif'; ctx.textAlign = 'right';
        ctx.fillText('Frozen', ml + pw - 4, mt + 12);
      }
    } else if (!showLines) {
      ctx.fillStyle = '#444'; ctx.font = '13px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('Press Start Plot to begin', w / 2, h / 2);
    }
  }
}
