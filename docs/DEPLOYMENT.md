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
   docker compose up -d --build
   docker compose ps
   docker compose logs --tail=100 app
   ```

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

Before treating the bot as production-ready, configure the existing encrypted
backup script with an S3-compatible bucket and a separate backup key file.
Schedule it daily, test a restore into a disposable database, and alert on a
failed backup or a non-healthy Docker container. Keep the backup encryption key
outside the VPS backup bucket.

Run the real Telegram/AI checks listed in `MANUAL_ACTIONS.md` before granting
regular users access.
