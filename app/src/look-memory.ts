import type { DB, SlotRef, Slots } from '../server/schema.ts';
import { pieceDifference, sameLookKeys } from './rating.ts';

/**
 * Look memory (owner, 19.11): every composition that ever existed — current looks and their older versions,
 * every advisor proposal (accepted or refused) and deleted looks — and one closeness check that every source of
 * new looks uses, so nothing that already was, or differs from it by one piece, is proposed again.
 */

const CORE = ['top', 'layer', 'bottom', 'shoes'] as const;
const SLOTS = [...CORE, 'accessories'] as const;

const COLOURS: [RegExp, string][] = [
  [/молочн|екрю|кремов|ecru|cream|off.?white|milk/i, 'cream'],
  [/біл|white/i, 'white'],
  [/чорн|black/i, 'black'],
  [/графіт|вугіль|charcoal|антрацит/i, 'charcoal'],
  [/сір|grey|gray/i, 'grey'],
  [/темно-син|navy|нейві/i, 'navy'],
  [/блакит|light blue|sky/i, 'lightblue'],
  [/денім|джинс|індиго|denim|indigo/i, 'denim'],
  [/син|blue/i, 'blue'],
  [/беж|пісоч|пісок|sand|beige|stone|кемел|camel|tan/i, 'sand'],
  [/олив|хакі|olive|khaki/i, 'olive'],
  [/зелен|green/i, 'green'],
  [/коричн|шоколад|brown|chocolate/i, 'brown'],
  [/бордов|burgundy|wine/i, 'burgundy'],
  [/червон|red/i, 'red'],
  [/рожев|pink/i, 'pink'],
];
/** The colour family a title or colour field names, or null when it names none. */
export function colourFamily(text: string | undefined): string | null {
  for (const [re, family] of COLOURS) if (re.test(text ?? '')) return family;
  return null;
}

/** What a piece stands for now: a merged item becomes its result, a covered purchase the item that covered it. */
function resolve(db: DB, r: SlotRef): { key: string; sig: string | null } {
  if (r.kind === 'product') {
    const needId = db.products.find((p) => p.id === r.id)?.needId;
    return needId ? resolve(db, { kind: 'need', id: needId }) : { key: `product:${r.id}`, sig: null };
  }
  if (r.kind === 'need') {
    const need = db.needs.find((n) => n.id === r.id);
    if (need?.coveredByItem) return resolve(db, { kind: 'item', id: need.coveredByItem });
    const family = need ? colourFamily(need.title) : null;
    return { key: `need:${r.id}`, sig: need && family ? `${need.category}:${family}` : null };
  }
  let item = db.items.find((i) => i.id === r.id);
  for (let hops = 0; item?.mergedInto && hops < 5; hops += 1) item = db.items.find((i) => i.id === item!.mergedInto);
  const family = item ? colourFamily(item.color) ?? colourFamily(item.title) : null;
  return { key: `item:${item?.id ?? r.id}`, sig: item && family ? `${item.category}:${family}` : null };
}

const keysOf = (db: DB, slots: Slots, only: readonly string[]) => new Set(only.flatMap((k) => (slots[k as keyof Slots] ?? []).map((r) => resolve(db, r).key)));

/** Exact duplicates have the same resolved pieces in each slot. */
export const sameComposition = (db: DB, a: Slots, b: Slots) =>
  SLOTS.every((slot) => pieceDifference(keysOf(db, a, [slot]), keysOf(db, b, [slot])) === 0);

/** The core outfit by kind and colour (top, layer, bottom, shoes); null when a colour is unknown. */
function coreSignature(db: DB, slots: Slots) {
  const parts: string[] = [];
  for (const k of CORE) {
    for (const r of slots[k] ?? []) {
      const s = resolve(db, r).sig;
      if (!s) return null;
      parts.push(`${k}=${s}`);
    }
  }
  return parts.length >= 3 ? parts.sort().join('|') : null;
}

/**
 * Too close to count as new: at most one piece different (the owner's rule), or at most one core piece different
 * ignoring accessories, or the same core by kind and colour (twin items, a purchase in place of the owned piece).
 */
export function tooClose(db: DB, a: Slots, b: Slots) {
  if (sameLookKeys(keysOf(db, a, SLOTS), keysOf(db, b, SLOTS))) return true;
  const ca = keysOf(db, a, CORE);
  const cb = keysOf(db, b, CORE);
  if (ca.size >= 3 && cb.size >= 3 && pieceDifference(ca, cb) <= 1) return true;
  const sa = coreSignature(db, a);
  return sa !== null && sa === coreSignature(db, b);
}

/** A proposed look with its pieces to buy, as slots: each piece to buy stands in as a purchase by its name. */
export function withBuys(slots: Slots, buy: { slot: keyof Slots; title: string }[] = []): Slots {
  const out = JSON.parse(JSON.stringify(slots)) as Slots;
  for (const b of buy) out[b.slot] = [...(out[b.slot] ?? []), { kind: 'need', id: `new:${b.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()}` }];
  return out;
}

/** Every composition that ever existed on the site. */
export function seenCompositions(db: DB): Slots[] {
  return [
    ...db.looks.flatMap((l) => [l.slots, ...l.versions.map((v) => v.slots)]),
    ...(db.suggestions ?? []).flatMap((s) => s.looks.map((l) => withBuys(l.slots, l.buy))),
    ...(db.lookMemory ?? []).map((m) => m.slots),
  ];
}

/** True when the outfit already was, or is within the closeness rule of something that was. */
export const alreadySeen = (db: DB, slots: Slots, extra: Slots[] = []) => [...seenCompositions(db), ...extra].some((s) => tooClose(db, slots, s));

/** Pieces the owner keeps refusing: in two or more refused proposals and in no look he kept. New proposals are not built around them. */
export function refusedPieces(db: DB, hidden: Set<string>): Set<string> {
  const count = new Map<string, number>();
  for (const s of db.suggestions ?? []) {
    if (s.status !== 'rejected') continue;
    const ids = new Set(s.looks.flatMap((l) => Object.values(l.slots).flat().filter((r) => r.kind === 'item').map((r) => r.id)));
    for (const id of ids) count.set(id, (count.get(id) ?? 0) + 1);
  }
  const kept = new Set(db.looks.filter((l) => !hidden.has(l.id)).flatMap((l) => Object.values(l.slots).flat().filter((r) => r.kind === 'item').map((r) => r.id)));
  return new Set([...count].filter(([id, n]) => n >= 2 && !kept.has(id)).map(([id]) => id));
}
