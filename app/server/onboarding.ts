// Steps 2 & 4 of onboarding:
// - capsule_plan: proposes 2–4 distinct fashion capsules from the person's free-text request → human review → db.capsules
// - capsule_match: matches confirmed wardrobe items + targeted gaps into closed sets → human review → capsule.pieces + db.needs
import type { Capsule, CapsuleDraft, CapsuleMatchDraft, Category, DB, Job, Need, Period, Season, SlotRef } from './schema.ts';
import { fitPromptBlock } from './fit.ts';
import { CATEGORIES, PERIODS, SEASONS } from './schema.ts';
import { HttpError, newId, now } from './store.ts';
import { focusLine, replyLanguage } from './person.ts';
import { CATEGORY_UK, ownedItems } from './analysis.ts';
import { PERIOD_LABEL, currentPeriod, isBlockedEyewear } from '../src/lib.ts';
import { CAPSULE_LIMITS, MAX_BASE_PIECES, capsuleLimits, fashionCapsules, pieceGroup, pieceKey, sameTitle, type PieceGroup } from '../src/capsule-pieces.ts';
import { setCapsulePieces } from './capsule-membership.ts';

const str = { type: 'string' } as const;
const strArr = { type: 'array', items: str } as const;

export const CAPSULE_PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'reason', 'capsules'],
  properties: {
    status: { type: 'string', enum: ['done', 'error'] },
    reason: str,
    capsules: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'season', 'periods', 'description', 'situations', 'keyPieces'],
        properties: {
          name: str,
          season: { type: 'string', enum: [...SEASONS] },
          periods: { type: 'array', items: { type: 'string', enum: [...PERIODS] } },
          description: str,
          situations: strArr,
          keyPieces: strArr,
        },
      },
    },
  },
} as const;

export const CAPSULE_MATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'reason', 'sets', 'unmatchedItemIds'],
  properties: {
    status: { type: 'string', enum: ['done', 'error'] },
    reason: str,
    sets: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['capsuleId', 'ownedItemIds', 'baseItemIds', 'missing', 'note'],
        properties: {
          capsuleId: str,
          ownedItemIds: strArr,
          baseItemIds: strArr,
          note: str,
          missing: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['title', 'category', 'priority', 'why'],
              properties: {
                title: str,
                category: { type: 'string', enum: [...CATEGORIES] },
                priority: { type: 'string', enum: ['core', 'optional'] },
                why: str,
              },
            },
          },
        },
      },
    },
    unmatchedItemIds: strArr,
  },
} as const;

const clip = (v: unknown, max: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Queues a capsule_plan job from the person's lifestyle/style request. */
export function queueCapsulePlan(db: DB, prompt: string): Job {
  const clean = clip(prompt, 800);
  if (!clean) throw new HttpError(400, 'Опиши, які капсули або стиль тобі потрібні');
  if (db.jobs.some((j) => j.kind === 'capsule_plan' && (j.state === 'queued' || j.state === 'running'))) {
    throw new HttpError(409, 'Капсули вже підбираються — зачекай на результат');
  }
  db.onboarding ??= {};
  db.onboarding.capsulePrompt = clean;
  const job: Job = {
    id: newId('J'),
    kind: 'capsule_plan',
    lookVersion: 0,
    snapshot: { lookName: 'План капсул', slots: [], basePhotoIds: [], basePhotoPaths: [] },
    instructions: clean,
    state: 'queued',
    origin: 'site',
    createdAt: now(),
  };
  db.jobs.push(job);
  return job;
}

export function capsulePlanPrompt(db: DB, job: Job): string {
  const existing = fashionCapsules(db).map((c) => c.name);
  const prefs = db.profile.preferences;
  const period = currentPeriod(new Date(), db.profile.hemisphere);
  const lang = replyLanguage(db);
  return [
    `You are the Capsula fashion stylist worker running unattended. Answer with JSON only (schema enforced). Write every text in ${lang}.`,
    focusLine(db),
    `Current weather period: ${PERIOD_LABEL[period]}${db.profile.location ? `, near ${db.profile.location}` : ''}.`,
    `Profile preferences — comfort: ${prefs.comfort || '—'}; materials: ${prefs.materials || '—'}; fit: ${prefs.fit || '—'}; branding: ${prefs.branding || '—'}.`,
    '',
    `The person asks for capsules: "${job.instructions}"`,
    '',
    'Design 2 to 4 DISTINCT fashion capsules tailored to this person.',
    'Strict Capsula rules:',
    '- Each capsule is ONE distinct fashion style (silhouette, colour palette, materials, mood) built on a compact closed set (up to 10 garments, 3 pairs of shoes, 3 accessories) where almost every top pairs with every bottom.',
    '- NEVER create a capsule that is merely a season ("Summer"), a ranking ("Best"), or a dump of random clothes.',
    '- Use clear, modern, refined style names (e.g. Smart Casual, Coastal Linen, Quiet City, Studio Minimal, Weekend Outdoor — in English or natural local fashion naming matching the language).',
    `- description: 2–3 concise sentences in ${lang} covering the style idea, neutral + accent colour palette, and key fabrics/materials.`,
    '- periods: 1 to 5 weather periods from the enum where this capsule is worn; season: matching overall season (warm | transitional | cold | all).',
    '- situations: 2–3 short situations (≤ 22 chars each, e.g. "Офіс", "Вечеря", "Прогулянка" or "Office", "Dinner", "City walk").',
    '- keyPieces: 5–6 concise example key pieces of the style (colour + garment type) appropriate for the person\'s wardrobe focus.',
    existing.length ? `Already in this wardrobe (do NOT repeat these names): ${existing.join(', ')}.` : '',
    'Return status "error" only if the request is unreadable; otherwise status "done" and reason "".',
  ]
    .filter(Boolean)
    .join('\n');
}

interface CapsulePlanReply {
  status: string;
  reason: string;
  capsules: { name: string; season: string; periods: string[]; description: string; situations: string[]; keyPieces: string[] }[];
}

export function applyCapsulePlan(db: DB, _job: Job, reply: CapsulePlanReply): string {
  const taken = new Set(fashionCapsules(db).map((c) => c.name.toLowerCase()));
  const drafts: CapsuleDraft[] = [];
  for (const raw of (reply.capsules ?? []).slice(0, 5)) {
    const name = clip(raw.name, 80);
    if (!name || taken.has(name.toLowerCase())) continue;
    taken.add(name.toLowerCase());
    const season: Season = SEASONS.includes(raw.season as Season) ? (raw.season as Season) : 'all';
    const periods = [...new Set((raw.periods ?? []).filter((p): p is Period => PERIODS.includes(p as Period)))];
    drafts.push({
      id: newId('CD'),
      name,
      season,
      periods: periods.length ? periods : ['spring', 'early-autumn'],
      description: clip(raw.description, 600),
      situations: (raw.situations ?? []).map((s) => clip(s, 40)).filter(Boolean).slice(0, 4),
      keyPieces: (raw.keyPieces ?? []).map((s) => clip(s, 80)).filter(Boolean).slice(0, 8),
      selected: true,
    });
  }
  db.onboarding ??= {};
  db.onboarding.capsuleDrafts = drafts;
  db.onboarding.step ??= 2;
  return drafts.length ? `Запропоновано капсул: ${drafts.length}` : 'Не вдалося підібрати нові капсули';
}

export function approveCapsules(
  db: DB,
  rawList: { name: string; season?: string; periods?: string[]; description?: string; situations?: string[] }[],
): Capsule[] {
  if (!Array.isArray(rawList) || !rawList.length) throw new HttpError(400, 'Вибери хоча б одну капсулу');
  const existing = new Set(fashionCapsules(db).map((c) => c.name.toLowerCase()));
  const created: Capsule[] = [];
  const at = now();
  for (const raw of rawList.slice(0, 8)) {
    const name = clip(raw.name, 80);
    if (!name || existing.has(name.toLowerCase())) continue;
    existing.add(name.toLowerCase());
    const season: Season = SEASONS.includes(raw.season as Season) ? (raw.season as Season) : 'all';
    const periods = [...new Set((raw.periods ?? []).filter((p): p is Period => PERIODS.includes(p as Period)))];
    const capsule: Capsule = {
      id: newId('C'),
      rev: 1,
      kind: 'capsule',
      name,
      season,
      ...(periods.length ? { periods } : {}),
      description: clip(raw.description, 1200),
      situations: (raw.situations ?? []).map((s) => clip(s, 60)).filter(Boolean).slice(0, 6),
      favorite: false,
      lookIds: [],
      origin: 'owner',
      createdAt: at,
      updatedAt: at,
    };
    db.capsules.push(capsule);
    created.push(capsule);
  }
  if (!created.length) throw new HttpError(409, 'Усі вибрані капсули вже існують');
  db.onboarding ??= {};
  delete db.onboarding.capsuleDrafts;
  db.onboarding.step = Math.max(db.onboarding.step ?? 2, 3) as 1 | 2 | 3 | 4 | 5;
  return created;
}

/** Owned items eligible for capsule matching (confirmed first; candidates included if the user skipped confirming). */
export function matchableItems(db: DB) {
  const all = ownedItems(db).filter((i) => !isBlockedEyewear(db, i.title));
  const confirmed = all.filter((i) => i.status === 'confirmed');
  return confirmed.length ? confirmed : all;
}

export function queueCapsuleMatch(db: DB, capsuleIds?: string[]): Job {
  const caps = fashionCapsules(db).filter((c) => !capsuleIds?.length || capsuleIds.includes(c.id));
  if (!caps.length) throw new HttpError(400, 'Спершу додай хоча б одну капсулу');
  const items = matchableItems(db);
  if (!items.length) throw new HttpError(400, 'Спершу додай речі в гардероб');
  if (db.jobs.some((j) => j.kind === 'capsule_match' && (j.state === 'queued' || j.state === 'running'))) {
    throw new HttpError(409, 'Розклад по капсулах уже триває — зачекай на результат');
  }
  const job: Job = {
    id: newId('J'),
    kind: 'capsule_match',
    lookVersion: 0,
    targetCapsuleIds: caps.map((c) => c.id),
    snapshot: { lookName: 'Набори капсул', slots: [], basePhotoIds: [], basePhotoPaths: [] },
    instructions: '',
    state: 'queued',
    origin: 'site',
    createdAt: now(),
  };
  db.jobs.push(job);
  return job;
}

export function capsuleMatchPrompt(db: DB, job: Job, attached: string[]): string {
  const caps = fashionCapsules(db).filter((c) => !job.targetCapsuleIds?.length || job.targetCapsuleIds.includes(c.id));
  const items = matchableItems(db);
  const openNeeds = db.needs.filter((n) => n.status === 'open');
  const lang = replyLanguage(db);
  const prefs = db.profile.preferences;
  return [
    `You are the Capsula wardrobe architect worker running unattended. Answer with JSON only (schema enforced). Write all text in ${lang}.`,
    focusLine(db),
    `Profile preferences — comfort: ${prefs.comfort || '—'}; materials: ${prefs.materials || '—'}; fit: ${prefs.fit || '—'}; branding: ${prefs.branding || '—'}.`,
    fitPromptBlock(db),
    '',
    'Task: match the person\'s existing wardrobe items onto their fashion capsules as COMPACT CLOSED SETS.',
    `Standard capsules hold up to ${CAPSULE_LIMITS.garments} garments (outerwear + knitwear + shirts + tees + dresses + trousers + shorts + skirts), ${CAPSULE_LIMITS.shoes} pairs of shoes, and ${CAPSULE_LIMITS.accessories} accessories. Multisport capsules may specify 4 accessories. Follow the limits shown per capsule below, counting ownedItemIds and missing purchases together.`,
    'Rules:',
    '- Every capsule must stay true to its aesthetic, palette, materials and weather periods. Prefer cohesion over stuffing every item in.',
    '- A truly versatile basic (e.g. white sneakers, plain tee, neutral coat) may be shared across 2 capsules, but each capsule should keep a distinct core.',
    `- baseItemIds: pick 1 to ${MAX_BASE_PIECES} anchor owned item id(s) from that capsule's ownedItemIds that hold the capsule together (e.g. unstructured blazer, signature trousers, key coat).`,
    '- missing: propose 0 to 3 high-leverage pieces to BUY that fit within the capsule\'s remaining capacity and multiply valid outfit combinations (formula: (tops × bottoms + dresses) × (layers + 1) × shoes). Reuse exact titles from Open purchases below when relevant.',
    '- unmatchedItemIds: owned item ids that genuinely do not fit any of these capsules (be honest, do not force mismatches into capsules).',
    `- note: one concise sentence in ${lang} explaining the cohesion and main gap of the capsule.`,
    attached.length ? `Catalogue thumbnails of ${attached.length} owned items are attached (named by item id) for colour and silhouette reference.` : '',
    '',
    'Capsules (id | name | periods | brief | limits: garments/shoes/accessories):',
    caps.map((c) => {
      const lim = capsuleLimits(c);
      return `${c.id} | ${c.name} | ${(c.periods ?? []).map((p) => PERIOD_LABEL[p]).join(', ') || '—'} | ${c.description.replace(/\s+/g, ' ').slice(0, 350)} | limits: ${lim.garments}/${lim.shoes}/${lim.accessories}`;
    }).join('\n'),
    '',
    'Owned wardrobe items (id | category | title | details):',
    items.map((i) => `${i.id} | ${CATEGORY_UK[i.category]} (${i.category}) | ${i.title}${[i.color, i.brand, i.fit].filter(Boolean).length ? ` | ${[i.color, i.brand, i.fit].filter(Boolean).join(', ')}` : ''}`).join('\n'),
    '',
    openNeeds.length ? `Open purchases already planned: ${openNeeds.map((n) => `${n.title} (${n.category})`).join('; ')}` : '',
    'Return status "error" only if no valid sets can be produced; otherwise status "done" and reason "".',
  ]
    .filter(Boolean)
    .join('\n');
}

interface CapsuleMatchReply {
  status: string;
  reason: string;
  sets: {
    capsuleId: string;
    ownedItemIds: string[];
    baseItemIds: string[];
    missing: { title: string; category: string; priority: string; why: string }[];
    note: string;
  }[];
  unmatchedItemIds: string[];
}

export function applyCapsuleMatch(db: DB, job: Job, reply: CapsuleMatchReply): string {
  const validCaps = new Map(fashionCapsules(db).filter((c) => !job.targetCapsuleIds?.length || job.targetCapsuleIds.includes(c.id)).map((c) => [c.id, c]));
  const itemById = new Map(matchableItems(db).map((i) => [i.id, i] as const));
  const drafts: CapsuleMatchDraft[] = [];
  const usedAnywhere = new Set<string>();

  for (const raw of reply.sets ?? []) {
    const cap = validCaps.get(raw.capsuleId);
    if (!cap || drafts.some((d) => d.capsuleId === raw.capsuleId)) continue;
    const limits = capsuleLimits(cap);
    const counts: Record<PieceGroup, number> = { garments: 0, shoes: 0, accessories: 0 };
    const ownedItemIds: string[] = [];
    for (const id of [...new Set(raw.ownedItemIds ?? [])]) {
      const item = itemById.get(id);
      if (!item) continue;
      const g = pieceGroup(item.category);
      if (counts[g] >= limits[g]) continue;
      counts[g] += 1;
      ownedItemIds.push(id);
      usedAnywhere.add(id);
    }
    const baseItemIds = [...new Set(raw.baseItemIds ?? [])]
      .filter((id) => ownedItemIds.includes(id))
      .slice(0, MAX_BASE_PIECES);

    const missing: CapsuleMatchDraft['missing'] = [];
    for (const m of (raw.missing ?? []).slice(0, 4)) {
      const title = clip(m.title, 100);
      const category = m.category as Category;
      if (!title || !CATEGORIES.includes(category)) continue;
      const g = pieceGroup(category);
      if (counts[g] >= limits[g]) continue;
      if (missing.some((x) => x.category === category && sameTitle(x.title, title))) continue;
      counts[g] += 1;
      missing.push({
        id: newId('CM'),
        title,
        category,
        priority: m.priority === 'optional' ? 'optional' : 'core',
        why: clip(m.why, 220),
        selected: true,
      });
    }
    drafts.push({
      capsuleId: raw.capsuleId,
      ownedItemIds,
      baseItemIds,
      missing,
      ...(clip(raw.note, 260) ? { note: clip(raw.note, 260) } : {}),
    });
  }

  const unmatchedItemIds = [...itemById.keys()].filter((id) => !usedAnywhere.has(id));
  db.onboarding ??= {};
  db.onboarding.matchDrafts = drafts;
  db.onboarding.unmatchedItemIds = unmatchedItemIds;
  db.onboarding.step = Math.max(db.onboarding.step ?? 4, 4) as 1 | 2 | 3 | 4 | 5;
  return drafts.length ? `Підготовлено наборів: ${drafts.length}` : 'Не вдалося зібрати набори капсул';
}

export interface ApprovedSetInput {
  capsuleId: string;
  ownedItemIds: string[];
  baseItemIds?: string[];
  missing?: { title: string; category: Category; priority?: 'core' | 'optional'; why?: string }[];
}

/** Commits human-reviewed closed sets onto capsules and creates/reuses approved shopping Needs. */
export function approveSets(db: DB, sets: ApprovedSetInput[]): { capsules: number; needsCreated: number; needIds: string[] } {
  if (!Array.isArray(sets) || !sets.length) throw new HttpError(400, 'Немає наборів для затвердження');
  const at = now();
  let capsules = 0;
  let needsCreated = 0;
  const needIds: string[] = [];

  for (const s of sets) {
    const capsule = db.capsules.find((c) => c.id === s.capsuleId);
    if (!capsule || capsule.redirectCapsuleIds) throw new HttpError(404, 'Капсулу не знайдено');
    const pieces: SlotRef[] = [];
    const seen = new Set<string>();
    for (const id of s.ownedItemIds ?? []) {
      const item = db.items.find((i) => i.id === id && i.status !== 'inactive' && !i.mergedInto);
      if (!item) continue;
      const ref: SlotRef = { kind: 'item', id: item.id };
      if (!seen.has(pieceKey(ref))) {
        seen.add(pieceKey(ref));
        pieces.push(ref);
      }
    }
    for (const m of s.missing ?? []) {
      const title = clip(m.title, 120);
      if (!title || !CATEGORIES.includes(m.category)) continue;
      let need = db.needs.find((n) => n.status === 'open' && n.category === m.category && sameTitle(n.title, title));
      if (!need) {
        need = {
          id: newId('N'),
          rev: 1,
          title,
          category: m.category,
          priority: m.priority === 'optional' ? 'optional' : 'core',
          description: '',
          why: clip(m.why, 240),
          fitCheck: '',
          status: 'open',
          origin: 'agent',
          forCapsule: capsule.id,
          createdAt: at,
          updatedAt: at,
        };
        db.needs.push(need);
        needsCreated += 1;
      }
      needIds.push(need.id);
      const ref: SlotRef = { kind: 'need', id: need.id };
      if (!seen.has(pieceKey(ref))) {
        seen.add(pieceKey(ref));
        pieces.push(ref);
      }
    }
    const base: SlotRef[] = [...new Set(s.baseItemIds ?? [])]
      .filter((id) => seen.has(`item:${id}`))
      .slice(0, MAX_BASE_PIECES)
      .map((id) => ({ kind: 'item', id }));
    setCapsulePieces(db, capsule, pieces, base);
    capsule.rev += 1;
    capsule.updatedAt = at;
    capsules += 1;
  }

  db.onboarding ??= {};
  delete db.onboarding.matchDrafts;
  delete db.onboarding.unmatchedItemIds;
  db.onboarding.step = Math.max(db.onboarding.step ?? 4, 5) as 1 | 2 | 3 | 4 | 5;
  return { capsules, needsCreated, needIds: [...new Set(needIds)] };
}
