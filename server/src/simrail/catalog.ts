import { readFile } from 'node:fs/promises';
import type { DescriptionVariant, InputElement } from '../protocol.js';

interface CatalogFile {
  source: string;
  fetchedAt: string;
  inputs: Array<{ category: string; name: string; vehicles: string[]; variants: DescriptionVariant[] }>;
}

interface OverridesFile {
  overrides: Record<string, Record<string, { description: string; note: string }>>;
}

/**
 * The wiki documents input fields per category (e.g. "Physics_Input_General") but never
 * spells out the full topic for them. The one documented topic is `trainset/name`
 * (category "Trainset", field "name"), so we assume `<category lowercased>/<field>`.
 * When the game is running, live discovery replaces these with the real topics.
 */
export function catalogTopic(category: string, name: string): string {
  return `${category.toLowerCase()}/${name}`;
}

/**
 * Input fields scraped from the SimRail wiki (server/data/simrail-inputs.json), with our
 * corrections (server/data/simrail-input-overrides.json) applied per vehicle.
 */
export async function loadCatalog(catalogPath: string, overridesPath: string): Promise<InputElement[]> {
  const file = JSON.parse(await readFile(catalogPath, 'utf8')) as CatalogFile;
  const { overrides } = JSON.parse(await readFile(overridesPath, 'utf8')) as OverridesFile;

  return file.inputs.map((i) => {
    const corrections = overrides[`${i.category}/${i.name}`];
    return {
      topic: catalogTopic(i.category, i.name),
      name: i.name,
      group: i.category,
      vehicles: i.vehicles,
      variants: corrections ? applyCorrections(i.variants, corrections) : i.variants,
    };
  });
}

/** Move each corrected vehicle out of the wiki variant it was in, into its own variant. */
function applyCorrections(
  variants: DescriptionVariant[],
  corrections: Record<string, { description: string; note: string }>,
): DescriptionVariant[] {
  const corrected = Object.keys(corrections);
  const fromWiki = variants
    .map((v) => ({ ...v, vehicles: v.vehicles.filter((name) => !corrected.includes(name)) }))
    .filter((v) => v.vehicles.length > 0);
  const ours = Object.entries(corrections).map(([vehicle, c]) => ({
    description: c.description,
    vehicles: [vehicle],
    correction: c.note,
  }));
  return [...fromWiki, ...ours];
}
