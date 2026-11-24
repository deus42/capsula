import { useMemo, useState } from 'react';
import { Plus, X } from 'lucide-react';
import type { Capsule, SlotRef } from '../api.ts';
import { api, thumb } from '../api.ts';
import { useApp, useDb } from '../store.tsx';
import { CATEGORY_LABEL, resolveRef } from '../lib.ts';
import { CAPSULE_LIMITS, MAX_BASE_PIECES, capsuleLimits, capsuleSet, pieceCategory, pieceGroup, pieceKey, type CapsulePiece, type PieceGroup } from '../capsule-pieces.ts';
import { Badge, CategoryIcon, Modal } from './ui.tsx';
import { LOOKS, t, plural as pluralize } from '../i18n.ts';

const looksText = (n: number) => (n ? pluralize(n, LOOKS) : t('без образів'));
const combosText = (n: number) => pluralize(n, { one: '{n} поєднання', few: '{n} поєднання', many: '{n} поєднань' });
const GROUP_TEXT: Record<PieceGroup, string> = { garments: 'Одяг', shoes: 'Взуття', accessories: 'Аксесуари' };
const ROLE_ORDER = ['layer', 'top', 'bottom', 'shoes', 'accessories'];
const byRole = (a: CapsulePiece, b: CapsulePiece) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || Number(b.base) - Number(a.base) || b.looks - a.looks;
const pieceHref = (r: SlotRef) => (r.kind === 'item' ? `/wardrobe/${r.id}` : `/shopping?need=${r.id}`);

/**
 * «Речі» under a capsule's looks (owner, 20.11): its ten garments in the order they are worn,
 * then — after a fine line — shoes and accessories, each with how many looks it makes.
 */
export function CapsuleSetSection({ capsule }: { capsule: Capsule }) {
  const db = useDb();
  const [adding, setAdding] = useState(false);
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
          <button type="button" className="btn sm ghost" onClick={() => setAdding(true)}><Plus size={14} /> {t('Додати річ')}</button>
        </div>
      </div>
      {garments.length > 0 && <div className="ward-grid">{garments.map(tile)}</div>}
      {extras.length > 0 && <div className="ward-grid small set-extras">{extras.map(tile)}</div>}
      {adding && <CapsuleSetDialog capsule={capsule} onClose={() => setAdding(false)} />}
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
  return <Modal title={t('Речі капсули')} onClose={() => { if (!saving) onClose(); }} footer={<>
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
  const limits = capsuleLimits(capsule);
  const groupOf = (r: SlotRef): PieceGroup => {
    const c = pieceCategory(db, r);
    return c ? pieceGroup(c) : 'garments';
  };
  const counts: Record<PieceGroup, number> = { garments: 0, shoes: 0, accessories: 0 };
  for (const r of draft.pieces) counts[groupOf(r)] += 1;
  const inSet = new Set(draft.pieces.map(pieceKey));
  const pendingGroup = draft.pending ? groupOf(draft.pending) : null;
  const items = db.items.filter((i) => i.status !== 'inactive' && !i.mergedInto && !inSet.has(`item:${i.id}`));
  const needs = db.needs.filter((n) => n.status === 'open' && !inSet.has(`need:${n.id}`));
  const roleOf = (r: SlotRef) => {
    const c = pieceCategory(db, r);
    return c === 'outerwear' ? 'layer' : c === 'trousers' || c === 'shorts' || c === 'skirts' ? 'bottom' : c === 'shoes' || c === 'accessories' ? c : 'top';
  };
  const ordered = [...draft.pieces].sort((a, b) => ROLE_ORDER.indexOf(roleOf(a)) - ROLE_ORDER.indexOf(roleOf(b)));

  const add = (value: string) => {
    const [kind, id] = value.split(':') as [SlotRef['kind'], string];
    if (!id) return;
    const ref: SlotRef = { kind, id };
    const g = groupOf(ref);
    if (counts[g] >= limits[g]) onChange({ ...draft, pending: ref });
    else onChange({ ...draft, pieces: [...draft.pieces, ref], pending: null });
  };
  const remove = (r: SlotRef) => onChange({ ...draft, pieces: draft.pieces.filter((x) => pieceKey(x) !== pieceKey(r)), base: draft.base.filter((k) => k !== pieceKey(r)) });
  const replace = (r: SlotRef) => {
    if (!draft.pending) return;
    const pending = draft.pending;
    onChange({ pieces: draft.pieces.map((x) => (pieceKey(x) === pieceKey(r) ? pending : x)), base: draft.base.filter((k) => k !== pieceKey(r)), pending: null });
  };
  const toggleBase = (r: SlotRef) => {
    const k = pieceKey(r);
    if (draft.base.includes(k)) onChange({ ...draft, base: draft.base.filter((x) => x !== k) });
    else if (draft.base.length < MAX_BASE_PIECES) onChange({ ...draft, base: [...draft.base, k] });
  };

  return (
    <div className="field full set-edit">
      <span>{t('Речі')}</span>
      <p className="set-counts">
        {(Object.keys(limits) as PieceGroup[]).map((g) => (
          <span key={g} className={counts[g] > limits[g] ? 'over' : ''}>{t(GROUP_TEXT[g])} {counts[g]}/{limits[g]}</span>
        ))}
      </p>
      <select className="select" value="" aria-label={t('Додати річ у капсулу')} onChange={(e) => add(e.target.value)}>
        <option value="">{t('Додати річ…')}</option>
        {items.length > 0 && <optgroup label={t('Мої речі')}>{items.map((i) => <option key={i.id} value={`item:${i.id}`}>{i.title} — {t(CATEGORY_LABEL[i.category])}</option>)}</optgroup>}
        {needs.length > 0 && <optgroup label={t('Докупити')}>{needs.map((n) => <option key={n.id} value={`need:${n.id}`}>{n.title} — {t(CATEGORY_LABEL[n.category])}</option>)}</optgroup>}
      </select>
      <ul className="set-list">
        {ordered.map((r) => {
          const res = resolveRef(db, r);
          const art = res.art ?? res.photo;
          const g = groupOf(r);
          const key = pieceKey(r);
          const isBase = draft.base.includes(key);
          return (
            <li key={key} className={pendingGroup === g ? 'replaceable' : ''}>
              <span className="set-thumb">{art ? <img src={thumb(art, 160)} alt="" /> : <CategoryIcon category={res.category} size={16} />}</span>
              <span className="set-name">{res.title}{r.kind === 'need' && <span className="buy"> · {t('докупити')}</span>}</span>
              {g === 'garments' && (
                <button type="button" className={`quiet-toggle${isBase ? ' on' : ''}`} aria-pressed={isBase} disabled={!isBase && draft.base.length >= MAX_BASE_PIECES} onClick={() => toggleBase(r)}>{t('база')}</button>
              )}
              {pendingGroup === g
                ? <button type="button" className="quiet-toggle" onClick={() => replace(r)}>{t('замінити')}</button>
                : <button type="button" className="icon-btn sm" aria-label={t('Прибрати «{title}»', { title: res.title })} onClick={() => remove(r)}><X size={13} /></button>}
            </li>
          );
        })}
      </ul>
      {draft.pending && pendingGroup && (
        <p className="set-note">
          {t('{group} уже {n}/{max}: що замінить «{title}»?', { group: t(GROUP_TEXT[pendingGroup]), n: counts[pendingGroup], max: limits[pendingGroup], title: resolveRef(db, draft.pending).title })}
          <button type="button" className="quiet-toggle" onClick={() => onChange({ ...draft, pending: null })}>{t('Скасувати')}</button>
        </p>
      )}
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
