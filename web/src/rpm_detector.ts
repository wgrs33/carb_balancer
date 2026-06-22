import { dampingToAlpha } from './signal_processor';

const STALL_TIMEOUT_US  = 2_000_000;    // no peak for 2s -> engine stopped
const US_PER_REV_PAIR   = 120_000_000;  // 60e6 µs/min * 2 rev/cycle (4-stroke)
const MIN_AMPLITUDE_RAW = 50;           // ~0.5 kPa swing; below this it's ADC noise, not a real pulse

/**
 * Detects RPM from a vacuum/pressure waveform by timing trough->rise
 * transitions (one per combustion cycle). Direction is confirmed by 3
 * consecutive samples moving the same way, which rejects single-sample noise.
 * A candidate transition is only accepted as a real cycle if the swing since
 * the previous one clears MIN_AMPLITUDE_RAW — otherwise it's just ADC noise
 * wobbling on a flat (engine-off) signal, and RPM is reported as 0.
 * State persists across process() calls, so a transition straddling a batch
 * boundary is still detected correctly.
 */
export class RpmDetector {
  private window: number[] = [];
  private ascending: boolean | null = null;
  private lastPeakUs: number | null = null;
  private cycleMin = Infinity;
  private cycleMax = -Infinity;
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
    this.cycleMin = Infinity;
    this.cycleMax = -Infinity;
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
    this.cycleMin = Math.min(this.cycleMin, value);
    this.cycleMax = Math.max(this.cycleMax, value);

    this.window.push(value);
    if (this.window.length > 3) this.window.shift();
    if (this.window.length < 3) return;

    const [a, b, c] = this.window;
    const up   = a < b && b < c;
    const down = a > b && b > c;

    if (this.ascending === false && up) {
      if (this.cycleMax - this.cycleMin >= MIN_AMPLITUDE_RAW) {
        if (this.lastPeakUs !== null) {
          const deltaUs = t - this.lastPeakUs;
          if (deltaUs > 0) {
            const sample = US_PER_REV_PAIR / deltaUs;
            this.rpm = this.rpm === null ? sample : this.emaAlpha * sample + (1 - this.emaAlpha) * this.rpm;
          }
        }
        this.lastPeakUs = t;
      } else {
        this.rpm = 0;          // swing too small to be a real pulse — not running
        this.lastPeakUs = null;
      }
      this.cycleMin = value;
      this.cycleMax = value;
    }

    if (up) this.ascending = true;
    else if (down) this.ascending = false;
  }
}
