import { ANALOG_MAX, DEFAULT_TOLERANCE, resolveAnalog } from './axis-mapping.js';

const fraction = (raw) => Math.min(Math.max(raw / ANALOG_MAX, 0), 1);
const percent = (f) => `${(f * 100).toFixed(3)}%`;

/**
 * A 0–1023 track for an analog channel: the binding's areas (shaded), its notches (bands as wide
 * as the tolerance) and the lever's position. The notch or area the lever is in is highlighted.
 */
export class AxisMeter {
  #overlays;
  #fill;
  #needle;
  #binding = null;
  #marks = [];
  #raw = null;

  /** @param {HTMLElement} el  emptied and filled with the meter */
  constructor(el) {
    el.classList.add('meter');
    el.innerHTML =
      '<div class="meter-fill"></div><div class="meter-overlays"></div><div class="meter-needle" hidden></div>';
    this.#fill = el.querySelector('.meter-fill');
    this.#overlays = el.querySelector('.meter-overlays');
    this.#needle = el.querySelector('.meter-needle');
  }

  /** @param {object | null} binding  notches/areas/tolerance; entries with missing numbers are skipped */
  setBinding(binding) {
    this.#binding = binding;
    const marks = [];
    const tolerance = binding?.tolerance ?? DEFAULT_TOLERANCE;

    (binding?.areas ?? []).forEach((area, index) => {
      if (![area.from, area.to].every(Number.isFinite)) return;
      const lo = fraction(Math.min(area.from, area.to));
      const hi = fraction(Math.max(area.from, area.to));
      marks.push({ kind: 'area', index, el: this.#mark('meter-area', lo, hi, `Area ${index + 1}`) });
    });
    (binding?.notches ?? []).forEach((notch, index) => {
      if (!Number.isFinite(notch.position)) return;
      const t = Number.isFinite(tolerance) ? tolerance : 0;
      const el = this.#mark('meter-notch', fraction(notch.position - t), fraction(notch.position + t), `Notch ${index + 1}`);
      marks.push({ kind: 'notch', index, el });
    });

    this.#overlays.replaceChildren(...marks.map((m) => m.el));
    this.#marks = marks;
    this.setValue(this.#raw);
  }

  /** @param {number | null} raw  null when there is no live value */
  setValue(raw) {
    this.#raw = raw;
    const live = raw !== null && Number.isFinite(raw);
    this.#needle.hidden = !live;
    this.#fill.style.width = live ? percent(fraction(raw)) : '0%';
    if (live) this.#needle.style.left = percent(fraction(raw));
    const hit = live && this.#binding ? resolveAnalog(this.#binding, raw) : null;
    for (const mark of this.#marks) {
      mark.el.classList.toggle('is-active', hit?.kind === mark.kind && hit.index === mark.index);
    }
  }

  #mark(className, lo, hi, title) {
    const el = document.createElement('div');
    el.className = className;
    el.style.left = percent(lo);
    el.style.width = percent(hi - lo);
    el.title = title;
    return el;
  }
}
