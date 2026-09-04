# Production deployment

This guide deploys IPsycho as one Docker Compose application on an EU VPS. It is
designed for a private GitHub repository and uses GitHub Actions to update the
server whenever a verified commit reaches `main`.

## Target architecture

```text
GitHub main -- GitHub Actions -- SSH --> VPS /opt/ipsycho
                                         |-- app (non-root Docker container)
                                         `-- postgres (internal Docker network)
```

The app and PostgreSQL are intentionally not published to the public internet.
Telegram long polling needs only outbound HTTPS access.

## First server setup

1. Create an Ubuntu 24.04 VPS in an EU location with at least 2 vCPU, 4 GB RAM
   and 40 GB disk. Add an SSH key at creation time.
2. In the provider firewall permit inbound SSH (`22/tcp`) only from your own
   current IP. Do not expose `3000` or `5432`.
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
   | `DEPLOY_SSH_PRIVATE_KEY` | private key for Actions to SSH into the VPS |
   | `DEPLOY_KNOWN_HOSTS` | pinned `ssh-keyscan -H <host>` output, verified against the provider console fingerprint |

Pushes to `main` first run CI. A successful CI run deploys its exact commit;
the server checks out that commit in detached mode, so the deployed code cannot
silently advance to a later, unverified commit. Keep server-specific changes in
`.env` or outside the repository.

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

For a non-AWS S3-compatible service, also set `S3_ENDPOINT_URL`. The runner
creates the encrypted file atomically, validates that it can be decrypted and
parsed, retains 7 daily and 4 weekly copies locally and remotely, and fails if
the Compose PostgreSQL service is unavailable.

Schedule `backup-compose.sh` daily as the `deploy` user and alert on any non-zero
exit. At least monthly, verify a selected encrypted backup without touching the
production database:

```sh
BACKUP_KEY_FILE=/opt/ipsycho-secrets/backup.key \
./scripts/restore-compose.sh backups/daily/ipsycho-YYYY-MM-DDTHHMMSSZ.dump.enc
```

`restore-compose.sh` starts a disposable PostgreSQL container, restores the
dump, verifies that public tables exist, and removes the container. It never
connects to the production Compose database. A real disaster recovery into the
primary database remains an explicit operator procedure and must only be done
after stopping the app and preserving the current volume.

Run the real Telegram/AI checks listed in `MANUAL_ACTIONS.md` before granting
regular users access.
