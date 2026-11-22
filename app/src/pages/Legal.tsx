/**
 * /privacy and /terms: one quiet page each, Ukrainian and English, open without signing in.
 * Facts here must match the running service: cookies (auth.ts, index.ts), the AI processor (capsula.fit runs Codex on
 * the owner's ChatGPT account with model training turned off; openai-engine.ts with an API key), deletion
 * (DELETE /api/account) and the backup retention set at deployment (7 daily and 4 weekly copies).
 */
type Lang = 'uk' | 'en';
interface Section { title: string; body: string[] }
interface Doc { title: string; updated: string; sections: Section[] }

const CONTACT = 'hello@capsula.fit';
const CONTROLLER = 'Oleksii Gapchenko';
const OPENAI_DATA = 'https://help.openai.com/en/articles/7730893-data-controls-faq';

const PRIVACY: Record<Lang, Doc> = {
  uk: {
    title: 'Приватність',
    updated: 'Оновлено 22 листопада 2026',
    sections: [
      { title: 'Що ми зберігаємо', body: [
        'Вхід через Google: ім’я, email і адресу фото профілю. Токенів доступу Google ми не зберігаємо.',
        'Те, що ти додаєш сам: фото себе й одягу, речі, капсули, образи, оцінки, мірки й побажання.',
        'Згенеровані зображення: примірки й каталожні фото речей.',
        'Місце — лише якщо ти натиснеш «Де шукати». Зберігаємо його округленим приблизно до 1 км.',
        'Скільки примірок і підборів ти використав цього місяця і скільки вони коштували.',
      ] },
      { title: 'Навіщо', body: [
        'Тільки щоб показувати твій гардероб, складати капсули й образи, шукати речі в магазинах і робити примірки.',
        'Обличчя й статура для примірок беруться лише з твоїх власних фото, ніколи зі згенерованих.',
      ] },
      { title: 'Хто ще бачить дані', body: [
        `OpenAI: фото й текст, потрібні для розпізнавання, підбору й примірок, обробляє Codex від OpenAI в акаунті ChatGPT власника Capsula. Навчання моделей на цих даних у цьому акаунті вимкнено (${OPENAI_DATA}).`,
        'Google: вхід в акаунт.',
        'Cloudflare: передає весь трафік до Capsula.',
        'Hetzner: розміщує наш сервер і дані.',
      ] },
      { title: 'Чого ми не робимо', body: [
        'Не продаємо й не передаємо твої дані. Немає реклами, аналітики чи сторонніх трекерів. Твої фото не використовуються для навчання моделей.',
      ] },
      { title: 'Cookies', body: [
        'Лише необхідні: сесія входу (30 днів) і cookie запрошення (до доби, поки ти реєструєшся). Тому банера згоди немає.',
      ] },
      { title: 'Зберігання й видалення', body: [
        'Дані зберігаються, поки існує акаунт.',
        '«Профіль → Акаунт → Видалити акаунт» одразу й назавжди видаляє акаунт, фото, речі, капсули, образи й примірки. У зашифрованих резервних копіях вони зникають протягом 4 тижнів.',
      ] },
      { title: 'Вік і чужі фото', body: [
        'Capsula для людей від 18 років. Завантажуй фото лише себе або людей, які на це погодилися.',
      ] },
      { title: 'Хто відповідає за дані', body: [`${CONTROLLER}, власник Capsula.`] },
      { title: 'Зв’язок', body: [`Питання й запити щодо даних: ${CONTACT}.`] },
    ],
  },
  en: {
    title: 'Privacy',
    updated: 'Updated 22 November 2026',
    sections: [
      { title: 'What we store', body: [
        'Google sign-in: your name, email and profile photo address. We do not store Google access tokens.',
        'What you add yourself: photos of you and your clothes, pieces, capsules, looks, ratings, measurements and preferences.',
        'Generated images: try-ons and catalogue pictures of pieces.',
        'Your location, only if you press «Where to shop». We keep it rounded to about 1 km.',
        'How many try-ons and styling runs you used this month and what they cost.',
      ] },
      { title: 'Why', body: [
        'Only to show your wardrobe, build capsules and looks, find pieces in shops and make try-ons.',
        'The face and build in a try-on come only from your own photos, never from generated ones.',
      ] },
      { title: 'Who else sees the data', body: [
        `OpenAI: the photos and text needed for recognition, styling and try-ons are processed by OpenAI’s Codex in the ChatGPT account of Capsula’s owner. Model training on this data is turned off in that account (${OPENAI_DATA}).`,
        'Google: signing in.',
        'Cloudflare: carries all traffic to Capsula.',
        'Hetzner: hosts our server and data.',
      ] },
      { title: 'What we do not do', body: [
        'We do not sell or share your data. No ads, analytics or third-party trackers. Your photos are not used to train models.',
      ] },
      { title: 'Cookies', body: [
        'Only the necessary ones: your sign-in session (30 days) and an invite cookie (up to a day, while you sign up). So there is no consent banner.',
      ] },
      { title: 'Keeping and deleting', body: [
        'Your data is kept while your account exists.',
        '«Profile → Account → Delete account» removes your account, photos, pieces, capsules, looks and try-ons at once and for good. Encrypted backups lose them within 4 weeks.',
      ] },
      { title: 'Age and other people’s photos', body: [
        'Capsula is for people aged 18 and over. Upload photos only of yourself or of people who agreed to it.',
      ] },
      { title: 'Who is responsible for the data', body: [`${CONTROLLER}, the owner of Capsula.`] },
      { title: 'Contact', body: [`Questions and data requests: ${CONTACT}.`] },
    ],
  },
};

const TERMS: Record<Lang, Doc> = {
  uk: {
    title: 'Умови',
    updated: 'Оновлено 20 листопада 2026',
    sections: [
      { title: 'Бета', body: [
        'Capsula — безкоштовна бета за запрошенням. Вона надається «як є», може змінюватися, мати помилки чи тимчасово зупинятися.',
      ] },
      { title: 'Акаунт', body: [
        'Тобі має бути 18 або більше. Один акаунт на людину; за те, що відбувається в ньому, відповідаєш ти.',
      ] },
      { title: 'Фото', body: [
        'Завантажуй лише фото себе або людей, які на це погодилися. Не можна: чужі фото без згоди, фото дітей, оголеність і будь-що незаконне.',
        'Примірка змінює лише одяг. Не намагайся змінити нею обличчя, тіло чи особу людини.',
      ] },
      { title: 'Поради й зображення', body: [
        'Згенеровані зображення — ілюстрації, а не доказ посадки, розміру чи складу речі. Оцінки й поради — думка стиліста, а не гарантія. Ціни й наявність перевіряй у магазині.',
      ] },
      { title: 'Ліміти', body: [
        'Примірки й підбори мають місячні ліміти. Їх, як і загальний бюджет, можна змінювати; коли бюджет вичерпано, генерація стає на паузу до 1-го числа. Акаунт можуть вимкнути за порушення цих умов.',
      ] },
      { title: 'Твій контент', body: [
        'Твої фото й дані лишаються твоїми. Ти дозволяєш Capsula зберігати й обробляти їх лише для роботи сервісу.',
      ] },
      { title: 'Код і назва', body: [
        'Код Capsula відкритий під ліцензією GNU AGPL-3.0. Назва й логотип Capsula під неї не підпадають.',
      ] },
      { title: 'Відповідальність', body: [
        'У межах, які дозволяє закон, Capsula не відповідає за непрямі збитки, покупки чи рішення, ухвалені на підставі порад або зображень.',
      ] },
      { title: 'Зв’язок і скарги', body: [`${CONTACT}`] },
    ],
  },
  en: {
    title: 'Terms',
    updated: 'Updated 20 November 2026',
    sections: [
      { title: 'Beta', body: [
        'Capsula is a free, invite-only beta. It is provided as is and may change, have bugs or pause for a while.',
      ] },
      { title: 'Account', body: [
        'You must be 18 or older. One account per person; you are responsible for what happens in it.',
      ] },
      { title: 'Photos', body: [
        'Upload only photos of yourself or of people who agreed to it. Not allowed: other people’s photos without consent, photos of children, nudity and anything unlawful.',
        'A try-on changes clothes only. Do not try to change a person’s face, body or identity with it.',
      ] },
      { title: 'Advice and images', body: [
        'Generated images are illustrations, not proof of a piece’s fit, size or fabric. Ratings and advice are a stylist’s opinion, not a guarantee. Check prices and availability with the shop.',
      ] },
      { title: 'Limits', body: [
        'Try-ons and styling have monthly limits. They and the overall budget may change; when the budget is spent, generation pauses until the 1st. An account may be disabled for breaking these terms.',
      ] },
      { title: 'Your content', body: [
        'Your photos and data stay yours. You allow Capsula to store and process them only to run the service.',
      ] },
      { title: 'Code and name', body: [
        'Capsula’s code is open under the GNU AGPL-3.0. The Capsula name and logo are not covered by it.',
      ] },
      { title: 'Liability', body: [
        'As far as the law allows, Capsula is not liable for indirect losses, purchases or decisions based on its advice or images.',
      ] },
      { title: 'Contact and complaints', body: [`${CONTACT}`] },
    ],
  },
};

const linkify = (text: string) =>
  text.split(/(https:\/\/\S+?)(?=\)|$|\s)/).map((part, i) =>
    part.startsWith('https://') ? <a key={i} href={part} target="_blank" rel="noreferrer">{part.replace(/^https:\/\//, '')}</a> : part);

export function LegalPage({ kind }: { kind: 'privacy' | 'terms' }) {
  const query = new URLSearchParams(window.location.search);
  const lang: Lang = query.get('lang') === 'en' || (!query.get('lang') && navigator.language.toLowerCase().startsWith('en')) ? 'en' : 'uk';
  const doc = (kind === 'privacy' ? PRIVACY : TERMS)[lang];
  const other = lang === 'uk' ? 'en' : 'uk';
  return (
    <main className="legal">
      <header className="legal-head">
        <a className="legal-mark" href="/">Capsula</a>
        <a className="quiet-toggle" href={`/${kind}?lang=${other}`}>{other === 'en' ? 'English' : 'Українська'}</a>
      </header>
      <h1>{doc.title}</h1>
      <p className="legal-updated">{doc.updated}</p>
      {doc.sections.map((s) => (
        <section key={s.title}>
          <h2>{s.title}</h2>
          {s.body.map((p, i) => <p key={i}>{linkify(p)}</p>)}
        </section>
      ))}
      <footer className="legal-foot">
        <a href={kind === 'privacy' ? `/terms?lang=${lang}` : `/privacy?lang=${lang}`}>{kind === 'privacy' ? TERMS[lang].title : PRIVACY[lang].title}</a>
        <a href="https://github.com/deus42/capsula">{lang === 'uk' ? 'Код' : 'Code'}</a>
      </footer>
    </main>
  );
}
