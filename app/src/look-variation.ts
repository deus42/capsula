import type { DB, Look, SlotKey } from '../server/schema.ts';
import { tooClose } from './look-memory.ts';

const CORE: SlotKey[] = ['top', 'layer', 'bottom', 'shoes'];
export const changedCoreSlots = (a: Look, b: Look) => CORE.filter((slot) => {
  const key = (look: Look) => look.slots[slot].map((r) => `${r.kind}:${r.id}`).sort().join('|');
  return key(a) !== key(b);
});

export function sameVariant(db: DB, a: Look, b: Look) {
  const sameFamily = a.capsuleId && a.capsuleId === b.capsuleId && (a.variantOf ?? a.id) === (b.variantOf ?? b.id);
  return Boolean(sameFamily) || tooClose(db, a.slots, b.slots);
}

/** Compare each look with the representative, so similarity cannot chain across a capsule. */
export function groupLookVariations(db: DB, looks: Look[]) {
  const groups: { primary: Look; variants: Look[] }[] = [];
  for (const look of looks) {
    const group = groups.find((g) => sameVariant(db, g.primary, look));
    if (group) group.variants.push(look);
    else groups.push({ primary: look, variants: [] });
  }
  return groups;
}
