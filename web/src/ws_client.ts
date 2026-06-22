import type { ServerMessage, SessionSettings, WifiSettings } from './types';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected';

export class WsClient {
  onMessage?:     (msg: ServerMessage) => void;
  onStateChange?: (state: ConnectionState) => void;

  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  connect(): void {
    this.clearReconnect();
    this.setState('connecting');
    const ws = new WebSocket(`ws://${location.host}/ws`);

    ws.onopen = () => {
      this.ws = ws;
      this.setState('connected');
    };

    ws.onclose = () => {
      this.ws = null;
      this.setState('disconnected');
      this.reconnectTimer = setTimeout(() => this.connect(), 2000);
    };

    ws.onmessage = (e: MessageEvent) => {
      try {
        this.onMessage?.(JSON.parse(e.data as string) as ServerMessage);
      } catch { /* ignore malformed messages */ }
    };
  }

  send(obj: Record<string, unknown>): void {
    this.ws?.send(JSON.stringify(obj));
  }

  sendCommand(cmd: string): void {
    this.send({ cmd });
  }

  sendSession(s: SessionSettings): void {
    this.send({
      cmd:               'set_session',
      channel_mask:      s.channelMask,
      reference_channel: s.referenceChannel,
      update_interval_ms: s.updateIntervalMs,
    });
  }

  sendWifi(w: WifiSettings): void {
    this.send({ cmd: 'set_wifi', ap_ssid: w.apSsid, ap_password: w.apPassword });
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setState(state: ConnectionState): void {
    this.onStateChange?.(state);
  }
}
