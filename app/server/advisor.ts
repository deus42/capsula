// Wardrobe advisor (owner, 18.11; spec 2026-11-18-wardrobe-advisor-design.md): rates every item (agent
// judgement + the site's own counts), every shown look (harmony, one weaker piece with a better owned swap)
// and proposes new looks and capsules from owned items — proposals only, «Додати / Ні». An item worth
// replacing becomes an open purchase «замінить: …». Runs after changes and weekly; text only, never pictures.
import type { DB, Item, Job, Need, Season, SlotRef, Slots, Suggestion } from './schema.ts';
import { CATEGORIES, SEASONS, emptySlots } from './schema.ts';
import { newId, now } from './store.ts';
import { focusLine, replyLanguage } from './person.ts';
import { CATEGORY_UK, ownedItems } from './analysis.ts';
import { SCORE_SCALE, SLOT_CATEGORIES, currentPeriod, eyewearBlocked, hasPieces, isBlockedEyewear, isComplete, itemUsage, openSuggestions, siteLooks, weakPiece } from '../src/lib.ts';
import { hiddenLookIds, isCapsuleHidden } from '../src/rating.ts';
import { placeLook, placePurchaseInSet, requireParentCapsule, stripFromSets } from './capsule-membership.ts';
import { alreadySeen, refusedPieces } from '../src/look-memory.ts';
import { buysFitSet, capsuleSet, fashionCapsules, freePlaces, inSavedSet, pieceGroup, pieceKey, sameTitle } from '../src/capsule-pieces.ts';
import { fitPromptBlock } from './fit.ts';

const str = { type: 'string' } as const;
const ids = { type: 'array', items: str } as const;
const SLOT_KEYS = ['top', 'layer', 'bottom', 'shoes', 'accessories'] as const;
const outfit = { name: str, top: ids, layer: ids, bottom: ids, shoes: ids, accessories: ids, why: str };
const outfitKeys = ['name', 'top', 'layer', 'bottom', 'shoes', 'accessories', 'why'];

export const ADVISE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'reason', 'items', 'looks', 'newLooks', 'newCapsules', 'newNeeds', 'coveredNeeds'],
  properties: {
    status: { type: 'string', enum: ['done', 'error'] },
    reason: str,
    items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'score', 'note', 'replace', 'replaceWith'], properties: { id: str, score: { type: 'number' }, note: str, replace: str, replaceWith: str } } },
    looks: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'score', 'weakItem', 'swapTo', 'why'], properties: { id: str, score: { type: 'number' }, weakItem: str, swapTo: str, why: str } } },
    newLooks: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['capsuleId', ...outfitKeys], properties: { capsuleId: str, ...outfit } } },
    newNeeds: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['capsuleId', 'title', 'category', 'why'], properties: { capsuleId: str, title: str, category: { type: 'string', enum: [...CATEGORIES] }, why: str } } },
    coveredNeeds: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['itemId', 'needId', 'reason'], properties: { itemId: str, needId: str, reason: str } } },
    newCapsules: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'season', 'why', 'looks'],
        properties: { name: str, season: { type: 'string', enum: [...SEASONS] }, why: str, looks: { type: 'array', items: { type: 'object', additionalProperties: false, required: outfitKeys, properties: outfit } } },
      },
    },
  },
};

type Outfit = { name: string; why: string } & Record<(typeof SLOT_KEYS)[number], string[]>;
export interface AdviseReply {
  status: string;
  reason: string;
  items: { id: string; score: number; note: string; replace: string; replaceWith: string }[];
  looks: { id: string; score: number; weakItem: string; swapTo: string; why: string }[];
  newLooks: (Outfit & { capsuleId: string })[];
  newCapsules: { name: string; season: string; why: string; looks: Outfit[] }[];
  newNeeds?: { capsuleId: string; title: string; category: string; why: string }[];
  /** Owned items that already are an open purchase (same category, garment type and colour family). */
  coveredNeeds?: { itemId: string; needId: string; reason: string }[];
}

/** What a saved advice changed beyond itself: the runner covers the needs, pictures the new purchases and re-renders the looks. */
export interface AdviceOutcome {
  note: string;
  covered: { itemId: string; needId: string; reason: string }[];
  modifiedLookIds: string[];
  createdNeedIds: string[];
}

/**
 * The honest rank scale (owner, 19.11): scores by place in the wardrobe — top 10 % 9–10, next 20 % 8, middle 40 % 6–7,
 * bottom 30 % 5 or lower; 9+ only for looks wearable today. Ratings made with an older scale are redone once.
 */
export { SCORE_SCALE };
const SCALE_RULE = 'Score by RANK against the whole set (current scores of the others are shown as "rated N" / "score N"): top 10 % → 9–10, next 20 % → 8, middle 40 % → 6–7, bottom 30 % → 5 or lower, so the median is about 7. Be honest: redundant near-duplicates, loud logos or prints, poor versatility and style mismatches score low.';

/** Items whose rating is missing, older than the item itself or made with an older scale: the agent looks at them (with photos). */
export const itemsToRate = (db: DB) => advisable(db).filter((i) => !i.rating || i.rating.rev !== i.rev || i.rating.scale !== SCORE_SCALE);
/** Shown looks with no score for their current pieces (or an older-scale one): only these are scored, so scores never jump on 👍/👎. */
export const looksToScore = (db: DB) => siteLooks(db).filter((l) => hasPieces(l) && (!l.advice || l.advice.version !== l.version || l.advice.scale !== SCORE_SCALE));
const currentLookScore = (l: { advice?: { score: number; version: number; scale?: number }; version: number }) => (l.advice && l.advice.version === l.version && l.advice.scale === SCORE_SCALE ? l.advice.score : null);

/** Owned items the advisor works with (respecting the profile's eyewear setting). */
const advisable = (db: DB) => ownedItems(db).filter((i) => !isBlockedEyewear(db, i.title));

/** Open «замінить» purchases at a time: the rest stay as a line on the item page (no flood in «Покупки»). */
export const MAX_OPEN_REPLACEMENTS = 3;
/** Open proposals kept at a time (Home shows two); unanswered ones stay until the owner answers or they go stale. */
export const MAX_OPEN_PROPOSALS = 3;

/** Pieces the owner chose himself (added by hand or bought): never «варто замінити» (owner, 18.11). */
export const ownerChosen = (i: Item) => i.origin === 'manual' || i.origin === 'purchase' || Boolean(i.purchasedFromProduct);

const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/** Two names for the same piece: «Пряме вовняне пальто кольору кемел» ≈ «Вовняне пальто кольору кемел» (most words shared). */
export { sameTitle };
/** A piece that is worn somewhere: in a shown look or in a fashion capsule's saved set. Only such a piece is worth replacing. */
export const itemInUse = (db: DB, itemId: string) =>
  itemUsage(db, itemId).looks > 0 || fashionCapsules(db).some((c) => Boolean(c.pieces?.some((r) => r.kind === 'item' && r.id === itemId)));

/** Titles already planned, bought, found or declined by the owner: a new advisor purchase never repeats them. */
const plannedTitles = (db: DB) => new Set([...db.needs.filter((n) => n.status === 'open' || n.status === 'covered').map((n) => norm(n.title)), ...(db.declinedNeeds ?? []).map(norm)]);

/** One advise job at a time in the queue; several changes in a row share it. */
export function queueAdvice(db: DB, reason: string): Job | null {
  if (!ownedItems(db).length) return null;
  if (db.jobs.some((j) => j.kind === 'advise' && j.state === 'queued')) return null;
  const j: Job = { id: newId('J'), kind: 'advise', lookVersion: 0, snapshot: { lookName: 'Порадник', slots: [], basePhotoIds: [], basePhotoPaths: [] }, instructions: reason, state: 'queued', origin: 'site', createdAt: now() };
  db.jobs.push(j);
  return j;
}

const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;
/** The weekly review: due when no advice finished in the last 7 days and none is waiting; after a failed run it waits a day. */
export function adviceDue(db: DB, at = Date.now()) {
  if (db.jobs.some((j) => j.kind === 'advise' && (j.state === 'queued' || j.state === 'running'))) return false;
  const last = (ok: boolean) => Math.max(0, ...db.jobs.filter((j) => j.kind === 'advise' && (ok ? j.state === 'done' : j.state === 'error')).map((j) => new Date(j.finishedAt ?? 0).getTime()));
  return at - last(true) >= WEEK && at - last(false) >= DAY && ownedItems(db).length > 0;
}

const piecesLine = (db: DB, slots: Slots) =>
  SLOT_KEYS.flatMap((k) => slots[k].map((r) => (r.kind === 'item' ? `${k}:${r.id}` : `${k}:${r.kind === 'need' ? 'TO BUY ' + (db.needs.find((n) => n.id === r.id)?.title ?? r.id) : r.id}`))).join(', ');

export function advisePrompt(db: DB, job: Job, attached: string[]) {
  const items = advisable(db);
  const prefs = db.profile.preferences;
  const hidden = hiddenLookIds(db);
  const capsules = db.capsules.filter((c) => !isCapsuleHidden(db, c));
  const looks = siteLooks(db);
  const rejected = [...(db.suggestions ?? []).filter((s) => s.status === 'rejected').flatMap((s) => s.looks), ...(db.lookMemory ?? [])].slice(-60);
  const disliked = db.looks.filter((l) => hidden.has(l.id));
  const kept = items.filter((i) => i.rating?.kept).map((i) => i.id);
  const chosen = items.filter((i) => ownerChosen(i) && !i.rating?.kept).map((i) => i.id);
  const toRate = itemsToRate(db).map((i) => i.id);
  const toScore = looksToScore(db).map((l) => l.id);
  const openNeeds = db.needs.filter((n) => n.status === 'open');
  const declined = db.declinedNeeds ?? [];
  const refused = refusedPieces(db, hidden);
  // So-so pieces (score under 6 or «варто замінити») are not built into new outfits (owner, 19.11).
  const weak = items.filter(weakPiece).map((i) => i.id);
  const unused = items.filter((i) => itemUsage(db, i.id).looks === 0 && !refused.has(i.id) && !weakPiece(i)).map((i) => i.id);
  return [
    `You are the Capsula wardrobe advisor running unattended. Answer with JSON only (schema enforced). Write every text in ${replyLanguage(db)}, short.`,
    focusLine(db),
    `Profile — comfort: ${prefs.comfort || '—'}; materials: ${prefs.materials || '—'}; fit: ${prefs.fit || '—'}; branding: ${prefs.branding || '—'}.`,
    fitPromptBlock(db),
    job.instructions ? `What changed: ${job.instructions}` : '',
    '',
    `1. items — rate ONLY these ids now: ${toRate.join(', ') || 'none'}. score 0–10 for style, how well it combines with the rest of the wardrobe, fit to the preferences and to the seasons of the capsules. ${SCALE_RULE} note: one sentence why. replace: a reason ONLY for a concrete conflict — a large logo or print against the minimal-branding preference, no capsule style it can fit, or wear/damage that the item's own notes state; colour or pattern alone is NEVER a reason (the owner chose them); never invent condition, material or fit; otherwise empty. replaceWith: when replace is set, a short title of what to buy instead (e.g. «Темно-синє трикотажне поло»), else empty.`,
    attached.length ? `Pictures of the items to rate are attached, named by item id (${attached.length} files). They are generated catalogue reconstructions, NOT photos of the real garment: use them for colour and shape only; never read wear, stains, fading, material or condition from them.` : '',
    kept.length ? `The owner keeps and likes these items — never suggest replacing them, and do not score them down for taste: ${kept.join(', ')}.` : '',
    chosen.length ? `The owner chose these pieces himself (added by hand or bought) — never suggest replacing them: ${chosen.join(', ')}.` : '',
    `2. looks — score ONLY these look ids now: ${toScore.join(', ') || 'none'} (the others are listed with their current score for comparison): 0–10 with ONE decimal for harmony of colours, silhouette, formality and season. ${SCALE_RULE} A look with any TO BUY piece is at most 8; 9+ only for looks that can be worn today; a near-duplicate of a stronger look scores low. weakItem: an item id in that look that clearly weakens it, and swapTo: an owned item id for the same slot that is clearly better and not already in the look; both empty if nothing is clearly better. why: one sentence.`,
    `3. newLooks — up to 3 new outfits from owned item ids only. First, every item with no shown look yet (${unused.join(', ') || 'none'}) that fits a listed capsule gets one outfit; then items rated 7+ with 0–1 shown looks. Every outfit requires the id of a listed capsule whose style and season fits. If none fits, propose a new capsule in newCapsules. Each needs a bottom and shoes; at most one item per slot except accessories (max 2). why: which owned pieces it brings into use and why it works.`,
    `5. newNeeds — at most 2: a piece to BUY when a listed capsule clearly lacks something for its style and season (e.g. no warm layer, no fitting shoes) and no owned item can fill it. capsuleId, title (short ${replyLanguage(db)} name of the piece), category (${CATEGORIES.join(' | ')}), why (one sentence). Never repeat the open purchases or the declined purchases listed below. Usually empty.`,
    '4. newCapsules — at most 1, only when 3 or more strong outfits of one style and season are not covered by any listed capsule: a name, season (all | warm | transitional | cold), why and 3–5 looks (same rules). Usually empty.',
    `6. coveredNeeds — owned wardrobe items (especially ones just added, confirmed or edited) that already ARE one of the open purchases listed with ids below: same category, same garment type and same colour family (light lighting shifts like cream vs white or light blue vs pale blue are the same family; a different colour or garment type is not). A store tag still attached is fine: it was just bought. Never match an item to the purchase that replaces it. itemId, needId, reason (one short ${replyLanguage(db)} sentence). Each item and each purchase at most once. Usually empty.`,
    eyewearBlocked(db) ? 'Never use eyewear (glasses, sunglasses, frames) anywhere — the owner wears none in looks.' : '',
    'Same-look rule (the owner\'s): two outfits are the SAME look when identical or different by only one piece. Every new outfit must be a different look from each other, from every listed look and from every rejected outfit.',
    'Return status "error" only if the wardrobe cannot be read.',
    '',
    `Today: ${new Date().toISOString().slice(0, 10)}, current weather period: ${currentPeriod(new Date(), db.profile.hemisphere)}.`,
    'Capsules are distinct FASHION capsules (owner, 19.11): every new outfit must fit its capsule\'s aesthetic, palette and weather periods in the brief.',
    'Capsules (id | name | season | periods | kind | brief):',
    capsules.map((c) => `${c.id} | ${c.name} | ${c.season} | ${(c.periods ?? []).join('+') || '—'} | ${c.kind ?? 'capsule'} | ${c.description.replace(/\s+/g, ' ').slice(0, 300)}`).join('\n'),
    ...closedSets(db, capsules),
    '',
    'Looks shown on the site (id | capsule | name | pieces):',
    looks.map((l) => `${l.id} | ${l.capsuleId ?? '—'} | ${l.name}${l.favorite ? ' | LIKED' : ''}${currentLookScore(l) !== null ? ` | score ${currentLookScore(l)}` : ''} | ${piecesLine(db, l.slots)}`).join('\n'),
    disliked.length ? `\nLooks the owner disliked (avoid their direction):\n${disliked.map((l) => `- ${piecesLine(db, l.slots)}`).join('\n')}` : '',
    rejected.length ? `\nOutfits the owner rejected as suggestions or deleted (never again, nothing within one piece):\n${rejected.map((o) => `- ${piecesLine(db, o.slots)}`).join('\n')}` : '',
    refused.size ? `Pieces the owner keeps refusing — never build an outfit around them: ${[...refused].join(', ')}.` : '',
    weak.length ? `So-so pieces — never use them in new outfits: ${weak.join(', ')}.` : '',
    '',
    openNeeds.length ? `Open purchases (already planned, do not repeat; id | category | title | description | why | replaces):\n${openNeeds.map((n) => `${n.id} | ${n.category} | ${n.title} | ${(n.description ?? '').replace(/\s+/g, ' ').slice(0, 200) || '—'} | ${(n.why ?? '').replace(/\s+/g, ' ').slice(0, 200) || '—'} | ${n.replaces ?? '—'}`).join('\n')}` : '',
    declined.length ? `Purchases the owner declined (never propose again): ${declined.join('; ')}` : '',
    '',
    'Wardrobe (id | category | title | details | notes | usage):',
    items
      .map((i) => {
        const u = itemUsage(db, i.id);
        const facts = [i.color, i.brand, i.fit, i.size].filter(Boolean).join(', ');
        const notes = [i.observation, i.confirmedFact].filter(Boolean).join(' ').replace(/\s+/g, ' ').slice(0, 240);
        return `${i.id} | ${CATEGORY_UK[i.category]} | ${i.title}${facts ? ` | ${facts}` : ''}${notes ? ` | notes: ${notes}` : ''} | looks ${u.looks}, complete ${u.complete}, liked ${u.liked}, capsules ${u.capsules}${i.rating && i.rating.rev === i.rev && i.rating.scale === SCORE_SCALE ? ` | rated ${i.rating.score}` : ''}`;
      })
      .join('\n'),
  ]
    .filter((x) => x !== '')
    .join('\n');
}

const clampScore = (n: unknown) => Math.max(0, Math.min(10, Math.round(Number(n) || 0)));
/** Look scores keep one decimal, so the strongest few can stand out («Найкращі», owner 18.11). */
const lookScore = (n: unknown) => Math.max(0, Math.min(10, Math.round((Number(n) || 0) * 10) / 10));

/** Item revisions and look versions the advisor sees when its prompt is built: ratings and look scores are stamped with these, so a change made meanwhile is rated again. */
export const seenRevs = (db: DB) => new Map<string, number>([...itemsToRate(db).map((i) => [i.id, i.rev] as const), ...siteLooks(db).map((l) => [l.id, l.version] as const)]);
const text = (v: unknown, n: number) => String(v ?? '').trim().slice(0, n);

/**
 * An outfit counts only when every piece is owned and fits its slot, with a top or an outer layer, a bottom (or a dress) and shoes.
 * Eyewear is quietly left out (never in looks); an unknown or deleted piece rejects the whole outfit.
 */
function slotsFrom(o: Outfit, owned: Map<string, Item>, eyewear: Set<string>): Slots | null {
  const slots = emptySlots();
  for (const k of SLOT_KEYS) {
    const ids = [...new Set(o[k] ?? [])].filter((id) => !eyewear.has(id));
    if (ids.some((id) => !owned.has(id) || !SLOT_CATEGORIES[k].includes(owned.get(id)!.category))) return null;
    slots[k] = ids.slice(0, k === 'accessories' ? 2 : 1).map((id) => ({ kind: 'item' as const, id }));
  }
  const dress = slots.top.some((r) => owned.get(r.id)?.category === 'dresses');
  return (slots.top.length || slots.layer.length) && (slots.bottom.length || dress) && slots.shoes.length ? slots : null;
}

/** Saves the advisor's answer: ratings, look advice, new proposals (valid open ones stay), replacement purchases. */
export function applyAdvice(db: DB, job: Job, reply: AdviseReply, seen?: Map<string, number>): AdviceOutcome {
  const at = now();
  const owned = new Map(advisable(db).map((i) => [i.id, i] as const));
  const modified: string[] = [];
  const createdNeedIds: string[] = [];
  let rated = 0;
  let replaced = 0;
  for (const r of reply.items ?? []) {
    const item = owned.get(r.id);
    // A rating that is already current on this scale stays: scores do not jump between runs.
    if (!item || (item.rating && item.rating.rev === item.rev && item.rating.scale === SCORE_SCALE)) continue;
    const replace = item.rating?.kept || ownerChosen(item) ? '' : text(r.replace, 200);
    item.rating = { score: clampScore(r.score), note: text(r.note, 200), replace: replace || undefined, replaceWith: replace ? text(r.replaceWith, 80) || undefined : undefined, rev: seen?.get(item.id) ?? item.rev, at, kept: item.rating?.kept, scale: SCORE_SCALE };
    rated += 1;
    // The advisor withdraws its own replacement purchase when the new rating no longer asks for it.
    if (!replace) modified.push(...withdrawReplacement(db, item.id, true));
  }
  // A replacement whose item the owner kept, chose himself, no longer has or wears nowhere goes too (also one skipped earlier while its search ran).
  for (const n of db.needs.filter((x) => x.replaces && x.status === 'open' && x.origin === 'agent')) {
    const it = db.items.find((i) => i.id === n.replaces);
    const ownerGone = !it || it.status === 'inactive' || Boolean(it.mergedInto) || Boolean(it.rating?.kept) || ownerChosen(it);
    // «Wears nowhere» is the advisor's own call: a purchase the owner already built on stays.
    if (ownerGone || !itemInUse(db, it.id)) modified.push(...withdrawReplacement(db, n.replaces!, !ownerGone));
  }
  // Free places go to every rated item still worth replacing, lowest score first — not only the ones rated now;
  // an item that already has a replacement (open, found or bought) never gets a second one.
  const planned = plannedTitles(db);
  const candidates = [...owned.values()]
    .filter((i) => i.rating?.replace && i.rating.replaceWith && !i.rating.kept && !ownerChosen(i) && itemInUse(db, i.id) && !db.needs.some((n) => n.replaces === i.id))
    .sort((a, b) => a.rating!.score - b.rating!.score);
  for (const item of candidates) {
    if (db.needs.filter((n) => n.replaces && n.status === 'open').length >= MAX_OPEN_REPLACEMENTS) break;
    if (planned.has(norm(item.rating!.replaceWith!))) continue;
    planned.add(norm(item.rating!.replaceWith!));
    replaced += 1;
    const need = replacementNeed(item, item.rating!.replace!, item.rating!.replaceWith!, at);
    db.needs.push(need);
    createdNeedIds.push(need.id);
  }
  const shown = new Map(siteLooks(db).map((l) => [l.id, l] as const));
  for (const r of reply.looks ?? []) {
    const look = shown.get(r.id);
    if (!look || currentLookScore(look) !== null) continue;
    const rejected = look.advice?.rejected ?? [];
    const slot = SLOT_KEYS.find((k) => look.slots[k].some((x) => x.kind === 'item' && x.id === r.weakItem));
    const inLook = Object.values(look.slots).flat().some((x) => x.kind === 'item' && x.id === r.swapTo);
    const lookCapsule = look.capsuleId ? db.capsules.find((c) => c.id === look.capsuleId) : undefined;
    const inSet = !lookCapsule?.pieces || inSavedSet(db, lookCapsule, { kind: 'item', id: r.swapTo });
    const swap = slot && owned.has(r.swapTo) && inSet && !inLook && !rejected.includes(`${r.weakItem}>${r.swapTo}`) ? { from: r.weakItem, to: r.swapTo } : undefined;
    // A look with a piece to buy is at most 8 (owner, 19.11): ideas never outrank what can be worn today.
    const score = isComplete(db, look) ? lookScore(r.score) : Math.min(8, lookScore(r.score));
    look.advice = { score, why: text(r.why, 200), version: seen?.get(look.id) ?? look.version, swap, rejected: rejected.length ? rejected : undefined, scale: SCORE_SCALE };
  }
  // Unanswered proposals stay while all their pieces are still owned and their capsule is shown; new ones fill up to the cap.
  const ownedIds = new Set(owned.keys());
  const valid = (s: Suggestion) =>
    s.looks.every((l) => Object.values(l.slots).flat().every((r) => r.kind === 'item' && ownedIds.has(r.id) && !weakPiece(owned.get(r.id)!))) &&
    (s.kind === 'capsule' || Boolean(db.capsules.find((c) => c.id === s.capsuleId && !isCapsuleHidden(db, c) && (!c.pieces || s.looks.every((l) => Object.values(l.slots).flat().every((r) => inSavedSet(db, c, r)) && buysFitSet(db, c, l.buy))))));
  const keep = (db.suggestions ?? []).filter((s) => s.status !== 'open' || valid(s));
  // Look memory (owner, 19.11): never a composition that already was — looks, older versions, any proposal, deleted looks —
  // or anything within the closeness rule; never built around pieces the owner keeps refusing.
  const fresh2Slots: Slots[] = [];
  const refused = refusedPieces(db, hiddenLookIds(db));
  // Search results («Нові») do not take the advisor's places.
  const room = Math.max(0, MAX_OPEN_PROPOSALS - keep.filter((s) => s.status === 'open' && s.source !== 'search').length);
  const fresh: Suggestion[] = [];
  const eyewear = new Set(db.items.filter((i) => isBlockedEyewear(db, i.title)).map((i) => i.id));
  const take = (o: Outfit) => {
    const slots = slotsFrom(o, owned, eyewear);
    if (!slots || Object.values(slots).flat().some((r) => refused.has(r.id) || weakPiece(owned.get(r.id)!))) return null;
    if (alreadySeen(db, slots, fresh2Slots)) return null;
    fresh2Slots.push(slots);
    return { name: text(o.name, 80) || 'Образ', why: text(o.why, 240), slots };
  };
  for (const o of (reply.newLooks ?? []).slice(0, 3)) {
    const capsule = db.capsules.find((c) => c.id === o.capsuleId);
    if (!capsule || isCapsuleHidden(db, capsule)) continue;
    const look = take(o);
    if (!look) continue;
    if (capsule.pieces && Object.values(look.slots).flat().some((r) => !inSavedSet(db, capsule, r))) continue;
    fresh.push({ id: newId('A'), kind: 'look', status: 'open', name: look.name, why: look.why, capsuleId: capsule.id, looks: [look], jobId: job.id, createdAt: at });
  }
  for (const c of (reply.newCapsules ?? []).slice(0, 1)) {
    const looks = (c.looks ?? []).slice(0, 5).map(take).filter((l): l is NonNullable<typeof l> => Boolean(l));
    if (looks.length < 2) continue;
    const season = ((SEASONS as readonly string[]).includes(c.season) ? c.season : 'all') as Season;
    fresh.push({ id: newId('A'), kind: 'capsule', status: 'open', name: text(c.name, 80) || 'Нова капсула', why: text(c.why, 240), season, looks, jobId: job.id, createdAt: at });
  }
  // A piece with no look yet (e.g. just added) goes first: its proposal takes the place of the oldest unanswered one.
  const unused = new Set([...owned.keys()].filter((id) => itemUsage(db, id).looks === 0 && !refused.has(id) && !weakPiece(owned.get(id)!)));
  const forUnused = (s: Suggestion) => s.looks.some((l) => Object.values(l.slots).flat().some((r) => unused.has(r.id)));
  const ordered = [...fresh.filter(forUnused), ...fresh.filter((s) => !forUnused(s))];
  let space = room;
  if (!space && ordered.length && forUnused(ordered[0])) {
    const oldest = keep.filter((s) => s.status === 'open' && s.source !== 'search').sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (oldest) {
      keep.splice(keep.indexOf(oldest), 1);
      space = 1;
    }
  }
  const fresh2 = ordered.slice(0, space);
  const added = fresh2.length;
  // Home shows the first two open proposals: one for a piece with no look comes before the older ones.
  db.suggestions = [...fresh2.filter(forUnused), ...keep, ...fresh2.filter((s) => !forUnused(s))];
  // What a capsule lacks becomes a purchase «Для капсули: …» — at most three such open at a time, never a repeat or a declined one.
  let gaps = 0;
  for (const g of (reply.newNeeds ?? []).slice(0, 2)) {
    const capsule = db.capsules.find((c) => c.id === g.capsuleId);
    const category = (CATEGORIES as readonly string[]).includes(g.category) ? (g.category as Need['category']) : null;
    const title = text(g.title, 80);
    if (!capsule || isCapsuleHidden(db, capsule) || !category || !title) continue;
    const free = freePlaces(db, capsule);
    if (free && free[pieceGroup(category)] <= 0) continue;
    if (db.needs.filter((n) => n.status === 'open' && n.forCapsule).length >= 3) break;
    if (planned.has(norm(title))) continue;
    planned.add(norm(title));
    const need: Need = { id: newId('N'), rev: 1, title, category, priority: 'optional', description: '', why: text(g.why, 240), fitCheck: '', status: 'open', origin: 'agent', forCapsule: capsule.id, sourceNote: `Порадник ${at.slice(0, 10)}: бракує в капсулі «${capsule.name}»`, createdAt: at, updatedAt: at };
    db.needs.push(need);
    // A gap of a saved closed set takes its free place, so the purchase belongs to the set instead of floating beside it.
    if (free) placePurchaseInSet(db, capsule, { kind: 'need', id: need.id });
    createdNeedIds.push(need.id);
    gaps += 1;
  }
  // Owned pieces that already are an open purchase (checked here; the runner covers them and updates their looks).
  const covered: AdviceOutcome['covered'] = [];
  for (const c of reply.coveredNeeds ?? []) {
    // Only a confirmed piece with a stated reason closes a purchase here; a fresh upload is covered by intake itself.
    const item = owned.get(String(c.itemId ?? '').trim());
    const need = db.needs.find((n) => n.id === String(c.needId ?? '').trim() && n.status === 'open');
    const reason = text(c.reason, 200);
    if (!item || item.status !== 'confirmed' || !need || !reason || need.category !== item.category || need.replaces === item.id) continue;
    if (covered.some((x) => x.needId === need.id || x.itemId === item.id)) continue;
    covered.push({ itemId: item.id, needId: need.id, reason });
  }
  const parts = [`Оцінено речей: ${rated}`, added ? `пропозицій: ${added}` : '', replaced ? `замінити: ${replaced}` : '', gaps ? `для капсул: ${gaps}` : ''].filter(Boolean);
  return { note: parts.join(' · '), covered, modifiedLookIds: [...new Set(modified)], createdNeedIds };
}

/**
 * Closed capsule sets (owner, 20.11): new outfits and swaps for such a capsule use only its set; a purchase for it
 * («newNeeds») only fills a free place. The set piece making the fewest looks is named so a replacement can target it.
 */
function closedSets(db: DB, capsules: DB['capsules']): string[] {
  const withSets = capsules.filter((c) => c.pieces);
  if (!withSets.length) return [];
  return ['', 'Closed sets — for these capsules newLooks and swapTo use ONLY item ids of the set; newNeeds only when the set has a free place of that kind:',
    ...withSets.map((c) => {
      const set = capsuleSet(db, c);
      const free = freePlaces(db, c)!;
      const weakest = set.pieces.filter((p) => p.owned).sort((a, b) => a.looks - b.looks)[0];
      return `${c.id} set: ${set.pieces.map((p) => `${pieceKey(p.ref)} (${p.role}, ${p.looks} looks${p.base ? ', base' : ''})`).join('; ')}. Free places: garments ${free.garments}, shoes ${free.shoes}, accessories ${free.accessories}.${weakest ? ` Fewest looks: ${weakest.ref.id}.` : ''}`;
    })];
}

/**
 * A replacement purchase the owner already built on: placed in a saved look or a capsule set (itself or one of its
 * products), or a product chosen or bought.
 */
export function replacementHeld(db: DB, need: Need): boolean {
  const productIds = new Set(db.products.filter((p) => p.needId === need.id).map((p) => p.id));
  const hit = (r: SlotRef) => (r.kind === 'need' && r.id === need.id) || (r.kind === 'product' && productIds.has(r.id));
  return db.products.some((p) => p.needId === need.id && (p.status === 'chosen' || p.status === 'purchased'))
    || db.looks.some((l) => Object.values(l.slots).some((refs) => refs.some(hit)))
    || db.capsules.some((c) => (c.pieces ?? []).some(hit) || (c.base ?? []).some(hit));
}

/**
 * Removes the advisor's own open replacement purchase for an item (nothing bought from it yet). `auto`: the
 * advisor's own decision, which leaves a purchase the owner already built on (replacementHeld) in place.
 */
function withdrawReplacement(db: DB, itemId: string, auto = false): string[] {
  // A purchase with a search still running stays until the next run (its job must not lose its purchase).
  const gone = db.needs
    .filter((n) => n.replaces === itemId && n.status === 'open' && n.origin === 'agent' && !db.products.some((p) => p.needId === n.id && p.status === 'purchased') && !db.jobs.some((j) => j.needId === n.id && j.state === 'running') && !(auto && replacementHeld(db, n)))
    .map((n) => n.id);
  if (!gone.length) return [];
  const changed: string[] = [];
  // Looks that used it get a new version, so the look page offers «Речі змінено» like any other change.
  const drop = (r: SlotRef) => (r.kind === 'need' && gone.includes(r.id)) || (r.kind === 'product' && db.products.some((p) => p.id === r.id && gone.includes(p.needId)));
  for (const l of db.looks) {
    if (!Object.values(l.slots).flat().some(drop)) continue;
    const slots = emptySlots();
    for (const k of SLOT_KEYS) slots[k] = l.slots[k].filter((r) => !drop(r));
    l.version += 1;
    l.slots = slots;
    l.versions.push({ version: l.version, slots, at: now(), note: 'Порадник прибрав свою покупку' });
    l.rev += 1;
    l.updatedAt = now();
    changed.push(l.id);
  }
  // A withdrawn purchase and its products also leave the capsule sets (pieces, base) they held a place in.
  for (const id of gone) stripFromSets(db, 'need', id);
  for (const p of db.products.filter((x) => gone.includes(x.needId))) stripFromSets(db, 'product', p.id);
  db.products = db.products.filter((p) => !gone.includes(p.needId));
  // Its searches and pictures go with it, finished ones included, like a purchase the owner deletes.
  const jobs = new Set(db.jobs.filter((j) => j.needId && gone.includes(j.needId)).map((j) => j.id));
  db.jobs = db.jobs.filter((j) => !jobs.has(j.id));
  for (const j of db.jobs) if (j.retryOf && jobs.has(j.retryOf)) delete j.retryOf;
  db.needs = db.needs.filter((n) => !gone.includes(n.id));
  return changed;
}

/** «Ні» on «варто замінити» (owner, 18.11): the item stays, its open replacement purchase goes, and it is rated again knowing the owner likes it. */
export function keepItem(db: DB, item: Item): string[] {
  if (item.rating) {
    item.rating.kept = true;
    item.rating.rev = -1;
  }
  return withdrawReplacement(db, item.id);
}

/** An item that left the wardrobe («Це моя річ? — Ні» or deleted) frees the replacement purchase made for it. */
export function dropReplacementsFor(db: DB, itemId: string): string[] {
  return withdrawReplacement(db, itemId);
}

/** A deleted advisor purchase is remembered, so the advisor never proposes the same piece again. */
export function rememberDeclined(db: DB, need: Need) {
  if (need.origin !== 'agent' || !(need.replaces || need.forCapsule)) return;
  db.declinedNeeds = [...new Set([...(db.declinedNeeds ?? []), need.title])].slice(-40);
}

function replacementNeed(item: Item, why: string, title: string, at: string): Need {
  return { id: newId('N'), rev: 1, title, category: item.category, priority: 'optional', description: '', why, fitCheck: '', status: 'open', origin: 'agent', replaces: item.id, sourceNote: `Порадник ${at.slice(0, 10)}: замінить «${item.title}»`, createdAt: at, updatedAt: at };
}

/** «Додати»: a look goes into its capsule, or a new capsule is created with its looks. Returns what changed for try-ons and pictures. */
export function acceptSuggestion(db: DB, s: Suggestion): { href: string; lookIds: string[]; modifiedLookIds: string[]; needIds: string[] } {
  const at = now();
  const lookIds: string[] = [];
  const modifiedLookIds: string[] = [];
  const needIds: string[] = [];
  const make = (l: Suggestion['looks'][number], capsuleId: string) => {
    // Pieces to buy (search, owner 19.11) become purchases only now; an open purchase of the same name is reused.
    const slots = JSON.parse(JSON.stringify(l.slots)) as Slots;
    const capsule = db.capsules.find((c) => c.id === capsuleId);
    for (const b of l.buy ?? []) {
      // A planned purchase of the capsule's set is reused first (owner, 20.11), then any open purchase of the same name.
      const same = (n: Need) => n.status === 'open' && n.category === b.category && sameTitle(n.title, b.title);
      let need = db.needs.find((n) => same(n) && capsule?.pieces?.some((r) => r.kind === 'need' && r.id === n.id)) ?? db.needs.find(same);
      if (!need) {
        need = { id: newId('N'), rev: 1, title: b.title, category: b.category, priority: 'optional', description: '', why: `Для образу «${l.name}»`, fitCheck: '', status: 'open', origin: 'agent', sourceNote: `Пошук нових образів, додано власником ${at.slice(0, 10)}`, createdAt: at, updatedAt: at };
        db.needs.push(need);
      }
      slots[b.slot] = [...slots[b.slot], { kind: 'need', id: need.id }];
      needIds.push(need.id);
      if (capsule) modifiedLookIds.push(...placePurchaseInSet(db, capsule, { kind: 'need', id: need.id }, b.replaces));
    }
    const look = { id: newId('L'), rev: 1, capsuleId, name: l.name, note: l.why, slots, version: 1, versions: [{ version: 1, slots, at }], favorite: false, origin: 'agent' as const, sourceNote: `Порадник (${s.jobId}), додано власником ${at.slice(0, 10)}`, createdAt: at, updatedAt: at };
    db.looks.push(look);
    lookIds.push(look.id);
    return look;
  };
  let target: string;
  if (s.kind === 'capsule') {
    const id = newId('C');
    const looks = s.looks.map((l) => make(l, id));
    db.capsules.push({ id, rev: 1, kind: 'capsule', name: s.name, season: s.season ?? 'all', description: s.why, situations: [], favorite: false, lookIds: looks.map((l) => l.id), origin: 'agent', sourceNote: `Порадник, додано власником ${at.slice(0, 10)}`, createdAt: at, updatedAt: at });
    target = `/capsules/${id}`;
  } else {
    const capsule = requireParentCapsule(db, s.capsuleId ?? undefined);
    const look = make(s.looks[0], capsule.id);
    placeLook(db, look, capsule);
    target = `/looks/${look.id}`;
  }
  s.status = 'accepted';
  s.decidedAt = at;
  return { href: target, lookIds, modifiedLookIds: [...new Set(modifiedLookIds)].filter((id) => !lookIds.includes(id)), needIds: [...new Set(needIds)] };
}

export { itemUsage, openSuggestions };
