import { EventEmitter } from 'node:events';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import {
  applyChange,
  defaultSettings,
  isSerialSettings,
  parseSettingsFile,
  type Settings,
  type SettingsChange,
} from './schema.js';

interface StoreEvents {
  change: [Settings];
}

/**
 * The user's settings, kept in memory and written to a JSON file (settings/config.json) after
 * every change. Hand edits are picked up on the next start.
 */
export class SettingsStore extends EventEmitter<StoreEvents> {
  private readonly file: string;
  private settings: Settings;
  /** Writes run one after another, so an older version never lands last. */
  private writing: Promise<void> = Promise.resolve();

  private constructor(file: string, settings: Settings) {
    super();
    this.file = file;
    this.settings = settings;
  }

  static async open(file: string): Promise<SettingsStore> {
    const name = basename(file);
    let raw: string | null = null;
    try {
      raw = await readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    if (raw === null) {
      const store = new SettingsStore(file, defaultSettings());
      await store.write();
      console.log(`[settings] created ${file}`);
      return store;
    }

    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      // Keep the broken file for the user to fix, rather than overwrite it on the next change.
      const aside = join(dirname(file), `${basename(file, extname(file))}.invalid-${Date.now()}${extname(file)}`);
      await rename(file, aside);
      console.warn(`[settings] ${name} is not valid JSON (${(err as Error).message}); moved it to ${aside}`);
      const store = new SettingsStore(file, defaultSettings());
      await store.write();
      return store;
    }

    const settings = parseSettingsFile(data, (message) => console.warn(`[settings] ${name}: ${message}`));
    console.log(`[settings] loaded ${file}`);
    return new SettingsStore(file, settings);
  }

  get(): Settings {
    return this.settings;
  }

  /**
   * Apply a change and save it. Resolves once it is on disk; rejects if it couldn't be written
   * (the change still holds until the app is restarted).
   */
  async update(change: SettingsChange): Promise<Settings> {
    this.settings = applyChange(this.settings, change);
    console.log(`[settings] ${describe(change)}`);
    this.emit('change', this.settings);
    await this.write();
    return this.settings;
  }

  /** Resolves once pending writes are done. */
  flush(): Promise<void> {
    return this.writing.catch(() => {});
  }

  private write(): Promise<void> {
    const json = `${JSON.stringify(this.settings, null, 2)}\n`;
    const done = this.writing.catch(() => {}).then(() => writeAtomically(this.file, json));
    this.writing = done;
    return done.catch((err: Error) => {
      console.error(`[settings] could not save ${this.file}: ${err.message}`);
      throw new Error(`Could not save ${basename(this.file)}: ${err.message}`);
    });
  }
}

/** Write to a temporary file and rename it over the target, so a crash never leaves half a file. */
async function writeAtomically(file: string, data: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await writeFile(temp, data, 'utf8');
  try {
    await rename(temp, file);
  } catch {
    // Windows refuses the rename while another program has the file open; write it in place.
    await writeFile(file, data, 'utf8');
    await unlink(temp).catch(() => {});
  }
}

function describe(change: SettingsChange): string {
  switch (change.kind) {
    case 'locomotive':
      return `locomotive: ${change.locomotive ?? 'none'}`;
    case 'paused':
      return change.paused ? 'sending to SimRail paused' : 'sending to SimRail resumed';
    case 'joystick': {
      const j = change.joystick;
      const read = j.enabled ? 'read' : 'not read';
      return isSerialSettings(j) ? `${j.port}: ${read}, ${j.baudRate} baud, mask ${j.mask}` : `${j.port}: ${read}`;
    }
    case 'binding': {
      const b = change.binding;
      return `${b.locomotive}: ${b.joystick} channel ${b.channel + 1} -> ${b.feature}`;
    }
    case 'remove-binding':
      return `${change.locomotive}: ${change.joystick} channel ${change.channel + 1} unassigned`;
    case 'device': {
      const d = change.device;
      return `${d.locomotive}: device "${d.name}" (${d.type}, ${d.inputs.length} buttons) -> ${d.feature}`;
    }
    case 'remove-device':
      return `device ${change.id} removed`;
  }
}
