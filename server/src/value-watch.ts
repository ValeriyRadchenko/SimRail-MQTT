import type { SimRailBridge } from './simrail/bridge.js';
import type { Client } from './ws.js';

/**
 * Tracks which topic each browser tab is following, keeps the bridge polling exactly the
 * topics someone watches, and fans values out to the tabs that want them.
 */
export class ValueWatch {
  private readonly bridge: SimRailBridge;
  private readonly topicByClient = new Map<number, string>();
  private readonly clientsByTopic = new Map<string, Set<Client>>();
  private readonly latest = new Map<string, { value: number; receivedAt: number }>();

  constructor(bridge: SimRailBridge) {
    this.bridge = bridge;
    bridge.on('value', (topic, value) => {
      const entry = { value, receivedAt: Date.now() };
      this.latest.set(topic, entry);
      for (const client of this.clientsByTopic.get(topic) ?? []) {
        client.send({ type: 'value', topic, ...entry });
      }
    });
  }

  /** Make `client` follow `topic` (replacing what it followed before); null stops following. */
  set(client: Client, topic: string | null): void {
    const previous = this.topicByClient.get(client.id);
    if (previous === topic) return;
    if (previous !== undefined) this.remove(client, previous);
    if (topic === null) return;

    // One bridge watch per topic, however many tabs follow it (released when the last one leaves).
    let clients = this.clientsByTopic.get(topic);
    if (!clients) {
      this.bridge.watch(topic); // throws on an invalid topic, before any bookkeeping
      clients = new Set<Client>();
      this.clientsByTopic.set(topic, clients);
    }
    this.topicByClient.set(client.id, topic);
    clients.add(client);

    // Another tab may already follow this topic: hand over the value we have.
    const known = this.latest.get(topic);
    if (known) client.send({ type: 'value', topic, ...known });
  }

  private remove(client: Client, topic: string): void {
    this.topicByClient.delete(client.id);
    const clients = this.clientsByTopic.get(topic);
    clients?.delete(client);
    if (clients && clients.size > 0) return;
    this.clientsByTopic.delete(topic);
    this.latest.delete(topic);
    this.bridge.unwatch(topic);
  }
}
