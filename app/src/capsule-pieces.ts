import type { Capsule, Category, DB, Look, SlotKey, SlotRef, Slots } from '../server/schema.ts';
import { hiddenLookIds, isCapsuleArchived, isCapsuleHidden } from './rating.ts';

/**
 * A capsule is a fashion style plus a closed set of pieces (owner, 20.11; spec
 * 2026-11-20-capsule-system-design.md): ten garments (top, layer, bottom), and
 * apart from them up to three pairs of shoes and three accessories. The set may
 * hold owned items and purchases still to buy. Until a capsule's set is saved,
 * it is read from the pieces its visible looks use. Shared by the server and the site.
 */
export const CAPSULE_LIMITS = { garments: 10, shoes: 3, accessories: 3 } as const;
export const MAX_BASE_PIECES = 2;

export type PieceGroup = keyof typeof CAPSULE_LIMITS;
export type PieceRole = 'top' | 'layer' | 'bottom' | 'shoes' | 'accessories';
type Limits = Record<PieceGroup, number>;
type LimitOptions = Pick<Capsule, 'accessoryLimit'>;

export const capsuleLimits = (capsule: LimitOptions): Limits => ({ ...CAPSULE_LIMITS, accessories: capsule.accessoryLimit ?? CAPSULE_LIMITS.accessories });

type PieceDb = Pick<DB, 'items' | 'needs' | 'products'>;

const SLOT_ORDER: SlotKey[] = ['layer', 'top', 'bottom', 'shoes', 'accessories'];
const GARMENT_ROLES = ['top', 'layer', 'bottom'] as const;
const DEFAULT_ROLE: Record<Category, PieceRole> = {
  outerwear: 'layer', knitwear: 'top', shirts: 'top', tees: 'top', dresses: 'top', trousers: 'bottom', shorts: 'bottom', skirts: 'bottom', shoes: 'shoes', accessories: 'accessories',
};

export const pieceGroup = (category: Category): PieceGroup =>
  category === 'shoes' ? 'shoes' : category === 'accessories' ? 'accessories' : 'garments';

export const pieceKey = (r: SlotRef) => `${r.kind}:${r.id}`;

/** A shop product stands for its purchase: the set keeps the purchase, a look may show the chosen product. */
export function normalizePiece(db: Pick<DB, 'products'>, ref: SlotRef): SlotRef {
  if (ref.kind !== 'product') return { kind: ref.kind, id: ref.id };
  const product = db.products.find((p) => p.id === ref.id);
  return product ? { kind: 'need', id: product.needId } : { kind: ref.kind, id: ref.id };
}

export function pieceCategory(db: PieceDb, ref: SlotRef): Category | undefined {
  const r = normalizePiece(db, ref);
  if (r.kind === 'item') return db.items.find((i) => i.id === r.id)?.category;
  if (r.kind === 'need') return db.needs.find((n) => n.id === r.id)?.category;
  return undefined;
}

/** The looks a capsule shows: hidden ones are history, not part of its set. */
export function visibleCapsuleLooks(db: DB, c: Pick<Capsule, 'lookIds'>): Look[] {
  const hidden = hiddenLookIds(db);
  return c.lookIds
    .map((id) => db.looks.find((l) => l.id === id))
    .filter((l): l is Look => l !== undefined && !hidden.has(l.id));
}

function uniquePieces(db: Pick<DB, 'products'>, refs: SlotRef[]): SlotRef[] {
  const seen = new Set<string>();
  const out: SlotRef[] = [];
  for (const r of refs) {
    const n = normalizePiece(db, r);
    if (seen.has(pieceKey(n))) continue;
    seen.add(pieceKey(n));
    out.push(n);
  }
  return out;
}

const slotPieces = (slots: Slots) => SLOT_ORDER.flatMap((k) => slots[k]);

/** The capsule's set: saved pieces, or — until it is saved — every piece its visible looks use. */
export function capsulePieceRefs(db: DB, c: Capsule): SlotRef[] {
  if (c.pieces) return uniquePieces(db, c.pieces);
  return uniquePieces(db, visibleCapsuleLooks(db, c).flatMap((l) => slotPieces(l.slots)));
}

/** The combinations formula: (tops × bottoms + dresses) × (layers + 1) × shoes. */
export function capsuleCombinations(r: { top: number; layer: number; bottom: number; shoes: number; dresses?: number }): number {
  return (r.top * r.bottom + (r.dresses ?? 0)) * (r.layer + 1) * r.shoes;
}

export interface CapsulePiece {
  ref: SlotRef;
  category?: Category;
  group: PieceGroup;
  /** Where the piece is worn: the slot it fills most often in the capsule's looks, else its category's usual one. */
  role: PieceRole;
  /** Visible looks of this capsule that use it. */
  looks: number;
  owned: boolean;
  base: boolean;
}

export interface CapsuleSet {
  /** False while the set is still read from the looks. */
  saved: boolean;
  pieces: CapsulePiece[];
  counts: Record<PieceGroup, number>;
  roles: Record<PieceRole, number>;
  combinations: number;
  /** Groups above their limit (a set read from the looks may be). */
  over: PieceGroup[];
}

export function capsuleSet(db: DB, c: Capsule): CapsuleSet {
  const looks = visibleCapsuleLooks(db, c);
  const baseKeys = new Set((c.base ?? []).map((r) => pieceKey(normalizePiece(db, r))));
  const pieces = capsulePieceRefs(db, c).map((ref): CapsulePiece => {
    const key = pieceKey(ref);
    const category = pieceCategory(db, ref);
    const group = category ? pieceGroup(category) : 'garments';
    const slotUse = new Map<SlotKey, number>();
    let used = 0;
    for (const l of looks) {
      let inLook = false;
      for (const k of SLOT_ORDER) {
        if (!l.slots[k].some((r) => pieceKey(normalizePiece(db, r)) === key)) continue;
        slotUse.set(k, (slotUse.get(k) ?? 0) + 1);
        inLook = true;
      }
      if (inLook) used += 1;
    }
    let role: PieceRole = category ? DEFAULT_ROLE[category] : 'top';
    if (group === 'garments') {
      const worn = GARMENT_ROLES.filter((k) => slotUse.has(k)).sort((a, b) => slotUse.get(b)! - slotUse.get(a)!);
      if (worn.length) role = worn[0];
    }
    return { ref, category, group, role, looks: used, owned: ref.kind === 'item', base: baseKeys.has(key) };
  });
  const counts: Record<PieceGroup, number> = { garments: 0, shoes: 0, accessories: 0 };
  const roles: Record<PieceRole, number> = { top: 0, layer: 0, bottom: 0, shoes: 0, accessories: 0 };
  for (const p of pieces) {
    counts[p.group] += 1;
    roles[p.role] += 1;
  }
  const limits = capsuleLimits(c);
  const over = (Object.keys(limits) as PieceGroup[]).filter((g) => counts[g] > limits[g]);
  // A dress worn as the top is a whole outfit on its own: it counts as a dress, not as a top to pair with bottoms.
  const dresses = pieces.filter((p) => p.category === 'dresses' && p.role === 'top').length;
  return { saved: Boolean(c.pieces), pieces, counts, roles, combinations: capsuleCombinations({ ...roles, top: roles.top - dresses, dresses }), over };
}

const GROUP_LIMIT_TEXT: Record<PieceGroup, string> = {
  garments: `до ${CAPSULE_LIMITS.garments} речей одягу`,
  shoes: `до ${CAPSULE_LIMITS.shoes} пар взуття`,
  accessories: 'аксесуарів',
};

/** Why a set cannot be saved, or null. Products must already be normalized to their purchase. */
export function pieceSetError(db: PieceDb, pieces: SlotRef[], base: SlotRef[] = [], capsule: LimitOptions = {}): string | null {
  const keys = new Set<string>();
  const counts: Record<PieceGroup, number> = { garments: 0, shoes: 0, accessories: 0 };
  for (const r of pieces) {
    if (r.kind !== 'item' && r.kind !== 'need') return 'У наборі капсули можуть бути лише речі й покупки';
    const category = pieceCategory(db, r);
    if (!category) return `Набір капсули: немає ${r.kind === 'item' ? 'речі' : 'покупки'} ${r.id}`;
    if (keys.has(pieceKey(r))) return 'Набір капсули: річ повторюється';
    keys.add(pieceKey(r));
    counts[pieceGroup(category)] += 1;
  }
  const limits = capsuleLimits(capsule);
  for (const g of Object.keys(limits) as PieceGroup[]) {
    if (counts[g] > limits[g]) {
      const limit = g === 'accessories' ? `до ${limits[g]} ${GROUP_LIMIT_TEXT[g]}` : GROUP_LIMIT_TEXT[g];
      return `У капсулі ${limit}. Що замінити?`;
    }
  }
  if (base.length > MAX_BASE_PIECES) return `База капсули — до ${MAX_BASE_PIECES} речей`;
  for (const r of base) if (!keys.has(pieceKey(r))) return 'База капсули має бути з її набору';
  return null;
}

/** Pieces of a look that are outside the capsule's saved set (none while the set is not saved). */
export function piecesOutsideSet(db: DB, c: Capsule, slots: Slots): SlotRef[] {
  if (!c.pieces) return [];
  const inSet = new Set(c.pieces.map((r) => pieceKey(normalizePiece(db, r))));
  return uniquePieces(db, slotPieces(slots)).filter((r) => !inSet.has(pieceKey(r)));
}

/** The fashion capsules shown on the site (selections, hidden and moved capsules are not). */
export const fashionCapsules = (db: DB) => db.capsules.filter((c) => c.kind !== 'selection' && !isCapsuleArchived(c) && !isCapsuleHidden(db, c));

/** Free places of a saved set per group; null while the set is still read from the looks. */
export function freePlaces(db: PieceDb, c: Capsule): Record<PieceGroup, number> | null {
  if (!c.pieces) return null;
  const free = capsuleLimits(c);
  for (const r of c.pieces) {
    const category = pieceCategory(db, r);
    if (category) free[pieceGroup(category)] -= 1;
  }
  return free;
}

export const inSavedSet = (db: Pick<DB, 'products'>, c: Capsule, ref: SlotRef) =>
  Boolean(c.pieces?.some((r) => pieceKey(normalizePiece(db, r)) === pieceKey(normalizePiece(db, ref))));

/**
 * How many new combinations each purchase adds to what can be worn today (owner, 20.11: the next purchase is the
 * one that completes the most looks, then the one that adds the most combinations), summed over the capsules
 * whose set holds it. Pieces already owned count; purchases still to buy do not.
 */
export function combinationGains(db: DB, capsules = fashionCapsules(db)): Map<string, number> {
  const gains = new Map<string, number>();
  for (const c of capsules) {
    const set = capsuleSet(db, c);
    const owned: Record<PieceRole, number> = { top: 0, layer: 0, bottom: 0, shoes: 0, accessories: 0 };
    for (const p of set.pieces) if (p.owned) owned[p.role] += 1;
    const before = capsuleCombinations(owned);
    for (const p of set.pieces) {
      if (p.ref.kind !== 'need') continue;
      const after = capsuleCombinations({ ...owned, [p.role]: owned[p.role] + 1 });
      gains.set(p.ref.id, (gains.get(p.ref.id) ?? 0) + after - before);
    }
  }
  return gains;
}

const normTitle = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/** Two purchase names for the same piece: equal, or sharing most of their words. */
export function sameTitle(a: string, b: string) {
  const wa = new Set(normTitle(a).split(' ').filter((w) => w.length > 2));
  const wb = new Set(normTitle(b).split(' ').filter((w) => w.length > 2));
  const shared = [...wa].filter((w) => wb.has(w)).length;
  return normTitle(a) === normTitle(b) || (shared >= 2 && shared / Math.min(wa.size, wb.size) >= 0.75);
}

/**
 * Whether a proposed look's purchases fit a capsule's closed set: each is a planned purchase of the set, replaces
 * a piece of the set of the same kind, or takes a free place. A capsule without a saved set takes any.
 */
export function buysFitSet(db: PieceDb, c: Capsule, buys: { title: string; category: Category; replaces?: string }[] = []): boolean {
  const free = freePlaces(db, c);
  if (!free || !c.pieces) return true;
  for (const b of buys) {
    const group = pieceGroup(b.category);
    if (c.pieces.some((r) => r.kind === 'need' && db.needs.some((n) => n.id === r.id && n.category === b.category && sameTitle(n.title, b.title)))) continue;
    const target = b.replaces ? c.pieces.find((r) => pieceKey(r) === b.replaces) : undefined;
    const targetCategory = target ? pieceCategory(db, target) : undefined;
    if (targetCategory && pieceGroup(targetCategory) === group) continue;
    if (free[group] <= 0) return false;
    free[group] -= 1;
  }
  return true;
}
