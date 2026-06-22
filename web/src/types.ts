// ---------------------------------------------------------------------------
// Wire protocol — messages from firmware
// ---------------------------------------------------------------------------

export interface RawWaveMessage {
  type: 'wave';
  /** 4-element array, index = physical channel. null for inactive channels. */
  chs: (number[] | null)[];
  t0: number;   // timestamp of first sample in batch (µs)
  dt: number;   // sample interval (µs)
}

export interface WifiMessage {
  type: 'wifi';
  ap_ssid: string;
  ap_password: string;
}

export interface WifiSavedMessage {
  type: 'wifi_saved';
}

export type ServerMessage = RawWaveMessage | WifiMessage | WifiSavedMessage;

// ---------------------------------------------------------------------------
// Internal data types
// ---------------------------------------------------------------------------

export interface CylinderData {
  kpa: number;
  delta_kpa: number;
}

export interface GaugeData {
  rpm: number;
  ref: number;          // index within the active-cylinders array (not physical channel)
  cylinders: CylinderData[];
}

export interface WavePoint {
  t: number;   // µs timestamp
  v: number;   // kPa
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface SessionSettings {
  channelMask: number;       // bitmask — bits 0-3 = channels 1-4
  referenceChannel: number;  // physical channel index 0-3
  updateIntervalMs: number;
  damping: number;
  rpmDamping: number;
}

export interface WifiSettings {
  apSsid: string;
  apPassword: string;
}
