import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Archive, Camera, Check, CircleCheck, CircleDashed, Dumbbell, Grid2x2, Merge, Pencil, Plus, Search, Sparkles, Trash2, Wand2 } from 'lucide-react';
import type { Category, Item, ItemStatus, Job, Photo } from '../api.ts';
import { api, media, thumb } from '../api.ts';
import { go, useApp, useDb } from '../store.tsx';
import { Badge, CategoryIcon, ConfirmButton, Empty, JobBar, LookArt, Missing, Modal, PageHead, PhotoPicker, SubNav, UploadButton } from '../components/ui.tsx';
import { CATEGORY_LABEL, capsuleCount, isBlockedEyewear, itemArt, itemPlacements, itemRating, itemVerdict, scoreLabel, usageLabel, wardrobeCapsule } from '../lib.ts';
import { itemCoverOptions, primaryPhotoFirst } from '../item-images.ts';

import { InfoMark, TermInfo } from './Glossary.tsx';
import { t } from '../i18n.ts';

const STATUS_LABEL: Record<ItemStatus, string> = { needs_confirmation: 'Потребує підтвердження', confirmed: 'Підтверджено', inactive: 'Неактуальна' };
const STATUS_SHORT: Record<ItemStatus, string> = { needs_confirmation: 'звірити', confirmed: 'моя річ', inactive: 'неактуальна' };
const STATUS_TONE: Record<ItemStatus, string> = { needs_confirmation: 'warn', confirmed: 'ok', inactive: '' };
const CATS = Object.keys(CATEGORY_LABEL) as Category[];

const duplicateTarget = (items: Item[], item: Item) => item.possibleDuplicateOf
  ? items.find((x) => x.id === item.possibleDuplicateOf && !x.mergedInto && x.status !== 'inactive')
  : undefined;

function usePackshotState() {
  const db = useDb();
  const busy = new Map<string, Job>();
  for (const j of db.jobs) if (j.kind === 'packshot' && j.itemId && (j.state === 'queued' || j.state === 'running') && busy.get(j.itemId)?.state !== 'running') busy.set(j.itemId, j);
  return busy;
}

/**
 * Minimal item page (owner, 17.11: always minimal, never side panels): the
 * picture and photos, one "Це моя річ?" question while unconfirmed, the looks
 * it is in. Everything editable sits behind the pencil. Owner, 24.11: the
 * question answers «Ношу · Не ношу · Не моя»; a piece one no longer wears goes
 * to «Неактуальні» with a quiet «Не ношу»; «Не моя» deletes it.
 */
function ItemPage({ item }: { item: Item }) {
  const db = useDb();
  const { act, refresh } = useApp();
  const busy = usePackshotState();
  const [editing, setEditing] = useState(false);
  const [picking, setPicking] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [resolving, setResolving] = useState(false);
  const photos = item.photoIds.flatMap((id) => db.photos.filter((p) => p.id === id));
  const { art, photo } = itemArt(db, item.id);
  const main = art ?? photo;
  const dupTarget = duplicateTarget(db.items, item);
  const dupArt = dupTarget && itemArt(db, dupTarget.id);
  const dupPath = dupArt?.art ?? dupArt?.photo;
  const { looks, capsules } = itemPlacements(db, item.id);
  const covers = db.needs.filter((n) => n.coveredByItem === item.id);
  const verdict = itemVerdict(db, item);
  const patch = (body: Record<string, unknown>, msg: string) => act(() => api('PATCH', `/api/items/${item.id}`, { rev: item.rev, ...body }), msg);
  const notWorn = () => void patch({ status: 'inactive' }, t('Прибрано в «Неактуальні»'));
  const confirmSeparate = () => patch({
    ...(item.status === 'needs_confirmation' ? { status: 'confirmed' } : {}),
    ...(item.possibleDuplicateOf ? { clearDuplicate: true } : {}),
  }, t(item.status === 'needs_confirmation' ? 'Моя річ' : 'Збережено'));
  const resolveDuplicate = async (target?: Item) => {
    setResolving(true);
    if (target) {
      const ok = await act(() => api('POST', `/api/items/${target.id}/absorb`, { sourceId: item.id }), t('Фото прикріплено'));
      if (ok) go(`/wardrobe/${target.id}`);
    } else {
      await confirmSeparate();
    }
    setResolving(false);
  };
  const attachable = (p: Photo) => p.source !== 'generated' && p.kind !== 'worn' && !p.inspiration && !p.archivedAt && !item.photoIds.includes(p.id);
  const attachPhotos = async (ids: string[]) => {
    setPicking(false);
    const pending = ids.filter((id) => db.photos.some((p) => p.id === id && attachable(p)));
    if (!pending.length) return;
    setAttaching(true);
    const ok = await act(async () => {
      for (const id of pending) await api('PATCH', `/api/photos/${id}`, { attachItemId: item.id });
      return true;
    }, t('Фото прикріплено'));
    if (!ok) await refresh(); // Earlier photos may already have been attached.
    setAttaching(false);
  };
  const findLooks = async () => {
    const ok = await act(() => api('POST', '/api/discover', { itemIds: [item.id] }), t('Підбираю образи з цією річчю'));
    if (ok) go(`/capsules?tab=new&item=${encodeURIComponent(item.id)}`);
  };

  return (
    <div className="page">
      <div className="crumb"><a href="/wardrobe">{t('Гардероб')}</a></div>
      <div className="page-head">
        <div>
          <h1>{item.title}<TermInfo texts={[item.title, item.fit]} /></h1>
          {verdict && (
            <p className="item-verdict">
              {/* The ⓘ stays with the last word; «у покупках» and «Ні» stay together. */}
              {verdict.line.includes(' ') ? `${verdict.line.slice(0, verdict.line.lastIndexOf(' '))} ` : ''}
              <span className="nowrap">{verdict.line.slice(verdict.line.lastIndexOf(' ') + 1)}{verdict.note && <InfoMark title={`${item.rating!.score}/10`} text={verdict.note} />}</span>
              {(verdict.need || (verdict.kind === 'replace' && item.status !== 'needs_confirmation')) && <span className="nowrap">
                {verdict.need && <> · <a href={`/shopping?need=${verdict.need.id}`}>{t('у покупках')}</a></>}
                {verdict.kind === 'replace' && item.status !== 'needs_confirmation' && <button className="btn sm verdict-no" onClick={() => void act(() => api('POST', `/api/items/${item.id}/keep`), t('Залишаю — порадник оцінить ще раз'))}>{t('Ні')}</button>}
              </span>}
            </p>
          )}
        </div>
        <div className="actions">
          <button className="icon-btn" aria-label={t('Редагувати річ')} onClick={() => setEditing(true)}><Pencil size={14} /></button>
        </div>
      </div>

      <div className="item-hero">
        <a className="item-main" href={main ? media(main) : undefined} target={main ? '_blank' : undefined} rel="noreferrer">
          {main ? <img src={thumb(main, 960)} alt={item.title} /> : <CategoryIcon category={item.category} size={34} />}
          {busy.get(item.id) && <JobBar job={busy.get(item.id)!} label />}
        </a>
        <div className="item-thumbs">
          {photos.map((p) => (
            <a key={p.id} className="item-thumb" href={media(p.path)} target="_blank" rel="noreferrer"><img src={thumb(p.path, 240)} alt="" loading="lazy" /></a>
          ))}
          <UploadButton kind="item" params={{ item: item.id }} className="item-thumb add" label="" />
          <button className="quiet-toggle item-photo-picker" disabled={attaching || !db.photos.some(attachable)} onClick={() => setPicking(true)}>{t('З моїх фото')}</button>
        </div>
      </div>

      {dupTarget && (
        <div className="its-me duplicate-review">
          <a className="row" href={`/wardrobe/${dupTarget.id}`}>
            <span className="item-thumb">{dupPath ? <img src={thumb(dupPath, 160)} alt="" /> : <CategoryIcon category={dupTarget.category} />}</span>
            {t('Можливо, це «{title}»', { title: dupTarget.title })}
          </a>
          <div className="row wrap">
            <button className="btn sm primary" disabled={resolving} onClick={() => void resolveDuplicate(dupTarget)}>{t('Додати фото до «{title}»', { title: dupTarget.title })}</button>
            <button className="quiet-toggle" disabled={resolving} onClick={() => void resolveDuplicate()}>{t('Це окрема річ')}</button>
            {item.status === 'needs_confirmation' && <>
              <button className="quiet-toggle" disabled={resolving} onClick={notWorn}>{t('Не ношу')}</button>
              <DeleteItem item={item} className="btn">{t('Не моя')}</DeleteItem>
            </>}
          </div>
        </div>
      )}
      {!dupTarget && item.status === 'needs_confirmation' && (
        <div className="its-me">
          <span>{t('Це моя річ?')}</span>
          <DeleteItem item={item} className="btn">{t('Не моя')}</DeleteItem>
          <button className="btn" onClick={notWorn}>{t('Не ношу')}</button>
          <button className="btn primary" onClick={() => void confirmSeparate()}><Check size={15} /> {t('Ношу')}</button>
        </div>
      )}
      {item.status === 'confirmed' && (
        <div className="its-me">
          <button className="quiet-toggle" onClick={notWorn}>{t('Не ношу')}</button>
        </div>
      )}
      {item.status === 'inactive' && !item.mergedInto && (
        <div className="its-me">
          <span>{t('Не ношу')}</span>
          <button className="btn" onClick={() => void patch({ status: 'confirmed' }, t('Повернуто'))}>{t('Повернути')}</button>
        </div>
      )}

      <div className="section-head">
        <h2 className="h2">{t('Де використано')} <span className="count">{usageLabel(capsuleCount(capsules), looks.length)}</span></h2>
        {/* New looks only for a piece one wears and the advisor would keep; they wait in «Нові» for «Додати». */}
        {item.status === 'confirmed' && verdict?.kind !== 'replace' && !isBlockedEyewear(db, item.title) && (
          <button className="quiet-toggle" onClick={() => void findLooks()}>{t('Підібрати образи з нею')}</button>
        )}
      </div>
      {capsules.length > 0 && <div className="row wrap" style={{ gap: 6, marginBottom: 12 }}>
        {capsules.map((c) => <a className="btn sm" key={c.id} href={`/capsules/${c.id}`}>{c.name} <span className="count">{c.looks.length}</span></a>)}
      </div>}
      {looks.length > 0 && (
        <div className="sib-strip">
          {looks.map((l) => (
            <a key={l.id} className="sib" href={`/looks/${l.id}`}>
              <span className="img"><LookArt look={l} w={480} /></span>
              <span className="nm">{l.name}</span>
              <Missing look={l} />
            </a>
          ))}
        </div>
      )}
      {covers.map((n) => (
        <a key={n.id} className="small muted" style={{ display: 'block', marginTop: 16 }} href={`/shopping?need=${n.id}`}>{t('Закриває покупку «{title}»', { title: n.title })}</a>
      ))}
      {picking && <PhotoPicker title={t('З моїх фото')} selected={[]} filter={attachable} onClose={() => setPicking(false)} onSave={attachPhotos} />}
      {editing && <ItemEdit item={item} photos={photos} onClose={() => setEditing(false)} />}
    </div>
  );
}

/** Deletes the item after a confirmation; its original photos stay in the archive. */
function DeleteItem({ item, className, children }: { item: Item; className: string; children: ReactNode }) {
  const { act } = useApp();
  return (
    <ConfirmButton
      className={className}
      title={t('Видалити річ')}
      message={t('Видалити «{title}» з гардероба? Фото-оригінали лишаться в архіві.', { title: item.title })}
      onConfirm={async () => {
        const ok = await act(() => api('DELETE', `/api/items/${item.id}`), t('Річ видалено'));
        if (ok !== undefined) go('/wardrobe');
      }}
    >
      {children}
    </ConfirmButton>
  );
}

/** Everything editable about an item, in one modal behind the pencil. */
function ItemEdit({ item, photos, onClose }: { item: Item; photos: Photo[]; onClose: () => void }) {
  const db = useDb();
  const { act } = useApp();
  const [sport, setSport] = useState(Boolean(item.sport));
  const covers = itemCoverOptions(db, [item]);
  const [primaryChoice, setPrimary] = useState<string>();
  const [coverChoice, setCover] = useState<string>();
  const primary = photos.find((p) => p.id === primaryChoice)?.id ?? photos[0]?.id;
  const cover = covers.find((p) => p.id === coverChoice)?.id ?? covers[0]?.id;
  // Replacing photoIds on the server would drop archived or worn links from older items.
  const canReorder = photos.every((p) => !p.archivedAt && p.kind !== 'worn');
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ title: item.title, category: item.category, color: item.color ?? '', brand: item.brand ?? '', model: item.model ?? '', composition: item.composition ?? '', fit: item.fit ?? '', size: item.size ?? '' });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const field = (k: keyof typeof form, label: string) => (
    <label className="field"><span>{t(label)}</span><input className="input" value={form[k]} onChange={set(k)} /></label>
  );
  const save = async () => {
    setSaving(true);
    const pictures = {
      ...(canReorder && primary && primary !== item.photoIds[0] ? { photoIds: primaryPhotoFirst(item.photoIds, primary) } : {}),
      ...(cover && cover !== item.packshotId ? { packshotId: cover } : {}),
    };
    const ok = await act(() => api('PATCH', `/api/items/${item.id}`, { rev: item.rev, ...form, sport, ...pictures }), t('Збережено'));
    setSaving(false);
    if (ok) onClose();
  };
  const detach = async (photoId: string) => {
    setSaving(true);
    await act(() => api('PATCH', `/api/photos/${photoId}`, { detachItemId: item.id }), t('Фото відкріплено'));
    setSaving(false);
  };
  const split = async (photoId: string) => {
    setSaving(true);
    const part = await act(() => api<Item>('POST', `/api/items/${item.id}/split`, { rev: item.rev, photoIds: [photoId] }), t('Річ додано'));
    setSaving(false);
    if (part) {
      onClose();
      go(`/wardrobe/${part.id}`);
    }
  };
  return (
    <Modal
      title={t('Річ')}
      onClose={() => { if (!saving) onClose(); }}
      footer={
        <>
          <DeleteItem item={item} className="btn ghost danger"><Trash2 size={14} /> {t('Видалити річ')}</DeleteItem>
          <button className="btn ghost" disabled={saving} onClick={() => void act(() => api('POST', '/api/packshots', { itemIds: [item.id], run: true }), t('Нове фото речі в роботі'))}><Wand2 size={14} /> {t('Нове фото')}</button>
          <span style={{ flex: 1 }} />
          <button className="btn primary" disabled={saving} onClick={() => void save()}>{t('Зберегти')}</button>
        </>
      }
    >
      <div className="grid-form">
        <label className="field full"><span>{t('Назва')}</span><input className="input" value={form.title} onChange={set('title')} /></label>
        <label className="field">
          <span>{t('Категорія')}</span>
          <select className="select" value={form.category} onChange={set('category')}>
            {CATS.map((c) => <option key={c} value={c}>{t(CATEGORY_LABEL[c])}</option>)}
          </select>
        </label>
        {field('color', 'Колір')}
        {field('brand', 'Бренд')}
        {field('size', 'Розмір')}
        {field('model', 'Модель')}
        {field('composition', 'Склад')}
        {field('fit', 'Крій')}
        <label className="row"><input type="checkbox" checked={sport} onChange={(event) => setSport(event.target.checked)} /> {t('Спорт')}</label>
        {covers.length > 1 && <PhotoChoices title={t('Каталожна обкладинка')} photos={covers} selected={cover} onSelect={setCover} disabled={saving} />}
        {photos.length > 1 && <PhotoChoices title={t('Основне фото')} photos={photos} selected={primary} onSelect={setPrimary} disabled={saving || !canReorder} />}
        {photos.length > 0 && <div className="field full">
          <span>{t('Фото речі')}</span>
          <div className="item-photo-list">
            {photos.map((p) => <div className="row" key={p.id} role="group" aria-label={p.originalName}>
              <span className="item-thumb"><img src={thumb(p.path, 160)} alt="" loading="lazy" /></span>
              <button className="quiet-toggle" disabled={saving} onClick={() => void detach(p.id)}>{t('Відкріпити')}</button>
              {photos.length >= 2 && <button className="quiet-toggle" disabled={saving} onClick={() => void split(p.id)}>{t('В окрему річ')}</button>}
            </div>)}
          </div>
        </div>}
      </div>
    </Modal>
  );
}

function PhotoChoices({ title, photos, selected, onSelect, disabled }: { title: string; photos: Photo[]; selected?: string; onSelect: (id: string) => void; disabled?: boolean }) {
  return (
    <div className="field full">
      <span>{title}</span>
      <div className="item-thumbs" role="group" aria-label={title}>
        {photos.map((photo) => (
          <button key={photo.id} type="button" className="item-thumb" aria-label={photo.originalName} aria-pressed={selected === photo.id} disabled={disabled} onClick={() => onSelect(photo.id)}>
            <img src={thumb(photo.path, 240)} alt="" />
            {selected === photo.id && <span className="tr sel-box"><Check size={14} /></span>}
          </button>
        ))}
      </div>
    </div>
  );
}

function MergeItems({ ids, onClose, onMerged }: { ids: string[]; onClose: () => void; onMerged: (id: string) => void }) {
  const db = useDb();
  const { act } = useApp();
  const sources = ids.flatMap((id) => db.items.filter((item) => item.id === id && !item.mergedInto));
  const originals = [...new Set(sources.flatMap((item) => item.photoIds))].flatMap((id) =>
    db.photos.filter((photo) => photo.id === id && photo.kind !== 'worn'));
  const covers = itemCoverOptions(db, sources);
  const originalFor = (item?: Item) => item?.photoIds.find((id) => originals.some((photo) => photo.id === id)) ?? originals[0]?.id;
  const coverFor = (item?: Item) => covers.find((photo) => item?.packshotId === photo.id)?.id ?? covers[0]?.id;
  const defaultItem = sources.find((item) => item.status === 'confirmed') ?? sources[0];
  const [keepId, setKeepId] = useState(defaultItem?.id);
  const [primary, setPrimary] = useState(originalFor(defaultItem));
  const [cover, setCover] = useState(coverFor(defaultItem));
  const [saving, setSaving] = useState(false);
  const merge = async () => {
    setSaving(true);
    const item = await act(() => api<Item>('POST', '/api/items/merge', { ids, keepId, primaryPhotoId: primary, packshotId: cover }), t('Дублікати обʼєднано, джерела збережено'));
    setSaving(false);
    if (item) onMerged(item.id);
  };
  return <Modal title={t('Обʼєднати дублікати')} onClose={() => { if (!saving) onClose(); }} footer={<>
    <button type="button" className="btn" disabled={saving} onClick={onClose}>{t('Скасувати')}</button>
    <button type="button" className="btn primary" disabled={saving || sources.length < 2 || !sources.some((item) => item.id === keepId)} onClick={() => void merge()}>{t('Обʼєднати')}</button>
  </>}>
    <div className="stack" style={{ gap: 14 }}>
      <div className="field" role="group" aria-label={t('Залишити картку')}>
        <span>{t('Залишити картку')}</span>
        <div className="own-picks">
          {sources.map((item) => {
            const { art, photo } = itemArt(db, item.id);
            const selected = keepId === item.id;
            return <button key={item.id} type="button" className={`own-pick${selected ? ' on' : ''}`} aria-pressed={selected} disabled={saving} onClick={() => {
              setKeepId(item.id);
              setPrimary(originalFor(item));
              setCover(coverFor(item));
            }}>
              <span className="img">{art || photo ? <img src={thumb((art ?? photo)!, 240)} alt="" /> : <CategoryIcon category={item.category} size={22} />}</span>
              <span>{item.title}</span>
            </button>;
          })}
        </div>
      </div>
      {covers.length > 0 && <PhotoChoices title={t('Каталожна обкладинка')} photos={covers} selected={cover} onSelect={setCover} />}
      {originals.length > 0 && <PhotoChoices title={t('Основне фото')} photos={originals} selected={primary} onSelect={setPrimary} />}
    </div>
  </Modal>;
}

function NewItem({ onClose }: { onClose: () => void }) {
  const { act } = useApp();
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<Category>('tees');
  const [sport, setSport] = useState(false);
  return (
    <Modal
      title={t('Нова річ')}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>{t('Скасувати')}</button>
          <button
            className="btn primary"
            onClick={async () => {
              const item = await act(() => api<Item>('POST', '/api/items', { title, category, sport }), t('Річ додано'));
              if (item) {
                onClose();
                go(`/wardrobe/${item.id}`);
              }
            }}
          >
            {t('Додати')}
          </button>
        </>
      }
    >
      <div className="grid-form">
        <label className="field full"><span>{t('Назва')}</span><input className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('напр. Біла Oxford-сорочка')} /></label>
        <label className="field">
          <span>{t('Категорія')}</span>
          <select className="select" value={category} onChange={(e) => setCategory(e.target.value as Category)}>
            {CATS.map((c) => <option key={c} value={c}>{t(CATEGORY_LABEL[c])}</option>)}
          </select>
        </label>
        <label className="row"><input type="checkbox" checked={sport} onChange={(event) => setSport(event.target.checked)} /> {t('Спорт')}</label>
      </div>
    </Modal>
  );
}

function MergedItemLink({ id }: { id: string }) {
  useEffect(() => { go(`/wardrobe/${id}`, true); }, [id]);
  return null;
}

export function WardrobePage({ openId }: { openId?: string }) {
  const db = useDb();
  const { act } = useApp();
  const busy = usePackshotState();
  const [view, setView] = useState<string>('all');
  const [q, setQ] = useState('');
  const [mode, setMode] = useState<'merge' | 'compose' | null>(null);
  const [sel, setSel] = useState<string[]>([]);
  const mergeSel = mode ? sel : null;
  const startMode = (m: 'merge' | 'compose') => {
    setSel([]);
    setMode(m);
  };
  const stopMode = () => {
    setSel([]);
    setMode(null);
  };
  const toggle = (id: string) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : mode === 'compose' && s.length >= 4 ? s : [...s, id]));
  // Same count as the item page: distinct looks (near-copies fold into one).
  const ready = wardrobeCapsule(db);
  const [creating, setCreating] = useState(false);
  const [confirmMerge, setConfirmMerge] = useState(false);
  const status = (['needs_confirmation', 'confirmed', 'inactive'] as ItemStatus[]).includes(view as ItemStatus) ? (view as ItemStatus) : null;
  const isNew = (i: Item) => i.origin === 'intake' && i.status === 'needs_confirmation';
  const cat = CATS.includes(view as Category) ? (view as Category) : null;
  const sport = view === 'sport';
  // Inactive items only appear in the «Неактуальні» filter.
  const list = db.items.filter(
    (i) => !i.mergedInto && !(mode === 'compose' && isBlockedEyewear(db, i.title)) && (view !== 'new' || isNew(i)) && (!cat || i.category === cat) && (!sport || i.sport) && (status ? i.status === status : i.status !== 'inactive') && `${i.title} ${i.id} ${i.brand ?? ''}`.toLowerCase().includes(q.trim().toLowerCase()),
  );
  const visible = db.items.filter((i) => i.status !== 'inactive' && !i.mergedInto);
  const open = openId ? db.items.find((i) => i.id === openId) : undefined;
  const missing = db.items.filter((i) => !i.packshotId && i.status !== 'inactive' && !busy.has(i.id)).length;
  const title = t(view === 'new' ? 'Нові з фото' : sport ? 'Спорт' : cat ? CATEGORY_LABEL[cat] : status ? STATUS_LABEL[status] : 'Усі речі');
  // An item opens as its own page, not a side panel over the grid.
  if (open?.mergedInto && db.items.some((item) => item.id === open.mergedInto)) return <MergedItemLink id={open.mergedInto} />;
  if (open) return <ItemPage key={open.id} item={open} />;

  return (
    <div className="page">
      <PageHead
        title={title}
        actions={
          mode ? null : (
            <>
              {missing > 0 && (
                <button className="btn" onClick={() => void act(() => api('POST', '/api/packshots', { all: true, run: true }), t('Роблю фото речей'))} title={t('Фото речей')}>
                  <Wand2 size={15} /> {t('Фото')} {missing}
                </button>
              )}
              <button className="icon-btn" onClick={() => startMode('merge')} title={t('Обʼєднати дублікати')}><Merge size={15} /></button>
              <button className="icon-btn" onClick={() => setCreating(true)} title={t('Додати вручну')}><Plus size={16} /></button>
              <button className="btn primary" onClick={() => startMode('compose')}><Sparkles size={15} /> {t('Доповнити образ')}</button>

            </>
          )
        }
      />


      <div className="split">
        <SubNav
          value={view}
          onChange={(k) => setView(k)}
          groups={[
            {
              items: [
                { key: 'all', label: 'Усі речі', icon: <Grid2x2 size={17} />, n: visible.length },
                ...(db.items.some(isNew) ? [{ key: 'new', label: 'Нові з фото', icon: <Camera size={17} />, n: db.items.filter(isNew).length }] : []),
              ],
            },
            { label: 'Категорії', items: [
              ...(visible.some((i) => i.sport) || view === 'sport' ? [{ key: 'sport', label: 'Спорт', icon: <Dumbbell size={17} />, n: visible.filter((i) => i.sport).length }] : []),
              ...CATS.map((c) => ({ key: c, label: CATEGORY_LABEL[c], icon: <CategoryIcon category={c} size={17} />, n: visible.filter((i) => i.category === c).length })),
            ] },
            {
              label: 'Статус',
              items: [
                { key: 'needs_confirmation', label: 'Звірити', icon: <CircleDashed size={17} />, n: db.items.filter((i) => i.status === 'needs_confirmation').length },
                { key: 'confirmed', label: 'Мої речі', icon: <CircleCheck size={17} />, n: db.items.filter((i) => i.status === 'confirmed').length },
                { key: 'inactive', label: 'Неактуальні', icon: <Archive size={17} />, n: db.items.filter((i) => i.status === 'inactive' && !i.mergedInto).length },
              ],
            },
          ]}
        />
        <div>
          <div className="toolbar">
            <label className="search">
              <Search size={15} />
              <input className="input" placeholder={t('Пошук речі')} value={q} onChange={(e) => setQ(e.target.value)} />
            </label>
            <span className="grow" />
          </div>
          {list.length === 0 ? (
            <Empty icon={<CircleDashed />} title={t('Речей не знайдено')}>{t('Зміни фільтр або додай нову річ.')}</Empty>
          ) : (
            <div className="ward-grid">
              {list.map((i) => {
                const { art, photo } = itemArt(db, i.id);
                const selected = mergeSel?.includes(i.id);
                const st = busy.get(i.id);
                const usage = mergeSel ? null : itemPlacements(db, i.id, ready);
                const duplicate = duplicateTarget(visible, i);
                return (
                  <button
                    key={i.id}
                    className={`wtile${selected ? ' selected' : ''}`}
                    onClick={() => (mode ? toggle(i.id) : go(`/wardrobe/${i.id}`))}
                  >
                    <div className="img">
                      {art ? <img src={thumb(art, 480)} alt={i.title} loading="lazy" /> : photo ? <img className="photo" src={thumb(photo, 480)} alt={i.title} loading="lazy" /> : <CategoryIcon category={i.category} size={22} />}
                      {duplicate ? <span className="tl"><Badge tone="warn glass">{t('дублікат?')}</Badge></span>
                        : i.status !== 'needs_confirmation' ? <span className="tl"><Badge tone={`${STATUS_TONE[i.status]} glass`}>{t(STATUS_SHORT[i.status])}</Badge></span>
                        : isNew(i) && <span className="tl"><Badge tone="info glass">{t('нова')}</Badge></span>}
                      {mergeSel && <span className="tr sel-box">{selected && <Check size={14} />}</span>}
                      {st?.state === 'running' && <JobBar job={st} />}
                    </div>
                    <span className="nm">{i.title}<TermInfo texts={[i.title]} /></span>
                    {usage && <span className="sub">{[itemRating(i, db) !== null ? scoreLabel(itemRating(i, db)!) : '', usageLabel(capsuleCount(usage.capsules), usage.looks.length)].filter(Boolean).join(' · ')}</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
      {mode && (
        <div className="sel-bar">
              <span className="small muted">{mode === 'compose' ? `${t('Вибери 1–4 речі')} · ${sel.length}` : `${t('Вибери дублікати')} · ${sel.length}`}</span>
              <button className="btn" onClick={stopMode}>{t('Скасувати')}</button>
              {mode === 'merge' ? (
                <button
                  className="btn primary"
                  disabled={sel.length < 2}
                  onClick={() => setConfirmMerge(true)}
                >
                  <Merge size={15} /> {t('Обʼєднати')} {sel.length}
                </button>
              ) : (
                <button
                  className="btn primary"
                  disabled={sel.length < 1}
                  onClick={async () => {
                    const ok = await act(() => api('POST', '/api/discover', { itemIds: sel }), t('Шукаю нові образи з вибраними речами'));
                    if (ok) {
                      stopMode();
                      go('/capsules?tab=new');
                    }
                  }}
                >
                  <Sparkles size={15} /> {t('Доповнити')} {sel.length || ''}
                </button>
              )}
                    </div>
      )}
      {creating && <NewItem onClose={() => setCreating(false)} />}
      {confirmMerge && <MergeItems ids={sel} onClose={() => setConfirmMerge(false)} onMerged={(id) => {
        setConfirmMerge(false);
        stopMode();
        go(`/wardrobe/${id}`);
      }} />}
    </div>
  );
}
