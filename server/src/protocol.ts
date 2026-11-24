// Messages exchanged between the server and the browser over the WebSocket.
// The client (plain JS) mirrors these shapes in client/js/connection.js.

export type MqttConnectionState = 'connected' | 'waiting';

export interface MqttStatus {
  state: MqttConnectionState;
  /** e.g. "127.0.0.1:1883" */
  broker: string;
  /** Last connection problem, if any. */
  error?: string;
}

export interface Trainset {
  name: string | null;
  vehicleDesignation: string | null;
}

/** One wiki description of a field and the vehicles it applies to (meanings differ per vehicle). */
export interface DescriptionVariant {
  description: string;
  vehicles: string[];
  /** Set when the description is our correction of the wiki: what was wrong. */
  correction?: string;
}

export interface InputElement {
  /** Full MQTT topic a value is published to. */
  topic: string;
  /** Field name in snake_case (last topic segment). */
  name: string;
  /** Grouping, e.g. "Physics_Input_General". */
  group: string;
  vehicles?: string[];
  /** Most informative first. */
  variants?: DescriptionVariant[];
  lastValue?: number | string | null;
}

/** "catalog" = bundled list from the SimRail wiki; "live" = topics reported by the running game. */
export type InputsSource = 'catalog' | 'live';

export interface InputList {
  source: InputsSource;
  items: InputElement[];
  /** Catalogue vehicle recognised from the live topics, e.g. "Dragon 2 (ET25 / E6ACTa)". */
  vehicle?: string | null;
}

export type ServerMessage =
  | { type: 'mqtt-status'; status: MqttStatus }
  | { type: 'trainset'; trainset: Trainset }
  | { type: 'inputs'; inputs: InputList }
  /** Current value of the watched topic, as reported by the game (polled). */
  | { type: 'value'; topic: string; value: number; receivedAt: number }
  | {
      type: 'publish-result';
      requestId: string;
      ok: boolean;
      topic: string;
      value: number;
      error?: string;
    };

export type ClientMessage =
  | { type: 'publish'; requestId: string; topic: string; value: number }
  | { type: 'request-topics' }
  /** Follow one topic's value (replaces this tab's previous watch); null stops watching. */
  | { type: 'watch'; topic: string | null };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Validate an incoming WebSocket frame; returns null for anything malformed. */
export function parseClientMessage(raw: string): ClientMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;

  if (data.type === 'publish') {
    const { requestId, topic, value } = data;
    if (typeof requestId !== 'string' || typeof topic !== 'string') return null;
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return { type: 'publish', requestId, topic: topic.trim(), value };
  }
  if (data.type === 'request-topics') return { type: 'request-topics' };
  if (data.type === 'watch') {
    if (data.topic === null) return { type: 'watch', topic: null };
    if (typeof data.topic !== 'string') return null;
    const topic = data.topic.trim();
    return { type: 'watch', topic: topic === '' ? null : topic };
  }
  return null;
}
