// Text/vision analysis jobs (no image output): photo intake and the outfit
// analyzer. Codex answers with JSON constrained by --output-schema; the result
// is validated here before anything is written.
import type { Category, DB, Item, Job, Look, Season, SlotKey, Slots } from './schema.ts';
import { CATEGORIES, SEASONS, SLOT_KEYS, emptySlots } from './schema.ts';
import { newId, now } from './store.ts';
import { focusLine, replyLanguage } from './person.ts';
import { hiddenLookIds, lookKeys } from '../src/rating.ts';
import { isBlockedEyewear, weakPiece } from '../src/lib.ts';
import { alreadySeen, refusedPieces } from '../src/look-memory.ts';
import { fitPromptBlock } from './fit.ts';

export const CATEGORY_UK: Record<Category, string> = {
  outerwear: 'верхній одяг', knitwear: 'худі й трикотаж', shirts: 'сорочки й поло', tees: 'футболки', dresses: 'сукні',
  trousers: 'штани', shorts: 'шорти', skirts: 'спідниці', shoes: 'взуття', accessories: 'аксесуари',
};

const str = { type: 'string' } as const;
const ids = { type: 'array', items: { type: 'string' } } as const;

export const PHOTO_TYPES = ['person_full_body', 'person_face', 'person_partial', 'garments_only', 'label', 'other'] as const;

/** One upload control: Codex decides what the photo is and what to do with it. */
export const INTAKE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'reason', 'photoType', 'singlePerson', 'baseSuitable', 'baseIssues', 'garments', 'label'],
  properties: {
    status: { type: 'string', enum: ['done', 'error'] },
    reason: str,
    photoType: { type: 'string', enum: [...PHOTO_TYPES] },
    singlePerson: { type: 'boolean' },
    baseSuitable: { type: 'boolean' },
    baseIssues: str,
    label: {
      type: 'object',
      additionalProperties: false,
      required: ['itemId', 'brand', 'size', 'composition'],
      properties: { itemId: str, brand: str, size: str, composition: str },
    },
    garments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'category', 'color', 'notes', 'duplicateOf', 'coversNeed', 'sport'],
        properties: { title: str, category: { type: 'string', enum: [...CATEGORIES] }, color: str, notes: str, duplicateOf: str, coversNeed: str, sport: { type: 'boolean' } },
      },
    },
  },
};

export const VISUAL_DEDUP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['matches'],
  properties: {
    matches: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['garmentIndex', 'itemId', 'confidence', 'reason'],
        properties: { garmentIndex: { type: 'integer' }, itemId: str, confidence: { type: 'string', enum: ['high', 'possible'] }, reason: str },
      },
    },
  },
};

/**
 * The visual check of one contact sheet. `include` picks the garments compared on it (their indices stay those of
 * the whole upload); a garment the text pass already named carries that id so the picture can confirm it.
 */
export function visualDedupPrompt(garments: IntakeReply['garments'], candidates: Item[], include: (garment: IntakeReply['garments'][number], index: number) => boolean = (g) => !g.duplicateOf) {
  return [
    'Compare the first attachment (new upload) with the second (numbered wardrobe contact sheet). Find the same physical garment in both. Return JSON only.',
    'Match garments within the same category using distinctive construction, hardware, seams, texture, pattern and logos. Colour and category alone are insufficient when a distinctive detail is visible. Ignore faces, poses and backgrounds.',
    'Allow for a mirror photo reversing left and right, and for changes in lighting or logo wear. Check the logo shape and placement after accounting for mirroring.',
    'Basic or partly hidden garments (a plain tee under an open jacket, a plain knit): high only when ALL hold — the colour family matches allowing for lighting (cream, milk and white read alike indoors; light blue can read white), the silhouette and cut match (neckline, sleeve, length, fit), the visible details match, and NO logo, print, pattern or hardware on either side contradicts the other. Anything less is possible at most.',
    'Two distinct garments in the upload are never the same wardrobe item: give each itemId to at most one garment.',
    'Return at most one match per garment. Use its zero-based garmentIndex and the exact itemId from the sheet legend. Use high for a distinctive match or a basic garment matching as above, possible for a plausible visual match with some details hidden, and omit weak matches. Briefly state the visible evidence in reason.',
    'Garments in the upload:',
    ...garments.map((g, index) => include(g, index) ? `${index} | ${g.category} | ${g.title} | ${g.color} | ${g.notes}${g.duplicateOf ? ` | text match: ${g.duplicateOf}` : ''}` : '').filter(Boolean),
    'Contact sheet legend (cell number | itemId | category | title):',
    ...candidates.map((item, index) => `${index + 1} | ${item.id} | ${item.category} | ${item.title}${item.color ? ` | ${item.color}` : ''}`),
  ].join('\n');
}

// Ukrainian endings (longest first) so «біла», «білий» and «білого» meet as «біл»; English plurals likewise.
const ENDINGS = ['ого', 'ому', 'ими', 'іми', 'ій', 'ий', 'ая', 'яя', 'ою', 'ею', 'ої', 'ей', 'их', 'іх', 'ім', 'им', 'ом', 'ем', 'ам', 'ям', 'ах', 'ях', 'es', 'а', 'я', 'е', 'є', 'и', 'і', 'у', 'ю', 'о', 'ь', 's'];
export function stem(word: string) {
  const w = word.toLowerCase();
  if (w.length < 4) return w;
  for (const end of ENDINGS) if (w.endsWith(end) && w.length - end.length >= 3) return w.slice(0, -end.length);
  return w;
}
const garmentWords = (text: string) => new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 3).map(stem));
const sharedWords = (a: Set<string>, b: Set<string>) => [...a].filter((word) => b.has(word)).length;

/** Colour families: names that one garment gets under different light (cream ≈ white, sky ≈ blue). `light` joins pale shades across families. */
const COLOUR_FAMILIES: [string, RegExp][] = [
  ['white', /біл|молочн|кремов|вершков|екрю|айвор|white|cream|ivory|ecru|milk|off[\s-]?white/],
  ['blue', /син|блакитн|голуб|індиго|navy|blue|indigo|sky|cobalt|azure/],
  ['brown', /коричнев|бежев|пісочн|кемел|тауп|шоколад|горіхов|brown|beige|sand|camel|taupe|tan\b|chocolate|cognac|коньячн/],
  ['black', /чорн|black/],
  ['grey', /сір|графіт|антрацит|grey|gray|charcoal|graphite|anthracite/],
  ['green', /зелен|оливк|оливков|хакі|olive|green|khaki|sage/],
  ['red', /червон|рожев|бордов|бордо|малинов|red|pink|burgundy|wine|rose/],
  ['yellow', /жовт|помаранч|гірчичн|yellow|orange|mustard/],
  ['light', /світл|блід|молочн|кремов|вершков|екрю|айвор|блакитн|голуб|бежев|пісочн|light|pale|sky|cream|ivory|ecru|beige|sand/],
];
export function colourFamilies(text: string) {
  const t = text.toLowerCase();
  return new Set(COLOUR_FAMILIES.filter(([, re]) => re.test(t)).map(([family]) => family));
}
const familyScore = (a: Set<string>, b: Set<string>) => [...a].reduce((n, f) => n + (b.has(f) ? (f === 'light' ? 1 : 3) : 0), 0);

/** A garment a contact sheet should check: not named yet, or named by text as a confirmed item the picture must confirm. */
export const needsVisualCheck = (db: DB, garment: IntakeReply['garments'][number]) =>
  !garment.duplicateOf || db.items.find((i) => i.id === garment.duplicateOf)?.status === 'confirmed';

/**
 * Likely references per category of the garments still to check, best first: colour family, shared word stems,
 * confirmed items on ties. A text-named confirmed item leads its category. Vision still decides the match.
 */
export function intakeComparisonGroups(db: DB, garments: IntakeReply['garments']): Map<string, Item[]> {
  const checked = garments.filter((g) => needsVisualCheck(db, g));
  const named = new Set(checked.map((g) => g.duplicateOf).filter(Boolean));
  const groups = new Map<string, Item[]>();
  for (const category of new Set(checked.map((g) => g.category))) {
    const wanted = checked.filter((g) => g.category === category).map((g) => ({
      title: garmentWords(`${g.title} ${g.notes ?? ''}`),
      colour: garmentWords(g.color),
      families: colourFamilies(`${g.color} ${g.title}`),
    }));
    const lead = ownedItems(db).filter((item) => item.category === category && named.has(item.id));
    const ranked = ownedItems(db).filter((item) => item.category === category && !named.has(item.id)).map((item) => {
      const title = garmentWords([item.title, item.brand, item.model].filter(Boolean).join(' '));
      const colour = garmentWords(item.color ?? '');
      const families = colourFamilies(`${item.color ?? ''} ${item.title}`);
      const score = Math.max(...wanted.map((g) => familyScore(families, g.families) + 2 * sharedWords(title, g.title) + sharedWords(colour, g.colour)));
      return { item, score };
    }).sort((a, b) => b.score - a.score || Number(b.item.status === 'confirmed') - Number(a.item.status === 'confirmed')).map(({ item }) => item);
    groups.set(category, [...lead, ...ranked]);
  }
  return groups;
}

/** Every likely reference, category by category (see intakeComparisonGroups). */
export function intakeComparisonCandidates(db: DB, garments: IntakeReply['garments']) {
  return [...intakeComparisonGroups(db, garments).values()].flat();
}

export const ANALYZE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'reason', 'name', 'description', 'looks'],
  properties: {
    status: { type: 'string', enum: ['done', 'error'] },
    reason: str,
    name: str,
    description: str,
    looks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'occasion', 'season', 'top', 'layer', 'bottom', 'shoes', 'accessories', 'why'],
        properties: { name: str, occasion: str, season: { type: 'string', enum: [...SEASONS] }, top: ids, layer: ids, bottom: ids, shoes: ids, accessories: ids, why: str },
      },
    },
  },
};

function wardrobeLines(db: DB, items: Item[]) {
  return items
    .map((i) => {
      const facts = [i.color, i.brand, i.fit, i.size].filter(Boolean).join(', ');
      return `${i.id} | ${CATEGORY_UK[i.category]} | ${i.title}${facts ? ` | ${facts}` : ''} | ${i.status === 'confirmed' ? 'confirmed by owner' : 'candidate'}${i.observation ? ` | ${i.observation}` : ''}`;
    })
    .join('\n');
}

export function ownedItems(db: DB) {
  return db.items.filter((i) => i.status !== 'inactive' && !i.mergedInto);
}

const openNeedLines = (db: DB) =>
  db.needs.filter((n) => n.status === 'open').map((n) => `${n.id} | ${CATEGORY_UK[n.category]} | ${n.title} | ${(n.description ?? '').replace(/\s+/g, ' ') || '—'} | ${(n.why ?? '').replace(/\s+/g, ' ') || '—'}`).join('\n');

export function intakePrompt(db: DB, job: Job, photoNames: string[]) {
  const intent = job.intakeIntent ?? 'auto';
  return [
    'You are the Capsula photo intake worker running unattended. The owner uploads any photo through one button; decide what it is and answer with JSON only (schema enforced).',
    `Uploaded photo: ${photoNames.join(', ')}. The photo belongs to this wardrobe account. Treat the clear main subject as the uploader for try-on suitability. Do not try to identify anyone or compare faces.`,
    'photoType: person_full_body = the main person visible head to shoes; person_face = close-up of the main person\'s face/shoulders; person_partial = the main person visible but cropped (e.g. shoes hidden); garments_only = clothes/shoes/accessories without a person (hanger, flat lay, floor, product photo); label = a garment label/tag close-up; other = anything else.',
    'singlePerson: true if exactly one person is the main subject (others absent or clearly in the background).',
    `baseSuitable: true only for person_full_body or person_face photos with singlePerson that meet the try-on base-photo standard: front-facing, eyes visible, no sunglasses/cap, no phone or objects in front of the body, not a mirror selfie, even light, plain background, sharp; full length for person_full_body. baseIssues: in ${replyLanguage(db)}, a short comma list of what breaks the standard (empty string if none or not applicable).`,
    'Return status "error" only if the image cannot be analysed at all; otherwise status "done" and reason "" (photoType other is still "done").',
    job.instructions ? `Owner note: ${job.instructions}` : '',
    ...(intent === 'person' ? [
      'This upload is a personal reference. Only evaluate photoType, singlePerson, baseSuitable and baseIssues. Always return garments: [] and label with all four fields set to empty strings, regardless of the photo or owner note.',
    ] : [
      'label: for photoType label, read the tag: brand, size, composition (as printed, keep original language) and itemId of the wardrobe item it most likely belongs to (empty string if unclear). For other photo types all label fields are empty strings.',
      'garments: for person_full_body, person_partial and garments_only list every distinct garment, pair of shoes and visible accessory of the main person or shown on its own (ignore other people, the phone, mirror and background). Only wearable items: clothing, shoes and fashion accessories (watch, glasses, cap/hat, belt, scarf, bag or backpack worn as part of the outfit). Never list shopping bags, phones, headphones/earbuds, keys or other objects. Skip anything barely visible that cannot be described reliably. For person_face, label and other: an empty array.',
      `For each: title in ${replyLanguage(db)} (short, descriptive: colour + type + visible brand only if the logo is clearly legible), category from the enum, colour in ${replyLanguage(db)}, notes in ${replyLanguage(db)} (visible construction, material look, uncertainty). Never guess sizes, exact models or composition.`,
      'Colour under indoor and mirror light: correct for the white balance first (warm bulbs turn everything yellow, daylight through a window turns it blue). Compare the garment with things that are truly white nearby (walls, sockets, paper). Light blue / sky blue is NOT white: a shirt that reads pale blue against a white wall is light blue. Cream, ivory, milk and ecru are NOT pure white: a warm off-white tee is milk or cream. A fine blue-on-white pattern (pinstripe, micro-check, oxford weave) that reads light blue from a step away is named light blue, with the pattern in notes. Say «white» only for a clean, neutral white.',
      'Set sport to true for athletic, gym, cycling, swimming or running clothing or sports equipment; otherwise false.',
      'duplicateOf: check the existing wardrobe list before treating anything as new. Put a listed id (e.g. W-047) only when distinctive details visible here match that item\'s notes — hardware shape and colour (buckle, zip, buttons), texture, stitching, logo, pattern. The same type and colour alone is NOT enough: the owner may have several black belts, white tees or dark jackets. If the listed item is known only from a worn or mirror photo, or any visible detail differs, use an empty string — a new candidate the owner can merge is better than hiding a new item inside an old one.',
      'coversNeed: the shopping list below holds things the owner was advised to buy (id | category | title | description | why). If this garment is a physical piece the owner has — worn, on a hanger, on the floor, laid flat, or newly bought with a store tag or label still attached — and it is what one of those entries asks for (same category, same garment type, same colour family), put that need id (e.g. N-10); a small logo or minor detail difference is fine, a different colour or garment type is not. Skip only web-store screenshots and catalogue listings. Otherwise an empty string. One garment covers at most one need.',
      '',
      'Existing wardrobe:',
      wardrobeLines(db, ownedItems(db)),
      '',
      'Shopping list (open recommendations):',
      openNeedLines(db) || '(empty)',
    ]),
  ]
    .filter(Boolean)
    .join('\n');
}

export const ANALYZE_THEMES = [
  'Smart casual для зустрічей і вечері',
  'Спортивний вікенд і активний день',
  'Теплі шари на холодну погоду',
  'Монохромні образи й тон-в-тон',
  'Кольорові акценти на спокійній базі',
  'Легкі образи на теплий день',
  'Подорож: зручно й охайно',
  'Денім у різних поєднаннях',
];

/** A theme not used by recent selections, so an empty request still gives something new. */
export function pickTheme(db: DB) {
  const recent = db.capsules.filter((c) => c.kind === 'selection').map((c) => c.sourceNote ?? '').join(' ');
  const fresh = ANALYZE_THEMES.filter((t) => !recent.includes(t));
  const pool = fresh.length ? fresh : ANALYZE_THEMES;
  return pool[Math.floor(Math.random() * pool.length)];
}

const lookItems = (l: Look) => new Set(SLOT_KEYS.flatMap((k) => l.slots[k].filter((r) => r.kind === 'item').map((r) => r.id)));

const outfitLine = (l: Look) => `- ${[...lookItems(l)].join(', ')}`;

/** Owned pieces the analyzer may put into looks (respecting the profile's eyewear setting). */
export const lookPieces = (db: DB) => ownedItems(db).filter((i) => !isBlockedEyewear(db, i.title));

export function analyzePrompt(db: DB, job: Job, attached: string[]) {
  // So-so pieces stay out unless the owner picked them himself (owner, 19.11).
  const items = lookPieces(db).filter((i) => !weakPiece(i) || (job.requiredItemIds ?? []).includes(i.id));
  // Every regeneration is checked against what the owner already approved or removed.
  const hidden = hiddenLookIds(db);
  const usable = db.looks.filter((l) => lookItems(l).size >= 2);
  const liked = usable.filter((l) => l.favorite);
  // Disliked looks, refused advisor proposals and deleted looks: never again (look memory, owner 19.11).
  const rejected: Pick<Look, 'slots'>[] = [
    ...usable.filter((l) => hidden.has(l.id)),
    ...(db.suggestions ?? []).filter((s) => s.status === 'rejected').flatMap((s) => s.looks),
    ...(db.lookMemory ?? []),
  ].filter((l) => lookItems(l as Look).size >= 2).slice(-60);
  const refused = [...refusedPieces(db, hidden)];
  const existing = usable.filter((l) => !l.favorite && !hidden.has(l.id)).slice(-40);
  const names = db.capsules.filter((c) => c.kind === 'selection').map((c) => c.name);
  const required = (job.requiredItemIds ?? []).map((id) => db.items.find((i) => i.id === id)).filter((i): i is Item => Boolean(i));
  const completeBlock = required.length
    ? [
        `COMPLETE-THE-LOOK MODE: the owner picked ${required.map((i) => `${i.id} (${i.title})`).join(', ')}. Every look MUST contain all of these exact ids in the appropriate slots.`,
        `Propose 3 to 4 clearly different ways to complete them (different occasions or moods), adding other wardrobe items for the missing slots. In "why", say in one ${replyLanguage(db)} sentence what the added pieces bring (colour, balance, formality).`,
        'Name the selection after the picked pieces, e.g. "Доповнення: оливковий overshirt".',
      ].join('\n')
    : '';
  return [
    'You are the Capsula stylist running unattended. Build outfits ONLY from the owner\'s existing wardrobe listed below and answer with JSON only (schema enforced).',
    focusLine(db),
    `Profile notes: ${Object.values(db.profile.preferences).filter(Boolean).join(' ')}`,
    fitPromptBlock(db),
    job.instructions ? `Request from the owner: ${job.instructions}` : 'Request: a balanced set of everyday outfits for the current season.',
    completeBlock,
    '',
    'Rules: use only ids from the list (exact strings). Each look needs a bottom (a dress in the top slot replaces both top and bottom) and shoes; add a top unless the outer layer is worn closed; at most one item per slot except accessories (max 2). Prefer items "confirmed by owner", but candidates are allowed. Produce 4 to 6 looks unless the owner asked otherwise.',
    'Same-look rule (the owner\'s): two outfits are the SAME look when they are identical or differ by only one piece — one swap, one addition or one removal, accessories included. A DIFFERENT look has at least two different pieces. Every look you return must be a different look from each other and from every outfit listed below; looks that break this are discarded.',
    'Spread the wardrobe: use pieces that existing outfits rarely use, vary colours and silhouettes. Give the selection a new name, different from the existing names.',
    rejected.length ? `Outfits the owner REJECTED (never propose them again or anything within one piece of them; steer away from their direction):\n${rejected.map((l) => outfitLine(l as Look)).join('\n')}` : '',
    refused.length ? `Pieces the owner keeps refusing — do not build looks around them: ${refused.join(', ')}.` : '',
    liked.length ? `Outfits the owner LIKED (already saved — do not repeat or near-copy them; their style is a good signal):\n${liked.map(outfitLine).join('\n')}` : '',
    existing.length ? `Other existing outfits (do not repeat or near-copy):\n${existing.map(outfitLine).join('\n')}` : '',
    names.length ? `Existing selection names (do not reuse): ${names.join('; ')}` : '',
    `Write name, description, look names, occasion and why in ${replyLanguage(db)}, short (why: one sentence on colour/silhouette logic). season: all | warm | transitional | cold.`,
    attached.length ? `Packshot images are attached as files named by item id (${attached.length} files) — use them to judge colours and styles.` : '',
    'If the wardrobe is not enough for a single sensible outfit, return status "error" with the reason.',
    '',
    'Wardrobe (id | category | title | details | status | notes):',
    wardrobeLines(db, items),
  ]
    .filter(Boolean)
    .join('\n');
}

export interface IntakeReply {
  status: string;
  reason: string;
  photoType?: string;
  singlePerson?: boolean;
  baseSuitable?: boolean;
  baseIssues?: string;
  label?: { itemId: string; brand: string; size: string; composition: string };
  /** duplicateConfidence: set by the visual check; `high` means the picture confirmed the same physical garment. */
  garments: { title: string; category: string; color: string; notes: string; duplicateOf: string; coversNeed?: string; sport?: boolean; duplicateConfidence?: 'high' | 'possible' }[];
}

export interface IntakeOutcome {
  created: string[];
  attachedTo: string[];
  /** Open recommendations the upload turned out to be (applied by the runner with coverNeed). */
  covers: { itemId: string; needId: string }[];
  base: 'added' | 'added_nonstandard' | null;
  labelFor: string | null;
  note: string;
}

/**
 * Applies a triaged upload. Owner photos become base photos (with the agent's
 * standard check); garments become candidates, or extra evidence on an
 * existing unconfirmed candidate when the model says it is the same item;
 * labels attach to the item and fill only empty brand/size/composition.
 * A garment that is an open shopping recommendation is reported in `covers`.
 * A confirmed item gets the photo only when the picture confirmed it (`high`); a text-only or possible match
 * becomes a new candidate marked possibleDuplicateOf. Labels may fill their missing facts.
 */
export function applyIntake(db: DB, job: Job, reply: IntakeReply): IntakeOutcome {
  const at = now();
  const photoId = (job.inputPhotoIds ?? [])[0];
  const photo = db.photos.find((p) => p.id === photoId);
  const out: IntakeOutcome = { created: [], attachedTo: [], covers: [], base: null, labelFor: null, note: '' };
  const notes: string[] = [];
  const type = reply.photoType ?? 'garments_only';
  const intent = job.intakeIntent ?? 'auto';

  if (photo && reply.singlePerson && (type === 'person_full_body' || type === 'person_face')) {
    const face = type === 'person_face';
    const suitable = Boolean(reply.baseSuitable);
    photo.baseCandidate = { suitable, ...(reply.baseIssues ? { issues: reply.baseIssues } : {}) };
    const select = intent === 'person' || (!db.profile.identity && (face || suitable));
    if (face || select) {
      photo.kind = 'base';
      if (face) photo.referenceRole = 'face';
      else delete photo.referenceRole;
      photo.meetsStandard = suitable;
      photo.note = suitable ? 'Оцінка агента: відповідає стандарту.' : `Оцінка агента: ${reply.baseIssues || 'не за стандартом'}.`;
    }
    if (select) {
      if (!db.profile.basePhotoIds.includes(photo.id)) {
        db.profile.basePhotoIds.push(photo.id);
        db.profile.rev += 1;
      }
      out.base = suitable ? 'added' : 'added_nonstandard';
      notes.push(suitable ? (face ? 'Фото обличчя додано' : 'Твоє фото додано для примірок') : `Твоє фото додано, але не за стандартом: ${reply.baseIssues || 'перевір'}`);
    }
  }

  if (photo && type === 'label' && intent !== 'person') {
    photo.kind = 'label';
    const item = reply.label?.itemId ? ownedItems(db).find((i) => i.id === reply.label!.itemId) : undefined;
    if (item) {
      if (!item.photoIds.includes(photo.id)) item.photoIds.push(photo.id);
      const filled: string[] = [];
      const fill = (k: 'brand' | 'size' | 'composition', v?: string) => {
        const val = String(v ?? '').trim().slice(0, 120);
        if (val && !item[k]) {
          item[k] = val;
          filled.push(k);
        }
      };
      fill('brand', reply.label?.brand);
      fill('size', reply.label?.size);
      fill('composition', reply.label?.composition);
      item.rev += 1;
      item.updatedAt = at;
      item.history.push({ at, action: 'label', note: `Етикетка розпізнана (${job.id})${filled.length ? `: ${filled.join(', ')}` : ''}` });
      out.labelFor = item.id;
      notes.push(`Етикетку прикріплено до «${item.title}»`);
    } else {
      notes.push('Етикетку не вдалося привʼязати до речі — відкрий річ і додай вручну');
    }
  }

  const covers = (g: IntakeReply['garments'][number], item: Item) => {
    const need = db.needs.find((n) => n.id === String(g.coversNeed ?? '').trim() && n.status === 'open' && n.category === item.category);
    if (need && !out.covers.some((c) => c.needId === need.id || c.itemId === item.id)) out.covers.push({ itemId: item.id, needId: need.id });
  };
  const garments = intent === 'person' || type === 'person_face' || type === 'label' ? [] : reply.garments ?? [];
  for (const g of garments) {
    const category = (CATEGORIES as readonly string[]).includes(g.category) ? (g.category as Category) : 'accessories';
    const title = String(g.title || '').trim().slice(0, 120);
    if (!title) continue;
    const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    // Deterministic safety net: the same title in the same category is the same candidate.
    const dup =
      (g.duplicateOf ? db.items.find((i) => i.id === g.duplicateOf && i.category === category && i.status !== 'inactive' && !i.mergedInto) : undefined) ??
      db.items.find((i) => i.category === category && i.status === 'needs_confirmation' && !i.mergedInto && norm(i.title) === norm(title));
    // A visually confirmed duplicate (high) takes the photo even when confirmed; «В окрему річ» undoes it.
    if (dup && photo && (dup.status === 'needs_confirmation' || g.duplicateConfidence === 'high')) {
      const attached = !dup.photoIds.includes(photo.id);
      const sportAdded = Boolean(g.sport) && !dup.sport;
      if (attached) dup.photoIds.push(photo.id);
      if (sportAdded) dup.sport = true;
      if (attached || sportAdded) {
        dup.rev += 1;
        dup.updatedAt = at;
        if (attached) dup.history.push({ at, action: 'photo_added', note: `Та сама річ на новому фото (${job.id})${g.duplicateConfidence === 'high' ? ', підтверджено за фото' : ''}` });
      }
      out.attachedTo.push(dup.id);
      covers(g, dup);
      continue;
    }
    const item: Item = {
      id: newId('W'),
      rev: 1,
      category,
      title,
      color: String(g.color || '').trim().slice(0, 60) || undefined,
      status: 'needs_confirmation',
      ...(g.sport ? { sport: true } : {}),
      ...(dup?.status === 'confirmed' ? { possibleDuplicateOf: dup.id } : {}),
      photoIds: photo ? [photo.id] : [],
      observation: String(g.notes || '').trim(),
      origin: 'intake',
      history: [{ at, action: 'intake', note: `Розпізнано з фото (${job.id})` }],
      createdAt: at,
      updatedAt: at,
    };
    db.items.push(item);
    out.created.push(item.id);
    covers(g, item);
  }
  if (out.created.length) notes.push(`нових речей: ${out.created.length}`);
  if (out.attachedTo.length) {
    const titles = out.attachedTo.map((id) => db.items.find((i) => i.id === id)?.title ?? id);
    notes.push(`фото додано до наявних: ${titles.slice(0, 2).map((t) => `«${t}»`).join(', ')}${titles.length > 2 ? ` і ще ${titles.length - 2}` : ''}`);
  }
  if (!notes.length) notes.push(type === 'other' ? 'Тут немає ні тебе, ні одягу' : 'Нічого нового не знайдено');
  out.note = notes.join(' · ');
  return out;
}

interface AnalyzeReply {
  status: string;
  reason: string;
  name: string;
  description: string;
  looks: ({ name: string; occasion: string; season: string; why: string } & Record<SlotKey, string[]>)[];
}

/** Turns an analyzer reply into a selection of owned-only looks; returns the capsule id. */
export function applyAnalyze(db: DB, job: Job, reply: AnalyzeReply): string | null {
  const owned = new Set(lookPieces(db).map((i) => i.id));
  const at = now();
  const capsuleId = newId('C');
  const looks: Look[] = [];
  const required = job.requiredItemIds ?? [];
  // The owner's same-look rule against every existing look — liked, hidden/disliked and
  // neutral alike. Picked items in complete-the-look mode are shared, so they never count as a difference.
  // Look memory (owner, 19.11): nothing that already was — current, older versions, refused or deleted — or is within the closeness rule.
  const fresh: Slots[] = [];
  const refused = refusedPieces(db, hiddenLookIds(db));
  for (const i of db.items) if (weakPiece(i)) refused.add(i.id);
  for (const l of reply.looks ?? []) {
    const slots = emptySlots();
    for (const k of SLOT_KEYS) {
      const limit = k === 'accessories' ? 2 : 1;
      slots[k] = [...new Set((l[k] ?? []).filter((id) => owned.has(id)))].slice(0, limit).map((id) => ({ kind: 'item' as const, id }));
    }
    const dress = slots.top.some((r) => db.items.find((i) => i.id === r.id)?.category === 'dresses');
    if ((!slots.bottom.length && !dress) || !slots.shoes.length) continue;
    const set = lookKeys({ slots });
    if (required.some((id) => !set.has(`item:${id}`))) continue;
    if ([...set].some((k) => refused.has(k.slice(5)) && !required.includes(k.slice(5)))) continue;
    if (alreadySeen(db, slots, fresh)) continue;
    fresh.push(slots);
    looks.push({
      id: newId('L'),
      rev: 1,
      capsuleId,
      name: String(l.name || 'Образ').slice(0, 80),
      note: [l.occasion, l.why].filter(Boolean).join(' — ').slice(0, 400),
      slots,
      version: 1,
      versions: [{ version: 1, slots, at }],
      favorite: false,
      origin: 'agent',
      sourceNote: `Аналізатор (${job.id}): лише наявні речі`,
      createdAt: at,
      updatedAt: at,
    });
  }
  if (!looks.length) return null;
  const seasons = new Set(reply.looks.map((l) => l.season).filter((s) => (SEASONS as readonly string[]).includes(s)));
  const season: Season = seasons.size === 1 ? ([...seasons][0] as Season) : 'all';
  db.looks.push(...looks);
  const base = String(reply.name || 'Підбірка з моїх речей').slice(0, 76);
  let name = base;
  for (let n = 2; db.capsules.some((c) => c.name === name); n += 1) name = `${base} · ${n}`;
  db.capsules.push({
    id: capsuleId,
    rev: 1,
    kind: 'selection',
    name,
    season,
    description: String(reply.description || '').slice(0, 400),
    situations: [...new Set(reply.looks.map((l) => l.occasion).filter(Boolean))].slice(0, 6),
    favorite: false,
    lookIds: looks.map((l) => l.id),
    origin: 'agent',
    sourceNote: `Аналізатор образів, ${at.slice(0, 10)}${job.instructions ? ` — «${job.instructions}»` : ''}; лише наявні речі`,
    createdAt: at,
    updatedAt: at,
  });
  return capsuleId;
}
