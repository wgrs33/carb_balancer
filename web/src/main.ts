import { WsClient } from './ws_client';
import { SignalProcessor } from './signal_processor';
import { CylinderView } from './cylinder_view';
import { WaveRenderer } from './wave_renderer';
import { CsvRecorder, defaultRecordingFilename } from './csv_recorder';
import { SettingsPanel, loadSession, saveSession } from './settings_panel';
import type { GaugeData, ServerMessage, SessionSettings } from './types';

const CARD_REFRESH_MS = 200; // cylinder card refresh rate — faster is unreadable

// ---------------------------------------------------------------------------
// App — wires all modules together
// ---------------------------------------------------------------------------

class App {
  private ws       = new WsClient();
  private signal   = new SignalProcessor(loadSession().damping, loadSession().rpmDamping);
  private view     = new CylinderView();
  private wave     = new WaveRenderer();
  private recorder = new CsvRecorder();
  private panel    = new SettingsPanel();

  private session:      SessionSettings = loadSession();
  private running       = false;
  private plotting      = false;
  private settingsOpen  = false;
  private recording     = false;
  private pending:      GaugeData | null = null;

  constructor() {
    this.applySession(this.session);
    this.wireWs();
    this.wirePanel();
    this.startRaf();
    this.startCardRefresh();
    this.ws.connect();
    window.addEventListener('pagehide', () => this.stopRecording());
  }

  // ---------------------------------------------------------------------------
  // Session
  // ---------------------------------------------------------------------------

  private applySession(s: SessionSettings): void {
    this.session = s;
    const n = countActive(s.channelMask);
    this.view.setCount(n);
    this.wave.setCylCount(n);
    this.wave.buildControls();
    this.signal.setDamping(s.damping);
    this.signal.setRpmDamping(s.rpmDamping);
  }

  // ---------------------------------------------------------------------------
  // WebSocket wiring
  // ---------------------------------------------------------------------------

  private wireWs(): void {
    this.ws.onStateChange = (state) => {
      const dot    = document.getElementById('dot')!;
      const btn    = document.getElementById('btn') as HTMLButtonElement;
      const btnUsb = document.getElementById('btn_usb') as HTMLButtonElement;

      if (state === 'connected') {
        dot.className  = 'ok';
        btn.disabled   = false;
        btnUsb.disabled = false;
        const s = loadSession();
        this.applySession(s);
        this.signal.reset();
        this.ws.sendSession(s);
        this.ws.send({ cmd: 'get_wifi' });
      } else {
        dot.className   = '';
        btn.disabled    = true;
        btnUsb.disabled = true;
        this.stopRecording();
        (document.getElementById('btn_record') as HTMLButtonElement).disabled = true;
        btn.textContent = 'Start';
        btn.className   = 'hbtn';
        this.running  = false;
        this.plotting = false;
        this.wave.reset();
        this.signal.reset();
        this.pending = null;
        document.getElementById('status')!.textContent = '--';
        document.getElementById('status')!.className   = '';
      }
    };

    this.ws.onMessage = (msg: ServerMessage) => {
      if (msg.type === 'wave') {
        const result = this.signal.process(msg, this.session.channelMask, this.session.referenceChannel);
        if (result) this.pending = result;
        if (this.plotting) this.wave.append(msg);
        if (this.recording) this.recorder.append(msg);
      } else if (msg.type === 'wifi') {
        this.panel.populateWifi(msg.ap_ssid, msg.ap_password);
      } else if (msg.type === 'wifi_saved') {
        this.panel.showMsg('Saved', 'ok');
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Settings panel wiring
  // ---------------------------------------------------------------------------

  private wirePanel(): void {
    this.panel.onSaveSession = (s) => {
      saveSession(s);
      if (this.running) {
        this.running = false;
        const btn = document.getElementById('btn') as HTMLButtonElement;
        btn.textContent = 'Start'; btn.className = 'hbtn';
        this.ws.sendCommand('stop');
      }
      if (this.plotting) this.doStopPlot();
      this.signal.reset();
      this.applySession(s);
      this.ws.sendSession(s);
    };

    this.panel.onSaveWifi = (w) => this.ws.sendWifi(w);
  }

  // ---------------------------------------------------------------------------
  // Rendering — wave plot runs every frame, cards refresh on a slower timer
  // (full RAF rate makes the kPa/delta numbers unreadable)
  // ---------------------------------------------------------------------------

  private startRaf(): void {
    const tick = () => {
      this.wave.drawFrame();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  private startCardRefresh(): void {
    setInterval(() => {
      if (this.pending) {
        if (this.running) this.view.update(this.pending);
        this.pending = null;
      }
    }, CARD_REFRESH_MS);
  }

  // ---------------------------------------------------------------------------
  // Actions (called via window globals from HTML onclick)
  // ---------------------------------------------------------------------------

  toggleRun(): void {
    if (!this.ws.connected) return;
    if (this.running && this.plotting) this.doStopPlot();
    this.running = !this.running;
    const btn = document.getElementById('btn') as HTMLButtonElement;
    btn.textContent = this.running ? 'Stop' : 'Start';
    btn.className   = `hbtn${this.running ? ' running' : ''}`;
    this.ws.sendCommand(this.running ? 'start' : 'stop');
    if (!this.running) { this.signal.reset(); this.pending = null; }
  }

  togglePlot(): void {
    if (!this.ws.connected || !this.running) return;
    if (this.plotting) { this.doStopPlot(); return; }
    this.plotting = true;
    this.wave.start();
    const btn = document.getElementById('btn_usb') as HTMLButtonElement;
    btn.textContent = 'Stop Plot'; btn.className = 'hbtn running';
    (document.getElementById('btn_record') as HTMLButtonElement).disabled = false;
  }

  toggleRecord(): void {
    if (!this.running || !this.plotting) return;
    if (this.recording) { this.stopRecording(); return; }
    this.recording = true;
    this.recorder.start(this.session.channelMask);
    const btn = document.getElementById('btn_record') as HTMLButtonElement;
    btn.textContent = 'Stop Recording'; btn.className = 'hbtn running';
  }

  toggleSettings(): void {
    this.settingsOpen = !this.settingsOpen;
    const show = (id: string, visible: boolean, display = '') =>
      (document.getElementById(id) as HTMLElement).style.display = visible ? display : 'none';

    show('settings-panel', this.settingsOpen, 'block');
    show('status',    !this.settingsOpen);
    show('grid',      !this.settingsOpen);
    show('wave-wrap', !this.settingsOpen);

    const btn = document.getElementById('btn_settings') as HTMLButtonElement;
    btn.textContent = this.settingsOpen ? '✕' : '⚙';
    btn.className   = `hbtn${this.settingsOpen ? ' active' : ''}`;

    if (this.settingsOpen) {
      this.stopRecording();
      if (this.running) {
        if (this.plotting) this.doStopPlot();
        this.running = false;
        const btnRun = document.getElementById('btn') as HTMLButtonElement;
        btnRun.textContent = 'Start'; btnRun.className = 'hbtn';
        this.ws.sendCommand('stop');
      }
      this.panel.populate();
      if (this.ws.connected) this.ws.send({ cmd: 'get_wifi' });
    }
  }

  onChannelChange(): void { this.panel.onChannelChange(); }
  saveSettings():    void { this.panel.save(); }

  onWaveZoom(val: string): void {
    this.wave.setViewPts(parseInt(val));
    (document.getElementById('wave-zoom-val') as HTMLElement).textContent = val;
  }

  onWaveSpan(val: string): void {
    this.wave.setWaveSpan(parseInt(val));
    (document.getElementById('wave-span-val') as HTMLElement).textContent = val;
  }

  onWaveScroll(val: string): void {
    const sl = document.getElementById('wave-scroll') as HTMLInputElement;
    this.wave.onScroll(parseInt(val), parseInt(sl.max));
  }

  private doStopPlot(): void {
    this.stopRecording();
    this.plotting = false;
    this.wave.stop();
    const btn = document.getElementById('btn_usb') as HTMLButtonElement;
    btn.textContent = 'Start Plot'; btn.className = 'hbtn';
    const btnRec = document.getElementById('btn_record') as HTMLButtonElement;
    btnRec.disabled = true;
  }

  private stopRecording(): void {
    if (!this.recording) return;
    this.recording = false;
    this.recorder.stop(defaultRecordingFilename());
    const btn = document.getElementById('btn_record') as HTMLButtonElement;
    btn.textContent = 'Record'; btn.className = 'hbtn';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countActive(mask: number): number {
  let n = 0;
  for (let i = 0; i < 4; i++) if (mask & (1 << i)) n++;
  return n;
}

// ---------------------------------------------------------------------------
// Bootstrap + window globals for HTML onclick handlers
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    toggleRun():          void;
    togglePlot():         void;
    toggleRecord():       void;
    toggleSettings():     void;
    onChannelChange():    void;
    saveSettings():       void;
    onWaveZoom(v: string): void;
    onWaveSpan(v: string): void;
    onWaveScroll(v: string): void;
  }
}

const app = new App();
window.toggleRun       = () => app.toggleRun();
window.togglePlot      = () => app.togglePlot();
window.toggleRecord    = () => app.toggleRecord();
window.toggleSettings  = () => app.toggleSettings();
window.onChannelChange = () => app.onChannelChange();
window.saveSettings    = () => app.saveSettings();
window.onWaveZoom      = (v) => app.onWaveZoom(v);
window.onWaveSpan      = (v) => app.onWaveSpan(v);
window.onWaveScroll    = (v) => app.onWaveScroll(v);
