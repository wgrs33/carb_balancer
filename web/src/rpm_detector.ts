import { dampingToAlpha } from './signal_processor';

const STALL_TIMEOUT_US = 2_000_000;    // no peak for 2s -> engine stopped
const US_PER_REV_PAIR  = 120_000_000;  // 60e6 µs/min * 2 rev/cycle (4-stroke)

/**
 * Detects RPM from a vacuum/pressure waveform by timing trough->rise
 * transitions (one per combustion cycle). Direction is confirmed by 3
 * consecutive samples moving the same way, which rejects single-sample noise.
 * State persists across process() calls, so a transition straddling a batch
 * boundary is still detected correctly.
 */
export class RpmDetector {
  private window: number[] = [];
  private ascending: boolean | null = null;
  private lastPeakUs: number | null = null;
  private emaAlpha: number;
  private rpm: number | null = null;

  constructor(damping: number) {
    this.emaAlpha = dampingToAlpha(damping);
  }

  setDamping(damping: number): void {
    this.emaAlpha = dampingToAlpha(damping);
  }

  reset(): void {
    this.window = [];
    this.ascending = null;
    this.lastPeakUs = null;
    this.rpm = null;
  }

  /** Feed one batch of raw reference-channel samples; returns the current smoothed RPM. */
  process(samples: number[], t0: number, dt: number): number {
    for (let i = 0; i < samples.length; i++) this.feed(samples[i], t0 + i * dt);

    const lastT = t0 + (samples.length - 1) * dt;
    if (this.lastPeakUs !== null && lastT - this.lastPeakUs > STALL_TIMEOUT_US) this.rpm = 0;

    return this.rpm ?? 0;
  }

  private feed(value: number, t: number): void {
    this.window.push(value);
    if (this.window.length > 3) this.window.shift();
    if (this.window.length < 3) return;

    const [a, b, c] = this.window;
    const up   = a < b && b < c;
    const down = a > b && b > c;

    if (this.ascending === false && up) {
      if (this.lastPeakUs !== null) {
        const deltaUs = t - this.lastPeakUs;
        if (deltaUs > 0) {
          const sample = US_PER_REV_PAIR / deltaUs;
          this.rpm = this.rpm === null ? sample : this.emaAlpha * sample + (1 - this.emaAlpha) * this.rpm;
        }
      }
      this.lastPeakUs = t;
    }

    if (up) this.ascending = true;
    else if (down) this.ascending = false;
  }
}
