// Features: the SimRail inputs a joystick channel or a virtual device can drive on a locomotive.

import { groupLabel, humanize } from './humanize.js';
import { inferRange } from './value-range.js';

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** "physics_input_general/drive_handle" -> "Drive Handle" */
export const featureTitle = (topic) => humanize(topic.slice(topic.lastIndexOf('/') + 1));

/**
 * Features that can be driven on `locomotive`: those the wiki lists for it, plus everything the
 * game reports when that locomotive is the one being driven (and `currentTopic`, if it is neither).
 *
 * @param {{ catalog: object[], liveInputs: object | null }} sources  wiki catalogue, last 'inputs' message
 * @returns {{ topic: string, title: string, groupTitle: string, description: string,
 *             range: ReturnType<typeof inferRange> }[]}
 */
export function featuresFor({ catalog, liveInputs }, locomotive, currentTopic) {
  const features = new Map();
  const add = (item) => {
    const key = item.topic.toLowerCase();
    if (features.has(key)) return;
    const variants = item.variants ?? [];
    const description = (variants.find((v) => v.vehicles.includes(locomotive)) ?? variants[0])?.description ?? '';
    features.set(key, {
      topic: item.topic,
      title: humanize(item.name),
      groupTitle: groupLabel(item.group),
      description,
      range: inferRange(description),
    });
  };
  if (liveInputs?.source === 'live' && liveInputs.vehicle === locomotive) liveInputs.items.forEach(add);
  for (const item of catalog) {
    if (item.vehicles?.some((v) => v === locomotive || v.startsWith('Common'))) add(item);
  }
  if (currentTopic && !features.has(currentTopic.toLowerCase())) {
    const slash = currentTopic.lastIndexOf('/');
    add({ topic: currentTopic, name: currentTopic.slice(slash + 1), group: slash > 0 ? currentTopic.slice(0, slash) : 'Other' });
  }
  // Fields shared by most trains first, like the Inputs column.
  const rank = (f) => (f.groupTitle === 'General' ? 0 : 1);
  return [...features.values()].sort(
    (a, b) => rank(a) - rank(b) || a.groupTitle.localeCompare(b.groupTitle) || a.title.localeCompare(b.title),
  );
}

/** The <option>s of a feature <select>, grouped like the Inputs column. */
export function featureOptionsHtml(features) {
  const groups = new Map();
  for (const f of features) {
    if (!groups.has(f.groupTitle)) groups.set(f.groupTitle, []);
    groups.get(f.groupTitle).push(f);
  }
  return (
    '<option value="">Choose a feature…</option>' +
    [...groups]
      .map(
        ([group, list]) =>
          `<optgroup label="${escapeHtml(group)}">` +
          list.map((f) => `<option value="${escapeHtml(f.topic)}">${escapeHtml(f.title)}</option>`).join('') +
          '</optgroup>',
      )
      .join('')
  );
}

/** "physics_input_163/cabin_light · values from 0 to 2" */
export function featureHint(feature) {
  const { range } = feature;
  return `${feature.topic} · ${range.documented ? `values from ${range.min} to ${range.max}` : 'range not documented'}`;
}
