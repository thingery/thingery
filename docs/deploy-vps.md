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

> **Pre-2026-10-15 backups contain plaintext API keys (THI-158).** The
> `sellers.api_key` column (plaintext keys) was dropped from the schema on
> 2026-10-15; the first nightly backup taken after the drop is
> `thingery-2026-10-15.sql.gz.age`. Any restore from an **older** backup puts
> plaintext keys back into the restored database — the scratch container from a
> drill of an old backup therefore holds every seller's key, and such a restored
> database must never be exposed or promoted to production. Drills should use
> post-drop backups whenever one exists; restoring an older backup is allowed
> only with that same care (delete the scratch container immediately after,
> exactly as step 7 requires). This warning retires with the 14-day retention
> window (last plaintext-keyed backup expires 2026-10-29).

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

Deploys are automated via the `deploy.yml` workflow (on push to `main`, plus a manual
`workflow_dispatch` trigger for no-op/re-deploys) once you set the
repo variables `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_ENABLED=true`, and the
`DEPLOY_SSH_KEY` secret in the protected `production` environment (§5.0).
`DEPLOY_ENABLED` is the arm switch: while it is unset the job skips on every push, and
deploys fall back to the manual equivalent below. The workflow itself only opens the
SSH session — the deploy steps execute server-side via the forced-command wrapper
`/usr/local/bin/thingery-deploy.sh` (§5.0). It applies `db/schema.sql`
(idempotent) **before** rebuilding — expand-phase
migrations are additive, so the running containers ignore them while the new code may
require the new columns; applying first avoids a window where authenticated traffic hits
`column ... does not exist` errors. It also exports `GIT_COMMIT`/`BUILD_TIME` before
building, so `/healthz` reports the deployed commit. Manual equivalent (run as the
`deploy` user — it owns `/opt/thingery` — e.g. `sudo -u deploy bash -c '…'` over the
operator SSH session):

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

Post-deploy smoke tests that create seller accounts in production must follow
[ops-smoke-policy.md](ops-smoke-policy.md): disposable `ops+thiXXX+…@thingery.test`
accounts, deleted before the run ends.

### 5.0 Automated deploy credentials (one-time, THI-223; hardened per THI-224)

The trust path is GitHub Actions → SSH → `deploy@<VPS_IP>`, restricted to the documented
deploy steps by two server/repository-side controls:

- **Forced command (THI-224 F3):** the deploy key's `authorized_keys` line forces
  `/usr/local/bin/thingery-deploy.sh` — a root-owned server-side script containing
  exactly the documented deploy steps. GitHub controls *when* deploys run; the server
  controls *what* a deploy can do. The workflow's inline script is just an explanatory
  echo; a stolen key (or a maliciously edited workflow file) still can only trigger the
  documented deploy.
- **Environment-scoped secret (THI-224 F1):** `DEPLOY_SSH_KEY` lives only in the
  protected `production` GitHub environment whose deployment-branch policy allows
  `main` only, so a `workflow_dispatch` from an unreviewed feature ref cannot resolve
  the key (the job fails at environment resolution, server-side enforced).

Setup:

1. **VPS: dedicated deploy user.** The automated key must never land on the operator
   account — it has passwordless sudo, and an automated credential must not be
   passwordless root.

   ```bash
   ssh thingery-vps
   sudo adduser --disabled-password --gecos '' deploy   # no sudo, no other keys
   sudo usermod -aG docker deploy                       # just enough to run compose
   sudo chown -R deploy:deploy /opt/thingery            # app tree owner
   ```

2. **VPS: the deploy wrapper** (canonical deploy steps, root-owned so only the
   operator can change them):

   ```bash
   sudo install -o root -g root -m 0755 thingery-deploy.sh /usr/local/bin/thingery-deploy.sh
   ```

   Contents — the same steps as the manual equivalent in §5, ending with a
   `thingery-deploy: done at $GIT_COMMIT` marker (the workflow log shows this output,
   proving the wrapper ran):

   ```bash
   #!/bin/bash
   set -euo pipefail
   cd /opt/thingery
   git pull --ff-only
   docker compose -f docker-compose.prod.yml exec -T db \
     psql -U thingery -d thingery -v ON_ERROR_STOP=1 < db/schema.sql
   export GIT_COMMIT=$(git rev-parse HEAD)
   export BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)
   docker compose -f docker-compose.prod.yml up -d --build
   docker image prune -f
   echo "thingery-deploy: done at $GIT_COMMIT"
   ```

3. **Operator machine: dedicated keypair** (never a personal key). The private key
   goes straight into the `production` environment secret and the local copy is
   destroyed — the secret is the only place the private key needs to live (rotation =
   fresh keypair, never reuse):

   ```bash
   ssh-keygen -t ed25519 -f thingery_deploy -N '' -C 'thingery-deploy-github-actions'
   gh secret set DEPLOY_SSH_KEY --env production -R thingery/thingery < thingery_deploy \
     && rm thingery_deploy
   ```

   Create the protected environment first (one-time; repo admin):

   ```bash
   curl -X PUT -H "Authorization: Bearer $(gh auth token)" \
     https://api.github.com/repos/thingery/thingery/environments/production \
     -d '{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}'
   curl -X POST -H "Authorization: Bearer $(gh auth token)" \
     https://api.github.com/repos/thingery/thingery/environments/production/deployment-branch-policies \
     -d '{"name":"main"}'
   ```

4. **VPS: install the public key with `restrict` + the forced command** — `restrict`
   disables PTY, agent/X11/port forwarding and user-rc; exec-channel only, which is
   exactly what `appleboy/ssh-action` uses. Verified in prod: exec works and runs the
   wrapper; `ssh -tt` is refused (`PTY allocation request failed`).

   ```bash
   echo "restrict,command=\"/usr/local/bin/thingery-deploy.sh\" $(cat thingery_deploy.pub)" \
     | sudo tee /home/deploy/.ssh/authorized_keys
   sudo chown deploy:deploy /home/deploy/.ssh/authorized_keys
   sudo chmod 600 /home/deploy/.ssh/authorized_keys
   ```

   ⚠️ From this moment **any use of this key performs a deploy** — never use it for
   ad-hoc SSH; it exists only inside the GitHub environment secret.

5. **Repo variables** (set `DEPLOY_ENABLED` last — it arms the workflow):

   ```bash
   gh variable set DEPLOY_HOST -R thingery/thingery --body <VPS_IP>  # public via DNS anyway
   gh variable set DEPLOY_USER -R thingery/thingery --body deploy
   gh variable set DEPLOY_ENABLED -R thingery/thingery --body true
   ```

Design notes (Security review THI-224 — conditional approval, F1–F5 applied):

- **No `from=` restriction** (confirmed): GitHub-hosted runners egress from the large,
  changing Azure ranges published at `api.github.com/meta` (hundreds of CIDRs) —
  maintaining that list in `authorized_keys` is a liability, not a control.
- **Forced command required** (overriding the earlier inline-script trade-off): with
  zero required reviews on `main`, an inline workflow script would be unreviewed
  arbitrary-exec-as-`deploy`; the wrapper bounds even a stolen key to the documented
  steps.
- **Docker group is host-root equivalent** (any member can `docker run -v /`). That is
  inherent to compose-based deploys; the mitigations are the dedicated non-sudo user,
  the forced-command wrapper, the environment-scoped secret, and fast revocation.
- Also shipped with THI-224: `appleboy/ssh-action` SHA-pinned to
  `823bd89e131d8d508129f9443cad5855e9ba96f0` (v1.2.4), `permissions: contents: read`,
  and a `deploy` concurrency group that never cancels mid-run.

**Regression checks (run after setup, and after any authorized_keys/environment
change):**

- **F1 (secret unreachable from unreviewed refs):** with `DEPLOY_ENABLED=true`,
  `gh workflow run deploy.yml --ref <feature-branch>` → the job must fail at
  environment resolution (`production` is restricted to `main`) and no deploy steps
  may run (VPS `git -C /opt/thingery rev-parse HEAD` unchanged).
- **F3 (forced command active):** the deploy job log must show the *wrapper's* output
  (`thingery-deploy: done at <sha>`), never the client-sent script's — proving the
  server overrides whatever the workflow sends. (The private key never leaves the
  GitHub secret, so there is no manual `ssh … 'id'` variant of this check; the
  dispatch log is the evidence.)

**Rotating the deploy key.** Generate a new keypair (step 3), replace the
`authorized_keys` line (step 4), `gh secret set DEPLOY_SSH_KEY --env production`
again, confirm with a `workflow_dispatch` deploy from `main`. During staging of THI-223
the key was rotated exactly this way (old fingerprint
`SHA256:wqn4Utx2Ut/PaZysOAfZwOgJ1MwlzNGfIgH5NOKsrn0` → current
`SHA256:MiisD8QGoWO6P9FB8vZdAn9kglpDj/uVEUi4ab7rY8E`).

**Revoking.** Delete the `restrict,command=… ssh-ed25519 … thingery-deploy-github-actions`
line from `/home/deploy/.ssh/authorized_keys` — the trust path dies immediately; running
services are unaffected, only future deploys stop. Optionally also
`gh variable delete DEPLOY_ENABLED` (workflow skips) and
`gh secret delete DEPLOY_SSH_KEY --env production` (removes the private key from
GitHub).

### Upgrade notes (breaking deploys)

- **Session hardening (THI-115):** the first deploy after this change ships a new
  cookie format (`sellerId.iat.mac` with a server-side 30-day expiry and a
  per-seller `session_epoch` in the MAC) — **all sessions are invalidated once**;
  every logged-in user simply logs in again. The app also now refuses to start
  when `NODE_ENV=production` and `SESSION_SECRET` is unset, so confirm `.env`
  sets `SESSION_SECRET` (it does if you followed §3) before upgrading. Rollback
  is `git revert` + users log in again — same one-time effect.

### 5.1 Image pipeline: post-deploy spot-check, backfill, purge (THI-156/THI-166, fixes THI-169)

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
   Measured in prod 2026-10-14 (THI-168, ~49 MP uploads): baseline VmRSS 109.5 MB, peaks
   VmHWM 172.3 MB (JPEG via `/mcp`) / 177.9 MB (WebP via HTTP path), settle ~130 MB, request
   times 0.48 s / 0.55 s. (An earlier "baseline" recorded here predated THI-168 and had not
   actually been measured in prod — treat this block as the measured reference.)
4. **Backfill existing uploads** (idempotent; skips already-clean files — including
   clean-dims JPEGs whose only dirt is a COM segment, detected at the byte level since THI-169).
   The runtime image has no `scripts/` or dev deps, so run a one-off musl container matching
   prod, with the uploads volume nested under a host-persisted backup dir (the script copies
   originals — fsync + size-verified — to a *sibling* of the uploads dir, outside the served
   tree, then swaps the sanitized file in with a same-directory atomic rename, so the
   volume/bind-mount filesystem boundary never sees a cross-device rename):

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
5. **Purge (F8b).** Backups are purged once they are ≥ 7 whole days old (GNU find ignores
   fractional days, so actual retention is 7–8 days; earlier revisions shipped `-mtime +7`,
   which deletes on day 8+ — corrected in THI-169). Root crontab:

   ```bash
   0 5 * * * find /var/backups/thi166 -maxdepth 1 -type d -name "uploads-backup-*" -mtime +6 -exec rm -rf {} +
   ```

   Scope is strictly `uploads-backup-*` under `/var/backups/thi166` — never touch the
   age-encrypted nightly archives (`thingery-*.age`, key off-box). **If the purge cron was
   already installed with `-mtime +7`, update the line above as an announced runbook change**
   (root crontab edit = prod change; DevOps executes, one line, `crontab -e` as root).

### 5.2 Chat limits (THI-180): hourly turn limiters + daily token budget

The `/chat` page is the only cost-bearing browser surface (each turn drives LLM calls).
Since THI-180 it is bounded twice — both live in `.env` and apply on **container restart**:

- **Hourly turn limiters** (per seller when logged in, per IP otherwise):
  `CHAT_TURNS_HOURLY_AUTHED` (default 60) and `CHAT_TURNS_HOURLY_ANON` (default 10).
  Hitting one returns a 429 with a friendly message and logs a `rate_limit` line
  (`route:"/api/chat"`, attributed `sellerId` or `ip`).
- **Process-wide daily LLM token budget**: `CHAT_DAILY_TOKEN_BUDGET` (default and
  current prod value **2,000,000** tokens/day, UTC-day rollover). When exhausted,
  `/api/chat` returns a 429 (`"Daily chat budget exhausted — please try again tomorrow."`);
  in-flight turns finish their current round first (bounded overshoot).

**Reading usage:** every LLM-backed turn logs two lines (stdout/container logs):
`chat_turn_usage` (THI-185 telemetry — per-call token pairs, tool stats, outcome,
duration) and `chat_usage` (THI-180 security event — `model`, `rounds`, `tokens_in`,
`tokens_out`, `daily_total`, `budget`, `usage_source` with seller/ip attribution).
`usage_source: "estimate_fallback"` means the provider omits/corrupts usage and the
numbers are conservative estimates. To watch the budget:

```bash
docker logs thingery-app 2>&1 | grep '"type":"chat_usage"' | tail -5
```

**Tuning:** pick the budget from `chat_usage` evidence (sum `tokens_in`+`tokens_out`
per day vs. provider billing). A restart is required for any change to apply, and
**the budget is in-memory — a restart resets `daily_total` to zero** (UTC-day rollover
otherwise). **Kill switch:** set `CHAT_DAILY_TOKEN_BUDGET=0` + restart to disable the
aggregate cap without a deploy (hourly limiters still apply). Rollback of the whole
feature = revert the PR; PR-A/B modules are inert without the routes wiring.

### 5.3 Stripe order flow: enabling payments (live mode) + rollback (THI-358)

The order flow (ADR 0003) ships with a **kill switch**: with `STRIPE_SECRET_KEY`
empty/unset the app answers `payments_not_configured`, listings stay buyable as
off-platform orders, and the Stripe webhook endpoint mounts as a 503 stub.
`docker-compose.prod.yml` passes the three `STRIPE_*` vars through from the VPS
`.env` (merged 2026-10-27, PR #142); before that the container never saw them.
Mode (test vs live) is derived **only** from the key prefix (`sk_test_` / `sk_live_`)
and is logged at boot:

```bash
docker compose -f docker-compose.prod.yml logs app 2>&1 | grep '\[config\] Stripe'
# → "Stripe payments enabled (live mode)" | "Stripe payments not configured … (kill switch)"
```

**Gate.** Live mode means real buyer payments and real Connect payouts. Flip only
after the board's legal/ToS sign-off is recorded (THI-357 confirmation card), and
only the Stripe account owner activates the account for live mode (business
profile, bank details, platform + Connect terms accepted in the Stripe dashboard).

**Flip (all on the VPS, secrets never leave the box or this file):**

1. Account owner (or operator acting on owner-provided values) appends to
   `/opt/thingery/.env` — `STRIPE_SECRET_KEY=sk_live_…` and
   `STRIPE_WEBHOOK_SECRET=whsec_…` (the signing secret of the **live-mode**
   webhook endpoint below). Leave `STRIPE_WEBHOOK_SECRET_PREVIOUS` unset unless
   rotating.
2. In the Stripe dashboard (live mode) register the webhook endpoint
   `https://thingery.dev/api/webhooks/stripe` with events:
   `checkout.session.completed`, `payment_intent.succeeded`, `charge.refunded`,
   `charge.dispute.created`, `charge.dispute.closed`, `transfer.created`,
   `transfer.updated`, `transfer.paid`, `account.updated`. Copy its signing
   secret into `STRIPE_WEBHOOK_SECRET`.
3. Recreate the app container (env changes need recreation, not rebuild):
   `cd /opt/thingery && docker compose -f docker-compose.prod.yml up -d`
4. Verify: boot log shows `(live mode)`; `curl -s https://thingery.dev/healthz`
   still `200`; a listing shows `payment_available: true` via the MCP order tools;
   the Stripe dashboard's webhook page shows signature-verified deliveries.

**Seller onboarding.** Sellers complete Stripe Connect onboarding via the app's
payout-setup flow once the platform account is live-enabled; `account.updated`
webhook events flip `sellers.stripe_onboarded_at` when `transfers` capability is
active. Confirm one seller onboarding before declaring live mode operational.

**Payout verification (seller-borne fees — THI-374).** Under the board decision
of 2026-10-27 (recorded via the THI-358 card `112e00aa` rejection) sellers bear
the Stripe processing fee: the seller transfer is **gross − fee**
(`src/stripe.ts` `sellerNetTransferCents`), with the fee read at payout time
from the PaymentIntent's latest-charge **balance transaction** (settlement
source of truth). Expected €1 verification order: buyer pays €1.00, seller
receives ~€0.73 (~€0.27 standard EEA fee) — that is correct behavior under the
model, not a bug; platform net cost per completed order is €0. When verifying a
payout (read-only, e.g. Stripe CLI `payment_intents retrieve … --expand
latest_charge.balance_transaction`): the transfer amount must equal
`bt.amount − bt.fee`, and `bt.amount` must equal the order gross (Security
THI-375 R1 invariant — a mismatch fails closed, never nets against a wrong
base). If the platform account settles in a currency ≠ the item currency,
payouts fail closed by design (currency invariant): the order stays
`payout_pending`, the deadline sweep retries, and the rule-7 alert fires —
that is a funding-setup signal (platform payout currency), not a code bug.
On refunded orders buyers are refunded in full and Stripe keeps the fee; the
platform's exposure per refunded order is bounded by that fee.

**Rollback (documented path back to the kill switch).** Comment out or remove the
`STRIPE_*` lines in `/opt/thingery/.env`, then
`cd /opt/thingery && docker compose -f docker-compose.prod.yml up -d`. The app
returns to `payments_not_configured` (new orders are off-platform), the webhook
endpoint returns to its 503 stub, and live-mode events stop verifying. Orders,
payment intents, and payouts already created in Stripe **remain real** — a
rollback stops new payments; it does not erase history or pending Connect
payouts. Rolling forward again = restore the same three lines (or rotate keys and
keep the old webhook secret in `STRIPE_WEBHOOK_SECRET_PREVIOUS` for zero-downtime
verification).

**Known gap.** No carrier (EasyPost) keys are configured on this deployment, so
`in_transit` orders cannot advance via carrier webhooks. Orders reach `delivered`
via buyer `confirm_receipt` (state machine T6/T13) and payouts release via buyer
`release_funds` (T17) or the dispute-window sweep (T16).

## 6. LLM guard: provider balance/failure detection (THI-282)

On 2026-10-21 the z.ai company account balance hit zero and prod chat failed
silently for days (THI-276 audit): every inference call returned `429 code 1113
"Insufficient balance"` and users saw a generic failure banner. The LLM guard
makes that signature loud. It runs on the VPS as root cron every 5 minutes
(`scripts/llm-guard.sh` in the repo is the source of truth):

1. **Probe**: one 1-token chat completion against the **same** endpoint, model
   and key the app container uses (read from the running container's env — the
   key never lands on the VPS disk). Classified: `llm_balance_exhausted`
   (429/402 with the 1113/balance/recharge signature), `llm_auth_error`
   (401/403), `llm_provider_fail` (anything else incl. timeouts), `app_down`.
2. **Error streak**: `chat_turn_usage` lines with `outcome=error` in the app
   logs (≥ 5 in 15 min while the probe is healthy → `llm_error_streak` — catches
   tool-loop breakage a single probe call misses).
3. **First-occurrence alerting**: state in `/var/lib/thingery-llm-guard/` — one
   alert per class on first occurrence, at most one reminder per 24 h while the
   failure persists, one recovery line when health returns. Never per-request.
   The current state is always readable in `/var/lib/thingery-llm-guard/status`
   (that file is what the 2×/day "Prod LLM guard alert" Paperclip routine reads
   when it wakes DevOps; alert → escalate to CEO per the recharge decision tree,
   THI-279).
4. **Optional push**: if `ROUTINE_WEBHOOK_URL` is set in
   `/etc/thingery-llm-guard.env`, each alert/recovery is also POSTed there
   (Paperclip routine webhook or any alert endpoint). No-op with a log line
   until configured — same posture as the offsite push in `thingery-backup`.

### Install (on the VPS, one-time)

```bash
# from a repo checkout that has scripts/llm-guard.sh (deployed to /opt/thingery):
install -o root -g root -m 750 /opt/thingery/scripts/llm-guard.sh /usr/local/bin/thingery-llm-guard
mkdir -p -m 700 /var/lib/thingery-llm-guard
# optional config (root:root 0600): webhook + thresholds — see header of the script
cat > /etc/thingery-llm-guard.env <<'EOF'
# ROUTINE_WEBHOOK_URL=
# ROUTINE_WEBHOOK_TOKEN=
EOF
chmod 600 /etc/thingery-llm-guard.env
sudo crontab -e   # add:
# */5 * * * * /usr/local/bin/thingery-llm-guard >> /var/log/thingery-llm-guard.log 2>&1
```

Cost note: a healthy probe consumes ~1 completion token of `glm-5.3-flash`
every 5 minutes (≈ 288 tiny calls/day, negligible; rejected calls cost nothing).

### Verify / drill (any time)

```bash
sudo /usr/local/bin/thingery-llm-guard              # manual run; log line shows class + action
sudo cat /var/lib/thingery-llm-guard/status        # current status (status=ok|alerting + class)
sudo tail -5 /var/log/thingery-llm-guard.log
sudo /usr/local/bin/thingery-llm-guard --test-signature   # drill the full alert path (writes status.test only)
```

`--test` / `--test-signature` never touch the production state file; the drill
alert is visible in the log and (if configured) the webhook, marked `test:true`.

**Rollback:** comment the crontab line (detection stops; nothing else depends on
it). The script reads but never modifies app/db/Caddy state.

## 6b. Daily sprint metrics snapshot (THI-394)

`scripts/daily-metrics.sh` (source of truth; see `docs/metrics.md`) aggregates
the sprint's three numbers — activation, search success, listing funnel — from
app-container analytics lines + read-only SQL, prints a 4-line summary, and
writes `metrics/daily-YYYY-MM-DD.json` (counts only, no PII). Snapshots are the
durable record because container logs rotate (§7).

Install once from the repo checkout at `/opt/thingery` (the script runs in
place; it needs no copy in `/usr/local/bin`):

```bash
sudo tee /etc/cron.d/thingery-daily-metrics >/dev/null <<'CRON'
# THI-394: daily sprint metrics snapshot (00:10 UTC). Read-only; writes /opt/thingery/metrics/.
10 0 * * * deploy cd /opt/thingery && scripts/daily-metrics.sh >> /var/log/thingery-daily-metrics.log 2>&1
CRON
sudo chmod 644 /etc/cron.d/thingery-daily-metrics
sudo touch /var/log/thingery-daily-metrics.log && sudo chown deploy:deploy /var/log/thingery-daily-metrics.log
```

(`deploy` owns `/opt/thingery` and is in the `docker` group — same posture as
the deploy flow in §5.)

**Verify:** `scripts/daily-metrics.sh` from `/opt/thingery` (expect a summary
block + a file under `metrics/`), then `tail -1 /var/log/thingery-daily-metrics.log`
the next day. Read any snapshot with
`cat /opt/thingery/metrics/daily-*.json | jq .`

**Rollback:** `sudo rm /etc/cron.d/thingery-daily-metrics` — collection stops;
existing snapshots stay. The script only reads containers/DB and writes under
`metrics/`; it never mutates app or Caddy state.

## 7. Logs: Caddy access log + container output

THI-312: every container's stdout/stderr goes to Docker's `json-file` driver with
rotation (`max-size: 10m`, `max-file: 3` per service — `docker-compose.prod.yml`),
and the Caddyfile has an access-log directive (`log` in the `thingery.dev` site
block), so each request logs client IP, method, path, status, and User-Agent as one
JSON line.

- **Read them:**
  `docker compose -f docker-compose.prod.yml logs caddy` (access log) and
  `... logs app` (startup + security events). `-f` follows, `--since 1h` limits.
- **Survives restarts:** a `docker compose restart`, a crash, or a VPS reboot keeps
  the same container and its log file (`restart: unless-stopped` reuses the
  container). A *recreate* (deploy or compose/config change) starts a fresh log
  file — the nightly DB backups remain the durable record of state; these logs are
  for operational debugging, not an audit trail.
- **Bounded disk:** at most 3 × 10 MB per service — no disk-fill risk on the small
  VPS disk.
- **Confidentiality:** access lines contain client IPs and user agents — operator
  data, not public data. Do not paste raw access logs into public issues; strip IPs
  first.

## 8. Scaling later

- Bigger VPS: resize, reboot, done.
- Managed database: change `DATABASE_URL`, done.
- Watch disk: `df -h` — item images are blobs stored in the app container's
  `/app/uploads` (nightly backup in section 4), so disk grows with uploads;
  the DB itself stays small.
