# Production deployment

This guide deploys IPsycho as one Docker Compose application on an EU VPS. It is
designed for a private GitHub repository and uses GitHub Actions to update the
server whenever a verified commit reaches `main`.

## Target architecture

```text
GitHub main -- GitHub Actions -- SSH --> VPS /opt/ipsycho
                                         |-- caddy (80/443, `webapp` profile only)
                                         |     `-- /app*, /api/v1/* --> app:3000
                                         |-- app (non-root Docker container)
                                         `-- postgres (internal Docker network)
```

PostgreSQL is never published, and the app container publishes no port of its
own: `/health` and `/ready` stay inside the Docker network. Telegram long
polling needs only outbound HTTPS access.

Until the Mini App is enabled that is the whole deployment — the `caddy` service
sits behind a Compose profile and does not start, so nothing listens on 80 or
443. Once the profile is on, Caddy is the single public entry point and forwards
exactly two path prefixes to the app. Everything else, `/health` and `/ready`
included, gets a 404 from Caddy; see
[Mini App: domain, TLS and registration](#mini-app-domain-tls-and-registration).

## First server setup

1. Create an Ubuntu 24.04 VPS in an EU location with at least 2 vCPU, 4 GB RAM
   and 40 GB disk. Add an SSH key at creation time.
2. In the provider firewall permit inbound SSH (`22/tcp`) only from your own
   current IP. Do not expose `3000` or `5432`. Leave `80` and `443` closed for
   now; they are opened as one explicit step when the Mini App goes live.
3. Install Docker Engine and the Compose plugin using Docker's official Ubuntu
   instructions. Create a non-root operator user named `deploy` and grant it
   Docker access.
4. Create `/opt/ipsycho`, make `deploy` its owner, and clone the private GitHub
   repository there. Use a GitHub deploy key with **read-only** access; it is a
   different key from the one GitHub Actions uses to log in to the VPS.
5. On the server create `/opt/ipsycho/.env` with `chmod 600`. Copy
   `.env.example`, set `NODE_ENV=production`, generate a long URL-safe
   `POSTGRES_PASSWORD`, and set the Telegram and AI credentials. Never commit
   this file.
6. Start once as the deploy user:

   ```sh
   cd /opt/ipsycho
   APP_COMMIT=$(git rev-parse HEAD) docker compose up -d --build
   docker compose ps
   docker compose logs --tail=100 app
   ```

   `APP_COMMIT` is baked into the image and reported by `/status` in Telegram and
   by `GET /health` and `GET /ready` (`commit` field), so the running build can be
   verified without shell access. Docker's healthcheck polls `/ready`, which also
   probes the database and the periodic loops; `/health` is process liveness only. The deploy workflow passes the exact verified commit automatically.

   The app image applies database migrations before it starts. Do not run a
   separate migration while the app container owns the database lock.

## GitHub setup

1. Create a **private** GitHub repository and push this project to its `main`
   branch.
2. In repository settings, protect `main`: require the `CI / verify` check and
   disallow force-pushes.
3. Create a GitHub Environment named `production`. Add a required reviewer if
   you want each production release approved manually.
4. Add these environment secrets:

   | Secret | Value |
   | --- | --- |
   | `DEPLOY_HOST` | VPS public IP or host name |
   | `DEPLOY_USER` | `deploy` |
   | `DEPLOY_SSH_PRIVATE_KEY_BASE64` | the private key for Actions to SSH into the VPS, base64-encoded (`base64 -w0 < key`) so newlines survive the secret store |
   | `DEPLOY_KNOWN_HOSTS` | pinned `ssh-keyscan -H <host>` output, verified against the provider console fingerprint |

   Add one environment **variable** (not a secret — it is a public host name)
   once the Mini App domain exists:

   | Variable | Value |
   | --- | --- |
   | `WEBAPP_DOMAIN` | the Mini App host name, e.g. `app.example.com` |

   While it is unset the deploy workflow skips its public HTTPS check and says
   so. Once it is set, every deploy must see `https://<domain>/app/` answer 200
   and `/health`, `/ready` and `/` answer 404, or the workflow fails.

Pushes to `main` first run CI. A successful CI run deploys its exact commit;
the server checks out that commit in detached mode, so the deployed code cannot
silently advance to a later, unverified commit. Keep server-specific changes in
`.env` or outside the repository.

The deploy itself is `scripts/deploy-remote.sh`, taken from the commit being
deployed and run over SSH. It takes a plain `pg_dump` into
`backups/pre-deploy/` (the last three are kept), rebuilds with
`docker compose up --wait`, and then polls `/ready` until the reported `commit`
equals the deployed SHA. If that does not happen within about 150 seconds the
previous commit is checked out and rebuilt, and the workflow fails. Old images
are no longer pruned during a deploy; schedule
`docker image prune -f --filter until=168h` weekly instead.

Container logs rotate at 5 × 10 MB per service. `stop_grace_period: 30s` gives
the old container time to release the migration advisory lock before the new
one starts.

## Mini App: domain, TLS and registration

The Telegram Mini App is the browsing surface: lists, task detail, forms,
settings. The conversation, the reaction cards and the account gates stay in
chat. Turning it on makes the process reachable from the internet for the first
time, so the steps below are deliberately separate from the base deployment and
none of them happens automatically.

Nothing in this repository names a domain. Choose one, then set it in
`/opt/ipsycho/.env`; the `Caddyfile` reads it from the environment.

### 1. Choose the domain and point DNS at the VPS — manual

Pick a host name you control, for example `app.example.com`. A dedicated
subdomain is worth it: the certificate, the CSP and the deploy check are all
scoped to it, and a shared host makes each of those someone else's problem too.

Create the DNS records at the registrar and wait for them to resolve:

```text
A     app.example.com  ->  <VPS IPv4>
AAAA  app.example.com  ->  <VPS IPv6>   (only if the VPS has one)
```

```sh
dig +short app.example.com
```

Do not continue until that prints the VPS address. Caddy's certificate request
fails if the name does not resolve to this machine, and a failed ACME order is
rate-limited.

### 2. Open 80 and 443 — manual

In the provider firewall (and `ufw`, if it is in use) permit inbound `80/tcp`,
`443/tcp` and `443/udp`. Port 80 is required: Caddy uses it for the HTTP-01
challenge and then serves nothing but redirects to HTTPS. `3000` and `5432`
stay closed.

### 3. Configure `/opt/ipsycho/.env` — manual

```sh
WEBAPP_ENABLED=true
WEBAPP_URL=https://app.example.com/app
WEBAPP_DOMAIN=app.example.com
ACME_EMAIL=you@example.com
COMPOSE_PROFILES=webapp
```

- `WEBAPP_ENABLED` mounts the API and the static files inside the app. Default
  is `false`, which is the rollout-step-1 state and the rollback state.
- `WEBAPP_URL` is what the bot puts in `web_app` buttons. It is the public
  HTTPS URL of `/app` with **no trailing slash**: the bot appends the route
  fragment to it (`${WEBAPP_URL}/#/today`, `/#/task/<id>`, `/#/week`).
- `WEBAPP_DOMAIN` and `ACME_EMAIL` are read by the `Caddyfile`. Both are
  required together: with either empty Caddy refuses to start with a config
  error rather than falling back to some default host.
- `COMPOSE_PROFILES=webapp` is what starts the `caddy` service at all. Without
  it `docker compose up` brings up `postgres` and `app` exactly as before and
  opens no ports — which is why enabling the Mini App cannot happen by accident.
  Compose reads it from `.env` like any other variable, so `deploy-remote.sh`
  and every manual `docker compose` in `/opt/ipsycho` pick it up with no flag.

### 4. Issue the certificate — manual, once

```sh
cd /opt/ipsycho
APP_COMMIT=$(git rev-parse HEAD) docker compose up -d --build
docker compose logs -f caddy
```

Watch for `certificate obtained successfully`. Then verify the edge from
**outside** the VPS:

```sh
curl -sS -o /dev/null -w '%{http_code}\n' https://app.example.com/app/     # 200
curl -sS -o /dev/null -w '%{http_code}\n' https://app.example.com/health   # 404
curl -sS -o /dev/null -w '%{http_code}\n' https://app.example.com/ready    # 404
curl -sS -o /dev/null -w '%{http_code}\n' https://app.example.com/         # 404
curl -sSI http://app.example.com/app/ | head -1                            # 308
```

The three 404s are the point of the `Caddyfile`, not a nicety: `/health` and
`/ready` report the deployed commit SHA, the database state and the names of
the periodic loops. Caddy answers a path that matches no route with an empty
`200`, so a catch-all `reverse_proxy` — the shape almost every tutorial
suggests — publishes all of it. The config has explicit `handle` blocks for
`/app*` and `/api/v1/*` and a final `respond 404`; the deploy workflow re-checks
those four responses after every release.

Renewal is automatic: Caddy renews about 30 days before expiry and needs
nothing but port 80 or 443 reachable. Certificates and the ACME account key
live in the `caddy_data` volume. Losing that volume is not fatal but forces a
re-issue on the next start, which Let's Encrypt rate-limits — include it if you
extend the backup script, or accept the window.

### 5. Register the Mini App with BotFather — manual

In [@BotFather](https://t.me/BotFather):

1. `/newapp`, choose this bot.
2. Title, short description, a 640×360 photo, and no demo GIF.
3. Web App URL: `https://app.example.com/app`.
4. Short name — this becomes `t.me/<bot>/<shortname>`.

`/myapps` edits any of it afterwards. The short name matters only for
`t.me/<bot>/<shortname>?startapp=` links; the bot's own buttons use
`WEBAPP_URL` directly.

### 6. Set the chat menu button — automatic, with a manual fallback

With `WEBAPP_ENABLED=true` the bot sets its own chat menu button at startup,
and leaves it alone when the flag is off. To set or repair it by hand:

```sh
curl -sS -X POST "https://api.telegram.org/bot<TOKEN>/setChatMenuButton" \
  -H 'Content-Type: application/json' \
  -d '{"menu_button":{"type":"web_app","text":"Открыть","web_app":{"url":"https://app.example.com/app"}}}'
```

To put it back to the default commands menu:

```sh
curl -sS -X POST "https://api.telegram.org/bot<TOKEN>/setChatMenuButton" \
  -H 'Content-Type: application/json' -d '{"menu_button":{"type":"commands"}}'
```

### 7. Rollback

The Mini App has two rollback levers and they are not the same size.

```sh
# Turn the surface off; the bot keeps working exactly as before.
cd /opt/ipsycho
sed -i 's/^WEBAPP_ENABLED=true$/WEBAPP_ENABLED=false/' .env
docker compose up -d
curl -sS -X POST "https://api.telegram.org/bot<TOKEN>/setChatMenuButton" \
  -H 'Content-Type: application/json' -d '{"menu_button":{"type":"commands"}}'
```

`WEBAPP_ENABLED=false` unmounts the API and the static files, so the app answers
nothing even though Caddy is still listening. It does not remove the menu button
Telegram already stored, which is why the second command is part of the rollback.
Buttons already sent in scroll-back keep pointing at a URL that now returns a
404 from the app.

**The flag is no longer a rollback for the bot's screens.** The browsing screens
were deleted once the app had been used in production, so turning the flag off
now leaves the bot with the conversation (free text and voice, including every
change to settings), the reaction cards (Done · Snooze · +1 h / This evening /
Tomorrow · Skip · Undo · consent) and the account commands (`/start`, `/help`,
`/status`, `/clear`, `/cancel`, `/retry_ai`, `/invite`, `/delete_account`,
`/restore`, `/ai_revoke`, `/context`) — and nothing to browse with. `/tasks`,
`/today`, `/week`, `/goals`, `/reminders`, `/settings`, `/memory` and the
settings commands answer one sentence saying where they went, with no button to
offer while the flag is off. `/context` still starts the profile interview in
chat; only the launch button that follows it disappears. That is the intended floor, not a regression.

The rollback for the deletion itself is a revert of that commit and a redeploy,
not a flag: a flag that keeps dead screens alive is how a temporary second
control model becomes permanent (design.md § 10).

To take the edge down entirely, remove `COMPOSE_PROFILES=webapp` from `.env` and
run `docker compose up -d --remove-orphans`; ports 80 and 443 stop being served.
Close them in the firewall too if the outage is expected to last.

### 8. Revocation and the blast radius of a stolen `initData`

Every API request carries `Authorization: tma <initDataRaw>` — the payload
Telegram signs with the bot token. There is no session store, no cookie and no
refresh, so this string *is* the credential.

- **Disabling one user is immediate.** The guard re-resolves the allowlist
  through `AccessService` on every request, so the admin CLI takes effect on the
  next call on both surfaces. Nothing is cached, and no restart is needed.
- **Rotating the bot token invalidates every outstanding `initData` at once.**
  The signing key is derived from the token, so every previously issued payload
  stops verifying the moment the new token is in `.env`. This is the emergency
  lever when a device is lost or a payload may have leaked. It also restarts the
  bot and every user must reopen the app, so it is not a routine action. After
  rotating, re-run step 6 — a token change does not move the menu button, but
  the old one points at the same URL and will simply fail to authenticate.
- **The 24-hour `auth_date` cap is a bound, not revocation.** A Mini App never
  refreshes `initData` while it is open, so a stolen payload is usable until it
  ages out. Use one of the two levers above; do not wait for the clock.
- **Never log the credential.** `initData` must not reach a log line, an error
  message or an access log. Caddy's access log is off for this reason
  (`log { output discard }` in the `Caddyfile`). If a request log is genuinely
  needed for an investigation, filter the header rather than logging it raw:

  ```caddyfile
  log {
  	output file /data/access.log
  	format filter {
  		request>headers>Authorization delete
  		request>headers>Cookie delete
  	}
  }
  ```

  Turn it off again afterwards.

### 9. Why the proxy hop is configured the way it is

The app's IP rate limiter is the only thing standing between an unauthenticated
attacker and the signature check. Behind a proxy it sees the proxy's address for
every request unless the hop is configured on both sides, and a limiter keyed on
a header the client controls is worse than none: one attacker can fill the
bucket for the only legitimate user.

- Caddy declares no `trusted_proxies`, so it trusts no inbound
  `X-Forwarded-For` or `Forwarded` when deciding the client IP. Caddy is the
  edge; there is nothing in front of it to trust.
- The `reverse_proxy` block sets `header_up X-Forwarded-For {client_ip}`, which
  **replaces** the header instead of appending to it, and deletes `X-Real-IP`
  and `Forwarded`. A client-supplied value cannot survive the hop. Use exactly
  `{client_ip}`: the plausible long form `{http.request.client_ip}` is not a
  registered placeholder and Caddy forwards that literal string to the app,
  which makes every request share one rate-limit bucket and produces no error
  anywhere.
- `main.ts` sets `trust proxy` to that one Compose hop, so `req.ip` is the
  address Caddy saw.

If you ever put a CDN or a second proxy in front of Caddy, all three of those
have to change together. Changing one is how the limiter silently stops working.

## Backups and operations

Before treating the bot as production-ready, configure encrypted Compose
backups with an S3-compatible bucket and a separate backup key file. Keep that
key outside both the repository and the backup bucket.

```sh
sudo install -d -m 700 -o deploy -g deploy /opt/ipsycho-secrets /opt/ipsycho/backups
sudo -u deploy sh -c 'umask 077; openssl rand -base64 48 > /opt/ipsycho-secrets/backup.key'

cd /opt/ipsycho
BACKUP_KEY_FILE=/opt/ipsycho-secrets/backup.key \
S3_BACKUP_URI=s3://your-private-bucket/ipsycho \
./scripts/backup-compose.sh
```

`S3_BACKUP_URI` may be left unset: the runner then writes the encrypted copy
locally and says `offsite=no`. That protects against a bad migration or a
wrong delete, never against losing the machine, so treat it as a stopgap until
a bucket exists.

For a non-AWS S3-compatible service, also set `S3_ENDPOINT_URL`. The runner
creates the encrypted file atomically, validates that it can be decrypted and
parsed, retains 7 daily and 4 weekly copies locally and remotely, and fails if
the Compose PostgreSQL service is unavailable.

Schedule `backup-compose.sh` daily as the `deploy` user and alert on any non-zero
exit. Every dump gets a `.sha256` sidecar, the script refuses to run twice at
once (`flock`), and `BACKUP_PING_URL` (a healthchecks.io-style URL) is pinged
after a successful upload so a silent cron failure is noticed. Suggested crontab:

```cron
15 3 * * *  cd /opt/ipsycho && BACKUP_KEY_FILE=/home/deploy/ipsycho-secrets/backup.key S3_BACKUP_URI=s3://bucket/ipsycho BACKUP_PING_URL=https://hc-ping.com/... ./scripts/backup-compose.sh >> /opt/ipsycho/backups/backup.log 2>&1
0 4 1 * *   cd /opt/ipsycho && BACKUP_KEY_FILE=/home/deploy/ipsycho-secrets/backup.key ./scripts/restore-compose.sh "$(ls -t /opt/ipsycho/backups/daily/*.dump.enc | head -1)" >> /opt/ipsycho/backups/restore-drill.log 2>&1
30 4 * * 0  docker image prune -f --filter until=168h >> /opt/ipsycho/backups/prune.log 2>&1
```

Installed on the production VPS on 2026-09-05 without `S3_BACKUP_URI`: the key
lives in `/home/deploy/ipsycho-secrets/backup.key` (the deploy user has no
sudo, so it is not under `/opt`), and the copies stay on the machine until a
bucket exists. Add `S3_BACKUP_URI` (and `S3_ENDPOINT_URL` for a non-AWS
service) to the first cron line to start copying off-site — nothing else
changes. The key itself is not backed up anywhere: keep a copy off the
machine, or every encrypted dump becomes unreadable with the disk.

`AI_PRICING_JSON` holds the per-model prices the cost estimate uses; the keys
must match `AI_MODEL` and `AI_TRANSCRIPTION_MODEL` exactly, and the estimate
silently stays on the old numbers when a price changes, so re-check it when
the model or the tariff moves. `AI_MONTHLY_WARNING_USD` is the monthly figure
at which the user and the owner get one notice; AI is never switched off
automatically.

Runtime alerts go to `OWNER_TELEGRAM_USER_ID`: the hourly maintenance tick
reports reminders pending more than ten minutes past their time, non-empty
dead-letter queues and ambiguous deliveries, once per change. `HEALTHCHECK_PING_URL`
makes the same tick ping a dead-man switch, so silence from the whole machine
is noticed by someone outside it.

Two watchers run in production since 2026-09-05:

```cron
*/5 * * * *  cd /opt/ipsycho && ./scripts/watchdog.sh >> /opt/ipsycho/backups/watchdog.log 2>&1
```

`scripts/watchdog.sh` polls `/ready` and, after two consecutive failures, sends
one Telegram message to the owner and one more when the app recovers. It shares
the machine's fate, so it catches a crash-looping app, not a dead host — that is
what the hourly ping to healthchecks.io covers. At least monthly, verify a selected encrypted backup without touching the
production database:

```sh
BACKUP_KEY_FILE=/opt/ipsycho-secrets/backup.key \
./scripts/restore-compose.sh backups/daily/ipsycho-YYYY-MM-DDTHHMMSSZ.dump.enc
```

CI additionally runs `scripts/backup-roundtrip.sh` against the throwaway e2e
database on every push: dump, encrypt, decrypt, restore into a scratch database
and compare the row count of every table, so a backup format that cannot be
restored fails the build rather than a real incident.

`restore-compose.sh` starts a disposable PostgreSQL container, restores the
dump, verifies that public tables exist, and removes the container. It never
connects to the production Compose database. A real disaster recovery into the
primary database remains an explicit operator procedure and must only be done
after stopping the app and preserving the current volume.

Run the real Telegram/AI checks listed in `MANUAL_ACTIONS.md` before granting
regular users access.
