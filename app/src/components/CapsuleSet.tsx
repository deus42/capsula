import { Fragment, useMemo, useRef, useState } from 'react';
import { Pencil, Plus, X } from 'lucide-react';
import type { Capsule, Category, SlotRef } from '../api.ts';
import { api, thumb } from '../api.ts';
import { useApp, useDb } from '../store.tsx';
import { CATEGORY_LABEL, resolveRef } from '../lib.ts';
import { CAPSULE_LIMITS, MAX_BASE_PIECES, capsuleLimits, capsuleSet, normalizePiece, pieceCategory, pieceGroup, pieceKey, visibleCapsuleLooks, type CapsulePiece, type PieceGroup } from '../capsule-pieces.ts';
import { Badge, CategoryIcon, Modal } from './ui.tsx';
import { LOOKS, t, plural as pluralize } from '../i18n.ts';

const looksText = (n: number) => (n ? pluralize(n, LOOKS) : t('без образів'));
const combosText = (n: number) => pluralize(n, { one: '{n} поєднання', few: '{n} поєднання', many: '{n} поєднань' });
const GROUP_TEXT: Record<PieceGroup, string> = { garments: 'Одяг', shoes: 'Взуття', accessories: 'Аксесуари' };
const CATEGORIES = Object.keys(CATEGORY_LABEL) as Category[];
type PieceFilter = Category | 'all' | 'sport' | 'new' | 'needs_confirmation' | 'confirmed';
const SPORT = /(?:^|[^\p{L}])(?:спорт(?:ивн\p{L}*)?|зал|біг|вело|плавання|тріатлон|фітнес|gym|sport|sports|running|cycling|swimming|triathlon|fitness)(?=$|[^\p{L}])/iu;
const sportCapsule = (capsule: Capsule) => capsule.accessoryLimit === 4 || SPORT.test([capsule.name, ...capsule.situations].join(' '));
const ROLE_ORDER = ['layer', 'top', 'bottom', 'shoes', 'accessories'];
const byRole = (a: CapsulePiece, b: CapsulePiece) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || Number(b.base) - Number(a.base) || b.looks - a.looks;
const pieceHref = (r: SlotRef) => (r.kind === 'item' ? `/wardrobe/${r.id}` : `/shopping?need=${r.id}`);

/**
 * «Речі» under a capsule's looks (owner, 20.11): its ten garments in the order they are worn,
 * then — after a fine line — shoes and accessories, each with how many looks it makes.
 */
export function CapsuleSetSection({ capsule }: { capsule: Capsule }) {
  const db = useDb();
  const [editing, setEditing] = useState(false);
  const set = useMemo(() => capsuleSet(db, capsule), [db, capsule]);
  const garments = set.pieces.filter((p) => p.group === 'garments').sort(byRole);
  const extras = set.pieces.filter((p) => p.group !== 'garments').sort(byRole);
  const over = set.counts.garments > CAPSULE_LIMITS.garments;
  const tile = (p: CapsulePiece) => {
    const r = resolveRef(db, p.ref);
    const art = r.art ?? r.photo;
    return (
      <a key={pieceKey(p.ref)} className="wtile" href={pieceHref(p.ref)}>
        <div className="img">
          {art ? <img src={thumb(art, 480)} alt={r.title} loading="lazy" /> : <span className="render-ph"><CategoryIcon category={r.category} size={22} /></span>}
          {r.inactive && <span className="tl"><Badge tone="glass">{t('неактуальна')}</Badge></span>}
        </div>
        <span className="nm">{r.title}</span>
        <span className="sub">{[p.base && t('база'), !p.owned && t('докупити'), looksText(p.looks)].filter(Boolean).join(' · ')}</span>
      </a>
    );
  };
  return (
    <section className="capsule-set" aria-label={t('Речі капсули')}>
      <div className="section-head">
        <h2 className="h2">{t('Речі')} <span className={`count${over ? ' over' : ''}`}>{over ? `${set.counts.garments}/${CAPSULE_LIMITS.garments}` : set.counts.garments}</span></h2>
        <div className="row">
          {set.combinations > 0 && <span className="set-combos">{combosText(set.combinations)}</span>}
          <button type="button" className="btn sm" onClick={() => setEditing(true)}>
            {set.pieces.length ? <><Pencil size={14} /> {t('Редагувати речі')}</> : <><Plus size={14} /> {t('Додати річ')}</>}
          </button>
        </div>
      </div>
      {garments.length > 0 && <div className="ward-grid">{garments.map(tile)}</div>}
      {extras.length > 0 && <div className="ward-grid small set-extras">{extras.map(tile)}</div>}
      {editing && <CapsuleSetDialog capsule={capsule} onClose={() => setEditing(false)} />}
    </section>
  );
}

function CapsuleSetDialog({ capsule, onClose }: { capsule: Capsule; onClose: () => void }) {
  const db = useDb();
  const { act } = useApp();
  const [{ initial, rev }] = useState(() => ({ initial: initialSetDraft(db, capsule), rev: capsule.rev }));
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    const result = await act(() => api('PATCH', `/api/capsules/${capsule.id}`, { rev, ...setDraftPayload(draft) }), t('Збережено'));
    setSaving(false);
    if (result) onClose();
  };
  return <Modal title={initial.pieces.length ? t('Редагувати речі') : t('Додати річ')} wide onClose={() => { if (!saving) onClose(); }} footer={<>
    <button type="button" className="btn" disabled={saving} onClick={onClose}>{t('Скасувати')}</button>
    <button type="button" className="btn primary" disabled={saving || Boolean(draft.pending) || sameSetDraft(draft, initial)} onClick={() => void save()}>{t('Зберегти')}</button>
  </>}>
    <CapsuleSetEditor capsule={capsule} draft={draft} onChange={setDraft} />
  </Modal>;
}

export interface SetDraft {
  pieces: SlotRef[];
  base: string[];
  /** A piece waiting for the owner to pick which piece of its full group it replaces. */
  pending: SlotRef | null;
}

export const initialSetDraft = (db: Parameters<typeof capsuleSet>[0], capsule: Capsule): SetDraft => ({
  pieces: capsuleSet(db, capsule).pieces.map((p) => p.ref),
  base: (capsule.base ?? []).map(pieceKey),
  pending: null,
});

/** The set inside the capsule's pencil modal: remove, add, replace at the limit, mark the base. */
export function CapsuleSetEditor({ capsule, draft, onChange }: { capsule: Capsule; draft: SetDraft; onChange: (next: SetDraft) => void }) {
  const db = useDb();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<PieceFilter>(() => sportCapsule(capsule) ? 'sport' : 'all');
  const [blocked, setBlocked] = useState<string | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const limits = capsuleLimits(capsule);
  const groupOf = (r: SlotRef): PieceGroup => {
    const c = pieceCategory(db, r);
    return c ? pieceGroup(c) : 'garments';
  };
  const counts: Record<PieceGroup, number> = { garments: 0, shoes: 0, accessories: 0 };
  for (const r of draft.pieces) counts[groupOf(r)] += 1;
  const inSet = new Set(draft.pieces.map(pieceKey));
  const pendingGroup = draft.pending ? groupOf(draft.pending) : null;
  const search = query.trim().toLocaleLowerCase();
  const matches = (...values: Array<string | undefined>) => values.join(' ').toLocaleLowerCase().includes(search);
  const availableItems = db.items.filter((i) => i.status !== 'inactive' && !i.mergedInto && !inSet.has(`item:${i.id}`));
  const availableNeeds = db.needs.filter((n) => n.status === 'open' && !inSet.has(`need:${n.id}`));
  const availableCategories = new Set([...availableItems, ...availableNeeds].map((piece) => piece.category));
  const isNew = (item: typeof availableItems[number]) => item.origin === 'intake' && item.status === 'needs_confirmation';
  const filters: { key: PieceFilter; label: string; available?: boolean }[] = [
    { key: 'all', label: 'Усі речі' },
    { key: 'sport', label: 'Спорт' },
    { key: 'new', label: 'Нові з фото', available: availableItems.some(isNew) },
    ...CATEGORIES.map((category) => ({ key: category, label: CATEGORY_LABEL[category], available: availableCategories.has(category) })),
    { key: 'needs_confirmation', label: 'Звірити', available: availableItems.some((item) => item.status === 'needs_confirmation') },
    { key: 'confirmed', label: 'Мої речі', available: availableItems.some((item) => item.status === 'confirmed') },
  ];
  const items = availableItems.filter((item) => {
    const inFilter = filter === 'sport' ? item.sport : filter === 'new' ? isNew(item) : filter === 'all' || filter === item.category || filter === item.status;
    return inFilter && matches(item.title, t(CATEGORY_LABEL[item.category]), item.brand, item.model);
  });
  const needs = availableNeeds.filter((need) => (
    (filter === 'all' || filter === need.category || (filter === 'sport' && need.forCapsule === capsule.id))
    && matches(need.title, t(CATEGORY_LABEL[need.category]))
  ));
  const roleOf = (r: SlotRef) => {
    const c = pieceCategory(db, r);
    return c === 'outerwear' ? 'layer' : c === 'trousers' || c === 'shorts' || c === 'skirts' ? 'bottom' : c === 'shoes' || c === 'accessories' ? c : 'top';
  };
  const ordered = [...draft.pieces].sort((a, b) => ROLE_ORDER.indexOf(roleOf(a)) - ROLE_ORDER.indexOf(roleOf(b)));
  const usedIn = (key: string) => visibleCapsuleLooks(db, capsule).filter((look) =>
    Object.values(look.slots).some((refs) => refs.some((ref) => pieceKey(normalizePiece(db, ref)) === key)));
  const blockedLooks = blocked ? usedIn(blocked) : [];

  const add = (ref: SlotRef) => {
    const g = groupOf(ref);
    const atLimit = counts[g] >= limits[g];
    onChange(atLimit ? { ...draft, pending: ref } : { ...draft, pieces: [...draft.pieces, ref], pending: null });
    return !atLimit;
  };
  const changePiece = (r: SlotRef, replacement?: SlotRef) => {
    const key = pieceKey(r);
    if (usedIn(key).length) {
      setBlocked(key);
      return;
    }
    setBlocked(null);
    const pieces = replacement
      ? draft.pieces.map((ref) => pieceKey(ref) === key ? replacement : ref)
      : draft.pieces.filter((ref) => pieceKey(ref) !== key);
    onChange({ ...draft, pieces, base: draft.base.filter((k) => k !== key), pending: replacement ? null : draft.pending });
  };
  const toggleBase = (r: SlotRef) => {
    const k = pieceKey(r);
    if (draft.base.includes(k)) onChange({ ...draft, base: draft.base.filter((x) => x !== k) });
    else if (draft.base.length < MAX_BASE_PIECES) onChange({ ...draft, base: [...draft.base, k] });
  };
  const choices = (label: string, refs: SlotRef[]) => refs.length > 0 && (
    <div className="set-choice-group" role="group" aria-label={label}>
      <h3>{label}</h3>
      <div className="own-picks">
        {refs.map((ref) => {
          const piece = resolveRef(db, ref);
          return (
            <button className="own-pick" key={pieceKey(ref)} type="button" onClick={(event) => {
              if (add(ref) && event.detail === 0) searchInput.current?.focus();
            }}>
              <span className="img">
                {piece.art ? <img src={thumb(piece.art, 240)} alt="" loading="lazy" /> : <CategoryIcon category={piece.category} size={22} />}
              </span>
              <span>{piece.title}</span>
            </button>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="field full set-edit">
      <span>{t('Речі')}</span>
      <p className="set-counts">
        {(Object.keys(limits) as PieceGroup[]).map((g) => (
          <span key={g} className={counts[g] > limits[g] ? 'over' : ''}>{t(GROUP_TEXT[g])} {counts[g]}/{limits[g]}</span>
        ))}
      </p>
      {draft.pending && pendingGroup && (
        <p className="set-note" role="status">
          {t('{group} уже {n}/{max}: що замінить «{title}»?', { group: t(GROUP_TEXT[pendingGroup]), n: counts[pendingGroup], max: limits[pendingGroup], title: resolveRef(db, draft.pending).title })}
          <button type="button" className="quiet-toggle" onClick={() => { setBlocked(null); onChange({ ...draft, pending: null }); }}>{t('Скасувати')}</button>
        </p>
      )}
      {ordered.length > 0 && <ul className="set-list">
        {ordered.map((r) => {
          const res = resolveRef(db, r);
          const art = res.art ?? res.photo;
          const g = groupOf(r);
          const key = pieceKey(r);
          const isBase = draft.base.includes(key);
          return (
            <Fragment key={key}>
              <li className={pendingGroup === g ? 'replaceable' : ''}>
                <span className="set-thumb">{art ? <img src={thumb(art, 160)} alt="" /> : <CategoryIcon category={res.category} size={16} />}</span>
                <a className="set-name" href={pieceHref(r)}>{res.title}{r.kind === 'need' && <span className="buy"> · {t('докупити')}</span>}</a>
                {g === 'garments' && (
                  <button type="button" className={`quiet-toggle${isBase ? ' on' : ''}`} aria-pressed={isBase} disabled={!isBase && draft.base.length >= MAX_BASE_PIECES} onClick={() => toggleBase(r)}>{t('база')}</button>
                )}
                {pendingGroup === g && draft.pending
                  ? <button type="button" className="quiet-toggle" onClick={() => changePiece(r, draft.pending!)}>{t('замінити')}</button>
                  : <button type="button" className="icon-btn sm" aria-label={t('Прибрати «{title}»', { title: res.title })} onClick={() => changePiece(r)}><X size={13} /></button>}
              </li>
              {blocked === key && blockedLooks.length > 0 && (
                <li><p className="set-note" role="status">
                  {t('Спершу заміни річ в образах')}
                  {blockedLooks.map((look) => <a key={look.id} className="quiet-toggle on" href={`/looks/${look.id}`}>{look.name}</a>)}
                </p></li>
              )}
            </Fragment>
          );
        })}
      </ul>}
      {!draft.pending && <>
        <div className="filters set-filters" role="group" aria-label={t('Категорії')}>
          {filters.filter(({ key, available }) => available !== false || key === filter).map(({ key, label }) => (
            <button key={key} type="button" className={key === filter ? 'on' : undefined} aria-pressed={key === filter} onClick={() => setFilter(key)}>{t(label)}</button>
          ))}
        </div>
        <input ref={searchInput} type="search" className="input" aria-label={t('Пошук речі')} placeholder={t('Пошук речі')} value={query} onChange={(event) => setQuery(event.target.value)} />
        {items.length + needs.length > 0 ? (
          <div className="set-choices">
            {choices(t('Мої речі'), items.map(({ id }) => ({ kind: 'item', id })))}
            {choices(t('Докупити'), needs.map(({ id }) => ({ kind: 'need', id })))}
          </div>
        ) : <p className="muted small" role="status">{t('Нічого відповідного не знайдено')}</p>}
      </>}
    </div>
  );
}

/** What the modal sends when the set changed: refs, and the base as refs of the set. */
export function setDraftPayload(draft: SetDraft) {
  const byKey = new Map(draft.pieces.map((r) => [pieceKey(r), r]));
  return { pieces: draft.pieces, base: draft.base.map((k) => byKey.get(k)).filter((r): r is SlotRef => Boolean(r)) };
}

export const sameSetDraft = (a: SetDraft, b: SetDraft) =>
  a.pieces.map(pieceKey).join('|') === b.pieces.map(pieceKey).join('|') && [...a.base].sort().join('|') === [...b.base].sort().join('|');
