// A mask describes one line a joystick sends over its serial port:
//   a   analog value, a whole number (0–1023 from an Arduino's analogRead)
//   b   button: 0 = released, 1 = pressed
//   anything else has to appear in the line as is; spaces around it don't matter.
//
//   "{a,a}"    reads "{512,340}" and "{ 512, 340 }"  -> [512, 340]
//   "{a,a,b}"  reads "{512,340,1}"                   -> [512, 340, 1]
//   "X:a Y:a"  reads "X:12 Y:900"                    -> [12, 900]
//
// The whole line has to match, so a line cut off when the port was opened is skipped.

export type ChannelKind = 'analog' | 'button';

export const DEFAULT_MASK = '{a,a}';
const MAX_CHANNELS = 32;
const MAX_MASK_LENGTH = 200;

const PLACEHOLDERS: Record<string, { kind: ChannelKind; pattern: string }> = {
  a: { kind: 'analog', pattern: '(\\d+)' },
  b: { kind: 'button', pattern: '([01])' },
};

export interface CompiledMask {
  readonly mask: string;
  /** One entry per value in the line, in order. */
  readonly channels: ChannelKind[];
  /** "Axis 1", "Axis 2", "Button 1": numbered per kind, in mask order. */
  readonly labels: string[];
  /** The line's values in mask order, or null when the line doesn't have the mask's shape. */
  parse(line: string): number[] | null;
}

const escapeRegExp = (ch: string) => ch.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

/** Throws an Error explaining what is wrong with the mask. */
export function compileMask(mask: string): CompiledMask {
  const source = mask.trim();
  if (source === '') throw new Error('The mask is empty.');
  if (source.length > MAX_MASK_LENGTH) throw new Error(`The mask is longer than ${MAX_MASK_LENGTH} characters.`);

  const channels: ChannelKind[] = [];
  // Pieces of the pattern; `\s*` goes between neighbouring pieces unless one of them already
  // matches whitespace (two whitespace quantifiers side by side backtrack badly on junk lines).
  const pieces: { pattern: string; space: boolean }[] = [];
  let previousWasValue = false;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (/\s/.test(ch)) {
      if (!pieces.at(-1)?.space) pieces.push({ pattern: '\\s+', space: true });
      previousWasValue = false;
      continue;
    }
    const placeholder = PLACEHOLDERS[ch];
    if (placeholder) {
      if (previousWasValue) {
        throw new Error(`"${source.slice(i - 1, i + 1)}" has no separator between the values. Use e.g. "a,a".`);
      }
      channels.push(placeholder.kind);
      pieces.push({ pattern: placeholder.pattern, space: false });
      previousWasValue = true;
    } else {
      pieces.push({ pattern: escapeRegExp(ch), space: false });
      previousWasValue = false;
    }
  }

  if (channels.length === 0) throw new Error('The mask has no values. Use a for analog and b for buttons, e.g. {a,a}.');
  if (channels.length > MAX_CHANNELS) throw new Error(`The mask has more than ${MAX_CHANNELS} values.`);

  let body = '';
  pieces.forEach((piece, i) => {
    const previous = pieces[i - 1];
    if (previous && !previous.space && !piece.space) body += '\\s*';
    body += piece.pattern;
  });
  const re = new RegExp(`^\\s*${body}\\s*$`);

  const counts: Record<ChannelKind, number> = { analog: 0, button: 0 };
  const labels = channels.map((kind) => `${kind === 'button' ? 'Button' : 'Axis'} ${++counts[kind]}`);

  return {
    mask: source,
    channels,
    labels,
    parse(line) {
      const match = re.exec(line);
      return match ? match.slice(1).map(Number) : null;
    },
  };
}
