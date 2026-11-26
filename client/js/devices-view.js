import { channelLabel, formatValue } from './axis-mapping.js';
import { DeviceDialog } from './device-dialog.js';
import { DEVICE_TYPES, buttonState, matchRule, positionIndex, unknownReason } from './devices.js';
import { featuresFor, featureTitle } from './features.js';

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Step switches show their positions as chips up to this many. */
const MAX_CHIPS = 16;

/**
 * The "Virtual devices" tab: the chosen locomotive's virtual devices, each with its buttons'
 * live states and what it sends. Devices are created and edited in a modal dialog.
 */
export class DevicesView {
  #els;
  #dialog;

  #serverOnline = false;
  #mqttConnected = false;
  #catalog = [];
  /** Last 'inputs' message: live topics carry what the train in game really has. */
  #liveInputs = null;
  #settings = null;
  #joysticks = [];
  /** port -> latest JoystickInput */
  #inputs = new Map();
  /** device id -> its position from the server (step switches) */
  #states = new Map();
  /** device id -> { device, pills, value, detail, chips } */
  #cards = new Map();

  /**
   * @param {{ list: HTMLElement, count: HTMLElement, dialog: HTMLDialogElement }} els
   * @param {{ onChange: (change: object) => Promise<{ ok: boolean, error?: string }> }} callbacks
   */
  constructor(els, { onChange }) {
    this.#els = els;
    this.#dialog = new DeviceDialog(els.dialog, { onSave: onChange });
    els.list.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      if (button.dataset.action === 'add') this.#openDialog(null);
      if (button.dataset.action === 'edit') this.#openDialog(button.closest('[data-id]').dataset.id);
    });
  }

  setContext({ serverOnline, mqttConnected }) {
    if (serverOnline === this.#serverOnline && mqttConnected === this.#mqttConnected) return;
    this.#serverOnline = serverOnline;
    this.#mqttConnected = mqttConnected;
    this.#render();
  }

  setCatalog(items) {
    this.#catalog = items;
  }

  setInputs(inputs) {
    this.#liveInputs = inputs;
  }

  setSettings(settings) {
    this.#settings = settings;
    this.#render();
  }

  setJoysticks(joysticks) {
    this.#joysticks = joysticks;
    for (const port of this.#inputs.keys()) {
      if (joysticks.find((j) => j.port === port)?.state !== 'open') this.#inputs.delete(port);
    }
    this.#render();
    this.#dialog.setJoysticks(joysticks);
  }

  setInput(input) {
    this.#inputs.set(input.port, input);
    for (const [id, card] of this.#cards) {
      if (card.device.inputs.some((i) => i.joystick === input.port)) this.#renderLive(id);
    }
    this.#dialog.setInput(input);
  }

  setDeviceState(state) {
    this.#states.set(state.id, state.value);
    if (this.#cards.has(state.id)) this.#renderLive(state.id);
    this.#dialog.setDeviceState(state);
  }

  // ---------- state ----------

  #devices() {
    const locomotive = this.#settings?.locomotive;
    return locomotive ? this.#settings.devices.filter((d) => d.locomotive === locomotive) : [];
  }

  #sendingState() {
    if (!this.#settings) return 'unknown';
    if (this.#settings.paused) return 'paused';
    return this.#mqttConnected ? 'on' : 'offline';
  }

  #joystick(port) {
    return this.#joysticks.find((j) => j.port === port);
  }

  #sourceLabel(input) {
    const joystick = this.#joystick(input.joystick);
    if (!joystick) return `${input.joystick} · channel ${input.channel + 1}`;
    return `${joystick.name} · ${channelLabel(joystick, input.channel)}`;
  }

  #openDialog(id) {
    const locomotive = this.#settings?.locomotive;
    if (!locomotive) return;
    const device = id ? (this.#devices().find((d) => d.id === id) ?? null) : null;
    this.#dialog.open({
      locomotive,
      device,
      features: featuresFor({ catalog: this.#catalog, liveInputs: this.#liveInputs }, locomotive, device?.feature),
      bindings: this.#settings.bindings.filter((b) => b.locomotive === locomotive),
      devices: this.#devices(),
      joysticks: this.#joysticks,
      inputs: this.#inputs,
      state: device ? { id: device.id, value: this.#states.get(device.id) ?? null } : null,
    });
  }

  // ---------- rendering ----------

  #render() {
    const { list, count } = this.#els;
    const devices = this.#devices();
    const locomotive = this.#settings?.locomotive;
    count.textContent = String(devices.length);
    list.dataset.sending = this.#sendingState();
    const focusKey = list.contains(document.activeElement) ? document.activeElement.dataset.focusKey : undefined;
    this.#cards.clear();

    if (!locomotive) {
      list.innerHTML =
        '<div class="empty-state"><p>No locomotive chosen</p>' +
        '<p class="muted">Virtual devices belong to a locomotive, like joystick assignments: choose one above.</p></div>';
      return;
    }
    if (devices.length === 0) {
      list.innerHTML = `
        <div class="empty-state">
          <p>No virtual devices on ${escapeHtml(locomotive)}</p>
          <p class="muted">A virtual device turns joystick buttons into one control: a combination of buttons for a
            three-way switch, Up and Down buttons for a multi-position switch, or a short pulse from a toggle switch.</p>
          <button type="button" class="btn btn-primary devices-add" data-action="add" data-focus-key="add">Add device</button>
        </div>`;
    } else {
      list.innerHTML =
        `<div class="devices-toolbar"><span class="muted">Buttons combined into controls on ${escapeHtml(locomotive)}</span>` +
        '<button type="button" class="btn btn-small btn-ghost" data-action="add" data-focus-key="add">Add device</button></div>' +
        devices.map((d) => this.#cardHtml(d)).join('');
    }

    for (const card of list.querySelectorAll('.device')) {
      const device = devices.find((d) => d.id === card.dataset.id);
      this.#cards.set(device.id, {
        device,
        pills: [...card.querySelectorAll('[data-role="state"]')],
        value: card.querySelector('[data-role="value"]'),
        detail: card.querySelector('[data-role="detail"]'),
        chips: [...card.querySelectorAll('.position')],
      });
      this.#renderLive(device.id);
    }
    if (focusKey) list.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus();
  }

  #cardHtml(device) {
    const type = DEVICE_TYPES[device.type];
    const id = escapeHtml(device.id);
    const sent = {
      on: 'Sent to SimRail when it changes',
      paused: 'Not sent: sending is paused',
      offline: 'Not sent: SimRail is not connected',
    }[this.#sendingState()];
    const inputs = device.inputs
      .map(
        (input, i) => `
          <li class="device-input">
            <span class="device-role">${escapeHtml(type.roles[i])}</span>
            <span class="device-source">${escapeHtml(this.#sourceLabel(input))}</span>
            <span class="pill" data-role="state">—</span>
          </li>`,
      )
      .join('');
    const chips =
      device.type === 'stepper' && device.positions.length <= MAX_CHIPS
        ? `<div class="positions" aria-hidden="true">${device.positions
            .map((p) => `<span class="position">${escapeHtml(formatValue(p))}</span>`)
            .join('')}</div>`
        : '';
    const value = device.type === 'pulse' ? '' : `<span class="output-value" data-role="value" title="${sent ?? ''}"></span>`;
    return `
      <article class="device" data-id="${id}" data-type="${device.type}">
        <header class="device-header">
          <span class="device-name">${escapeHtml(device.name)}</span>
          <span class="device-type">${escapeHtml(type.title)}</span>
          <button type="button" class="btn btn-small btn-ghost" data-action="edit" data-focus-key="device:${id}"
            title="Edit ${escapeHtml(device.name)}">Edit</button>
        </header>
        <div class="device-output">
          <span class="feature-name" title="${escapeHtml(device.feature)}">${escapeHtml(featureTitle(device.feature))}</span>
          ${value}
          <span class="output-detail" data-role="detail"></span>
        </div>
        ${chips}
        <ul class="device-inputs">${inputs}</ul>
      </article>`;
  }

  /** Button states and output of one card. */
  #renderLive(id) {
    const card = this.#cards.get(id);
    if (!card) return;
    const { device } = card;
    const states = device.inputs.map((input) =>
      buttonState(this.#joystick(input.joystick), this.#inputs.get(input.joystick), input.channel),
    );
    card.pills.forEach((pill, i) => {
      const state = states[i];
      const input = device.inputs[i];
      pill.textContent = state === null ? '—' : state ? 'Pressed' : 'Released';
      pill.dataset.on = String(state === true);
      pill.title = state === null ? unknownReason(this.#joystick(input.joystick), input.channel) : '';
    });

    const show = (value, detail, title = '') => {
      if (card.value) card.value.textContent = value;
      card.detail.textContent = detail;
      card.detail.title = title;
    };
    switch (device.type) {
      case 'combo': {
        if (states.some((s) => s === null)) return show('—', 'buttons not read');
        const index = matchRule(device.rules, states);
        const rule = device.rules[index];
        if (!rule) return show('—', 'keeps last value', 'No rule matches: nothing is sent, the game keeps its value');
        if (rule.value === null) return show('—', `rule ${index + 1}: sends nothing`);
        return show(formatValue(rule.value), `rule ${index + 1}`);
      }
      case 'stepper': {
        const value = this.#states.get(id) ?? null;
        const at = value === null ? -1 : positionIndex(device.positions, value);
        card.chips.forEach((chip, i) => chip.classList.toggle('is-active', i === at));
        if (value === null) {
          const why = this.#mqttConnected
            ? 'SimRail reports no value for this input: is this the train in game?'
            : 'Read from SimRail once it is connected';
          return show('—', 'position unknown', why);
        }
        const where = at >= 0 ? `position ${at + 1} of ${device.positions.length}` : 'between positions';
        return show(formatValue(value), `in game · ${where}`);
      }
      case 'pulse': {
        const parts = [];
        if (device.onPress !== null) parts.push(`press → ${formatValue(device.onPress)}`);
        if (device.onRelease !== null) parts.push(`release → ${formatValue(device.onRelease)}`);
        return show('', `${parts.join(', ')}, then ${formatValue(device.rest)} after ${device.durationMs} ms`);
      }
    }
  }
}
