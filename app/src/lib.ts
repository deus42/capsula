import type { Capsule, Category, DB, Item, Job, Look, MeasureKey, Need, Period, Result, Season, SlotKey, SlotRef, Wear } from './api.ts';
import { hiddenLookIds, isCapsuleHidden } from './rating.ts';
import { groupLookVariations } from './look-variation.ts';
import { tooClose, withBuys } from './look-memory.ts';
import { buysFitSet, capsulePieceRefs, combinationGains, fashionCapsules, inSavedSet } from './capsule-pieces.ts';
import { LOOKS, currentLanguage, plural, t } from './i18n.ts';

export const CATEGORY_LABEL: Record<Category, string> = {
  outerwear: 'Верхній одяг',
  knitwear: 'Худі й трикотаж',
  shirts: 'Сорочки й поло',
  tees: 'Футболки',
  dresses: 'Сукні',
  trousers: 'Штани',
  shorts: 'Шорти',
  skirts: 'Спідниці',
  shoes: 'Взуття',
  accessories: 'Аксесуари',
};

export const SEASON_LABEL: Record<Season, string> = { all: 'Усі сезони', warm: 'Тепло', transitional: 'Міжсезоння', cold: 'Холод' };

/** The five weather periods (owner, 19.11), temperate months of the northern hemisphere: Mar–May spring, Jun–Aug summer, Sep–Oct early autumn, Nov late autumn, Dec–Feb winter. */
export const PERIOD_LABEL: Record<Period, string> = { spring: 'Весна', summer: 'Літо', 'early-autumn': 'Рання осінь', 'late-autumn': 'Пізня осінь', winter: 'Зима' };
export const PERIOD_TEMP: Record<Period, string> = { spring: '10–20 °C', summer: 'від 20 °C', 'early-autumn': '12–20 °C', 'late-autumn': '5–12 °C', winter: '0–10 °C, дощ' };
export function currentPeriod(date = new Date(), hemisphere: 'north' | 'south' = 'north'): Period {
  // The southern hemisphere has the same periods six months later.
  const m = ((date.getMonth() + (hemisphere === 'south' ? 6 : 0)) % 12) + 1;
  return m >= 3 && m <= 5 ? 'spring' : m <= 8 && m >= 6 ? 'summer' : m === 9 || m === 10 ? 'early-autumn' : m === 11 ? 'late-autumn' : 'winter';
}
/** «у приміщенні» (owner, 19.11): a look of a capsule only for cold periods, without any outer layer, is not for going out in 0–12 °C. */
export function indoorOnly(db: DB, look: Look): boolean {
  const c = look.capsuleId ? db.capsules.find((x) => x.id === look.capsuleId) : undefined;
  if (!c?.periods?.length || !c.periods.every((p) => p === 'late-autumn' || p === 'winter')) return false;
  const category = (r: SlotRef) => (r.kind === 'item' ? db.items.find((i) => i.id === r.id)?.category : r.kind === 'need' ? db.needs.find((n) => n.id === r.id)?.category : db.needs.find((n) => n.id === db.products.find((p) => p.id === r.id)?.needId)?.category);
  return !Object.values(look.slots).flat().some((r) => category(r) === 'outerwear');
}

const NEAR: Record<Period, Period[]> = { spring: ['early-autumn', 'summer'], summer: ['spring', 'early-autumn'], 'early-autumn': ['spring', 'late-autumn'], 'late-autumn': ['winter', 'early-autumn'], winter: ['late-autumn'] };
/** Home (owner, 19.11): ready looks for today — capsules of the current period first, then the nearest periods; liked and best scored first. */
export function todayLooks(db: DB, n = 2): Look[] {
  const now = currentPeriod(new Date(), db.profile.hemisphere);
  const caps = db.capsules.filter((c) => !c.redirectCapsuleIds && c.kind !== 'selection' && !isCapsuleHidden(db, c) && c.periods?.length);
  const rank = (ps: Period[]) => caps
    .filter((c) => c.periods!.some((p) => ps.includes(p)))
    .flatMap((c) => distinctLooks(db, capsuleLooks(db, c.lookIds)))
    .filter((l) => isComplete(db, l))
    .sort((a, b) => Number(b.favorite) - Number(a.favorite) || (lookRating(b) ?? 0) - (lookRating(a) ?? 0));
  const out: Look[] = [];
  for (const l of [...rank([now]), ...rank(NEAR[now])]) if (!out.some((x) => x.id === l.id) && out.length < n) out.push(l);
  return out;
}

/** «Пізня осінь · Зима» on a tile; with temperatures on the capsule page. */
export const periodLine = (c: { periods?: Period[] }, temps = false) => (c.periods ?? []).map((p) => (temps ? `${t(PERIOD_LABEL[p])} ${t(PERIOD_TEMP[p])}` : t(PERIOD_LABEL[p]))).join(' · ');

export const SLOT_LABEL: Record<SlotKey, string> = { top: 'Верх', layer: 'Шар', bottom: 'Низ', shoes: 'Взуття', accessories: 'Аксесуари' };

/** Which wardrobe categories fit each outfit slot. */
export const SLOT_CATEGORIES: Record<SlotKey, Category[]> = {
  top: ['tees', 'shirts', 'knitwear', 'dresses'],
  layer: ['outerwear', 'knitwear', 'shirts'],
  bottom: ['trousers', 'shorts', 'skirts'],
  shoes: ['shoes'],
  accessories: ['accessories'],
};

export const JOB_LABEL: Record<Job['state'], string> = { queued: 'У черзі', running: 'В роботі', done: 'Готово', needs_data: 'Потрібні дані', error: 'Помилка' };
export const JOB_TONE: Record<Job['state'], string> = { queued: '', running: 'info', done: 'ok', needs_data: 'warn', error: 'bad' };
export const REVIEW_LABEL: Record<Result['review'], string> = { pending: 'На перевірці', accepted: 'Прийнято', rework: 'Переробити' };
export const REVIEW_TONE: Record<Result['review'], string> = { pending: 'warn', accepted: 'ok', rework: 'bad' };
export const REASON_LABEL = { face: 'Обличчя', proportions: 'Пропорції', garment: 'Річ', background: 'Фон / кадр', other: 'Інше' } as const;

export const MEASURES: { key: MeasureKey; label: string; how: string }[] = [
  { key: 'height', label: 'Зріст', how: 'Без взуття, спиною до стіни, від підлоги до верхівки.' },
  { key: 'chest', label: 'Груди', how: 'По найширшій частині грудей під пахвами, стрічка горизонтально.' },
  { key: 'waist', label: 'Талія', how: 'Там, де носиш пояс штанів, без втягування живота.' },
  { key: 'hips', label: 'Стегна', how: 'По найширшій частині сідниць, ноги разом.' },
  { key: 'shoulders', label: 'Плечі', how: 'Ззаду від кісточки одного плеча до іншого.' },
  { key: 'sleeve', label: 'Довжина рукава', how: 'Від шва плеча до кісточки зап’ястя, рука трохи зігнута.' },
  { key: 'inseam', label: 'Внутрішній шов', how: 'Від паху до підлоги по внутрішній стороні ноги, без взуття.' },
  { key: 'foot', label: 'Довжина стопи', how: 'Стоячи, від п’ятки до найдовшого пальця.' },
];

export type RefKind = 'owned' | 'candidate' | 'need' | 'product';
export const REF_KIND_LABEL: Record<RefKind, string> = { owned: 'Твоя річ', candidate: 'Кандидат', need: 'Бажаний тип', product: 'Товар магазину' };

export interface ResolvedRef {
  ref: SlotRef;
  title: string;
  kind: RefKind;
  category?: Category;
  /** Clean catalogue image: packshot, concept or product photo. */
  art?: string;
  photo?: string;
  missing?: boolean;
  inactive?: boolean;
}

export function resolveRef(db: DB, ref: SlotRef): ResolvedRef {
  if (ref.kind === 'item') {
    const it = db.items.find((i) => i.id === ref.id);
    if (!it) return { ref, title: ref.id, kind: 'candidate', missing: true };
    const photo = it.photoIds.map((id) => db.photos.find((p) => p.id === id)?.path).find(Boolean);
    const art = it.packshotId ? db.photos.find((p) => p.id === it.packshotId)?.path : undefined;
    return { ref, title: it.title, kind: it.status === 'confirmed' ? 'owned' : 'candidate', category: it.category, art, photo, inactive: it.status === 'inactive' };
  }
  if (ref.kind === 'need') {
    const n = db.needs.find((x) => x.id === ref.id);
    const art = n?.conceptPhotoId ? db.photos.find((p) => p.id === n.conceptPhotoId)?.path : undefined;
    return { ref, title: n?.title ?? ref.id, kind: 'need', category: n?.category, art, missing: !n };
  }
  const p = db.products.find((x) => x.id === ref.id);
  const photo = p?.photoId ? db.photos.find((ph) => ph.id === p.photoId)?.path : undefined;
  const cat = p ? db.needs.find((n) => n.id === p.needId)?.category : undefined;
  return { ref, title: p ? `${p.brand} ${p.model}`.trim() : ref.id, kind: 'product', category: cat, art: photo, photo, missing: !p };
}

export function resultsForLook(db: DB, lookId: string) {
  return db.results.filter((r) => r.lookId === lookId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * The look's picture: an accepted try-on, else one awaiting the owner's check.
 * A rejected try-on (not the owner's face) is never shown; the look shows its
 * pieces instead (owner, 17.11). Rejected attempts stay in the archive.
 */
export function coverForLook(db: DB, look: Look): Result | undefined {
  const rs = resultsForLook(db, look.id);
  // A try-on awaiting the owner's check shows only when it was made with the current, active face reference.
  const face = db.profile.identity && !db.profile.identity.disabledReason ? db.profile.identity.face?.sha256 : undefined;
  const current = (r: Result) => Boolean(face) && db.jobs.find((j) => j.id === r.jobId)?.snapshot.identity?.face?.sha256 === face;
  return rs.find((r) => r.review === 'accepted') ?? rs.find((r) => r.review === 'pending' && current(r));
}

/**
 * The picture shown for a look (owner, 19.11): a try-on of an older composition is not shown — the collage of the
 * current pieces stands in until a new try-on (⟳) — unless the owner answered «Ні» to «Речі змінено» for this version.
 */
export function currentCover(db: DB, look: Look): Result | undefined {
  const cover = coverForLook(db, look);
  return cover && (cover.lookVersion === look.version || look.keptVersion === look.version) ? cover : undefined;
}

/**
 * «Додати мій образ»: the latest real appearance of the look's current composition. Photos of an older version
 * show other pieces, so they never stand for the look once it changes.
 */
export function currentWear(db: DB, look: Look): Wear | undefined {
  return (db.wears ?? []).filter((w) => w.lookId === look.id && w.lookVersion === look.version).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

/** The person's own photos of a wear, in the order they were added. */
export const wearPhotoPaths = (db: DB, wear: Wear) => wear.photoIds.map((id) => db.photos.find((p) => p.id === id && p.kind === 'worn')?.path).filter((p): p is string => Boolean(p));

/** The render pinned beside a wear, while it is still shown (a hidden or deleted one is gone from the state). */
export const wearRenderOf = (db: DB, wear: Wear) => (wear.resultId ? db.results.find((r) => r.id === wear.resultId && !r.hiddenAt && r.review !== 'rework' && r.lookId === wear.lookId && r.lookVersion === wear.lookVersion) : undefined);

/** The latest review job of a wear. */
export const wearJob = (db: DB, wearId: string) => db.jobs.filter((j) => j.kind === 'wearreview' && j.wearId === wearId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);

/** A try-on of this look is being made right now (a queued one is not shown as work in progress). */
export const lookBusy = (db: DB, lookId: string) => db.jobs.some((j) => (j.kind ?? 'tryon') === 'tryon' && j.lookId === lookId && j.state === 'running');

/** The look's picture job: running, or also waiting when the owner just asked for it. */
export const lookJob = (db: DB, lookId: string, includeQueued = false) =>
  db.jobs.filter((j) => (j.kind ?? 'tryon') === 'tryon' && j.lookId === lookId && (j.state === 'running' || (includeQueued && j.state === 'queued'))).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

const FALLBACK_SECONDS: Record<string, number> = { tryon: 140, packshot: 80, intake: 25, analyze: 60, shopsearch: 320, advise: 240, storefind: 240, discover: 120, wearreview: 60 };

/** How long a job of this kind usually takes here: the median of the last 20 finished ones (owner, 18.11). */
export function expectedSeconds(db: DB, kind: Job['kind']) {
  const k = kind ?? 'tryon';
  const recent = db.jobs
    .filter((j) => (j.kind ?? 'tryon') === k && j.state === 'done' && j.startedAt && j.finishedAt)
    .sort((a, b) => b.finishedAt!.localeCompare(a.finishedAt!))
    .slice(0, 20)
    .map((j) => (new Date(j.finishedAt!).getTime() - new Date(j.startedAt!).getTime()) / 1000)
    .filter((s) => s > 0)
    .sort((a, b) => a - b);
  return recent.length >= 3 ? recent[Math.floor(recent.length / 2)] : FALLBACK_SECONDS[k] ?? 120;
}

/** Up to the usual end a bar fills to 90 %; a slower run keeps creeping towards 96 % instead of standing still. */
export const progressShare = (elapsed: number, total: number) =>
  elapsed <= total ? (0.9 * elapsed) / total : 0.9 + 0.06 * (1 - Math.exp(-(elapsed - total) / total));

/** Real progress of one job: share of its usual time (never 100% before it ends) and what is left. */
export function jobProgress(db: DB, job: Job, now = Date.now()) {
  if (job.state !== 'running' || !job.startedAt) return { pct: 0, label: t('у черзі') };
  const total = expectedSeconds(db, job.kind);
  const elapsed = Math.max(0, (now - new Date(job.startedAt).getTime()) / 1000);
  const left = total - elapsed;
  const pct = progressShare(elapsed, total);
  const label = left >= 60 ? t('ще ≈ {n} хв', { n: Math.ceil(left / 60) }) : left > 5 ? t('ще < 1 хв') : left > -15 ? t('майже готово') : t('ще трохи');
  return { pct, label };
}

/** Looks (visible on the site) that use this piece. */
export function looksUsing(db: DB, kind: SlotRef['kind'], id: string) {
  const hidden = hiddenLookIds(db);
  return db.looks.filter((l) => !hidden.has(l.id) && Object.values(l.slots).some((refs) => refs.some((r) => r.kind === kind && r.id === id)));
}

export function piecesOf(db: DB, slots: Look['slots']): ResolvedRef[] {
  return (['layer', 'top', 'bottom', 'shoes', 'accessories'] as SlotKey[]).flatMap((k) => slots[k].map((r) => resolveRef(db, r)));
}

export function itemArt(db: DB, itemId: string) {
  const it = db.items.find((i) => i.id === itemId);
  if (!it) return {};
  const art = it.packshotId ? db.photos.find((p) => p.id === it.packshotId)?.path : undefined;
  const photo = it.photoIds.map((id) => db.photos.find((p) => p.id === id)?.path).find(Boolean);
  return { art, photo };
}

/** Active BCP 47 locale for dates, numbers and currency. */
export const activeLocale = () => (currentLanguage() === 'en' ? 'en-GB' : 'uk-UA');

export function fmtDate(iso?: string) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(activeLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function fmtDay(iso?: string) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(activeLocale(), { day: 'numeric', month: 'long', year: 'numeric' });
}

// Stable: the representative of near-copies does not change as pictures arrive.
const lookScore = (db: DB, l: Look) => (l.favorite ? 8 : 0) + (isComplete(db, l) ? 4 : 0);

/**
 * One card per look: hidden looks are dropped and near-copies (owner's rule:
 * identical or one piece different) fold into the best representative —
 * liked, then with an accepted try-on, then with any try-on. Copies stay in
 * the data. Liked looks come first; otherwise the given order is kept.
 */
export function distinctLooks(db: DB, looks: Look[]): Look[] {
  const hidden = hiddenLookIds(db);
  const visible = looks.filter((l) => !hidden.has(l.id));
  const best = visible.map((l, i) => ({ l, i, s: lookScore(db, l) })).sort((a, b) => b.s - a.s || a.i - b.i).map((e) => e.l);
  const reps = new Set(groupLookVariations(best).map((g) => g.primary.id));
  return rankLooks(db, visible.filter((l) => reps.has(l.id)));
}

/** The other looks shown as variants of this one in its capsule (owner, 19.11): its primary and the primary's other variants. */
export function lookVariants(db: DB, look: Look): Look[] {
  const capsule = look.capsuleId ? db.capsules.find((c) => c.id === look.capsuleId) : undefined;
  if (!capsule) return [];
  const hidden = hiddenLookIds(db);
  const visible = capsuleLooks(db, capsule.lookIds).filter((l) => !hidden.has(l.id));
  const best = visible.map((l, i) => ({ l, i, s: lookScore(db, l) })).sort((a, b) => b.s - a.s || a.i - b.i).map((e) => e.l);
  const group = groupLookVariations(best).find((g) => g.primary.id === look.id || g.variants.some((v) => v.id === look.id));
  return group ? [group.primary, ...group.variants].filter((l) => l.id !== look.id) : [];
}

/** Recommendations a look still waits for (a shop option counts as its recommendation). */
export function missingNeeds(db: DB, look: Pick<Look, 'slots'>): string[] {
  const ids = Object.values(look.slots).flat().flatMap((r) => (r.kind === 'need' ? [r.id] : r.kind === 'product' ? [db.products.find((p) => p.id === r.id)?.needId ?? r.id] : []));
  return [...new Set(ids)];
}

/** Pieces the owner cannot wear now: recommendations still to buy and items that are inactive, merged away or gone. */
function missingTitles(db: DB, look: Pick<Look, 'slots'>): string[] {
  const gone = Object.values(look.slots).flat().flatMap((r) => {
    if (r.kind !== 'item') return [];
    const it = db.items.find((i) => i.id === r.id);
    return !it || it.status === 'inactive' || it.mergedInto ? [it?.title ?? r.id] : [];
  });
  return [...missingNeeds(db, look).map((id) => db.needs.find((n) => n.id === id)?.title ?? id), ...gone];
}

export const hasPieces = (look: Pick<Look, 'slots'>) => Object.values(look.slots).some((refs) => refs.length);

/** Everything in the look is in the wardrobe and in use: it can be worn today. */
export const isComplete = (db: DB, look: Look) => hasPieces(look) && missingTitles(db, look).length === 0;

export const WARDROBE_CAPSULE_ID = 'my-wardrobe';
export const WARDROBE_CAPSULE_NAME = 'З моїх речей';

export function wardrobeCapsule(db: DB) {
  const active = new Set(db.capsules.filter((c) => !isCapsuleHidden(db, c)).map((c) => c.id));
  const looks = distinctLooks(db, db.looks.filter((l) => l.capsuleId && active.has(l.capsuleId) && isComplete(db, l)));
  // One look of each capsule in turn, so the tile does not repeat one capsule's cover.
  const byCapsule = new Map<string, Look[]>();
  for (const l of looks) byCapsule.set(l.capsuleId!, [...(byCapsule.get(l.capsuleId!) ?? []), l]);
  const order: Look[] = [];
  for (let i = 0; order.length < looks.length; i += 1) for (const ls of byCapsule.values()) if (ls[i]) order.push(ls[i]);
  return { id: WARDROBE_CAPSULE_ID, name: WARDROBE_CAPSULE_NAME, lookIds: order.map((l) => l.id), favorite: false };
}

export const BEST_CAPSULE_ID = 'best';
export const BEST_CAPSULE_NAME = 'Найкращі';
const BEST_COUNT = 10;
const bestCache = new WeakMap<DB, Look[]>();
/**
 * «Найкращі» (owner, 18.11): up to ten looks — liked first, then the advisor's highest current scores.
 * The «Найкращий» label on cards and the automatic capsule use this one list.
 */
export function bestLooks(db: DB): Look[] {
  const hit = bestCache.get(db);
  if (hit) return hit;
  const score = (l: Look) => (l.advice && l.advice.version === l.version ? l.advice.score : 0);
  const out = siteLooks(db)
    .filter((l) => hasPieces(l) && (l.favorite || score(l) >= 8))
    .map((l, i) => ({ l, i }))
    .sort((a, b) => Number(b.l.favorite) - Number(a.l.favorite) || score(b.l) - score(a.l) || Number(isComplete(db, b.l)) - Number(isComplete(db, a.l)) || a.i - b.i)
    .slice(0, BEST_COUNT)
    .map((e) => e.l);
  bestCache.set(db, out);
  return out;
}
export const isBestLook = (db: DB, id: string) => bestLooks(db).some((l) => l.id === id);

/** The advisor's scores on cards and pages (owner, 19.11), written like the item line: «8/10», «8,6/10». */
const scoreFormats = {
  uk: new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 1 }),
  en: new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 }),
};
export const scoreLabel = (n: number) => `${scoreFormats[currentLanguage()].format(n)}/10`;
/** A look's score counts only while it belongs to the pieces the look has now. */
export const lookRating = (l: Look) => (l.advice && l.advice.version === l.version ? l.advice.score : null);
/** A capsule's score: the mean of its shown looks' current scores (owner, 19.11). */
export function capsuleRating(db: DB, c: Pick<Capsule, 'lookIds'>) {
  const scores = distinctLooks(db, capsuleLooks(db, c.lookIds)).filter(hasPieces).map(lookRating).filter((s): s is number => s !== null);
  return scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null;
}
/** An item's score, like its verdict line: none for blocked glasses or pieces no longer in the wardrobe. */
export const itemRating = (item: Item, db?: DB) => (item.rating && item.status !== 'inactive' && !item.mergedInto && !(db ? isBlockedEyewear(db, item.title) : isEyewear(item.title)) ? item.rating.score : null);
export const bestCapsule = (db: DB) => ({ id: BEST_CAPSULE_ID, name: BEST_CAPSULE_NAME, lookIds: bestLooks(db).map((l) => l.id), favorite: false });
/** The site's own capsules (no data of their own): «Найкращі» and «З моїх речей». */
export const isAutoCapsule = (id: string) => id === BEST_CAPSULE_ID || id === WARDROBE_CAPSULE_ID;
// «Найкращі» and «З моїх речей» are not capsules but filters of the looks (owner, 20.11): a capsule is one distinct style.

/** Count where an item is used, including when it appears only in a saved variant. */
export function itemPlacements(db: DB, itemId: string, ready = wardrobeCapsule(db)) {
  const contains = (look: Look) => Object.values(look.slots).flat().some((r) => r.kind === 'item' && r.id === itemId);
  const matching = db.looks.filter(contains);
  const groups = db.capsules.flatMap((capsule) => {
    if (isCapsuleHidden(db, capsule)) return [];
    const looks = distinctLooks(db, matching.filter((l) => l.capsuleId === capsule.id && capsule.lookIds.includes(l.id)));
    return looks.length ? [{ id: capsule.id, name: capsule.name, looks }] : [];
  });
  const readyLooks = capsuleLooks(db, ready.lookIds).filter(contains);
  const looks = distinctLooks(db, [...new Map([...groups.flatMap((c) => c.looks), ...readyLooks].map((l) => [l.id, l])).values()]);
  const capsules = [...groups, ...(readyLooks.length ? [{ id: ready.id, name: ready.name, looks: readyLooks }] : [])];
  return { looks, capsules };
}

/** Capsules an item counts in: only real ones — «З моїх речей» and «Найкращі» are other views of the same looks (owner, 19.11). */
export const capsuleCount = (capsules: { id: string }[]) => capsules.filter((c) => !isAutoCapsule(c.id)).length;

const ukrainianPlural = new Intl.PluralRules('uk');
export function usageLabel(capsules: number, looks: number) {
  if (!capsules && !looks) return t('без образів');
  const ending = ukrainianPlural.select(capsules);
  return `${capsules ? t(ending === 'one' ? 'у {n} капсулі' : 'у {n} капсулах', { n: capsules }) : t('0 капсул')} · ${plural(looks, LOOKS)}`;
}

/** Quiet line under an incomplete look's name (owner, 17.11): what is missing first, then how many more. */
export function missingInfo(db: DB, look: Look): { text: string; more: number } | null {
  if (!hasPieces(look)) return { text: t('порожній образ'), more: 0 };
  const m = missingTitles(db, look);
  if (!m.length) return null;
  return { text: `${t('бракує')}: ${m[0].charAt(0).toLowerCase()}${m[0].slice(1)}`, more: m.length - 1 };
}

/** Liked first, then looks the owner can wear now, then the rest; otherwise the given order (owner, 17.11). */
export const rankLooks = (db: DB, looks: Look[]) =>
  looks.map((l, i) => ({ l, i, full: isComplete(db, l) })).sort((a, b) => Number(b.l.favorite) - Number(a.l.favorite) || Number(b.full) - Number(a.full) || a.i - b.i).map((e) => e.l);

/** How many of a capsule's looks are ready to wear. */
export function capsuleReady(db: DB, c: Pick<Capsule, 'lookIds'>) {
  // An empty look just added with «+ Образ» does not count yet.
  const looks = distinctLooks(db, capsuleLooks(db, c.lookIds)).filter(hasPieces);
  return { done: looks.filter((l) => isComplete(db, l)).length, total: looks.length };
}

/** Advisor counts for an item: shown looks with it, how many are complete or liked, capsules it is in. */
export function itemUsage(db: DB, itemId: string, ready = wardrobeCapsule(db)) {
  // The same looks «Де використано» lists, so the verdict and the page never disagree.
  const { looks, capsules } = itemPlacements(db, itemId, ready);
  return { looks: looks.length, complete: looks.filter((l) => isComplete(db, l)).length, liked: looks.filter((l) => l.favorite).length, capsules: capsuleCount(capsules) };
}

/** The item page's quiet line (owner, 18.11): «8/10 · сильна річ», «гарна, мало образів», «варто замінити: …»; the count lives in «Де використано». */
export function itemVerdict(db: DB, item: Item): { line: string; note: string; kind: 'strong' | 'underused' | 'replace' | 'plain'; need?: Need } | null {
  const r = item.rating;
  if (!r || item.status === 'inactive' || item.mergedInto || isBlockedEyewear(db, item.title)) return null;
  const n = itemUsage(db, item.id).looks;
  const reason = r.replace ? `${r.replace.charAt(0).toLowerCase()}${r.replace.slice(1)}`.replace(/[.\s]+$/, '') : '';
  if (r.replace && !r.kept) return { kind: 'replace', line: `${r.score}/10 · ${t('варто замінити')}: ${reason}`, note: r.note, need: db.needs.find((x) => x.replaces === item.id && x.status === 'open') };
  if (r.score >= 7 && n <= 1) return { kind: 'underused', line: `${r.score}/10 · ${t('гарна, мало образів')}`, note: r.note };
  if (r.score >= 7) return { kind: 'strong', line: `${r.score}/10 · ${t('сильна річ')}`, note: r.note };
  return { kind: 'plain', line: `${r.score}/10`, note: r.note };
}

/** The honest rank scale's version (owner, 19.11); ratings made with an older scale are redone once. */
export const SCORE_SCALE = 2;
/** A so-so piece (owner, 19.11: «відсіяти так собі речі»): honest score under 6, or still «варто замінити». New looks are not built with it. */
export const weakPiece = (item: Item) => Boolean(item.rating && ((item.rating.scale === SCORE_SCALE && item.rating.score < 6) || (item.rating.replace && !item.rating.kept)));
export const isEyewear = (title: string) => /окуляр|оправ|glasses|eyewear/i.test(title);
/** Whether eyewear is kept out of looks for this profile (default: yes, unless enabled in preferences). */
export const eyewearBlocked = (db: DB) => !db.profile.allowEyewear;
export const isBlockedEyewear = (db: DB, title: string) => eyewearBlocked(db) && isEyewear(title);

/** Advisor proposals still worth showing: open and made only of active owned pieces. */
export function openSuggestions(db: DB) {
  const active = new Set(db.items.filter((i) => i.status !== 'inactive' && !i.mergedInto && !isBlockedEyewear(db, i.title) && !weakPiece(i)).map((i) => i.id));
  const parents = new Set(db.capsules.filter((c) => !isCapsuleHidden(db, c)).map((c) => c.id));
  // A proposal that a look made meanwhile already covers is not shown (look memory, owner 19.11).
  // A proposal for a capsule with a closed set shows only while its owned pieces are in that set (owner, 20.11).
  const fitsSet = (s: NonNullable<DB['suggestions']>[number]) => {
    const c = s.kind === 'look' && s.capsuleId ? db.capsules.find((x) => x.id === s.capsuleId) : undefined;
    return !c?.pieces || s.looks.every((l) => Object.values(l.slots).flat().every((r) => inSavedSet(db, c, r)) && buysFitSet(db, c, l.buy));
  };
  return (db.suggestions ?? []).filter((s) => s.status === 'open' && fitsSet(s) && (s.kind === 'capsule' || Boolean(s.capsuleId && parents.has(s.capsuleId))) && s.looks.every((l) => Object.values(l.slots).flat().every((r) => r.kind !== 'item' || active.has(r.id))) && !s.looks.some((l) => db.looks.some((x) => tooClose(db, withBuys(l.slots, l.buy), x.slots))));
}

/** «Де шукати» (Profile → Магазини): the owner's shopping place; empty means online only. */
/** «Де шукати»: the person's shopping place; empty until they name one or share their location. */
export const shopLocation = (db: DB) => db.profile.location ?? '';

// «Магазини» (owner, 19.11): the shops of the found products and where their nearest store is.
/** Country and region words shops add to their names («Levi’s Poland», «Levi’s Polska», «Levi’s DE»); generic, not anyone's place. */
const COUNTRY_WORDS = 'croatia|hrvatska|slovenia|slovenija|serbia|srbija|bosnia|montenegro|ukraine|україна|ukraina|poland|polska|czech|česko|slovakia|hungary|magyarország|romania|bulgaria|greece|germany|deutschland|austria|österreich|switzerland|schweiz|italy|italia|france|spain|españa|portugal|netherlands|nederland|belgium|ireland|denmark|sweden|norway|finland|lithuania|latvia|estonia|uk|usa|us|eu|hr|si|rs|ua|pl|cz|sk|hu|ro|bg|gr|de|at|ch|it|fr|es|pt|nl|be|ie|dk|se|no|fi|lt|lv|ee';
const COUNTRY_SUFFIX = new RegExp(`\\s+(${COUNTRY_WORDS})$`, 'i');
/** A shop's plain name: no «(…)» notes and no trailing country word. */
export const plainShopName = (name: string) => name.replace(/\s*\([^)]*\)/g, '').trim().replace(COUNTRY_SUFFIX, '').trim();
/** One key per shop: «Levi’s Poland» and «Levi’s Polska» are the same shop. */
const KEY_NOISE = new RegExp(`\\b(${COUNTRY_WORDS}|online|shop|store)\\b`, 'g');
export const storeKey = (name: string) => name.replace(/\([^)]*\)/g, ' ').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(KEY_NOISE, ' ').replace(/\s+/g, ' ').trim();

/** Shops of the found products, once each, with their known place (a shop at the owner's place counts as known). */
export function shopStores(db: DB) {
  const seen = new Map<string, { key: string; name: string; host: string; atPlace: boolean }>();
  for (const p of db.products) {
    const key = storeKey(p.store);
    if (!key) continue;
    const prev = seen.get(key);
    let host = '';
    try {
      host = p.url ? new URL(p.url).hostname : '';
    } catch {
      /* no link */
    }
    seen.set(key, { key, name: prev?.name ?? p.store, host: prev?.host || host, atPlace: Boolean(prev?.atPlace || p.towerAvailability === 'confirmed') });
  }
  return [...seen.values()].map((s) => ({ ...s, place: (db.stores ?? []).find((x) => x.key === s.key) }));
}


/** «4 з 6 готові» / «усі готові» — the quiet capsule line. */
export function readyLine(db: DB, c: Pick<Capsule, 'lookIds'>) {
  const { done, total } = capsuleReady(db, c);
  if (!total) return '';
  return done === total ? t('усі готові') : t('{done} з {total} готові', { done, total });
}

/** Liked first, then fully ready capsules, then the share of ready looks. */
export const rankCapsules = (db: DB, caps: Capsule[]) =>
  caps
    .map((c, i) => {
      const { done, total } = capsuleReady(db, c);
      return { c, i, full: total > 0 && done === total, share: total ? done / total : 0, now: Boolean(c.periods?.includes(currentPeriod(new Date(), db.profile.hemisphere))) };
    })
    // Capsules for the current weather period first (owner, 19.11), then liked, ready, …
    .sort((a, b) => Number(b.now) - Number(a.now) || Number(b.c.favorite) - Number(a.c.favorite) || Number(b.full) - Number(a.full) || b.share - a.share || a.i - b.i)
    .map((e) => e.c);

/**
 * Next-purchase rating (owner, 17.11): looks it would complete count most,
 * then how much closer it brings the other looks, the owner's liked looks and
 * core priority. Derived from the data, so every purchase or upload re-ranks.
 */
/**
 * The looks the site shows as cards: each visible capsule's looks with near-copies folded inside
 * that capsule (as its page shows them), plus looks outside capsules — one entry per look.
 */
export function siteLooks(db: DB): Look[] {
  const seen = new Set<string>();
  const out: Look[] = [];
  const add = (ls: Look[]) => { for (const l of ls) if (!seen.has(l.id)) { seen.add(l.id); out.push(l); } };
  for (const c of db.capsules) if (!c.disliked) add(distinctLooks(db, capsuleLooks(db, c.lookIds)));
  add(distinctLooks(db, db.looks.filter((l) => !l.capsuleId || !db.capsules.some((c) => c.id === l.capsuleId))));
  return out;
}

export function purchaseRanking(db: DB) {
  const open = db.needs.filter((n) => n.status === 'open');
  const visible = siteLooks(db);
  // Capsule sets (owner, 20.11): a purchase in a capsule's set comes first; on equal score, the one adding more combinations.
  const capsules = fashionCapsules(db);
  const inSets = new Set(capsules.flatMap((c) => capsulePieceRefs(db, c)).filter((r) => r.kind === 'need').map((r) => r.id));
  const gains = combinationGains(db, capsules);
  return open
    .map((n) => {
      // Same cards as everywhere else: the visible looks with near-copies folded once for the whole site.
      const looks = visible.filter((l) => missingNeeds(db, l).includes(n.id));
      let completes = 0;
      let closer = 0;
      let liked = 0;
      for (const l of looks) {
        const m = missingTitles(db, l).length;
        if (m === 1) completes += 1;
        else closer += 1 / m;
        if (l.favorite) liked += 1;
      }
      const looksIn = looks.length;
      return { need: n, looksIn, completes, inSet: inSets.has(n.id), combos: gains.get(n.id) ?? 0, score: completes * 3 + closer + liked + (n.priority === 'core' ? 0.5 : 0) };
    })
    .sort((a, b) => Number(b.inSet) - Number(a.inSet) || b.score - a.score || b.combos - a.combos || b.looksIn - a.looksIn);
}

/**
 * What a purchase really gives (owner, 19.11): the looks it fits, how many it completes on its own, and when one is not
 * enough, the smallest set of open purchases after which a look — liked first — can be worn.
 */
export function purchasePlan(db: DB, needId: string) {
  const looks = siteLooks(db).filter((l) => missingNeeds(db, l).includes(needId));
  // Only looks whose every missing piece is a purchase (not an item taken out of the wardrobe).
  const buyable = looks.filter((l) => missingTitles(db, l).length === missingNeeds(db, l).length);
  const completes = buyable.filter((l) => missingNeeds(db, l).length === 1).length;
  const best = completes ? undefined : buyable
    .map((l) => ({ l, n: missingNeeds(db, l).length }))
    .sort((a, b) => Number(b.l.favorite) - Number(a.l.favorite) || a.n - b.n)[0];
  const others = best ? missingNeeds(db, best.l).filter((id) => id !== needId).map((id) => db.needs.find((x) => x.id === id)?.title ?? id) : [];
  return { fits: looks.length, completes, with: best ? { look: best.l, others } : undefined };
}

export const capsuleLooks = (db: DB, lookIds: string[]) => lookIds.map((id) => db.looks.find((l) => l.id === id)).filter((l): l is Look => Boolean(l));

const KNOWN_BRANDS: [string, RegExp][] = [
  ["Levi's", /levi/i], ['The North Face', /\btnf\b|north face/i], ['Adidas', /adidas|stan smith/i], ['Napapijri', /napapijri/i],
  ['Polo Ralph Lauren', /ralph lauren/i], ['Puma', /\bpuma\b/i], ['Under Armour', /\bua\b|under armour/i], ['Tommy Hilfiger', /tommy/i],
  ['Tom Tailor', /tom tailor/i], ['Nike', /\bnike\b/i], ['Lacoste', /lacoste/i], ['Calvin Klein', /calvin klein/i], ['Hugo Boss', /\bboss\b|\bhugo\b/i],
];

/** Brands seen in the wardrobe (brand field, title or notes), most frequent first — the start of «Мої бренди». */
export function wardrobeBrands(db: Pick<DB, 'items'>): string[] {
  const count = new Map<string, number>();
  for (const i of db.items) {
    if (i.status === 'inactive' || i.mergedInto) continue;
    const text = `${i.brand ?? ''} ${i.title} ${i.observation ?? ''}`;
    for (const [name, re] of KNOWN_BRANDS) if (re.test(text)) count.set(name, (count.get(name) ?? 0) + 1);
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
}
