import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import type { Suggestion } from '../api.ts';
import { api } from '../api.ts';
import { go, useApp, useDb } from '../store.tsx';
import { Composer, Empty, LookCollage } from '../components/ui.tsx';
import { openSuggestions } from '../lib.ts';
import { isCapsuleHidden } from '../rating.ts';
import { LOOKS, plural, t } from '../i18n.ts';

/**
 * «Нові» (owner, 19.11; spec 2026-11-19-fashion-capsules-design.md, part 6): one line «Що шукаємо?», an optional
 * capsule, and the results as cards «Ні / Додати». Pieces to buy become purchases only on «Додати»; a try-on only on ⟳.
 * `?item=<id>` (an item's «Підібрати образи з нею», owner 24.11) shows only the proposals with that piece.
 */
export function NewLooks() {
  const db = useDb();
  const { act } = useApp();
  const [text, setText] = useState('');
  const [capsuleId, setCapsuleId] = useState('');
  const capsules = db.capsules.filter((c) => !c.redirectCapsuleIds && c.kind !== 'selection' && !isCapsuleHidden(db, c));
  const job = db.jobs.find((j) => j.kind === 'discover' && j.state === 'running') ?? db.jobs.find((j) => j.kind === 'discover' && j.state === 'queued');
  const itemId = new URLSearchParams(window.location.search).get('item');
  const pinned = itemId ? db.items.find((i) => i.id === itemId) : undefined;
  const withPinned = (s: Suggestion) => s.looks.some((l) => Object.values(l.slots).some((refs) => refs?.some((r) => r.kind === 'item' && r.id === itemId)));
  // The newest first: what a search just found comes before older proposals.
  const list = [...openSuggestions(db)].filter((s) => !pinned || withPinned(s)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const search = async () => {
    const ok = await act(() => api('POST', '/api/discover', { prompt: text, capsuleId }), t('Шукаю нові образи'));
    if (ok) setText('');
  };
  return (
    <>
      <Composer className="new-search" value={text} onChange={setText} onSend={() => void search()} busy={Boolean(job)} label={t('Шукати')} placeholder={t('Що шукаємо? Напр.: пальто на прогулянку, вечеря в місті')}>
        <select className="composer-pick" value={capsuleId} onChange={(e) => setCapsuleId(e.target.value)} aria-label={t('Капсула')}>
          <option value="">{t('Усі капсули')}</option>
          {capsules.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </Composer>
      {pinned && (
        <div className="section-head">
          <h2 className="h2">{t('З «{title}»', { title: pinned.title })} <span className="count">{list.length}</span></h2>
          <a href="/capsules?tab=new">{t('Усі нові')}</a>
        </div>
      )}
      {list.length ? (
        <div className="look-grid">{list.map((s) => <NewCard key={s.id} s={s} />)}</div>
      ) : (
        <Empty icon={<Sparkles />} title={t('Нових образів ще немає')} />
      )}
    </>
  );
}

function NewCard({ s }: { s: Suggestion }) {
  const db = useDb();
  const { act } = useApp();
  const look = s.looks[0];
  const capsule = db.capsules.find((c) => c.id === s.capsuleId);
  const buy = s.looks.flatMap((l) => l.buy ?? []);
  // A purchase that replaces a piece of the capsule's set (owner, 20.11) says which one.
  const replacedTitle = (key: string) => {
    const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    return (kind === 'item' ? db.items.find((i) => i.id === id)?.title : db.needs.find((n) => n.id === id)?.title) ?? id;
  };
  const add = async () => {
    const r = await act(() => api<{ href: string }>('POST', `/api/suggestions/${s.id}/accept`), t('Додано'));
    if (r?.href) go(r.href);
  };
  return (
    <div className="look-card new-card">
      <div className="cover" style={{ aspectRatio: '3 / 4' }}><LookCollage slots={look.slots} max={5} /></div>
      <div>
        <span className="eyebrow-sm best-mark">{s.kind === 'capsule' ? `${t('Нова капсула')} · ${plural(s.looks.length, LOOKS)}` : capsule?.name ?? t('Новий образ')}</span>
        <h4>{s.name}</h4>
        {s.why && <span className="miss">{s.why}</span>}
        {buy.length > 0 && <span className="miss">{t('докупити')}: {buy.map((b) => b.replaces ? t('{title} замість «{old}»', { title: b.title, old: replacedTitle(b.replaces) }) : b.title).join(', ')}</span>}
      </div>
      <div className="card-foot">
        <button className="btn sm" onClick={() => void act(() => api('POST', `/api/suggestions/${s.id}/reject`))}>{t('Ні')}</button>
        <button className="btn sm primary" onClick={() => void add()}>{t('Додати')}</button>
      </div>
    </div>
  );
}
