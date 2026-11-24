import { groupLabel, humanize } from './humanize.js';

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const SOURCE_BADGE = {
  catalog: {
    text: 'Wiki catalogue',
    title:
      'SimRail has not reported its topics yet, so this list comes from the SimRail wiki. ' +
      'Topics are a best guess until the game is connected.',
  },
  live: { text: 'Live from SimRail', title: 'Topics reported by the running game (request_topics).' },
  stale: {
    text: 'From last session',
    title: 'Topics reported by SimRail before it disconnected. They are refreshed on reconnect.',
  },
};

/** The "Inputs" column: grouped, filterable list of MQTT input elements. */
export class InputsView {
  #els;
  #onSelect;
  #items = [];
  #source = null;
  #connected = false;
  #query = '';
  #selected = null;

  /**
   * @param {{ list: HTMLElement, filter: HTMLInputElement, count: HTMLElement, source: HTMLElement }} els
   * @param {(item: object, options: { byUser: boolean }) => void} onSelect
   */
  constructor(els, onSelect) {
    this.#els = els;
    this.#onSelect = onSelect;

    els.filter.addEventListener('input', () => {
      this.#query = els.filter.value.trim().toLowerCase();
      this.#render();
    });
    els.list.addEventListener('click', (event) => {
      const button = event.target.closest('[data-index]');
      if (button) this.#select(this.#items[Number(button.dataset.index)], true);
    });
  }

  /** Whether SimRail is currently connected (affects how a live list is labelled). */
  setConnected(connected) {
    this.#connected = connected;
    this.#renderBadge();
  }

  /** @param {{ source: 'catalog' | 'live', items: object[] }} inputs */
  setInputs({ source, items }) {
    this.#items = items.map((item) => {
      const title = humanize(item.name);
      const groupTitle = groupLabel(item.group);
      const search = [title, item.name, item.topic, groupTitle, ...(item.vehicles ?? [])].join(' ').toLowerCase();
      return { ...item, title, groupTitle, search };
    });

    this.#source = source;
    this.#renderBadge();

    // Keep the selection across list swaps (e.g. wiki catalogue -> live topics).
    if (this.#selected) {
      const prev = this.#selected;
      const match =
        this.#items.find((i) => i.topic === prev.topic) ??
        this.#items.find((i) => i.name === prev.name && i.group.toLowerCase() === prev.group.toLowerCase()) ??
        this.#items.find((i) => i.name === prev.name);
      this.#selected = null;
      if (match) this.#select(match, false);
    }
    this.#render();
  }

  #renderBadge() {
    const { source: el } = this.#els;
    const key = this.#source === 'live' && !this.#connected ? 'stale' : this.#source;
    const badge = SOURCE_BADGE[key];
    el.hidden = !badge;
    if (!badge) return;
    el.textContent = badge.text;
    el.title = badge.title;
    el.dataset.source = this.#source;
    el.dataset.connected = String(this.#connected);
  }

  #select(item, byUser) {
    this.#selected = item;
    this.#onSelect(item, { byUser });
    for (const el of this.#els.list.querySelectorAll('[aria-selected="true"]')) el.setAttribute('aria-selected', 'false');
    this.#els.list
      .querySelector(`[data-index="${this.#items.indexOf(item)}"]`)
      ?.setAttribute('aria-selected', 'true');
  }

  #render() {
    const { list, count } = this.#els;
    const visible = this.#query ? this.#items.filter((i) => i.search.includes(this.#query)) : this.#items;

    count.textContent = this.#query ? `${visible.length} / ${this.#items.length}` : String(this.#items.length);

    if (visible.length === 0) {
      list.innerHTML = `<p class="list-empty">${
        this.#items.length ? `No inputs match “${escapeHtml(this.#query)}”.` : 'No inputs available.'
      }</p>`;
      return;
    }

    // Fields shared by most trains come first, vehicle-specific groups after.
    const groups = new Map([['General', []]]);
    for (const item of visible) {
      if (!groups.has(item.groupTitle)) groups.set(item.groupTitle, []);
      groups.get(item.groupTitle).push(item);
    }

    let html = '';
    for (const [title, items] of groups) {
      if (items.length === 0) continue;
      html +=`<div class="group" role="group" aria-label="${escapeHtml(title)}">`;
      html += `<div class="group-header"><span>${escapeHtml(title)}</span><span class="count">${items.length}</span></div>`;
      for (const item of items) {
        const index = this.#items.indexOf(item);
        const selected = item === this.#selected;
        html +=
          `<button type="button" class="input-item" role="option" aria-selected="${selected}" data-index="${index}"` +
          ` title="${escapeHtml(item.topic)}">` +
          `<span class="input-title">${escapeHtml(item.title)}</span>` +
          `<code class="input-name">${escapeHtml(item.name)}</code>` +
          `</button>`;
      }
      html += '</div>';
    }
    list.innerHTML = html;
  }
}
