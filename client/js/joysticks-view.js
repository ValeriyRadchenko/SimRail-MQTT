import { AxisMeter } from './axis-meter.js';
import { channelLabel, formatValue, resolveAnalog, resolveButton } from './axis-mapping.js';
import { featuresFor, featureTitle } from './features.js';
import { ChannelDialog, PortDialog } from './joystick-dialogs.js';

/** Game controllers' ids start with this; mirrors CONTROLLER_PREFIX in server/src/settings/schema.ts. */
const CONTROLLER_PREFIX = 'sdl:';
/**
 * Settings of a joystick the user hasn't touched; mirrors defaultSerialJoystick() and
 * defaultController() in server/src/settings/schema.ts.
 */
const defaultJoystick = (port) =>
  port.startsWith(CONTROLLER_PREFIX) ? { port, enabled: false } : { port, enabled: false, baudRate: 9600, mask: '{a,a}' };
/** A serial port that is read but silent for this long is flagged (controllers only report changes). */
const STALE_MS = 2000;

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * The "Joysticks" column: serial ports and game controllers, whether they are read, their live
 * values per channel, and what each channel drives on the selected locomotive. Settings open in
 * modal dialogs.
 */
export class JoysticksView {
  #els;
  #onChange;
  #portDialog;
  #channelDialog;

  #serverOnline = false;
  #mqttConnected = false;
  /** Vehicle recognised in game, or null. */
  #vehicle = null;
  /** Last failed change, shown until the next one succeeds. */
  #error = null;
  #catalog = [];
  #locomotives = [];
  /** Last 'inputs' message: live topics carry what the train in game really has. */
  #liveInputs = null;
  #settings = null;
  #joysticks = [];
  /** port -> latest JoystickInput */
  #inputs = new Map();
  /** port -> { status, channels: [{ kind, meter?, raw, value, detail, state? }] } */
  #cards = new Map();
  #autoPicked = false;
  #lastLocomotiveOptions = '';

  /**
   * @param {{ list: HTMLElement, count: HTMLElement, locomotive: HTMLSelectElement, notice: HTMLElement,
   *           sendingStatus: HTMLElement, sendingToggle: HTMLButtonElement,
   *           portDialog: HTMLDialogElement, channelDialog: HTMLDialogElement }} els
   * @param {{ onChange: (change: object) => Promise<{ ok: boolean, error?: string }> }} callbacks
   */
  constructor(els, { onChange }) {
    this.#els = els;
    this.#onChange = onChange;
    this.#portDialog = new PortDialog(els.portDialog, { onSave: onChange });
    this.#channelDialog = new ChannelDialog(els.channelDialog, { onSave: onChange });

    els.locomotive.addEventListener('change', () => {
      void this.#change({ kind: 'locomotive', locomotive: els.locomotive.value || null });
    });
    els.sendingToggle.addEventListener('click', () => {
      if (this.#settings) void this.#change({ kind: 'paused', paused: !this.#settings.paused });
    });
    els.list.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      const port = button.closest('[data-port]').dataset.port;
      if (button.dataset.action === 'port-settings') this.#openPortDialog(port);
      if (button.dataset.action === 'channel') this.#openChannelDialog(port, Number(button.dataset.channel));
    });
    els.list.addEventListener('change', (event) => {
      const toggle = event.target.closest('input[data-action="enable"]');
      if (!toggle) return;
      const port = toggle.closest('[data-port]').dataset.port;
      void this.#change({ kind: 'joystick', joystick: { ...this.#settingsFor(port), enabled: toggle.checked } }).then(
        (ok) => ok || (toggle.checked = !toggle.checked),
      );
    });
    // Notice a joystick going quiet even when no message arrives.
    setInterval(() => {
      for (const port of this.#cards.keys()) this.#renderLive(port);
    }, 1000);
  }

  setContext({ serverOnline, mqttConnected, vehicle }) {
    const changed =
      serverOnline !== this.#serverOnline || mqttConnected !== this.#mqttConnected || vehicle !== this.#vehicle;
    this.#serverOnline = serverOnline;
    this.#mqttConnected = mqttConnected;
    this.#vehicle = vehicle;
    if (!changed) return;
    this.#autoPickLocomotive();
    this.#render();
  }

  /** The wiki catalogue: which inputs each locomotive has. */
  setCatalog(items) {
    this.#catalog = items;
    this.#locomotives = [...new Set(items.flatMap((i) => i.vehicles ?? []))]
      .filter((v) => !v.startsWith('Common'))
      .sort((a, b) => a.localeCompare(b));
    this.#render();
  }

  /** The current input list (live from the game, or the catalogue). */
  setInputs(inputs) {
    this.#liveInputs = inputs;
  }

  setSettings(settings) {
    this.#settings = settings;
    this.#autoPickLocomotive();
    this.#render();
  }

  setJoysticks(joysticks) {
    this.#joysticks = joysticks;
    for (const port of this.#inputs.keys()) {
      if (joysticks.find((j) => j.port === port)?.state !== 'open') this.#inputs.delete(port);
    }
    this.#render();
    for (const j of joysticks) this.#forwardToDialogs(j);
  }

  setInput(input) {
    this.#inputs.set(input.port, input);
    this.#renderLive(input.port);
    const joystick = this.#joysticks.find((j) => j.port === input.port);
    if (joystick) this.#forwardToDialogs(joystick);
  }

  // ---------- state ----------

  #settingsFor(port) {
    return this.#settings?.joysticks.find((j) => j.port === port) ?? defaultJoystick(port);
  }

  #bindingFor(port, channel) {
    const locomotive = this.#settings?.locomotive;
    if (!locomotive) return null;
    return (
      this.#settings.bindings.find((b) => b.locomotive === locomotive && b.joystick === port && b.channel === channel) ??
      null
    );
  }

  /** Virtual devices of the selected locomotive that read this channel. */
  #devicesUsing(port, channel) {
    const locomotive = this.#settings?.locomotive;
    if (!locomotive) return [];
    return this.#settings.devices.filter(
      (d) => d.locomotive === locomotive && d.inputs.some((i) => i.joystick === port && i.channel === channel),
    );
  }

  #inputFor(joystick) {
    return joystick.state === 'open' ? (this.#inputs.get(joystick.port) ?? null) : null;
  }

  /** First time a train is recognised and nothing is chosen yet: choose it. */
  #autoPickLocomotive() {
    if (this.#autoPicked || !this.#settings || this.#settings.locomotive || !this.#vehicle) return;
    if (!this.#locomotives.includes(this.#vehicle)) return;
    this.#autoPicked = true;
    void this.#change({ kind: 'locomotive', locomotive: this.#vehicle });
  }

  async #change(change) {
    const result = await this.#onChange(change);
    this.#error = result.ok ? null : (result.error ?? 'Could not save the change.');
    this.#renderNotice();
    return result.ok;
  }

  /**
   * on: values go to the game; paused: by the user; offline: SimRail isn't connected;
   * unknown: settings not received yet.
   */
  #sendingState() {
    if (!this.#settings) return 'unknown';
    if (this.#settings.paused) return 'paused';
    return this.#mqttConnected ? 'on' : 'offline';
  }

  #featuresFor(locomotive, currentTopic) {
    return featuresFor({ catalog: this.#catalog, liveInputs: this.#liveInputs }, locomotive, currentTopic);
  }

  // ---------- dialogs ----------

  #openPortDialog(port) {
    const joystick = this.#joysticks.find((j) => j.port === port);
    if (joystick) this.#portDialog.open(joystick, this.#settingsFor(port), this.#inputFor(joystick));
  }

  #openChannelDialog(port, channel) {
    const joystick = this.#joysticks.find((j) => j.port === port);
    const locomotive = this.#settings?.locomotive;
    if (!joystick || !locomotive) return;
    const binding = this.#bindingFor(port, channel);
    this.#channelDialog.open({
      joystick,
      channel,
      locomotive,
      binding,
      features: this.#featuresFor(locomotive, binding?.feature),
      input: this.#inputFor(joystick),
    });
  }

  #forwardToDialogs(joystick) {
    const input = this.#inputFor(joystick);
    if (this.#portDialog.port === joystick.port) this.#portDialog.setInput(joystick, input);
    if (this.#channelDialog.port === joystick.port) this.#channelDialog.setInput(joystick, input);
  }

  // ---------- rendering ----------

  #render() {
    this.#renderLocomotives();
    this.#renderNotice();
    this.#renderSending();

    const { list, count } = this.#els;
    count.textContent = String(this.#joysticks.length);
    // The list is rebuilt; put the keyboard focus back where it was.
    const focusKey = list.contains(document.activeElement) ? document.activeElement.dataset.focusKey : undefined;

    this.#cards.clear();
    if (this.#joysticks.length === 0) {
      list.innerHTML =
        '<div class="empty-state"><p>No joysticks found</p>' +
        '<p class="muted">Plug in a game controller or a serial (COM port) joystick; it shows up here within 2 seconds.</p></div>';
      return;
    }
    list.innerHTML = this.#joysticks.map((j) => this.#cardHtml(j)).join('');

    for (const card of list.querySelectorAll('.joystick')) {
      const { port } = card.dataset;
      const channels = [...card.querySelectorAll('.channel')].map((row) => {
        const channel = Number(row.dataset.channel);
        const meterEl = row.querySelector('[data-role="meter"]');
        const meter = meterEl ? new AxisMeter(meterEl) : null;
        meter?.setBinding(this.#bindingFor(port, channel));
        return {
          kind: row.dataset.kind,
          meter,
          state: row.querySelector('[data-role="state"]'),
          raw: row.querySelector('[data-role="raw"]'),
          value: row.querySelector('[data-role="value"]'),
          detail: row.querySelector('[data-role="detail"]'),
        };
      });
      this.#cards.set(port, { status: card.querySelector('[data-role="status"]'), channels });
      this.#renderLive(port);
    }

    if (focusKey) list.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus();
  }

  #renderLocomotives() {
    const select = this.#els.locomotive;
    const current = this.#settings?.locomotive ?? '';
    const names = [...this.#locomotives];
    if (current && !names.includes(current)) names.push(current);
    const options =
      `<option value="">Choose a locomotive…</option>` +
      names
        .map((name) => {
          const inGame = name === this.#vehicle ? ' (in game)' : '';
          return `<option value="${escapeHtml(name)}">${escapeHtml(name + inGame)}</option>`;
        })
        .join('');
    // Rebuilding the options closes the dropdown, so only do it when they change.
    if (options !== this.#lastLocomotiveOptions) {
      select.innerHTML = options;
      this.#lastLocomotiveOptions = options;
    }
    select.value = current;
    select.disabled = !this.#settings;
  }

  #renderNotice() {
    const notice = this.#els.notice;
    const locomotive = this.#settings?.locomotive;
    const hasChannels = this.#joysticks.some((j) => j.state !== 'off' && j.channels.length > 0);
    let kind = 'hint';
    let text = '';
    if (this.#error) {
      kind = 'error';
      text = this.#error;
    } else if (locomotive && this.#vehicle && this.#vehicle !== locomotive) {
      kind = 'warn';
      text = `SimRail reports ${this.#vehicle}, but ${locomotive} is chosen: its assignments are what gets sent.`;
    } else if (this.#settings && !locomotive && hasChannels) {
      text = 'Choose a locomotive to assign joystick channels to its features.';
    }
    notice.dataset.kind = kind;
    notice.textContent = text;
  }

  #renderSending() {
    const { sendingStatus: status, sendingToggle: toggle, list } = this.#els;
    const state = this.#sendingState();
    const paused = this.#settings?.paused ?? false;
    status.dataset.state = state;
    status.textContent = { on: 'Sending to SimRail', paused: 'Sending paused', offline: 'SimRail not connected', unknown: '' }[
      state
    ];
    status.title =
      state === 'offline' ? 'Values are sent once SimRail is connected (a session with MQTT enabled).' : '';
    toggle.textContent = paused ? 'Resume sending' : 'Pause sending';
    toggle.setAttribute('aria-pressed', String(paused));
    toggle.title = paused
      ? 'Send joystick values to the game again; the levers’ current positions are sent first'
      : 'Stop sending joystick values to the game; they are still read and shown here';
    toggle.disabled = !this.#settings || !this.#serverOnline;
    // Shown values are muted when they don't reach the game.
    list.dataset.sending = state;
  }

  #cardHtml(joystick) {
    const { port, name, description, state, channels, layout } = joystick;
    const serial = joystick.kind === 'serial';
    const settings = this.#settingsFor(port);
    const locomotive = this.#settings?.locomotive;
    const p = escapeHtml(port);
    const n = escapeHtml(name);

    const rows =
      state === 'off'
        ? ''
        : `<ul class="channels">${channels.map((kind, i) => this.#channelHtml(joystick, kind, i, locomotive)).join('')}</ul>`;
    // Serial: how lines are read. Controllers: what they have (known once read).
    let config = '';
    if (serial) config = `${settings.baudRate} baud · <code>${escapeHtml(settings.mask)}</code>`;
    else if (layout) {
      const { axes, buttons, hats } = layout;
      config = [plural(axes, 'axis', 'axes'), plural(buttons, 'button'), hats ? plural(hats, 'hat') : ''].filter(Boolean).join(' · ');
    }
    // Only serial ports have settings (mask, baud rate).
    const settingsButton = serial
      ? `<button type="button" class="btn btn-small btn-ghost" data-action="port-settings"
            data-focus-key="port:${p}" title="Mask and baud rate">Settings</button>`
      : '';

    return `
      <article class="joystick" data-port="${p}" data-kind="${joystick.kind}" data-state="${state}">
        <header class="joystick-header">
          <span class="dot" data-state="${state}" aria-hidden="true"></span>
          <div class="joystick-name">
            <span class="joystick-port" ${serial ? '' : `title="${p}"`}>${n}</span>
            <span class="joystick-description">${escapeHtml(description ?? '')}</span>
          </div>
          <label class="switch" title="Read joystick values from ${n}">
            <input type="checkbox" role="switch" data-action="enable" data-focus-key="enable:${p}"
              ${settings.enabled ? 'checked' : ''} ${this.#serverOnline ? '' : 'disabled'} />
            <span>Read</span>
          </label>
          ${settingsButton}
        </header>
        <div class="joystick-status">
          <span class="status-line" data-role="status"></span>
          <span class="status-config">${config}</span>
        </div>
        ${rows}
      </article>`;
  }

  #channelHtml(joystick, kind, channel, locomotive) {
    const label = channelLabel(joystick, channel);
    const binding = this.#bindingFor(joystick.port, channel);
    const indicator =
      kind === 'analog'
        ? '<div class="channel-meter" data-role="meter"></div>'
        : '<span class="pill" data-role="state">—</span>';
    const sent = {
      on: 'Sent to SimRail when it changes',
      paused: 'Not sent: sending is paused',
      offline: 'Not sent: SimRail is not connected',
    }[this.#sendingState()];
    const devices = this.#devicesUsing(joystick.port, channel);
    let unassigned = locomotive ? 'Not assigned' : 'No locomotive chosen';
    if (devices.length) unassigned = `In ${devices.map((d) => `“${d.name}”`).join(', ')}`;
    const output = binding
      ? `<span class="feature-name" title="${escapeHtml(binding.feature)}">${escapeHtml(featureTitle(binding.feature))}</span>` +
        `<span class="output-value" data-role="value" title="${sent ?? ''}"></span>` +
        `<span class="output-detail" data-role="detail"></span>`
      : `<span class="muted" ${devices.length ? 'title="Used by a virtual device (Virtual devices tab)"' : ''}>${escapeHtml(unassigned)}</span>`;
    return `
      <li class="channel" data-channel="${channel}" data-kind="${kind}">
        <span class="channel-name">${label}</span>
        ${indicator}
        <span class="channel-raw" data-role="raw">—</span>
        <span class="channel-output">${output}</span>
        <button type="button" class="btn btn-small btn-ghost" data-action="channel" data-channel="${channel}"
          data-focus-key="channel:${escapeHtml(joystick.port)}:${channel}" ${locomotive ? '' : 'disabled'}
          title="${locomotive ? `What ${label} does on ${escapeHtml(locomotive)}` : 'Choose a locomotive first'}">
          ${binding ? 'Edit' : 'Assign'}</button>
      </li>`;
  }

  /** Status line and channel values of one card, from the latest input. */
  #renderLive(port) {
    const card = this.#cards.get(port);
    const joystick = this.#joysticks.find((j) => j.port === port);
    if (!card || !joystick) return;
    const input = this.#inputFor(joystick);
    const stale = joystick.kind === 'serial' && input && Date.now() - input.receivedAt > STALE_MS;

    card.status.innerHTML = this.#statusHtml(joystick, input, stale);

    card.channels.forEach((ch, channel) => {
      const raw = !stale && Number.isFinite(input?.values?.[channel]) ? input.values[channel] : null;
      ch.raw.textContent = raw === null ? '—' : String(raw);
      if (ch.meter) ch.meter.setValue(raw);
      if (ch.state) {
        ch.state.textContent = raw === null ? '—' : raw ? 'Pressed' : 'Released';
        ch.state.dataset.on = String(raw === 1);
      }
      if (!ch.value) return;
      const binding = this.#bindingFor(port, channel);
      const hit = raw === null ? null : ch.kind === 'button' ? resolveButton(binding, raw) : resolveAnalog(binding, raw);
      ch.value.textContent = hit ? formatValue(hit.value) : '—';
      if (hit) ch.detail.textContent = hit.kind === 'button' ? '' : `${hit.kind} ${hit.index + 1}`;
      else ch.detail.textContent = raw === null ? '' : 'keeps last value';
      ch.detail.title = !hit && raw !== null ? 'Not in a notch or area: nothing is sent, the game keeps the last value' : '';
    });
  }

  #statusHtml(joystick, input, stale) {
    const serial = joystick.kind === 'serial';
    switch (joystick.state) {
      case 'off':
        return serial
          ? '<span class="muted">Not read. Turn on Read if this is a joystick.</span>'
          : '<span class="muted">Not read. Turn on Read to use it.</span>';
      case 'absent':
        return '<span class="warn">Not connected</span>';
      case 'opening':
        return '<span class="muted">Opening…</span>';
      case 'error':
        return `<span class="danger">${escapeHtml(joystick.error ?? 'Error')}</span> <span class="muted">· retrying</span>`;
      case 'open':
        if (!input) return '<span class="muted">Waiting for data…</span>';
        if (!serial) {
          // No line to show: list what is pressed, which helps tell the buttons apart.
          const pressed = (input.values ?? [])
            .map((value, i) => (joystick.channels[i] === 'button' && value === 1 ? channelLabel(joystick, i) : null))
            .filter(Boolean);
          const status = '<span class="ok">Connected</span>';
          return pressed.length ? `${status} · ${escapeHtml(pressed.join(', '))} pressed` : status;
        }
        if (stale) {
          const seconds = Math.round((Date.now() - input.receivedAt) / 1000);
          return `<span class="warn">No data for ${seconds} s</span>`;
        }
        if (!input.values) {
          return `<code>${escapeHtml(input.line)}</code> <span class="warn">doesn't match the mask</span>`;
        }
        return `<code>${escapeHtml(input.line)}</code>`;
      default:
        return '';
    }
  }
}
