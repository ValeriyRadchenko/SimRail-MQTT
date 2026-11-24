// Turns SimRail field names (snake_case) into readable titles:
//   drive_handle             -> Drive Handle
//   compressor_rq            -> Compressor Request
//   headlight_individual_fl  -> Headlight Individual Front Left
//   etcs_ack_button          -> ETCS ACK Button
//   display1_F3              -> Display 1 F3

/** Abbreviations used in SimRail field names, expanded. */
const WORDS = {
  rq: 'Request',
  bt: 'Button',
  ctrl: 'Control',
  pos: 'Position',
  pow: 'Power',
  temp: 'Temperature',
  pas: 'Passenger',
  passanger: 'Passenger', // spelled this way in the API
  comp: 'Compartment',
  onoff: 'On/Off',
  cablight: 'Cab Light',
  endsignal: 'End Signal',
  highcurrent: 'High Current',
  springbrake: 'Spring Brake',
  l: 'Left',
  r: 'Right',
  fl: 'Front Left',
  fr: 'Front Right',
  ft: 'Front Top',
  rl: 'Rear Left',
  rr: 'Rear Right',
  rt: 'Rear Top',
};

/** Railway / train-protection acronyms kept in capitals. */
const ACRONYMS = new Set([
  'ack', 'ca', 'ed', 'ep', 'etcs', 'evc', 'hv', 'hz', 'lv', 'lzb', 'mcb', 'pzb', 'ril', 'shp', 'sifa', 'tco',
]);

/** Short words left lowercase unless first or last. */
const MINOR = new Set(['and', 'of', 'or', 'to']);

const capitalize = (w) => w.charAt(0).toUpperCase() + w.slice(1);

function humanizeWord(raw, index, count) {
  const w = raw.toLowerCase();
  if (Object.hasOwn(WORDS, w)) return WORDS[w];
  if (ACRONYMS.has(w)) return w.toUpperCase();
  if (MINOR.has(w) && index > 0 && index < count - 1) return w;
  // Single letters and letter+digits keys: a -> A, f3 -> F3, v0 -> V0
  if (/^[a-z]\d*$/.test(w)) return w.toUpperCase();
  // Word with a trailing number: compressor1 -> Compressor 1
  const numbered = w.match(/^([a-z]{3,})(\d+)$/);
  if (numbered) return `${capitalize(numbered[1])} ${numbered[2]}`;
  return capitalize(w);
}

/** snake_case field name -> human readable title. */
export function humanize(name) {
  const parts = String(name).split(/[_\s]+/).filter(Boolean);
  return parts.map((part, i) => humanizeWord(part, i, parts.length)).join(' ');
}

/**
 * Group heading for a category / topic prefix:
 *   Physics_Input_General -> General, Physics_Input_TRAXX_E186 -> TRAXX E186,
 *   physics_input_eu07 (lowercase live topic) -> EU07
 */
export function groupLabel(group) {
  const stripped = String(group).replace(/^physics_input_/i, '') || String(group);
  const words = stripped.split(/[_/\s]+/).filter(Boolean);
  if (stripped === stripped.toLowerCase()) {
    return words.map((w) => (/\d/.test(w) ? w.toUpperCase() : capitalize(w))).join(' ');
  }
  return words.join(' ');
}
