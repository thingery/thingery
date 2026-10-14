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
never in the repo, never in chat. The operator machine that holds the key (and
decrypts during drills) should be disk-encrypted.

**Recovery key (recommended).** Generate a second keypair on a *different*
operator account/machine, store it offline and separate from the primary
(second vault entry or printed in a physical safe), and encrypt every backup
to both recipients. The script supports this natively (THI-163): set
`RECOVERY_PUBKEY=age1...` in `/etc/thingery-backup.env` and every backup is
encrypted to both keys automatically — no script edit needed, and the log
prints `recovery recipient active` on each run. Cost is ~100
bytes per file; the win is that losing one secret no longer means losing all
backups. Rotate on event (suspected compromise, custody change) — age keys
have no calendar rotation requirement.

**Key rotation procedure.** Generate the new keypair on the operator machine →
encrypt to **both** keys (`-r OLD -r NEW`) for a transition window of ≥45 days
(local 14 d + offsite 30 d + margin) → verify a decrypt with NEW via the drill
→ drop OLD from the script → keep OLD in the manager until the last OLD-only
ciphertext has aged out of both retention windows, then destroy it.

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
# The age PRIVATE key lives offsite (operator password manager), never on the VPS.
# Optional second recipient (recovery key): set RECOVERY_PUBKEY in
# /etc/thingery-backup.env and every backup is encrypted to both keys (THI-163).
set -uo pipefail
umask 077

PUBKEY='age1ln7rs3dymzlgvtmtvj4kaly598ncpt80m3mxjlnndzw84tfgqehszz22vk'
# ^ production key (2026-10-14, THI-116). Public — not secret. The copy on the
# VPS (/usr/local/bin/thingery-backup) must match this line exactly; a monthly
# drill decrypt failure or a diff here = possible key substitution, treat as a
# security incident.
BACKUP_DIR=/var/backups
DATE=$(date +%F)
FAIL=0

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

# 0. Optional config: /etc/thingery-backup.env (root:root 0600, VPS only) may set
#    RECOVERY_PUBKEY (second age recipient, THI-163), RCLONE_* (offsite push),
#    HEALTHCHECK_URL (dead-man's switch). Sourced BEFORE encryption so a recovery
#    recipient applies to today's files immediately.
if [ -r /etc/thingery-backup.env ]; then . /etc/thingery-backup.env; fi
RECIPIENTS=(-r "$PUBKEY")
if [ -n "${RECOVERY_PUBKEY:-}" ]; then
  RECIPIENTS+=(-r "$RECOVERY_PUBKEY")
  log "recovery recipient active (encrypting to both keys)"
fi

DB_FILE="$BACKUP_DIR/thingery-$DATE.sql.gz.age"
IMG_FILE="$BACKUP_DIR/thingery-images-$DATE.tar.gz.age"

# 1. Database: pg_dump | gzip | age -> atomic rename (no truncated .age left behind)
DB_CID=$(docker ps -qf name=thingery-db)
if [ -n "$DB_CID" ] && docker exec "$DB_CID" pg_dump -U thingery thingery \
     | gzip | age "${RECIPIENTS[@]}" > "$DB_FILE.part"; then
  if [ -s "$DB_FILE.part" ] && [ "$(stat -c %s "$DB_FILE.part")" -ge 1024 ]; then
    # size floor: a truncated-but-nonempty dump must not log OK (THI-120 nit)
    mv "$DB_FILE.part" "$DB_FILE"
    log "db OK $DB_FILE $(stat -c %s "$DB_FILE")B"
  else log "db FAIL empty output"; rm -f "$DB_FILE.part"; FAIL=1; fi
else
  log "db FAIL pg_dump|gzip|age pipe"; rm -f "$DB_FILE.part"; FAIL=1
fi

# 2. Images: tar runs INSIDE the app container, piped straight into age
#    (plaintext images never land on VPS disk; old flow copied them via img.tmp)
APP_CID=$(docker ps -qf name=app)
if [ -n "$APP_CID" ] && docker exec "$APP_CID" tar czf - -C /app/uploads . \
     | age "${RECIPIENTS[@]}" > "$IMG_FILE.part"; then
  if [ -s "$IMG_FILE.part" ]; then
    mv "$IMG_FILE.part" "$IMG_FILE"
    log "img OK $IMG_FILE $(stat -c %s "$IMG_FILE")B"
  else log "img FAIL empty output"; rm -f "$IMG_FILE.part"; FAIL=1; fi
else
  log "img FAIL tar|age pipe"; rm -f "$IMG_FILE.part"; FAIL=1
fi

# 3. Local retention: 14 days (encrypted files; old plaintext names are untouched here)
find "$BACKUP_DIR" -name 'thingery-*.age' -mtime +14 -delete
log "local prune (14d) done"

# 4. Offsite push - gated on /etc/thingery-backup.env (sourced in step 0).
#    Expected vars: RCLONE_REMOTE="name:path" (+ RCLONE_CONFIG_<NAME>_* creds),
#    optional RCLONE_KEEP_DAYS (default 30). No-op with a log line until configured.
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

# 5. Dead-man's-switch ping (optional; HEALTHCHECK_URL in /etc/thingery-backup.env).
#    Bare URL = full success; /skip = local OK but offsite not configured; /fail = any FAIL.
#    Endpoint is a CEO/vendor decision (e.g. healthchecks.io-style); unset = no ping.
if [ -n "${HEALTHCHECK_URL:-}" ]; then
  if [ "$FAIL" -ne 0 ]; then SIG="/fail"
  elif [ -z "${RCLONE_REMOTE:-}" ]; then SIG="/skip"
  else SIG=""; fi
  curl -fsS -m 10 --retry 2 "${HEALTHCHECK_URL}${SIG}" >/dev/null 2>&1 \
    && log "healthcheck ping OK (${SIG:-success})" \
    || { log "healthcheck ping FAIL"; FAIL=1; }
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

Offsite hardening requirements (security review THI-120 F2): use a **dedicated
bucket and a dedicated S3 key scoped to that bucket only**; prefer **write-only
credentials (no delete)** with retention enforced by a provider-side lifecycle
rule instead of the script's `rclone delete` — then VPS compromise cannot
destroy offsite history. If the provider supports it, bucket versioning or
object-lock adds another layer. If client-side pruning stays, scope it to our
files only: `rclone delete --min-age "${RCLONE_KEEP_DAYS:-30}d" --include 'thingery-*.age' "$RCLONE_REMOTE"`.

Optionally set `HEALTHCHECK_URL` in the same env file (dead-man's-switch ping:
bare URL on full success, `/skip` when offsite is not configured, `/fail` on
any failure; endpoint is an operator choice, e.g. a healthchecks.io-style
service). Until then, a daily log check stands in for alerting.

> Status 2026-10-14: CEO decision — **local-only for now**; revisit offsite when
> the service has real users. The push stays an env-gated no-op until then.

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
   rm dump.sql.gz                                  # delete the plaintext copy after the drill
   ```
   (Or skip the local plaintext file entirely and stream end-to-end in step 5:
   `age -d -i <key> <file>.age | gunzip -c | ssh <vps> 'docker exec -i …'`.)

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
nightly backup as broken until fixed and escalate. A decrypt failure during the
drill can also mean the VPS script's public key was substituted — diff the
`PUBKEY=` line against this doc and treat a mismatch as a security incident.

Checklist line: after every drill confirm **no non-`.age` thingery files exist**
in `/var/backups` (`sudo find /var/backups -maxdepth 1 -name 'thingery-*' ! -name '*.age'`).
Ad-hoc pre-deploy dumps must pipe straight into `age` too — never leave a
plaintext twin: `docker exec $(docker ps -qf name=thingery-db) pg_dump -U thingery thingery | gzip | age -r <pubkey> > /var/backups/thingery-predeploy-<tag>.sql.gz.age`.

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
The workflow applies `db/schema.sql` (idempotent) **before** rebuilding — expand-phase
migrations are additive, so the running containers ignore them while the new code may
require the new columns; applying first avoids a window where authenticated traffic hits
`column ... does not exist` errors. It also exports `GIT_COMMIT`/`BUILD_TIME` before
building, so `/healthz` reports the deployed commit. Manual equivalent:

```bash
cd /opt/thingery && git pull && \
  docker compose -f docker-compose.prod.yml exec -T db \\
    psql -U thingery -d thingery -v ON_ERROR_STOP=1 < db/schema.sql && \
  GIT_COMMIT=$(git rev-parse HEAD) BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ) \\
  docker compose -f docker-compose.prod.yml up -d --build
```

Verify the deployed build info (must match `git rev-parse HEAD` in `/opt/thingery`):

```bash
curl -s https://thingery.dev/healthz   # {"ok":true,...,"version":"…","commit":"…","buildTime":"…"}
```
If `commit` reports `"unknown"`, the deploy skipped the build args — rebuild with the
exports above. The site footer shows the same version + short commit.

### Upgrade notes (breaking deploys)

- **Session hardening (THI-115):** the first deploy after this change ships a new
  cookie format (`sellerId.iat.mac` with a server-side 30-day expiry and a
  per-seller `session_epoch` in the MAC) — **all sessions are invalidated once**;
  every logged-in user simply logs in again. The app also now refuses to start
  when `NODE_ENV=production` and `SESSION_SECRET` is unset, so confirm `.env`
  sets `SESSION_SECRET` (it does if you followed §3) before upgrading. Rollback
  is `git revert` + users log in again — same one-time effect.

### 5.1 Image pipeline: post-deploy spot-check, backfill, purge (THI-156/THI-166)

Run this after any deploy that touches `src/images.ts`. Blast radius for image-pipeline
deploys is the app container only (no schema/compose changes); rollback = rebuild at the
previous commit.

1. **Both-path fresh upload (F3).** Upload a large legal image (~49 MP, ≤ 5 MB) with EXIF/GPS
   twice: via `/mcp` `add_item_image` (API key auth) and via `POST /api/items/:id/images`
   (session cookie, raw body). CI tests glibc; prod runs musl — never rely on one path.
   Fixture: `python3 -c` with PIL — 7000×7000 gradient, `Image.Exif()` with a marker string
   and a GPS IFD (rational values as floats), saved as JPEG + WebP.
2. **Assert the stored copies are clean.** Download the returned `/img/items/...` URLs and
   verify: dims ≤ 2000, same-family format, zero EXIF/GPS/XMP/ICC, marker string absent
   from raw bytes. PIL: `im.getexif()`, `im.get_ifd(0x8825)`, `im.info`.
3. **RSS watch (Security N2).** During each upload sample
   `docker stats --no-stream --format "{{.MemUsage}}" thingery-app-1` (~1 Hz) and read the
   kernel high-water mark after: `docker exec thingery-app-1 awk '/VmHWM/{print $2}' /proc/1/status`.
   Record baseline / peak / settle. Also note `docker inspect -f '{{.HostConfig.Memory}}'
   thingery-app-1` (no cap → semaphore + `sequentialRead` are the bounds on the 2 GB box).
   2026-10-14 baseline (49 MP uploads): VmRSS ~98 MB, peaks 152 MB (JPEG) / 156 MB (WebP),
   settle ~106 MB, request times 1.0 s / 0.7 s.
4. **Backfill existing uploads** (idempotent; skips already-clean files). The runtime image
   has no `scripts/` or dev deps, so run a one-off musl container matching prod, with the
   uploads volume nested under a host-persisted backup dir (the script writes originals to a
   *sibling* of the uploads dir — outside the served tree — before overwriting):

   ```bash
   sudo mkdir -p /var/backups/thi166
   docker run --rm \
     -v /var/backups/thi166:/work \
     -v thingery_uploads:/work/uploads \
     -e UPLOADS_DIR=/work/uploads \
     -v /opt/thingery:/src:ro \
     node:22-alpine sh -c "cp -r /src /app2 && cd /app2 && npm ci --no-audit --no-fund >/dev/null 2>&1 && npx tsx scripts/reencode-existing-uploads.ts"
   ```

   Report the printed counts (processed/skipped/failed). A backup dir `uploads-backup-<date>/`
   is created on the host at `/var/backups/thi166/` only when at least one file is re-encoded.
   The empty `uploads/` dir docker creates there is just the volume mountpoint — ignore it.
5. **Purge (F8b).** Backups are kept ≤ 7 days; root crontab:

   ```bash
   0 5 * * * find /var/backups/thi166 -maxdepth 1 -type d -name "uploads-backup-*" -mtime +7 -exec rm -rf {} +
   ```

   Scope is strictly `uploads-backup-*` under `/var/backups/thi166` — never touch the
   age-encrypted nightly archives (`thingery-*.age`, key off-box).

## 6. Scaling later

- Bigger VPS: resize, reboot, done.
- Managed database: change `DATABASE_URL`, done.
- Watch disk: `df -h` — item images are blobs stored in the app container's
  `/app/uploads` (nightly backup in section 4), so disk grows with uploads;
  the DB itself stays small.
