# Deploy Thingery on a VPS

Target: any fresh Ubuntu 24.04 / Debian 12 VPS (2 GB RAM / 20 GB SSD is enough to start).
Result: `https://thingery.dev` serving the MCP endpoint, website, and discovery files,
with automatic HTTPS and nightly database backups.

Total time: ~15 minutes.

## 1. VPS initialization

```bash
ssh root@<VPS_IP>

# security basics
adduser --disabled-password thingery
usermod -aG sudo thingery
rsync --archive --chown=thingery:thingery ~/.ssh /home/thingery

# firewall: SSH + web only
apt update && apt install -y ufw
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp
ufw --force enable

# 2 GB swap as OOM insurance
fallocate -l 2G /swapfile && chmod 600 /swapfile
mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# Docker (official script)
curl -fsSL https://get.docker.com | sh
```

## 2. DNS (at Infomaniak)

Point the domain at the server before starting Caddy (it needs to solve the ACME challenge):

| Type | Name | Value |
|---|---|---|
| A | `thingery.dev` | `<VPS_IP>` |
| AAAA | `thingery.dev` | `<VPS_IPV6>` (if the VPS has one) |
| CNAME | `www` | `thingery.dev` |

## 3. First deploy

```bash
sudo su - thingery
sudo apt install -y git
git clone https://github.com/thingery/thingery.git /opt/thingery  # or: sudo mkdir /opt/thingery && sudo chown thingery /opt/thingery
cd /opt/thingery

cp .env.example .env
nano .env   # set POSTGRES_PASSWORD (required!), EMBED_API_KEY (optional), PUBLIC_BASE_URL=https://thingery.dev

export GIT_COMMIT=$(git rev-parse HEAD)
export BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)
docker compose -f docker-compose.prod.yml up -d --build

# apply the schema (idempotent — safe to re-run)
docker compose -f docker-compose.prod.yml exec -T db psql -U thingery -d thingery < db/schema.sql
```

Verify:

```bash
curl https://thingery.dev/healthz          # {"ok":true,...}
curl https://thingery.dev/llms.txt | head
```

## 4. Nightly backups (do not skip)

The Item Graph is the asset. Local dumps at minimum, object storage better:

```bash
sudo crontab -e
# add:
0 3 * * * docker exec $(docker ps -qf name=db) pg_dump -U thingery thingery | gzip > /var/backups/thingery-$(date +\%F).sql.gz && find /var/backups -name 'thingery-*.sql.gz' -mtime +14 -delete
0 4 * * * docker cp $(docker ps -qf name=app):/app/uploads /var/backups/img.tmp && tar czf /var/backups/thingery-images-$(date +\%F).tar.gz -C /var/backups/img.tmp . && rm -rf /var/backups/img.tmp && find /var/backups -name 'thingery-images-*.tar.gz' -mtime +14 -delete
```

The second job backs up uploaded item images. On 2026-10-12 the DB restore procedure
below was executed end-to-end on the production VPS against a real nightly backup
(3.3 KB dump, restore in 0.24 s, row counts matched live). Re-run it monthly —
a backup that has never been restored is not a backup.

### Restore test (monthly, ~5 minutes)

Never restore over the live database. The procedure below restores into an
isolated scratch container with **no published ports** — it is reachable only
via `docker exec`, so production cannot be touched. All commands run on the VPS.

1. Pick the latest backup and verify its integrity:

   ```bash
   sudo ls -lh --time-style=long-iso /var/backups/thingery-*.sql.gz | tail -3
   B=/var/backups/thingery-$(date +%F).sql.gz   # or the newest file from the listing
   sudo gzip -t "$B" && echo GZIP_OK            # must print GZIP_OK
   sudo sha256sum "$B"                          # record this in the ops log
   ```

2. Start an isolated scratch Postgres (pgvector) container — same image as prod,
   throwaway password, no `-p` port mappings:

   ```bash
   docker run -d --name thingery-restore-test \
     -e POSTGRES_USER=thingery \
     -e POSTGRES_PASSWORD=$(head -c 24 /dev/urandom | base64) \
     -e POSTGRES_DB=thingery \
     pgvector/pgvector:pg16
   for i in $(seq 1 30); do
     docker exec thingery-restore-test pg_isready -U thingery >/dev/null 2>&1 && break
     sleep 1
   done
   ```

3. Confirm the scratch target is empty (must print `0`):

   ```bash
   docker exec thingery-restore-test psql -U thingery -d thingery -tc \
     "SELECT count(*) FROM pg_tables WHERE schemaname='public';"
   ```

4. Restore and time it. `ON_ERROR_STOP=1` makes any SQL error fail loudly instead
   of producing a silently-partial restore:

   ```bash
   time (sudo zcat "$B" | docker exec -i thingery-restore-test \
     psql -U thingery -d thingery -v ON_ERROR_STOP=1 -q)
   ```

5. Verify the restored data. Row counts must match the live DB; run a joined query
   and check the pgvector extension so you know the data is usable, not just present:

   ```bash
   docker exec thingery-restore-test psql -U thingery -d thingery -c \
     "SELECT (SELECT count(*) FROM sellers) AS sellers,
             (SELECT count(*) FROM items) AS items,
             (SELECT count(*) FROM categories) AS categories,
             (SELECT extversion FROM pg_extension WHERE extname='vector') AS pgvector;"
   docker exec thingery-restore-test psql -U thingery -d thingery -c \
     "SELECT i.title, s.display_name AS seller FROM items i JOIN sellers s ON s.id = i.seller_id LIMIT 5;"
   # live counts for comparison (read-only, does not touch data):
   docker exec $(docker ps -qf name=thingery-db) psql -U thingery -d thingery -tc \
     "SELECT (SELECT count(*) FROM sellers), (SELECT count(*) FROM items), (SELECT count(*) FROM categories);"
   ```

6. Clean up the scratch container (never delete the backup file itself):

   ```bash
   docker rm -f -v thingery-restore-test
   ```

7. Confirm production is untouched:

   ```bash
   curl -sf https://thingery.dev/healthz   # {"ok":true,...}
   ```

Record in the ops log: backup filename, size, sha256, restore duration, live vs
restored row counts, and the date. If any step fails, treat the nightly backup as
broken until fixed and escalate.

The images backup (`thingery-images-*.tar.gz`) can be spot-checked with
`mkdir /tmp/img-verify && tar xzf <file> -C /tmp/img-verify && ls /tmp/img-verify | head`
then `rm -rf /tmp/img-verify`.

## 5. Updating

Deploys are automated via the `deploy.yml` workflow (on push to `main`) once you set the
repo variables/secrets: `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, and `DEPLOY_ENABLED=true`.
The workflow exports `GIT_COMMIT`/`BUILD_TIME` before building, so `/healthz` reports the
deployed commit. Manual equivalent:

```bash
cd /opt/thingery && git pull && \
  GIT_COMMIT=$(git rev-parse HEAD) BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
  docker compose -f docker-compose.prod.yml up -d --build
```

Verify the deployed build info (must match `git rev-parse HEAD` in `/opt/thingery`):

```bash
curl -s https://thingery.dev/healthz   # {"ok":true,...,"version":"…","commit":"…","buildTime":"…"}
```
If `commit` reports `"unknown"`, the deploy skipped the build args — rebuild with the
exports above. The site footer shows the same version + short commit.

## 6. Scaling later

- Bigger VPS: resize, reboot, done.
- Managed database: change `DATABASE_URL`, done.
- Watch disk: `df -h` — item images are blobs stored in the app container's
  `/app/uploads` (nightly backup in section 4), so disk grows with uploads;
  the DB itself stays small.
