import type { Capsule, DB, Look, SlotRef, Slots } from './schema.ts';
import { SLOT_KEYS } from './schema.ts';
import { bump, findOr404, HttpError, now } from './store.ts';
import { freePlaces, inSavedSet, normalizePiece, pieceCategory, pieceGroup, pieceKey, pieceSetError, piecesOutsideSet, visibleCapsuleLooks } from '../src/capsule-pieces.ts';

export function requireParentCapsule(db: DB, id: string | undefined): Capsule {
  if (!id) throw new HttpError(400, 'Вибери капсулу для образу');
  const capsule = findOr404(db.capsules, id, 'Капсула');
  if (capsule.redirectCapsuleIds) throw new HttpError(409, 'Капсулу вже перенесено. Вибери чинну капсулу');
  return capsule;
}

const pieceTitle = (db: DB, r: SlotRef) =>
  (r.kind === 'item' ? db.items.find((i) => i.id === r.id)?.title : db.needs.find((n) => n.id === r.id)?.title) ?? r.id;

/** A capsule with a saved set takes only looks made of its pieces (owner, 20.11). */
export function assertFitsCapsule(db: DB, slots: Slots, capsule: Capsule) {
  const outside = piecesOutsideSet(db, capsule, slots);
  if (!outside.length) return;
  throw new HttpError(409, `Поза набором капсули «${capsule.name}»: ${outside.map((r) => pieceTitle(db, r)).join(', ')}. Додай у набір або заміни`);
}

export function assertLookFits(db: DB, look: Look) {
  const capsule = look.capsuleId ? db.capsules.find((c) => c.id === look.capsuleId) : undefined;
  if (capsule) assertFitsCapsule(db, look.slots, capsule);
}

/** Saves the explicitly chosen outside piece in the same mutation as the look. */
export function addLookPieceToSet(db: DB, look: Look, revision: number, replaceKey?: string) {
  const capsule = requireParentCapsule(db, look.capsuleId ?? undefined);
  const outside = piecesOutsideSet(db, capsule, look.slots);
  if (!capsule.pieces || outside.length !== 1) throw new HttpError(409, 'Вибери одну річ поза набором капсули');
  const [piece] = outside;
  const category = pieceCategory(db, piece);
  if (!category) throw new HttpError(400, 'Річ не знайдено');
  const replacement = replaceKey ? capsule.pieces.find((ref) => pieceKey(normalizePiece(db, ref)) === replaceKey) : undefined;
  const replacementCategory = replacement && pieceCategory(db, replacement);
  if (replaceKey && (!replacementCategory || pieceGroup(replacementCategory) !== pieceGroup(category))) {
    throw new HttpError(409, 'Вибери заміну з тієї самої групи речей');
  }
  bump(capsule, revision);
  setCapsulePieces(db, capsule, [...capsule.pieces.filter((ref) => ref !== replacement), piece], undefined);
}

/** Update membership in both directions without changing the look's composition. */
export function placeLook(db: DB, look: Look, capsule: Capsule) {
  assertFitsCapsule(db, look.slots, capsule);
  for (const other of db.capsules) {
    if (other.id === capsule.id || !other.lookIds.includes(look.id)) continue;
    other.lookIds = other.lookIds.filter((id) => id !== look.id);
    bump(other, undefined);
  }
  if (!capsule.lookIds.includes(look.id)) {
    capsule.lookIds.push(look.id);
    bump(capsule, undefined);
  }
  look.capsuleId = capsule.id;
}

function refList(raw: unknown): SlotRef[] {
  if (!Array.isArray(raw)) throw new HttpError(400, 'Набір капсули — список речей');
  return raw.map((r) => {
    if (!r || typeof r !== 'object' || !['item', 'need', 'product'].includes((r as SlotRef).kind) || typeof (r as SlotRef).id !== 'string') {
      throw new HttpError(400, 'Набір капсули — список речей');
    }
    return { kind: (r as SlotRef).kind, id: (r as SlotRef).id };
  });
}

function unique(db: DB, refs: SlotRef[]): SlotRef[] {
  const seen = new Set<string>();
  return refs.map((r) => normalizePiece(db, r)).filter((r) => (seen.has(pieceKey(r)) ? false : (seen.add(pieceKey(r)), true)));
}

/**
 * Saves (or clears with null) a capsule's set and base. Every visible look of the
 * capsule must already be made of the new set; nothing is changed if one is not.
 */
export function setCapsulePieces(db: DB, capsule: Capsule, rawPieces: unknown, rawBase: unknown) {
  if (rawPieces === null) {
    delete capsule.pieces;
    delete capsule.base;
    return;
  }
  const pieces = rawPieces === undefined ? capsule.pieces : unique(db, refList(rawPieces));
  if (!pieces) throw new HttpError(400, 'Спершу збережи набір капсули');
  const keys = new Set(pieces.map(pieceKey));
  const base = rawBase === undefined
    ? (capsule.base ?? []).filter((r) => keys.has(pieceKey(r)))
    : rawBase === null ? [] : unique(db, refList(rawBase));
  const err = pieceSetError(db, pieces, base, capsule);
  if (err) throw new HttpError(422, err);
  const candidate = { ...capsule, pieces };
  const misfits = visibleCapsuleLooks(db, capsule).filter((l) => piecesOutsideSet(db, candidate, l.slots).length);
  if (misfits.length) {
    const outside = unique(db, misfits.flatMap((l) => piecesOutsideSet(db, candidate, l.slots)));
    throw new HttpError(409, `Образів поза набором: ${misfits.length} (${outside.map((r) => pieceTitle(db, r)).join(', ')}). Спершу зміни ці образи`);
  }
  capsule.pieces = pieces;
  if (base.length) capsule.base = base;
  else delete capsule.base;
}

/** A piece replaced across looks (merge, purchase, undo) is replaced in capsule sets too. */
export function replaceInSets(db: DB, match: (r: SlotRef) => boolean, replacement: SlotRef, capsuleIds?: Set<string>) {
  const next = normalizePiece(db, replacement);
  for (const c of db.capsules) {
    if (!c.pieces || (capsuleIds && !capsuleIds.has(c.id))) continue;
    if (!c.pieces.some(match) && !(c.base ?? []).some(match)) continue;
    c.pieces = unique(db, c.pieces.map((r) => (match(r) ? next : r)));
    if (c.base) c.base = unique(db, c.base.map((r) => (match(r) ? next : r)));
    bump(c, undefined);
  }
}

/** A deleted item or purchase leaves every capsule set. */
export function stripFromSets(db: DB, kind: SlotRef['kind'], id: string) {
  const hit = (r: SlotRef) => r.kind === kind && r.id === id;
  for (const c of db.capsules) {
    if (!c.pieces || (!c.pieces.some(hit) && !(c.base ?? []).some(hit))) continue;
    c.pieces = c.pieces.filter((r) => !hit(r));
    if (c.base) {
      c.base = c.base.filter((r) => !hit(r));
      if (!c.base.length) delete c.base;
    }
    bump(c, undefined);
  }
}

/**
 * A purchase accepted with a proposed look (owner, 20.11): it fills a free place of the capsule's set, or takes the
 * place of the set piece it replaces — in the set, its base and the capsule's visible looks (each gets a new version).
 */
export function placePurchaseInSet(db: DB, capsule: Capsule, purchase: SlotRef, replaces?: string) {
  if (!capsule.pieces || inSavedSet(db, capsule, purchase)) return;
  if (replaces) {
    const from = capsule.pieces.find((r) => pieceKey(r) === replaces);
    if (!from) throw new HttpError(409, 'Річ, яку замінює покупка, уже не в наборі капсули');
    const swap = (r: SlotRef) => (pieceKey(normalizePiece(db, r)) === replaces ? purchase : r);
    capsule.pieces = unique(db, capsule.pieces.map(swap));
    if (capsule.base) capsule.base = unique(db, capsule.base.map(swap));
    const at = now();
    const title = pieceTitle(db, from);
    for (const look of visibleCapsuleLooks(db, capsule)) {
      if (!SLOT_KEYS.some((k) => look.slots[k].some((r) => pieceKey(normalizePiece(db, r)) === replaces))) continue;
      const slots = Object.fromEntries(SLOT_KEYS.map((k) => [k, unique(db, look.slots[k].map(swap))])) as Slots;
      look.version += 1;
      look.slots = slots;
      look.versions.push({ version: look.version, slots, at, note: `Набір капсули: покупка замість «${title}»` });
      look.rev += 1;
      look.updatedAt = at;
    }
  } else {
    const category = pieceCategory(db, purchase);
    const free = freePlaces(db, capsule)!;
    if (!category || free[pieceGroup(category)] <= 0) throw new HttpError(409, `У наборі капсули «${capsule.name}» немає місця для «${pieceTitle(db, purchase)}». Що замінити?`);
    capsule.pieces = [...capsule.pieces, normalizePiece(db, purchase)];
  }
  bump(capsule, undefined);
}
