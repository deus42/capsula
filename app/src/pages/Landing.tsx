import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { t } from '../i18n.ts';

/**
 * The page before sign-in: the wordmark, one line and «Продовжити з Google».
 * The beta is by invitation: an invite link opens this page with ?invite=1; without one a quiet line says so.
 */
export function Landing() {
  const params = new URLSearchParams(window.location.search);
  const invited = params.get('invite') === '1';
  const invalid = params.get('invite') === 'invalid';
  const testInvalid = params.get('test') === 'invalid';
  const failed = params.has('error');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');

  const signIn = async () => {
    setBusy(true);
    setProblem('');
    try {
      const res = await fetch('/api/auth/sign-in/social', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'google', callbackURL: '/', errorCallbackURL: '/' }),
      });
      const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (res.ok && data.url) return void (window.location.href = data.url);
      setBusy(false);
      setProblem(res.status === 429 && data.error ? t(data.error) : t('Не вдалося відкрити вхід через Google. Спробуй ще раз.'));
    } catch {
      setBusy(false);
      setProblem(t('Не вдалося відкрити вхід через Google. Спробуй ще раз.'));
    }
  };

  const note = problem || (testInvalid ? t('Це тестове посилання вже використане або застаріло.') : invalid ? t('Це запрошення вже використане або застаріло.') : failed ? t('Увійти не вдалося. Поки що Capsula відкрита за запрошенням.') : invited ? '' : t('Поки що за запрошенням.'));
  return (
    <main className="landing">
      <div className="landing-inner">
        <h1 className="landing-mark">Capsula</h1>
        <p className="landing-line">{t('Кілька речей. Багато образів. На тобі.')}</p>
        <button className="landing-google" onClick={() => void signIn()} disabled={busy} aria-busy={busy}>
          {busy ? <Loader2 size={16} className="spin" /> : <GoogleMark />}
          <span>{t('Продовжити з Google')}</span>
        </button>
        {note && <p className="landing-note">{note}</p>}
      </div>
      <footer className="landing-foot">
        <a href="https://github.com/deus42/capsula">{t('Код')}</a>
        <a href="/privacy">{t('Приватність')}</a>
        <a href="/terms">{t('Умови')}</a>
      </footer>
    </main>
  );
}

function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.2-.1-2.3-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.2-.1-2.3-.4-3.5z" />
    </svg>
  );
}
