import { groupLabel, humanize } from './humanize.js';
import { DEFAULT_RANGE, describeValue, inferRange, roundToStep } from './value-range.js';

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
/** Minimum gap between values sent while dragging (20 per second). */
const LIVE_INTERVAL_MS = 50;
const LIVE_PREF_KEY = 'simrail.slider.live';

function readPref(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === 'true';
  } catch {
    return fallback;
  }
}

function writePref(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* storage unavailable: preference just isn't remembered */
  }
}

const tokens = (s) => String(s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * Pick the description variant for the train in use: the vehicle the server recognised from the
 * live topics, else a match on the trainset name (e.g. "EU07-005" -> "4E (EU07/EP07)").
 */
function matchVariant(variants, trainset, vehicle) {
  if (vehicle) {
    const exact = variants.findIndex((v) => v.vehicles.includes(vehicle));
    if (exact >= 0) return exact;
  }
  const wanted = new Set([...tokens(trainset?.vehicleDesignation), ...tokens(trainset?.name)].filter((t) => /[a-z]/.test(t)));
  if (wanted.size === 0) return 0;
  const index = variants.findIndex((v) => v.vehicles.some((name) => tokens(name).some((t) => wanted.has(t))));
  return Math.max(index, 0);
}

/**
 * Testing panel: pick a value with the slider (or type it) and send it to the selected topic.
 * The slider follows the value reported by the game unless the user is changing it.
 */
export class TestingPanel {
  #els;
  #onApply;
  #onWatch;
  #context = { serverOnline: false, mqttConnected: false, mqttError: null, trainset: null, vehicle: null };

  #item = null;
  #variantIndex = 0;
  #variantChosenByUser = false;
  #range = DEFAULT_RANGE;

  #busy = false;
  /** The value shown was changed by the user and not sent yet: don't overwrite it with game values. */
  #dirty = false;
  #dragging = false;
  /** { topic, value, receivedAt } — last value the game reported for the current topic. */
  #game = null;

  #livePending = null;
  #liveTimer = null;
  #lastLiveAt = 0;
  #sendSeq = 0;

  /**
   * @param {Document} doc
   * @param {{
   *   onApply: (topic: string, value: number) => Promise<{ ok: boolean, error?: string }>,
   *   onWatch: (topic: string | null) => void,
   * }} callbacks
   */
  constructor(doc, { onApply, onWatch }) {
    const $ = (id) => doc.getElementById(id);
    this.#els = {
      form: $('testing-form'),
      element: $('testing-element'),
      group: $('testing-group'),
      topic: $('testing-topic'),
      value: $('testing-value'),
      apply: $('testing-apply'),
      slider: $('testing-slider'),
      ticks: $('slider-ticks'),
      min: $('slider-min'),
      max: $('slider-max'),
      step: $('slider-step'),
      live: $('slider-live'),
      meaning: $('slider-meaning'),
      game: $('game-value'),
      hint: $('testing-hint'),
      details: $('testing-details'),
      variantField: $('variant-field'),
      variant: $('testing-variant'),
      description: $('testing-description'),
      meta: $('testing-meta'),
      result: $('testing-result'),
    };
    this.#onApply = onApply;
    this.#onWatch = onWatch;
    const els = this.#els;

    els.live.checked = readPref(LIVE_PREF_KEY, true);
    els.live.addEventListener('change', () => {
      writePref(LIVE_PREF_KEY, els.live.checked);
      this.#refresh();
    });

    els.form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.#apply();
    });

    els.topic.addEventListener('input', () => this.#refresh());
    // Follow whatever topic is in the box once the user is done editing it.
    els.topic.addEventListener('change', () => this.#watchTopic());

    els.value.addEventListener('input', () => {
      this.#dirty = true;
      const value = this.#readValue();
      if (value !== null) els.slider.value = String(value);
      this.#renderMeaning();
      this.#refresh();
    });

    els.slider.addEventListener('pointerdown', () => (this.#dragging = true));
    const endDrag = () => {
      if (!this.#dragging) return;
      this.#dragging = false;
      this.#flushLive();
    };
    doc.defaultView.addEventListener('pointerup', endDrag);
    doc.defaultView.addEventListener('pointercancel', endDrag);

    els.slider.addEventListener('input', () => {
      const value = roundToStep(Number(els.slider.value), this.#range.step);
      els.value.value = String(value);
      this.#renderMeaning();
      if (els.live.checked && !this.#blocker()) {
        this.#dirty = false;
        this.#queueLive(value);
      } else {
        this.#dirty = true;
      }
      this.#refresh();
    });
    // Keyboard changes and the end of a drag: make sure the final position is sent.
    els.slider.addEventListener('change', () => this.#flushLive());

    for (const field of [els.min, els.max, els.step]) {
      field.addEventListener('input', () => this.#readRangeFields());
    }

    els.variant.addEventListener('change', () => {
      this.#variantChosenByUser = true;
      this.#variantIndex = Number(els.variant.value);
      this.#renderVariant();
    });

    this.#applyRange(DEFAULT_RANGE);
    this.#renderGame();
    this.#refresh();
  }

  /**
   * Called when an input element is picked in the list. `focus` moves the cursor to the slider —
   * only wanted when the user clicked, not when the list refreshes underneath them.
   */
  select(item, { focus = true } = {}) {
    const { element, group, topic, slider } = this.#els;
    const sameTopic = this.#item?.topic === item.topic;
    this.#item = item;
    element.textContent = humanize(item.name);
    group.textContent = groupLabel(item.group);
    topic.value = item.topic;
    // Forget the previous input's game value before its range is computed.
    if (!sameTopic) this.#game = null;

    this.#variantChosenByUser = false;
    this.#variantIndex = matchVariant(item.variants ?? [], this.#context.trainset, this.#context.vehicle);
    this.#renderVariant();

    if (!sameTopic) {
      this.#dirty = false;
      const last = Number(item.lastValue);
      const initial =
        item.lastValue !== null && item.lastValue !== undefined && Number.isFinite(last)
          ? last
          : this.#range.min <= 0 && this.#range.max >= 0
            ? 0
            : this.#range.min;
      this.#showValue(initial);
      this.#renderGame();
      this.#watchTopic();
    }

    this.#refresh();
    if (focus) slider.focus();
  }

  /**
   * @param {{ serverOnline: boolean, mqttConnected: boolean, mqttError: string | null,
   *           trainset: object | null, vehicle: string | null }} context
   */
  setContext(context) {
    const trainChanged =
      context.vehicle !== this.#context.vehicle ||
      context.trainset?.name !== this.#context.trainset?.name ||
      context.trainset?.vehicleDesignation !== this.#context.trainset?.vehicleDesignation;
    this.#context = context;
    if (trainChanged && this.#item && !this.#variantChosenByUser) {
      this.#variantIndex = matchVariant(this.#item.variants ?? [], context.trainset, context.vehicle);
      this.#renderVariant();
    }
    if (!context.mqttConnected) this.#game = null;
    this.#renderGame();
    this.#refresh();
  }

  /** A value reported by the game for a watched topic. */
  setGameValue(topic, value, receivedAt) {
    if (topic !== this.#els.topic.value.trim()) return;
    this.#game = { topic, value, receivedAt };
    this.#includeInRange(value);
    if (!this.#dragging && !this.#dirty) this.#showValue(value);
    this.#renderGame();
  }

  // ---------- value & range ----------

  #readValue() {
    const raw = this.#els.value.value.trim();
    if (raw === '') return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  }

  #showValue(value) {
    this.#els.value.value = String(value);
    this.#els.slider.value = String(value);
    this.#renderMeaning();
    this.#refresh();
  }

  #applyRange(range) {
    const { slider, ticks, min, max, step } = this.#els;
    this.#range = range;
    min.value = String(range.min);
    max.value = String(range.max);
    step.value = String(range.step);
    for (const field of [min, max, step]) field.removeAttribute('aria-invalid');
    slider.min = String(range.min);
    slider.max = String(range.max);
    slider.step = String(range.step);
    ticks.replaceChildren(
      ...range.ticks.map((t) => {
        const option = document.createElement('option');
        option.value = String(t);
        return option;
      }),
    );
    // Re-sync the thumb with the value box (changing min/max can move it).
    const value = this.#readValue();
    if (value !== null) slider.value = String(value);
    this.#renderMeaning();
  }

  /** Min/max/step typed by the user. */
  #readRangeFields() {
    const { min, max, step } = this.#els;
    const lo = Number(min.value);
    const hi = Number(max.value);
    const st = Number(step.value);
    const okMin = min.value !== '' && Number.isFinite(lo);
    const okMax = max.value !== '' && Number.isFinite(hi) && (!okMin || hi > lo);
    const okStep = step.value !== '' && Number.isFinite(st) && st > 0;
    min.toggleAttribute('aria-invalid', !okMin);
    max.toggleAttribute('aria-invalid', !okMax);
    step.toggleAttribute('aria-invalid', !okStep);
    if (!okMin || !okMax || !okStep) return;

    const { slider } = this.#els;
    this.#range = { ...this.#range, min: lo, max: hi, step: st };
    slider.min = String(lo);
    slider.max = String(hi);
    slider.step = String(st);
    const value = this.#readValue();
    if (value !== null) slider.value = String(value);
  }

  /** Widen the slider if the game reports a value outside the documented range. */
  #includeInRange(value) {
    const { min, max } = this.#range;
    if (value >= min && value <= max) return;
    this.#applyRange({ ...this.#range, min: Math.min(min, value), max: Math.max(max, value) });
  }

  // ---------- rendering ----------

  #renderVariant() {
    const { details, variantField, variant, description, meta } = this.#els;
    const item = this.#item;
    const variants = item?.variants ?? [];
    const current = variants[this.#variantIndex];

    variantField.hidden = variants.length < 2;
    variant.replaceChildren(
      ...variants.map((v, i) => {
        const option = document.createElement('option');
        option.value = String(i);
        option.textContent = v.vehicles.join(', ') + (v.correction ? ' (corrected)' : '');
        return option;
      }),
    );
    variant.value = String(this.#variantIndex);

    description.textContent = current?.description ?? '';
    description.hidden = !current;
    const notes = [];
    if (current?.correction) notes.push(`Corrected from the wiki: ${current.correction}`);
    // With a single description, list the vehicles; with several, the picker already shows them.
    if (variants.length < 2 && item?.vehicles?.length) notes.push(`Vehicles: ${item.vehicles.join(', ')}`);
    meta.textContent = notes.join(' · ');
    details.hidden = !current && !meta.textContent;

    const range = inferRange(current?.description);
    this.#applyRange(range);
    if (this.#game) this.#includeInRange(this.#game.value);
  }

  #renderMeaning() {
    const { meaning } = this.#els;
    if (!this.#range.documented) {
      meaning.textContent = 'Range not documented: set min and max';
      meaning.dataset.kind = 'note';
      return;
    }
    const value = this.#readValue();
    const text = value === null ? undefined : describeValue(this.#range, value);
    meaning.textContent = text ? `${value} = ${text}` : '';
    meaning.dataset.kind = 'meaning';
  }

  #renderGame() {
    const { game } = this.#els;
    if (!this.#item && !this.#els.topic.value.trim()) {
      game.textContent = '';
      return;
    }
    if (!this.#context.mqttConnected) {
      game.textContent = 'In game: not connected';
      game.title = '';
    } else if (!this.#game) {
      game.textContent = 'In game: no value reported yet';
      game.title = '';
    } else {
      game.textContent = `In game: ${this.#game.value}`;
      game.title = `Reported at ${timeFormat.format(new Date(this.#game.receivedAt))}`;
    }
  }

  /** Why sending is unavailable, or null when it can be used. */
  #blocker() {
    const { serverOnline, mqttConnected, mqttError } = this.#context;
    if (!serverOnline) return 'Local server is offline. Reconnecting…';
    if (!mqttConnected) return `Waiting for SimRail. ${mqttError ?? 'Start a session with MQTT enabled to apply values.'}`;
    if (!this.#els.topic.value.trim()) return 'Pick an input from the list, or type a topic.';
    if (this.#readValue() === null) return 'Enter a number to send.';
    return null;
  }

  #refresh() {
    const blocker = this.#blocker();
    this.#els.apply.disabled = this.#busy || blocker !== null;
    this.#els.hint.textContent =
      blocker ?? (this.#els.live.checked ? 'Drag the slider to send, or type a value and press Enter.' : 'Press Enter or Apply to send.');
  }

  // ---------- sending ----------

  #watchTopic() {
    const topic = this.#els.topic.value.trim();
    if (this.#game && this.#game.topic !== topic) this.#game = null;
    this.#renderGame();
    this.#onWatch(topic || null);
  }

  #queueLive(value) {
    this.#livePending = value;
    if (this.#liveTimer) return;
    const wait = LIVE_INTERVAL_MS - (Date.now() - this.#lastLiveAt);
    if (wait <= 0) this.#flushLive();
    else this.#liveTimer = setTimeout(() => this.#flushLive(), wait);
  }

  #flushLive() {
    clearTimeout(this.#liveTimer);
    this.#liveTimer = null;
    if (this.#livePending === null) return;
    const value = this.#livePending;
    this.#livePending = null;
    this.#lastLiveAt = Date.now();
    void this.#send(value);
  }

  async #apply() {
    if (this.#busy || this.#blocker()) return;
    this.#busy = true;
    this.#refresh();
    const ok = await this.#send(this.#readValue());
    this.#busy = false;
    if (ok) this.#dirty = false;
    this.#refresh();
  }

  async #send(value) {
    const topic = this.#els.topic.value.trim();
    const seq = ++this.#sendSeq;
    const result = await this.#onApply(topic, value);
    // Values are sent in quick succession while dragging; only report the latest.
    if (seq === this.#sendSeq) {
      const time = timeFormat.format(new Date());
      this.#els.result.dataset.ok = String(result.ok);
      this.#els.result.textContent = result.ok
        ? `${time}  Sent ${value} → ${topic}`
        : `${time}  Failed to send ${value} → ${topic}: ${result.error ?? 'unknown error'}`;
    }
    return result.ok;
  }
}
