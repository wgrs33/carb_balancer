import type { SessionSettings, WifiSettings } from './types';

// ---------------------------------------------------------------------------
// localStorage helpers
// ---------------------------------------------------------------------------

function load<T>(key: string, def: T): T {
  const v = localStorage.getItem(key);
  return v !== null ? (JSON.parse(v) as T) : def;
}

function save<T>(key: string, val: T): void {
  localStorage.setItem(key, JSON.stringify(val));
}

export function loadSession(): SessionSettings {
  return {
    channelMask:      load('channel_mask', 0x0F),
    referenceChannel: load('reference_channel', 0),
    updateIntervalMs: load('update_interval_ms', 50),
    damping:          load('damping', 8),
    rpmDamping:       load('rpm_damping', 8),
  };
}

export function saveSession(s: SessionSettings): void {
  save('channel_mask',       s.channelMask);
  save('reference_channel',  s.referenceChannel);
  save('update_interval_ms', s.updateIntervalMs);
  save('damping',            s.damping);
  save('rpm_damping',        s.rpmDamping);
}

// ---------------------------------------------------------------------------
// SettingsPanel — manages the settings form and its localStorage backing
// ---------------------------------------------------------------------------

export class SettingsPanel {
  onSaveSession?: (s: SessionSettings) => void;
  onSaveWifi?:    (w: WifiSettings) => void;

  private msgTimer: ReturnType<typeof setTimeout> | null = null;

  populate(): void {
    const s = loadSession();
    for (let i = 0; i < 4; i++)
      this.checkbox(`s_ch${i}`).checked = !!(s.channelMask & (1 << i));
    this.rebuildRefSelect(s.channelMask, s.referenceChannel);
    this.el('s_ref_warn').style.display = 'none';
    this.input('s_damp').value     = String(s.damping);
    this.input('s_rdamp').value    = String(s.rpmDamping);
    this.input('s_interval').value = String(s.updateIntervalMs);
  }

  populateWifi(apSsid: string, apPassword: string): void {
    this.input('s_ssid').value = apSsid;
    this.input('s_pw').value   = apPassword;
  }

  onChannelChange(): void {
    const mask   = this.readChannelMask();
    const curRef = parseInt(this.select('s_ref').value, 10);
    this.rebuildRefSelect(mask, curRef);
    const warn = this.el('s_ref_warn');
    if (mask !== 0 && !(mask & (1 << curRef))) {
      this.select('s_ref').value = '';
      warn.style.display = '';
    } else {
      warn.style.display = 'none';
    }
  }

  save(): void {
    const mask  = this.readChannelMask();
    const refCh = parseInt(this.select('s_ref').value, 10);
    if (mask === 0) { this.showMsg('Select at least one channel', 'err'); return; }
    if (isNaN(refCh) || !(mask & (1 << refCh))) {
      this.showMsg('Select a reference channel', 'err');
      this.el('s_ref_warn').style.display = '';
      return;
    }
    this.el('s_ref_warn').style.display = 'none';

    const s: SessionSettings = {
      channelMask:      mask,
      referenceChannel: refCh,
      updateIntervalMs: parseInt(this.input('s_interval').value, 10),
      damping:          parseInt(this.input('s_damp').value, 10),
      rpmDamping:       parseInt(this.input('s_rdamp').value, 10),
    };

    saveSession(s);
    this.onSaveSession?.(s);
    this.onSaveWifi?.({
      apSsid:     this.input('s_ssid').value,
      apPassword: this.input('s_pw').value,
    });
  }

  showMsg(text: string, cls: string): void {
    if (this.msgTimer !== null) clearTimeout(this.msgTimer);
    const el = this.el('s_msg');
    el.textContent = text;
    el.className   = cls;
    this.msgTimer = setTimeout(() => { el.textContent = ''; el.className = ''; }, 3000);
  }

  private readChannelMask(): number {
    let mask = 0;
    for (let i = 0; i < 4; i++)
      if (this.checkbox(`s_ch${i}`).checked) mask |= (1 << i);
    return mask;
  }

  private rebuildRefSelect(mask: number, curRef: number): void {
    const sel = this.select('s_ref');
    sel.innerHTML = '';
    for (let i = 0; i < 4; i++) {
      if (!(mask & (1 << i))) continue;
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = `Ch ${i + 1}`;
      sel.appendChild(opt);
    }
    sel.value = String(curRef);
  }

  private el(id: string): HTMLElement {
    return document.getElementById(id) as HTMLElement;
  }
  private input(id: string): HTMLInputElement {
    return document.getElementById(id) as HTMLInputElement;
  }
  private checkbox(id: string): HTMLInputElement {
    return document.getElementById(id) as HTMLInputElement;
  }
  private select(id: string): HTMLSelectElement {
    return document.getElementById(id) as HTMLSelectElement;
  }
}
