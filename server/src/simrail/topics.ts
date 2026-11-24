import type { InputElement } from '../protocol.js';

// Parsing of the `request_topics_response` message. As sent by SimRail:
//   { "Inputs":  [{ "Topic": "physics_input_general/drive_handle", "Type": "float", "CurrentValue": "0" }, …],
//     "Outputs": [{ "Topic": "trainset/name", "Type": "string", "CurrentValue": "trainset-Player" }, …] }
// CurrentValue is always a string, and "" for outputs that have no value yet.

export interface DiscoveredTopic {
  topic: string;
  direction: 'input' | 'output';
  type: string;
  /** Number for float topics, text for string topics, null when the game has no value. */
  value: number | string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** "0.5" -> 0.5; also accepts a decimal comma ("0,5"), in case the game formats with the PC's locale. */
export function parseFloatValue(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const text = raw.includes('.') ? raw : raw.replace(',', '.');
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

export function parseTopicsResponse(data: unknown): DiscoveredTopic[] {
  if (!isRecord(data)) return [];
  const topics: DiscoveredTopic[] = [];
  for (const [key, direction] of [['Inputs', 'input'], ['Outputs', 'output']] as const) {
    const list = data[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (!isRecord(entry) || typeof entry.Topic !== 'string') continue;
      const type = typeof entry.Type === 'string' ? entry.Type : 'float';
      const raw = entry.CurrentValue;
      const value =
        type === 'string' ? (typeof raw === 'string' ? raw : null) : parseFloatValue(raw);
      topics.push({ topic: entry.Topic, direction, type, value });
    }
  }
  return topics;
}

const GENERAL_GROUP = 'physics_input_general';
const groupOf = (topic: string) => topic.slice(0, Math.max(topic.lastIndexOf('/'), 0)).toLowerCase();

/**
 * Work out which catalogue vehicle the player is driving. The game doesn't say (trainset/name is
 * "trainset-Player"), but vehicle-specific input groups do: physics_input_e6act -> Dragon 2.
 * Groups shared by several vehicles (EU07: 4E and 102E) are settled by how well each vehicle's
 * catalogue inputs overlap the live ones.
 */
export function inferVehicle(liveInputTopics: string[], catalog: InputElement[]): string | null {
  const live = new Set(liveInputTopics.map((t) => t.toLowerCase()));
  const liveGroups = new Set([...live].map(groupOf).filter((g) => g !== GENERAL_GROUP));
  const isVehicle = (name: string) => !name.startsWith('Common');

  // 1. Votes from vehicle-specific groups present in the game.
  const votes = new Map<string, number>();
  for (const item of catalog) {
    if (!liveGroups.has(item.group.toLowerCase())) continue;
    for (const v of item.vehicles ?? []) if (isVehicle(v)) votes.set(v, (votes.get(v) ?? 0) + 1);
  }
  const top = Math.max(0, ...votes.values());
  let candidates = [...votes].filter(([, n]) => n === top && top > 0).map(([v]) => v);
  if (candidates.length === 1) return candidates[0] ?? null;

  // 2. Overlap (Jaccard) between each candidate's catalogue inputs and the live inputs.
  const stats = new Map<string, { total: number; matched: number }>();
  for (const item of catalog) {
    for (const v of item.vehicles ?? []) {
      if (!isVehicle(v)) continue;
      const s = stats.get(v) ?? { total: 0, matched: 0 };
      s.total += 1;
      if (live.has(item.topic.toLowerCase())) s.matched += 1;
      stats.set(v, s);
    }
  }
  if (candidates.length === 0) candidates = [...stats.keys()];
  let best: string | null = null;
  let bestScore = 0;
  for (const v of candidates) {
    const s = stats.get(v);
    if (!s) continue;
    const score = s.matched / (s.total + live.size - s.matched);
    if (score > bestScore) [best, bestScore] = [v, score];
  }
  return bestScore >= 0.2 ? best : null;
}

/**
 * Turn the game's topic list into the input list shown in the UI, borrowing descriptions and
 * vehicle lists from the wiki catalogue where the field matches.
 */
export function buildLiveInputs(
  topics: DiscoveredTopic[],
  catalog: InputElement[],
): { items: InputElement[]; vehicle: string | null } {
  const inputs = topics.filter((t) => t.direction === 'input');
  const byTopic = new Map(catalog.map((c) => [c.topic.toLowerCase(), c]));

  const items = inputs
    .map((t): InputElement => {
      const slash = t.topic.lastIndexOf('/');
      const name = t.topic.slice(slash + 1);
      const group = slash > 0 ? t.topic.slice(0, slash) : 'Other';
      const known = byTopic.get(t.topic.toLowerCase());
      return {
        topic: t.topic,
        name,
        group,
        vehicles: known?.vehicles,
        variants: known?.variants,
        lastValue: t.value,
      };
    })
    .sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));

  return { items, vehicle: inferVehicle(inputs.map((t) => t.topic), catalog) };
}
