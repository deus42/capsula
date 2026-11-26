import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AppState, Session } from './api.ts';
import { ApiError, getSession, getState, setUploadConversion } from './api.ts';
import { t } from './i18n.ts';

interface Ctx {
  state: AppState | null;
  /** Accounts mode: who is signed in; null while unknown. */
  session: Session | null;
  /** Accounts mode without a signed-in account: the landing page shows instead of the site. */
  signedOut: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** Runs a mutation, refreshes state and reports errors as a toast. */
  act: <T>(fn: () => Promise<T>, okMessage?: string) => Promise<T | undefined>;
  toast: (msg: string, bad?: boolean, href?: string) => void;
}

const AppCtx = createContext<Ctx | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [toastMsg, setToast] = useState<{ msg: string; bad: boolean; href?: string } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  // Accounts mode: the allowances in the session change as work is queued and finishes.
  const accounts = useRef(false);

  const toast = useCallback((msg: string, bad = false, href?: string) => {
    setToast({ msg, bad, href });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), bad || href ? 6000 : 2600);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [next, s] = await Promise.all([getState(), accounts.current ? getSession().catch(() => null) : null]);
      setState(next);
      if (s) setSession(s);
      setError(null);
      setSignedOut(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setSignedOut(true);
      else setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void getSession().then((s) => { accounts.current = s.mode === 'accounts'; setUploadConversion(accounts.current); setSession(s); }).catch(() => setSession({ mode: 'local', user: null }));
  }, []);

  const act = useCallback(
    async <T,>(fn: () => Promise<T>, okMessage?: string) => {
      try {
        const out = await fn();
        await refresh();
        if (okMessage) toast(okMessage);
        return out;
      } catch (e) {
        if (e instanceof ApiError && (e.status === 409 || e.status === 429)) await refresh();
        toast((e as Error).message, true);
        return undefined;
      }
    },
    [refresh, toast],
  );

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  // Queued work counts too: between two chained jobs (photo → item picture → advisor) nothing runs for a moment.
  // Try-ons are left out: they can wait for the owner for a long time.
  const busy = Boolean(state?.runner.running || state?.db.jobs.some((j) => j.state === 'running' || (j.state === 'queued' && j.kind !== 'tryon')));
  useEffect(() => {
    if (!busy) return;
    const id = window.setInterval(() => void refresh(), 2500);
    return () => window.clearInterval(id);
  }, [busy, refresh]);

  // Where an uploaded photo went (criterion 7): said once, as a toast with a link, when its recognition finishes.
  const uploads = useRef(new Set<string>());
  useEffect(() => {
    if (!state) return;
    const notes: string[] = [];
    let href: string | undefined;
    let bad = false;
    for (const j of state.db.jobs) {
      // A search for new looks says how it went, with a link to «Нові» (owner, 19.11).
      if (j.kind === 'discover') {
        if (j.state === 'queued' || j.state === 'running') uploads.current.add(j.id);
        else if (uploads.current.delete(j.id)) {
          notes.push(t(j.stateNote ?? 'Пошук завершено'));
          href ??= '/capsules?tab=new';
          bad ||= j.state === 'error';
        }
        continue;
      }
      if (j.kind !== 'intake') continue;
      if (j.state === 'queued' || j.state === 'running') uploads.current.add(j.id);
      else if (uploads.current.delete(j.id)) {
        const created = (j.createdItemIds ?? []).map((id) => state.db.items.find((i) => i.id === id)?.title).filter(Boolean);
        const rest = (j.stateNote ?? '').split(' · ').filter((x) => x && !(created.length && x.startsWith('нових речей')));
        const parts = [...(created.length ? [`${created.length === 1 ? t('нова річ') : t('нові речі')}: ${created.map((x) => `«${x}»`).join(', ')}`] : []), ...rest.map((x) => t(x))];
        if (parts.length) notes.push(parts.join(' · '));
        href ??= [...(j.createdItemIds ?? []), ...(j.attachedItemIds ?? [])].map((id) => `/wardrobe/${id}`)[0];
        bad ||= j.state === 'error';
      }
    }
    if (notes.length) {
      const msg = notes.join(' · ');
      toast(href === '/capsules?tab=new' ? msg : `${t('Фото')}: ${msg}`, bad, href);
    }
  }, [state, toast]);

  const value = useMemo(() => ({ state, session, signedOut, error, refresh, act, toast }), [state, session, signedOut, error, refresh, act, toast]);
  return (
    <AppCtx.Provider value={value}>
      {children}
      {toastMsg && (toastMsg.href
        ? <a className={`toast${toastMsg.bad ? ' bad' : ''}`} role="status" href={toastMsg.href}>{toastMsg.msg}</a>
        : <div className={`toast${toastMsg.bad ? ' bad' : ''}`} role="status">{toastMsg.msg}</div>)}
    </AppCtx.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppCtx);
  if (!ctx) throw new Error('useApp outside provider');
  return ctx;
}

export function useDb() {
  const { state } = useApp();
  return state!.db;
}

const ROUTE_EVENT = 'capsula:route';

/**
 * Clean addresses (/capsules/C-1, /looks/L-1). Old #/ links still work: they
 * are rewritten to the clean address on arrival.
 */
function currentRoute() {
  const h = window.location.hash;
  if (h.startsWith('#/')) window.history.replaceState(null, '', h.slice(1));
  const p = window.location.pathname + window.location.search;
  return p === '/' ? '/home' : p;
}

export function useRoute() {
  const [route, setRoute] = useState(currentRoute);
  useEffect(() => {
    const on = () => setRoute(currentRoute());
    window.addEventListener('popstate', on);
    window.addEventListener('hashchange', on);
    window.addEventListener(ROUTE_EVENT, on);
    return () => {
      window.removeEventListener('popstate', on);
      window.removeEventListener('hashchange', on);
      window.removeEventListener(ROUTE_EVENT, on);
    };
  }, []);
  const [pathPart, query = ''] = route.split('?');
  return { parts: pathPart.split('/').filter(Boolean), query: new URLSearchParams(query) };
}

export function go(path: string, replace = false, keepScroll = false) {
  const to = path.startsWith('#') ? path.slice(1) : path;
  const from = window.location.pathname;
  if (to === from + window.location.search) return;
  window.history[replace ? 'replaceState' : 'pushState'](null, '', to);
  if (!keepScroll && to.split('?')[0] !== from) window.scrollTo(0, 0);
  window.dispatchEvent(new Event(ROUTE_EVENT));
}

// In-app links navigate without reloading; files, the API and new tabs are left alone.
document.addEventListener('click', (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = (e.target as Element | null)?.closest?.('a');
  if (!a || a.target || a.hasAttribute('download')) return;
  const href = a.getAttribute('href') ?? '';
  if (!(href.startsWith('#/') || (href.startsWith('/') && !href.startsWith('//') && !/^\/(api|media|thumb|assets)\//.test(href)))) return;
  e.preventDefault();
  go(href);
});
