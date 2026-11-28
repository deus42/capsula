// Shop search (owner, 17.11): for one shopping recommendation, Codex searches the web — the stores at
// the owner's place (Profile → Магазини) and the owner's stores first, then the brands' own stores — and returns
// 2–4 real products with a match score against the recommendation, its looks and the owner's taste.
// Results are dated options, never availability promises; product photos are fetched by the server.
import fs from 'node:fs';
import sharp from 'sharp';
import dns from 'node:dns/promises';
import https from 'node:https';
import type { Readable } from 'node:stream';
import net from 'node:net';
import path from 'node:path';
import type { DB, Job, Product, StorePlace } from './schema.ts';
import { newId, now } from './store.ts';
import { detectImageType } from './media.ts';
import { siteLooks, wardrobeBrands, missingNeeds, resolveRef, shopLocation, shopStores } from '../src/lib.ts';
import { brandKey, sizeEvidence, sizingBrands } from '../src/brand-sizes.ts';
import { sizeGuides } from '../src/size-guides.ts';
import { placeCountry, replyLanguage, shopSection } from './person.ts';
import { FIT_LABEL, fitPromptBlock, violatesAvoidedFit } from './fit.ts';

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
        required: ['store', 'brand', 'model', 'sku', 'url', 'imageUrl', 'price', 'currency', 'inTower', 'size', 'sizeBasis', 'fit', 'matchScore', 'matchNote'],
        properties: { store: str, brand: str, model: str, sku: str, url: str, imageUrl: str, price: str, currency: str, inTower: { type: 'boolean' }, size: str, sizeBasis: str, fit: str, matchScore: { type: 'number' }, matchNote: str },
      },
    },
  },
};

export interface ShopReply {
  status: string;
  reason: string;
  products: { store: string; brand: string; model: string; sku?: string; url: string; imageUrl: string; price: string; currency: string; inTower: boolean; size: string; sizeBasis?: string; fit?: string; matchScore: number; matchNote: string }[];
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
  const fit = db.profile.fitProfile;
  const garment = need.category !== 'shoes' && need.category !== 'accessories';
  const fitRules = garment ? fitPromptBlock(db) : '';
  const looks = siteLooks(db)
    .filter((l) => missingNeeds(db, l).includes(need.id))
    .map((l) => `- ${l.name}: ${Object.values(l.slots).flat().filter((r) => !(r.kind === 'need' && r.id === need.id)).map((r) => resolveRef(db, r).title).join(', ')}`);
  return [
    'You are the Capsula shop-search worker running unattended. Use live web search. Answer with JSON only (schema enforced).',
    `Find 2 to 4 products the owner can buy now that fulfil this shopping recommendation, in the shops' ${shopSection(db)} sections.`,
    `Recommendation: ${need.title}${need.description ? ` — ${need.description}` : ''}`,
    need.why ? `Why it is recommended: ${need.why}` : '',
    need.fitCheck ? `Fit to check: ${need.fitCheck}` : '',
    `Owner's brands (search these first): ${ownerBrands(db).join(', ') || '—'}.`,
    db.profile.stores?.length ? `Owner's stores (check these first): ${db.profile.stores.join(', ')}.` : '',
    where.onlineOnly
      ? `Where: only the official online stores of the owner's stores and brands that ship to ${placeCountry(db) || "the owner's country"} (the owner buys online only). Other shops only if nothing suitable is found there.`
      : `Where: first physical stores ${where.radius ? `within ${where.radius} km of` : 'near'} ${where.origin} — check which stores are there (the owner's stores first) and whether they sell such a piece; then the official online stores of the owner's stores and brands that ship to ${placeCountry(db) || "the owner's country"}. Other shops only if nothing suitable is found there.`,
    `Owner's taste — comfort: ${prefs.comfort || '—'}; materials: ${prefs.materials || '—'}; fit: ${prefs.fit || '—'}; branding: ${prefs.branding || '—'}.`,
    fitRules,
    fitRules && fit?.preferred.length ? `Put the preferred cut in your search queries (e.g. "${FIT_LABEL[fit.preferred[0]]} fit ${need.title}").` : '',
    fitRules && fit?.avoid.length ? `Strictly exclude products whose cut is ${fit.avoid.map((f) => FIT_LABEL[f]).join(', ')} (including "Classic Fit" or "Comfort Fit" names for Regular or Relaxed). Verify the cut on the product page before returning it; leave out a product whose cut you cannot verify.` : '',
    sizes ? `Known sizes: ${sizes}.` : '',
    body ? `Measured body dimensions: ${body}. Use these only to compare in private, never in web search queries.` : '',
    need.category === 'shoes' && db.profile.shoeSizeEu ? `Usual shoe size: EU ${db.profile.shoeSizeEu}; this is an EU label, not foot length or a confirmed size for every brand.` : '',
    guides ? `Official brand guide URLs to verify corresponding sizes: ${guides}.` : '',
    looks.length ? `Looks this piece would complete (with their other pieces):\n${looks.join('\n')}` : '',
    known.length ? `Already found (do not return these again; find different ones): ${known.join(' ')}` : '',
    `Rules: only real products listed right now, each with its direct product page URL and a direct https image URL of the product taken from that page. Never invent products, prices, URLs or images; leave out anything you could not verify. model: the model name and colour as shown to shoppers, without article numbers or colour codes; sku: the article number if shown, else empty. price: the number with a decimal point as text, empty if unknown; currency: ISO code. inTower: true only when the store is at the owner's shopping place. matchScore 0–10: colour, cut, material and style against the recommendation, the looks and the taste; use distinct scores so the best one is clear. matchNote: one short ${replyLanguage(db)} sentence why. Best first.`,
    `fit: the cut exactly as the product page states it (e.g. "Slim Fit", "Tapered", "Regular Fit"); empty for shoes and accessories or when the page states none.`,
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
  const images: { productId: string; url: string; productUrl?: string }[] = [];
  if (!need) return { created, images, note: 'Покупку не знайдено' };
  const known = new Set([...db.products.filter((p) => p.needId === need.id && p.url).map((p) => p.url!), ...(need.droppedUrls ?? [])].map(linkKey));
  const dropped = new Set(need.droppedModels ?? []);
  let offFit = 0;
  for (const r of (reply.products ?? []).slice(0, 6)) {
    if (created.length >= 4) break;
    const url = httpsUrl(String(r.url || '').trim());
    const store = String(r.store || '').trim().slice(0, 80);
    // Article numbers stay out of the name the owner sees: «Spezial Brown (JQ1740)» → name + sku.
    const code = /\s*\((?=[^)]*\d)([A-Z0-9][A-Z0-9 /.-]{3,})\)\s*$/.exec(String(r.model || ''));
    const model = String(r.model || '').replace(code?.[0] ?? '', '').trim().slice(0, 160);
    const sku = String(r.sku || '').trim().slice(0, 60) || code?.[1];
    if (!url || !store || !model || known.has(linkKey(url.href)) || dropped.has(productKey(store, `${String(r.brand || '').trim()} ${model}`))) continue;
    const fit = String(r.fit || '').trim().slice(0, 60);
    // A cut the owner never wears is dropped here too, whatever the score.
    if (violatesAvoidedFit(fit, `${String(r.brand || '')} ${model}`, need.category, db.profile.fitProfile)) {
      offFit += 1;
      continue;
    }
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
      fit: fit || undefined,
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
    // Without a usable image address the product page's own share image is tried.
    const img = httpsUrl(String(r.imageUrl || '').trim());
    images.push({ productId: p.id, url: img?.href ?? '', productUrl: url.href });
  }
  const note = created.length ? `Знайдено варіантів: ${created.length}` : offFit ? 'Знайдені варіанти не того крою' : reply.reason || 'Нічого відповідного не знайдено';
  return { created, images, note };
}

const PRIVATE_HOST = /^(localhost|0\.)|\.local$|\.internal$|\.ts\.net$/i;

/** IPv6 text → eight 16-bit groups (an embedded dotted IPv4 tail included); null when malformed. */
function ipv6Groups(ip: string): number[] | null {
  let v = ip.toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v);
  if (dotted) {
    if (!net.isIPv4(dotted[1])) return null;
    const [a, b, c, d] = dotted[1].split('.').map(Number);
    v = `${v.slice(0, -dotted[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = v.split('::');
  if (halves.length > 2) return null;
  const part = (s: string) => (s ? s.split(':') : []);
  const head = part(halves[0]);
  const tail = halves.length === 2 ? part(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

const v4From = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/**
 * Loopback, private, link-local, carrier-grade NAT (tailnet), unique-local, multicast and reserved addresses are
 * never fetched — also when an IPv4 address hides inside IPv6 (mapped, compatible, NAT64, 6to4) in any spelling.
 */
export function privateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b, c] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) || a >= 224;
  }
  const g = ipv6Groups(ip);
  if (!g) return true;
  const zeros = (n: number) => g.slice(0, n).every((x) => x === 0);
  // ::, ::1, and IPv4-compatible ::a.b.c.d
  if (zeros(6)) return (g[6] === 0 && g[7] <= 1) || privateAddress(v4From(g[6], g[7]));
  // ::ffff:a.b.c.d (mapped) and ::ffff:0:a.b.c.d (translated)
  if (zeros(5) && g[5] === 0xffff) return privateAddress(v4From(g[6], g[7]));
  if (zeros(4) && g[4] === 0xffff && g[5] === 0) return privateAddress(v4From(g[6], g[7]));
  // NAT64 64:ff9b::/96 carries an IPv4 address; 64:ff9b:1::/48 is local-use.
  if (g[0] === 0x64 && g[1] === 0xff9b) return g[2] === 1 || !g.slice(2, 6).every((x) => x === 0) || privateAddress(v4From(g[6], g[7]));
  // 6to4 2002:aabb:ccdd::/16 carries an IPv4 address.
  if (g[0] === 0x2002) return privateAddress(v4From(g[1], g[2]));
  // Teredo 2001:0::/32 and documentation 2001:db8::/32.
  if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8)) return true;
  // fc00::/7 unique-local, fe80::/10 link-local, fec0::/10 site-local, ff00::/8 multicast.
  return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0 || (g[0] & 0xff00) === 0xff00;
}

type LookupAll = (host: string, options: { all: true }) => Promise<{ address: string; family: number }[]>;
const systemLookup: LookupAll = (host, options) => dns.lookup(host, options);

/** The one address a fetch may connect to: every address the name resolves to must be public (no rebinding to a private one). */
export async function publicAddress(u: URL, lookup: LookupAll = systemLookup): Promise<{ address: string; family: number } | null> {
  if (u.protocol !== 'https:' || PRIVATE_HOST.test(u.hostname)) return null;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const literal = net.isIP(host);
  if (literal) return privateAddress(host) ? null : { address: host, family: literal };
  try {
    const all = await lookup(host, { all: true });
    if (!all.length || all.some((x) => privateAddress(x.address))) return null;
    return { address: all[0].address, family: all[0].family };
  } catch {
    return null;
  }
}

/** A socket lookup that always answers with the address already checked, whatever the name resolves to now. */
export function pinnedLookup(addr: { address: string; family: number }) {
  return ((_host: string, options: unknown, callback?: unknown) => {
    const cb = (typeof options === 'function' ? options : callback) as (...args: unknown[]) => void;
    if (typeof options === 'object' && options && (options as { all?: boolean }).all) cb(null, [{ address: addr.address, family: addr.family }]);
    else cb(null, addr.address, addr.family);
  }) as unknown as net.LookupFunction;
}

export interface PublicResponse {
  status: number;
  /** The address of this hop (after redirects). */
  url: string;
  headers: { contentType: string; contentLength: number; location?: string };
  body: Readable;
}
type PinnedRequest = (u: URL, addr: { address: string; family: number }, accept: string) => Promise<PublicResponse>;

/** One HTTPS GET to the checked address; the name stays the TLS server name and Host, so the certificate is still verified. */
const pinnedRequest: PinnedRequest = (u, addr, accept) => new Promise((resolve, reject) => {
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const req = https.request({
    hostname: host,
    port: u.port || 443,
    path: `${u.pathname}${u.search}`,
    method: 'GET',
    ...(net.isIP(host) ? {} : { servername: host }),
    headers: { host: u.host, 'user-agent': 'Mozilla/5.0 (Capsula product photo)', accept, 'accept-encoding': 'identity' },
    lookup: pinnedLookup(addr),
    agent: false,
    timeout: 15000,
  }, (res) => {
    const header = (name: string) => { const v = res.headers[name]; return Array.isArray(v) ? v[0] : v; };
    resolve({ status: res.statusCode ?? 0, url: u.href, headers: { contentType: String(header('content-type') ?? ''), contentLength: Number(header('content-length') ?? 0) || 0, location: header('location') }, body: res });
  });
  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.on('error', reject);
  req.end();
});

export interface PublicGetDeps { lookup?: LookupAll; request?: PinnedRequest }
export type PublicGet = (url: string, accept: string) => Promise<PublicResponse | null>;

/**
 * GETs a public https address connecting only to an address checked just before (no DNS rebinding); every
 * redirect is checked the same way (at most 3). A skipped response's stream is destroyed.
 */
export async function publicGet(url: string, accept: string, deps: PublicGetDeps = {}): Promise<PublicResponse | null> {
  const request = deps.request ?? pinnedRequest;
  let u = httpsUrl(url);
  for (let hop = 0; u && hop <= 3; hop += 1) {
    const addr = await publicAddress(u, deps.lookup);
    if (!addr) return null;
    const res = await request(u, addr, accept);
    if (res.status < 300 || res.status >= 400) return res;
    res.body.destroy();
    let next: URL | null = null;
    try {
      next = res.headers.location ? httpsUrl(new URL(res.headers.location, u).href) : null;
    } catch {
      next = null;
    }
    u = next;
  }
  return null;
}

/** Reads a stream up to `limit` bytes within a hard wall-clock bound: null when longer, or its first `limit` bytes with `truncate`. The stream is always closed. */
async function readStream(body: Readable, limit: number, truncate = false, timeoutMs = 20000): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  const timer = setTimeout(() => body.destroy(new Error('timeout')), timeoutMs);
  timer.unref?.();
  try {
    for await (const chunk of body) {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      if (total + b.length > limit) {
        if (!truncate) return null;
        chunks.push(b.subarray(0, limit - total));
        total = limit;
        break;
      }
      chunks.push(b);
      total += b.length;
    }
    return Buffer.concat(chunks, total);
  } finally {
    clearTimeout(timer);
    body.destroy();
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

const IMAGE_ACCEPT = 'image/webp,image/jpeg,image/png,*/*;q=0.8';
const MAX_PAGE = 512 * 1024;

/** The product picture a shop page declares for sharing (og:image, twitter:image). */
export function pageImage(html: string, base: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = /(?:property|name)\s*=\s*["']?(og:image(?::secure_url)?|twitter:image(?::src)?)["'\s>]/i.exec(tag);
    const content = /content\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!key || !content) continue;
    try {
      const href = new URL(content.replace(/&amp;/g, '&'), base).href;
      if (httpsUrl(href)) return href;
    } catch {
      /* a malformed address is skipped */
    }
  }
  return null;
}

/** Largest side and pixel count a product photo may decode to; larger or broken files are refused. */
const MAX_SIDE = 6000;
export const MAX_INPUT_PIXELS = 25_000_000;

/**
 * Decodes the whole picture within bounds (no decompression bombs, no corrupt files). JPEG, PNG and WebP keep their
 * bytes; any other format sharp reads (AVIF, HEIC…) becomes a JPEG of bounded size.
 */
export async function normalizeProductImage(buf: Buffer): Promise<{ buf: Buffer; type: 'jpg' | 'png' | 'webp' } | null> {
  try {
    const opts = { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' as const };
    const { width = 0, height = 0 } = await sharp(buf, opts).metadata();
    if (width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE) return null;
    await sharp(buf, opts).stats();
    const type = detectImageType(buf);
    if (type && type !== 'heic') return { buf, type };
    const jpeg = await sharp(buf, opts).rotate().resize({ width: 3000, height: 3000, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
    return jpeg.length <= MAX_PHOTO ? { buf: jpeg, type: 'jpg' } : null;
  } catch {
    return null;
  }
}

async function downloadImage(url: string, get: PublicGet): Promise<{ buf: Buffer; type: 'jpg' | 'png' | 'webp' } | null> {
  const res = await get(url, IMAGE_ACCEPT);
  if (!res) return null;
  if (res.status < 200 || res.status >= 300 || !res.headers.contentType.startsWith('image/') || res.headers.contentLength > MAX_PHOTO) {
    res.body.destroy();
    return null;
  }
  const buf = await readStream(res.body, MAX_PHOTO);
  return buf ? normalizeProductImage(buf) : null;
}

const HTML_ACCEPT = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5';

/** The product page's own share image (og:image / twitter:image), fetched through the same checks. */
async function pageShareImage(productUrl: string, imageUrl: string, get: PublicGet) {
  const page = await get(productUrl, HTML_ACCEPT);
  if (!page) return null;
  if (page.status < 200 || page.status >= 300 || !/html/i.test(page.headers.contentType)) {
    page.body.destroy();
    return null;
  }
  const html = await readStream(page.body, MAX_PAGE, true);
  const og = html ? pageImage(html.toString('utf8'), page.url || productUrl) : null;
  return og && og !== imageUrl ? downloadImage(og, get) : null;
}

/**
 * Fetches a product photo from a public https address; when it fails (or throws) and the product page is known,
 * the page's own og:image / twitter:image is tried. Returns the saved file (relative) or null.
 */
export async function fetchProductImage(projectRoot: string, dataDir: string, id: string, url: string, productUrl?: string, get: PublicGet = publicGet): Promise<string | null> {
  let image: Awaited<ReturnType<typeof downloadImage>> = null;
  if (url) {
    try {
      image = await downloadImage(url, get);
    } catch {
      image = null;
    }
  }
  if (!image && productUrl) {
    try {
      image = await pageShareImage(productUrl, url, get);
    } catch {
      image = null;
    }
  }
  if (!image) return null;
  try {
    const dir = path.join(dataDir, 'media', 'products');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.${image.type}`);
    fs.writeFileSync(file, image.buf);
    return path.relative(projectRoot, file);
  } catch {
    return null;
  }
}
