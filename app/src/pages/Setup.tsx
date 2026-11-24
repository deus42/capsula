import { useEffect, useMemo, useRef, useState } from 'react';
import { Camera, Check, CheckCheck, RefreshCw, ShoppingBag, Sparkles, Star, Upload, X } from 'lucide-react';
import type { CapsuleDraft, CapsuleMatchDraft, Category, Job, Look, Period } from '../api.ts';
import { api, media, quotaNote, thumb, uploadFile } from '../api.ts';
import { go, useApp, useDb } from '../store.tsx';
import { Badge, CategoryIcon, Composer, ConfirmButton, Empty, JobBar, LookArt, LookCollage } from '../components/ui.tsx';
import {
  CATEGORY_LABEL, PERIOD_LABEL, SEASON_LABEL, capsuleLooks, currentCover, distinctLooks,
  isBlockedEyewear, openSuggestions, periodLine, purchaseRanking, scoreLabel,
} from '../lib.ts';
import { MAX_BASE_PIECES, capsuleCombinations, capsuleLimits, capsuleSet, fashionCapsules, pieceGroup, type PieceGroup } from '../capsule-pieces.ts';
import { STYLE_CATALOGUE, stylePieces } from '../style-catalogue.ts';
import { LOOKS, currentLanguage, plural, t } from '../i18n.ts';

type Step = 1 | 2 | 3 | 4 | 5;
const PERIODS: Period[] = ['spring', 'summer', 'early-autumn', 'late-autumn', 'winter'];
const STEPS: { n: Step; label: string }[] = [
  { n: 1, label: 'Опора' },
  { n: 2, label: 'Капсули' },
  { n: 3, label: 'Гардероб' },
  { n: 4, label: 'Набори' },
  { n: 5, label: 'Образи' },
];

/** Quiet photo uploader box for Step 1 (face or full-body original). */
function PhotoSlot({
  title,
  hint,
  role,
  photoId,
  onPick,
}: {
  title: string;
  hint: string;
  role: 'face' | 'body';
  photoId: string;
  onPick: (id: string) => void;
}) {
  const db = useDb();
  const { act } = useApp();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const photo = db.photos.find((p) => p.id === photoId && !p.archivedAt);
  const candidates = db.photos.filter((p) => !p.archivedAt && p.source !== 'generated' && !p.inspiration && p.kind !== 'worn' && p.kind !== 'label');

  const handleFile = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setBusy(true);
    const params: Record<string, string> = role === 'face' ? { kind: 'base', role: 'face' } : { kind: 'base' };
    const saved = await act(() => uploadFile(file, params), t('Фото завантажено'));
    if (saved) onPick(saved.id);
    setBusy(false);
    if (input.current) input.current.value = '';
  };

  return (
    <div className="setup-slot">
      <div className="setup-slot-head">
        <b>{t(title)}</b>
        {photo && (
          <button type="button" className="link-quiet small" onClick={() => input.current?.click()} disabled={busy}>
            {t('Замінити')}
          </button>
        )}
      </div>
      <p className="small muted">{t(hint)}</p>
      {photo ? (
        <div className="setup-slot-preview">
          <img src={thumb(photo.path, 480)} alt={t(title)} />
          {photo.meetsStandard === false && (
            <span className="setup-slot-warn">{photo.note || t('Не за стандартом — краще рівне світло без дзеркала')}</span>
          )}
        </div>
      ) : (
        <button type="button" className="dropzone setup-drop" onClick={() => input.current?.click()} disabled={busy}>
          <Camera size={20} style={{ margin: '0 auto 6px' }} />
          <span>{busy ? t('Завантажую…') : t('Вибрати фото')}</span>
        </button>
      )}
      {candidates.length > 0 && !photo && (
        <select className="select setup-pick-existing" value="" onChange={(e) => e.target.value && onPick(e.target.value)} aria-label={t('Вибрати з наявних')}>
          <option value="">{t('Або вибрати з наявних…')}</option>
          {candidates.slice(-15).reverse().map((p) => (
            <option key={p.id} value={p.id}>{p.originalName}</option>
          ))}
        </select>
      )}
      <input ref={input} type="file" accept="image/*,.heic,.heif" hidden onChange={(e) => void handleFile(e.target.files)} />
    </div>
  );
}

/** Step 1: Identity reference preparation + side-by-side «Це я?» review. */
function StepIdentity({ onNext }: { onNext: () => void }) {
  const db = useDb();
  const { act, session } = useApp();
  const draft = db.onboarding?.identityDraft;
  const approved = db.profile.identity;
  const activePhotos = db.photos.filter((p) => !p.archivedAt);
  const isActive = (id?: string) => activePhotos.some((p) => p.id === id);
  const defaultFace = [draft?.sourcePhotoId, approved?.sourcePhotoId, activePhotos.find((p) => p.referenceRole === 'face')?.id, ...db.profile.basePhotoIds].find(isActive) ?? '';
  const defaultBody = [draft?.bodyPhotoId, activePhotos.find((p) => p.path === approved?.bodyOriginal?.path)?.id, ...db.profile.basePhotoIds.filter((id) => id !== defaultFace)].find(isActive) ?? '';
  const [pickedFaceId, setFaceId] = useState(defaultFace);
  const [pickedBodyId, setBodyId] = useState(defaultBody);
  const faceId = isActive(pickedFaceId) ? pickedFaceId : defaultFace;
  const bodyId = isActive(pickedBodyId) ? pickedBodyId : defaultBody;
  const [noGlasses, setNoGlasses] = useState(draft ? draft.noGlasses : !db.profile.allowEyewear);
  const [hairstyle, setHairstyle] = useState(draft?.hairstyle ?? approved?.hairstyle ?? '');
  const [redoNote, setRedoNote] = useState('');
  const [editing, setEditing] = useState(!approved);

  const job = db.jobs.filter((j) => j.kind === 'identity_prep').at(-1);
  const busy = job?.state === 'queued' || job?.state === 'running';
  const limit = quotaNote(session, 'tryon');

  const prepare = (instructions = '') =>
    act(
      () => api<Job>('POST', '/api/identity/prepare', { facePhotoId: faceId, bodyPhotoId: bodyId || faceId, noGlasses, hairstyle, instructions }),
      t('Готую базову опору'),
    );

  const approve = async () => {
    const ok = await act(() => api('POST', '/api/identity/approve'), t('Опору збережено'));
    if (ok) {
      setEditing(false);
      onNext();
    }
  };

  return (
    <section className="setup-section">
      <div className="setup-head">
        <h2>{t('Опора для примірок')}</h2>
        <p className="muted">{t('Обличчя і статура беруться лише з твоїх фото. Ми підготуємо чистий студійний портрет і перевіримо його разом із тобою.')}</p>
      </div>

      {approved && !draft && !editing && (
        <div className="setup-approved-box">
          <div className="setup-compare">
            <figure>
              <a className="cover" href={media(approved.face.path)} target="_blank" rel="noreferrer">
                <img src={thumb(approved.face.path, 600)} alt={t('Схвалений портрет')} />
              </a>
              <figcaption>{t('Схвалений портрет')}</figcaption>
            </figure>
            <figure>
              <a className="cover" href={media(approved.body.path)} target="_blank" rel="noreferrer">
                <img src={thumb(approved.body.path, 600)} alt={t('Опора статури')} />
              </a>
              <figcaption>{t('Опора статури')}</figcaption>
            </figure>
          </div>
          <div className="setup-actions">
            <button type="button" className="btn" onClick={() => setEditing(true)}>{t('Оновити опору')}</button>
            <button type="button" className="btn primary" onClick={onNext}>{t('Далі: капсули')}</button>
          </div>
        </div>
      )}

      {draft && (
        <div className="setup-review-box">
          <div className="setup-compare three">
            <figure>
              <a className="cover" href={media(draft.original.path)} target="_blank" rel="noreferrer">
                <img src={thumb(draft.original.path, 600)} alt={t('Оригінал')} />
              </a>
              <figcaption>{t('Твоє фото')}</figcaption>
            </figure>
            <figure>
              <a className="cover" href={media(draft.face.path)} target="_blank" rel="noreferrer">
                <img src={thumb(draft.face.path, 600)} alt={t('Базовий портрет')} />
              </a>
              <figcaption>{t('Базовий портрет')}</figcaption>
            </figure>
            <figure>
              <a className="cover" href={media(draft.body.path)} target="_blank" rel="noreferrer">
                <img src={thumb(draft.body.path, 600)} alt={t('Опора статури')} />
              </a>
              <figcaption>{t('Статура (без обличчя)')}</figcaption>
            </figure>
          </div>
          {draft.notes && <p className="small muted">{draft.notes}</p>}
          <div className="setup-review-bar">
            <span className="setup-ask">{t('Це я?')}</span>
            <button type="button" className="btn primary" disabled={busy} onClick={() => void approve()}>
              <Check size={14} /> {t('Так, зберегти опору')}
            </button>
            <button type="button" className="btn" disabled={busy || Boolean(limit)} onClick={() => void prepare(redoNote)}>
              <RefreshCw size={14} /> {t('Переробити')}
            </button>
            <button type="button" className="btn ghost" disabled={busy} onClick={() => void act(() => api('DELETE', '/api/identity/draft'))}>
              {t('Замінити фото')}
            </button>
          </div>
          <input
            className="input"
            value={redoNote}
            onChange={(e) => setRedoNote(e.target.value)}
            placeholder={t('Що підправити при переробці (необовʼязково): напр. риси обличчя, зачіска')}
          />
          {busy && job && <JobBar job={job} label />}
          {job?.state === 'error' && !busy && <p className="miss" role="status">{t(job.stateNote ?? 'Не вдалося підготувати опору')}</p>}
          {limit && <p className="miss" role="status">{limit}</p>}
        </div>
      )}

      {!draft && (editing || !approved) && (
        <>
          <div className="setup-slots">
            <PhotoSlot
              title="Фото обличчя"
              hint="Спереду, рівне денне світло, без темних окулярів і тіней."
              role="face"
              photoId={faceId}
              onPick={setFaceId}
            />
            <PhotoSlot
              title="Фото в повний зріст"
              hint="Камера на рівні грудей, не дзеркальне селфі, видно від голови до взуття."
              role="body"
              photoId={bodyId}
              onPick={setBodyId}
            />
          </div>

          <div className="setup-opts">
            <div className="pref-row">
              <span>{t('Окуляри на примірках')}</span>
              <div className="filters start">
                <button type="button" className={noGlasses ? 'on' : ''} aria-pressed={noGlasses} onClick={() => setNoGlasses(true)}>{t('Ні')}</button>
                <button type="button" className={!noGlasses ? 'on' : ''} aria-pressed={!noGlasses} onClick={() => setNoGlasses(false)}>{t('Так')}</button>
              </div>
            </div>
            <label className="field">
              <span>{t('Зачіска (необовʼязково)')}</span>
              <input className="input" value={hairstyle} onChange={(e) => setHairstyle(e.target.value)} placeholder={t('напр. як на фото, волосся прибране назад')} />
            </label>
          </div>

          {busy && job && <JobBar job={job} label />}
          {job?.state === 'error' && !busy && <p className="miss" role="status">{t(job.stateNote ?? 'Не вдалося підготувати опору')}</p>}
          {limit && <p className="miss" role="status">{limit}</p>}

          <div className="setup-actions">
            <button type="button" className="btn primary" disabled={!faceId || !bodyId || busy || Boolean(limit)} onClick={() => void prepare()}>
              <Sparkles size={14} /> {t('Зібрати опору')}
            </button>
            <button type="button" className="btn ghost" onClick={onNext}>{t('Пропустити поки що')}</button>
          </div>
        </>
      )}
    </section>
  );
}

/** Step 2: Prompt-driven capsule planning + catalogue picks + human review. */
function StepCapsules({ onNext }: { onNext: () => void }) {
  const db = useDb();
  const { act, session } = useApp();
  const lang = currentLanguage();
  const existing = fashionCapsules(db);
  const [prompt, setPrompt] = useState(db.onboarding?.capsulePrompt ?? '');
  const [drafts, setDrafts] = useState<CapsuleDraft[]>(db.onboarding?.capsuleDrafts ?? []);
  const draftKey = (db.onboarding?.capsuleDrafts ?? []).map((d) => d.id).join(',');

  useEffect(() => {
    setDrafts(db.onboarding?.capsuleDrafts ?? []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]);

  const job = db.jobs.filter((j) => j.kind === 'capsule_plan').at(-1);
  const busy = job?.state === 'queued' || job?.state === 'running';
  const limit = quotaNote(session, 'styling');

  const plan = async () => {
    if (!prompt.trim()) return;
    await act(() => api('POST', '/api/onboarding/plan-capsules', { prompt }), t('Підбираю капсули'));
  };

  const selected = drafts.filter((d) => d.selected);
  const commit = async () => {
    const ok = await act(
      () => api('POST', '/api/onboarding/approve-capsules', { capsules: selected }),
      t('Капсули збережено'),
    );
    if (ok) onNext();
  };

  const updateDraft = (id: string, patch: Partial<CapsuleDraft>) =>
    setDrafts((list) => list.map((d) => (d.id === id ? { ...d, ...patch } : d)));

  const togglePeriod = (d: CapsuleDraft, p: Period) => {
    const has = d.periods.includes(p);
    const next = has ? d.periods.filter((x) => x !== p) : [...d.periods, p];
    if (next.length) updateDraft(d.id, { periods: next });
  };

  const starters = [
    'Офіс без суворого дрес-коду, прогулянки містом і вечері в ресторані',
    'Спокійний мінімалізм у натуральних тканинах на весну, осінь і зиму',
    'Поїздки, прогулянки біля моря й розслаблені вихідні',
  ];
  const takenNames = new Set(existing.map((c) => c.name));
  const catalogue = STYLE_CATALOGUE.filter((s) => !takenNames.has(s.name));

  return (
    <section className="setup-section">
      <div className="setup-head">
        <h2>{t('Твої капсули')}</h2>
        <p className="muted">{t('Капсула — це окремий стиль із закритим набором речей, які поєднуються між собою. Опиши свій ритм або вибери готові стилі.')}</p>
      </div>

      <Composer
        className="setup-composer"
        value={prompt}
        onChange={setPrompt}
        onSend={() => void plan()}
        busy={busy}
        label={t('Запропонувати капсули')}
        placeholder={t('Опиши свій стиль, ритм тижня, клімат і улюблені кольори…')}
      />
      <div className="setup-chips">
        {starters.map((s) => (
          <button key={s} type="button" className="setup-chip" onClick={() => setPrompt(t(s))}>{t(s)}</button>
        ))}
      </div>

      {busy && job && <JobBar job={job} label />}
      {job?.state === 'error' && !busy && <p className="miss" role="status">{t(job.stateNote ?? 'Не вдалося підібрати капсули')}</p>}
      {limit && <p className="miss" role="status">{limit}</p>}

      {drafts.length > 0 && (
        <div className="setup-block">
          <div className="section-head" style={{ marginTop: 0 }}>
            <h3 className="h2">{t('Пропозиції стиліста')} <span className="count">{selected.length}/{drafts.length}</span></h3>
          </div>
          <div className="setup-draft-grid">
            {drafts.map((d) => (
              <article key={d.id} className={`setup-draft${d.selected ? '' : ' off'}`}>
                <div className="setup-draft-top">
                  <input
                    className="setup-draft-name"
                    value={d.name}
                    onChange={(e) => updateDraft(d.id, { name: e.target.value })}
                    aria-label={t('Назва')}
                  />
                  <button
                    type="button"
                    className={`btn sm${d.selected ? ' primary' : ''}`}
                    onClick={() => updateDraft(d.id, { selected: !d.selected })}
                  >
                    {d.selected ? <><Check size={13} /> {t('Беру')}</> : t('Прибрано')}
                  </button>
                </div>
                <div className="filters start">
                  {PERIODS.map((p) => (
                    <button key={p} type="button" className={d.periods.includes(p) ? 'on' : ''} onClick={() => togglePeriod(d, p)}>
                      {t(PERIOD_LABEL[p])}
                    </button>
                  ))}
                </div>
                <textarea
                  className="textarea setup-draft-desc"
                  value={d.description}
                  onChange={(e) => updateDraft(d.id, { description: e.target.value })}
                  rows={3}
                />
                {d.keyPieces.length > 0 && (
                  <p className="small muted">{d.keyPieces.join(' · ')}</p>
                )}
              </article>
            ))}
          </div>
          <div className="setup-actions">
            <button type="button" className="btn primary" disabled={!selected.length} onClick={() => void commit()}>
              <Check size={14} /> {t('Затвердити капсули')} ({selected.length})
            </button>
          </div>
        </div>
      )}

      {existing.length > 0 && (
        <div className="setup-block">
          <div className="section-head" style={{ marginTop: 0 }}>
            <h3 className="h2">{t('Твої активні капсули')} <span className="count">{existing.length}</span></h3>
          </div>
          <div className="setup-existing-caps">
            {existing.map((c) => (
              <div key={c.id} className="setup-cap-pill">
                <b>{c.name}</b>
                <span className="small muted">{c.periods?.length ? periodLine(c) : t(SEASON_LABEL[c.season])}</span>
              </div>
            ))}
          </div>
          <div className="setup-actions">
            <button type="button" className="btn primary" onClick={onNext}>{t('Далі: гардероб')}</button>
          </div>
        </div>
      )}

      {catalogue.length > 0 && (
        <div className="setup-block">
          <div className="section-head" style={{ marginTop: 0 }}>
            <h3 className="h2">{t('Або додай із каталогу стилів')}</h3>
          </div>
          <div className="home-caps">
            {catalogue.slice(0, 6).map((s) => (
              <div key={s.id} className="capsule-card style-card">
                <div>
                  <span className="eyebrow-sm tile-period">{periodLine({ periods: s.periods })}</span>
                  <h3>{s.name}</h3>
                  <p className="style-idea">{s.idea[lang]}</p>
                  <p className="style-pieces">{stylePieces(s, db.profile.wardrobeFocus).slice(0, 5).map((x) => x[lang]).join(' · ')}</p>
                </div>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => void act(() => api('POST', '/api/capsules/from-style', { styleId: s.id }), t('Капсулу додано'))}
                >
                  {t('Додати')}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

/** Step 3: Batch wardrobe upload + live digitization status + inline triage. */
function StepWardrobe({ onNext }: { onNext: () => void }) {
  const db = useDb();
  const { act } = useApp();
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const intakePending = db.jobs.filter((j) => j.kind === 'intake' && (j.state === 'queued' || j.state === 'running')).length;
  const packshotPending = db.jobs.filter((j) => j.kind === 'packshot' && (j.state === 'queued' || j.state === 'running')).length;
  const activeItems = db.items.filter((i) => !i.mergedInto && i.status !== 'inactive');
  const pendingItems = activeItems.filter((i) => i.status === 'needs_confirmation');
  const bulkConfirmIds = pendingItems.filter((i) => !i.possibleDuplicateOf).map((i) => i.id);
  const confirmedItems = activeItems.filter((i) => i.status === 'confirmed');

  const uploadBatch = async (files: FileList | null) => {
    const list = Array.from(files ?? []);
    if (!list.length) return;
    setUploading(true);
    await act(async () => {
      for (const f of list) await uploadFile(f, { kind: 'intake', batch: '1', intent: 'garments' });
    }, list.length > 1 ? t('Додано фото: {n}', { n: list.length }) : t('Фото додано'));
    setUploading(false);
    if (input.current) input.current.value = '';
  };

  const setStatus = (ids: string[], status: 'confirmed' | 'inactive') =>
    act(() => api('POST', '/api/items/batch-status', { ids, status }), status === 'confirmed' ? t('Підтверджено') : t('Прибрано в «Неактуальні»'));

  const confirmItem = (item: (typeof pendingItems)[number]) => item.possibleDuplicateOf
    ? act(() => api('PATCH', `/api/items/${item.id}`, { rev: item.rev, status: 'confirmed', clearDuplicate: true }), t('Підтверджено'))
    : setStatus([item.id], 'confirmed');

  const itemPhoto = (item: (typeof activeItems)[number]) => {
    const p = (item.packshotId && db.photos.find((x) => x.id === item.packshotId)) || item.photoIds.map((id) => db.photos.find((x) => x.id === id)).find(Boolean);
    return p?.path;
  };

  return (
    <section className="setup-section">
      <div className="setup-head">
        <h2>{t('Оцифруй свій гардероб')}</h2>
        <p className="muted">{t('Завантаж 5–20 фото речей (на собі, на вішалці, розкладених чи скріншоти замовлень). Ми розпізнаємо кожну річ і зробимо чисті каталожні фото.')}</p>
      </div>

      <button type="button" className="dropzone setup-batch-drop" onClick={() => input.current?.click()} disabled={uploading}>
        <Upload size={22} style={{ margin: '0 auto 8px' }} />
        <b>{uploading ? t('Завантажую фото…') : t('Завантажити фото речей')}</b>
        <span className="small muted">{t('Можна вибрати одразу багато фото — система опрацює їх по черзі')}</span>
      </button>
      <input ref={input} type="file" accept="image/*,.heic,.heif" multiple hidden onChange={(e) => void uploadBatch(e.target.files)} />

      {(intakePending > 0 || packshotPending > 0 || activeItems.length > 0) && (
        <p className="setup-status" role="status">
          {[
            intakePending > 0 && t('Розпізнаю фото: {n}', { n: intakePending }),
            packshotPending > 0 && t('Роблю каталожні фото: {n}', { n: packshotPending }),
            t('Речей у гардеробі: {n}', { n: activeItems.length }),
          ].filter(Boolean).join(' · ')}
        </p>
      )}

      {pendingItems.length > 0 && (
        <div className="setup-block">
          <div className="section-head" style={{ marginTop: 0 }}>
            <h3 className="h2">{t('Перевір розпізнані речі')} <span className="count">{pendingItems.length}</span></h3>
            {bulkConfirmIds.length > 0 && (
              <button type="button" className="btn sm primary" onClick={() => void setStatus(bulkConfirmIds, 'confirmed')}>
                <CheckCheck size={14} /> {t('Підтвердити всі')}
              </button>
            )}
          </div>
          <div className="setup-triage-grid">
            {pendingItems.map((it) => {
              const img = itemPhoto(it);
              const dupTarget = it.possibleDuplicateOf ? activeItems.find((x) => x.id === it.possibleDuplicateOf) : undefined;
              return (
                <div key={it.id} className="triage-card">
                  <a className="img" href={`/wardrobe/${it.id}`}>
                    {img ? <img src={thumb(img, 360)} alt={it.title} loading="lazy" /> : <span className="render-ph"><CategoryIcon category={it.category} size={22} /></span>}
                  </a>
                  <div className="triage-meta">
                    <a className="nm" href={`/wardrobe/${it.id}`}>{it.title}</a>
                    <span className="small muted">{t(CATEGORY_LABEL[it.category])}{it.color ? ` · ${it.color}` : ''}</span>
                  </div>
                  {dupTarget && (
                    <div className="triage-duplicate">
                      <Badge>{t('дублікат?')}</Badge>
                      <a className="small muted" href={`/wardrobe/${dupTarget.id}`}>{t('Можливо, це «{title}»', { title: dupTarget.title })}</a>
                    </div>
                  )}
                  <div className="triage-actions triage-review-actions">
                    {dupTarget ? (
                      <>
                        <button type="button" className="btn sm primary" onClick={() => void act(() => api('POST', `/api/items/${dupTarget.id}/absorb`, { sourceId: it.id }), t('Фото прикріплено'))}>
                          {t('Додати фото до «{title}»', { title: dupTarget.title })}
                        </button>
                        <button type="button" className="quiet-toggle" onClick={() => void confirmItem(it)}>{t('Окрема')}</button>
                      </>
                    ) : (
                      <button type="button" className="btn sm primary" onClick={() => void confirmItem(it)}><Check size={13} /> {t('Ношу')}</button>
                    )}
                    <button type="button" className="quiet-toggle" onClick={() => void setStatus([it.id], 'inactive')}>{t('Не ношу')}</button>
                    <ConfirmButton
                      className="quiet-toggle"
                      title={t('Видалити річ')}
                      message={t('Видалити «{title}» з гардероба? Фото-оригінали лишаться в архіві.', { title: it.title })}
                      onConfirm={() => act(() => api('DELETE', `/api/items/${it.id}`), t('Річ видалено'))}
                    >
                      {t('Не моя')}
                    </ConfirmButton>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {confirmedItems.length > 0 && (
        <div className="setup-block">
          <div className="section-head" style={{ marginTop: 0 }}>
            <h3 className="h2">{t('Підтверджені речі')} <span className="count">{confirmedItems.length}</span></h3>
          </div>
          <div className="ward-grid">
            {confirmedItems.map((it) => {
              const img = itemPhoto(it);
              return (
                <a key={it.id} className="wtile" href={`/wardrobe/${it.id}`}>
                  <span className="img">
                    {img ? <img src={thumb(img, 360)} alt={it.title} loading="lazy" /> : <span className="render-ph"><CategoryIcon category={it.category} size={22} /></span>}
                  </span>
                  <span className="nm">{it.title}</span>
                </a>
              );
            })}
          </div>
        </div>
      )}

      <div className="setup-actions">
        <button type="button" className="btn primary" disabled={!activeItems.length} onClick={onNext}>
          {t('Далі: розкласти по капсулах')}
        </button>
        {!activeItems.length && <button type="button" className="btn ghost" onClick={onNext}>{t('Пропустити поки що')}</button>}
      </div>
    </section>
  );
}

/** Step 4: AI wardrobe-to-capsule matching into closed sets + human review. */
function StepMatch({ onNext }: { onNext: () => void }) {
  const db = useDb();
  const { act, session } = useApp();
  const caps = fashionCapsules(db);
  const owned = db.items.filter((i) => i.status !== 'inactive' && !i.mergedInto && !isBlockedEyewear(db, i.title));
  const [drafts, setDrafts] = useState<CapsuleMatchDraft[]>(db.onboarding?.matchDrafts ?? []);
  const matchKey = (db.onboarding?.matchDrafts ?? []).map((d) => `${d.capsuleId}:${d.ownedItemIds.join('.')}:${d.missing.map((m) => m.id).join('.')}`).join('|');

  useEffect(() => {
    setDrafts(db.onboarding?.matchDrafts ?? []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchKey]);

  const job = db.jobs.filter((j) => j.kind === 'capsule_match').at(-1);
  const busy = job?.state === 'queued' || job?.state === 'running';
  const limit = quotaNote(session, 'styling');
  const alreadySaved = caps.length > 0 && caps.every((c) => Boolean(c.pieces));

  const runMatch = () => act(() => api('POST', '/api/onboarding/match-capsules', {}), t('Розкладаю гардероб по капсулах'));

  const countsOf = (d: CapsuleMatchDraft) => {
    const counts: Record<PieceGroup, number> = { garments: 0, shoes: 0, accessories: 0 };
    let tops = 0, layers = 0, bottoms = 0, shoes = 0, dresses = 0;
    const countCat = (cat: Category) => {
      counts[pieceGroup(cat)] += 1;
      if (cat === 'outerwear') layers += 1;
      else if (cat === 'dresses') dresses += 1;
      else if (cat === 'trousers' || cat === 'shorts' || cat === 'skirts') bottoms += 1;
      else if (cat === 'shoes') shoes += 1;
      else if (cat !== 'accessories') tops += 1;
    };
    for (const id of d.ownedItemIds) {
      const it = owned.find((x) => x.id === id);
      if (it) countCat(it.category);
    }
    for (const m of d.missing) if (m.selected) countCat(m.category);
    return { counts, combos: capsuleCombinations({ top: tops, layer: layers, bottom: bottoms, shoes, dresses }) };
  };

  const mutateDraft = (capsuleId: string, fn: (d: CapsuleMatchDraft) => CapsuleMatchDraft) =>
    setDrafts((list) => list.map((d) => (d.capsuleId === capsuleId ? fn(d) : d)));

  const toggleItem = (capsuleId: string, itemId: string) =>
    mutateDraft(capsuleId, (d) => {
      const has = d.ownedItemIds.includes(itemId);
      if (has) return { ...d, ownedItemIds: d.ownedItemIds.filter((x) => x !== itemId), baseItemIds: d.baseItemIds.filter((x) => x !== itemId) };
      const it = owned.find((x) => x.id === itemId);
      const cap = caps.find((c) => c.id === d.capsuleId);
      if (!it || !cap) return d;
      const limits = capsuleLimits(cap);
      const g = pieceGroup(it.category);
      if (countsOf(d).counts[g] >= limits[g]) return d;
      return { ...d, ownedItemIds: [...d.ownedItemIds, itemId] };
    });

  const toggleBase = (capsuleId: string, itemId: string) =>
    mutateDraft(capsuleId, (d) => {
      if (d.baseItemIds.includes(itemId)) return { ...d, baseItemIds: d.baseItemIds.filter((x) => x !== itemId) };
      if (d.baseItemIds.length >= MAX_BASE_PIECES) return d;
      return { ...d, baseItemIds: [...d.baseItemIds, itemId] };
    });

  const toggleMissing = (capsuleId: string, missId: string) =>
    mutateDraft(capsuleId, (d) => {
      const cap = caps.find((c) => c.id === d.capsuleId);
      const missing = d.missing.find((m) => m.id === missId);
      if (!cap || !missing) return d;
      const limits = capsuleLimits(cap);
      const g = pieceGroup(missing.category);
      if (!missing.selected && countsOf(d).counts[g] >= limits[g]) return d;
      return { ...d, missing: d.missing.map((m) => m.id === missId ? { ...m, selected: !m.selected } : m) };
    });

  const commit = async () => {
    const sets = drafts.map((d) => ({
      capsuleId: d.capsuleId,
      ownedItemIds: d.ownedItemIds,
      baseItemIds: d.baseItemIds,
      missing: d.missing.filter((m) => m.selected).map(({ title, category, priority, why }) => ({ title, category, priority, why })),
    }));
    const ok = await act(() => api('POST', '/api/onboarding/approve-sets', { sets }), t('Набори капсул затверджено'));
    if (ok) onNext();
  };

  const usedIds = useMemo(() => new Set(drafts.flatMap((d) => d.ownedItemIds)), [drafts]);
  const unmatched = owned.filter((i) => !usedIds.has(i.id));
  const photoOf = (id: string) => {
    const it = db.items.find((x) => x.id === id);
    if (!it) return undefined;
    return (it.packshotId && db.photos.find((p) => p.id === it.packshotId)?.path) || it.photoIds.map((pid) => db.photos.find((p) => p.id === pid)?.path).find(Boolean);
  };

  return (
    <section className="setup-section">
      <div className="setup-head">
        <h2>{t('Набори капсул')}</h2>
        <p className="muted">{t('До 10 речей одягу, 3 пар взуття й 3 аксесуарів. У мультиспортивних капсулах — до 4 аксесуарів.')}</p>
      </div>

      {(!caps.length || !owned.length) ? (
        <Empty icon={<Sparkles />} title={!caps.length ? t('Спершу додай капсули на кроці 2') : t('Спершу додай речі на кроці 3')} />
      ) : (
        <>
          <div className="setup-actions" style={{ marginTop: 0 }}>
            <button type="button" className="btn primary" disabled={busy || Boolean(limit)} onClick={() => void runMatch()}>
              <Sparkles size={14} /> {drafts.length || alreadySaved ? t('Перерозкласти гардероб') : t('Розкласти гардероб по капсулах')}
            </button>
            {alreadySaved && !drafts.length && (
              <button type="button" className="btn" onClick={onNext}>{t('Далі: образи')}</button>
            )}
          </div>

          {busy && job && <JobBar job={job} label />}
          {job?.state === 'error' && !busy && <p className="miss" role="status">{t(job.stateNote ?? 'Не вдалося зібрати набори')}</p>}
          {limit && <p className="miss" role="status">{limit}</p>}

          {drafts.map((d) => {
            const cap = caps.find((c) => c.id === d.capsuleId);
            if (!cap) return null;
            const limits = capsuleLimits(cap);
            const { counts, combos } = countsOf(d);
            const available = owned.filter((i) => !d.ownedItemIds.includes(i.id));
            return (
              <div key={d.capsuleId} className="setup-match-card">
                <div className="setup-match-head">
                  <div>
                    <h3>{cap.name}</h3>
                    {d.note && <p className="small muted">{d.note}</p>}
                  </div>
                  <span className="small muted">
                    {t('Одяг')} {counts.garments}/{limits.garments} · {t('Взуття')} {counts.shoes}/{limits.shoes} · {t('Аксесуари')} {counts.accessories}/{limits.accessories}
                    {combos > 0 ? ` · ~${combos} ${t('поєднань')}` : ''}
                  </span>
                </div>

                <div className="setup-triage-grid">
                  {d.ownedItemIds.map((id) => {
                    const it = owned.find((x) => x.id === id);
                    if (!it) return null;
                    const img = photoOf(id);
                    const isBase = d.baseItemIds.includes(id);
                    return (
                      <div key={id} className="triage-card">
                        <div className="img">
                          {img ? <img src={thumb(img, 360)} alt={it.title} loading="lazy" /> : <span className="render-ph"><CategoryIcon category={it.category} size={22} /></span>}
                        </div>
                        <div className="triage-meta">
                          <span className="nm">{it.title}</span>
                        </div>
                        <div className="triage-actions">
                          <button type="button" className={`btn sm${isBase ? ' primary' : ''}`} onClick={() => toggleBase(d.capsuleId, id)}>
                            <Star size={12} /> {t('База')}
                          </button>
                          <button type="button" className="btn sm ghost" onClick={() => toggleItem(d.capsuleId, id)} aria-label={t('Прибрати')}>
                            <X size={13} />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {available.length > 0 && (
                  <select className="select setup-add-item" value="" onChange={(e) => e.target.value && toggleItem(d.capsuleId, e.target.value)}>
                    <option value="">{t('+ Додати свою річ у цю капсулу…')}</option>
                    {available.map((i) => <option key={i.id} value={i.id}>{i.title} ({t(CATEGORY_LABEL[i.category])})</option>)}
                  </select>
                )}

                {d.missing.length > 0 && (
                  <div className="setup-missing-list">
                    <span className="eyebrow-sm">{t('Варто докупити')}</span>
                    {d.missing.map((m) => (
                      <label key={m.id} className={`setup-miss-row${m.selected ? '' : ' off'}`}>
                        <input type="checkbox" checked={m.selected} onChange={() => toggleMissing(d.capsuleId, m.id)} />
                        <span className="setup-miss-body">
                          <span className="setup-miss-head">
                            <b>{m.title}</b>
                            <Badge>{t(CATEGORY_LABEL[m.category])}</Badge>
                          </span>
                          {m.why && <span className="small muted">{m.why}</span>}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {drafts.length > 0 && unmatched.length > 0 && (
            <div className="setup-block">
              <span className="eyebrow-sm">{t('Поза капсулами')} ({unmatched.length})</span>
              <p className="small muted">{unmatched.map((i) => i.title).join(' · ')}</p>
            </div>
          )}

          {drafts.length > 0 && (
            <div className="setup-actions">
              <button type="button" className="btn primary" onClick={() => void commit()}>
                <Check size={14} /> {t('Затвердити набори')}
              </button>
            </div>
          )}

          {!drafts.length && alreadySaved && (
            <div className="setup-existing-caps">
              {caps.map((c) => {
                const s = capsuleSet(db, c);
                return (
                  <div key={c.id} className="setup-cap-pill">
                    <b>{c.name}</b>
                    <span className="small muted">{s.counts.garments} {t('одягу')} · {s.counts.shoes} {t('взуття')} · {s.counts.accessories} {t('акс.')}</span>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** Step 5: Discover first looks inside approved sets, run try-ons with «Це я?» review, and trigger first shop search. */
function StepActivate({ onFinish }: { onFinish: () => void }) {
  const db = useDb();
  const { act, session, toast } = useApp();
  const caps = fashionCapsules(db);
  const suggestions = openSuggestions(db);
  const looks = distinctLooks(db, capsuleLooks(db, caps.flatMap((c) => c.lookIds)));
  const discoverJob = db.jobs.filter((j) => j.kind === 'discover').at(-1);
  const discoverBusy = discoverJob?.state === 'queued' || discoverJob?.state === 'running';
  const tryonLimit = quotaNote(session, 'tryon');
  const stylingLimit = quotaNote(session, 'styling');
  const nextNeed = purchaseRanking(db)[0];
  const shopJob = nextNeed ? db.jobs.filter((j) => j.kind === 'shopsearch' && j.needId === nextNeed.need.id).at(-1) : undefined;
  const shopBusy = shopJob?.state === 'queued' || shopJob?.state === 'running';

  const discover = () => act(() => api('POST', '/api/discover', { prompt: '' }), t('Складаю образи в межах твоїх капсул'));

  const tryOn = async (look: Look) => {
    const job = await act(() => api<Job>('POST', '/api/jobs', { lookId: look.id, basePhotoIds: db.profile.basePhotoIds, instructions: '', run: true }));
    if (job?.state === 'needs_data') toast(t(job.stateNote ?? 'Зараз не вийде'), true);
  };

  const review = (resultId: string, ok: boolean) =>
    act(
      () => api('POST', `/api/results/${resultId}/review`, ok ? { decision: 'accepted' } : { decision: 'rework', reason: 'face' }),
      ok ? t('Прийнято') : t('Прибрано'),
    );

  return (
    <section className="setup-section">
      <div className="setup-head">
        <h2>{t('Перші образи й примірка')}</h2>
        <p className="muted">{t('Стиліст складе образи строго в межах затверджених наборів. Додай ті, що подобаються, і приміряй їх на своїй схваленій опорі.')}</p>
      </div>

      <div className="setup-actions" style={{ marginTop: 0 }}>
        <button type="button" className="btn primary" disabled={discoverBusy || !caps.length || Boolean(stylingLimit)} onClick={() => void discover()}>
          <Sparkles size={14} /> {t('Скласти перші образи')}
        </button>
      </div>

      {discoverBusy && discoverJob && <JobBar job={discoverJob} label />}
      {stylingLimit && <p className="miss" role="status">{stylingLimit}</p>}

      {suggestions.length > 0 && (
        <div className="setup-block">
          <div className="section-head" style={{ marginTop: 0 }}>
            <h3 className="h2">{t('Запропоновані образи')} <span className="count">{suggestions.length}</span></h3>
          </div>
          <div className="look-grid">
            {suggestions.map((s) => {
              const first = s.looks[0];
              const cap = db.capsules.find((c) => c.id === s.capsuleId);
              const buy = s.looks.flatMap((l) => l.buy ?? []);
              return (
                <div key={s.id} className="look-card new-card">
                  <div className="cover" style={{ aspectRatio: '3 / 4' }}><LookCollage slots={first.slots} max={5} /></div>
                  <div>
                    <span className="eyebrow-sm best-mark">{cap?.name ?? t('Новий образ')}</span>
                    <h4>{s.name}</h4>
                    {s.why && <span className="miss">{s.why}</span>}
                    {buy.length > 0 && <span className="miss">{t('докупити')}: {buy.map((b) => b.title).join(', ')}</span>}
                  </div>
                  <div className="card-foot">
                    <button type="button" className="btn sm" onClick={() => void act(() => api('POST', `/api/suggestions/${s.id}/reject`))}>{t('Ні')}</button>
                    <button type="button" className="btn sm primary" onClick={() => void act(() => api('POST', `/api/suggestions/${s.id}/accept`), t('Додано'))}>{t('Додати')}</button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {looks.length > 0 && (
        <div className="setup-block">
          <div className="section-head" style={{ marginTop: 0 }}>
            <h3 className="h2">{t('Твої образи')} <span className="count">{plural(looks.length, LOOKS)}</span></h3>
          </div>
          <div className="look-grid">
            {looks.slice(0, 6).map((l) => {
              const cover = currentCover(db, l);
              const job = db.jobs.filter((j) => (j.kind ?? 'tryon') === 'tryon' && j.lookId === l.id).at(-1);
              const busy = job?.state === 'queued' || job?.state === 'running';
              return (
                <div key={l.id} className="look-card">
                  <a className="cover" style={{ aspectRatio: '2 / 3' }} href={`/looks/${l.id}`}>
                    <LookArt look={l} busy={busy} label />
                  </a>
                  <a href={`/looks/${l.id}`}><h4>{l.name}</h4></a>
                  {job?.state === 'error' && !busy && <span className="miss">{t(job.stateNote ?? 'Зараз не вийде')}</span>}
                  {cover && cover.review === 'pending' && !busy ? (
                    <div className="update-ask">
                      <span>{t('Це я?')}</span>
                      <button type="button" className="btn sm" onClick={() => void review(cover.id, false)}>{t('Ні')}</button>
                      <button type="button" className="btn sm primary" onClick={() => void review(cover.id, true)}>{t('Так')}</button>
                    </div>
                  ) : (
                    <div className="card-foot">
                      <button type="button" className="btn sm" disabled={busy || Boolean(tryonLimit)} onClick={() => void tryOn(l)}>
                        <Sparkles size={13} /> {cover ? t('Переприміряти') : t('Приміряти на мені')}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {tryonLimit && <p className="miss" role="status">{tryonLimit}</p>}
        </div>
      )}

      {nextNeed && (
        <div className="setup-block setup-next-buy">
          <div>
            <span className="eyebrow-sm">{t('Наступна покупка')}</span>
            <h3>{nextNeed.need.title}</h3>
            {nextNeed.need.why && <p className="small muted">{nextNeed.need.why}</p>}
          </div>
          <div className="setup-actions" style={{ marginTop: 0 }}>
            <button
              type="button"
              className="btn"
              disabled={shopBusy || Boolean(stylingLimit)}
              onClick={() => void act(() => api('POST', `/api/needs/${nextNeed.need.id}/search`, {}), t('Шукаю в магазинах'))}
            >
              <ShoppingBag size={14} /> {t('Знайти в магазинах')}
            </button>
            <a className="btn ghost" href={`/shopping?need=${nextNeed.need.id}`}>{t('Покупки')}</a>
          </div>
          {shopBusy && shopJob && <JobBar job={shopJob} label />}
          {db.products.filter((p) => p.needId === nextNeed.need.id).length > 0 && (
            <p className="small muted">
              {t('Знайдено варіантів: {n}', { n: db.products.filter((p) => p.needId === nextNeed.need.id).length })}
              {db.products.find((p) => p.needId === nextNeed.need.id)?.matchScore !== undefined && ` · ${scoreLabel(db.products.find((p) => p.needId === nextNeed.need.id)!.matchScore!)}`}
            </p>
          )}
        </div>
      )}

      <div className="setup-actions">
        <button type="button" className="btn primary" onClick={onFinish}>
          <Check size={14} /> {t('Завершити налаштування')}
        </button>
      </div>
    </section>
  );
}

export function SetupPage() {
  const db = useDb();
  const { act } = useApp();
  const savedStep = db.onboarding?.step ?? (db.profile.identity ? (fashionCapsules(db).length ? 3 : 2) : 1);
  const [step, setStep] = useState<Step>(savedStep);

  const gotoStep = (n: Step) => {
    setStep(n);
    void api('PATCH', '/api/onboarding', { step: n }).catch(() => undefined);
  };

  const done: Record<Step, boolean> = {
    1: Boolean(db.profile.identity),
    2: fashionCapsules(db).length > 0,
    3: db.items.some((i) => i.status === 'confirmed' && !i.mergedInto),
    4: fashionCapsules(db).some((c) => Boolean(c.pieces)),
    5: db.looks.length > 0,
  };

  const finish = async () => {
    await act(() => api('PATCH', '/api/onboarding', { complete: true }));
    go('/home');
  };

  return (
    <div className="page setup-page">
      <div className="page-head">
        <div>
          <span className="eyebrow-sm">{t('Налаштування гардероба')}</span>
          <h1>{t('Крок {n} з 5', { n: step })}</h1>
        </div>
        <div className="actions">
          <button type="button" className="quiet-toggle" onClick={() => void finish()}>{t('Вийти в гардероб')}</button>
        </div>
      </div>

      <nav className="filters start setup-stepper" aria-label={t('Кроки налаштування')}>
        {STEPS.map((s) => (
          <button
            key={s.n}
            type="button"
            className={step === s.n ? 'on' : ''}
            aria-current={step === s.n ? 'step' : undefined}
            onClick={() => gotoStep(s.n)}
          >
            {done[s.n] ? '✓ ' : `${s.n}. `}{t(s.label)}
          </button>
        ))}
      </nav>

      {step === 1 && <StepIdentity onNext={() => gotoStep(2)} />}
      {step === 2 && <StepCapsules onNext={() => gotoStep(3)} />}
      {step === 3 && <StepWardrobe onNext={() => gotoStep(4)} />}
      {step === 4 && <StepMatch onNext={() => gotoStep(5)} />}
      {step === 5 && <StepActivate onFinish={() => void finish()} />}
    </div>
  );
}
