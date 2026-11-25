import { AxisMeter } from './axis-meter.js';
import {
  ANALOG_MAX,
  DEFAULT_PRESSED,
  DEFAULT_RELEASED,
  DEFAULT_TOLERANCE,
  channelLabel,
  formatValue,
  resolveAnalog,
  resolveButton,
} from './axis-mapping.js';

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Empty or non-numeric fields read as NaN and are flagged; saving reports them. */
function readNumber(input) {
  const raw = input.value.trim();
  const value = raw === '' ? NaN : Number(raw);
  input.toggleAttribute('aria-invalid', !Number.isFinite(value));
  return value;
}

const fieldValue = (n) => (Number.isFinite(n) ? String(n) : '');

/**
 * A modal <dialog> holding a form: close buttons ([data-close]), an error line, and a Save that
 * waits for the server and only closes the dialog once the change is accepted.
 */
class ModalForm {
  dialog;
  #busy = false;

  constructor(dialog) {
    this.dialog = dialog;
    dialog.addEventListener('click', (event) => {
      if (event.target.closest('[data-close]')) dialog.close();
    });
    dialog.querySelector('form').addEventListener('submit', (event) => {
      event.preventDefault();
      this.submit();
    });
  }

  /** Element with data-role="…" inside the dialog. */
  $(role) {
    return this.dialog.querySelector(`[data-role="${role}"]`);
  }

  get isOpen() {
    return this.dialog.open;
  }

  show() {
    this.setError('');
    this.dialog.showModal();
  }

  setError(message) {
    const el = this.$('error');
    el.textContent = message;
    el.hidden = !message;
  }

  /** Send a change; close on success, show the server's reason otherwise. */
  async send(request) {
    if (this.#busy) return;
    this.#busy = true;
    this.$('save').disabled = true;
    this.setError('');
    try {
      const result = await request();
      if (result.ok) this.dialog.close();
      else this.setError(result.error ?? 'Could not save.');
    } finally {
      this.#busy = false;
      this.$('save').disabled = false;
    }
  }

  submit() {}
}

/** Port settings: how lines are read (mask, baud rate). */
export class PortDialog extends ModalForm {
  #onSave;
  #joystick = null;
  #settings = null;

  /** @param {{ onSave: (change: object) => Promise<{ ok: boolean, error?: string }> }} callbacks */
  constructor(dialog, { onSave }) {
    super(dialog);
    this.#onSave = onSave;
  }

  /** Port shown while open, else null. */
  get port() {
    return this.isOpen ? this.#joystick.port : null;
  }

  open(joystick, settings, input) {
    this.#joystick = joystick;
    this.#settings = settings;
    this.$('title').textContent = `${joystick.port} settings`;
    this.$('subtitle').textContent = joystick.description ?? '';
    this.$('mask').value = settings.mask;
    this.$('mask').removeAttribute('aria-invalid');
    this.$('baud').value = String(settings.baudRate);
    this.$('baud').removeAttribute('aria-invalid');
    this.show();
    this.setInput(joystick, input);
  }

  /** Latest line of the port (null when it isn't being read). */
  setInput(joystick, input) {
    if (!this.isOpen || joystick.port !== this.#joystick.port) return;
    this.#joystick = joystick;
    const el = this.$('line');
    if (!input) {
      const why = joystick.state === 'open' ? 'Nothing received yet.' : 'Nothing: the port is not being read.';
      el.innerHTML = `<span class="muted">${why}</span>`;
    } else if (input.values) {
      el.innerHTML = `<code>${escapeHtml(input.line)}</code> <span class="ok">matches the saved mask</span>`;
    } else {
      el.innerHTML = `<code>${escapeHtml(input.line)}</code> <span class="warn">does not match the saved mask</span>`;
    }
  }

  submit() {
    const mask = this.$('mask').value.trim();
    const baudRate = readNumber(this.$('baud'));
    this.$('mask').toggleAttribute('aria-invalid', mask === '');
    if (mask === '') return this.setError('Enter a mask, e.g. {a,a}.');
    if (!Number.isInteger(baudRate) || baudRate <= 0) return this.setError('Baud rate must be a whole number, e.g. 9600.');
    void this.send(() => this.#onSave({ kind: 'joystick', joystick: { ...this.#settings, mask, baudRate } }));
  }
}

/**
 * What one channel of a joystick does on the selected locomotive: the feature it drives and,
 * for analog channels, notches and areas; for buttons, the values for pressed and released.
 * Edits are previewed live against the lever's position and only saved with Save.
 */
export class ChannelDialog extends ModalForm {
  #onSave;
  /** { joystick, channel, kind, locomotive, binding, features } */
  #ctx = null;
  /** The binding being edited; numbers are NaN while a field is empty or invalid. */
  #draft = null;
  #meter;
  #input = null;
  #raw = null;

  /** @param {{ onSave: (change: object) => Promise<{ ok: boolean, error?: string }> }} callbacks */
  constructor(dialog, { onSave }) {
    super(dialog);
    this.#onSave = onSave;
    this.#meter = new AxisMeter(this.$('meter'));

    this.$('feature').addEventListener('change', () => {
      this.#draft.feature = this.$('feature').value;
      this.#renderFeature();
    });
    this.$('tolerance').addEventListener('input', () => {
      this.#draft.tolerance = readNumber(this.$('tolerance'));
      this.#renderDraft();
    });
    for (const field of ['pressed', 'released']) {
      this.$(field).addEventListener('input', () => {
        this.#draft[field] = readNumber(this.$(field));
        this.#renderValue();
      });
    }
    for (const list of ['notches', 'areas']) this.#wireTable(list);
    this.$('add-notch').addEventListener('click', () => this.#addNotch());
    this.$('add-area').addEventListener('click', () => this.#addArea());
    this.$('remove').addEventListener('click', () => this.#remove());
  }

  /** Port shown while open, else null. */
  get port() {
    return this.isOpen ? this.#ctx.joystick.port : null;
  }

  /**
   * @param {{ joystick: object, channel: number, locomotive: string, binding: object | null,
   *           features: { topic, title, groupTitle, description, range }[], input: object | null }} ctx
   */
  open({ joystick, channel, locomotive, binding, features, input }) {
    const kind = joystick.channels[channel];
    this.#ctx = { joystick, channel, kind, locomotive, binding, features };
    this.#draft = {
      feature: binding?.feature ?? '',
      tolerance: binding?.tolerance ?? DEFAULT_TOLERANCE,
      notches: (binding?.notches ?? []).map((n) => ({ ...n })),
      areas: (binding?.areas ?? []).map((a) => ({ ...a })),
      pressed: binding?.pressed ?? DEFAULT_PRESSED,
      released: binding?.released ?? DEFAULT_RELEASED,
    };

    this.$('title').textContent = `${joystick.name} · ${channelLabel(joystick, channel)}`;
    this.$('subtitle').textContent = locomotive;
    this.#renderFeatureOptions();
    this.$('tolerance').value = fieldValue(this.#draft.tolerance);
    this.$('pressed').value = fieldValue(this.#draft.pressed);
    this.$('released').value = fieldValue(this.#draft.released);
    for (const el of this.dialog.querySelectorAll('input[aria-invalid]')) el.removeAttribute('aria-invalid');
    this.$('analog').hidden = kind !== 'analog';
    this.$('button').hidden = kind !== 'button';
    this.$('remove').hidden = !binding;

    this.#renderRows();
    this.#renderFeature();
    this.show();
    this.setInput(joystick, input);
  }

  /** Latest line of the joystick (null when it isn't being read). */
  setInput(joystick, input) {
    if (!this.isOpen || joystick.port !== this.#ctx.joystick.port) return;
    this.#ctx.joystick = joystick;
    this.#input = input;
    const value = input?.values?.[this.#ctx.channel];
    this.#raw = Number.isFinite(value) ? value : null;
    this.#renderValue();
  }

  submit() {
    const { binding, error } = this.#collect();
    if (error) return this.setError(error);
    void this.send(() => this.#onSave({ kind: 'binding', binding }));
  }

  // ---------- editing ----------

  #wireTable(list) {
    const body = this.$(list);
    body.addEventListener('input', (event) => {
      const input = event.target.closest('input[data-field]');
      if (!input) return;
      const row = Number(input.closest('tr').dataset.index);
      this.#draft[list][row][input.dataset.field] = readNumber(input);
      this.#renderDraft();
    });
    body.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      const row = Number(button.closest('tr').dataset.index);
      if (button.dataset.action === 'delete') {
        this.#draft[list].splice(row, 1);
        this.#renderRows();
        this.$(list === 'notches' ? 'add-notch' : 'add-area').focus();
      } else if (button.dataset.action === 'capture' && this.#raw !== null) {
        this.#draft[list][row][button.dataset.field] = this.#raw;
        const input = button.parentElement.querySelector('input');
        input.value = String(this.#raw);
        input.removeAttribute('aria-invalid');
        this.#renderDraft();
      }
    });
  }

  #addNotch() {
    const { notches } = this.#draft;
    const range = this.#feature()?.range;
    const last = notches.at(-1);
    let value = last && Number.isFinite(last.value) ? last.value + 1 : range?.documented ? range.min : 0;
    if (range?.documented) value = Math.min(value, range.max);
    notches.push({ position: this.#raw ?? Math.round(ANALOG_MAX / 2), value });
    this.#renderRows();
    this.$('notches').querySelector('tr:last-child input[data-field="value"]')?.focus();
  }

  #addArea() {
    const { areas } = this.#draft;
    const range = this.#feature()?.range;
    const ends = areas.map((a) => Math.max(a.from, a.to)).filter(Number.isFinite);
    const lastEnd = ends.length ? Math.max(...ends) : -1;
    areas.push({
      from: lastEnd >= 0 && lastEnd < ANALOG_MAX - 1 ? lastEnd + 1 : 0,
      to: ANALOG_MAX,
      valueFrom: range?.documented ? range.min : 0,
      valueTo: range?.documented ? range.max : 1,
    });
    this.#renderRows();
    this.$('areas').querySelector('tr:last-child input[data-field="from"]')?.focus();
  }

  async #remove() {
    const { joystick, channel, locomotive } = this.#ctx;
    const label = channelLabel(joystick, channel);
    if (!window.confirm(`Remove what ${label} of ${joystick.name} does on ${locomotive}?`)) return;
    await this.send(() => this.#onSave({ kind: 'remove-binding', locomotive, joystick: joystick.port, channel }));
  }

  /** The binding to save, or the first problem with the form. */
  #collect() {
    const { joystick, channel, kind, locomotive } = this.#ctx;
    const d = this.#draft;
    if (!d.feature) return { error: 'Choose the feature this channel drives.' };
    const base = { locomotive, joystick: joystick.port, channel, feature: d.feature };

    if (kind === 'button') {
      if (!Number.isFinite(d.pressed) || !Number.isFinite(d.released)) {
        return { error: 'Enter numbers for pressed and released.' };
      }
      return { binding: { ...base, pressed: d.pressed, released: d.released } };
    }

    if (!Number.isFinite(d.tolerance) || d.tolerance < 0) return { error: 'Tolerance must be 0 or more.' };
    for (const [i, n] of d.notches.entries()) {
      if (![n.position, n.value].every(Number.isFinite)) return { error: `Notch ${i + 1}: enter a position and a value.` };
    }
    for (const [i, a] of d.areas.entries()) {
      if (![a.from, a.to, a.valueFrom, a.valueTo].every(Number.isFinite)) {
        return { error: `Area ${i + 1}: fill in all four numbers.` };
      }
      if (a.from === a.to) return { error: `Area ${i + 1}: "from" and "to" must differ.` };
    }
    return { binding: { ...base, tolerance: d.tolerance, notches: d.notches, areas: d.areas } };
  }

  // ---------- rendering ----------

  #feature() {
    return this.#ctx.features.find((f) => f.topic === this.#draft.feature) ?? null;
  }

  #renderFeatureOptions() {
    const groups = new Map();
    for (const f of this.#ctx.features) {
      if (!groups.has(f.groupTitle)) groups.set(f.groupTitle, []);
      groups.get(f.groupTitle).push(f);
    }
    const select = this.$('feature');
    select.innerHTML =
      '<option value="">Choose a feature…</option>' +
      [...groups]
        .map(
          ([group, features]) =>
            `<optgroup label="${escapeHtml(group)}">` +
            features.map((f) => `<option value="${escapeHtml(f.topic)}">${escapeHtml(f.title)}</option>`).join('') +
            '</optgroup>',
        )
        .join('');
    select.value = this.#draft.feature;
  }

  #renderFeature() {
    const feature = this.#feature();
    const hint = this.$('feature-hint');
    if (!feature) {
      hint.textContent = 'The SimRail input this channel drives on this locomotive.';
    } else {
      const { range } = feature;
      const values = range.documented ? `values from ${range.min} to ${range.max}` : 'range not documented';
      hint.textContent = `${feature.topic} · ${values}`;
    }
    this.$('description-box').hidden = !feature?.description;
    this.$('description').textContent = feature?.description ?? '';
  }

  #renderRows() {
    const { notches, areas } = this.#draft;
    const capture = (field, what) =>
      `<button type="button" class="btn btn-small btn-ghost" data-action="capture" data-field="${field}"` +
      ` title="Set ${what} to the lever's current position">Capture</button>`;
    const remove = (what) =>
      `<button type="button" class="icon-btn" data-action="delete" aria-label="Remove ${what}" title="Remove ${what}">✕</button>`;
    const number = (field, value, label, step = 'any') =>
      `<input type="number" step="${step}" data-field="${field}" value="${fieldValue(value)}" aria-label="${label}" />`;

    this.$('notches').innerHTML = notches
      .map((n, i) => {
        const name = `notch ${i + 1}`;
        return (
          `<tr data-index="${i}"><td class="num">${i + 1}</td>` +
          `<td><div class="capture">${number('position', n.position, `${name} position`, 1)}${capture('position', 'the position')}</div></td>` +
          `<td>${number('value', n.value, `${name} value`)}</td>` +
          `<td>${remove(name)}</td></tr>`
        );
      })
      .join('');
    this.$('areas').innerHTML = areas
      .map((a, i) => {
        const name = `area ${i + 1}`;
        return (
          `<tr data-index="${i}"><td class="num">${i + 1}</td>` +
          `<td><div class="capture">${number('from', a.from, `${name} from`, 1)}${capture('from', '"from"')}</div></td>` +
          `<td><div class="capture">${number('to', a.to, `${name} to`, 1)}${capture('to', '"to"')}</div></td>` +
          `<td>${number('valueFrom', a.valueFrom, `${name} value from`)}</td>` +
          `<td>${number('valueTo', a.valueTo, `${name} value to`)}</td>` +
          `<td>${remove(name)}</td></tr>`
        );
      })
      .join('');
    this.$('notches-table').hidden = notches.length === 0;
    this.$('notches-empty').hidden = notches.length > 0;
    this.$('areas-table').hidden = areas.length === 0;
    this.$('areas-empty').hidden = areas.length > 0;
    this.#renderDraft();
  }

  /** The draft's notches/areas changed. */
  #renderDraft() {
    this.#meter.setBinding(this.#draft);
    this.#renderValue();
  }

  /** The live value (or how it maps) changed. */
  #renderValue() {
    const { kind, joystick } = this.#ctx;
    const raw = this.#raw;
    this.#meter.setValue(kind === 'analog' ? raw : null);
    for (const button of this.dialog.querySelectorAll('[data-action="capture"]')) button.disabled = raw === null;

    const hit = kind === 'analog' && raw !== null ? resolveAnalog(this.#draft, raw) : null;
    for (const list of ['notches', 'areas']) {
      const active = hit?.kind === (list === 'notches' ? 'notch' : 'area') ? hit.index : -1;
      for (const row of this.$(list).rows) row.classList.toggle('is-active', Number(row.dataset.index) === active);
    }

    const readout = this.$('readout');
    readout.dataset.kind = 'note';
    if (!this.#input) {
      readout.textContent =
        joystick.state === 'open' ? `Waiting for data from ${joystick.name}…` : `No live value: ${joystick.name} is not being read.`;
    } else if (raw === null) {
      readout.textContent = `The last line from ${joystick.name} doesn't match its mask.`;
    } else if (kind === 'button') {
      readout.dataset.kind = 'value';
      readout.textContent = `${raw ? 'Pressed' : 'Released'} → ${formatValue(resolveButton(this.#draft, raw).value)}`;
    } else if (!hit) {
      readout.textContent = `Raw ${raw}: not in a notch or area`;
    } else {
      readout.dataset.kind = 'value';
      readout.textContent = `Raw ${raw} → ${hit.kind} ${hit.index + 1} → ${formatValue(hit.value)}`;
    }
  }
}
