import path from 'node:path';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type { Capsule, DB, Item, Job, Look, Need, Photo, PhotoKind, ReworkReason, SlotKey, SlotRef, Slots, SnapshotSlot, Language, WardrobeFocus, Wear } from './schema.ts';
import { CATEGORIES, ITEM_STATUSES, LANGUAGES, MEASURE_KEYS, PHOTO_KINDS, REWORK_REASONS, SEASONS, SLOT_KEYS, WARDROBE_FOCUS } from './schema.ts';
import type { Store } from './store.ts';
import { HttpError, bump, findOr404, newId, now } from './store.ts';
import { folderBytesAsync, prewarm, saveUpload, type StorageLimits } from './media.ts';
import { pickTheme } from './analysis.ts';
import { acceptSuggestion, dropReplacementsFor, keepItem, queueAdvice, rememberDeclined } from './advisor.ts';
import { looksNeedingRender } from '../src/render-need.ts';
import { isBlockedEyewear } from '../src/lib.ts';
import { productKey, queueStoreFind } from './shop-search.ts';
import { quotaKind, type QuotaKind } from './quota.ts';
import { STYLE_CATALOGUE, styleBrief } from '../src/style-catalogue.ts';
import { tooClose, withBuys } from '../src/look-memory.ts';
import { queueDiscover } from './discover.ts';
import { sameIdentity } from './identity.ts';
import { assertLookFits, placeLook, replaceInSets, requireParentCapsule, setCapsulePieces, stripFromSets } from './capsule-membership.ts';
import { MAX_WEAR_PHOTOS, newWearId, queueWearReview, reviewPending, wearRender } from './wear-review.ts';

type Body = Record<string, unknown>;
export interface Ctx {
  store: Store;
  projectRoot: string;
  drain: () => void;
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

/** Freezes the exact selection, photos and texts at queue time. */
export function snapshotSlots(db: DB, slots: Slots): SnapshotSlot[] {
  const out: SnapshotSlot[] = [];
  for (const slot of SLOT_KEYS) {
    for (const ref of slots[slot]) {
      if (ref.kind === 'item') {
        const item = findOr404(db.items, ref.id, 'Річ');
        const usable = item.photoIds.map((pid) => findOr404(db.photos, pid, 'Фото'))
          .filter((p) => !p.inspiration && p.kind !== 'label' && p.referenceRole !== 'face');
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
        out.push({ slot, kind: 'need', id: need.id, title: need.title, description: need.description, owned: false, photoPaths: [] });
      } else {
        const p = findOr404(db.products, ref.id, 'Товар');
        const photo = p.photoId ? findOr404(db.photos, p.photoId, 'Фото') : undefined;
        const originals = photo?.kind === 'product' && !photo.inspiration ? [photo.path] : [];
        out.push({ slot, kind: 'product', id: p.id, title: `${p.brand} ${p.model}`.trim(), description: [p.composition, p.fit].filter(Boolean).join(', '), owned: false, photoPaths: [], originalPhotoPaths: originals });
      }
    }
  }
  return out;
}

export function createJob(db: DB, look: Look, basePhotoIds: string[], instructions: string, retryOf?: string, frozen?: Job['snapshot']): Job {
  const identity = db.profile.identity;
  const selectedIds = identity ? [identity.sourcePhotoId] : basePhotoIds;
  const basePaths = identity ? [identity.face.path, identity.body.path, ...(identity.hair ? [identity.hair.crop.path] : [])] : selectedIds.map((id) => findOr404(db.photos, id, 'Базове фото').path);
  const snapshot = structuredClone(frozen ?? { lookName: look.name, slots: snapshotSlots(db, look.slots), basePhotoIds: selectedIds, basePhotoPaths: basePaths, identity });
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
    .filter((photo) => !photo.inspiration && photo.referenceRole !== 'face' && !['label', 'packshot', 'worn'].includes(photo.kind));
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
    snapshot = { lookName: need.title, slots: [{ slot: ITEM_SLOT[need.category], kind: 'need', id: need.id, title: need.title, description: need.description, owned: false, photoPaths: [] }], basePhotoIds: [], basePhotoPaths: [] };
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
    if (!item || item.status === 'inactive' || item.mergedInto || item.packshotId || activeIds.has(id) || !packshotSources(db, item).length) continue;
    packshotJob(db, { itemId: id });
    queued += 1;
  }
  return queued;
}

function replaceRefs(db: DB, match: (r: SlotRef) => boolean, replacement: SlotRef, note: string, onlyLooks?: Set<string>) {
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
  replaceInSets(db, match, replacement, onlyLooks ? new Set(db.capsules.filter((c) => c.lookIds.some((id) => changedLooks.includes(id))).map((c) => c.id)) : undefined);
  return changedLooks;
}

/**
 * Try-ons for looks whose current composition has none and none on the way
 * (hidden looks excepted). While generation is paused a job waits with the
 * reason instead of running; once the pause is lifted the look counts as
 * missing again, so "Оновити примірки" picks it up.
 */
function renderLooks(db: DB, lookIds?: string[]) {
  if (!db.profile.basePhotoIds.length) return [] as Job[];
  return looksNeedingRender(db)
    .filter((l) => !lookIds || lookIds.includes(l.id))
    .map((l) => {
      // Only the newest composition is worth making: older attempts that never started are dropped.
      dropJobs(db, (j) => (j.kind ?? 'tryon') === 'tryon' && j.lookId === l.id && j.state === 'queued' && j.lookVersion !== l.version);
      return createJob(db, l, db.profile.basePhotoIds, '');
    });
}

/** A changed composition gets a fresh try-on; returns waiting jobs too. */
export const queueRerenders = (db: DB, lookIds: string[]) => renderLooks(db, lookIds);

/**
 * The owner already has what a recommendation asked for: the need leaves the
 * shopping list, its stand-ins in looks become the owner's item, and those
 * looks get fresh try-ons. Undone with uncoverNeed.
 */
export function coverNeed(db: DB, needId: string, itemId: string) {
  const need = findOr404(db.needs, needId, 'Потреба');
  const item = findOr404(db.items, itemId, 'Річ');
  if (need.status !== 'open') throw new HttpError(409, `«${need.title}» уже закрито`);
  if (item.category !== need.category) throw new HttpError(400, 'Річ іншої категорії, ніж рекомендація');
  if (item.status === 'inactive' || item.mergedInto) throw new HttpError(400, 'Неактуальна річ не закриває покупку');
  if (item.id === need.replaces) throw new HttpError(409, 'Це та сама річ, яку покупка має замінити');
  const options = new Set(db.products.filter((p) => p.needId === need.id && p.status !== 'purchased').map((p) => p.id));
  const looks = replaceRefs(db, (r) => (r.kind === 'need' && r.id === need.id) || (r.kind === 'product' && options.has(r.id)) || (r.kind === 'item' && r.id === need.replaces), { kind: 'item', id: item.id }, `Своя річ замість «${need.title}»`);
  need.status = 'covered';
  need.coveredByItem = item.id;
  need.coveredLookIds = looks;
  bump(need, undefined);
  history(item, 'covers_need', `${need.id} · ${need.title}`);
  bump(item, undefined);
  // The picture is updated only when the owner asks (look page: «Оновити»).
  return { need, looks, renders: [] as Job[] };
}

/** Puts a recommendation back on the shopping list and its stand-in back into the looks it was replaced in. */
export function uncoverNeed(db: DB, needId: string) {
  const need = findOr404(db.needs, needId, 'Потреба');
  if (need.status !== 'covered') throw new HttpError(409, `«${need.title}» і так у покупках`);
  if (db.products.some((p) => p.needId === need.id && p.status === 'purchased')) throw new HttpError(409, 'Закрито покупкою — це запис покупки, не збіг із фото');
  const itemId = need.coveredByItem;
  restoreRetired(db, need);
  // A replacement purchase gives its looks the old item back; any other gets its stand-in back.
  const old = need.replaces ? db.items.find((i) => i.id === need.replaces && i.status !== 'inactive' && !i.mergedInto) : undefined;
  const looks = itemId ? replaceRefs(db, (r) => r.kind === 'item' && r.id === itemId, old ? { kind: 'item', id: old.id } : { kind: 'need', id: need.id }, `Повернуто в покупки: «${need.title}»`, new Set(need.coveredLookIds ?? [])) : [];
  need.status = 'open';
  delete need.coveredByItem;
  delete need.coveredLookIds;
  bump(need, undefined);
  const item = itemId ? db.items.find((i) => i.id === itemId) : undefined;
  if (item) {
    history(item, 'uncovers_need', `${need.id} · ${need.title}`);
    bump(item, undefined);
  }
  return { need, looks, renders: [] as Job[] };
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

export async function upload(ctx: Ctx, query: URLSearchParams, buf: Buffer, filename: string) {
  const intake = query.get('kind') === 'intake';
  const kind = (intake ? 'item' : (query.get('kind') ?? 'item')) as PhotoKind;
  if (!PHOTO_KINDS.includes(kind) || kind === 'source' || kind === 'packshot') throw new HttpError(400, 'Невідомий тип фото');
  // A photo of a worn look is kept once: the same file chosen again (a retry after a reload) is the same photo.
  const worn = kind === 'worn';
  const sha256 = worn ? createHash('sha256').update(buf).digest('hex') : undefined;
  const known = (db: DB) => (worn ? db.photos.find((p) => p.kind === 'worn' && p.sha256 === sha256) : undefined);
  const existing = known(ctx.store.read());
  if (existing) return existing;
  if (ctx.limits) await checkStorage(ctx, ctx.limits, buf.length);
  if (intake) ctx.admit?.('intake');
  const id = newId('P');
  const saved = await saveUpload(ctx.projectRoot, ctx.store.dataDir, id, buf);
  prewarm(ctx.projectRoot, ctx.store.dataDir, [saved.path]);
  // A worn photo is never a garment or product source.
  const itemId = worn ? null : query.get('item');
  const productId = worn ? null : query.get('product');
  let queuedPackshot = false;
  let duplicate = false;
  return ctx.store.mutate((db) => {
    const same = known(db);
    if (same) {
      duplicate = true;
      return same;
    }
    const photo: Photo = { id, kind, path: saved.path, originalPath: saved.originalPath, originalName: path.basename(filename || 'upload').slice(0, 200), source: 'upload', preserveAsReference: true, meetsStandard: kind === 'base' ? null : undefined, ...(sha256 ? { sha256 } : {}), createdAt: now() };
    db.photos.push(photo);
    if (kind === 'base') {
      db.profile.basePhotoIds.push(id);
      db.profile.rev += 1;
    }
    if (itemId) {
      const item = findOr404(db.items, itemId, 'Річ');
      item.photoIds.push(id);
      bump(item, undefined);
      history(item, 'photo_added', `${kind}: ${photo.originalName}`);
      if (!intake && kind === 'item') queuedPackshot = queueMissingItemPackshots(db, [itemId]) > 0;
    }
    if (productId) {
      const p = findOr404(db.products, productId, 'Товар');
      p.photoId = id;
      bump(p, undefined);
    }
    if (intake) {
      db.jobs.push({ id: newId('J'), kind: 'intake', inputPhotoIds: [id], lookVersion: 0, snapshot: { lookName: photo.originalName, slots: [], basePhotoIds: [], basePhotoPaths: [] }, instructions: str(query.get('note')) ?? '', state: 'queued', origin: 'site', createdAt: now() });
    }
    return photo;
  }).then((photo) => {
    // Two requests with the same file at once: the second copy on disk is dropped.
    if (duplicate) for (const rel of [saved.path, saved.originalPath]) if (rel) fs.rmSync(path.join(ctx.projectRoot, rel), { force: true });
    if ((intake || queuedPackshot) && query.get('run') !== '0') ctx.drain();
    return photo;
  });
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
  db.looks = db.looks.filter((l) => l.id !== id);
}

export function deleteCapsule(db: DB, id: string) {
  const c = findOr404(db.capsules, id, 'Капсула');
  for (const l of db.looks.filter((look) => look.capsuleId === id)) deleteLook(db, l.id);
  for (const other of db.capsules) {
    if (other.redirectCapsuleIds?.includes(id)) other.redirectCapsuleIds = other.redirectCapsuleIds.filter((target) => target !== id);
  }
  for (const j of db.jobs) if (j.capsuleId === id) delete j.capsuleId;
  db.capsules = db.capsules.filter((x) => x.id !== id);
}

function stripRefs(db: DB, kind: SlotRef['kind'], id: string) {
  stripFromSets(db, kind, id);
  for (const look of db.looks) {
    const next = cleanSlots(look.slots);
    for (const k of SLOT_KEYS) next[k] = next[k].filter((r) => !(r.kind === kind && r.id === id));
    if (setLookSlots(look, next, 'Видалено річ зі складу')) {
      look.rev += 1;
      look.updatedAt = now();
    }
  }
}

export function deleteItem(db: DB, id: string) {
  const item = findOr404(db.items, id, 'Річ');
  if (db.products.some((p) => p.purchasedItemId === id)) throw new HttpError(409, 'Річ створена покупкою — скасуй покупку в «Покупках» (✎ → «Скасувати покупку»)');
  busyJob(db, (j) => j.itemId === id);
  // A deleted item no longer covers a recommendation: its looks get the stand-in back.
  for (const n of db.needs) if (n.coveredByItem === id && n.status === 'covered') uncoverNeed(db, n.id);
  stripRefs(db, 'item', id);
  dropJobs(db, (j) => j.kind === 'packshot' && j.itemId === id);
  if (item.packshotId) db.photos = db.photos.filter((p) => p.id !== item.packshotId);
  for (const j of db.jobs) {
    if (j.createdItemIds?.includes(id)) j.createdItemIds = j.createdItemIds.filter((x) => x !== id);
    if (j.attachedItemIds?.includes(id)) j.attachedItemIds = j.attachedItemIds.filter((x) => x !== id);
    if (j.requiredItemIds?.includes(id)) j.requiredItemIds = j.requiredItemIds.filter((x) => x !== id);
  }
  for (const n of db.needs) if (n.coveredByItem === id) {
    delete n.coveredByItem;
    n.status = 'open';
  }
  db.items = db.items.filter((i) => i.id !== id);
}

const MEASURE_UK: Record<(typeof MEASURE_KEYS)[number], string> = { height: 'зріст', chest: 'груди', waist: 'талія', hips: 'стегна', shoulders: 'плечі', sleeve: 'довжина рукава', inseam: 'внутрішній шов', foot: 'довжина стопи' };

type Handler = (ctx: Ctx, params: string[], body: Body) => unknown;
const routes: [string, RegExp, Handler][] = [];
const on = (method: string, pattern: string, h: Handler) => routes.push([method, new RegExp(`^${pattern.replace(/:\w+/g, '([^/]+)')}$`), h]);

// ── Wardrobe ───────────────────────────────────────────────────────────────
function clearDetachedCrop(db: DB, item: Item) {
  if (item.tryonReference && !item.photoIds.some((id) => db.photos.some((p) => p.id === id && p.path === item.tryonReference!.source.path))) delete item.tryonReference;
}

on('POST', '/api/items', async (ctx, _p, b) => {
  const out = await ctx.store.mutate((db) => {
    const category = str(b.category) as Item['category'];
    if (!CATEGORIES.includes(category)) throw new HttpError(400, 'Вибери категорію');
    const at = now();
    const item: Item = { id: newId('W'), rev: 1, category, title: str(b.title, 200) || 'Нова річ', status: 'confirmed', photoIds: [], origin: 'manual', history: [{ at, action: 'created', note: 'Додано власником' }], createdAt: at, updatedAt: at };
    pick(item, b, ['color', 'brand', 'model', 'composition', 'fit', 'size']);
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
    if (b.category && CATEGORIES.includes(b.category as never)) item.category = b.category as Item['category'];
    if (b.status && ITEM_STATUSES.includes(b.status as never)) item.status = b.status as Item['status'];
    // «Це моя річ? — Ні»: a rejected item no longer covers a recommendation; its looks get the stand-in back.
    if (item.status === 'inactive' && before !== 'inactive') for (const n of db.needs) if (n.coveredByItem === item.id && n.status === 'covered' && !db.products.some((p) => p.needId === n.id && p.status === 'purchased')) uncoverNeed(db, n.id);
    if (Array.isArray(b.photoIds)) item.photoIds = (b.photoIds as string[]).filter((pid) => db.photos.some((p) => p.id === pid && p.kind !== 'worn'));
    clearDetachedCrop(db, item);
    if (!item.title) throw new HttpError(400, 'Назва не може бути порожньою');
    history(item, before !== item.status ? `status:${item.status}` : 'edited');
    if (item.status === 'inactive') dropReplacementsFor(db, item.id);
    queueAdvice(db, `Змінено річ: ${item.title}`);
    return item;
  });
  ctx.drain();
  return out;
});

on('POST', '/api/items/merge', async (ctx, _p, b) => {
  const out = await ctx.store.mutate((db) => {
    const ids = Array.isArray(b.ids) ? (b.ids as string[]) : [];
    if (ids.length < 2) throw new HttpError(400, 'Для обʼєднання потрібно щонайменше дві речі');
    const sources = ids.map((id) => findOr404(db.items, id, 'Річ'));
    const at = now();
    const merged: Item = {
      id: newId('W'),
      rev: 1,
      category: sources[0].category,
      title: str(b.title, 200) || sources[0].title,
      // Merging items the owner already confirmed does not ask «Це моя річ?» again.
      status: sources.every((s) => s.status === 'confirmed') ? 'confirmed' : 'needs_confirmation',
      photoIds: [...new Set(sources.flatMap((s) => s.photoIds))],
      observation: sources.map((s) => `${s.id}: ${s.observation ?? ''}`).join(' · '),
      confirmedFact: sources.map((s) => s.confirmedFact).filter(Boolean).join(' ') || undefined,
      origin: 'merge',
      mergedFrom: ids,
      history: [{ at, action: 'merged', note: `Обʼєднано з ${ids.join(', ')}` }],
      createdAt: at,
      updatedAt: at,
    };
    // «Ні» on «варто замінити» survives a merge: the merged piece is rated again, still kept.
    const kept = sources.find((x) => x.rating?.kept)?.rating;
    if (kept) merged.rating = { ...kept, replace: undefined, replaceWith: undefined, rev: -1, kept: true };
    db.items.push(merged);
    for (const s of sources) {
      s.status = 'inactive';
      s.mergedInto = merged.id;
      bump(s, undefined);
      history(s, 'merged_into', merged.id);
    }
    replaceRefs(db, (r) => r.kind === 'item' && ids.includes(r.id), { kind: 'item', id: merged.id }, `Обʼєднання речей → ${merged.id}`);
    for (const n of db.needs) if (n.coveredByItem && ids.includes(n.coveredByItem)) n.coveredByItem = merged.id;
    for (const id of ids) dropReplacementsFor(db, id);
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
    const part: Item = { id: newId('W'), rev: 1, category: item.category, title: str(b.title, 200) || `${item.title} (окрема)`, status: 'needs_confirmation', photoIds, observation: item.observation, origin: 'split', splitFrom: item.id, history: [{ at, action: 'split', note: `Відокремлено від ${item.id}` }], createdAt: at, updatedAt: at };
    item.photoIds = item.photoIds.filter((p) => !photoIds.includes(p));
    clearDetachedCrop(db, item);
    bump(item, b.rev);
    history(item, 'split', `Фото ${photoIds.join(', ')} → ${part.id}`);
    db.items.push(part);
    return part;
  }),
);

// ── Capsules & looks ───────────────────────────────────────────────────────
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
    // The capsule's closed set (owner, 20.11): up to 10 garments, 3 shoes, 3 accessories; null clears it.
    if ('pieces' in b || 'base' in b) setCapsulePieces(db, c, b.pieces, b.base);
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
    const href = acceptSuggestion(db, s);
    queueAdvice(db, `Додано пропозицію: ${s.name}`);
    return { href };
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

on('POST', '/api/looks', (ctx, _p, b) =>
  ctx.store.mutate((db) => {
    const capsule = requireParentCapsule(db, str(b.capsuleId));
    const slots = cleanSlots(b.slots);
    const at = now();
    const look: Look = { id: newId('L'), rev: 1, capsuleId: capsule.id, name: str(b.name, 120) || 'Мій образ', note: str(b.note), slots, version: 1, versions: [{ version: 1, slots, at }], favorite: false, origin: 'owner', createdAt: at, updatedAt: at };
    db.looks.push(look);
    placeLook(db, look, capsule);
    return look;
  }),
);

on('PATCH', '/api/looks/:id', async (ctx, [id], b) => {
  const out = await ctx.store.mutate((db) => {
    const look = findOr404(db.looks, id, 'Образ');
    bump(look, b.rev);
    pick(look, b, ['name', 'note']);
    // A changed composition is rated again (never re-rendered by itself: the look page offers «Оновити», owner 17.11).
    const changed = b.slots ? setLookSlots(look, cleanSlots(b.slots), str(b.versionNote)) : false;
    if ('capsuleId' in b) placeLook(db, look, requireParentCapsule(db, str(b.capsuleId)));
    else if (changed) assertLookFits(db, look);
    if (b.keptVersion === look.version) look.keptVersion = look.version;
    if (typeof b.favorite === 'boolean') rate(look, b.favorite ? 'like' : null);
    if (!look.name) throw new HttpError(400, 'Назва не може бути порожньою');
    if (changed) queueAdvice(db, `Змінено образ: ${look.name}`);
    return { look, run: changed };
  });
  if (out.run) ctx.drain();
  return out.look;
});

// ── «Додати мій образ»: real photos of a saved look ─────────────────────────
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
  ctx.admit?.('tryon');
  const job = await ctx.store.mutate((db) => {
    const look = findOr404(db.looks, str(b.lookId) ?? '', 'Образ');
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
on('POST', '/api/needs', (ctx, _p, b) =>
  ctx.store.mutate((db) => {
    const category = str(b.category) as Item['category'];
    if (!CATEGORIES.includes(category)) throw new HttpError(400, 'Вибери категорію');
    const at = now();
    const need: Need = { id: newId('N'), rev: 1, title: str(b.title, 200) || 'Нова потреба', category, priority: b.priority === 'core' ? ('core' as const) : ('optional' as const), description: str(b.description) ?? '', why: str(b.why) ?? '', fitCheck: str(b.fitCheck) ?? '', status: 'open' as const, origin: 'owner' as const, createdAt: at, updatedAt: at };
    // A purchase can be for a capsule («Для капсули: …», owner 19.11).
    const forCapsule = str(b.forCapsule);
    if (forCapsule) need.forCapsule = requireParentCapsule(db, forCapsule).id;
    db.needs.push(need);
    return need;
  }),
);

on('PATCH', '/api/needs/:id', (ctx, [id], b) =>
  ctx.store.mutate((db) => {
    const need = findOr404(db.needs, id, 'Потреба');
    bump(need, b.rev);
    pick(need, b, ['title', 'description', 'why', 'fitCheck']);
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
    const res = coverNeed(db, id, str(b.itemId) ?? '');
    retireReplaced(db, res.need, b.retire);
    queueAdvice(db, `Вже маю: ${res.need.title}`);
    return res;
  });
  ctx.drain();
  return { looks: out.looks.length, queued: out.renders.filter((j) => j.state === 'queued').length, waiting: out.renders.filter((j) => j.state === 'needs_data').length };
});

on('POST', '/api/needs/:id/uncover', async (ctx, [id]) => {
  const out = await ctx.store.mutate((db) => {
    const res = uncoverNeed(db, id);
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
    const looks = replaceRefs(db, (r) => (r.kind === 'need' && r.id === need.id) || (r.kind === 'product' && options.has(r.id)) || (r.kind === 'item' && r.id === need.replaces), { kind: 'item', id: item.id }, `Куплено: ${item.title}`);
    need.coveredLookIds = looks;
    bump(need, undefined);
    retireReplaced(db, need, b.retire);
    queueMissingItemPackshots(db, [item.id]);
    queueAdvice(db, `Куплено: ${item.title}`);
    // The look pages offer «Оновити» for the changed pictures.
    return { item, renders: [] as Job[] };
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
        .filter((s) => str(s.brand) && str(s.size) && CATEGORIES.includes(s.category as never))
        .map((s) => ({ id: str(s.id) || newId('K'), brand: str(s.brand, 80)!, category: s.category as Item['category'], size: str(s.size, 40)!, note: str(s.note) }));
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
    if (Array.isArray(b.basePhotoIds)) prof.basePhotoIds = (b.basePhotoIds as string[]).filter((id) => db.photos.some((p) => p.id === id && p.kind !== 'worn'));
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
    if (typeof b.allowEyewear === 'boolean') prof.allowEyewear = b.allowEyewear;
    return prof;
  }),
);

on('PATCH', '/api/photos/:id', (ctx, [id], b) =>
  ctx.store.mutate((db) => {
    const p = findOr404(db.photos, id, 'Фото');
    if ('meetsStandard' in b) p.meetsStandard = b.meetsStandard === null ? null : Boolean(b.meetsStandard);
    if ('note' in b) p.note = str(b.note);
    return p;
  }),
);

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
    dropReplacementsFor(db, id);
    deleteItem(db, id);
    queueAdvice(db, 'Видалено річ');
  });
  ctx.drain();
});

// «Ні» on «варто замінити»: the owner keeps and likes the item.
on('POST', '/api/items/:id/keep', async (ctx, [id]) => {
  const out = await ctx.store.mutate((db) => {
    const item = findOr404(db.items, id, 'Річ');
    keepItem(db, item);
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
    const itemId = p.purchasedItemId;
    p.status = 'option';
    delete p.purchasedItemId;
    bump(p, undefined);
    if (itemId && db.items.some((i) => i.id === itemId)) deleteItem(db, itemId);
    queueAdvice(db, `Скасовано покупку: ${p.model}`);
    return p;
  });
  ctx.drain();
  return out;
});

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

export async function dispatch(ctx: Ctx, method: string, pathname: string, body: Body) {
  for (const [m, re, h] of routes) {
    if (m !== method) continue;
    const match = pathname.match(re);
    if (match) return h(ctx, match.slice(1).map(decodeURIComponent), body);
  }
  throw new HttpError(404, 'Маршрут не знайдено');
}

export { SLOT_TEXT };
