// «Нові» (owner, 19.11; spec 2026-11-19-fashion-capsules-design.md, part 6): a search for new looks in the style of
// a fashion capsule and the current weather period. Looks may use up to two pieces to buy; results are cards
// «Ні / Додати» (db.suggestions, source «search»); the pieces to buy become purchases only on «Додати».
// Every candidate passes the look memory; text only, never pictures.
import type { Category, DB, Job, SlotKey, Slots, Suggestion } from './schema.ts';
import { fitPromptBlock } from './fit.ts';
import { CATEGORIES, emptySlots } from './schema.ts';
import { HttpError, newId, now } from './store.ts';
import { focusLine, replyLanguage } from './person.ts';
import { CATEGORY_UK, ownedItems } from './analysis.ts';
import { PERIOD_LABEL, PERIOD_TEMP, SLOT_CATEGORIES, currentPeriod, eyewearBlocked, isBlockedEyewear, weakPiece } from '../src/lib.ts';
import { hiddenLookIds, isCapsuleHidden } from '../src/rating.ts';
import { alreadySeen, refusedPieces, seenCompositions, withBuys } from '../src/look-memory.ts';
import { freePlaces, inSavedSet, normalizePiece, pieceCategory, pieceGroup, pieceKey, sameTitle } from '../src/capsule-pieces.ts';

const SLOT_KEYS = ['top', 'layer', 'bottom', 'shoes', 'accessories'] as const;
const str = { type: 'string' } as const;
const ids = { type: 'array', items: str } as const;
export const MAX_SEARCH_RESULTS = 6;

export const DISCOVER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'reason', 'looks'],
  properties: {
    status: { type: 'string', enum: ['done', 'error'] },
    reason: str,
    looks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['capsuleId', 'name', 'why', ...SLOT_KEYS, 'buy'],
        properties: {
          capsuleId: str, name: str, why: str, top: ids, layer: ids, bottom: ids, shoes: ids, accessories: ids,
          buy: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['slot', 'title', 'category', 'replaces'], properties: { slot: { type: 'string', enum: [...SLOT_KEYS] }, title: str, category: { type: 'string', enum: [...CATEGORIES] }, replaces: str } } },
        },
      },
    },
  },
};

type Outfit = { capsuleId: string; name: string; why: string; buy: { slot: string; title: string; category: string; replaces?: string }[] } & Record<(typeof SLOT_KEYS)[number], string[]>;
export interface DiscoverReply {
  status: string;
  reason: string;
  looks: Outfit[];
}

/** The fashion capsules a search can fill. */
export const searchCapsules = (db: DB) => db.capsules.filter((c) => !c.redirectCapsuleIds && c.kind !== 'selection' && !isCapsuleHidden(db, c));
const pieces = (db: DB) => ownedItems(db).filter((i) => !isBlockedEyewear(db, i.title));
const text = (v: unknown, n: number) => String(v ?? '').trim().slice(0, n);

function eligibleCapsules(db: DB, { capsuleId, requiredItemIds = [] }: Pick<Job, 'capsuleId' | 'requiredItemIds'>) {
  const caps = searchCapsules(db).filter((capsule) => (!capsuleId || capsule.id === capsuleId) &&
    (!capsule.pieces || requiredItemIds.every((id) => inSavedSet(db, capsule, { kind: 'item', id }))));
  if (requiredItemIds.length && !caps.length) {
    throw new HttpError(409, capsuleId
      ? 'У наборі цієї капсули бракує вибраних речей. Додай їх до набору або вибери іншу капсулу.'
      : 'Жодна капсула не містить усіх вибраних речей. Додай їх до набору капсули.');
  }
  return caps;
}

/** One search at a time; the owner's words, a capsule and picked pieces are optional. */
export function queueDiscover(db: DB, opts: { prompt?: string; capsuleId?: string; itemIds?: string[] }): Job {
  if (db.jobs.some((j) => j.kind === 'discover' && (j.state === 'queued' || j.state === 'running'))) throw new HttpError(409, 'Пошук уже йде — зачекай на результат');
  const capsuleId = opts.capsuleId || undefined;
  if (capsuleId && !searchCapsules(db).some((c) => c.id === capsuleId)) throw new HttpError(400, 'Такої капсули немає');
  const picked = (opts.itemIds ?? []).slice(0, 4).map((id) => {
    const item = db.items.find((i) => i.id === id);
    if (!item) throw new HttpError(404, 'Річ не знайдено');
    if (item.status === 'inactive' || item.mergedInto) throw new HttpError(400, 'Неактуальну річ не можна брати в образ');
    if (isBlockedEyewear(db, item.title)) throw new HttpError(400, 'Окуляри в образи не беру');
    return item;
  });
  const j: Job = {
    id: newId('J'), kind: 'discover', capsuleId, requiredItemIds: picked.length ? picked.map((i) => i.id) : undefined, lookVersion: 0,
    snapshot: { lookName: 'Нові образи', slots: [], basePhotoIds: [], basePhotoPaths: [] },
    instructions: text(opts.prompt, 400) || (picked.length ? `Доповнити: ${picked.map((i) => i.title).join(', ')}` : ''),
    state: 'queued', origin: 'site', createdAt: now(),
  };
  eligibleCapsules(db, j);
  db.jobs.push(j);
  return j;
}

const line = (db: DB, slots: Slots) =>
  SLOT_KEYS.flatMap((k) => slots[k].map((r) => (r.kind === 'item' ? `${k}:${r.id}` : `${k}:TO BUY ${db.needs.find((n) => n.id === r.id)?.title ?? r.id.replace(/^new:/, '')}`))).join(', ');

export function discoverPrompt(db: DB, job: Job) {
  const period = currentPeriod(new Date(), db.profile.hemisphere);
  const required = job.requiredItemIds ?? [];
  const items = pieces(db).filter((i) => !weakPiece(i) || required.includes(i.id));
  const caps = eligibleCapsules(db, job);
  const refused = [...refusedPieces(db, hiddenLookIds(db))].filter((id) => !required.includes(id));
  const prefs = db.profile.preferences;
  return [
    'You are the Capsula stylist worker running unattended. Answer with JSON only (schema enforced). Text only, no images.',
    `Today: ${new Date().toISOString().slice(0, 10)}; current weather period: ${PERIOD_LABEL[period]} (${PERIOD_TEMP[period]})${db.profile.location ? `, near ${db.profile.location}` : ''}.`,
    'The owner wants NEW looks in distinct FASHION capsules (refined modern direction). Each look must clearly belong to its capsule\'s aesthetic, palette and weather periods below, and must differ from every outfit listed under "Never again" and "Existing" (owner\'s rule: identical, one piece different, or one core piece different ignoring accessories = the same look).',
    focusLine(db),
    eyewearBlocked(db) ? 'No eyewear of any kind.' : '',
    `Profile — comfort: ${prefs.comfort || '—'}; materials: ${prefs.materials || '—'}; fit: ${prefs.fit || '—'}; branding: ${prefs.branding || '—'}.`,
    fitPromptBlock(db),
    job.instructions ? `The owner asks: ${job.instructions}` : `No request: start with the capsules of the current period and the ones with the fewest looks.`,
    required.length ? `Every look MUST contain these owned pieces: ${required.join(', ')}.` : '',
    required.length ? 'For picked pieces, use a weather period of their capsule. A capsule for another period is valid unless the owner explicitly asks for a particular period or weather.' : '',
    `Return up to ${MAX_SEARCH_RESULTS} looks. Each: capsuleId (one of the capsules below), a short elegant ${replyLanguage(db)} name, why (one ${replyLanguage(db)} sentence: the idea of the look), owned item ids per slot (top, layer, bottom, shoes, accessories — at most 1 per slot, 2 accessories), and buy: at most 2 pieces the owner does not have that make the look work (slot, a short ${replyLanguage(db)} name with colour and material, category). Prefer owned pieces; a look needs a top or an outer layer, a bottom and shoes (owned or to buy).`,
    refused.length ? `Pieces the owner keeps refusing — never use them: ${refused.join(', ')}.` : '',
    `Pieces already planned to buy — when a look needs one of them, use its exact name in buy: ${db.needs.filter((n) => n.status === 'open').map((n) => n.title).join('; ') || '—'}.`,
    '',
    'Capsules (id | name | periods | brief):',
    caps.map((c) => `${c.id} | ${c.name} | ${(c.periods ?? []).map((p) => PERIOD_LABEL[p]).join(', ') || '—'} | ${c.description.replace(/\s+/g, ' ').slice(0, 300)}`).join('\n'),
    ...setRules(db, caps),
    '',
    'Owned pieces (id | kind | title | colour):',
    items.map((i) => `${i.id} | ${CATEGORY_UK[i.category]} | ${i.title}${i.color ? ` | ${i.color}` : ''}`).join('\n'),
    '',
    'Never again (refused, disliked or deleted):',
    [
      ...(db.suggestions ?? []).filter((s) => s.status === 'rejected').flatMap((s) => s.looks.map((l) => withBuys(l.slots, l.buy))),
      ...db.looks.filter((l) => hiddenLookIds(db).has(l.id)).map((l) => l.slots),
      ...(db.lookMemory ?? []).map((m) => m.slots),
    ].slice(-60).map((s) => `- ${line(db, s)}`).join('\n') || '—',
    '',
    'Existing looks (do not repeat or near-copy):',
    db.looks.filter((l) => !hiddenLookIds(db).has(l.id)).slice(-60).map((l) => `- ${line(db, l.slots)}`).join('\n') || '—',
  ].filter((x) => x !== '').join('\n');
}

/**
 * A capsule with a saved set (owner, 20.11) takes looks made of its set only: owned pieces of the set, its planned
 * purchases by exact name, a new purchase only into a free place, or one that replaces a piece of the set.
 */
function setRules(db: DB, caps: DB['capsules']): string[] {
  const withSets = caps.filter((c) => c.pieces);
  if (!withSets.length) return [];
  const out = ['', 'Closed sets — a look for one of these capsules uses ONLY its set. Owned ids must be from the set; a planned purchase of the set goes into buy with its exact name and replaces "". A NEW piece to buy is allowed only into a free place (replaces ""), or with replaces = the id of the set piece of the same kind it replaces (then it takes that piece\'s place in the whole capsule). Otherwise use replaces "".'];
  for (const c of withSets) {
    const free = freePlaces(db, c)!;
    const owned = c.pieces!.filter((r) => r.kind === 'item').map((r) => r.id);
    const planned = c.pieces!.filter((r) => r.kind === 'need').map((r) => `${r.id} «${db.needs.find((n) => n.id === r.id)?.title ?? r.id}»`);
    out.push(`${c.id} set — owned: ${owned.join(', ') || '—'}; planned purchases: ${planned.join('; ') || '—'}; free places: garments ${free.garments}, shoes ${free.shoes}, accessories ${free.accessories}.`);
  }
  return out;
}

/** Saves a search: up to six new cards; the previous search's unanswered cards make room. */
export function applyDiscover(db: DB, job: Job, reply: DiscoverReply) {
  const owned = new Map(pieces(db).map((i) => [i.id, i] as const));
  const required = job.requiredItemIds ?? [];
  const avoid = refusedPieces(db, hiddenLookIds(db));
  for (const i of owned.values()) if (weakPiece(i)) avoid.add(i.id);
  for (const id of required) avoid.delete(id);
  const caps = new Map(eligibleCapsules(db, job).map((c) => [c.id, c] as const));
  const at = now();
  db.suggestions = (db.suggestions ?? []).filter((s) => !(s.source === 'search' && s.status === 'open'));
  const fresh: Slots[] = [];
  let added = 0;
  for (const o of (reply.looks ?? []).slice(0, MAX_SEARCH_RESULTS + 2)) {
    if (added >= MAX_SEARCH_RESULTS) break;
    const capsule = caps.get(text(o.capsuleId, 80));
    if (!capsule) continue;
    const slots = emptySlots();
    let bad = false;
    const setKeys = capsule.pieces ? new Set(capsule.pieces.map((r) => pieceKey(normalizePiece(db, r)))) : null;
    for (const k of SLOT_KEYS) {
      const list = [...new Set(o[k] ?? [])];
      if (list.some((id) => !owned.has(id) || !SLOT_CATEGORIES[k].includes(owned.get(id)!.category) || avoid.has(id))) bad = true;
      if (setKeys && list.some((id) => !setKeys.has(`item:${id}`))) bad = true;
      slots[k] = list.slice(0, k === 'accessories' ? 2 : 1).map((id) => ({ kind: 'item' as const, id }));
    }
    if (bad || required.some((id) => !Object.values(slots).flat().some((r) => r.id === id))) continue;
    const buy: NonNullable<Suggestion['looks'][number]['buy']> = [];
    const free = freePlaces(db, capsule);
    const replaced = new Set<string>();
    for (const b of (o.buy ?? []).slice(0, 2)) {
      const slot = b.slot as SlotKey;
      const category = b.category as Category;
      const title = text(b.title, 80);
      if (!title || !(SLOT_KEYS as readonly string[]).includes(slot) || !SLOT_CATEGORIES[slot].includes(category)) continue;
      if (slot !== 'accessories' && slots[slot].length) continue;
      // A dress is the whole outfit: nothing to buy for the bottom beside it.
      if (slot === 'bottom' && slots.top.some((r) => owned.get(r.id)?.category === 'dresses')) continue;
      if (free && setKeys) {
        // A closed set: a planned purchase of the set, a free place, or a named piece of the set it replaces.
        const planned = capsule.pieces!.some((r) => r.kind === 'need' && db.needs.some((n) => n.id === r.id && n.category === category && sameTitle(n.title, title)));
        const group = pieceGroup(category);
        const rep = text(b.replaces, 80);
        const target = rep ? capsule.pieces!.find((r) => pieceKey(r) === rep || r.id === rep) : undefined;
        if (planned) buy.push({ slot, title, category });
        else if (target && !replaced.has(pieceKey(target)) && pieceCategory(db, target) && pieceGroup(pieceCategory(db, target)!) === group) {
          replaced.add(pieceKey(target));
          buy.push({ slot, title, category, replaces: pieceKey(target) });
        } else if (free[group] > 0) {
          free[group] -= 1;
          buy.push({ slot, title, category });
        } else bad = true;
        continue;
      }
      buy.push({ slot, title, category });
    }
    if (bad) continue;
    // A replaced piece cannot stay in the same look.
    if ([...replaced].some((key) => Object.values(slots).flat().some((r) => pieceKey(r) === key))) continue;
    const has = (k: SlotKey) => slots[k].length > 0 || buy.some((b) => b.slot === k);
    if (!(has('top') || has('layer')) || !has('bottom') || !has('shoes')) continue;
    const check = withBuys(slots, buy);
    if (alreadySeen(db, check, fresh)) continue;
    fresh.push(check);
    const name = text(o.name, 80) || 'Новий образ';
    const why = text(o.why, 240);
    db.suggestions.push({ id: newId('A'), kind: 'look', status: 'open', source: 'search', name, why, capsuleId: capsule.id, looks: [{ name, why, slots, buy: buy.length ? buy : undefined }], jobId: job.id, createdAt: at });
    added += 1;
  }
  return added ? `Нових образів: ${added}` : 'Нового не знайдено — усе схоже вже було';
}

export { seenCompositions };
