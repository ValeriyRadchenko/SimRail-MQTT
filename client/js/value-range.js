// Infers a slider range from an input's wiki description, e.g.
//   "0–43 = integer values (as float)"        -> 0..43, step 1
//   "0–1 = 0%–100% of brightness"             -> 0..1, step 0.01
//   "-128 = disabled\n128 = enabled"          -> -128..128, step 1, ticks at -128 and 128
//   "0 = disabled\n3.5-5.5 = braking (range)" -> 0..8, step 0.01
//   "From -1.001 (brake) to 1.0 (full ...)"   -> -1.001..1, step 0.001
// Only the part before "=" is read, so "0%–100%" on the right never widens the range.

const NUM = String.raw`-?\d+(?:\.\d+)?`;
// "0–43", "3.5-5.5", "4...6"
const RANGE_RE = new RegExp(String.raw`(${NUM})\s*(?:[–—-]|\.{2,3}|…)\s*(${NUM})`);
const FROM_TO_RE = new RegExp(String.raw`from\s+(${NUM}).*?\bto\s+(${NUM})`, 'i');
const DASH_MEANING_RE = new RegExp(String.raw`^\s*(${NUM})\s+[–—-]\s+(\D.*)$`); // "-1 - disable radio"
const INTEGER_HINT_RE = /\bint(eger)?s?\b/i;
const MAX_TICKS = 25;

export const DEFAULT_RANGE = Object.freeze({
  min: 0,
  max: 1,
  step: 0.01,
  ticks: [],
  meanings: new Map(),
  rangeMeanings: [],
  documented: false,
});

const decimals = (n) => (String(n).split('.')[1] ?? '').length;

/**
 * @param {string | undefined} description
 * @returns {{
 *   min: number, max: number, step: number, ticks: number[],
 *   meanings: Map<number, string>,
 *   rangeMeanings: { from: number, to: number, text: string }[],
 *   documented: boolean,
 * }}
 */
export function inferRange(description) {
  const numbers = [];
  const meanings = new Map();
  const rangeMeanings = [];
  let continuous = false;
  let integerOnly = false;

  for (const line of String(description ?? '').split('\n')) {
    const eq = line.indexOf('=');
    let left = eq > 0 ? line.slice(0, eq) : null;
    const meaning = eq > 0 ? line.slice(eq + 1).trim() : '';

    if (left === null) {
      const fromTo = line.match(FROM_TO_RE);
      const dashMeaning = line.match(DASH_MEANING_RE);
      const range = line.match(RANGE_RE);
      if (fromTo) left = `${fromTo[1]}–${fromTo[2]}`;
      else if (dashMeaning) {
        const value = Number(dashMeaning[1]);
        numbers.push(value);
        meanings.set(value, dashMeaning[2].trim());
        continue;
      } else if (range && INTEGER_HINT_RE.test(line)) left = range[0]; // "Int values 0-5"
      else continue;
      if (INTEGER_HINT_RE.test(line)) integerOnly = true;
    } else if (INTEGER_HINT_RE.test(line)) {
      integerOnly = true;
    }

    const range = left.match(RANGE_RE);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      numbers.push(from, to);
      if (meaning) rangeMeanings.push({ from: Math.min(from, to), to: Math.max(from, to), text: meaning });
      if (!INTEGER_HINT_RE.test(line)) continuous = true;
      continue;
    }

    // "5 = braking" or "1, 2, 3 = selected speed"
    const listed = left.match(new RegExp(NUM, 'g'))?.map(Number) ?? [];
    const isPlainList = /^[\s\d.,\-]+$/.test(left);
    for (const value of listed) {
      numbers.push(value);
      if (isPlainList && meaning && !meanings.has(value)) meanings.set(value, meaning);
    }
  }

  if (numbers.length < 2 && meanings.size === 0) return DEFAULT_RANGE;

  let min = Math.min(...numbers);
  let max = Math.max(...numbers);
  if (min === max) {
    // A single documented value (e.g. "0 = released"): give the slider somewhere to go.
    min = Math.min(min, 0);
    max = Math.max(max, 1);
  }

  const places = integerOnly && !continuous ? 0 : Math.max(...numbers.map(decimals), continuous ? 2 : 0);
  const step = Number((10 ** -Math.min(places, 3)).toFixed(3));

  const ticks = [...new Set(numbers)].sort((a, b) => a - b);
  return {
    min,
    max,
    step,
    ticks: ticks.length <= MAX_TICKS ? ticks : [],
    meanings,
    // A range's text only names a position when single values are listed too ("4...6 = full
    // service" among "3 = initial", "7 = re-application"); a lone "0–43 = integer values" doesn't.
    rangeMeanings: meanings.size > 0 ? rangeMeanings : [],
    documented: true,
  };
}

/** What a value means for this input, e.g. 6 -> "full service (3.4bar)". */
export function describeValue(range, value) {
  return range.meanings.get(value) ?? range.rangeMeanings.find((r) => value >= r.from && value <= r.to)?.text;
}

/** Round to the step's precision so 0.30000000000000004 shows as 0.3. */
export function roundToStep(value, step) {
  const places = Math.min(decimals(step), 6);
  return Number(value.toFixed(places));
}
