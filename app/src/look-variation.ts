import type { DB, Look, SlotKey } from '../server/schema.ts';
import { tooClose } from './look-memory.ts';

const CORE: SlotKey[] = ['top', 'layer', 'bottom', 'shoes'];
export const changedCoreSlots = (a: Look, b: Look) => CORE.filter((slot) => {
  const key = (look: Look) => look.slots[slot].map((r) => `${r.kind}:${r.id}`).sort().join('|');
  return key(a) !== key(b);
});

export function sameVariant(db: DB, a: Look, b: Look) {
  return a.capsuleId === b.capsuleId && tooClose(db, a.slots, b.slots);
}

/** Compare each look with the representative, so similarity cannot chain across a capsule. */
export function groupLookVariations(db: DB, looks: Look[]) {
  type Group = { primary: Look; variants: Look[] };
  const byId = new Map(looks.map((look) => [look.id, look]));
  const explicit = new Map<string, Group>();
  const parents = new Map<string, Group>();
  for (const look of looks) {
    const parent = look.variantOf && byId.get(look.variantOf);
    if (parent && parent.capsuleId === look.capsuleId) {
      const group = explicit.get(parent.id) ?? { primary: parent, variants: [] };
      explicit.set(parent.id, group);
      parents.set(look.id, group);
    }
  }
  const groups = [...explicit.values()];
  for (const look of looks) {
    if (explicit.has(look.id)) continue;
    const group = parents.get(look.id) ?? groups.find((g) => sameVariant(db, g.primary, look));
    if (group) group.variants.push(look);
    else groups.push({ primary: look, variants: [] });
  }
  return groups;
}
