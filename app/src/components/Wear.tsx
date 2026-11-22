import { useEffect, useRef, useState } from 'react';
import { Camera, Loader2, Trash2 } from 'lucide-react';
import type { Look, Wear, WearCause, WearText } from '../api.ts';
import { api, media, quotaNote, thumb, uploadFile } from '../api.ts';
import { useApp, useDb } from '../store.tsx';
import { wearJob, wearPhotoPaths, wearRenderOf } from '../lib.ts';
import { ConfirmButton, JobBar } from './ui.tsx';
import { currentLanguage, t } from '../i18n.ts';

const MAX_PHOTOS = 6;
const CAUSE: Record<WearCause, string> = { outfit: 'у житті', render: 'рендер', substitution: 'заміна', unknown: 'неясно' };

/** One key per «Додати мій образ» action: a repeated request returns the same wear. */
const actionKey = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

/** The person's own photos of the look and, beside them, the render they were compared with. */
export function WearPair({ wear }: { wear: Wear }) {
  const db = useDb();
  const [first, ...otherPhotos] = wearPhotoPaths(db, wear);
  const render = wearRenderOf(db, wear);
  const original = (p: string) => (
    <a key={p} className="cover worn" href={media(p)} target="_blank" rel="noreferrer">
      <img src={thumb(p, 960)} alt={t('Мій образ')} />
    </a>
  );
  return (
    <div className="wear-pair">
      {first && original(first)}
      {render && (
        <figure>
          <a className="cover" href={media(render.imagePath)} target="_blank" rel="noreferrer">
            <img src={thumb(render.imagePath, 960)} alt={t('Рендер')} />
          </a>
          <figcaption>{t('Рендер')}</figcaption>
        </figure>
      )}
      {otherPhotos.length > 0 && <div className="wear-angles">{otherPhotos.map(original)}</div>}
    </div>
  );
}

/** The stylist's short read, the retry when it failed and the person's own «Одягну знову?». */
export function WearReview({ wear }: { wear: Wear }) {
  const db = useDb();
  const { act, session } = useApp();
  const job = wearJob(db, wear.id);
  const pending = job?.state === 'queued' || job?.state === 'running';
  const limit = quotaNote(session, 'styling');
  const text: WearText | undefined = wear.review && (currentLanguage() === 'en' ? wear.review.en : wear.review.uk);
  const compared = Boolean(wear.review?.resultId && wearRenderOf(db, wear));
  const differences = text?.differences.filter((d) => compared || d.cause !== 'render') ?? [];
  const answer = (again: boolean) => act(() => api('PATCH', `/api/wears/${wear.id}`, { again: wear.again === again ? null : again }));
  return (
    <div className="wear-review">
      {pending && job && <JobBar job={job} label />}
      {text && (
        <dl>
          <dt>{compared ? t('Збіглося') : t('На фото')}</dt>
          <dd>{text.seen}</dd>
          {differences.length > 0 && <>
            <dt>{t('Відрізняється')}</dt>
            {differences.map((d, i) => <dd key={i}>{d.text} <span className="cause">{t(CAUSE[d.cause])}</span></dd>)}
          </>}
          <dt>{t('Порада')}</dt>
          <dd>{text.adjust}</dd>
        </dl>
      )}
      {!text && !pending && (
        <p className="miss" role="status">
          {limit ?? (job ? t('Не вдалося розібрати фото') : t('Фото збережено'))}
          {!limit && <> · <button type="button" className="link-quiet" onClick={() => void act(() => api('POST', `/api/wears/${wear.id}/review`))}>{t('Ще раз')}</button></>}
        </p>
      )}
      <div className="wear-again">
        <span>{t('Одягну знову?')}</span>
        <button type="button" className={wear.again === true ? 'on' : ''} aria-pressed={wear.again === true} onClick={() => void answer(true)}>{t('Так')}</button>
        <button type="button" className={wear.again === false ? 'on' : ''} aria-pressed={wear.again === false} onClick={() => void answer(false)}>{t('Ні')}</button>
        {!pending && (
          <ConfirmButton
            className="wear-remove"
            title={t('Прибрати фото образу')}
            message={t('Прибрати ці фото з образу? Оригінали залишаться в «Мої фото».')}
            onConfirm={async () => { await act(() => api('DELETE', `/api/wears/${wear.id}`), t('Прибрано')); }}
          >
            <Trash2 size={13} />
          </ConfirmButton>
        )}
      </div>
    </div>
  );
}

/** «Додати мій образ»: one or more photos of one appearance, saved and read in one action. */
export function AddWear({ look }: { look: Look }) {
  const ref = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (location.hash === '#my-look') button.current?.scrollIntoView({ block: 'center' });
  }, [look.id]);
  const { act, toast } = useApp();
  const [busy, setBusy] = useState(false);
  const run = async (files: FileList | null) => {
    const list = Array.from(files ?? []);
    if (!list.length) return;
    if (list.length > MAX_PHOTOS) {
      toast(t('Додай від 1 до 6 власних фото образу'), true);
      if (ref.current) ref.current.value = '';
      return;
    }
    setBusy(true);
    const key = actionKey();
    await act(async () => {
      // One at a time: the same file is stored once, and a retry finds the photos already saved.
      const photoIds: string[] = [];
      for (const f of list) photoIds.push((await uploadFile(f, { kind: 'worn' })).id);
      const out = await api<{ note?: string }>('POST', `/api/looks/${look.id}/wears`, { photoIds, key, lookVersion: look.version });
      if (out.note) toast(t(out.note), true);
    });
    setBusy(false);
    if (ref.current) ref.current.value = '';
  };
  return (
    <>
      <button type="button" ref={button} id="my-look" className="wear-add" onClick={() => ref.current?.click()} disabled={busy}>
        {busy ? <Loader2 size={14} className="spin" /> : <Camera size={14} />}
        {t('Додати мій образ')}
      </button>
      <input ref={ref} type="file" accept="image/*,.heic,.heif" multiple hidden onChange={(e) => void run(e.target.files)} />
    </>
  );
}
