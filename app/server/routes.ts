import path from 'node:path';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type { Capsule, DB, FitType, Item, Job, Look, Need, Photo, PhotoKind, ReworkReason, SlotKey, SlotRef, Slots, SnapshotSlot, Language, WardrobeFocus, Wear } from './schema.ts';
import { CATEGORIES, FIT_TYPES, ITEM_STATUSES, LANGUAGES, MEASURE_KEYS, PERIODS, PHOTO_KINDS, REWORK_REASONS, SEASONS, SLOT_KEYS, WARDROBE_FOCUS } from './schema.ts';
import type { Store } from './store.ts';
import { HttpError, bump, findOr404, newId, now } from './store.ts';
import { computeDhash, dhashDistance, folderBytesAsync, prewarm, resolveAllowed, sameVisualPhoto, saveUpload, type StorageLimits } from './media.ts';
import { pickTheme } from './analysis.ts';
import { acceptSuggestion, dropReplacementsFor, keepItem, queueAdvice, rememberDeclined } from './advisor.ts';
import { looksNeedingRender, rendersPaused } from '../src/render-need.ts';
import { normalizePiece, pieceKey, pieceSetError } from '../src/capsule-pieces.ts';
import { itemCoverOptions, primaryPhotoFirst } from '../src/item-images.ts';
import { SLOT_CATEGORIES, hasPieces, isBlockedEyewear, isEyewear, lookGroup, lookVariants, resolveRef } from '../src/lib.ts';
import { productKey, queueStoreFind } from './shop-search.ts';
import { quotaKind, type QuotaKind } from './quota.ts';
import { STYLE_CATALOGUE, styleBrief } from '../src/style-catalogue.ts';
import { onePieceApart, sameComposition, tooClose, withBuys } from '../src/look-memory.ts';
import { sameVariant } from '../src/look-variation.ts';
import { queueDiscover } from './discover.ts';
import { sameIdentity } from './identity.ts';
import { addLookPieceToSet, assertLookFits, detachLookVariant, linkNewLookVariant, placeLook, replaceInSets, requireParentCapsule, setCapsulePieces, stripFromSets } from './capsule-membership.ts';
import { MAX_WEAR_PHOTOS, newWearId, queueWearReview, reviewPending, wearRender } from './wear-review.ts';
import { approveIdentityDraft, queueIdentityPrep } from './identity-prep.ts';
import { approveCapsules, approveSets, queueCapsuleMatch, queueCapsulePlan, type ApprovedSetInput } from './onboarding.ts';
import { cleanFit, fitPhotoPath, queueFitAnalysis, suggestFitFromMeasurements } from './fit.ts';

type Body = Record<string, unknown>;
export interface Ctx {
  store: Store;
  projectRoot: string;
  drain: () => void;
  /** False when try-ons must be started explicitly. */
  autoTryOn?: boolean;
  /** Accounts mode: refuses AI work beyond this month's allowance or while the budget is spent (429). */
  admit?: (kind: QuotaKind, n?: number) => void;
  /** Accounts mode, the owner excepted: photo size, photo count and folder size (413). */
  limits?: StorageLimits;
}

/** Jobs a write returned that the allowances let through (accounts drop the rest inside the write). */
const kept = (ctx: Ctx, ids: string[]) => {
  const live = new Set(ctx.store.read().jobs.map((j) => j.id));
  return ids.filter((id) => live.has(id));
};

const str = (v: unknown, max = 2000) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);
const SLOT_TEXT: Record<SlotKey, string> = { top: 'Верх', layer: 'Верхній шар', bottom: 'Низ', shoes: 'Взуття', accessories: 'Аксесуари' };

function pick<T extends object>(target: T, body: Body, fields: (keyof T & string)[]) {
  for (const f of fields) {
    if (!(f in body)) continue;
    const v = body[f];
    (target as Record<string, unknown>)[f] = typeof v === 'string' ? v.trim().slice(0, 2000) || undefined : v;
  }
}

function sameSlots(a: Slots, b: Slots) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function cleanSlots(raw: unknown): Slots {
  const out = { top: [], layer: [], bottom: [], shoes: [], accessories: [] } as Slots;
  const src = (raw ?? {}) as Record<string, unknown>;
  for (const k of SLOT_KEYS) {
    const list = Array.isArray(src[k]) ? (src[k] as SlotRef[]) : [];
    out[k] = list
      .filter((r) => r && ['item', 'need', 'product'].includes(r.kind) && typeof r.id === 'string')
      .map((r) => ({ kind: r.kind, id: r.id }));
  }
  return out;
}

function setLookSlots(look: Look, slots: Slots, note?: string) {
  if (sameSlots(look.slots, slots)) return false;
  look.version += 1;
  look.slots = slots;
  look.versions.push({ version: look.version, slots, at: now(), note });
  return true;
}

/**
 * The pictures a planned purchase can be rendered from, best first: its concept packshot, the chosen shop photo,
 * then the best-scored shop photos (at most 4, each once). An unreadable first picture falls back to the next.
 */
export function needGarmentPhotos(db: DB, need: Need): Photo[] {
  const usable = (id?: string) => {
    const p = id ? db.photos.find((x) => x.id === id) : undefined;
    return p && !p.archivedAt && !p.inspiration && !p.referenceRole && p.kind !== 'worn' && p.kind !== 'label' && p.kind !== 'base' ? p : undefined;
  };
  const shopPhoto = (p?: Photo) => (p && (p.kind === 'product' || (p.source === 'upload' && (p.kind === 'item' || p.kind === 'detail'))) ? p : undefined);
  const shop = db.products
    .filter((p) => p.needId === need.id && p.photoId)
    .sort((a, b) => Number(b.status === 'chosen') - Number(a.status === 'chosen') || (b.matchScore ?? -1) - (a.matchScore ?? -1))
    .map((p) => shopPhoto(usable(p.photoId)));
  const out: Photo[] = [];
  for (const p of [usable(need.conceptPhotoId), ...shop]) if (p && !out.some((x) => x.path === p.path)) out.push(p);
  return out.slice(0, 4);
}

/** Freezes the exact selection, photos and texts at queue time. */
export function snapshotSlots(db: DB, slots: Slots): SnapshotSlot[] {
  const out: SnapshotSlot[] = [];
  for (const slot of SLOT_KEYS) {
    for (const ref of slots[slot]) {
      if (ref.kind === 'item') {
        const item = findOr404(db.items, ref.id, 'Річ');
        const usable = item.photoIds.map((pid) => findOr404(db.photos, pid, 'Фото'))
          .filter((p) => !p.archivedAt && !p.inspiration && p.kind !== 'label' && p.referenceRole !== 'face');
        const real = usable.filter((p) => p.source !== 'generated');
        // A bought item keeps its shop photo until the owner photographs it: the photo its product slot used.
        const photos = (real.length ? real : usable.filter((p) => p.kind === 'product')).slice(-4).map((p) => p.path);
        const details = [item.color, item.brand, item.model, item.fit, item.composition, item.observation].filter(Boolean).join(', ');
        const crop = item.tryonReference;
        // Prefer the verified crop even in profiles created before identity pinning.
        const photoPaths = crop ? [crop.path] : db.profile.identity ? [] : photos;
        out.push({ slot, kind: 'item', id: item.id, title: item.title, description: details, owned: item.status !== 'inactive', photoPaths, originalPhotoPaths: photos, photoHashes: crop ? [crop, crop.source] : undefined });
      } else if (ref.kind === 'need') {
        const need = findOr404(db.needs, ref.id, 'Потреба');
        // A planned purchase is drawn from its concept picture, else its best shop photo; a crop is made and face-checked before use.
        out.push({ slot, kind: 'need', id: need.id, title: need.title, description: need.description ?? '', owned: false, photoPaths: [], originalPhotoPaths: needGarmentPhotos(db, need).map((photo) => photo.path) });
      } else {
        const p = findOr404(db.products, ref.id, 'Товар');
        const photo = p.photoId ? findOr404(db.photos, p.photoId, 'Фото') : undefined;
        const garmentUpload = photo?.source === 'upload' && (photo.kind === 'item' || photo.kind === 'detail');
        const originals = photo && !photo.inspiration && !photo.referenceRole && !photo.archivedAt && (photo.kind === 'product' || garmentUpload) ? [photo.path] : [];
        out.push({ slot, kind: 'product', id: p.id, title: `${p.brand} ${p.model}`.trim(), description: [p.composition, p.fit].filter(Boolean).join(', '), owned: false, photoPaths: [], originalPhotoPaths: originals });
      }
    }
  }
  return out;
}

export function createJob(db: DB, look: Look, basePhotoIds: string[], instructions: string, retryOf?: string, frozen?: Job['snapshot']): Job {
  const identity = db.profile.identity;
  const selectedIds = identity ? [identity.sourcePhotoId] : basePhotoIds.filter((id) => !db.photos.find((p) => p.id === id)?.archivedAt);
  const basePaths = identity ? [identity.face.path, identity.body.path, ...(identity.hair ? [identity.hair.crop.path] : [])] : selectedIds.map((id) => findOr404(db.photos, id, 'Базове фото').path);
  const snapshot = structuredClone(frozen ?? { lookName: look.name, slots: snapshotSlots(db, look.slots), basePhotoIds: selectedIds, basePhotoPaths: basePaths, identity });
  if (snapshot.identity?.noGlasses) snapshot.slots = snapshot.slots.filter((slot) => !isEyewear(slot.title));
  const job: Job = { id: newId('J'), lookId: look.id, lookVersion: frozen ? (db.jobs.find((j) => j.id === retryOf)?.lookVersion ?? look.version) : look.version, snapshot, instructions, state: 'queued', origin: 'site', retryOf, createdAt: now() };
  if (identity?.disabledReason || snapshot.identity?.disabledReason) {
    job.state = 'needs_data';
    job.stateNote = identity?.disabledReason || snapshot.identity?.disabledReason;
  } else if (!sameIdentity(identity, snapshot.identity)) {
    job.state = 'needs_data';
    job.stateNote = 'Опора обличчя або статури змінилася. Створи нову примірку з поточними референсами.';
  } else if (!snapshot.basePhotoIds.length) {
    job.state = 'needs_data';
    job.stateNote = 'Немає базового фото. Додай 2–3 фото спереду в «Мій профіль» або вибери фото в Примірці.';
  } else if (!snapshot.slots.length) {
    job.state = 'needs_data';
    job.stateNote = 'В образі немає жодної речі — додай верх, низ чи взуття.';
  }
  db.jobs.push(job);
  return job;
}

const ITEM_SLOT: Record<Item['category'], SlotKey> = { outerwear: 'layer', knitwear: 'top', shirts: 'top', tees: 'top', dresses: 'top', trousers: 'bottom', shorts: 'bottom', skirts: 'bottom', shoes: 'shoes', accessories: 'accessories' };

function packshotSources(db: DB, item: Item): string[] {
  const photos = item.photoIds.map((id) => findOr404(db.photos, id, 'Фото'))
    .filter((photo) => !photo.archivedAt && !photo.inspiration && photo.referenceRole !== 'face' && !['label', 'packshot', 'worn'].includes(photo.kind));
  const own = photos.filter((photo) => photo.kind !== 'product' && photo.source !== 'generated');
  return (own.length ? own : photos.filter((photo) => photo.kind === 'product')).slice(0, 3).map((photo) => photo.path);
}

export function packshotJob(db: DB, target: { itemId?: string; needId?: string }, instructions = '', retryOf?: string, frozen?: Job['snapshot']): Job {
  let snapshot = frozen;
  if (!snapshot && target.itemId) {
    const item = findOr404(db.items, target.itemId, 'Річ');
    const photos = packshotSources(db, item);
    const description = [item.color, item.brand, item.model, item.fit, item.observation].filter(Boolean).join('; ');
    snapshot = { lookName: item.title, slots: [{ slot: ITEM_SLOT[item.category], kind: 'item', id: item.id, title: item.title, description, owned: true, photoPaths: photos }], basePhotoIds: [], basePhotoPaths: [] };
  } else if (!snapshot && target.needId) {
    const need = findOr404(db.needs, target.needId, 'Потреба');
    snapshot = { lookName: need.title, slots: [{ slot: ITEM_SLOT[need.category], kind: 'need', id: need.id, title: need.title, description: need.description ?? '', owned: false, photoPaths: [] }], basePhotoIds: [], basePhotoPaths: [] };
  }
  if (!snapshot) throw new HttpError(400, 'Не вказано річ для packshot');
  const job: Job = { id: newId('J'), kind: 'packshot', itemId: target.itemId, needId: target.needId, lookVersion: 0, snapshot, instructions, state: 'queued', origin: 'site', retryOf, createdAt: now() };
  db.jobs.push(job);
  return job;
}

/** New garment evidence can fill a missing cover; existing covers stay in place. */
export function queueMissingItemPackshots(db: DB, itemIds: string[]): number {
  const activeIds = new Set(db.jobs.filter((job) => job.kind === 'packshot' && (job.state === 'queued' || job.state === 'running')).map((job) => job.itemId));
  let queued = 0;
  for (const id of new Set(itemIds)) {
    const item = db.items.find((candidate) => candidate.id === id);
    if (!item || item.status === 'inactive' || item.mergedInto || item.possibleDuplicateOf || item.packshotId || activeIds.has(id) || !packshotSources(db, item).length) continue;
    packshotJob(db, { itemId: id });
    queued += 1;
  }
  return queued;
}

/** A planned purchase gets its concept picture once, so Shopping and its looks are never left without an image. */
export function queueMissingNeedPackshots(db: DB, needIds: string[]): number {
  const active = new Set(db.jobs.filter((job) => job.kind === 'packshot' && (job.state === 'queued' || job.state === 'running')).map((job) => job.needId));
  let queued = 0;
  for (const id of new Set(needIds)) {
    const need = db.needs.find((candidate) => candidate.id === id);
    if (!need || need.status !== 'open' || need.conceptPhotoId || active.has(id)) continue;
    packshotJob(db, { needId: id });
    queued += 1;
  }
  return queued;
}

/**
 * Looks whose pieces changed get a fresh try-on by themselves (unless try-ons start by hand or cannot run at all).
 * A look still missing a garment picture keeps a waiting job that resumes when the picture arrives.
 */
export function queueChangedLookRenders(db: DB, lookIds: string[], autoTryOn?: boolean): Job[] {
  const ids = [...new Set(lookIds)].filter((id) => db.looks.some((look) => look.id === id));
  if (autoTryOn === false || !ids.length || rendersPaused(db)) return [];
  return queueNewLookRenders(db, ids);
}

/** A piece got its picture (a concept packshot, a real photo): try-ons of the current version waiting for it start again. */
export function resumeWaitingTryonsForRef(db: DB, kind: SlotRef['kind'], id: string, autoTryOn?: boolean): Job[] {
  if (autoTryOn === false || rendersPaused(db)) return [];
  const uses = (look: Look) => Object.values(look.slots).some((refs) => refs.some((r) => r.kind === kind && r.id === id));
  const waiting = (look: Look) => db.jobs.some((j) => (j.kind ?? 'tryon') === 'tryon' && j.lookId === look.id && j.lookVersion === look.version && j.state === 'needs_data');
  const busy = (look: Look) => db.jobs.some((j) => (j.kind ?? 'tryon') === 'tryon' && j.lookId === look.id && j.lookVersion === look.version && (j.state === 'queued' || j.state === 'running'));
  const looks = db.looks.filter((look) => uses(look) && waiting(look) && !busy(look));
  if (!looks.length) return [];
  const created = queueNewLookRenders(db, looks.map((look) => look.id));
  const started = new Set(created.filter((j) => j.state === 'queued').map((j) => j.lookId));
  const fresh = new Set(created.map((j) => j.id));
  // The waiting job goes only once a queued replacement exists; a replacement that would still wait is not kept.
  dropJobs(db, (j) => fresh.has(j.id) ? j.state !== 'queued' : (j.kind ?? 'tryon') === 'tryon' && j.state === 'needs_data' && Boolean(j.lookId && started.has(j.lookId)) && j.lookVersion === db.looks.find((look) => look.id === j.lookId)?.version);
  return created.filter((j) => j.state === 'queued');
}

/**
 * Replaces a piece in looks and capsule sets. `onlyLooks` limits the looks; the sets touched are then those of the
 * changed looks plus `alsoCapsules`. Changed capsule ids are added to `capsulesOut`.
 */
function replaceRefs(db: DB, match: (r: SlotRef) => boolean, replacement: SlotRef, note: string, onlyLooks?: Set<string>, alsoCapsules?: Set<string>, capsulesOut?: string[]) {
  const changedLooks: string[] = [];
  for (const look of db.looks) {
    if (onlyLooks && !onlyLooks.has(look.id)) continue;
    const next = cleanSlots(look.slots);
    let changed = false;
    for (const k of SLOT_KEYS) {
      next[k] = next[k].map((r) => {
        if (!match(r)) return r;
        changed = true;
        return replacement;
      });
      const seen = new Set<string>();
      next[k] = next[k].filter((r) => (seen.has(`${r.kind}:${r.id}`) ? false : (seen.add(`${r.kind}:${r.id}`), true)));
    }
    if (changed && setLookSlots(look, next, note)) {
      look.rev += 1;
      look.updatedAt = now();
      changedLooks.push(look.id);
    }
  }
  // Capsule sets follow the same replacement; a limited replacement touches only the capsules of the changed looks.
  const capsules = replaceInSets(db, match, replacement, onlyLooks ? new Set([...db.capsules.filter((c) => c.lookIds.some((id) => changedLooks.includes(id))).map((c) => c.id), ...(alsoCapsules ?? [])]) : undefined);
  capsulesOut?.push(...capsules);
  return changedLooks;
}

/**
 * Try-ons for looks whose current composition has none and none on the way
 * (hidden looks excepted). While generation is paused a job waits with the
 * reason instead of running; once the pause is lifted the look counts as
 * missing again, so "Оновити примірки" picks it up.
 */
function renderLooks(db: DB, lookIds?: string[], includeWaiting = false) {
  if (!includeWaiting && !db.profile.basePhotoIds.length) return [] as Job[];
  const versions = new Map(db.looks.filter((look) => !lookIds || lookIds.includes(look.id)).map((look) => [look.id, look.version]));
  // Older attempts that never started are obsolete, even when the look was emptied.
  dropJobs(db, (job) => {
    const current = job.lookId && versions.get(job.lookId);
    return Boolean(current && (job.kind ?? 'tryon') === 'tryon' && job.state === 'queued' && job.lookVersion !== current);
  });
  return looksNeedingRender(db)
    .filter((look) => versions.has(look.id))
    .map((look) => createJob(db, look, db.profile.basePhotoIds, ''));
}

/** New looks retain a waiting job when their personal or garment references are still missing. */
export function queueNewLookRenders(db: DB, ids: string[]) {
  return renderLooks(db, ids, true).map((job) => {
    const missing = job.snapshot.slots.filter((slot) => !slot.photoPaths.length && !slot.originalPhotoPaths?.length);
    if (job.state === 'queued' && missing.length) {
      job.state = 'needs_data';
      job.stateNote = `Потрібні окремі фото речей: ${[...new Set(missing.map((slot) => slot.title))].join(', ')}.`;
    }
    return job;
  });
}

/** The capsule's + Look starts empty and its item picker saves a piece at a time. */
function assembledDraft(db: DB, look: Pick<Look, 'slots'>) {
  const { top, layer, bottom, shoes } = look.slots;
  const dress = top.some((ref) => resolveRef(db, ref).category === 'dresses');
  return shoes.length > 0 && (dress || ((top.length > 0 || layer.length > 0) && bottom.length > 0));
}

function awaitingFirstAssembly(db: DB, look: Look) {
  const first = look.versions[0];
  return first && !hasPieces(first) && !look.versions.slice(1, -1).some((version) => assembledDraft(db, version));
}

/** A changed composition gets a fresh try-on; returns waiting jobs too. */
export const queueRerenders = (db: DB, lookIds: string[]) => renderLooks(db, lookIds);

/**
 * The owner already has what a recommendation asked for: the need leaves the
 * shopping list, its stand-ins in looks become the owner's item, and those
 * looks get fresh try-ons. Undone with uncoverNeed.
 */
export function coverNeed(db: DB, needId: string, itemId: string, autoTryOn?: boolean) {
  const need = findOr404(db.needs, needId, 'Потреба');
  const item = findOr404(db.items, itemId, 'Річ');
  if (need.status !== 'open') throw new HttpError(409, `«${need.title}» уже закрито`);
  if (item.category !== need.category) throw new HttpError(400, 'Річ іншої категорії, ніж рекомендація');
  if (item.status === 'inactive' || item.mergedInto) throw new HttpError(400, 'Неактуальна річ не закриває покупку');
  if (item.id === need.replaces) throw new HttpError(409, 'Це та сама річ, яку покупка має замінити');
  const options = new Set(db.products.filter((p) => p.needId === need.id && p.status !== 'purchased').map((p) => p.id));
  const capsules: string[] = [];
  const looks = replaceRefs(db, (r) => (r.kind === 'need' && r.id === need.id) || (r.kind === 'product' && options.has(r.id)) || (r.kind === 'item' && r.id === need.replaces), { kind: 'item', id: item.id }, `Своя річ замість «${need.title}»`, undefined, undefined, capsules);
  need.status = 'covered';
  need.coveredByItem = item.id;
  need.coveredLookIds = looks;
  // Capsule sets that took the item in its place are restored on undo too, even with no look changed.
  if (capsules.length) need.coveredCapsuleIds = [...new Set(capsules)];
  else delete need.coveredCapsuleIds;
  bump(need, undefined);
  history(item, 'covers_need', `${need.id} · ${need.title}`);
  bump(item, undefined);
  return { need, looks, renders: queueChangedLookRenders(db, looks, autoTryOn) };
}

/** Puts a recommendation back on the shopping list and its stand-in back into the looks it was replaced in. */
export function uncoverNeed(db: DB, needId: string, autoTryOn?: boolean) {
  const need = findOr404(db.needs, needId, 'Потреба');
  if (need.status !== 'covered') throw new HttpError(409, `«${need.title}» і так у покупках`);
  if (db.products.some((p) => p.needId === need.id && p.status === 'purchased')) throw new HttpError(409, 'Закрито покупкою — це запис покупки, не збіг із фото');
  const itemId = need.coveredByItem;
  restoreRetired(db, need);
  // A replacement purchase gives its looks the old item back; any other gets its stand-in back.
  const old = need.replaces ? db.items.find((i) => i.id === need.replaces && i.status !== 'inactive' && !i.mergedInto) : undefined;
  const looks = itemId ? replaceRefs(db, (r) => r.kind === 'item' && r.id === itemId, old ? { kind: 'item', id: old.id } : { kind: 'need', id: need.id }, `Повернуто в покупки: «${need.title}»`, new Set(need.coveredLookIds ?? []), new Set(need.coveredCapsuleIds ?? [])) : [];
  need.status = 'open';
  delete need.coveredByItem;
  delete need.coveredLookIds;
  delete need.coveredCapsuleIds;
  bump(need, undefined);
  const item = itemId ? db.items.find((i) => i.id === itemId) : undefined;
  if (item) {
    history(item, 'uncovers_need', `${need.id} · ${need.title}`);
    bump(item, undefined);
  }
  return { need, looks, renders: queueChangedLookRenders(db, looks, autoTryOn) };
}

/** «Прибрати стару річ»: after a replacement is bought or found, the old item may leave the wardrobe; undo brings it back. */
function retireReplaced(db: DB, need: Need, retire: unknown) {
  const old = need.replaces && retire === true ? db.items.find((i) => i.id === need.replaces) : undefined;
  if (!old || old.status === 'inactive') return;
  need.retired = { id: old.id, status: old.status };
  old.status = 'inactive';
  history(old, 'replaced', 'Замінено покупкою');
  bump(old, undefined);
}

/** Undo of «Вже маю» / «Куплено»: the old item taken out with it returns to the wardrobe. */
function restoreRetired(db: DB, need: Need) {
  const old = need.retired ? db.items.find((i) => i.id === need.retired!.id && !i.mergedInto) : undefined;
  if (old && old.status === 'inactive') {
    old.status = need.retired!.status;
    history(old, 'restored', `Скасовано заміну: ${need.title}`);
    bump(old, undefined);
  }
  delete need.retired;
}

function history(item: Item, action: string, note?: string) {
  item.history.push({ at: now(), action, note });
}

async function checkStorage(ctx: Ctx, limits: StorageLimits, bytes: number) {
  const mb = (n: number) => Math.round(n / 1024 ** 2);
  if (bytes > limits.fileBytes) throw new HttpError(413, `Фото більше за ${mb(limits.fileBytes)} МБ`);
  const uploads = ctx.store.read().photos.filter((p) => p.source === 'upload').length;
  if (uploads >= limits.photos) throw new HttpError(413, `Уже ${limits.photos} фото: більше в бета-версії не вміщається`);
  if ((await folderBytesAsync(ctx.store.dataDir)) + bytes > limits.storageBytes) throw new HttpError(413, `Місце закінчилося: ${Math.round(limits.storageBytes / 1024 ** 3)} ГБ на акаунт`);
}

function parseIntakeIntent(value: unknown): NonNullable<Job['intakeIntent']> {
  if (value === undefined || value === null || value === 'auto') return 'auto';
  if (value === 'person' || value === 'garments') return value;
  throw new HttpError(400, 'Невідомий намір розпізнавання фото');
}

function intakeJob(db: DB, photo: Photo, intakeIntent: NonNullable<Job['intakeIntent']>, instructions: string, batch = false) {
  const job: Job = { id: newId('J'), kind: 'intake', inputPhotoIds: [photo.id], intakeIntent, ...(batch ? { batch } : {}), lookVersion: 0, snapshot: { lookName: photo.originalName, slots: [], basePhotoIds: [], basePhotoPaths: [] }, instructions, state: 'queued', origin: 'site', createdAt: now() };
  db.jobs.push(job);
  return job;
}

// Serialize identical uploads from the same wardrobe, including asynchronous HEIC conversion.
const pendingUploads = new Map<string, Promise<Photo>>();
/** Perceptual candidates: at most this many of 64 dHash bits differ; sameVisualPhoto then decides. */
export const DHASH_MAX_DISTANCE = 6;
/** Older photos hashed per upload at most, so one upload never reads the whole archive. */
const DHASH_BACKFILL_CAP = 40;
/** A photo whose file could not be hashed is retried after this long (or as soon as its path changes). */
const DHASH_MISS_TTL_MS = 10 * 60 * 1000;
const dhashMisses = new Map<string, number>();

/** The same upload class: a worn look's photos among themselves, every other own photo among the rest. */
const sameUploadClass = (p: Photo, worn: boolean) => (worn ? p.kind === 'worn' : p.kind !== 'worn' && p.source !== 'generated');
/** Photos a re-encoded upload may resolve to: own, visible uploads of the same class. */
const visualPool = (db: DB, worn: boolean) => db.photos.filter((p) => p.source === 'upload' && !p.inspiration && !p.archivedAt && sameUploadClass(p, worn));

/**
 * Fills in the dHash of earlier visible uploads of the class (photos uploaded before hashing existed). A hash is
 * saved only while the photo still points at the file that was read.
 */
async function backfillDhashes(ctx: Ctx, worn: boolean) {
  const at = Date.now();
  const missKey = (p: Photo) => `${ctx.store.dataDir}:${p.id}:${p.path}`;
  const todo = visualPool(ctx.store.read(), worn).filter((p) => !p.dhash && !((dhashMisses.get(missKey(p)) ?? 0) > at)).slice(0, DHASH_BACKFILL_CAP);
  if (!todo.length) return;
  const found = new Map<string, { path: string; hash: string }>();
  for (const p of todo) {
    let hash: string | undefined;
    try {
      const file = resolveAllowed(ctx.projectRoot, ctx.store.dataDir, p.path);
      hash = fs.existsSync(file) ? await computeDhash(file) : undefined;
    } catch {
      hash = undefined;
    }
    if (hash) found.set(p.id, { path: p.path, hash });
    else dhashMisses.set(missKey(p), at + DHASH_MISS_TTL_MS);
  }
  if (!found.size) return;
  await ctx.store.mutate((db) => {
    for (const p of db.photos) {
      const f = found.get(p.id);
      if (!f || p.dhash || p.path !== f.path) continue;
      try {
        if (fs.existsSync(resolveAllowed(ctx.projectRoot, ctx.store.dataDir, p.path))) p.dhash = f.hash;
      } catch {
        /* a file outside the data folder is never hashed */
      }
    }
  });
}

/**
 * The visible own upload that is the same photograph as the incoming one: a near dHash proposes it, the tight
 * visual check (aspect ratio + 16×16 RGB difference) confirms it. Undefined keeps the upload a new photo.
 */
async function visualDuplicate(ctx: Ctx, worn: boolean, dhash: string, incoming: string | Buffer): Promise<string | undefined> {
  await backfillDhashes(ctx, worn);
  const near = visualPool(ctx.store.read(), worn)
    .filter((p) => p.dhash && dhashDistance(p.dhash, dhash) <= DHASH_MAX_DISTANCE)
    .sort((a, b) => dhashDistance(a.dhash!, dhash) - dhashDistance(b.dhash!, dhash))
    .slice(0, 3);
  for (const p of near) {
    try {
      const file = resolveAllowed(ctx.projectRoot, ctx.store.dataDir, p.path);
      if (fs.existsSync(file) && (await sameVisualPhoto(incoming, file))) return p.id;
    } catch {
      /* an unreadable candidate is not a match */
    }
  }
  return undefined;
}

export async function upload(ctx: Ctx, query: URLSearchParams, buf: Buffer, filename: string): Promise<Photo> {
  const intake = query.get('kind') === 'intake';
  const kind = (intake ? 'item' : (query.get('kind') ?? 'item')) as PhotoKind;
  if (!PHOTO_KINDS.includes(kind) || kind === 'source' || kind === 'packshot') throw new HttpError(400, 'Невідомий тип фото');
  const intent = intake ? parseIntakeIntent(query.get('intent')) : 'auto';
  const sha256 = createHash('sha256').update(buf).digest('hex');
  const key = `${ctx.store.dataDir}:${kind === 'worn'}`;
  const previous = pendingUploads.get(key);
  const run = (async () => {
    await previous?.catch(() => undefined);
    const worn = kind === 'worn';
    // The same bytes first (no hashing at all), then the same picture re-encoded, confirmed visually.
    const bySha = (db: DB) => db.photos.find((p) => p.sha256 === sha256 && sameUploadClass(p, worn));
    let dhash: string | undefined;
    let visualId: string | undefined;
    if (!bySha(ctx.store.read())) {
      dhash = await computeDhash(buf);
      if (dhash) visualId = await visualDuplicate(ctx, worn, dhash, buf);
    }
    const known = (db: DB) => bySha(db) ?? (visualId ? visualPool(db, worn).find((p) => p.id === visualId) : undefined);
    const id = newId('P');
    let queued = false;
    const apply = (db: DB, saved?: Awaited<ReturnType<typeof saveUpload>>) => {
      let photo = known(db);
      if (!photo) {
        if (!saved) return;
        photo = { id, kind, ...saved, originalName: path.basename(filename || 'upload').slice(0, 200), source: 'upload', preserveAsReference: true, meetsStandard: kind === 'base' ? null : undefined, sha256, ...(dhash ? { dhash } : {}), createdAt: now() };
        db.photos.push(photo);
      } else if (dhash && !photo.dhash && photo.source === 'upload') photo.dhash = dhash;
      delete photo.archivedAt;
      if (worn) return photo;
      if (kind === 'base') {
        photo.kind = 'base';
        if (query.get('role') === 'face') photo.referenceRole = 'face';
        selectBasePhoto(db, photo.id);
      }
      const itemId = query.get('item');
      if (itemId) {
        const item = findOr404(db.items, itemId, 'Річ');
        if (attachItemPhoto(item, photo) && !intake && kind === 'item') {
          clearStaleCrop(item, photo);
          queued = queueMissingItemPackshots(db, [itemId]) > 0;
          queued = resumeWaitingTryonsForRef(db, 'item', itemId, ctx.autoTryOn).length > 0 || queued;
        }
      }
      const productId = query.get('product');
      if (productId) {
        const product = findOr404(db.products, productId, 'Товар');
        if (product.photoId !== photo.id) {
          product.photoId = photo.id;
          bump(product, undefined);
          // Try-ons waiting for this purchase's picture can start now.
          queued = resumeWaitingTryonsForRef(db, 'need', product.needId, ctx.autoTryOn).length > 0 || queued;
          queued = resumeWaitingTryonsForRef(db, 'product', product.id, ctx.autoTryOn).length > 0 || queued;
        }
      }
      if (intake && (query.get('reanalyze') === '1' || !db.jobs.some((j) =>
        j.kind === 'intake' && j.inputPhotoIds?.includes(photo.id) && ['queued', 'running', 'done'].includes(j.state)))) {
        ctx.admit?.('intake');
        intakeJob(db, photo, intent, str(query.get('note')) ?? '', query.get('batch') === '1');
        queued = true;
      }
      return photo;
    };

    const existing = known(ctx.store.read());
    if (worn && existing && !existing.archivedAt) return existing;
    let photo = existing ? await ctx.store.mutate((db) => apply(db)) : undefined;
    if (!photo) {
      if (ctx.limits) await checkStorage(ctx, ctx.limits, buf.length);
      const saved = await saveUpload(ctx.projectRoot, ctx.store.dataDir, id, buf);
      try {
        // A HEIC original sharp cannot read is hashed from its JPEG display copy.
        if (!dhash && saved.originalPath && !bySha(ctx.store.read())) {
          const display = path.join(ctx.projectRoot, saved.path);
          dhash = await computeDhash(display);
          if (dhash) visualId = await visualDuplicate(ctx, worn, dhash, display);
        }
        photo = (await ctx.store.mutate((db) => apply(db, saved)))!;
      } finally {
        // Another process may have registered the same picture while this request saved it.
        if (photo?.id !== id) for (const rel of [saved.path, saved.originalPath]) if (rel) fs.rmSync(path.join(ctx.projectRoot, rel), { force: true });
      }
      if (photo.id === id) prewarm(ctx.projectRoot, ctx.store.dataDir, [saved.path]);
    }
    if (queued && query.get('run') !== '0') ctx.drain();
    return photo;
  })();
  pendingUploads.set(key, run);
  try {
    return await run;
  } finally {
    if (pendingUploads.get(key) === run) pendingUploads.delete(key);
  }
}

// ── Deletion with cascades (validateDb rejects anything left dangling) ────
function busyJob(db: DB, pred: (j: Job) => boolean) {
  if (db.jobs.some((j) => pred(j) && j.state === 'running')) throw new HttpError(409, 'Зачекай, поки завершиться генерація');
}

function dropJobs(db: DB, pred: (j: Job) => boolean) {
  const gone = new Set(db.jobs.filter(pred).map((j) => j.id));
  if (!gone.size) return gone;
  const resultIds = new Set(db.results.filter((r) => gone.has(r.jobId)).map((r) => r.id));
  db.results = db.results.filter((r) => !resultIds.has(r.id));
  db.comparisons = db.comparisons.filter((c) => !resultIds.has(c.resultA) && !resultIds.has(c.resultB));
  unpinRenders(db);
  db.jobs = db.jobs.filter((j) => !gone.has(j.id));
  for (const j of db.jobs) if (j.retryOf && gone.has(j.retryOf)) delete j.retryOf;
  return gone;
}

/** A deleted render leaves the wears it was beside: the real photos and the review stay. */
function unpinRenders(db: DB) {
  for (const w of db.wears ?? []) {
    if (!w.resultId || db.results.some((r) => r.id === w.resultId)) continue;
    delete w.resultId;
    if (w.review) delete w.review.resultId;
  }
}

export function deleteLook(db: DB, id: string) {
  const look = findOr404(db.looks, id, 'Образ');
  // The look memory keeps what it was, every version, so it is never proposed again (owner, 19.11).
  const at = now();
  const seen = new Set<string>();
  for (const slots of [look.slots, ...look.versions.map((v) => v.slots)]) {
    const key = JSON.stringify(slots);
    if (seen.has(key) || !Object.values(slots).some((r) => r.length)) continue;
    seen.add(key);
    db.lookMemory = [...(db.lookMemory ?? []), { slots, outcome: 'deleted' as const, ref: look.id, name: look.name, at }];
  }
  const wears = new Set((db.wears ?? []).filter((w) => w.lookId === id).map((w) => w.id));
  busyJob(db, (j) => j.lookId === id || (j.kind === 'wearreview' && wears.has(j.wearId ?? '')));
  dropJobs(db, (j) => j.lookId === id || (j.kind === 'wearreview' && wears.has(j.wearId ?? '')));
  // The real photos stay in «Мої фото»; only their link to the deleted look goes.
  if (db.wears) db.wears = db.wears.filter((w) => !wears.has(w.id));
  db.results = db.results.filter((r) => r.lookId !== id);
  unpinRenders(db);
  db.comparisons = db.comparisons.filter((c) => db.results.some((r) => r.id === c.resultA) && db.results.some((r) => r.id === c.resultB));
  for (const c of db.capsules) c.lookIds = c.lookIds.filter((l) => l !== id);
  for (const n of db.needs) if (n.coveredLookIds?.includes(id)) n.coveredLookIds = n.coveredLookIds.filter((l) => l !== id);
  detachLookVariant(db, look);
  db.looks = db.looks.filter((l) => l.id !== id);
}

export function deleteCapsule(db: DB, id: string) {
  const c = findOr404(db.capsules, id, 'Капсула');
  for (const l of db.looks.filter((look) => look.capsuleId === id)) deleteLook(db, l.id);
  for (const other of db.capsules) {
    if (other.redirectCapsuleIds?.includes(id)) other.redirectCapsuleIds = other.redirectCapsuleIds.filter((target) => target !== id);
  }
  for (const j of db.jobs) if (j.capsuleId === id) delete j.capsuleId;
  for (const n of db.needs) {
    if (!n.coveredCapsuleIds?.includes(id)) continue;
    n.coveredCapsuleIds = n.coveredCapsuleIds.filter((c) => c !== id);
    if (!n.coveredCapsuleIds.length) delete n.coveredCapsuleIds;
  }
  if (db.onboarding?.matchDrafts) db.onboarding.matchDrafts = db.onboarding.matchDrafts.filter((m) => m.capsuleId !== id);
  db.capsules = db.capsules.filter((x) => x.id !== id);
}

function stripRefs(db: DB, kind: SlotRef['kind'], id: string) {
  stripFromSets(db, kind, id);
  const changed: string[] = [];
  for (const look of db.looks) {
    const next = cleanSlots(look.slots);
    for (const k of SLOT_KEYS) next[k] = next[k].filter((r) => !(r.kind === kind && r.id === id));
    if (setLookSlots(look, next, 'Видалено річ зі складу')) {
      look.rev += 1;
      look.updatedAt = now();
      changed.push(look.id);
    }
  }
  return changed;
}

/** Removes an item everywhere; returns the looks whose pieces changed (the caller queues their try-ons). */
export function deleteItem(db: DB, id: string): string[] {
  const item = findOr404(db.items, id, 'Річ');
  if (db.products.some((p) => p.purchasedItemId === id)) throw new HttpError(409, 'Річ створена покупкою — скасуй покупку в «Покупках» (✎ → «Скасувати покупку»)');
  busyJob(db, (j) => j.itemId === id);
  const changed: string[] = [];
  // A deleted item no longer covers a recommendation: its looks get the stand-in back.
  for (const n of db.needs) if (n.coveredByItem === id && n.status === 'covered') changed.push(...uncoverNeed(db, n.id, false).looks);
  changed.push(...stripRefs(db, 'item', id));
  dropJobs(db, (j) => j.kind === 'packshot' && j.itemId === id);
  if (item.packshotId && !db.items.some((other) => other.id !== id && (other.packshotId === item.packshotId || other.photoIds.includes(item.packshotId!)))
    && !db.products.some((product) => product.photoId === item.packshotId)
    && !db.needs.some((need) => need.conceptPhotoId === item.packshotId)
    && !db.jobs.some((job) => job.photoId === item.packshotId)) {
    db.photos = db.photos.filter((p) => p.id !== item.packshotId);
  }
  for (const j of db.jobs) {
    if (j.createdItemIds?.includes(id)) j.createdItemIds = j.createdItemIds.filter((x) => x !== id);
    if (j.attachedItemIds?.includes(id)) j.attachedItemIds = j.attachedItemIds.filter((x) => x !== id);
    if (j.requiredItemIds?.includes(id)) j.requiredItemIds = j.requiredItemIds.filter((x) => x !== id);
  }
  for (const n of db.needs) if (n.coveredByItem === id) {
    delete n.coveredByItem;
    n.status = 'open';
  }
  if (db.onboarding?.matchDrafts) {
    for (const m of db.onboarding.matchDrafts) {
      m.ownedItemIds = m.ownedItemIds.filter((x) => x !== id);
      m.baseItemIds = m.baseItemIds.filter((x) => x !== id);
    }
  }
  if (db.onboarding?.unmatchedItemIds) db.onboarding.unmatchedItemIds = db.onboarding.unmatchedItemIds.filter((x) => x !== id);
  for (const other of db.items) if (other.possibleDuplicateOf === id) delete other.possibleDuplicateOf;
  db.items = db.items.filter((i) => i.id !== id);
  return [...new Set(changed)];
}

const MEASURE_UK: Record<(typeof MEASURE_KEYS)[number], string> = { height: 'зріст', chest: 'груди', waist: 'талія', hips: 'стегна', shoulders: 'плечі', sleeve: 'довжина рукава', inseam: 'внутрішній шов', foot: 'довжина стопи' };

type Handler = (ctx: Ctx, params: string[], body: Body) => unknown;
const routes: [string, RegExp, Handler][] = [];
const on = (method: string, pattern: string, h: Handler) => routes.push([method, new RegExp(`^${pattern.replace(/:\w+/g, '([^/]+)')}$`), h]);

// ── Wardrobe ───────────────────────────────────────────────────────────────
function manualItem(category: Item['category'], fields: Body, photoIds: string[] = []): Item {
  const at = now();
  const item: Item = { id: newId('W'), rev: 1, category, title: str(fields.title, 200) || 'Нова річ', status: 'confirmed', photoIds, origin: 'manual', history: [{ at, action: 'created', note: 'Додано власником' }], createdAt: at, updatedAt: at };
  pick(item, fields, ['color', 'brand', 'model', 'composition', 'fit', 'size']);
  if (fields.sport === true) item.sport = true;
  return item;
}

function clearDetachedCrop(db: DB, item: Item) {
  if (item.tryonReference && !item.photoIds.some((id) => db.photos.some((p) => p.id === id && p.path === item.tryonReference!.source.path))) delete item.tryonReference;
}

function clearStaleCrop(item: Item, photo: Photo) {
  if (item.tryonReference && item.tryonReference.source.path !== photo.path && photo.source !== 'generated'
    && !photo.inspiration && !photo.referenceRole && photo.kind !== 'product' && photo.kind !== 'label') delete item.tryonReference;
}

function attachItemPhoto(item: Item, photo: Photo) {
  if (item.photoIds.includes(photo.id)) return false;
  item.photoIds.push(photo.id);
  bump(item, undefined);
  history(item, 'photo_added', `${photo.kind}: ${photo.originalName}`);
  return true;
}

function selectBasePhoto(db: DB, id: string) {
  if (db.profile.basePhotoIds.includes(id)) return;
  db.profile.basePhotoIds.push(id);
  db.profile.rev += 1;
}

function removeBasePhoto(db: DB, id: string) {
  if (!db.profile.basePhotoIds.includes(id)) return;
  db.profile.basePhotoIds = db.profile.basePhotoIds.filter((photoId) => photoId !== id);
  db.profile.rev += 1;
}

on('POST', '/api/items', async (ctx, _p, b) => {
  const out = await ctx.store.mutate((db) => {
    const category = str(b.category) as Item['category'];
    if (!CATEGORIES.includes(category)) throw new HttpError(400, 'Вибери категорію');
    const item = manualItem(category, b);
    db.items.push(item);
    queueAdvice(db, `Нова річ: ${item.title}`);
    return item;
  });
  ctx.drain();
  return out;
});

on('PATCH', '/api/items/:id', async (ctx, [id], b) => {
  const out = await ctx.store.mutate((db) => {
    const item = findOr404(db.items, id, 'Річ');
    bump(item, b.rev);
    const before = item.status;
    pick(item, b, ['title', 'color', 'brand', 'model', 'composition', 'fit', 'size']);
    if (typeof b.sport === 'boolean') item.sport = b.sport;
    if (b.category && CATEGORIES.includes(b.category as never)) item.category = b.category as Item['category'];
    if (b.status && ITEM_STATUSES.includes(b.status as never)) item.status = b.status as Item['status'];
    // «Це моя річ? — Ні»: a rejected item no longer covers a recommendation; its looks get the stand-in back.
    if (item.status === 'inactive' && before !== 'inactive') for (const n of db.needs) if (n.coveredByItem === item.id && n.status === 'covered' && !db.products.some((p) => p.needId === n.id && p.status === 'purchased')) uncoverNeed(db, n.id, ctx.autoTryOn);
    if (Array.isArray(b.photoIds)) item.photoIds = (b.photoIds as string[]).filter((pid) => db.photos.some((p) => p.id === pid && p.kind !== 'worn' && !p.archivedAt));
    if (b.packshotId !== undefined) {
      const cover = itemCoverOptions(db, [item]).find((photo) => photo.id === b.packshotId);
      if (!cover) throw new HttpError(400, 'Вибери каталожне зображення цієї речі');
      item.packshotId = cover.id;
    }
    clearDetachedCrop(db, item);
    if (!item.title) throw new HttpError(400, 'Назва не може бути порожньою');
    history(item, before !== item.status ? `status:${item.status}` : 'edited');
    if (item.status === 'inactive') queueChangedLookRenders(db, dropReplacementsFor(db, item.id), ctx.autoTryOn);
    if (b.clearDuplicate === true) {
      delete item.possibleDuplicateOf;
      queueMissingItemPackshots(db, [item.id]);
    }
    queueAdvice(db, `Змінено річ: ${item.title}`);
    return item;
  });
  ctx.drain();
  return out;
});

const MERGE_FIELDS = ['brand', 'model', 'color', 'size', 'fit', 'composition'] as const;

function repointMergedItems(db: DB, ids: string[], target: Item) {
  const changed = new Set(replaceRefs(db, (r) => r.kind === 'item' && ids.includes(r.id), { kind: 'item', id: target.id }, `Обʼєднання речей → ${target.id}`));
  // A duplicate changes the catalogue link. Its approved picture still shows the same outfit.
  for (const look of db.looks) {
    if (!changed.has(look.id)) continue;
    const previousVersion = look.version - 1;
    if (look.keptVersion === previousVersion || db.results.some((result) =>
      result.lookId === look.id && result.lookVersion === previousVersion && result.review === 'accepted' && !result.hiddenAt)) {
      look.keptVersion = look.version;
    }
  }
  for (const n of db.needs) {
    if (n.coveredByItem && ids.includes(n.coveredByItem)) n.coveredByItem = target.id;
    if (n.replaces && ids.includes(n.replaces) && n.coveredByItem !== target.id) n.replaces = target.id;
  }
  for (const p of db.products) {
    if (p.purchasedItemId && ids.includes(p.purchasedItemId)) {
      p.purchasedItemId = target.id;
      bump(p, undefined);
    }
  }
  for (const item of db.items) {
    if (!item.possibleDuplicateOf || !ids.includes(item.possibleDuplicateOf)) continue;
    if (item.id === target.id) delete item.possibleDuplicateOf;
    else {
      item.possibleDuplicateOf = target.id;
      bump(item, undefined);
    }
  }
}

function markMerged(source: Item, target: Item) {
  source.status = 'inactive';
  source.mergedInto = target.id;
  delete source.possibleDuplicateOf;
  bump(source, undefined);
  history(source, 'merged_into', target.id);
}

function mergedPhotoIds(db: DB, items: Item[]) {
  const worn = new Set(db.photos.filter((p) => p.kind === 'worn').map((p) => p.id));
  return [...new Set(items.flatMap((item) => item.photoIds))].filter((id) => !worn.has(id));
}

function mergedCrop(db: DB, sources: Item[], photoIds: string[]) {
  return sources.map((item) => item.tryonReference).find((crop) =>
    crop && db.photos.some((photo) => photo.path === crop.source.path && photoIds.includes(photo.id)));
}

function dropUnusedAbsorbedPackshot(db: DB, source: Item) {
  const id = source.packshotId;
  if (!id || !db.photos.some((p) => p.id === id && p.kind === 'packshot' && p.source === 'generated' && !p.preserveAsReference)) return;
  const sourceJob = (job: Job) => job.kind === 'packshot' && job.itemId === source.id;
  if (db.items.some((i) => i.photoIds.includes(id) || (i.id !== source.id && i.packshotId === id))
    || db.needs.some((n) => n.conceptPhotoId === id) || db.products.some((p) => p.photoId === id)
    || db.profile.basePhotoIds.includes(id) || db.wears?.some((wear) => wear.photoIds.includes(id))
    || db.jobs.some((j) => j.inputPhotoIds?.includes(id) || j.snapshot.basePhotoIds.includes(id) || (j.photoId === id && !sourceJob(j)))) return;
  delete source.packshotId;
  for (const job of db.jobs) if (sourceJob(job) && job.photoId === id) delete job.photoId;
  db.photos = db.photos.filter((photo) => photo.id !== id);
}

on('POST', '/api/items/:id/absorb', async (ctx, [id], b) => {
  const out = await ctx.store.mutate((db) => {
    const target = findOr404(db.items, id, 'Річ');
    const source = findOr404(db.items, str(b.sourceId) ?? '', 'Річ');
    if (target.id === source.id) throw new HttpError(400, 'Вибери іншу річ для обʼєднання');
    if (target.mergedInto || source.mergedInto) throw new HttpError(409, 'Ці речі вже обʼєднано');
    busyJob(db, (j) => j.itemId === source.id);
    target.photoIds = [...new Set([...target.photoIds, ...mergedPhotoIds(db, [source])])];
    for (const field of [...MERGE_FIELDS, 'confirmedFact'] as const) if (!target[field] && source[field]) target[field] = source[field];
    if (source.sport) target.sport = true;
    if (!target.packshotId && source.packshotId) target.packshotId = source.packshotId;
    if (!target.tryonReference) {
      const crop = mergedCrop(db, [source], target.photoIds);
      if (crop) target.tryonReference = crop;
    }
    target.mergedFrom = [...new Set([...(target.mergedFrom ?? []), source.id])];
    markMerged(source, target);
    repointMergedItems(db, [source.id], target);
    dropJobs(db, (j) => j.kind === 'packshot' && j.itemId === source.id && j.state === 'queued');
    dropUnusedAbsorbedPackshot(db, source);
    bump(target, undefined);
    history(target, 'merged', source.id);
    queueAdvice(db, `Обʼєднано речі: ${target.title}`);
    return target;
  });
  ctx.drain();
  return out;
});

on('POST', '/api/items/merge', async (ctx, _p, b) => {
  const out = await ctx.store.mutate((db) => {
    const ids = Array.isArray(b.ids) ? [...new Set(b.ids.filter((id): id is string => typeof id === 'string'))] : [];
    if (ids.length < 2) throw new HttpError(400, 'Для обʼєднання потрібно щонайменше дві речі');
    const sources = ids.map((id) => findOr404(db.items, id, 'Річ'));
    if (sources.some((item) => item.mergedInto)) throw new HttpError(409, 'Ці речі вже обʼєднано');
    const keeper = sources.find((item) => item.id === b.keepId);
    if (b.keepId !== undefined && !keeper) throw new HttpError(400, 'Вибери картку з цих речей');
    const sourcePackshot = (job: Job) => job.kind === 'packshot' && Boolean(job.itemId && ids.includes(job.itemId));
    busyJob(db, sourcePackshot);
    const donor = keeper ?? sources.find((item) => item.id === b.targetId) ?? sources.find((item) => item.status === 'confirmed') ?? sources[0];
    const donors = [donor, ...sources.filter((item) => item !== donor)];
    const photoIds = mergedPhotoIds(db, sources);
    const primary = str(b.primaryPhotoId);
    if (primary && !photoIds.includes(primary)) throw new HttpError(400, 'Вибери основне фото з цих речей');
    const covers = itemCoverOptions(db, sources);
    const coverId = b.coverPhotoId ?? b.packshotId;
    const cover = coverId === undefined ? covers.find((photo) => photo.id === donor.packshotId) ?? covers[0] : covers.find((photo) => photo.id === coverId);
    if (coverId !== undefined && !cover) throw new HttpError(400, 'Вибери каталожне зображення цієї речі');
    const crop = mergedCrop(db, donors, photoIds);
    const duplicate = donors.find((item) => item.possibleDuplicateOf && !ids.includes(item.possibleDuplicateOf))?.possibleDuplicateOf;
    const at = now();
    const retired = keeper ? sources.filter((item) => item !== keeper) : sources;
    const merged: Item = {
      ...keeper,
      id: keeper?.id ?? newId('W'),
      rev: keeper ? keeper.rev + 1 : 1,
      category: keeper?.category ?? sources[0].category,
      ...(sources.some((item) => item.sport) ? { sport: true } : {}),
      title: str(b.title, 200) || keeper?.title || sources[0].title,
      // Merging items the owner already confirmed does not ask «Це моя річ?» again.
      status: sources.some((s) => s.status === 'confirmed') ? 'confirmed' : 'needs_confirmation',
      photoIds: primaryPhotoFirst(photoIds, primary),
      packshotId: cover?.id,
      tryonReference: crop,
      possibleDuplicateOf: duplicate,
      observation: sources.map((s) => `${s.id}: ${s.observation ?? ''}`).join(' · '),
      confirmedFact: sources.map((s) => s.confirmedFact).filter(Boolean).join(' ') || undefined,
      origin: 'merge',
      mergedFrom: [...new Set([...(keeper?.mergedFrom ?? []), ...retired.map((item) => item.id)])],
      history: [...(keeper?.history ?? []), { at, action: 'merged', note: `Обʼєднано з ${retired.map((item) => item.id).join(', ')}` }],
      createdAt: keeper?.createdAt ?? at,
      updatedAt: at,
    };
    for (const field of [...MERGE_FIELDS, 'purchasedFromProduct'] as const) {
      const value = donors.find((item) => item[field])?.[field];
      if (value) merged[field] = value;
    }
    // «Ні» on «варто замінити» survives a merge: the merged piece is rated again, still kept.
    const kept = sources.find((x) => x.rating?.kept)?.rating;
    if (kept) merged.rating = { ...kept, replace: undefined, replaceWith: undefined, rev: -1, kept: true };
    if (keeper) db.items[db.items.indexOf(keeper)] = merged;
    else db.items.push(merged);
    for (const source of retired) markMerged(source, merged);
    repointMergedItems(db, retired.map((item) => item.id), merged);
    dropJobs(db, (job) => job.state === 'queued' && sourcePackshot(job));
    queueMissingItemPackshots(db, [merged.id]);
    queueAdvice(db, `Обʼєднано речі: ${merged.title}`);
    return merged;
  });
  ctx.drain();
  return out;
});

on('POST', '/api/items/:id/split', (ctx, [id], b) =>
  ctx.store.mutate((db) => {
    const item = findOr404(db.items, id, 'Річ');
    const photoIds = (Array.isArray(b.photoIds) ? (b.photoIds as string[]) : []).filter((p) => item.photoIds.includes(p));
    if (!photoIds.length || photoIds.length === item.photoIds.length) throw new HttpError(400, 'Вибери частину фото для окремої речі');
    const at = now();
    const part: Item = { id: newId('W'), rev: 1, category: item.category, ...(item.sport ? { sport: true } : {}), title: str(b.title, 200) || `${item.title} (окрема)`, status: 'needs_confirmation', photoIds, observation: item.observation, origin: 'split', splitFrom: item.id, history: [{ at, action: 'split', note: `Відокремлено від ${item.id}` }], createdAt: at, updatedAt: at };
    item.photoIds = item.photoIds.filter((p) => !photoIds.includes(p));
    clearDetachedCrop(db, item);
    bump(item, b.rev);
    history(item, 'split', `Фото ${photoIds.join(', ')} → ${part.id}`);
    db.items.push(part);
    return part;
  }),
);

// Batch confirmation/removal during Step 3 wardrobe triage (without opening every item page one by one).
on('POST', '/api/items/batch-status', async (ctx, _p, b) => {
  const out = await ctx.store.mutate((db) => {
    const status = str(b.status) as Item['status'];
    if (status !== 'confirmed' && status !== 'inactive') throw new HttpError(400, 'Невідомий статус');
    const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).filter((x): x is string => typeof x === 'string'))];
    if (!ids.length) return { updated: 0 };
    let updated = 0;
    const changed: string[] = [];
    for (const id of ids) {
      const item = db.items.find((i) => i.id === id && !i.mergedInto);
      if (!item || item.status === status) continue;
      item.status = status;
      item.rev += 1;
      item.updatedAt = now();
      history(item, `status:${status}`);
      if (status === 'inactive') {
        // Like «Це моя річ? — Ні» on one item: it no longer covers a recommendation, and its replacement purchase goes.
        for (const n of db.needs) if (n.coveredByItem === item.id && n.status === 'covered' && !db.products.some((p) => p.needId === n.id && p.status === 'purchased')) changed.push(...uncoverNeed(db, n.id, false).looks);
        changed.push(...dropReplacementsFor(db, item.id));
      }
      updated += 1;
    }
    if (updated) {
      queueChangedLookRenders(db, changed, ctx.autoTryOn);
      queueAdvice(db, status === 'confirmed' ? `Підтверджено речей: ${updated}` : `Прибрано речей: ${updated}`);
    }
    return { updated };
  });
  ctx.drain();
  return out;
});

// ── Capsules & looks ───────────────────────────────────────────────────────
function setAccessoryLimit(capsule: Capsule, limit: unknown) {
  if (limit === undefined) return;
  if (limit === 4) capsule.accessoryLimit = 4;
  else if (limit === null || limit === 3) delete capsule.accessoryLimit;
  else throw new HttpError(400, 'Некоректний ліміт аксесуарів');
}

on('POST', '/api/capsules', (ctx, _p, b) =>
  ctx.store.mutate((db) => {
    const name = str(b.name, 80);
    if (!name) throw new HttpError(400, 'Назва не може бути порожньою');
    if (db.capsules.some((c) => !c.redirectCapsuleIds && c.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, 'Така капсула вже є');
    const season = SEASONS.includes(b.season as never) ? (b.season as Capsule['season']) : 'all';
    const periods = Array.isArray(b.periods) ? [...new Set((b.periods as string[]).filter((p): p is NonNullable<Capsule['periods']>[number] => PERIODS.includes(p as never)))] : [];
    const at = now();
    const capsule: Capsule = {
      id: newId('C'), rev: 1, kind: 'capsule', name, season, ...(periods.length ? { periods } : {}),
      description: str(b.description, 1200) ?? '',
      situations: Array.isArray(b.situations) ? (b.situations as string[]).map((s) => String(s).trim()).filter(Boolean).slice(0, 6) : [],
      favorite: false, lookIds: [], origin: 'owner', createdAt: at, updatedAt: at,
    };
    setAccessoryLimit(capsule, b.accessoryLimit);
    db.capsules.push(capsule);
    return capsule;
  }),
);

on('PATCH', '/api/capsules/:id', (ctx, [id], b) =>
  ctx.store.mutate((db) => {
    const c = findOr404(db.capsules, id, 'Капсула');
    bump(c, b.rev);
    pick(c, b, ['name', 'description']);
    if (!c.name) throw new HttpError(400, 'Назва не може бути порожньою');
    if (typeof b.favorite === 'boolean') rate(c, b.favorite ? 'like' : null);
    if (b.season && SEASONS.includes(b.season as never)) c.season = b.season as typeof c.season;
    if (Array.isArray(b.situations)) c.situations = (b.situations as string[]).map((s) => String(s).trim()).filter(Boolean);
    if (Array.isArray(b.lookIds)) {
      const ids: unknown[] = b.lookIds;
      if (ids.length !== c.lookIds.length || new Set(ids).size !== ids.length || ids.some((id) => typeof id !== 'string' || !c.lookIds.includes(id))) {
        throw new HttpError(400, 'Переносити образ між капсулами можна зі сторінки образу');
      }
      c.lookIds = ids as string[];
    }
    const previousLimit = c.accessoryLimit;
    setAccessoryLimit(c, b.accessoryLimit);
    if ('pieces' in b || 'base' in b) setCapsulePieces(db, c, b.pieces, b.base);
    else if (c.accessoryLimit !== previousLimit && c.pieces) {
      const error = pieceSetError(db, c.pieces, c.base ?? [], c);
      if (error) throw new HttpError(422, error);
    }
    return c;
  }),
);

/** Like / dislike / clear. Dislike hides without deleting; like ranks first. */
function rate(target: { favorite: boolean; disliked?: boolean; ratedAt?: string }, value: unknown) {
  if (value !== 'like' && value !== 'dislike' && value !== null) throw new HttpError(400, 'Оцінка: like, dislike або null');
  target.favorite = value === 'like';
  if (value === 'dislike') target.disliked = true;
  else delete target.disliked;
  target.ratedAt = now();
}

on('POST', '/api/capsules/:id/rating', async (ctx, [id], b) => {
  const out = await ctx.store.mutate((db) => {
    const c = findOr404(db.capsules, id, 'Капсула');
    rate(c, b.rating ?? null);
    bump(c, undefined);
    queueAdvice(db, `Оцінка капсули «${c.name}»: ${b.rating ?? 'знято'}`);
    return c;
  });
  ctx.drain();
  return out;
});

on('POST', '/api/looks/:id/rating', async (ctx, [id], b) => {
  const out = await ctx.store.mutate((db) => {
    const look = findOr404(db.looks, id, 'Образ');
    rate(look, b.rating ?? null);
    bump(look, undefined);
    queueAdvice(db, `Оцінка образу «${look.name}»: ${b.rating ?? 'знято'}`);
    return look;
  });
  ctx.drain();
  return out;
});

// ── Advisor (spec 2026-11-18): proposals only — the owner adds or declines ──
on('POST', '/api/suggestions/:id/accept', async (ctx, [id]) => {
  const out = await ctx.store.mutate((db) => {
    const s = findOr404(db.suggestions ?? [], id, 'Пропозиція');
    if (s.status !== 'open') throw new HttpError(409, 'Пропозицію вже розглянуто');
    // A look made meanwhile may already be this one (look memory, owner 19.11).
    if (s.looks.some((l) => db.looks.some((x) => tooClose(db, withBuys(l.slots, l.buy), x.slots)))) throw new HttpError(409, 'Вже є схожий образ');
    const accepted = acceptSuggestion(db, s);
    // New looks and the capsule's looks a purchase took a place in get their try-ons; new purchases get their picture.
    if (ctx.autoTryOn !== false) queueNewLookRenders(db, accepted.lookIds);
    queueChangedLookRenders(db, accepted.modifiedLookIds, ctx.autoTryOn);
    queueMissingNeedPackshots(db, accepted.needIds);
    queueAdvice(db, `Додано пропозицію: ${s.name}`);
    return { href: accepted.href };
  });
  ctx.drain();
  return out;
});

on('POST', '/api/suggestions/:id/reject', (ctx, [id]) =>
  ctx.store.mutate((db) => {
    const s = findOr404(db.suggestions ?? [], id, 'Пропозиція');
    if (s.status !== 'open') throw new HttpError(409, 'Пропозицію вже розглянуто');
    s.status = 'rejected';
    s.decidedAt = now();
    return s;
  }),
);

// «Порада: X → Y» on a look: «Так» swaps the piece, «Ні» never offers that swap again.
on('POST', '/api/looks/:id/advice', async (ctx, [id], b) => {
  const out = await ctx.store.mutate((db) => {
    const look = findOr404(db.looks, id, 'Образ');
    const swap = look.advice?.swap;
    if (!look.advice || !swap || look.advice.version !== look.version) throw new HttpError(409, 'Порада вже неактуальна');
    if (b.accept === true) {
      const next = cleanSlots(look.slots);
      for (const k of SLOT_KEYS) next[k] = next[k].map((r) => (r.kind === 'item' && r.id === swap.from ? { kind: 'item' as const, id: swap.to } : r));
      // The new composition gets a fresh score (it stays in «Найкращі» once rated again).
      if (setLookSlots(look, next, 'Порада порадника')) {
        assertLookFits(db, look);
        if (ctx.autoTryOn !== false && (!awaitingFirstAssembly(db, look) || assembledDraft(db, look))) queueNewLookRenders(db, [id]);
        queueAdvice(db, `Порада прийнята: ${look.name}`);
      }
    } else {
      look.advice.rejected = [...(look.advice.rejected ?? []), `${swap.from}>${swap.to}`];
    }
    delete look.advice.swap;
    bump(look, undefined);
    return look;
  });
  ctx.drain();
  return out;
});

on('POST', '/api/looks', async (ctx, _p, b) => {
  const out = await ctx.store.mutate((db) => {
    const variant = b.variant as Body | undefined;
    const source = variant ? findOr404(db.looks, str(variant.lookId) ?? '', 'Образ') : undefined;
    const capsule = requireParentCapsule(db, source ? source.capsuleId ?? undefined : str(b.capsuleId));
    let variantOf: string | undefined;
    let name = str(b.name, 120) || 'Мій образ';
    let slots = cleanSlots(b.slots);
    if (source && variant) {
      if (typeof variant.rev !== 'number') throw new HttpError(400, 'Онови сторінку образу');
      if (variant.rev !== source.rev) throw new HttpError(409, 'Запис уже змінено в іншому місці — оновіть сторінку', source);
      const slot = SLOT_KEYS.find((key) => key === variant.slot);
      const refs = slot ? cleanSlots({ [slot]: [variant.from, variant.to] })[slot] : [];
      if (!slot || refs.length !== 2) throw new HttpError(400, 'Вибери одну річ для заміни');
      const [from, to] = refs;
      const key = (ref: SlotRef) => pieceKey(normalizePiece(db, ref));
      const replacement = resolveRef(db, to);
      const oldIndex = source.slots[slot].findIndex((ref) => ref.kind === from.kind && ref.id === from.id);
      if (oldIndex < 0 || !replacement.category || !SLOT_CATEGORIES[slot].includes(replacement.category) || replacement.inactive
        || Object.values(source.slots).flat().some((ref) => key(ref) === key(to))) {
        throw new HttpError(400, 'Вибери одну річ для заміни');
      }
      if (isBlockedEyewear(db, replacement.title)) throw new HttpError(400, 'Окуляри в образи не беру');
      variantOf = lookGroup(db, source)?.primary.id ?? source.id;
      slots = { ...source.slots, [slot]: source.slots[slot].map((ref, index) => index === oldIndex ? to : ref) };
      name = replacement.title.slice(0, 120);
    }
    const duplicate = hasPieces({ slots }) && db.looks.find((look) => look.capsuleId === capsule.id && sameComposition(db, look.slots, slots));
    if (duplicate) return { look: duplicate, queuedIds: [] };
    const at = now();
    const look: Look = { id: newId('L'), rev: 1, capsuleId: capsule.id, variantOf, name, note: str(b.note), slots, version: 1, versions: [{ version: 1, slots, at }], favorite: false, origin: 'owner', createdAt: at, updatedAt: at };
    if (variantOf && typeof b.capsuleRev === 'number') addLookPieceToSet(db, look, b.capsuleRev, str(b.replaceCapsulePiece));
    db.looks.push(look);
    placeLook(db, look, capsule);
    const jobs = ctx.autoTryOn !== false ? queueNewLookRenders(db, [look.id]) : [];
    return { look, queuedIds: jobs.filter((job) => job.state === 'queued').map((job) => job.id) };
  });
  if (out.queuedIds.length && (!ctx.admit || kept(ctx, out.queuedIds).length)) ctx.drain();
  return out.look;
});

on('POST', '/api/looks/:id/primary', (ctx, [id], b) => ctx.store.mutate((db) => {
  const look = findOr404(db.looks, id, 'Образ');
  const variants = lookVariants(db, look);
  if (!variants.length) throw new HttpError(409, 'У цього образу немає варіантів');
  bump(look, b.rev);
  const family = new Set([id, ...variants.map((other) => other.id)]);
  for (const other of db.looks) {
    if (other.id === id || other.capsuleId !== look.capsuleId) continue;
    if (!family.has(other.id) && !(other.variantOf && family.has(other.variantOf))) continue;
    if (other.variantOf !== id) {
      other.variantOf = id;
      bump(other, undefined);
    }
  }
  delete look.variantOf;
  return look;
}));

on('PATCH', '/api/looks/:id', async (ctx, [id], b) => {
  const out = await ctx.store.mutate((db) => {
    const look = findOr404(db.looks, id, 'Образ');
    bump(look, b.rev);
    pick(look, b, ['name', 'note']);
    const changed = b.slots ? setLookSlots(look, cleanSlots(b.slots), str(b.versionNote)) : false;
    if ('capsuleId' in b) placeLook(db, look, requireParentCapsule(db, str(b.capsuleId)));
    else if (changed) {
      if (typeof b.capsuleRev === 'number') addLookPieceToSet(db, look, b.capsuleRev, str(b.replaceCapsulePiece));
      assertLookFits(db, look);
    }
    if (b.keptVersion === look.version) look.keptVersion = look.version;
    if (typeof b.favorite === 'boolean') rate(look, b.favorite ? 'like' : null);
    if (!look.name) throw new HttpError(400, 'Назва не може бути порожньою');
    if (changed) {
      const parentId = look.variantOf;
      if (parentId && !db.looks.some((other) => other.id !== id && other.capsuleId === look.capsuleId
        && (other.id === parentId || other.variantOf === parentId)
        && (onePieceApart(db, other.slots, look.slots) || sameVariant(db, other, look)))) {
        delete look.variantOf;
      }
      const draft = awaitingFirstAssembly(db, look);
      const ready = !draft || assembledDraft(db, look);
      if (draft && ready) {
        const duplicate = db.looks.some((other) => other.id !== id && other.capsuleId === look.capsuleId && sameComposition(db, other.slots, look.slots));
        if (duplicate) throw new HttpError(409, 'Такий образ уже є в цій капсулі');
        const capsule = db.capsules.find((other) => other.id === look.capsuleId);
        if (capsule) linkNewLookVariant(db, capsule, look);
      }
      if (ready && ctx.autoTryOn !== false) queueNewLookRenders(db, [id]);
      queueAdvice(db, `Змінено образ: ${look.name}`);
    }
    return { look, run: changed };
  });
  if (out.run) ctx.drain();
  return out.look;
});

// ── «Додати реальне фото»: references for a saved look ───────────────────────
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** The stylist may read it now: refusals (allowance, budget, AI only for the owner) leave the photos saved without a review. */
function mayReview(ctx: Ctx): string | null {
  try {
    ctx.admit?.('styling');
    return null;
  } catch (e) {
    if (e instanceof HttpError && (e.status === 429 || e.status === 403)) return e.message;
    throw e;
  }
}

/**
 * One appearance, one or more photos, one request. The same request again (the same key, or the same photos for
 * the same look version after a reload) returns the same wear and never a second review.
 */
on('POST', '/api/looks/:id/wears', async (ctx, [id], b) => {
  const key = str(b.key, 80);
  if (!key) throw new HttpError(400, 'Немає ключа запиту');
  const ids = [...new Set((Array.isArray(b.photoIds) ? b.photoIds : []).filter((x): x is string => typeof x === 'string'))];
  if (!ids.length || ids.length > MAX_WEAR_PHOTOS) throw new HttpError(400, 'Додай від 1 до 6 власних фото образу');
  const refused = mayReview(ctx);
  const out = await ctx.store.mutate((db) => {
    const look = findOr404(db.looks, id, 'Образ');
    if (!ids.every((pid) => db.photos.some((p) => p.id === pid && p.kind === 'worn' && p.source === 'upload'))) throw new HttpError(400, 'Додай власні фото образу');
    db.wears ??= [];
    let wear = db.wears.find((w) => w.key === key);
    if (wear && wear.lookId !== look.id) throw new HttpError(409, 'Цей запит уже належить іншому образу');
    if (!wear && b.lookVersion !== undefined && b.lookVersion !== look.version) throw new HttpError(409, 'Склад образу змінився. Переглянь його й додай фото ще раз.');
    wear ??= db.wears.find((w) => w.lookId === look.id && w.lookVersion === look.version && sameSet(w.photoIds, ids));
    if (!wear) {
      const render = wearRender(db, look);
      wear = { id: newWearId(), lookId: look.id, lookVersion: look.version, photoIds: ids, ...(render ? { resultId: render.id } : {}), key, createdAt: now() } satisfies Wear;
      db.wears.push(wear);
    }
    const alreadyRequested = db.jobs.some((j) => j.kind === 'wearreview' && j.wearId === wear.id);
    const job = !wear.review && !alreadyRequested && !refused ? queueWearReview(db, wear) : undefined;
    return { wear, job: job?.id };
  });
  const queued = out.job ? kept(ctx, [out.job]).length > 0 : false;
  if (queued) ctx.drain();
  return { wear: ctx.store.read().wears?.find((w) => w.id === out.wear.id) ?? out.wear, queued, note: refused ?? undefined };
});

// «Ще раз»: a review that failed is asked once more; a finished one is never repeated.
on('POST', '/api/wears/:id/review', async (ctx, [id]) => {
  const current = findOr404(ctx.store.read().wears ?? [], id, 'Образ у житті');
  if (current.review) throw new HttpError(409, 'Розбір уже є');
  if (!reviewPending(ctx.store.read(), id)) ctx.admit?.('styling');
  const job = await ctx.store.mutate((db) => {
    const wear = findOr404(db.wears ?? [], id, 'Образ у житті');
    if (reviewPending(db, wear.id)) return db.jobs.filter((j) => j.kind === 'wearreview' && j.wearId === wear.id).at(-1)!;
    return queueWearReview(db, wear);
  });
  ctx.drain();
  return job;
});

// «Одягну знову?»: the person's own answer; null clears it.
on('PATCH', '/api/wears/:id', (ctx, [id], b) =>
  ctx.store.mutate((db) => {
    const wear = findOr404(db.wears ?? [], id, 'Образ у житті');
    if (b.again === null) delete wear.again;
    else if (typeof b.again === 'boolean') wear.again = b.again;
    else throw new HttpError(400, 'Відповідь: так, ні або null');
    return wear;
  }),
);

// Removes a wear entry from its look while keeping the uploaded original photos in the archive.
on('DELETE', '/api/wears/:id', (ctx, [id]) =>
  ctx.store.mutate((db) => {
    const wear = findOr404(db.wears ?? [], id, 'Образ у житті');
    busyJob(db, (j) => j.kind === 'wearreview' && j.wearId === wear.id);
    dropJobs(db, (j) => j.kind === 'wearreview' && j.wearId === wear.id);
    db.wears = (db.wears ?? []).filter((w) => w.id !== wear.id);
    return { ok: true };
  }),
);

// ── Try-on queue ───────────────────────────────────────────────────────────
on('POST', '/api/jobs', async (ctx, _p, b) => {
  const job = await ctx.store.mutate((db) => {
    const look = findOr404(db.looks, str(b.lookId) ?? '', 'Образ');
    const pending = db.jobs.find((j) => (j.kind ?? 'tryon') === 'tryon' && j.lookId === look.id && j.lookVersion === look.version && (j.state === 'queued' || j.state === 'running'));
    if (pending) return pending;
    ctx.admit?.('tryon');
    const base = Array.isArray(b.basePhotoIds) ? (b.basePhotoIds as string[]) : db.profile.basePhotoIds;
    return createJob(db, look, base, str(b.instructions) ?? '');
  });
  if (b.run) ctx.drain();
  return job;
});

on('POST', '/api/jobs/:id/retry', async (ctx, [id], b) => {
  const earlier = ctx.store.read().jobs.find((j) => j.id === id);
  if (earlier) ctx.admit?.(quotaKind(earlier));
  const job = await ctx.store.mutate((db) => {
    const prev = findOr404(db.jobs, id, 'Завдання');
    if (prev.state === 'queued' || prev.state === 'running') throw new HttpError(409, 'Завдання ще виконується');
    if (prev.kind === 'intake' || prev.kind === 'analyze') {
      const j: Job = { id: newId('J'), kind: prev.kind, inputPhotoIds: prev.inputPhotoIds, lookVersion: 0, snapshot: prev.snapshot, instructions: [prev.instructions, str(b.instructions)].filter(Boolean).join('\n'), state: 'queued', origin: 'site', retryOf: prev.id, createdAt: now() };
      db.jobs.push(j);
      return j;
    }
    if (prev.kind === 'wearreview') {
      const wear = findOr404(db.wears ?? [], prev.wearId ?? '', 'Образ у житті');
      if (reviewPending(db, wear.id)) throw new HttpError(409, 'Завдання ще виконується');
      return queueWearReview(db, wear);
    }
    if (prev.kind === 'packshot') return packshotJob(db, { itemId: prev.itemId, needId: prev.needId }, [prev.instructions, str(b.instructions)].filter(Boolean).join('\n'), prev.id, prev.snapshot);
    const look = findOr404(db.looks, prev.lookId ?? '', 'Образ');
    const extra = str(b.instructions);
    const instructions = [prev.instructions, extra].filter(Boolean).join('\n');
    return createJob(db, look, prev.snapshot.basePhotoIds, instructions, prev.id, prev.origin === 'import' ? undefined : prev.snapshot);
  });
  if (b.run) ctx.drain();
  return job;
});

on('POST', '/api/packshots', async (ctx, _p, b) => {
  ctx.admit?.('packshot');
  const out = await ctx.store.mutate((db) => {
    const pending = new Set(db.jobs.filter((j) => j.kind === 'packshot' && (j.state === 'queued' || j.state === 'running')).map((j) => j.itemId ?? j.needId));
    const itemIds = b.all ? db.items.filter((i) => i.status !== 'inactive' && !i.packshotId).map((i) => i.id) : Array.isArray(b.itemIds) ? (b.itemIds as string[]) : [];
    const needIds = b.allNeeds ? db.needs.filter((n) => n.status === 'open' && !n.conceptPhotoId).map((n) => n.id) : Array.isArray(b.needIds) ? (b.needIds as string[]) : [];
    const jobs: Job[] = [];
    for (const id of itemIds) if (!pending.has(id)) jobs.push(packshotJob(db, { itemId: id }, str(b.instructions)));
    for (const id of needIds) if (!pending.has(id)) jobs.push(packshotJob(db, { needId: id }, str(b.instructions)));
    return { created: jobs.length, jobIds: jobs.map((j) => j.id) };
  });
  if (ctx.admit) {
    out.jobIds = kept(ctx, out.jobIds);
    out.created = out.jobIds.length;
  }
  if (b.run) ctx.drain();
  return out;
});

on('POST', '/api/analyze', async (ctx, _p, b) => {
  ctx.admit?.('styling');
  const job = await ctx.store.mutate((db) => {
    if (db.jobs.some((j) => j.kind === 'analyze' && (j.state === 'queued' || j.state === 'running'))) throw new HttpError(409, 'Аналізатор уже працює — зачекай на поточну підбірку');
    const asked = str(b.prompt, 600) ?? '';
    const required = (Array.isArray(b.itemIds) ? (b.itemIds as string[]) : []).slice(0, 4);
    const picked = required.map((id) => findOr404(db.items, id, 'Річ'));
    if (picked.some((i) => i.status === 'inactive')) throw new HttpError(400, 'Неактуальну річ не можна брати в образ');
    if (picked.some((i) => isBlockedEyewear(db, i.title))) throw new HttpError(400, 'Окуляри в образи не беру');
    const instructions = asked || (picked.length ? `Доповнити: ${picked.map((i) => i.title).join(', ')}` : `Тема: ${pickTheme(db)}`);
    const j: Job = { id: newId('J'), kind: 'analyze', requiredItemIds: picked.length ? required : undefined, lookVersion: 0, snapshot: { lookName: picked.length ? 'Доповнити образ' : 'Підбірка з моїх речей', slots: [], basePhotoIds: [], basePhotoPaths: [] }, instructions, state: 'queued', origin: 'site', createdAt: now() };
    db.jobs.push(j);
    return j;
  });
  ctx.drain();
  return job;
});

/** Queues a try-on for every look whose current composition has no render, so every look shows the owner in what it is now. */
export const queueMissingRenders = (db: DB, lookIds?: string[]) => renderLooks(db, lookIds).filter((j) => j.state === 'queued');

on('POST', '/api/renders/missing', async (ctx) => {
  ctx.admit?.('tryon');
  const jobs = await ctx.store.mutate((db) => queueMissingRenders(db));
  ctx.drain();
  return { queued: kept(ctx, jobs.map((j) => j.id)).length };
});

on('POST', '/api/runner/run', (ctx) => {
  ctx.drain();
  return { started: true };
});

const REASON_TEXT: Record<ReworkReason, string> = { face: 'обличчя не схоже', proportions: 'змінені пропорції тіла', garment: 'річ відтворена неточно', background: 'фон або кадр не за стандартом', other: 'інше' };

on('POST', '/api/results/:id/review', async (ctx, [id], b) => {
  const out = await ctx.store.mutate((db) => {
    const r = findOr404(db.results, id, 'Результат');
    const decision = str(b.decision);
    if (decision === 'accepted') {
      r.review = 'accepted';
      r.reviewReason = undefined;
    } else if (decision === 'rework') {
      const reason = str(b.reason) as ReworkReason;
      if (!REWORK_REASONS.includes(reason)) throw new HttpError(400, 'Вкажи причину переробки');
      r.review = 'rework';
      r.reviewReason = reason;
      // «Це я? — Ні»: a face the owner rejected never shows on the site again; the file stays in local history.
      if (reason === 'face') r.hiddenAt = now();
    } else if (decision === 'pending') {
      r.review = 'pending';
    } else throw new HttpError(400, 'Невідоме рішення');
    r.reviewNote = str(b.note);
    r.reviewedAt = now();
    let retry: Job | undefined;
    // A rejected face is not re-run with the same references (owner rule); a new picture is the owner's call.
    if (r.review === 'rework' && r.reviewReason !== 'face') {
      const prev = findOr404(db.jobs, r.jobId, 'Завдання');
      const look = findOr404(db.looks, prev.lookId ?? '', 'Образ');
      const fix = `Переробити: ${REASON_TEXT[r.reviewReason!]}${r.reviewNote ? ` — ${r.reviewNote}` : ''}.`;
      const base = prev.origin === 'import' || !prev.snapshot.basePhotoIds.length ? db.profile.basePhotoIds : prev.snapshot.basePhotoIds;
      retry = createJob(db, look, base, [prev.origin === 'import' ? '' : prev.instructions, fix].filter(Boolean).join('\n'), prev.id, prev.origin === 'import' || !prev.snapshot.slots.length ? undefined : prev.snapshot);
    }
    return { result: r, retry };
  });
  // Accounts: a rework beyond the month's try-ons is recorded without a new attempt.
  if (out.retry && !kept(ctx, [out.retry.id]).length) out.retry = undefined;
  if (out.retry && b.run) ctx.drain();
  return out;
});

on('PATCH', '/api/results/:id', (ctx, [id], b) =>
  ctx.store.mutate((db) => {
    const r = findOr404(db.results, id, 'Результат');
    if (typeof b.favorite === 'boolean') r.favorite = b.favorite;
    if ('note' in b) r.note = str(b.note);
    return r;
  }),
);

on('POST', '/api/comparisons', (ctx, _p, b) =>
  ctx.store.mutate((db) => {
    const a = findOr404(db.results, str(b.resultA) ?? '', 'Результат A');
    const c = findOr404(db.results, str(b.resultB) ?? '', 'Результат B');
    if (a.id === c.id) throw new HttpError(400, 'Вибери два різні результати');
    const cmp = { id: newId('X'), resultA: a.id, resultB: c.id, note: str(b.note), favorite: Boolean(b.favorite), createdAt: now() };
    db.comparisons.push(cmp);
    return cmp;
  }),
);

on('PATCH', '/api/comparisons/:id', (ctx, [id], b) =>
  ctx.store.mutate((db) => {
    const c = findOr404(db.comparisons, id, 'Порівняння');
    if ('note' in b) c.note = str(b.note);
    if (typeof b.favorite === 'boolean') c.favorite = b.favorite;
    return c;
  }),
);

// ── Shopping ───────────────────────────────────────────────────────────────
on('POST', '/api/needs', async (ctx, _p, b) => {
  const out = await ctx.store.mutate((db) => {
    const category = str(b.category) as Item['category'];
    if (!CATEGORIES.includes(category)) throw new HttpError(400, 'Вибери категорію');
    const at = now();
    const need: Need = { id: newId('N'), rev: 1, title: str(b.title, 200) || 'Нова потреба', category, priority: b.priority === 'core' ? ('core' as const) : ('optional' as const), description: str(b.description) ?? '', why: str(b.why) ?? '', fitCheck: str(b.fitCheck) ?? '', status: 'open' as const, origin: 'owner' as const, createdAt: at, updatedAt: at };
    // A purchase can be for a capsule («Для капсули: …», owner 19.11).
    const forCapsule = str(b.forCapsule);
    if (forCapsule) need.forCapsule = requireParentCapsule(db, forCapsule).id;
    db.needs.push(need);
    queueMissingNeedPackshots(db, [need.id]);
    return need;
  });
  ctx.drain();
  return out;
});

on('PATCH', '/api/needs/:id', (ctx, [id], b) =>
  ctx.store.mutate((db) => {
    const need = findOr404(db.needs, id, 'Потреба');
    bump(need, b.rev);
    pick(need, b, ['title', 'description', 'why', 'fitCheck']);
    // Cleared texts stay empty strings: prompts and the shopping list read them as text.
    for (const f of ['description', 'why', 'fitCheck'] as const) need[f] ??= '';
    if (!need.title) throw new HttpError(400, 'Назва не може бути порожньою');
    if (b.priority === 'core' || b.priority === 'optional') need.priority = b.priority;
    if (b.status === 'open' || b.status === 'covered') need.status = b.status;
    return need;
  }),
);

// «Знайти»: search the shops (the owner's place and stores, then the owner's brands) for this recommendation.
on('POST', '/api/needs/:id/search', async (ctx, [id], b) => {
  ctx.admit?.('styling');
  const job = await ctx.store.mutate((db) => {
    const need = findOr404(db.needs, id, 'Потреба');
    if (need.status !== 'open') throw new HttpError(409, 'Ця покупка вже закрита');
    if (db.jobs.some((j) => j.kind === 'shopsearch' && j.needId === id && (j.state === 'queued' || j.state === 'running'))) throw new HttpError(409, 'Пошук уже йде');
    const j: Job = { id: newId('J'), kind: 'shopsearch', needId: id, lookVersion: 0, snapshot: { lookName: need.title, slots: [], basePhotoIds: [], basePhotoPaths: [] }, instructions: str(b.instructions, 400) ?? '', state: 'queued', origin: 'site', createdAt: now() };
    db.jobs.push(j);
    return j;
  });
  ctx.drain();
  return job;
});

// "Вже маю": the owner's own item is what the recommendation asked for.
on('POST', '/api/needs/:id/cover', async (ctx, [id], b) => {
  const out = await ctx.store.mutate((db) => {
    let itemId = str(b.itemId) ?? '';
    if (b.newItem !== undefined) {
      if (itemId || !b.newItem || typeof b.newItem !== 'object' || Array.isArray(b.newItem)) throw new HttpError(400, 'Вибери наявну або додай нову річ');
      const fields = b.newItem as Body;
      const need = findOr404(db.needs, id, 'Потреба');
      if (need.status !== 'open') throw new HttpError(409, `«${need.title}» уже закрито`);
      if (!str(fields.title, 200)) throw new HttpError(400, 'Назва не може бути порожньою');
      const photoId = str(fields.photoId);
      if (photoId) {
        const photo = findOr404(db.photos, photoId, 'Фото');
        if (photo.kind !== 'item' || photo.source !== 'upload' || photo.inspiration || photo.referenceRole) throw new HttpError(400, 'Додай власне фото речі');
      }
      const item = manualItem(need.category, fields, photoId ? [photoId] : []);
      db.items.push(item);
      itemId = item.id;
    }
    const res = coverNeed(db, id, itemId, ctx.autoTryOn);
    if (b.newItem) queueMissingItemPackshots(db, [itemId]);
    retireReplaced(db, res.need, b.retire);
    queueAdvice(db, `Вже маю: ${res.need.title}`);
    return res;
  });
  ctx.drain();
  return { looks: out.looks.length, queued: out.renders.filter((j) => j.state === 'queued').length, waiting: out.renders.filter((j) => j.state === 'needs_data').length };
});

on('POST', '/api/needs/:id/uncover', async (ctx, [id]) => {
  const out = await ctx.store.mutate((db) => {
    const res = uncoverNeed(db, id, ctx.autoTryOn);
    queueAdvice(db, `Повернуто в покупки: ${res.need.title}`);
    return res;
  });
  ctx.drain();
  return { looks: out.looks.length, queued: out.renders.filter((j) => j.state === 'queued').length, waiting: out.renders.filter((j) => j.state === 'needs_data').length };
});

const PRODUCT_FIELDS = ['store', 'brand', 'model', 'sku', 'url', 'composition', 'fit', 'currency', 'recommendedSize', 'sizeBasis', 'checkedAt', 'sources'] as const;

function productNumbers(target: Record<string, unknown>, b: Body) {
  if ('price' in b) target.price = b.price === '' || b.price === null ? null : Number(String(b.price).replace(',', '.'));
  if (typeof target.price === 'number' && !Number.isFinite(target.price)) throw new HttpError(400, 'Ціна має бути числом');
  for (const k of ['onlineAvailability', 'towerAvailability'] as const) if (typeof b[k] === 'string') target[k] = b[k];
  if (target.url && !/^https?:\/\//.test(String(target.url))) throw new HttpError(400, 'URL має починатися з http(s)://');
}

on('POST', '/api/products', (ctx, _p, b) =>
  ctx.store.mutate((db) => {
    const need = findOr404(db.needs, str(b.needId) ?? '', 'Потреба');
    const at = now();
    const p = { id: newId('S'), rev: 1, needId: need.id, store: '', brand: '', model: '', onlineAvailability: 'unknown' as const, towerAvailability: 'unknown' as const, status: 'option' as const, createdAt: at, updatedAt: at };
    pick(p, b, [...PRODUCT_FIELDS] as never);
    productNumbers(p as unknown as Record<string, unknown>, b);
    if (!p.store || !p.model) throw new HttpError(400, 'Потрібні магазин і модель');
    db.products.push(p);
    return p;
  }),
);

on('PATCH', '/api/products/:id', (ctx, [id], b) =>
  ctx.store.mutate((db) => {
    const p = findOr404(db.products, id, 'Товар');
    bump(p, b.rev);
    pick(p, b, [...PRODUCT_FIELDS] as never);
    productNumbers(p as unknown as Record<string, unknown>, b);
    if (b.status === 'option' || b.status === 'chosen') p.status = b.status;
    return p;
  }),
);

on('POST', '/api/products/:id/purchase', async (ctx, [id], b) => {
  const out = await ctx.store.mutate((db) => {
    const p = findOr404(db.products, id, 'Товар');
    if (p.status === 'purchased') throw new HttpError(409, 'Товар уже позначено купленим');
    const need = findOr404(db.needs, p.needId, 'Потреба');
    if (need.status !== 'open') throw new HttpError(409, `«${need.title}» уже закрито`);
    const at = now();
    const ownPhoto = str(b.photoId);
    const photos = [p.photoId, ownPhoto].filter((x): x is string => Boolean(x) && db.photos.some((ph) => ph.id === x && ph.kind !== 'worn'));
    const item: Item = {
      id: newId('W'),
      rev: 1,
      category: need.category,
      title: `${p.brand} ${p.model}`.trim() || need.title,
      brand: p.brand || undefined,
      model: p.model || undefined,
      composition: p.composition,
      fit: p.fit,
      size: str(b.size, 40),
      status: 'confirmed',
      photoIds: photos,
      origin: 'purchase',
      purchasedFromProduct: p.id,
      confirmedFact: 'Куплено власником; фізична посадка не перевірена сайтом.',
      history: [{ at, action: 'purchased', note: `${p.store}${p.sku ? ` · ${p.sku}` : ''}` }],
      createdAt: at,
      updatedAt: at,
    };
    db.items.push(item);
    p.status = 'purchased';
    p.purchasedItemId = item.id;
    bump(p, undefined);
    need.status = 'covered';
    need.coveredByItem = item.id;
    // Every shop option of the bought need leaves the looks too, not only the one bought.
    const options = new Set(db.products.filter((x) => x.needId === need.id && (x.status !== 'purchased' || x.id === p.id)).map((x) => x.id));
    const capsules: string[] = [];
    const looks = replaceRefs(db, (r) => (r.kind === 'need' && r.id === need.id) || (r.kind === 'product' && options.has(r.id)) || (r.kind === 'item' && r.id === need.replaces), { kind: 'item', id: item.id }, `Куплено: ${item.title}`, undefined, undefined, capsules);
    need.coveredLookIds = looks;
    if (capsules.length) need.coveredCapsuleIds = [...new Set(capsules)];
    else delete need.coveredCapsuleIds;
    bump(need, undefined);
    retireReplaced(db, need, b.retire);
    queueMissingItemPackshots(db, [item.id]);
    const renders = queueChangedLookRenders(db, looks, ctx.autoTryOn);
    queueAdvice(db, `Куплено: ${item.title}`);
    return { item, renders };
  });
  ctx.drain();
  return out.item;
});

// ── Profile & settings ─────────────────────────────────────────────────────
on('PATCH', '/api/profile', (ctx, _p, b) =>
  ctx.store.mutate((db) => {
    const prof = db.profile;
    bump(prof, b.rev);
    if (b.measurements && typeof b.measurements === 'object') {
      for (const k of MEASURE_KEYS) {
        const m = (b.measurements as Record<string, { value: unknown; date?: string }>)[k];
        if (!m) continue;
        const v = m.value === '' || m.value === null || m.value === undefined ? null : Number(String(m.value).replace(',', '.'));
        if (v !== null && (!Number.isFinite(v) || v <= 0 || v > 300)) throw new HttpError(400, `Неправильне значення: ${MEASURE_UK[k]}`);
        // The date says when it was measured: an unchanged value keeps its date.
        const prev = prof.measurements[k];
        prof.measurements[k] = { value: v, date: v === null ? undefined : prev.value === v && prev.date ? prev.date : (str(m.date, 10) ?? now().slice(0, 10)) };
      }
    }
    if (Array.isArray(b.knownSizes)) {
      prof.knownSizes = (b.knownSizes as Record<string, unknown>[])
        .filter((s) => s && str(s.brand) && str(s.size) && CATEGORIES.includes(s.category as never))
        .map((s) => ({ id: str(s.id) || newId('K'), brand: str(s.brand, 80)!, category: s.category as Item['category'], size: str(s.size, 40)!, note: str(s.note) }));
    }
    if ('shoeSizeEu' in b) {
      const size = str(b.shoeSizeEu, 16);
      if (size && !/^\d{2}(?:[.,]\d{1,2}| ?[½⅓⅔]| [12]\/3)?$/.test(size)) throw new HttpError(400, 'Вкажи розмір взуття у форматі EU');
      if (size) prof.shoeSizeEu = size;
      else delete prof.shoeSizeEu;
    }
    // «Магазини» (Profile): the place to search, my stores and my brands — short, de-duplicated lists.
    const list = (v: unknown[]) => [...new Set(v.map((x) => str(x, 60)).filter((x): x is string => Boolean(x)))].slice(0, 30);
    if (Array.isArray(b.brands)) prof.brands = list(b.brands);
    if (Array.isArray(b.stores)) prof.stores = list(b.stores);
    if (typeof b.location === 'string') prof.location = str(b.location, 120) ?? '';
    // «Моє місце»: only a rounded position (≈ 1 km) is kept; null forgets it.
    if (b.coords === null) delete prof.coords;
    else if (b.coords && typeof b.coords === 'object') {
      const c = b.coords as { lat?: unknown; lon?: unknown };
      const lat = Number(c.lat);
      const lon = Number(c.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new HttpError(400, 'Неправильне місце');
      prof.coords = { lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100, at: now() };
    }
    if (b.radiusKm === null) delete prof.radiusKm;
    else if (b.radiusKm !== undefined) {
      const r = Number(b.radiusKm);
      if (!Number.isFinite(r) || r < 0 || r > 1000) throw new HttpError(400, 'Неправильна відстань');
      prof.radiusKm = Math.round(r);
    }
    if (b.preferences && typeof b.preferences === 'object') {
      const pr = b.preferences as Record<string, unknown>;
      for (const k of ['comfort', 'materials', 'fit', 'branding'] as const) if (typeof pr[k] === 'string') prof.preferences[k] = str(pr[k])!;
    }
    if (Array.isArray(b.basePhotoIds)) prof.basePhotoIds = (b.basePhotoIds as string[]).filter((id) => db.photos.some((p) => p.id === id && p.kind !== 'worn' && !p.archivedAt));
    // First sign-in and «Побажання»: language, what to dress the person in, the consent, the hemisphere.
    if (b.language !== undefined) {
      if (!LANGUAGES.includes(b.language as never)) throw new HttpError(400, 'Невідома мова');
      prof.language = b.language as Language;
    }
    if (b.wardrobeFocus !== undefined) {
      if (!WARDROBE_FOCUS.includes(b.wardrobeFocus as never)) throw new HttpError(400, 'Невідомий гардероб');
      prof.wardrobeFocus = b.wardrobeFocus as WardrobeFocus;
    }
    if (b.consent === true && !prof.consentAt) prof.consentAt = now();
    if (b.hemisphere === 'north' || b.hemisphere === 'south') prof.hemisphere = b.hemisphere;
    if (typeof b.allowEyewear === 'boolean') {
      prof.allowEyewear = b.allowEyewear;
      if (prof.identity) prof.identity.noGlasses = !b.allowEyewear;
    }
    // «Крій» / «Уникати крою»: the owner's own choice; null forgets it.
    if (b.fitProfile === null) delete prof.fitProfile;
    else if (b.fitProfile !== undefined) {
      if (typeof b.fitProfile !== 'object' || Array.isArray(b.fitProfile)) throw new HttpError(400, 'Невідомий крій');
      const raw = b.fitProfile as Body;
      // A malformed list is refused, never silently read as «no cuts».
      const cuts = (v: unknown) => v === undefined || (Array.isArray(v) && v.every((x) => typeof x === 'string' && FIT_TYPES.includes(x as FitType)));
      if (!cuts(raw.preferred) || !cuts(raw.avoid) || (raw.bodySummary !== undefined && typeof raw.bodySummary !== 'string')) throw new HttpError(400, 'Некоректний формат крою');
      const fit = cleanFit(raw.preferred ?? prof.fitProfile?.preferred, raw.avoid ?? prof.fitProfile?.avoid);
      const bodySummary = raw.bodySummary !== undefined ? String(raw.bodySummary).trim().slice(0, 240) : prof.fitProfile?.bodySummary;
      prof.fitProfile = { ...fit, ...(bodySummary ? { bodySummary } : {}), source: 'owner', updatedAt: now() };
    }
    return prof;
  }),
);

// «Визначити по фігурі»: the figure on a full-length photo (or the body crop) decides the cuts; without one, the measurements do.
on('POST', '/api/profile/analyze-fit', async (ctx) => {
  if (fitPhotoPath(ctx.store.read())) {
    ctx.admit?.('styling');
    const job = await ctx.store.mutate((db) => queueFitAnalysis(db));
    ctx.drain();
    return { job };
  }
  const profile = await ctx.store.mutate((db) => {
    const fit = suggestFitFromMeasurements(db.profile);
    if (!fit) throw new HttpError(400, 'Додай фото на повний зріст або мірки грудей і талії');
    db.profile.fitProfile = fit;
    db.profile.rev += 1;
    return db.profile;
  });
  return { profile };
});

function isProtectedIdentityPhoto(db: DB, photo: Photo) {
  const identity = db.profile.identity;
  return Boolean(identity && (identity.sourcePhotoId === photo.id || identity.original.path === photo.path
    || identity.bodyOriginal?.path === photo.path || identity.hair?.sourcePhotoId === photo.id || identity.hair?.original.path === photo.path));
}

function assertEditablePhoto(photo: Photo) {
  if (photo.kind === 'worn' || photo.source === 'generated' || photo.inspiration) throw new HttpError(409, 'Цю дію можна виконати лише з власним оригіналом поза фото образу');
}

on('PATCH', '/api/photos/:id', async (ctx, [id], b) => {
  let queued = false;
  const photo = await ctx.store.mutate((db) => {
    const p = findOr404(db.photos, id, 'Фото');
    if ('meetsStandard' in b) p.meetsStandard = b.meetsStandard === null ? null : Boolean(b.meetsStandard);
    if ('note' in b) p.note = str(b.note);
    if (b.role !== undefined) {
      assertEditablePhoto(p);
      const role = b.role;
      if (role !== 'face' && role !== 'base' && role !== 'item' && role !== 'label') throw new HttpError(400, 'Невідома роль фото');
      if ((role === 'item' || role === 'label') && isProtectedIdentityPhoto(db, p)) throw new HttpError(409, 'Фото використовується як опора зовнішності');
      p.kind = role === 'face' ? 'base' : role;
      if (role === 'face') p.referenceRole = 'face';
      else delete p.referenceRole;
      if (p.kind === 'base') {
        delete p.archivedAt;
        selectBasePhoto(db, id);
      } else {
        removeBasePhoto(db, id);
      }
    }
    if (typeof b.detachItemId === 'string') {
      const item = findOr404(db.items, b.detachItemId, 'Річ');
      if (item.photoIds.includes(id)) {
        item.photoIds = item.photoIds.filter((photoId) => photoId !== id);
        clearDetachedCrop(db, item);
        bump(item, undefined);
        history(item, 'photo_removed', p.originalName);
      }
    }
    if (typeof b.attachItemId === 'string') {
      assertEditablePhoto(p);
      const item = findOr404(db.items, b.attachItemId, 'Річ');
      delete p.archivedAt;
      const attached = attachItemPhoto(item, p);
      if (attached) clearStaleCrop(item, p);
      queued = queueMissingItemPackshots(db, [item.id]) > 0;
      if (attached && p.source !== 'generated') queued = resumeWaitingTryonsForRef(db, 'item', item.id, ctx.autoTryOn).length > 0 || queued;
    }
    if (b.archived === true) {
      if (isProtectedIdentityPhoto(db, p)) throw new HttpError(409, 'Фото використовується як опора зовнішності');
      if (db.wears?.some((wear) => wear.photoIds.includes(id))
        || db.items.some((item) => item.status !== 'inactive' && !item.mergedInto && (item.photoIds.includes(id) || item.packshotId === id))) {
        throw new HttpError(409, 'Фото використовується в гардеробі або в образі');
      }
      p.archivedAt ??= now();
      removeBasePhoto(db, id);
    }
    if (b.archived === false) delete p.archivedAt;
    return p;
  });
  if (queued) ctx.drain();
  return photo;
});

on('POST', '/api/photos/:id/reanalyze', async (ctx, [id], b) => {
  const job = await ctx.store.mutate((db) => {
    const photo = findOr404(db.photos, id, 'Фото');
    assertEditablePhoto(photo);
    if (db.jobs.some((j) => j.kind === 'intake' && j.inputPhotoIds?.includes(id) && (j.state === 'queued' || j.state === 'running'))) {
      throw new HttpError(409, 'Фото ще в обробці');
    }
    const intent = parseIntakeIntent(b.intent);
    ctx.admit?.('intake');
    delete photo.archivedAt;
    return intakeJob(db, photo, intent, str(b.note) ?? '');
  });
  ctx.drain();
  return job;
});

on('PATCH', '/api/settings', (ctx, _p, b) =>
  ctx.store.mutate((db) => {
    const s = db.settings;
    if (str(b.codexModel)) s.codexModel = str(b.codexModel, 80)!;
    if (['low', 'medium', 'high', 'xhigh'].includes(b.reasoningEffort as string)) s.reasoningEffort = b.reasoningEffort as typeof s.reasoningEffort;
    if ('tailscaleLogin' in b) s.tailscaleLogin = str(b.tailscaleLogin, 200) ?? '';
    return s;
  }),
);

// ── Delete endpoints ───────────────────────────────────────────────────────
on('DELETE', '/api/capsules/:id', (ctx, [id]) => ctx.store.mutate((db) => deleteCapsule(db, id)));

// «Капсули для тебе»: a capsule started from a catalogue style, its brief in the person's language and wardrobe.
on('POST', '/api/capsules/from-style', (ctx, _p, b) =>
  ctx.store.mutate((db) => {
    const style = STYLE_CATALOGUE.find((s) => s.id === str(b.styleId));
    if (!style) throw new HttpError(404, 'Стиль не знайдено');
    if (db.capsules.some((c) => c.name === style.name && !c.redirectCapsuleIds)) throw new HttpError(409, 'Така капсула вже є');
    const at = now();
    const capsule: Capsule = {
      id: newId('C'), rev: 1, kind: 'capsule', name: style.name, season: style.season, periods: [...style.periods],
      description: styleBrief(style, db.profile.wardrobeFocus, db.profile.language === 'en' ? 'en' : 'uk'),
      situations: [], favorite: false, lookIds: [], origin: 'owner', sourceNote: `Каталог стилів: ${style.id}`, createdAt: at, updatedAt: at,
    };
    db.capsules.push(capsule);
    return capsule;
  }),
);
on('DELETE', '/api/looks/:id', (ctx, [id]) => ctx.store.mutate((db) => deleteLook(db, id)));
on('DELETE', '/api/items/:id', async (ctx, [id]) => {
  await ctx.store.mutate((db) => {
    const changed = dropReplacementsFor(db, id);
    changed.push(...deleteItem(db, id));
    queueChangedLookRenders(db, changed, ctx.autoTryOn);
    queueAdvice(db, 'Видалено річ');
  });
  ctx.drain();
});

// «Ні» on «варто замінити»: the owner keeps and likes the item.
on('POST', '/api/items/:id/keep', async (ctx, [id]) => {
  const out = await ctx.store.mutate((db) => {
    const item = findOr404(db.items, id, 'Річ');
    queueChangedLookRenders(db, keepItem(db, item), ctx.autoTryOn);
    queueAdvice(db, `Власник залишає річ: ${item.title}`);
    return item;
  });
  ctx.drain();
  return out;
});

on('DELETE', '/api/results/:id', (ctx, [id]) =>
  ctx.store.mutate((db) => {
    const r = findOr404(db.results, id, 'Результат');
    db.comparisons = db.comparisons.filter((c) => c.resultA !== id && c.resultB !== id);
    for (const j of db.jobs) if (j.resultId === id) delete j.resultId;
    db.results = db.results.filter((x) => x.id !== r.id);
    unpinRenders(db);
  }),
);

on('DELETE', '/api/photos/:id', (ctx, [id]) =>
  ctx.store.mutate((db) => {
    const p = findOr404(db.photos, id, 'Фото');
    if (p.kind === 'source') throw new HttpError(409, 'Оригінали з чату не видаляються');
    if (p.preserveAsReference) throw new HttpError(409, 'Оригінал збережено як референс. Його можна прибрати з базових фото або речі, але не видалити з архіву.');
    if (db.jobs.some((j) => j.inputPhotoIds?.includes(id) && (j.state === 'queued' || j.state === 'running'))) throw new HttpError(409, 'Фото ще в обробці');
    for (const i of db.items) {
      if (i.photoIds.includes(id)) i.photoIds = i.photoIds.filter((x) => x !== id);
      clearDetachedCrop(db, i);
      if (i.packshotId === id) delete i.packshotId;
    }
    for (const n of db.needs) if (n.conceptPhotoId === id) delete n.conceptPhotoId;
    for (const pr of db.products) if (pr.photoId === id) delete pr.photoId;
    db.profile.basePhotoIds = db.profile.basePhotoIds.filter((x) => x !== id);
    dropJobs(db, (j) => Boolean(j.inputPhotoIds?.includes(id)) || j.photoId === id || j.snapshot.basePhotoIds.includes(id));
    db.photos = db.photos.filter((x) => x.id !== id);
  }),
);

// «Скасувати покупку»: a wrong «Куплено» tap is undone — the variant returns, the item leaves, the looks get the purchase back.
on('POST', '/api/products/:id/unpurchase', async (ctx, [id]) => {
  const out = await ctx.store.mutate((db) => {
    const p = findOr404(db.products, id, 'Товар');
    if (p.status !== 'purchased') throw new HttpError(409, 'Товар не позначено купленим');
    const item = db.items.find((i) => i.id === p.purchasedItemId);
    p.status = 'option';
    delete p.purchasedItemId;
    bump(p, undefined);
    const changed: string[] = [];
    if (item?.mergedFrom?.length) {
      // A merged item can also represent an independently owned piece or another purchase.
      const need = db.needs.find((n) => n.id === p.needId && n.coveredByItem === item.id && n.status === 'covered');
      if (need && !db.products.some((other) => other.needId === need.id && other.status === 'purchased')) changed.push(...uncoverNeed(db, need.id, false).looks);
      if (item.purchasedFromProduct === p.id) {
        const remaining = db.products.find((other) => other.purchasedItemId === item.id && other.status === 'purchased');
        if (remaining) item.purchasedFromProduct = remaining.id;
        else delete item.purchasedFromProduct;
        bump(item, undefined);
      }
    } else if (item) changed.push(...deleteItem(db, item.id));
    queueChangedLookRenders(db, changed, ctx.autoTryOn);
    queueAdvice(db, `Скасовано покупку: ${p.model}`);
    return p;
  });
  ctx.drain();
  return out;
});

// ── Identity setup & step-by-step onboarding (human-in-the-loop) ───────────
on('POST', '/api/identity/prepare', async (ctx, _p, b) => {
  ctx.admit?.('tryon');
  const job = await ctx.store.mutate((db) =>
    queueIdentityPrep(db, {
      facePhotoId: str(b.facePhotoId) ?? '',
      bodyPhotoId: str(b.bodyPhotoId) ?? '',
      noGlasses: typeof b.noGlasses === 'boolean' ? b.noGlasses : undefined,
      hairstyle: str(b.hairstyle, 200),
      instructions: str(b.instructions, 400),
    }),
  );
  ctx.drain();
  return job;
});

on('POST', '/api/identity/approve', (ctx) =>
  ctx.store.mutate((db) => approveIdentityDraft(db, ctx.projectRoot, ctx.store.dataDir)),
);

on('DELETE', '/api/identity/draft', (ctx) =>
  ctx.store.mutate((db) => {
    if (db.onboarding) delete db.onboarding.identityDraft;
    return { ok: true };
  }),
);

on('POST', '/api/onboarding/plan-capsules', async (ctx, _p, b) => {
  ctx.admit?.('styling');
  const job = await ctx.store.mutate((db) => queueCapsulePlan(db, str(b.prompt, 800) ?? ''));
  ctx.drain();
  return job;
});

on('POST', '/api/onboarding/approve-capsules', (ctx, _p, b) =>
  ctx.store.mutate((db) => approveCapsules(db, Array.isArray(b.capsules) ? (b.capsules as never) : [])),
);

on('POST', '/api/onboarding/match-capsules', async (ctx, _p, b) => {
  ctx.admit?.('styling');
  const capsuleIds = Array.isArray(b.capsuleIds) ? (b.capsuleIds as string[]).filter((x) => typeof x === 'string') : undefined;
  const job = await ctx.store.mutate((db) => queueCapsuleMatch(db, capsuleIds));
  ctx.drain();
  return job;
});

on('POST', '/api/onboarding/approve-sets', async (ctx, _p, b) => {
  const out = await ctx.store.mutate((db) => {
    const res = approveSets(db, Array.isArray(b.sets) ? (b.sets as ApprovedSetInput[]) : []);
    queueMissingNeedPackshots(db, res.needIds);
    return res;
  });
  ctx.drain();
  return out;
});

on('PATCH', '/api/onboarding', (ctx, _p, b) =>
  ctx.store.mutate((db) => {
    db.onboarding ??= {};
    if (typeof b.step === 'number' && [1, 2, 3, 4, 5].includes(b.step)) db.onboarding.step = b.step as 1 | 2 | 3 | 4 | 5;
    if (b.complete === true) db.onboarding.completedAt = now();
    if (b.complete === false) delete db.onboarding.completedAt;
    return db.onboarding;
  }),
);

// «Нові» (owner, 19.11): one search for new looks — the owner's words, a capsule and picked pieces are optional.
on('POST', '/api/discover', async (ctx, _p, b) => {
  ctx.admit?.('styling');
  const job = await ctx.store.mutate((db) => queueDiscover(db, { prompt: str(b.prompt, 400), capsuleId: str(b.capsuleId), itemIds: Array.isArray(b.itemIds) ? (b.itemIds as string[]) : [] }));
  ctx.drain();
  return job;
});

// «Магазини» (owner, 19.11): one web search for the shops whose nearest store is not known yet.
on('POST', '/api/stores/find', async (ctx) => {
  ctx.admit?.('styling');
  const job = await ctx.store.mutate((db) => queueStoreFind(db));
  ctx.drain();
  return { queued: Boolean(job && kept(ctx, [job.id]).length) };
});

on('DELETE', '/api/products/:id', (ctx, [id]) =>
  ctx.store.mutate((db) => {
    const p = findOr404(db.products, id, 'Товар');
    if (p.status === 'purchased') throw new HttpError(409, 'Куплений товар уже в гардеробі — скасуй покупку (✎ → «Скасувати покупку»)');
    const need = db.needs.find((n) => n.id === p.needId);
    if (need && p.url) need.droppedUrls = [...new Set([...(need.droppedUrls ?? []), p.url])].slice(-30);
    if (need) need.droppedModels = [...new Set([...(need.droppedModels ?? []), productKey(p.store, `${p.brand ?? ''} ${p.model}`)])].slice(-30);
    stripRefs(db, 'product', id);
    db.products = db.products.filter((x) => x.id !== id);
  }),
);

on('DELETE', '/api/needs/:id', (ctx, [id]) =>
  ctx.store.mutate((db) => {
    const need = findOr404(db.needs, id, 'Потреба');
    if (db.products.some((p) => p.needId === id && p.status === 'purchased')) throw new HttpError(409, 'За цією потребою вже є покупка');
    // Declining a replacement keeps the item: the advisor does not suggest replacing it again.
    const kept = need.replaces ? db.items.find((i) => i.id === need.replaces) : undefined;
    if (kept?.rating) kept.rating.kept = true;
    rememberDeclined(db, need);
    for (const p of db.products.filter((x) => x.needId === id)) stripRefs(db, 'product', p.id);
    db.products = db.products.filter((p) => p.needId !== id);
    stripRefs(db, 'need', id);
    busyJob(db, (j) => j.needId === id);
    dropJobs(db, (j) => j.needId === id);
    db.needs = db.needs.filter((n) => n.id !== id);
  }),
);

on('DELETE', '/api/jobs/:id', (ctx, [id]) =>
  ctx.store.mutate((db) => {
    const j = findOr404(db.jobs, id, 'Завдання');
    if (j.state === 'running') throw new HttpError(409, 'Завдання виконується');
    dropJobs(db, (x) => x.id === id);
  }),
);

export function decodeParam(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch (error) {
    if (error instanceof URIError) throw new HttpError(400, 'Некоректний запит');
    throw error;
  }
}

export async function dispatch(ctx: Ctx, method: string, pathname: string, body: Body) {
  for (const [m, re, h] of routes) {
    if (m !== method) continue;
    const match = pathname.match(re);
    if (match) return h(ctx, match.slice(1).map(decodeParam), body);
  }
  throw new HttpError(404, 'Маршрут не знайдено');
}

export { SLOT_TEXT };
