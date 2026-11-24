import { EventEmitter } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import mqtt, { type IPublishPacket, type MqttClient } from 'mqtt';
import type { MqttStatus, Trainset } from '../protocol.js';
import { decodeReceived, encodeFloat } from './payload.js';
import { parseTopicsResponse, type DiscoveredTopic } from './topics.js';

const TOPIC_REQUEST = 'request_topics';
const TOPIC_RESPONSE = 'request_topics_response';
const TOPIC_TRAINSET_NAME = 'trainset/name';
const TOPIC_TRAINSET_DESIGNATION = 'trainset/vehicle_designation';
const BASE_TOPICS = [TOPIC_RESPONSE, TOPIC_TRAINSET_NAME, TOPIC_TRAINSET_DESIGNATION];
/** A poll left unanswered this long is sent again. */
const POLL_TIMEOUT_MS = 1000;

function assertPublishableTopic(topic: string): void {
  if (!topic || /[+#\u0000]/.test(topic)) throw new Error(`Invalid topic "${topic}"`);
}

export interface BridgeOptions {
  host: string;
  port: number;
  clientId: string;
  reconnectMs: number;
  /** How often watched inputs are polled for their current value. */
  pollMs: number;
  /** Where the raw `request_topics_response` is saved for inspection. */
  runtimeDir: string;
}

interface BridgeEvents {
  status: [MqttStatus];
  trainset: [Trainset];
  /** The full topic list (answer to `request_topics` "all"). */
  topics: [DiscoveredTopic[]];
  /** Current value of a watched input, from polling. Emitted on every poll answer. */
  value: [topic: string, value: number];
}

/**
 * Connection to SimRail's MQTT broker. The broker only exists while a session is running,
 * so the bridge keeps retrying and reports "waiting" until the game is reachable.
 *
 * SimRail doesn't publish input states on the input topics; their current values are only
 * available through `request_topics`. Watched inputs are therefore polled with the topic as the
 * prefix filter, which the game answers in about a millisecond with a ~200-byte response.
 */
export class SimRailBridge extends EventEmitter<BridgeEvents> {
  private readonly options: BridgeOptions;
  private client: MqttClient | null = null;
  private status: MqttStatus;
  private trainset: Trainset = { name: null, vehicleDesignation: null };
  /** Input topics whose values are polled. */
  private readonly watched = new Set<string>();
  /** topic -> when its unanswered poll was sent */
  private readonly pollSentAt = new Map<string, number>();
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(options: BridgeOptions) {
    super();
    this.options = options;
    this.status = { state: 'waiting', broker: `${options.host}:${options.port}` };
  }

  getStatus(): MqttStatus {
    return this.status;
  }

  getTrainset(): Trainset {
    return this.trainset;
  }

  start(): void {
    const { host, port, clientId, reconnectMs } = this.options;
    const client = mqtt.connect(`mqtt://${host}:${port}`, {
      clientId,
      clean: true,
      keepalive: 5,
      protocolVersion: 4, // MQTT 3.1.1 — the wiki targets v3 clients
      reconnectPeriod: reconnectMs,
      connectTimeout: 5000,
      // Never replay control inputs that were sent while the game was unreachable.
      queueQoSZero: false,
    });
    this.client = client;

    client.on('connect', () => {
      this.setStatus({ state: 'connected' });
      client
        .subscribeAsync(BASE_TOPICS, { qos: 1 })
        .then(() => this.requestTopics())
        .then(() => this.startPolling())
        .catch((err: Error) => console.error('[mqtt] subscribe failed:', err.message));
    });
    client.on('close', () => {
      this.stopPolling();
      if (this.status.state === 'connected') console.log('[mqtt] disconnected from SimRail');
      this.setStatus({ state: 'waiting' });
      this.setTrainset({ name: null, vehicleDesignation: null });
    });
    client.on('error', (err) => {
      const error =
        (err as NodeJS.ErrnoException).code === 'ECONNREFUSED'
          ? 'Broker not reachable. SimRail opens it only during a session, with MQTT enabled in Control options.'
          : err.message;
      this.setStatus({ state: this.status.state, error });
    });
    client.on('message', (topic, payload, packet) => this.handleMessage(topic, payload, packet));
  }

  async stop(): Promise<void> {
    this.stopPolling();
    await this.client?.endAsync(true);
    this.client = null;
  }

  /** Ask the game for the full list of topics; the answer arrives on `request_topics_response`. */
  async requestTopics(): Promise<void> {
    if (!this.client?.connected) throw new Error('Not connected to SimRail');
    await this.client.publishAsync(TOPIC_REQUEST, 'all', { qos: 0 });
  }

  async publishFloat(topic: string, value: number): Promise<void> {
    if (!this.client?.connected) throw new Error('Not connected to SimRail');
    assertPublishableTopic(topic);
    await this.client.publishAsync(topic, encodeFloat(value), { qos: 0, retain: false });
  }

  /** Start polling a topic's current value (emitted as 'value'). */
  watch(topic: string): void {
    assertPublishableTopic(topic);
    if (this.watched.has(topic)) return;
    this.watched.add(topic);
    this.poll(topic); // don't wait for the next tick for the first value
  }

  unwatch(topic: string): void {
    this.watched.delete(topic);
    this.pollSentAt.delete(topic);
  }

  // ---------- polling ----------

  private startPolling(): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      for (const topic of this.watched) this.poll(topic);
    }, this.options.pollMs);
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.pollSentAt.clear();
  }

  private poll(topic: string): void {
    if (!this.client?.connected) return;
    const sentAt = this.pollSentAt.get(topic);
    if (sentAt !== undefined && Date.now() - sentAt < POLL_TIMEOUT_MS) return; // still waiting
    this.pollSentAt.set(topic, Date.now());
    this.client.publish(TOPIC_REQUEST, topic, { qos: 0 });
  }

  // ---------- incoming ----------

  private handleMessage(topic: string, payload: Buffer, packet: IPublishPacket): void {
    const value = decodeReceived(payload);
    switch (topic) {
      case TOPIC_RESPONSE:
        // The broker keeps the last response (possibly someone's 2-topic poll) and hands it to
        // every new subscriber; we always ask for fresh ones instead.
        if (!packet.retain) this.handleTopicsResponse(String(value));
        break;
      case TOPIC_TRAINSET_NAME: {
        const previous = this.trainset.name;
        this.setTrainset({ ...this.trainset, name: String(value) });
        // Different trainset -> different set of input topics.
        if (previous !== null && previous !== this.trainset.name) {
          this.requestTopics().catch((err: Error) => console.error('[mqtt] request_topics failed:', err.message));
        }
        break;
      }
      case TOPIC_TRAINSET_DESIGNATION:
        this.setTrainset({ ...this.trainset, vehicleDesignation: String(value) });
        break;
    }
  }

  private handleTopicsResponse(raw: string): void {
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      console.warn(`[mqtt] ${TOPIC_RESPONSE} is not JSON (${raw.length} chars); saved to .runtime/`);
      void this.saveRaw(raw);
      return;
    }
    const topics = parseTopicsResponse(data);

    // Every response (ours or another client's, poll or full) carries current values.
    for (const t of topics) {
      if (!this.watched.has(t.topic)) continue;
      this.pollSentAt.delete(t.topic);
      if (typeof t.value === 'number') this.emit('value', t.topic, t.value);
    }

    // Only a full list replaces the inputs. Prefix polls never contain trainset/name; a client
    // asking for "trainset" gets it but no inputs.
    const isFullList = topics.some((t) => t.topic === TOPIC_TRAINSET_NAME) && topics.some((t) => t.direction === 'input');
    if (!isFullList) return;
    void this.saveRaw(raw);
    console.log(`[mqtt] discovered ${topics.length} topics`);
    this.emit('topics', topics);
  }

  private async saveRaw(raw: string): Promise<void> {
    try {
      await mkdir(this.options.runtimeDir, { recursive: true });
      await writeFile(join(this.options.runtimeDir, `${TOPIC_RESPONSE}.json`), raw);
    } catch (err) {
      console.warn('[mqtt] could not save raw topics response:', (err as Error).message);
    }
  }

  private setStatus(next: Omit<MqttStatus, 'broker'>): void {
    // A successful connection clears the last error; while waiting, keep showing it.
    const error = next.state === 'connected' ? undefined : (next.error ?? this.status.error);
    const status: MqttStatus = { state: next.state, broker: this.status.broker, ...(error ? { error } : {}) };
    if (status.state === this.status.state && status.error === this.status.error) return;
    if (status.state === 'connected') console.log(`[mqtt] connected to SimRail at ${status.broker}`);
    this.status = status;
    this.emit('status', status);
  }

  private setTrainset(next: Trainset): void {
    if (next.name === this.trainset.name && next.vehicleDesignation === this.trainset.vehicleDesignation) return;
    this.trainset = next;
    this.emit('trainset', next);
  }
}
