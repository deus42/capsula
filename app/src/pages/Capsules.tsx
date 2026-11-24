import { useEffect, useMemo, useState } from 'react';
import { EyeOff, ImageOff, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react';
import type { Capsule, Look, Season, SlotRef, SlotKey } from '../api.ts';
import { api } from '../api.ts';
import { go, useApp, useDb, useRoute } from '../store.tsx';
import { Badge, ConfirmButton, Empty, LookArt, Missing, Modal, PieceBlocks, RateButtons } from '../components/ui.tsx';
import { SEASON_LABEL, SLOT_CATEGORIES, SLOT_LABEL, isBlockedEyewear, openSuggestions, periodLine, bestLooks, capsuleLooks, capsuleRating, distinctLooks, hasPieces, isBestLook, lookRating, resolveRef, scoreLabel, isComplete, piecesOf, rankCapsules, rankLooks, readyLine, wardrobeCapsule, BEST_CAPSULE_NAME, WARDROBE_CAPSULE_NAME } from '../lib.ts';
import { capsulePieceRefs, pieceKey } from '../capsule-pieces.ts';
import { hiddenLookIds, isCapsuleArchived, isCapsuleHidden } from '../rating.ts';
import { CapsuleTile, tileCovers } from './Home.tsx';
import { NewLooks } from './NewLooks.tsx';
import { CapsuleSetEditor, CapsuleSetSection, initialSetDraft, sameSetDraft, setDraftPayload } from '../components/CapsuleSet.tsx';
import { t } from '../i18n.ts';


export function CapsulesPage() {
  const db = useDb();
  const { query } = useRoute();
  // The tab lives in the address, so links and Back switch it even while this page is open.
  const tab = (['new', 'selections', 'looks', 'hidden'] as const).find((t) => t === query.get('tab')) ?? 'capsules';
  const setTab = (t: typeof tab) => go(t === 'capsules' ? '/capsules' : `/capsules?tab=${t}`);
  const shown = db.capsules.filter((c) => !isCapsuleHidden(db, c));
  const ready = wardrobeCapsule(db);
  // Only the fashion capsules: «Найкращі» and «З моїх речей» are filters of «Усі образи», not capsules (owner, 20.11).
  const capsules = rankCapsules(db, shown.filter((c) => c.kind !== 'selection'));
  const selections = rankCapsules(db, shown.filter((c) => c.kind === 'selection').reverse());
  const list = tab === 'capsules' ? capsules : selections;
  const covers = tileCovers(db, list);
  // Each capsule's lead look first, then the rest of the catalogue.
  // Each capsule's own order comes before the rest, so a group of variants keeps the same main look as on its capsule page.
  const orderedLooks = capsuleLooks(db, [...new Set([...db.capsules.flatMap((c) => c.lookIds.slice(0, 1)), ...db.capsules.flatMap((c) => c.lookIds), ...db.looks.map((l) => l.id)])]);
  const allLooks = distinctLooks(db, orderedLooks);
  // Two quick filters of «Усі образи»: «Найкращі» (owner, 20.11: a filter, not a capsule) and «З моїх речей».
  const readyOnly = tab === 'looks' && query.get('owned') === '1';
  const bestOnly = tab === 'looks' && query.get('best') === '1';
  const readyIds = new Set(ready.lookIds);
  const filteredLooks = (bestOnly ? bestLooks(db) : readyOnly ? capsuleLooks(db, ready.lookIds) : allLooks).filter((l) => !readyOnly || readyIds.has(l.id));
  const looksHref = (owned: boolean, best: boolean) => `/capsules?tab=looks${owned ? '&owned=1' : ''}${best ? '&best=1' : ''}`;
  const hiddenCaps = db.capsules.filter((c) => !isCapsuleArchived(c) && isCapsuleHidden(db, c));
  const hiddenLooks = capsuleLooks(db, [...hiddenLookIds(db)]).filter((l) => !hiddenCaps.some((c) => c.lookIds.includes(l.id)));
  const hiddenCount = hiddenCaps.length + hiddenLooks.length;
  // With a filter on, the title stays «Усі образи»: the active button already says it.
  const title = t({ capsules: 'Капсули', new: 'Нові', selections: 'Підбірки', looks: 'Усі образи', hidden: 'Приховані' }[tab]);
  const newCount = openSuggestions(db).length;
  // On a phone the tabs scroll sideways: the active one is always brought into view.
  useEffect(() => { document.querySelector('.page-head .seg-scroll button.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [tab]);

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>{title}</h1></div>
        <div className="actions">
          <div className="seg seg-scroll">
            <button className={tab === 'capsules' ? 'on' : ''} onClick={() => setTab('capsules')}>{t('Капсули')} <span className="faint">{capsules.length}</span></button>
            <button className={tab === 'new' ? 'on' : ''} onClick={() => setTab('new')}>{t('Нові')} <span className="faint">{newCount}</span></button>
            {(selections.length > 0 || tab === 'selections') && <button className={tab === 'selections' ? 'on' : ''} onClick={() => setTab('selections')}>{t('Підбірки')} <span className="faint">{selections.length}</span></button>}
            <button className={tab === 'looks' ? 'on' : ''} onClick={() => setTab('looks')}>{t('Усі образи')} <span className="faint">{allLooks.length}</span></button>
            {hiddenCount > 0 && <button className={tab === 'hidden' ? 'on' : ''} onClick={() => setTab('hidden')}><EyeOff size={13} /> {t('Приховані')} <span className="faint">{hiddenCount}</span></button>}
          </div>
        </div>
      </div>
      {/* Below the tabs, not beside them: a button appearing next to the tabs made them jump when switching. */}
      {tab === 'looks' && <div className="filters" role="group" aria-label={t('Фільтр образів')}>
        <Filter active={bestOnly} href={looksHref(readyOnly, !bestOnly)}>{t(BEST_CAPSULE_NAME)}</Filter>
        <Filter active={readyOnly} href={looksHref(!readyOnly, bestOnly)}>{t(WARDROBE_CAPSULE_NAME)}</Filter>
      </div>}
      {tab === 'hidden' ? (
        hiddenCount === 0 ? <Empty icon={<EyeOff />} title={t('Нічого не приховано')} /> : <>
          {hiddenCaps.length > 0 && <div className="capsule-grid" style={{ marginBottom: 30 }}>{hiddenCaps.map((c) => <CapsuleTile key={c.id} c={c} />)}</div>}
          {hiddenLooks.length > 0 && <div className="look-grid">{hiddenLooks.map((l) => <LookCard key={l.id} look={l} />)}</div>}
        </>
      ) : tab === 'new' ? <NewLooks /> : tab === 'looks' ? <LookGrid looks={filteredLooks} heading={false} mark={!bestOnly} /> : list.length === 0 ? (
        tab === 'selections' ? <Empty icon={<Sparkles />} title={t('Підбірок ще немає')} /> : <Empty icon={<Sparkles />} title={t('Капсул ще немає')} />
      ) : (
        <div className="capsule-grid">{list.map((c) => <CapsuleTile key={c.id} c={c} cover={covers.get(c.id)} />)}</div>
      )}
    </div>
  );
}

/** An old capsule address that now lives elsewhere. */
function MovedTo({ href }: { href: string }) {
  useEffect(() => go(href, true), [href]);
  return null;
}

/** A quiet text filter (owner, 20.11: elegant, not a heavy button): the active one is ink with a fine underline. */
function Filter({ active, href, children }: { active: boolean; href: string; children: React.ReactNode }) {
  return <button type="button" className={active ? 'on' : ''} aria-pressed={active} onClick={() => go(href)}>{children}</button>;
}

/** Looks already reduced to one card per look (see distinctLooks). */
function LookGrid({ looks, heading = true, filter, mark = true }: { looks: Look[]; heading?: boolean; filter?: React.ReactNode; mark?: boolean }) {
  const db = useDb();
  // «Найкращий» only where it tells something; when some cards carry it, the others keep its line so names line up.
  const marked = mark && looks.some((l) => isBestLook(db, l.id));
  return <>
    {heading && <div className="section-head"><h2 className="h2">{t('Образи')} <span className="count">{looks.length}</span></h2>{filter}</div>}
    {looks.length ? <div className="look-grid">{looks.map((l) => <LookCard key={l.id} look={l} mark={marked} />)}</div> : <Empty icon={<ImageOff />} title={t('Образів ще немає')} />}
  </>;
}

export function EditLook({ look, onClose, onMakePrimary }: { look: Look; onClose: () => void; onMakePrimary?: () => void }) {
  const db = useDb();
  const { act } = useApp();
  const [name, setName] = useState(look.name);
  const [note, setNote] = useState(look.note ?? '');
  const [capsuleId, setCapsuleId] = useState(look.capsuleId ?? '');
  const capsules = db.capsules.filter((c) => !isCapsuleArchived(c) && (!c.disliked || c.id === look.capsuleId));
  const renders = db.results.filter((r) => r.lookId === look.id).length;
  return (
    <Modal
      title={t('Образ')}
      onClose={onClose}
      footer={
        <>
          <ConfirmButton
            className="btn ghost danger"
            title={t('Видалити образ')}
            message={<>{t('Видалити «{name}»?', { name: look.name })}{renders ? ` ${t('Разом з ним зникнуть {n} примірок цього образу.', { n: renders })}` : ''} {t('Речі в гардеробі залишаться.')}</>}
            onConfirm={async () => {
              const ok = await act(() => api('DELETE', `/api/looks/${look.id}`), t('Образ видалено'));
              if (ok === undefined) return;
              onClose();
              // Leaving the deleted look's own page: back to its capsule.
              if (location.pathname === `/looks/${look.id}`) go(look.capsuleId ? `/capsules/${look.capsuleId}` : '/capsules?tab=looks', true);
            }}
          >
            <Trash2 size={15} />
          </ConfirmButton>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>{t('Скасувати')}</button>
          <button
            className="btn primary"
            disabled={!capsuleId}
            onClick={async () => {
              const ok = await act(() => api('PATCH', `/api/looks/${look.id}`, { rev: look.rev, name, note, capsuleId }), t('Збережено'));
              if (ok) onClose();
            }}
          >
            {t('Зберегти')}
          </button>
        </>
      }
    >
      <div className="grid-form">
        <label className="field full"><span>{t('Назва')}</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field full"><span>{t('Капсула')}</span><select className="select" value={capsuleId} onChange={(e) => setCapsuleId(e.target.value)}>
          {!capsuleId && <option value="" disabled>{t('Вибери капсулу')}</option>}
          {capsules.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select></label>
        <label className="field full"><span>{t('Нотатка')}</span><textarea className="textarea" value={note} onChange={(e) => setNote(e.target.value)} /></label>
      </div>
      {onMakePrimary && <div className="row wrap" style={{ marginTop: 12 }}>
        <button className="btn ghost" onClick={onMakePrimary}>{t('Зробити головним')}</button>
      </div>}
    </Modal>
  );
}

function CreateLook({ capsule, onClose }: { capsule: Capsule; onClose: () => void }) {
  const db = useDb();
  const { act, toast } = useApp();
  const [name, setName] = useState('');
  const [slots, setSlots] = useState<Look['slots']>({ layer: [], top: [], bottom: [], shoes: [], accessories: [] });
  const [saving, setSaving] = useState(false);
  const refs: SlotRef[] = capsule.pieces ? capsulePieceRefs(db, capsule) : [
    ...db.items.filter((item) => item.status !== 'inactive' && !item.mergedInto && !isBlockedEyewear(db, item.title)).map((item) => ({ kind: 'item' as const, id: item.id })),
    ...db.needs.filter((need) => need.status === 'open').map((need) => ({ kind: 'need' as const, id: need.id })),
  ];
  const options = refs.map((ref) => resolveRef(db, ref));
  const picked = new Set(Object.values(slots).flat().map(pieceKey));
  const save = async () => {
    setSaving(true);
    // The server answers an existing composition in this capsule with that look instead of a copy.
    const known = new Set(db.looks.map((l) => l.id));
    const look = await act(() => api<Look>('POST', '/api/looks', { capsuleId: capsule.id, name, slots }));
    setSaving(false);
    if (!look) return;
    toast(known.has(look.id) ? t('Такий образ уже є в цій капсулі') : t('Образ додано'));
    go(`/looks/${look.id}`);
  };
  return <Modal title={t('Новий образ')} onClose={onClose} footer={<>
    <button className="btn" onClick={onClose}>{t('Скасувати')}</button>
    <button className="btn primary" disabled={saving || !hasPieces({ slots })} onClick={() => void save()}>{t('Зберегти')}</button>
  </>}>
    <div className="grid-form">
      <label className="field full"><span>{t('Назва')}</span><input className="input" value={name} onChange={(event) => setName(event.target.value)} /></label>
      {(Object.keys(slots) as SlotKey[]).map((slot) => <div className="field full" key={slot}>
        <label className="field">
          <span>{t(SLOT_LABEL[slot])}</span>
          <select className="select" value="" onChange={(event) => {
            const option = options.find((entry) => pieceKey(entry.ref) === event.target.value);
            if (option) setSlots({ ...slots, [slot]: [...slots[slot], option.ref] });
          }}>
            <option value="" disabled>{t('Додати річ')}</option>
            {options.filter((option) => option.category && SLOT_CATEGORIES[slot].includes(option.category) && !picked.has(pieceKey(option.ref))).map((option) =>
              <option key={pieceKey(option.ref)} value={pieceKey(option.ref)}>{option.title}</option>)}
          </select>
        </label>
        {slots[slot].length > 0 && <div className="row wrap">
          {slots[slot].map((ref) => <button type="button" className="btn sm ghost" key={pieceKey(ref)} title={t('Прибрати з образу')} onClick={() => setSlots({ ...slots, [slot]: slots[slot].filter((entry) => pieceKey(entry) !== pieceKey(ref)) })}>
            {resolveRef(db, ref).title} ×
          </button>)}
        </div>}
      </div>)}
    </div>
  </Modal>;
}

function LookCard({ look, mark = false }: { look: Look; mark?: boolean }) {
  const db = useDb();
  const best = mark && isBestLook(db, look.id);
  return (
    <div className="look-card">
      <a className="cover" style={{ aspectRatio: '2 / 3' }} href={`/looks/${look.id}`}>
        <LookArt look={look} />
      </a>
      {/* Above the name, not on the picture: on a phone a corner label covered the face. */}
      <a href={`/looks/${look.id}`}>{mark && <span className={`eyebrow-sm best-mark${best ? '' : ' ghost'}`} aria-hidden={!best}>{t('Найкращий')}</span>}<h4 title={look.note}>{look.name}</h4><Missing look={look} /></a>
      <div className="card-foot">
        <RateButtons kind="look" target={look} size="sm" />
        {lookRating(look) !== null && <span className="score">{scoreLabel(lookRating(look)!)}</span>}
      </div>
    </div>
  );
}

function EditCapsule({ capsule, onClose }: { capsule: Capsule; onClose: () => void }) {
  const { act } = useApp();
  const db = useDb();
  const isSelection = capsule.kind === 'selection';
  // The set (owner, 20.11) is sent only when it changed, so renaming never trips over an unsaved, too-large set.
  const [initialSet] = useState(() => initialSetDraft(db, capsule));
  const [setDraft, setSetDraft] = useState(initialSet);
  const [multi, setMulti] = useState(capsule.accessoryLimit === 4);
  const [name, setName] = useState(capsule.name);
  const [description, setDescription] = useState(capsule.description);
  const [season, setSeason] = useState<Season>(capsule.season);
  const [situations, setSituations] = useState(capsule.situations.join('\n'));
  const save = async () => {
    const set = !isSelection && !sameSetDraft(setDraft, initialSet) ? setDraftPayload(setDraft) : {};
    const limit = isSelection ? {} : { accessoryLimit: multi ? 4 : null };
    const ok = await act(() => api('PATCH', `/api/capsules/${capsule.id}`, { rev: capsule.rev, name, description, season, situations: situations.split('\n'), ...limit, ...set }), t('Збережено'));
    if (ok) onClose();
  };
  return (
    <Modal
      title={t('Редагувати')}
      onClose={onClose}
      footer={
        <>
          <ConfirmButton
            className="btn ghost danger"
            title={capsule.kind === 'selection' ? t('Видалити підбірку') : t('Видалити капсулу')}
            message={<>{t('Видалити «{name}» і її образи назавжди? Щоб просто прибрати з очей — постав 👎. Речі в гардеробі залишаться.', { name: capsule.name })}</>}
            onConfirm={async () => {
              const ok = await act(() => api('DELETE', `/api/capsules/${capsule.id}`), t('Видалено'));
              if (ok !== undefined) go(capsule.kind === 'selection' ? '/capsules?tab=selections' : '/capsules', true);
            }}
          >
            <Trash2 size={14} />
          </ConfirmButton>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>{t('Скасувати')}</button>
          <button className="btn primary" onClick={() => void save()}>{t('Зберегти')}</button>
        </>
      }
    >
      <div className="grid-form">
        <label className="field full"><span>{t('Назва')}</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field full"><span>{t('Опис')}</span><textarea className="textarea" value={description} onChange={(e) => setDescription(e.target.value)} /></label>
        <label className="field">
          <span>{t('Сезон')}</span>
          <select className="select" value={season} onChange={(e) => setSeason(e.target.value as Season)}>
            {(['all', 'warm', 'transitional', 'cold'] as Season[]).map((s) => <option key={s} value={s}>{t(SEASON_LABEL[s])}</option>)}
          </select>
        </label>
        <label className="field full"><span>{t('Ситуації (по рядку)')}</span><textarea className="textarea" value={situations} onChange={(e) => setSituations(e.target.value)} /></label>
        {!isSelection && <>
          <label className="row full"><input type="checkbox" checked={multi} onChange={(event) => setMulti(event.target.checked)} /> {t('4 аксесуари (мультиспорт)')}</label>
          <CapsuleSetEditor capsule={{ ...capsule, accessoryLimit: multi ? 4 : undefined }} draft={setDraft} onChange={setSetDraft} />
        </>}
      </div>
    </Modal>
  );
}

export function CapsuleDetail({ id }: { id: string }) {
  const db = useDb();
  const { query } = useRoute();
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const capsule = db.capsules.find((c) => c.id === id);
  const allLooks = useMemo(() => capsuleLooks(db, capsule?.lookIds ?? []), [capsule, db]);
  if (!capsule) return <div className="page"><Empty icon={<ImageOff />} title={t('Не знайдено')} /></div>;
  if (capsule.redirectCapsuleIds) {
    // A merged or dissolved capsule (owner, 20.11): one destination opens directly; several are shown without the old name.
    // Follow chains of moves (an old capsule moved into one that moved again) to the live, shown capsules.
    const seen = new Set<string>();
    const queue = [...capsule.redirectCapsuleIds];
    const targets: Capsule[] = [];
    while (queue.length) {
      const next = queue.shift();
      const c = db.capsules.find((x) => x.id === next);
      if (!c || seen.has(c.id)) continue;
      seen.add(c.id);
      if (c.redirectCapsuleIds) queue.push(...c.redirectCapsuleIds);
      else if (!isCapsuleHidden(db, c)) targets.push(c);
    }
    if (targets.length === 1) return <MovedTo href={`/capsules/${targets[0].id}`} />;
    return <div className="page">
      <div className="crumb"><a href="/capsules">{t('Капсули')}</a></div>
      <div className="page-head"><h1>{t('Капсулу перенесено')}</h1></div>
      {targets.length > 0 && <div className="capsule-grid">{targets.map((c) => <CapsuleTile key={c.id} c={c} />)}</div>}
    </div>;
  }
  const hidden = isCapsuleHidden(db, capsule);
  // A hidden capsule opened from «Приховані» shows its looks so it can be judged again.
  const readyOnly = !hidden && query.get('owned') === '1';
  const looks = hidden ? rankLooks(db, allLooks) : distinctLooks(db, readyOnly ? allLooks.filter((l) => isComplete(db, l)) : allLooks);
  const pieces = looks.flatMap((l) => piecesOf(db, l.slots));
  const isSelection = capsule.kind === 'selection';

  return (
    <div className="page">
      <div className="crumb"><a href={isSelection ? '/capsules?tab=selections' : '/capsules'}>{isSelection ? t('Підбірки') : t('Капсули')}</a></div>
      <div className="page-head">
        <div>
          {capsule.periods?.length ? <span className="eyebrow-sm">{periodLine(capsule, true)}</span> : null}
          <h1>{capsule.name}</h1>
          {(readyLine(db, capsule) || capsuleRating(db, capsule) !== null) && <p className="miss" style={{ marginTop: 6 }}>{[readyLine(db, capsule), capsuleRating(db, capsule) !== null ? scoreLabel(capsuleRating(db, capsule)!) : ''].filter(Boolean).join(' · ')}</p>}
          <div className="row wrap" style={{ marginTop: 12 }}>
            {capsule.season !== 'all' && !capsule.periods?.length && <Badge>{t(SEASON_LABEL[capsule.season])}</Badge>}
            {hidden && <Badge>{t('приховано')}</Badge>}
            {capsule.situations.filter((s) => s.length <= 24).slice(0, 3).map((s) => <Badge key={s}>{s}</Badge>)}
          </div>
        </div>
        <div className="actions">
          <RateButtons kind="capsule" target={capsule} />
          <button className="icon-btn" aria-label={t('Редагувати')} onClick={() => setEditing(true)}><Pencil size={14} /></button>
          <button className="btn primary" onClick={() => setCreating(true)}><Plus size={16} /> {t('Образ')}</button>
        </div>
      </div>
      <LookGrid looks={looks} filter={!hidden && <div className="filters" role="group" aria-label={t('Фільтр образів')}><Filter active={readyOnly} href={`/capsules/${capsule.id}${readyOnly ? '' : '?owned=1'}`}>{t(WARDROBE_CAPSULE_NAME)}</Filter></div>} />
      {isSelection ? <PieceBlocks pieces={pieces} ownTitle={t('Речі капсули')} /> : <CapsuleSetSection capsule={capsule} />}
      {editing && <EditCapsule capsule={capsule} onClose={() => setEditing(false)} />}
      {creating && <CreateLook capsule={capsule} onClose={() => setCreating(false)} />}
    </div>
  );
}
