// Shared data contract for the site, the Codex runner and agent imports.
// Every write goes through validateDb before it reaches disk.
import { pieceSetError } from '../src/capsule-pieces.ts';

export const SCHEMA_VERSION = 1;

export const CATEGORIES = ['outerwear', 'knitwear', 'shirts', 'tees', 'dresses', 'trousers', 'shorts', 'skirts', 'shoes', 'accessories'] as const;
export type Category = (typeof CATEGORIES)[number];

export const ITEM_STATUSES = ['needs_confirmation', 'confirmed', 'inactive'] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

/** 'worn': the person's own photo of a look actually worn; never a base, identity or garment source. */
export const PHOTO_KINDS = ['source', 'base', 'item', 'label', 'detail', 'product', 'packshot', 'worn'] as const;
export type PhotoKind = (typeof PHOTO_KINDS)[number];

export const SLOT_KEYS = ['top', 'layer', 'bottom', 'shoes', 'accessories'] as const;
export type SlotKey = (typeof SLOT_KEYS)[number];

export const SEASONS = ['all', 'warm', 'transitional', 'cold'] as const;
export type Season = (typeof SEASONS)[number];
/** The five weather periods (owner, 19.11; seasonal spec): a fashion capsule belongs to one or more. */
export const PERIODS = ['spring', 'summer', 'early-autumn', 'late-autumn', 'winter'] as const;
export type Period = (typeof PERIODS)[number];

export const JOB_STATES = ['queued', 'running', 'done', 'needs_data', 'error'] as const;
export type JobState = (typeof JOB_STATES)[number];

export const REVIEW_STATES = ['pending', 'accepted', 'rework'] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

export const REWORK_REASONS = ['face', 'proportions', 'garment', 'background', 'other'] as const;
export type ReworkReason = (typeof REWORK_REASONS)[number];

export const MEASURE_KEYS = ['height', 'chest', 'waist', 'hips', 'shoulders', 'sleeve', 'inseam', 'foot'] as const;
export type MeasureKey = (typeof MEASURE_KEYS)[number];

/** The nearest physical store of a shop found in «Покупки» (owner, 19.11). */
export interface StorePlace {
  key: string;
  name: string;
  /** Mall or street and city, e.g. «Arkadia, Warsaw»; empty when online only. */
  place: string;
  /** Approximate road distance from the owner's shopping place. */
  km?: number;
  online: boolean;
  url?: string;
  checkedAt: string;
}

export interface HistoryEntry {
  at: string;
  action: string;
  note?: string;
}

export interface HashedFile { path: string; sha256: string }

/** Owner-confirmed face/body references; frozen into each new try-on. */
export interface IdentityReference {
  sourcePhotoId: string;
  original: HashedFile;
  face: HashedFile;
  /** Explicit owner exception: this exact generated portrait replaces the original face crop. */
  approvedPortrait?: { approvedAt: string; provisional: boolean };
  body: HashedFile;
  preserveHeadAngle: boolean;
  hairstyle?: string;
  noGlasses?: boolean;
  /** Rejected identity setup must be replaced before another personal try-on. */
  disabledReason?: string;
  bodyOriginal?: HashedFile;
  hair?: { sourcePhotoId: string; original: HashedFile; crop: HashedFile };
  confirmedAt: string;
}

export function validHashedFile(file: HashedFile): boolean {
  return !!file && typeof file.path === 'string' && !!file.path && !file.path.startsWith('/') && !file.path.split(/[\\/]/).includes('..') && /^[a-f0-9]{64}$/.test(file.sha256);
}

export function validIdentity(ref: IdentityReference): boolean {
  return !!ref && typeof ref.sourcePhotoId === 'string' && typeof ref.preserveHeadAngle === 'boolean' && !!ref.confirmedAt
    && (!ref.approvedPortrait || (Number.isFinite(Date.parse(ref.approvedPortrait.approvedAt)) && typeof ref.approvedPortrait.provisional === 'boolean' && !!ref.bodyOriginal && !ref.hair))
    && [ref.original, ref.face, ref.body, ...(ref.bodyOriginal ? [ref.bodyOriginal] : []), ...(ref.hair ? [ref.hair.original, ref.hair.crop] : [])].every(validHashedFile) && new Set([ref.original.path, ref.face.path, ref.body.path]).size === 3;
}

export interface Photo {
  id: string;
  kind: PhotoKind;
  /** Display copy, relative to the project root. */
  path: string;
  /** Untouched original when the display copy was converted (HEIC → JPEG). */
  originalPath?: string;
  originalName: string;
  source: 'chat-2026-11-14' | 'upload' | 'generated';
  /** Keep personal originals available as references, independently of item/base selection. */
  preserveAsReference?: boolean;
  /** Owner-supplied face references are separate from full-body sources. */
  referenceRole?: 'face';
  observation?: string;
  /** SHA-256 of the stored original (worn photos): the same file chosen again reuses this photo. */
  sha256?: string;
  /** Owner's check against the base-photo standard; null = not checked. */
  meetsStandard?: boolean | null;
  note?: string;
  /** Archived styling reference, separate from owner photos and generated try-ons. */
  inspiration?: {
    title: string;
    sourceUrl: string;
    sourceNote: string;
    tags: string[];
    sha256: string;
  };
  createdAt: string;
}

export interface Item {
  id: string;
  rev: number;
  category: Category;
  /** Wardrobe filter independent of the outfit slot. */
  sport?: boolean;
  title: string;
  color?: string;
  brand?: string;
  model?: string;
  composition?: string;
  fit?: string;
  size?: string;
  status: ItemStatus;
  photoIds: string[];
  observation?: string;
  confirmedFact?: string;
  origin: 'candidate' | 'purchase' | 'manual' | 'split' | 'merge' | 'intake';
  mergedFrom?: string[];
  mergedInto?: string;
  splitFrom?: string;
  purchasedFromProduct?: string;
  /** Generated catalogue image (reconstruction, not evidence). */
  packshotId?: string;
  /** Advisor's rating (agent judgement; the site adds the counts). Stale when `rev` differs from the item's. */
  rating?: ItemRating;
  /** Face-free crop of an original garment photo, never an identity reference. */
  tryonReference?: HashedFile & { source: HashedFile };
  history: HistoryEntry[];
  createdAt: string;
  updatedAt: string;
}

export interface ItemRating {
  score: number;
  note: string;
  /** A visible or stated reason to replace the item; empty when it is fine. */
  replace?: string;
  replaceWith?: string;
  rev: number;
  at: string;
  /** The owner keeps the item: never suggest replacing it again. */
  kept?: boolean;
  /** The scoring scale this rating was made with (the honest rank scale, owner 19.11, is 2). */
  scale?: number;
}

export interface Need {
  id: string;
  rev: number;
  title: string;
  category: Category;
  priority: 'core' | 'optional';
  description: string;
  why: string;
  fitCheck: string;
  status: 'open' | 'covered';
  origin: 'source' | 'agent' | 'owner';
  sourceNote?: string;
  coveredByItem?: string;
  /** Looks whose stand-in was replaced by the owner's own item (restored if the cover is undone). */
  coveredLookIds?: string[];
  /** Generated concept image of the desired type. */
  conceptPhotoId?: string;
  /** Advisor: this purchase replaces an owned item («замінить: …»). */
  replaces?: string;
  /** Advisor: what this capsule lacks for its style and season («Для капсули: …»). */
  forCapsule?: string;
  /** The old item this purchase took out of the wardrobe («Прибрати стару річ»); undo brings it back. */
  retired?: { id: string; status: ItemStatus };
  /** Shop links the owner dropped with ×: a new search never brings them back. */
  droppedUrls?: string[];
  /** The same dropped products by store and name (a link with other tracking or colour parameters is still the same product). */
  droppedModels?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Product {
  id: string;
  rev: number;
  needId: string;
  store: string;
  brand: string;
  model: string;
  sku?: string;
  url?: string;
  photoId?: string;
  composition?: string;
  fit?: string;
  price?: number | null;
  currency?: string;
  recommendedSize?: string;
  sizeBasis?: string;
  onlineAvailability: 'unknown' | 'in_stock' | 'out_of_stock';
  towerAvailability: 'unknown' | 'confirmed' | 'not_found';
  checkedAt?: string;
  sources?: string;
  /** Shop search: how well it fits the recommendation, its looks and the owner's taste (0–10), with one reason. */
  matchScore?: number;
  matchNote?: string;
  status: 'option' | 'chosen' | 'purchased';
  purchasedItemId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SlotRef {
  kind: 'item' | 'need' | 'product';
  id: string;
}

export type Slots = Record<SlotKey, SlotRef[]>;

export interface LookVersion {
  version: number;
  slots: Slots;
  at: string;
  note?: string;
}

export interface Look {
  id: string;
  rev: number;
  capsuleId: string | null;
  /** An explicitly curated variant of another look in the same capsule. */
  variantOf?: string;
  name: string;
  note?: string;
  slots: Slots;
  version: number;
  versions: LookVersion[];
  /** Owner liked it (ranked first). */
  favorite: boolean;
  /** Owner disliked it: hidden from the site, kept as a finished look and as a "never again" reference. */
  disliked?: boolean;
  ratedAt?: string;
  /** «Речі змінено → Ні»: the owner keeps the picture for this version, so the question does not return. */
  keptVersion?: number;
  /** Advisor: harmony 0–10 for this version and, maybe, one better owned piece; rejected swaps never return. */
  advice?: { score: number; why: string; version: number; swap?: { from: string; to: string }; rejected?: string[]; scale?: number };
  origin: 'source' | 'agent' | 'owner';
  sourceNote?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Capsule {
  id: string;
  rev: number;
  /** 'selection' = outfits picked by the analyzer from owned items only. */
  kind?: 'capsule' | 'selection';
  name: string;
  season: Season;
  /** Weather periods the capsule is for (owner, 19.11); shown as a quiet line above its name. */
  periods?: Period[];
  description: string;
  situations: string[];
  favorite: boolean;
  /** Owner disliked it: the capsule and its looks are hidden, not deleted. */
  disliked?: boolean;
  ratedAt?: string;
  lookIds: string[];
  /**
   * The capsule's closed set (owner, 20.11): up to 10 garments, 3 pairs of shoes and 3 accessories,
   * owned items or purchases to buy. Once saved, the capsule's looks use only these pieces;
   * until then the set is read from its visible looks.
   */
  pieces?: SlotRef[];
  /** One or two pieces of the set the capsule's looks are built on, like Karan's bodysuit. */
  base?: SlotRef[];
  /** Multisport equipment can use a fourth accessory place. */
  accessoryLimit?: 4;
  /** A retired capsule's old URL leads to the capsules that received its looks. */
  redirectCapsuleIds?: string[];
  origin: 'source' | 'agent' | 'owner';
  sourceNote?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SnapshotSlot {
  slot: SlotKey;
  kind: SlotRef['kind'];
  id: string;
  title: string;
  description: string;
  owned: boolean;
  photoPaths: string[];
  originalPhotoPaths?: string[];
  photoHashes?: HashedFile[];
}

export interface Job {
  id: string;
  /** Missing kind means a try-on (records created before packshots). */
  kind?: 'tryon' | 'packshot' | 'intake' | 'analyze' | 'shopsearch' | 'advise' | 'storefind' | 'discover' | 'wearreview';
  lookId?: string;
  /** wearreview: the worn look whose real photos are read. */
  wearId?: string;
  /** intake: uploaded photos to recognise. */
  inputPhotoIds?: string[];
  /** intake: wardrobe candidates created from the photo. */
  createdItemIds?: string[];
  /** Existing items an upload was attached to (shown and linked so nothing disappears silently). */
  attachedItemIds?: string[];
  /** analyze: the selection created. */
  capsuleId?: string;
  /** analyze ("Доповнити образ"): items every proposed look must contain. */
  requiredItemIds?: string[];
  itemId?: string;
  needId?: string;
  photoId?: string;
  lookVersion: number;
  snapshot: {
    lookName: string;
    slots: SnapshotSlot[];
    basePhotoIds: string[];
    basePhotoPaths: string[];
    identity?: IdentityReference;
  };
  instructions: string;
  state: JobState;
  stateNote?: string;
  retryOf?: string;
  resultId?: string;
  origin: 'site' | 'import';
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  logPath?: string;
}

export interface Result {
  /** Owner removed this attempt from site display; original file/history remain local. */
  hiddenAt?: string;
  id: string;
  jobId: string;
  lookId: string;
  lookVersion: number;
  imagePath: string;
  tool: string;
  model: string;
  prompt: string;
  sources: string[];
  usedItemPhotos: boolean;
  notes?: string;
  review: ReviewState;
  reviewReason?: ReworkReason;
  reviewNote?: string;
  reviewedAt?: string;
  favorite: boolean;
  note?: string;
  createdAt: string;
}

export interface Comparison {
  id: string;
  resultA: string;
  resultB: string;
  note?: string;
  favorite: boolean;
  createdAt: string;
}

/** Where one difference between the real photo and the look comes from. */
export const WEAR_CAUSES = ['outfit', 'render', 'substitution', 'unknown'] as const;
export type WearCause = (typeof WEAR_CAUSES)[number];

export interface WearText {
  /** With a render: what matches; without: what the real clothing shows. */
  seen: string;
  differences: { cause: WearCause; text: string }[];
  /** One styling adjustment that is easy to try. */
  adjust: string;
}

/** The stylist's one read of a wear, in both interface languages; pinned to what it compared. */
export interface WearReview {
  uk: WearText;
  en: WearText;
  /** The render it compared with; absent when it read the real photos alone. */
  resultId?: string;
  at: string;
}

/**
 * «Додати мій образ»: one appearance in one saved look, one or more of the person's own photos.
 * It stays pinned to the look version and the render that were current when it was added.
 */
export interface Wear {
  id: string;
  lookId: string;
  lookVersion: number;
  photoIds: string[];
  /** The current-version render beside it; never changes after the wear is added. */
  resultId?: string;
  /** The client's key for this one action: a repeated request returns the same wear. */
  key: string;
  review?: WearReview;
  /** «Одягну знову?»: the person's own answer, apart from the stylist. */
  again?: boolean;
  createdAt: string;
}

export interface Measurement {
  value: number | null;
  date?: string;
}

export interface KnownSize {
  id: string;
  brand: string;
  category: Category;
  size: string;
  note?: string;
}

export interface Profile {
  rev: number;
  basePhotoIds: string[];
  identity?: IdentityReference;
  measurements: Record<MeasureKey, Measurement>;
  knownSizes: KnownSize[];
  /** «Мої бренди»: brands the owner wears; shop search looks there first. */
  brands?: string[];
  /** «Де шукати»: the owner's shopping place (city or mall); «Знайти» checks its stores first. Empty = online only. */
  location?: string;
  /** «Мої магазини»: shops the owner likes; checked first, at the place and online. */
  stores?: string[];
  /** «Моє місце» (owner, 20.11): the location the browser shared, rounded to about 1 km; searches measure from it. */
  coords?: { lat: number; lon: number; at: string };
  /** «Відстань»: how far physical stores may be, in km; 0 = online only; unset = any distance. */
  radiusKm?: number;
  preferences: { comfort: string; materials: string; fit: string; branding: string };
  /** Interface and reply language; unset = the browser's, then Ukrainian. */
  language?: Language;
  /** «Який одяг підбирати?»: what the stylist, searches and try-ons dress the person in; unset = any. */
  wardrobeFocus?: WardrobeFocus;
  /** First sign-in: «На фото я або людина, яка дала згоду. Мені 18+». */
  consentAt?: string;
  /** Weather periods follow the hemisphere; unset = northern. */
  hemisphere?: 'north' | 'south';
  /** Whether glasses/sunglasses may be used in looks and suggestions; unset/false keeps them out. */
  allowEyewear?: boolean;
}

export const LANGUAGES = ['uk', 'en'] as const;
export type Language = (typeof LANGUAGES)[number];
export const WARDROBE_FOCUS = ['men', 'women', 'any'] as const;
export type WardrobeFocus = (typeof WARDROBE_FOCUS)[number];

export interface Settings {
  codexModel: string;
  reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh';
  tailscaleLogin: string;
  concurrency?: number;
}

/** Advisor proposal: a new look or a new capsule from owned items, added only on the owner's «Додати». */
export interface Suggestion {
  id: string;
  kind: 'look' | 'capsule';
  status: 'open' | 'accepted' | 'rejected';
  name: string;
  why: string;
  capsuleId?: string | null;
  season?: Season;
  /** `buy`: pieces to buy for the look (search for new looks, owner 19.11) — they become purchases only on «Додати». */
  looks: { name: string; why: string; slots: Slots; buy?: { slot: SlotKey; title: string; category: Category; /** A piece of the capsule's closed set this purchase replaces (owner, 20.11). */ replaces?: string }[] }[];
  /** «search»: a result of «Нові» (owner, 19.11); otherwise an advisor proposal. */
  source?: 'search';
  jobId: string;
  createdAt: string;
  decidedAt?: string;
}

export interface DB {
  schemaVersion: number;
  revision: number;
  updatedAt: string;
  photos: Photo[];
  items: Item[];
  needs: Need[];
  products: Product[];
  looks: Look[];
  capsules: Capsule[];
  jobs: Job[];
  results: Result[];
  comparisons: Comparison[];
  profile: Profile;
  settings: Settings;
  /** Advisor proposals (optional: older databases have none). */
  suggestions?: Suggestion[];
  /** Titles of advisor purchases the owner deleted: never proposed again. */
  declinedNeeds?: string[];
  /** Compositions of deleted looks (owner, 19.11): kept so no source ever proposes them, or anything within one piece, again. */
  lookMemory?: { slots: Slots; outcome: 'deleted'; ref: string; name: string; at: string }[];
  /** Where the nearest physical store of each shop is (owner, 19.11), keyed by the shop's plain name. */
  stores?: StorePlace[];
  /** Real photos of saved looks (optional: older databases have none). */
  wears?: Wear[];
}

export function emptySlots(): Slots {
  return { top: [], layer: [], bottom: [], shoes: [], accessories: [] };
}

const COLLECTIONS = ['photos', 'items', 'needs', 'products', 'looks', 'capsules', 'jobs', 'results', 'comparisons'] as const;

function isRelativeSafe(p: unknown): boolean {
  return typeof p === 'string' && p.length > 0 && !p.startsWith('/') && !p.split(/[\\/]/).includes('..');
}

/** Returns a human-readable error, or null when the database is valid. */
export function validateDb(db: unknown): string | null {
  if (!db || typeof db !== 'object') return 'База не є обʼєктом';
  const d = db as DB;
  if (d.schemaVersion !== SCHEMA_VERSION) return `Непідтримувана версія схеми: ${String(d.schemaVersion)}`;
  if (typeof d.revision !== 'number') return 'Немає ревізії';
  const ids = new Map<string, Set<string>>();
  for (const c of COLLECTIONS) {
    const list = d[c];
    if (!Array.isArray(list)) return `Колекція ${c} відсутня`;
    const set = new Set<string>();
    for (const e of list as { id: string }[]) {
      if (!e || typeof e.id !== 'string' || !e.id) return `${c}: запис без id`;
      if (set.has(e.id)) return `${c}: повторний id ${e.id}`;
      set.add(e.id);
    }
    ids.set(c, set);
  }
  const has = (c: (typeof COLLECTIONS)[number], id: string) => ids.get(c)!.has(id);
  for (const p of d.photos) {
    if (!PHOTO_KINDS.includes(p.kind)) return `Фото ${p.id}: невідомий тип`;
    if (!isRelativeSafe(p.path)) return `Фото ${p.id}: недозволений шлях`;
    if (p.originalPath && !isRelativeSafe(p.originalPath)) return `Фото ${p.id}: недозволений шлях оригіналу`;
    if (p.referenceRole && (p.referenceRole !== 'face' || p.source === 'generated' || p.inspiration)) return `Фото ${p.id}: референс обличчя повинен бути власним оригіналом`;
    if (p.kind === 'worn' && (p.source !== 'upload' || p.referenceRole || p.inspiration)) return `Фото ${p.id}: фото образу повинно бути власним завантаженням`;
  }
  const worn = new Set(d.photos.filter((p) => p.kind === 'worn').map((p) => p.id));
  if (d.wears !== undefined) {
    if (!Array.isArray(d.wears)) return 'Колекція wears пошкоджена';
    const seen = new Set<string>();
    for (const w of d.wears) {
      if (!w || typeof w.id !== 'string' || !w.id || seen.has(w.id)) return 'wears: запис без id або повторний id';
      seen.add(w.id);
      const look = d.looks.find((l) => l.id === w.lookId);
      if (!look) return `Образ у житті ${w.id}: немає образу`;
      if (!Number.isInteger(w.lookVersion) || !look.versions.some((v) => v.version === w.lookVersion)) return `Образ у житті ${w.id}: немає версії образу`;
      if (!Array.isArray(w.photoIds) || !w.photoIds.length || w.photoIds.some((id) => !worn.has(id))) return `Образ у житті ${w.id}: потрібні власні фото`;
      if (w.resultId && !has('results', w.resultId)) return `Образ у житті ${w.id}: немає рендера`;
      if (w.review?.resultId && w.review.resultId !== w.resultId) return `Образ у житті ${w.id}: розбір іншого рендера`;
      if (w.again !== undefined && typeof w.again !== 'boolean') return `Образ у житті ${w.id}: некоректна відповідь`;
    }
  }
  for (const i of d.items) {
    if (!CATEGORIES.includes(i.category)) return `Річ ${i.id}: невідома категорія`;
    if (i.sport !== undefined && typeof i.sport !== 'boolean') return `Річ ${i.id}: некоректна категорія «Спорт»`;
    if (!ITEM_STATUSES.includes(i.status)) return `Річ ${i.id}: невідомий статус`;
    if (!i.title?.trim()) return `Річ ${i.id}: порожня назва`;
    for (const pid of i.photoIds) if (!has('photos', pid)) return `Річ ${i.id}: немає фото ${pid}`;
    if (i.packshotId && !has('photos', i.packshotId)) return `Річ ${i.id}: немає packshot`;
    if (i.tryonReference) {
      const crop = i.tryonReference;
      if (!validHashedFile(crop) || !validHashedFile(crop.source) || !i.photoIds.some((id) => d.photos.some((p) => p.id === id && p.path === crop.source.path && p.source !== 'generated' && !p.inspiration))) return `Річ ${i.id}: некоректний кроп власного оригіналу`;
    }
  }
  for (const n of d.needs) {
    if (!CATEGORIES.includes(n.category)) return `Потреба ${n.id}: невідома категорія`;
    if (n.conceptPhotoId && !has('photos', n.conceptPhotoId)) return `Потреба ${n.id}: немає концепт-фото`;
    if (n.coveredByItem && !has('items', n.coveredByItem)) return `Потреба ${n.id}: немає речі, що її закриває`;
    for (const id of n.coveredLookIds ?? []) if (!has('looks', id)) return `Потреба ${n.id}: немає образу ${id}`;
  }
  for (const p of d.products) {
    if (!has('needs', p.needId)) return `Товар ${p.id}: немає потреби ${p.needId}`;
    if (p.photoId && !has('photos', p.photoId)) return `Товар ${p.id}: немає фото`;
    if (p.purchasedItemId && !has('items', p.purchasedItemId)) return `Товар ${p.id}: немає речі покупки`;
  }
  const refOk = (r: SlotRef) =>
    (r.kind === 'item' && has('items', r.id)) || (r.kind === 'need' && has('needs', r.id)) || (r.kind === 'product' && has('products', r.id));
  for (const l of d.looks) {
    if (l.capsuleId && !has('capsules', l.capsuleId)) return `Образ ${l.id}: немає капсули`;
    for (const k of SLOT_KEYS) {
      if (!Array.isArray(l.slots?.[k])) return `Образ ${l.id}: немає слота ${k}`;
      for (const r of l.slots[k]) if (!refOk(r)) return `Образ ${l.id}: битий звʼязок ${r.kind}:${r.id}`;
    }
    if (!l.versions.some((v) => v.version === l.version)) return `Образ ${l.id}: немає поточної версії`;
    if (l.disliked !== undefined && typeof l.disliked !== 'boolean') return `Образ ${l.id}: некоректна оцінка`;
    if (l.disliked && l.favorite) return `Образ ${l.id}: лайк і дизлайк одночасно`;
  }
  for (const c of d.capsules) {
    if (!SEASONS.includes(c.season)) return `Капсула ${c.id}: невідомий сезон`;
    for (const lid of c.lookIds) if (!has('looks', lid)) return `Капсула ${c.id}: немає образу ${lid}`;
    if (c.disliked !== undefined && typeof c.disliked !== 'boolean') return `Капсула ${c.id}: некоректна оцінка`;
    if (c.disliked && c.favorite) return `Капсула ${c.id}: лайк і дизлайк одночасно`;
    if (c.base && !c.pieces) return `Капсула ${c.id}: база без набору`;
    if (c.accessoryLimit !== undefined && c.accessoryLimit !== 4) return `Капсула ${c.id}: некоректний ліміт аксесуарів`;
    if (c.pieces !== undefined) {
      if (!Array.isArray(c.pieces) || (c.base !== undefined && !Array.isArray(c.base))) return `Капсула ${c.id}: некоректний набір`;
      const err = pieceSetError(d, c.pieces, c.base ?? [], c);
      if (err) return `Капсула ${c.id}: ${err}`;
    }
  }
  for (const j of d.jobs) {
    if (!JOB_STATES.includes(j.state)) return `Завдання ${j.id}: невідомий стан`;
    if ((j.kind ?? 'tryon') === 'tryon' && !(j.lookId && has('looks', j.lookId))) return `Завдання ${j.id}: немає образу`;
    if (j.kind === 'packshot' && !((j.itemId && has('items', j.itemId)) || (j.needId && has('needs', j.needId)))) return `Завдання ${j.id}: немає речі`;
    if (j.kind === 'shopsearch' && !(j.needId && has('needs', j.needId))) return `Завдання ${j.id}: немає покупки`;
    if (j.photoId && !has('photos', j.photoId)) return `Завдання ${j.id}: немає фото результату`;
    if (j.kind === 'wearreview' && !(j.wearId && d.wears?.some((w) => w.id === j.wearId))) return `Завдання ${j.id}: немає образу в житті`;
    if (j.kind === 'intake' && !(j.inputPhotoIds?.length && j.inputPhotoIds.every((p) => has('photos', p)))) return `Завдання ${j.id}: немає фото для розпізнавання`;
    for (const id of j.createdItemIds ?? []) if (!has('items', id)) return `Завдання ${j.id}: немає створеної речі ${id}`;
    for (const id of j.attachedItemIds ?? []) if (!has('items', id)) return `Завдання ${j.id}: немає речі ${id}`;
    if (j.capsuleId && !has('capsules', j.capsuleId)) return `Завдання ${j.id}: немає підбірки`;
    for (const id of j.requiredItemIds ?? []) if (!has('items', id)) return `Завдання ${j.id}: немає речі ${id}`;
    if (j.retryOf && !has('jobs', j.retryOf)) return `Завдання ${j.id}: немає попередньої спроби`;
    if (j.resultId && !has('results', j.resultId)) return `Завдання ${j.id}: немає результату`;
    if (j.snapshot.identity && !validIdentity(j.snapshot.identity)) return `Завдання ${j.id}: некоректний оригінал зовнішності`;
  }
  for (const r of d.results) {
    if (!has('jobs', r.jobId)) return `Результат ${r.id}: немає завдання`;
    if (!REVIEW_STATES.includes(r.review)) return `Результат ${r.id}: невідомий стан перевірки`;
    if (!isRelativeSafe(r.imagePath)) return `Результат ${r.id}: недозволений шлях`;
  }
  for (const c of d.comparisons) {
    if (!has('results', c.resultA) || !has('results', c.resultB)) return `Порівняння ${c.id}: немає результату`;
  }
  if (!d.profile || !Array.isArray(d.profile.basePhotoIds)) return 'Профіль пошкоджений';
  for (const pid of d.profile.basePhotoIds) if (!has('photos', pid)) return `Профіль: немає базового фото ${pid}`;
  if (d.profile.basePhotoIds.some((pid) => worn.has(pid))) return 'Профіль: фото образу не може бути базовим';
  if (d.profile.identity) {
    const ref = d.profile.identity;
    const p = d.photos.find((p) => p.id === ref.sourcePhotoId);
    if (!validIdentity(ref) || !p || p.source === 'generated' || p.inspiration || p.kind === 'worn' || ref.original.path !== p.path) return 'Профіль: зовнішність повинна походити з власного оригіналу';
    const originalPhoto = (file: HashedFile) => d.photos.some((p) => p.source !== 'generated' && !p.inspiration && p.path === file.path);
    if (ref.bodyOriginal && !originalPhoto(ref.bodyOriginal)) return 'Профіль: статура повинна походити з власного оригіналу';
    if (ref.hair && !d.photos.some((p) => p.id === ref.hair!.sourcePhotoId && p.source !== 'generated' && !p.inspiration && p.path === ref.hair!.original.path)) return 'Профіль: зачіска повинна походити з власного оригіналу';
  }
  for (const k of MEASURE_KEYS) if (!d.profile.measurements?.[k]) return `Профіль: немає мірки ${k}`;
  if (d.profile.language !== undefined && !LANGUAGES.includes(d.profile.language)) return 'Профіль: невідома мова';
  if (d.profile.wardrobeFocus !== undefined && !WARDROBE_FOCUS.includes(d.profile.wardrobeFocus)) return 'Профіль: невідомий гардероб';
  if (d.profile.hemisphere !== undefined && d.profile.hemisphere !== 'north' && d.profile.hemisphere !== 'south') return 'Профіль: невідома півкуля';
  if (!d.settings?.codexModel) return 'Налаштування: немає моделі Codex';
  return null;
}
