import type { GaugeData } from './types';

export class CylinderView {
  private channels: number[] = [];

  setChannels(mask: number): void {
    this.channels = [];
    for (let c = 0; c < 4; c++) if (mask & (1 << c)) this.channels.push(c);
    this.rebuild();
  }

  update(d: GaugeData): void {
    const grid = document.getElementById('grid')!;
    if (grid.children.length !== d.cylinders.length) this.rebuild();

    document.getElementById('rpm')!.textContent =
      d.rpm > 0 ? `${d.rpm} RPM` : '-- RPM';

    this.updateStatus(d);

    d.cylinders.forEach((c, i) => {
      const card     = grid.children[i] as HTMLElement;
      const isRef    = i === d.ref;
      const absDelta = Math.abs(c.delta_kpa);
      const dText    = isRef
        ? 'ref'
        : `${c.delta_kpa >= 0 ? '+' : ''}${c.delta_kpa.toFixed(2)} kPa`;
      const dCls = isRef ? 'zero' : (absDelta < 0.5 ? 'zero' : c.delta_kpa > 0 ? 'pos' : 'neg');

      card.className = `cyl${isRef ? ' ref' : ''}`;
      (card.querySelector('.cyl-kpa') as HTMLElement).textContent = c.kpa.toFixed(1);
      const dt = card.querySelector('.cyl-delta') as HTMLElement;
      dt.textContent = dText; dt.className = `cyl-delta ${dCls}`;
    });
  }

  private rebuild(): void {
    const grid = document.getElementById('grid')!;
    grid.innerHTML = this.channels.map((ch) =>
      `<div class="cyl"><div class="cyl-label">Cyl ${ch + 1}</div><div class="cyl-kpa">--.-</div><div class="cyl-unit">kPa</div><div class="cyl-delta zero">---</div></div>`
    ).join('');
  }

  private updateStatus(d: GaugeData): void {
    const el = document.getElementById('status')!;
    let maxDelta = 0;
    d.cylinders.forEach((c, i) => {
      if (i !== d.ref) maxDelta = Math.max(maxDelta, Math.abs(c.delta_kpa));
    });
    if (maxDelta < 5)       { el.textContent = 'Synchronized';        el.className = 'sync';   }
    else if (maxDelta < 10) { el.textContent = 'Almost Synchronized'; el.className = 'almost'; }
    else                    { el.textContent = 'Desynchronized';       el.className = 'desync'; }
  }
}
