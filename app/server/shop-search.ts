// Shop search (owner, 17.11): for one shopping recommendation, Codex searches the web — the stores at
// the owner's place (Profile → Магазини) and the owner's stores first, then the brands' own stores — and returns
// 2–4 real products with a match score against the recommendation, its looks and the owner's taste.
// Results are dated options, never availability promises; product photos are fetched by the server.
import fs from 'node:fs';
import dns from 'node:dns/promises';
import net from 'node:net';
import path from 'node:path';
import type { DB, Job, Product, StorePlace } from './schema.ts';
import { newId, now } from './store.ts';
import { detectImageType } from './media.ts';
import { siteLooks, wardrobeBrands, missingNeeds, resolveRef, shopLocation, shopStores } from '../src/lib.ts';
import { brandKey, sizeEvidence, sizingBrands } from '../src/brand-sizes.ts';
import { sizeGuides } from '../src/size-guides.ts';
import { placeCountry, replyLanguage, shopSection } from './person.ts';

const str = { type: 'string' } as const;

export const SHOP_SEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'reason', 'products'],
  properties: {
    status: { type: 'string', enum: ['done', 'error'] },
    reason: str,
    products: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['store', 'brand', 'model', 'sku', 'url', 'imageUrl', 'price', 'currency', 'inTower', 'size', 'sizeBasis', 'matchScore', 'matchNote'],
        properties: { store: str, brand: str, model: str, sku: str, url: str, imageUrl: str, price: str, currency: str, inTower: { type: 'boolean' }, size: str, sizeBasis: str, matchScore: { type: 'number' }, matchNote: str },
      },
    },
  },
};

export interface ShopReply {
  status: string;
  reason: string;
  products: { store: string; brand: string; model: string; sku?: string; url: string; imageUrl: string; price: string; currency: string; inTower: boolean; size: string; sizeBasis?: string; matchScore: number; matchNote: string }[];
}

// ── Stores (owner, 19.11): where the nearest physical store of each shop is ──────────────────────────
/** Shops whose place is not known yet (not at the owner's place and never looked up). */
export const storesToFind = (db: DB) => shopStores(db).filter((s) => !s.atPlace && !s.place);

export const STORE_FIND_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'reason', 'stores'],
  properties: {
    status: { type: 'string', enum: ['done', 'error'] },
    reason: str,
    stores: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['key', 'place', 'km', 'online', 'url'], properties: { key: str, place: str, km: { type: 'number' }, online: { type: 'boolean' }, url: str } } },
  },
};
export interface StoreReply {
  status: string;
  reason: string;
  stores: { key: string; place: string; km: number; online: boolean; url: string }[];
}

/** One store search at a time; new shops from later searches wait for the next one. */
export function queueStoreFind(db: DB): Job | null {
  if (!storesToFind(db).length || db.jobs.some((j) => j.kind === 'storefind' && (j.state === 'queued' || j.state === 'running'))) return null;
  const j: Job = { id: newId('J'), kind: 'storefind', lookVersion: 0, snapshot: { lookName: 'Магазини', slots: [], basePhotoIds: [], basePhotoPaths: [] }, instructions: '', state: 'queued', origin: 'site', createdAt: now() };
  db.jobs.push(j);
  return j;
}

/** Where the owner shops (owner, 20.11): the shared location or the named place, and how far a store may be. */
export function ownerWhere(db: DB) {
  const c = db.profile.coords;
  const place = shopLocation(db);
  const origin = c ? `the owner's shared location ${c.lat}, ${c.lon} (rounded to about 1 km)${place && !/моє місце/i.test(place) ? `, near «${place}»` : ''}` : `the owner's shopping place «${place}»`;
  const radius = db.profile.radiusKm;
  // An emptied place (and no shared location) still means online only, as before the distance choice existed.
  return { origin, radius, onlineOnly: radius === 0 || (!c && !place) };
}

/** Known sizes come from recorded item sizes or an explicit entry in the profile. */
export function ownerSizes(db: DB) {
  const out = new Map<string, string>();
  for (const row of sizeEvidence(db)) {
    const key = `${brandKey(row.brand)}:${row.category}:${row.size.trim().toUpperCase()}`;
    if (!out.has(key)) out.set(key, `${row.brand || 'unknown brand'} ${row.category}: ${row.size}`);
  }
  return [...out.values()];
}

export function storeFindPrompt(db: DB) {
  const { origin, radius } = ownerWhere(db);
  const limit = radius && radius > 0 ? radius : 300;
  return [
    // Worded like the shop search: the unattended worker refused a "store-finder" task as outside its sources (19.11).
    'You are the Capsula shop-search worker running unattended. Use live web search. Answer with JSON only (schema enforced).',
    `Find where the owner can buy in person. Measure from: ${origin}.`,
    `For each shop below, find the NEAREST place to that point where its clothes can be bought in person — the shop's own store or an official retailer that sells the brand, whichever is nearer. place: for a retailer its name first, then the mall or street and city, e.g. "Foot Locker, Westfield, London"; for an own store the mall or street and city, e.g. "Westfield Stratford, London". km: approximate road distance from that point, 0 if unknown. url: the store locator or store page you used. online: true when there is no such place within about ${limit} km (then place empty). Only facts you verified on the web; never invent a store.`,
    'Shops (key | name | website):',
    storesToFind(db).map((s) => `${s.key} | ${s.name} | ${s.host || '—'}`).join('\n'),
  ].join('\n');
}

export function applyStoreFind(db: DB, reply: StoreReply) {
  const at = now();
  const wanted = new Map(storesToFind(db).map((s) => [s.key, s] as const));
  const list: StorePlace[] = [...(db.stores ?? [])];
  let found = 0;
  for (const r of reply.stores ?? []) {
    const s = wanted.get(String(r.key || '').trim());
    if (!s) continue;
    const place = String(r.place || '').trim().slice(0, 120);
    const online = Boolean(r.online) || !place;
    const url = httpsUrl(String(r.url || '').trim())?.href;
    const km = Number(r.km);
    list.push({ key: s.key, name: s.name, place: online ? '' : place, km: !online && km > 0 ? Math.round(km) : undefined, online, url, checkedAt: at });
    wanted.delete(s.key);
    if (!online) found += 1;
  }
  db.stores = list;
  return `Магазини: знайдено ${found}${wanted.size ? `, без відповіді ${wanted.size}` : ''}`;
}

/** The owner's brands: the saved list, or what the wardrobe shows until the owner edits it. */
export const ownerBrands = (db: DB) => db.profile.brands ?? wardrobeBrands(db);

const plain = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/** A product the owner dropped is the same product under another link: same store and name. */
export const productKey = (store: string, name: string) => `${plain(store)}|${plain(name)}`;
/** A link without its tracking/colour parameters, for "already found or dropped". */
const linkKey = (href: string) => {
  try {
    const u = new URL(href);
    return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return href;
  }
};

export function shopSearchPrompt(db: DB, job: Job) {
  const need = db.needs.find((n) => n.id === job.needId)!;
  const prefs = db.profile.preferences;
  const where = ownerWhere(db);
  // Links the owner dropped with × count as found: a new search never brings them back.
  const known = [...db.products.filter((p) => p.needId === need.id && p.url).map((p) => p.url!), ...(need.droppedUrls ?? [])];
  const sizes = ownerSizes(db).join('; ');
  const measures = db.profile.measurements;
  const measureKeys = need.category === 'shoes' ? ['foot'] as const
    : need.category === 'trousers' || need.category === 'shorts' ? ['waist', 'hips', 'inseam'] as const
      : ['chest', 'waist', 'hips'] as const;
  const body = measureKeys.flatMap((key) => measures[key].value == null ? [] : [`${key} ${measures[key].value} cm`]).join(', ');
  const focus = db.profile.wardrobeFocus ?? 'men';
  const guides = sizingBrands(db).flatMap((brand) => {
    const urls = [...new Set(sizeGuides(brand, focus)
      .filter((guide) => guide.categories.includes(need.category) && (focus !== 'any' || guide.focus === 'unisex'))
      .map((guide) => guide.url))];
    return urls.length ? [`${brand}: ${urls.join(', ')}`] : [];
  }).join('; ');
  const looks = siteLooks(db)
    .filter((l) => missingNeeds(db, l).includes(need.id))
    .map((l) => `- ${l.name}: ${Object.values(l.slots).flat().filter((r) => !(r.kind === 'need' && r.id === need.id)).map((r) => resolveRef(db, r).title).join(', ')}`);
  return [
    'You are the Capsula shop-search worker running unattended. Use live web search. Answer with JSON only (schema enforced).',
    `Find 2 to 4 products the owner can buy now that fulfil this shopping recommendation, in the shops' ${shopSection(db)} sections.`,
    `Recommendation: ${need.title} — ${need.description}`,
    need.why ? `Why it is recommended: ${need.why}` : '',
    need.fitCheck ? `Fit to check: ${need.fitCheck}` : '',
    `Owner's brands (search these first): ${ownerBrands(db).join(', ') || '—'}.`,
    db.profile.stores?.length ? `Owner's stores (check these first): ${db.profile.stores.join(', ')}.` : '',
    where.onlineOnly
      ? `Where: only the official online stores of the owner's stores and brands that ship to ${placeCountry(db) || "the owner's country"} (the owner buys online only). Other shops only if nothing suitable is found there.`
      : `Where: first physical stores ${where.radius ? `within ${where.radius} km of` : 'near'} ${where.origin} — check which stores are there (the owner's stores first) and whether they sell such a piece; then the official online stores of the owner's stores and brands that ship to ${placeCountry(db) || "the owner's country"}. Other shops only if nothing suitable is found there.`,
    `Owner's taste — comfort: ${prefs.comfort || '—'}; materials: ${prefs.materials || '—'}; fit: ${prefs.fit || '—'}; branding: ${prefs.branding || '—'}.`,
    sizes ? `Known sizes: ${sizes}.` : '',
    body ? `Measured body dimensions: ${body}. Use these only to compare in private, never in web search queries.` : '',
    need.category === 'shoes' && db.profile.shoeSizeEu ? `Usual shoe size: EU ${db.profile.shoeSizeEu}; this is an EU label, not foot length or a confirmed size for every brand.` : '',
    guides ? `Official brand guide URLs to verify corresponding sizes: ${guides}.` : '',
    looks.length ? `Looks this piece would complete (with their other pieces):\n${looks.join('\n')}` : '',
    known.length ? `Already found (do not return these again; find different ones): ${known.join(' ')}` : '',
    `Rules: only real products listed right now, each with its direct product page URL and a direct https image URL of the product taken from that page. Never invent products, prices, URLs or images; leave out anything you could not verify. model: the model name and colour as shown to shoppers, without article numbers or colour codes; sku: the article number if shown, else empty. price: the number with a decimal point as text, empty if unknown; currency: ISO code. inTower: true only when the store is at the owner's shopping place. matchScore 0–10: colour, cut, material and style against the recommendation, the looks and the taste; use distinct scores so the best one is clear. matchNote: one short ${replyLanguage(db)} sentence why. Best first.`,
    `Sizing: use the recorded size for the same brand and category as the starting point, or compare the relevant body measurements with a verified model or brand guide. Preserve the original label system, including W/L and EU. Distinguish body measurements from garment measurements and foot length from shoe size. Return size and a short ${replyLanguage(db)} sizeBasis explaining the evidence. Leave both empty if evidence is insufficient.`,
    `Return status "error" only if web search is unavailable; if nothing suitable exists, status "done" with an empty list and the reason in ${replyLanguage(db)}.`,
    job.instructions ? `Owner note: ${job.instructions}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

const httpsUrl = (u: string) => {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' ? x : null;
  } catch {
    return null;
  }
};

/** Saves the found products as dated options of the recommendation; returns the photos to fetch. */
export function applyShopSearch(db: DB, job: Job, reply: ShopReply) {
  const need = db.needs.find((n) => n.id === job.needId);
  const at = now();
  const created: string[] = [];
  const images: { productId: string; url: string }[] = [];
  if (!need) return { created, images, note: 'Покупку не знайдено' };
  const known = new Set([...db.products.filter((p) => p.needId === need.id && p.url).map((p) => p.url!), ...(need.droppedUrls ?? [])].map(linkKey));
  const dropped = new Set(need.droppedModels ?? []);
  for (const r of (reply.products ?? []).slice(0, 4)) {
    const url = httpsUrl(String(r.url || '').trim());
    const store = String(r.store || '').trim().slice(0, 80);
    // Article numbers stay out of the name the owner sees: «Spezial Brown (JQ1740)» → name + sku.
    const code = /\s*\((?=[^)]*\d)([A-Z0-9][A-Z0-9 /.-]{3,})\)\s*$/.exec(String(r.model || ''));
    const model = String(r.model || '').replace(code?.[0] ?? '', '').trim().slice(0, 160);
    const sku = String(r.sku || '').trim().slice(0, 60) || code?.[1];
    if (!url || !store || !model || known.has(linkKey(url.href)) || dropped.has(productKey(store, `${String(r.brand || '').trim()} ${model}`))) continue;
    known.add(linkKey(url.href));
    const price = Number(String(r.price || '').replace(',', '.'));
    const p: Product = {
      id: newId('S'),
      rev: 1,
      needId: need.id,
      store,
      brand: String(r.brand || '').trim().slice(0, 80),
      model,
      sku: sku || undefined,
      url: url.href,
      price: String(r.price || '').trim() && Number.isFinite(price) ? price : null,
      currency: String(r.currency || '').trim().slice(0, 8) || undefined,
      recommendedSize: String(r.size || '').trim().slice(0, 40) || undefined,
      sizeBasis: String(r.sizeBasis || '').trim().slice(0, 300) || undefined,
      onlineAvailability: 'unknown',
      towerAvailability: r.inTower ? 'confirmed' : 'unknown',
      checkedAt: at.slice(0, 10),
      sources: `Пошук ${at.slice(0, 10)}`,
      matchScore: Math.max(0, Math.min(10, Math.round(Number(r.matchScore) || 0))),
      matchNote: String(r.matchNote || '').trim().slice(0, 240) || undefined,
      status: 'option',
      createdAt: at,
      updatedAt: at,
    };
    db.products.push(p);
    created.push(p.id);
    const img = httpsUrl(String(r.imageUrl || '').trim());
    if (img) images.push({ productId: p.id, url: img.href });
  }
  const note = created.length ? `Знайдено варіантів: ${created.length}` : reply.reason || 'Нічого відповідного не знайдено';
  return { created, images, note };
}

const PRIVATE_HOST = /^(localhost|0\.)|\.local$|\.internal$|\.ts\.net$/i;

/** Loopback, private, link-local, carrier-grade NAT (tailnet) and unique-local addresses are never fetched. */
function privateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return privateAddress(v.slice(7));
  return v === '::' || v === '::1' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v);
}

async function publicUrl(u: URL) {
  if (u.protocol !== 'https:' || PRIVATE_HOST.test(u.hostname)) return false;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return !privateAddress(host);
  try {
    const all = await dns.lookup(host, { all: true });
    return all.length > 0 && all.every((x) => !privateAddress(x.address));
  } catch {
    return false;
  }
}

const MAX_PHOTO = 8 * 1024 * 1024;

/** Reads a response body up to `limit` bytes, aborting early if a chunked stream exceeds it. */
export async function readCapped(res: Response, limit: number): Promise<Buffer | null> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, total);
  } finally {
    reader.releaseLock();
  }
}

/** Fetches a product photo from a public https address; returns the saved file (relative) or null. */
export async function fetchProductImage(projectRoot: string, dataDir: string, id: string, url: string): Promise<string | null> {
  let u = httpsUrl(url);
  try {
    let res: Response | null = null;
    // Every redirect is checked again before it is followed (at most 3).
    for (let hop = 0; u && hop <= 3; hop += 1) {
      if (!(await publicUrl(u))) return null;
      res = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'Mozilla/5.0 (Capsula product photo)' } });
      if (res.status < 300 || res.status >= 400) break;
      const next = res.headers.get('location');
      u = next ? httpsUrl(new URL(next, u).href) : null;
      res = null;
    }
    if (!res || !res.ok || !String(res.headers.get('content-type') ?? '').startsWith('image/')) return null;
    if (Number(res.headers.get('content-length') ?? 0) > MAX_PHOTO) return null;
    const buf = await readCapped(res, MAX_PHOTO);
    if (!buf || buf.length > MAX_PHOTO) return null;
    const type = detectImageType(buf);
    if (!type || type === 'heic') return null;
    const dir = path.join(dataDir, 'media', 'products');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.${type}`);
    fs.writeFileSync(file, buf);
    return path.relative(projectRoot, file);
  } catch {
    return null;
  }
}
