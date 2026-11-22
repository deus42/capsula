# AGENTS.md

Guidance for people and coding agents working on Capsula, a capsule-wardrobe web app (AGPL-3.0).

## Layout

- `app/src/`: the React 19 + Vite interface. It is written in Ukrainian; `app/src/i18n/en.ts` holds the English strings.
- `app/server/`: the Node 24 server, run straight from TypeScript (type stripping, no build step). Each wardrobe is one JSON store (`store.ts`, schema in `schema.ts`).
- `scripts/`: deployment, backups and the one-time account import. `deploy/`: the container setup and its runbook.
- `docs/`: background reading.

## Commands

- Run: `cd app && npm install && npm start` (http://127.0.0.1:4317). For UI work: `npm run dev:server` and `npm run dev:client`.
- Before every commit: `cd app && npm run check` (typecheck, server tests, production build) and `git diff --check`.

## Two modes

- Without Google credentials the server runs one local wardrobe with its data in `.local/app-data/`, and AI work goes through the local Codex CLI.
- With them it runs accounts: Google sign-in by invitation, one folder per account, the OpenAI API, monthly allowances and a budget. Without an API key, production runs Codex on the owner's ChatGPT subscription, for the owner only unless `CODEX_ACCESS=accounts`. [`deploy/capsula.env.example`](deploy/capsula.env.example) lists the settings.
- The owner is the admin (Profile → «Адмін»). To try processing in accounts mode, use a test account with made-up data: `node scripts/test-account.ts create|link|list` prints a one-time sign-in link (see [`deploy/README.md`](deploy/README.md#admin-and-test-accounts)). Never use the owner's own wardrobe for tests.

## Product rules

- Everything serves the capsules. A capsule is one distinct fashion style (silhouette, palette, materials, key pieces) built on a closed set of pieces. It is never a season, a ranking or a group of existing looks. Looks live inside their capsule; owning a piece is a quiet filter, and missing pieces become purchases.
- Minimal, elegant design: the fewest elements that do the job, quiet type, fine lines and generous space. No explanatory text, debug data or duplicate controls on screens.
- Never a panel that slides out from the side (drawer, side sheet): details open as their own page. Never hide content behind accordions, collapsible sections or show-more toggles.
- Filters are quiet text toggles and primary actions are small. Chat input follows the usual composer: text that grows as you type, quiet controls, a small round send button.
- Change only what the task asks; don't redesign other screens along the way.
- A try-on takes the face and build only from the person's own photos; generated images never supply identity. Every result waits for the person's own «Це я?».

## Languages

- Every Ukrainian string the interface can show needs an English one in `app/src/i18n/en.ts`; `app/server/i18n.test.ts` fails otherwise. Model replies follow the person's language.

## Data and security

- Never commit photos, `.local/`, `.env` files, credentials or anyone's personal details. Test data is made up.
- Each account sees only its own data: keep new routes behind the tenant context and test that another account cannot reach them.
- Report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md).

## Commits

- Small, focused commits with a plain message that describes the change. No tool or agent attribution trailers.
