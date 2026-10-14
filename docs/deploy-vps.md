# Deploy Thingery on a VPS

Target: any fresh Ubuntu 24.04 / Debian 12 VPS (2 GB RAM / 20 GB SSD is enough to start).
Result: `https://thingery.dev` serving the MCP endpoint, website, and discovery files,
with automatic HTTPS and encrypted nightly backups (§4).

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

The Item Graph is the asset. Backups are **encrypted before they touch disk**
(client-side `age`) and pushed offsite to object storage; the decryption key
never lives on the VPS. Local retention: 14 days. Offsite retention: 30 days.

### Key management (one-time)

```bash
# on the OPERATOR's machine (never on the VPS):
age-keygen -o thingery-backup-key.age.txt
# prints: Public key: age1...  <- goes on the VPS in the backup script (not secret)
# the file itself is the PRIVATE key -> store it in a password manager,
# confirm it is saved, then delete the file.
```

The private key is the only way to restore. If it is lost, every backup is
unrecoverable. It lives in the operator's password manager — never on the VPS,
never in the repo, never in chat.

### Backup script and cron (on the VPS)

```bash
sudo apt install -y age rclone                 # prerequisites
sudo nano /usr/local/bin/thingery-backup       # paste the script below
sudo chmod 0750 /usr/local/bin/thingery-backup
sudo tee /etc/logrotate.d/thingery-backup <<'LR'
/var/log/thingery-backup.log {
  weekly
  rotate 8
  compress
  missingok
  notifempty
}
LR
sudo crontab -e
# add (single entry; script does DB + images + prune + offsite push):
0 3 * * * /usr/local/bin/thingery-backup >> /var/log/thingery-backup.log 2>&1
```

Script contents (`/usr/local/bin/thingery-backup`):

```bash
#!/bin/bash
# thingery-backup - nightly encrypted backup pipeline (docs/deploy-vps.md section 4).
# DB dump and images tarball are encrypted with age BEFORE anything touches disk.
set -uo pipefail
umask 077

PUBKEY='age1...'                    # <- the public key from age-keygen (not secret)
BACKUP_DIR=/var/backups
DATE=$(date +%F)
FAIL=0

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

DB_FILE="$BACKUP_DIR/thingery-$DATE.sql.gz.age"
IMG_FILE="$BACKUP_DIR/thingery-images-$DATE.tar.gz.age"

# 1. Database: pg_dump | gzip | age -> atomic rename (no truncated .age left behind)
DB_CID=$(docker ps -qf name=thingery-db)
if [ -n "$DB_CID" ] && docker exec "$DB_CID" pg_dump -U thingery thingery \
     | gzip | age -r "$PUBKEY" > "$DB_FILE.part"; then
  if [ -s "$DB_FILE.part" ]; then
    mv "$DB_FILE.part" "$DB_FILE"
    log "db OK $DB_FILE $(stat -c %s "$DB_FILE")B"
  else log "db FAIL empty output"; rm -f "$DB_FILE.part"; FAIL=1; fi
else
  log "db FAIL pg_dump|gzip|age pipe"; rm -f "$DB_FILE.part"; FAIL=1
fi

# 2. Images: tar runs INSIDE the app container, piped straight into age
#    (plaintext images never land on VPS disk)
APP_CID=$(docker ps -qf name=app)
if [ -n "$APP_CID" ] && docker exec "$APP_CID" tar czf - -C /app/uploads . \
     | age -r "$PUBKEY" > "$IMG_FILE.part"; then
  if [ -s "$IMG_FILE.part" ]; then
    mv "$IMG_FILE.part" "$IMG_FILE"
    log "img OK $IMG_FILE $(stat -c %s "$IMG_FILE")B"
  else log "img FAIL empty output"; rm -f "$IMG_FILE.part"; FAIL=1; fi
else
  log "img FAIL tar|age pipe"; rm -f "$IMG_FILE.part"; FAIL=1
fi

# 3. Local retention: 14 days (encrypted files only)
find "$BACKUP_DIR" -name 'thingery-*.age' -mtime +14 -delete
log "local prune (14d) done"

# 4. Offsite push - gated on /etc/thingery-backup.env (root:root 0600, VPS only).
if [ -r /etc/thingery-backup.env ]; then . /etc/thingery-backup.env; fi
if [ -n "${RCLONE_REMOTE:-}" ]; then
  if rclone copy "$DB_FILE" "$RCLONE_REMOTE" && rclone copy "$IMG_FILE" "$RCLONE_REMOTE"; then
    log "offsite push OK -> $RCLONE_REMOTE"
    if rclone delete --min-age "${RCLONE_KEEP_DAYS:-30}d" "$RCLONE_REMOTE"; then
      log "offsite prune (${RCLONE_KEEP_DAYS:-30}d) done"
    else log "offsite prune FAIL"; FAIL=1; fi
  else
    log "offsite push FAIL"; FAIL=1
  fi
else
  log "offsite push SKIPPED (not configured; see section 4 Offsite push)"
fi

exit $FAIL
```

### Offsite push (object storage)

Credentials live only in `/etc/thingery-backup.env` on the VPS (root:root, 0600).
Never in the repo. Any S3-compatible destination works via rclone:

```bash
RCLONE_REMOTE="offsite:thingery-backups/"        # <remote-name>:<bucket/path>
RCLONE_KEEP_DAYS=30                              # offsite retention
# remote defined inline via env vars (no rclone.conf needed):
RCLONE_CONFIG_OFFSITE_TYPE=s3
RCLONE_CONFIG_OFFSITE_PROVIDER=Other             # e.g. Infomaniak public cloud
RCLONE_CONFIG_OFFSITE_ENDPOINT=https://<s3-endpoint>
RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID=<access-key>
RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY=<secret-key>
```

Until this file exists the script logs `offsite push SKIPPED` and still writes
the local encrypted backups every night.

**Rollback** to the pre-encryption pipeline (kept one cycle after the 2026-10-14
switch): comment the `/usr/local/bin/thingery-backup` cron line, uncomment these
two old lines:

```bash
# 0 3 * * * docker exec $(docker ps -qf name=db) pg_dump -U thingery thingery | gzip > /var/backups/thingery-$(date +\%F).sql.gz && find /var/backups -name 'thingery-*.sql.gz' -mtime +14 -delete
# 0 4 * * * docker cp $(docker ps -qf name=app):/app/uploads /var/backups/img.tmp && tar czf /var/backups/thingery-images-$(date +\%F).tar.gz -C /var/backups/img.tmp . && rm -rf /var/backups/img.tmp && find /var/backups -name 'thingery-images-*.tar.gz' -mtime +14 -delete
```

### Restore test (monthly, ~5 minutes)

Never restore over the live database. The procedure restores into an isolated
scratch container with **no published ports** — reachable only via `docker exec`,
so production cannot be touched. Decryption happens **on the operator's machine**
(private key from the password manager); plaintext SQL streams over SSH straight
into the scratch container and is never written to the VPS disk.

1. On the VPS: pick the latest backup and record its sha256:

   ```bash
   sudo ls -lh --time-style=long-iso /var/backups/thingery-*.age | tail -4
   B=/var/backups/thingery-$(date +%F).sql.gz.age   # or the newest from the listing
   sudo sha256sum "$B"                              # record this in the ops log
   ```

2. Fetch the encrypted file to the operator machine and verify it decrypts
   (integrity check happens after decrypt — you cannot gzip -t an .age file):

   ```bash
   # on the VPS: sudo cp "$B" /tmp/ && sudo chown $USER /tmp/"$(basename "$B")"
   scp <vps>:/tmp/thingery-$(date +%F).sql.gz.age .
   # on the VPS: rm /tmp/thingery-*.age
   age -d -i thingery-backup-key.age.txt thingery-$(date +%F).sql.gz.age > dump.sql.gz
   gzip -t dump.sql.gz && echo GZIP_OK             # must print GZIP_OK
   sha256sum thingery-$(date +%F).sql.gz.age        # must match the VPS-side hash
   ```

3. Start an isolated scratch Postgres (pgvector) container on the VPS — same image
   as prod, throwaway password, no `-p` port mappings:

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

4. Confirm the scratch target is empty (must print `0`):

   ```bash
   docker exec thingery-restore-test psql -U thingery -d thingery -tc \
     "SELECT count(*) FROM pg_tables WHERE schemaname='public';"
   ```

5. Restore and time it, streaming the decrypted dump from the operator machine.
   `ON_ERROR_STOP=1` makes any SQL error fail loudly instead of producing a
   silently-partial restore:

   ```bash
   time (gunzip -c dump.sql.gz | ssh <vps> 'docker exec -i thingery-restore-test \
     psql -U thingery -d thingery -v ON_ERROR_STOP=1 -q')
   ```

6. Verify the restored data. Row counts must match the live DB; run a joined query
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

7. Clean up the scratch container (never delete the backup file itself):

   ```bash
   docker rm -f -v thingery-restore-test
   ```

8. Confirm production is untouched:

   ```bash
   curl -sf https://thingery.dev/healthz   # {"ok":true,...}
   ```

Record in the ops log (issue tracker): backup filename, size, sha256, restore
duration, live vs restored row counts, and the date. If any step fails, treat the
nightly backup as broken until fixed and escalate.

Drill history: 2026-10-12 end-to-end against a plaintext nightly (3.3 KB, 0.24 s,
counts matched); 2026-10-14 first end-to-end drill of the encrypted pipeline
(7.7 KB `.age`, decrypt + restore 2.1 s, counts matched, pgvector OK, images
tarball decrypts and lists). Re-run monthly — a backup that has never been
restored is not a backup.

The images backup (`thingery-images-*.tar.gz.age`) can be spot-checked on the
operator machine with:

```bash
age -d -i thingery-backup-key.age.txt thingery-images-$(date +%F).tar.gz.age \
  | tar tzf - | head    # list entries without extracting
```

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
