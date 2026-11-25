// WebSocket link to the local server, reconnecting automatically.
//
// Server -> client messages (see server/src/protocol.ts):
//   { type: 'mqtt-status', status: { state: 'connected' | 'waiting', broker, error? } }
//   { type: 'trainset', trainset: { name, vehicleDesignation } }
//   { type: 'inputs', inputs: { source: 'catalog' | 'live', items: InputElement[] } }
//   { type: 'value', topic, value, receivedAt }   current value of the watched topic
//   { type: 'publish-result', requestId, ok, topic, value, error? }
//   { type: 'catalog', items: InputElement[] }    wiki catalogue (inputs per locomotive)
//   { type: 'settings', settings }                settings/config.json: locomotive, joysticks, bindings
//   { type: 'joysticks', joysticks: [{ port, present, description, state, error?, channels }] }
//   { type: 'joystick-input', input: { port, line, values: number[] | null, receivedAt } }
//   { type: 'result', requestId, ok, error? }     answer to update-settings
// Client -> server:
//   { type: 'publish', requestId, topic, value }
//   { type: 'request-topics' }
//   { type: 'watch', topic | null }              follow one topic's value (this tab)
//   { type: 'update-settings', requestId, change }  see SettingsChange in server/src/settings/schema.ts

const RESPONSE_TIMEOUT_MS = 5000;
const MAX_RETRY_MS = 5000;

export class ServerConnection extends EventTarget {
  #url;
  #socket = null;
  #retryMs = 500;
  #nextRequestId = 1;
  /** requestId -> resolve */
  #pending = new Map();
  /** Topic this tab follows; re-sent after a reconnect (the server forgets it). */
  #watched = null;

  constructor(url) {
    super();
    this.#url = url;
  }

  get isOpen() {
    return this.#socket?.readyState === WebSocket.OPEN;
  }

  connect() {
    const socket = new WebSocket(this.#url);
    this.#socket = socket;

    socket.addEventListener('open', () => {
      this.#retryMs = 500;
      if (this.#watched) this.#send({ type: 'watch', topic: this.#watched });
      this.dispatchEvent(new Event('open'));
    });
    socket.addEventListener('message', (event) => this.#handleMessage(event.data));
    socket.addEventListener('close', () => {
      this.#settleAll({ ok: false, error: 'Lost connection to the local server' });
      this.dispatchEvent(new Event('close'));
      setTimeout(() => this.connect(), this.#retryMs);
      this.#retryMs = Math.min(this.#retryMs * 2, MAX_RETRY_MS);
    });
  }

  /** Publish a float to an MQTT topic. Resolves to { ok, error? }. */
  publish(topic, value) {
    return this.#request({ type: 'publish', topic, value });
  }

  /** Change a setting (saved to settings/config.json). Resolves to { ok, error? }. */
  updateSettings(change) {
    return this.#request({ type: 'update-settings', change });
  }

  /** Send a message that the server answers; resolves to { ok, error? }. */
  #request(message) {
    if (!this.isOpen) return Promise.resolve({ ok: false, error: 'Local server is offline' });

    const requestId = String(this.#nextRequestId++);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        resolve({ ok: false, error: 'No response from the local server' });
      }, RESPONSE_TIMEOUT_MS);
      this.#pending.set(requestId, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      this.#send({ ...message, requestId });
    });
  }

  requestTopics() {
    this.#send({ type: 'request-topics' });
  }

  /** Follow a topic's value from the game (null to stop). Values arrive as 'value' messages. */
  watch(topic) {
    if (topic === this.#watched) return;
    this.#watched = topic;
    this.#send({ type: 'watch', topic });
  }

  #send(message) {
    if (this.isOpen) this.#socket.send(JSON.stringify(message));
  }

  #handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.type === 'publish-result' || message.type === 'result') {
      const settle = this.#pending.get(message.requestId);
      this.#pending.delete(message.requestId);
      settle?.({ ok: message.ok, error: message.error });
      return;
    }
    this.dispatchEvent(new CustomEvent('message', { detail: message }));
  }

  #settleAll(result) {
    for (const settle of this.#pending.values()) settle(result);
    this.#pending.clear();
  }
}
