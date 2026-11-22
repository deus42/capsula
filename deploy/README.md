# Running Capsula

How the hosted Capsula runs: one container on an existing Linux host, reached only through a Cloudflare Tunnel, with nightly snapshots that a
separate Mac pulls and encrypts. `user@server` below stands for an SSH login over Tailscale with passwordless
`sudo` for Docker.

## First setup on the server

1. Folders: data belongs to the image's user (uid 1000), snapshots to root.

   ```sh
   sudo install -d -m 755 /srv/capsula
   sudo install -d -o 1000 -g 1000 -m 700 /srv/capsula/data
   sudo install -d -m 700 /srv/capsula/backups
   ```

2. Secrets: copy [`capsula.env.example`](capsula.env.example) to `/srv/capsula/capsula.env`, fill it in and
   `sudo chmod 600` it. Production refuses to start without the OAuth client and `BETTER_AUTH_SECRET`. Without an
   OpenAI key it also needs `OWNER_EMAIL` and a closed `SIGNUP`; with one, the model names, `OPENAI_PRICES` and
   `MONTHLY_BUDGET_USD`.
3. Tunnel: add an ingress rule `capsula.fit → http://127.0.0.1:4317` to the host's Cloudflare Tunnel. The
   container publishes its port on loopback only; `TRUST_PROXY=cloudflare` lets the rate limits see the visitor's
   address.
4. Snapshots: install [`capsula-backup.service`](capsula-backup.service) and
   [`capsula-backup.timer`](capsula-backup.timer) into `/etc/systemd/system`, then
   `sudo systemctl daemon-reload && sudo systemctl enable --now capsula-backup.timer`. `sqlite3` must be installed.
   The first deploy installs the script the service runs.
5. The image is public on GHCR once its package visibility is set to public after the first push; otherwise run
   `docker login ghcr.io` on the server with a read-only token.

## Deploy

From a clean checkout on the Mac, logged in to GHCR with a token that can write packages:

```sh
DOCKER_CONTEXT=colima scripts/deploy.sh user@server
```

It builds `linux/amd64`, pushes `ghcr.io/deus42/capsula:sha-<commit>`, installs `compose.yaml` and the backup
script, pulls that exact image, restarts and waits for `/health`; an unhealthy start goes back to the previous tag.

## AI without an API key

Without `OPENAI_API_KEY` the container runs Codex on the owner's ChatGPT subscription. By default only
`OWNER_EMAIL` and the owner's test accounts can sign in and use AI, and invites are off. `CODEX_ACCESS=accounts`
lets invited accounts use it too, each within its monthly allowances; whether a subscription may serve other people
is for its owner to check against the provider's terms. Sign Codex in once after the first deploy:

```sh
cd /srv/capsula
sudo docker compose exec capsula codex login --device-auth
```

Open the address it prints, enter the code and sign in with the owner's ChatGPT account. `codex login status`
checks it. The sign-in lives in `/srv/capsula/data/codex` and is not in the backups: after a restore, sign in
again. Codex has no command sandbox inside the container, so it runs without commands: the app collects each
generated image from Codex's own folder.

## Admin and test accounts

The owner is the admin: Profile → «Адмін» lists everyone with an account (what they hold, this month's try-ons,
the last sign-in), makes invite links and manages test accounts. Test accounts are the owner's own, for trying the
site and its AI work with made-up data. They have no Google sign-in and no lasting key: each sign-in is a one-time
link, single use and valid for 10 minutes. Open it in a private window, since it replaces the browser's session.
Agents with shell access to the host make accounts and links from the command line:

```sh
sudo docker exec capsula-capsula-1 node /srv/capsula/scripts/test-account.ts create "Agent"
sudo docker exec capsula-capsula-1 node /srv/capsula/scripts/test-account.ts link "Agent"
sudo docker exec capsula-capsula-1 node /srv/capsula/scripts/test-account.ts list
```

Removing a test account is done in «Адмін», which also removes its folder.

## Moving the owner's data (once)

Uploading personal originals is a separate step the owner approves at the time.

1. Sign in once at capsula.fit with the owner's Google account, so the account exists.
2. On the Mac, with no job queued or running: `node scripts/import-user.ts pack <staging-dir>`, then
   `node scripts/import-user.ts verify <staging-dir>`.
3. Copy it: `rsync -a --info=progress2 <staging-dir>/ user@server:/srv/capsula/import/`.
4. On the server:

   ```sh
   cd /srv/capsula
   sudo docker compose stop capsula
   sudo docker compose run --rm --no-deps -v /srv/capsula/import:/import:ro capsula \
     node /srv/capsula/scripts/import-user.ts apply /import /data owner@example.com
   sudo docker compose start capsula
   ```

   `apply` checks every SHA-256 before and after copying and keeps the account's previous folder as
   `users/<id>.before-import-<time>`.
5. Check the wardrobe, then make one control try-on and answer «Це я?» before any batch generation. Remove
   `/srv/capsula/import` and the `before-import` folder once everything is right.

## Backups

On the Mac that keeps the copies:

```sh
scripts/install-mac-backup.sh user@server
```

Every hour it pulls the newest nightly snapshot once, encrypts it with age, checks it by decrypting, and keeps 7 daily and 4 weekly copies in `~/Library/Application Support/Capsula/Backups`. Keep a second copy of
`Recovery/identity.txt` somewhere safe.

To check a restore:

```sh
scripts/restore-backup.sh <copy>.tar.age "$HOME/Library/Application Support/Capsula/Recovery/identity.txt" <empty-dir>
```

It verifies the SHA-256, SQLite integrity and every account's `db.json`. To look inside, start the app with
`CAPSULA_DATA_DIR=<empty-dir>` and a development Google client.
