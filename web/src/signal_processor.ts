import type { RawWaveMessage, CylinderData, GaugeData, WavePoint } from './types';
import { RpmDetector } from './rpm_detector';

// MPX4250AP (VOUT = VS × (P × 0.004 − 0.04)) + 12kΩ/20kΩ divider (ratio 5/8)
// + ADS1115 GAIN_ONE (±4.096 V, 16-bit)
// P [kPa] = raw × (LSB / (VS × ratio × 0.004)) + 10  →  raw × 0.01 + 10
export function adcToKpa(raw: number): number {
  return raw * 0.01 + 10;
}

export function kpaToMbar(kpa: number): number {
  return kpa * 10;
}

export function dampingToAlpha(damping: number): number {
  return 1 / (1 + damping);
}

export class SignalProcessor {
  private emaAlpha: number;
  private emaKpa: (number | null)[] = [null, null, null, null];
  private rpmDetector: RpmDetector;

  constructor(damping: number, rpmDamping: number) {
    this.emaAlpha = dampingToAlpha(damping);
    this.rpmDetector = new RpmDetector(rpmDamping);
  }

  setDamping(damping: number): void {
    this.emaAlpha = dampingToAlpha(damping);
  }

  setRpmDamping(rpmDamping: number): void {
    this.rpmDetector.setDamping(rpmDamping);
  }

  reset(): void {
    this.emaKpa = [null, null, null, null];
    this.rpmDetector.reset();
  }

  process(msg: RawWaveMessage, channelMask: number, refChannel: number): GaugeData | null {
    for (let c = 0; c < 4; c++) {
      const ch = msg.chs[c];
      if (!ch || ch.length === 0) continue;
      let sum = 0;
      for (const raw of ch) sum += adcToKpa(raw);
      const batchAvg = sum / ch.length;
      const prev = this.emaKpa[c];
      this.emaKpa[c] = prev === null
        ? batchAvg
        : this.emaAlpha * batchAvg + (1 - this.emaAlpha) * prev;
    }

    const refKpa = this.emaKpa[refChannel] ?? 0;
    const cylinders: CylinderData[] = [];
    let refIdx = 0, idx = 0;

    for (let c = 0; c < 4; c++) {
      if (!(channelMask & (1 << c))) continue;
      if (c === refChannel) refIdx = idx;
      cylinders.push({
        kpa:       this.emaKpa[c] ?? 0,
        delta_kpa: (this.emaKpa[c] ?? 0) - refKpa,
      });
      idx++;
    }

    const refSamples = msg.chs[refChannel];
    const rpm = refSamples && refSamples.length > 0
      ? this.rpmDetector.process(refSamples, msg.t0, msg.dt)
      : 0;

    return cylinders.length ? { rpm: Math.round(rpm), ref: refIdx, cylinders } : null;
  }

  extractWavePoints(msg: RawWaveMessage): (WavePoint[] | null)[] {
    return msg.chs.map((ch) => {
      if (!ch) return null;
      return ch.map((raw, i) => ({ t: msg.t0 + i * msg.dt, v: adcToKpa(raw) }));
    });
  }
}
