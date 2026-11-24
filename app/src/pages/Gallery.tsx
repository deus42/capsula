import { useEffect, useMemo, useState } from 'react';
import { Download, ExternalLink, Images, RotateCcw, ThumbsUp, Trash2, X } from 'lucide-react';
import type { DB, Photo, Result } from '../api.ts';
import { api, media, thumb } from '../api.ts';
import { useApp, useDb, useRoute } from '../store.tsx';
import { Badge, ConfirmButton, Empty, Overlay, PageHead, RateButtons } from '../components/ui.tsx';
import { hiddenLookIds } from '../rating.ts';
import { activeLocale, fmtDay } from '../lib.ts';
import './Gallery.css';
import { t } from '../i18n.ts';

type Entry = { kind: 'tryon'; r: Result; at: string } | { kind: 'packshot' | 'inspiration' | 'original'; p: Photo; at: string; itemId?: string };

const PHOTO_ROLES = [['item', 'Одяг'], ['face', 'Обличчя'], ['base', 'Опора'], ['label', 'Етикетка']] as const;

function entries(db: DB): Entry[] {
  const hidden = hiddenLookIds(db);
  const out: Entry[] = db.results.filter((r) => !hidden.has(r.lookId)).map((r) => ({ kind: 'tryon' as const, r, at: r.createdAt }));
  for (const p of db.photos) {
    if (p.inspiration) {
      out.push({ kind: 'inspiration', p, at: p.createdAt });
      continue;
    }
    if (p.source !== 'generated') {
      out.push({ kind: 'original', p, at: p.createdAt });
      continue;
    }
    if (p.kind !== 'packshot') continue;
    // Only the current photo of an item in use: no superseded or orphaned duplicates.
    const item = db.items.find((i) => i.packshotId === p.id && i.status !== 'inactive' && !i.mergedInto);
    if (!item) continue;
    out.push({ kind: 'packshot', p, at: p.createdAt, itemId: item.id });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

function dayKey(iso: string) {
  return fmtDay(iso);
}

function Lightbox({ entry, onClose }: { entry: Entry; onClose: () => void }) {
  const db = useDb();
  const { act } = useApp();
  const [saving, setSaving] = useState(false);
  if (entry.kind === 'tryon') {
    // A try-on in the archive: the picture, the look's rating and the way to the look (its check lives on the look page).
    const r = db.results.find((x) => x.id === entry.r.id);
    if (!r) return null;
    const look = db.looks.find((l) => l.id === r.lookId);
    return (
      <Overlay onClose={onClose}>
        <div className="lightbox simple" role="dialog" aria-modal="true">
          <div className="lb-img"><img src={media(r.imagePath)} alt={look?.name} /></div>
          <div className="lb-bar">
            {look ? <a className="grow lb-name" href={`/looks/${look.id}`} onClick={onClose}>{look.name}</a> : <b className="grow">{t('Примірка')}</b>}
            {look && <RateButtons kind="look" target={look} size="sm" />}
            <button className="icon-btn" onClick={onClose} aria-label={t('Закрити')}><X size={16} /></button>
          </div>
        </div>
      </Overlay>
    );
  }
  const original = entry.kind === 'original';
  const photo = original ? db.photos.find((x) => x.id === entry.p.id) : entry.p;
  if (!photo) return null;
  const item = entry.itemId ? db.items.find((i) => i.id === entry.itemId) : undefined;
  const job = db.jobs.find((j) => j.photoId === photo.id);
  const inspiration = photo.inspiration;
  const title = inspiration?.title ?? item?.title ?? (original ? t('Моє фото') : t('Фото'));
  const worn = original && photo.kind === 'worn';
  const editable = original && !worn && photo.source !== 'generated' && !inspiration;
  const identity = db.profile.identity;
  const isProtectedIdentity = Boolean(identity && (identity.sourcePhotoId === photo.id || identity.original.path === photo.path
    || identity.bodyOriginal?.path === photo.path || identity.hair?.sourcePhotoId === photo.id || identity.hair?.original.path === photo.path));
  const activeItems = editable ? db.items.filter((i) => !i.mergedInto && i.status !== 'inactive') : [];
  const linkedItems = activeItems.filter((i) => i.photoIds.includes(photo.id));
  const attachableItems = activeItems.filter((i) => !i.photoIds.includes(photo.id)).sort((a, b) => a.title.localeCompare(b.title, activeLocale()));
  const wears = original ? db.wears?.filter((w) => w.photoIds.includes(photo.id)) ?? [] : [];
  const wornLooks = worn ? db.looks.filter((l) => wears.some((w) => w.lookId === l.id)) : [];
  const intakeBusy = editable && db.jobs.some((j) => j.kind === 'intake' && j.inputPhotoIds?.includes(photo.id) && (j.state === 'queued' || j.state === 'running'));
  const canArchive = !isProtectedIdentity && wears.length === 0 && linkedItems.length === 0 && !activeItems.some((i) => i.packshotId === photo.id);
  const photoRole = photo.referenceRole === 'face' ? 'face' : photo.kind === 'base' ? 'base' : photo.kind === 'label' ? 'label' : 'item';
  const photoEndpoint = `/api/photos/${photo.id}`;
  const changePhoto = async (request: () => Promise<unknown>, message: string) => {
    setSaving(true);
    const result = await act(request, message);
    setSaving(false);
    return result;
  };
  const patchPhoto = (body: Record<string, unknown>, message = t('Збережено')) => changePhoto(() => api('PATCH', photoEndpoint, body), message);
  return (
    <Overlay onClose={onClose}>
      <div className={`lightbox${inspiration || original ? ' inspiration-lightbox' : ''}${original ? ' original-lightbox' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="lb-img" style={{ background: '#fff' }}><img src={media(photo.path)} alt={title} /></div>
        <div className="lb-side">
          <div className="drawer-head">
            <h2>{title}</h2>
            <button className="icon-btn" onClick={onClose} aria-label={t('Закрити')}><X size={16} /></button>
          </div>
          <div className="body">
            {inspiration?.sourceNote && <div className="note small">{inspiration.sourceNote}</div>}
            {inspiration && <div className="row wrap">{inspiration.tags.map((t) => <Badge key={t}>{t}</Badge>)}</div>}
            {editable && <>
              <div className="filters start" role="group" aria-label={t('Роль фото')}>
                {PHOTO_ROLES.map(([role, label]) => <button
                  key={role}
                  className={photoRole === role ? 'on' : ''}
                  aria-pressed={photoRole === role}
                  disabled={saving || (isProtectedIdentity && (role === 'item' || role === 'label'))}
                  onClick={() => void patchPhoto({ role })}
                >{t(label)}</button>)}
              </div>
              {linkedItems.length > 0 && <ul className="gallery-photo-links">
                {linkedItems.map((i) => <li className="row" key={i.id}>
                  <a className="quiet-toggle" href={`/wardrobe/${i.id}`} onClick={onClose}>{i.title}</a>
                  <button className="quiet-toggle" aria-label={t('Відкріпити від «{title}»', { title: i.title })} disabled={saving} onClick={() => void patchPhoto({ detachItemId: i.id }, t('Фото відкріплено'))}><X size={14} /></button>
                </li>)}
              </ul>}
              <select className="select sm" aria-label={t('Прикріпити до речі')} value="" disabled={saving || attachableItems.length === 0} onChange={(event) => {
                if (event.target.value) void patchPhoto({ attachItemId: event.target.value }, t('Фото прикріплено'));
              }}>
                <option value="" disabled>{t('Прикріпити до речі')}</option>
                {attachableItems.map((i) => <option key={i.id} value={i.id}>{i.title}</option>)}
              </select>
            </>}
            {wornLooks.length > 0 && <ul className="gallery-photo-links">
              {wornLooks.map((look) => <li key={look.id}><a className="quiet-toggle" href={`/looks/${look.id}`} onClick={onClose}>{look.name}</a></li>)}
            </ul>}
          </div>
          <div className="drawer-foot">
            {!original && <ConfirmButton className="btn sm ghost danger" title={inspiration ? t('Прибрати референс') : t('Видалити фото речі')} message={inspiration ? t('Прибрати цей референс із галереї? Архівне джерело залишиться.') : t('Видалити це згенероване фото? Річ і її оригінальні фото залишаться.')} onConfirm={async () => { const ok = await act(() => api('DELETE', `/api/photos/${entry.p.id}`), t('Зображення прибрано')); if (ok !== undefined) onClose(); }}>
              <Trash2 size={13} />
            </ConfirmButton>}
            <span style={{ flex: 1 }} />
            {inspiration && <a className="btn sm" href={inspiration.sourceUrl} target="_blank" rel="noreferrer"><ExternalLink size={13} /> {t('Джерело')}</a>}
            {original && <a className="btn sm" href={media(photo.originalPath ?? photo.path)} download><Download size={13} /> {t('Оригінал')}</a>}
            {editable && <>
              <button className="quiet-toggle" disabled={saving || intakeBusy} onClick={() => void changePhoto(() => api('POST', `${photoEndpoint}/reanalyze`, { intent: 'garments' }), t('Розпізнаю речі на фото…'))}>{t('Розпізнати ще раз')}</button>
              {photo.archivedAt
                ? <button className="quiet-toggle" disabled={saving} onClick={() => void patchPhoto({ archived: false }, t('Повернуто'))}>{t('Відновити')}</button>
                : canArchive && <button className="quiet-toggle" disabled={saving} onClick={async () => {
                  const ok = await patchPhoto({ archived: true }, t('Фото архівовано'));
                  if (ok) onClose();
                }}>{t('Сховати')}</button>}
            </>}
            {!original && job && (
              <button className="btn sm" onClick={() => void act(() => api('POST', `/api/jobs/${job.id}/retry`, { run: true }), t('Роблю нове фото речі'))}>
                <RotateCcw size={13} /> {t('Нове фото')}
              </button>
            )}
            {item && <a className="btn sm primary" href={`/wardrobe/${item.id}`} onClick={onClose}>{t('Картка речі')}</a>}
          </div>
        </div>
      </div>
    </Overlay>
  );
}

export function GalleryPage() {
  const db = useDb();
  const { query } = useRoute();
  const [type, setType] = useState<'tryon' | 'packshot' | 'inspiration' | 'original' | 'face'>(query.get('type') === 'face' ? 'face' : query.get('type') === 'original' ? 'original' : query.get('type') === 'inspiration' ? 'inspiration' : query.get('type') === 'packshot' ? 'packshot' : 'tryon');
  // On a phone the tabs scroll sideways: the active one is always brought into view.
  useEffect(() => { document.querySelector('.toolbar .seg-scroll button.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [type]);
  const [tag, setTag] = useState('');
  const [filter, setFilter] = useState<'any' | 'fav'>('any');
  const [showArchived, setShowArchived] = useState(false);
  const [open, setOpen] = useState<Entry | null>(null);
  const all = useMemo(() => entries(db), [db]);
  const originals = all.flatMap((e) => e.kind === 'original' ? [e.p] : []);
  const activeOriginals = originals.filter((p) => !p.archivedAt);
  const archivedCount = originals.length - activeOriginals.length;
  const inArchive = showArchived && archivedCount > 0;
  useEffect(() => { if (archivedCount === 0) setShowArchived(false); }, [archivedCount]);
  const tags = [...new Set(all.flatMap((e) => e.kind === 'inspiration' ? e.p.inspiration?.tags ?? [] : []))].sort();
  const list = all.filter((e) => {
    if (type === 'face') return e.kind === 'original' && e.p.referenceRole === 'face' && !e.p.archivedAt;
    if (type === 'original') return e.kind === 'original' && Boolean(e.p.archivedAt) === inArchive;
    if (e.kind !== type) return false;
    if (type === 'inspiration' && tag && !(e.kind === 'inspiration' && e.p.inspiration?.tags.includes(tag))) return false;
    if (type === 'inspiration') return true;
    if (filter === 'any') return true;
    if (e.kind !== 'tryon') return false;
    if (filter === 'fav') return Boolean(db.looks.find((l) => l.id === e.r.lookId)?.favorite);
    return true;
  });
  const groups: [string, Entry[]][] = [];
  for (const e of list) {
    const k = dayKey(e.at);
    const g = groups.find((x) => x[0] === k);
    if (g) g[1].push(e);
    else groups.push([k, [e]]);
  }
  const counts = { tryon: all.filter((e) => e.kind === 'tryon').length, packshot: all.filter((e) => e.kind === 'packshot').length, inspiration: all.filter((e) => e.kind === 'inspiration').length, original: activeOriginals.length, face: activeOriginals.filter((p) => p.referenceRole === 'face').length };

  return (
    <div className="page">
      <PageHead title={t('Галерея')} />
      <div className="toolbar">
        <div className="seg seg-scroll">
          <button className={type === 'tryon' ? 'on' : ''} onClick={() => setType('tryon')}>{t('Примірки')} <span className="faint">{counts.tryon}</span></button>
          <button className={type === 'packshot' ? 'on' : ''} onClick={() => setType('packshot')}>{t('Фото речей')} <span className="faint">{counts.packshot}</span></button>
          <button className={type === 'original' ? 'on' : ''} onClick={() => setType('original')}>{t('Мої фото')} <span className="faint">{counts.original}</span></button>
          <button className={type === 'face' ? 'on' : ''} onClick={() => setType('face')}>{t('Обличчя')} <span className="faint">{counts.face}</span></button>
          <button className={type === 'inspiration' ? 'on' : ''} onClick={() => setType('inspiration')}>{t('Натхнення')} <span className="faint">{counts.inspiration}</span></button>
        </div>
      </div>
      {/* Quiet text filters on their own row under the tabs (owner, 20.11: elegant, and the tabs never move). */}
      {type === 'original' && archivedCount > 0 && (
        <div className="filters" role="group" aria-label={t('Мої фото')}>
          <button className={!inArchive ? 'on' : ''} aria-pressed={!inArchive} onClick={() => setShowArchived(false)}>{t('Усі')}</button>
          <button className={inArchive ? 'on' : ''} aria-pressed={inArchive} onClick={() => setShowArchived(true)}>{t('Архів')} <span className="faint">{archivedCount}</span></button>
        </div>
      )}
      {type === 'inspiration' && tags.length > 0 && (
        <div className="filters" role="group" aria-label={t('Тема натхнення')}>
          <button className={tag === '' ? 'on' : ''} aria-pressed={tag === ''} onClick={() => setTag('')}>{t('Усі теми')}</button>
          {tags.map((t) => <button key={t} className={tag === t ? 'on' : ''} aria-pressed={tag === t} onClick={() => setTag(t)}>{t}</button>)}
        </div>
      )}
      {type === 'tryon' && (
        <div className="filters" role="group" aria-label={t('Які примірки')}>
          <button className={filter === 'any' ? 'on' : ''} aria-pressed={filter === 'any'} onClick={() => setFilter('any')}>{t('Усі')}</button>
          <button className={filter === 'fav' ? 'on' : ''} aria-pressed={filter === 'fav'} onClick={() => setFilter('fav')}>{t('Подобаються')}</button>
        </div>
      )}
      {groups.length === 0 ? (
        <Empty icon={<Images />} title={t('Поки порожньо')} />
      ) : (
        groups.map(([day, es]) => (
          <section key={day}>
            <div className="eyebrow">{day}</div>
            <div className="gallery">
              {es.map((e) =>
                e.kind === 'tryon' ? (
                  <button key={e.r.id} className="gtile tryon" onClick={() => setOpen(e)}>
                    <img src={thumb(e.r.imagePath, 520)} alt="" loading="lazy" />
                    {db.looks.find((l) => l.id === e.r.lookId)?.favorite && <span className="tr liked-mark" aria-label={t('Подобається')}><ThumbsUp size={12} fill="currentColor" /></span>}
                    <span className="cap">{db.looks.find((l) => l.id === e.r.lookId)?.name}</span>
                  </button>
                ) : (
                  <button key={e.p.id} className="gtile contain" onClick={() => setOpen(e)}>
                    <img src={thumb(e.p.path, 520)} alt={e.p.inspiration?.title ?? ''} loading="lazy" />
                    <span className="cap">{e.p.inspiration?.title ?? db.items.find((i) => i.id === e.itemId)?.title ?? e.p.originalName}</span>
                  </button>
                ),
              )}
            </div>
          </section>
        ))
      )}
      {open && <Lightbox entry={open} onClose={() => setOpen((current) => current === open ? null : current)} />}
    </div>
  );
}
