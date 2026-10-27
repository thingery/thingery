#!/bin/bash
# thingery-llm-guard - LLM provider balance/failure detection
# (docs/deploy-vps.md section 6, THI-282).
#
# Why this exists: on 2026-10-21 the z.ai company account balance hit zero
# and prod chat failed SILENTLY for company-key users (THI-276 audit): every
# inference call returned 429 code 1113 "Insufficient balance" and nobody
# was alerted for days. This guard makes that signature loud:
#
#   1. Probes the SAME endpoint/model/key the app container uses (one
#      1-token chat completion; config is read from the running container's
#      env so the API key never lands on the VPS disk).
#   2. Independently counts chat_turn_usage outcome=error lines in the app
#      logs - catches failures a healthy probe misses (tool-loop breakage).
#   3. Keeps state in /var/lib/thingery-llm-guard: alerts on FIRST
#      occurrence (+ at most one reminder per ALERT_REPEAT_HOURS), not on
#      every request, and logs a single recovery line when health returns.
#   4. Notification: env-gated webhook POST (ROUTINE_WEBHOOK_URL) - a no-op
#      with a log line until configured, same posture as the offsite push in
#      thingery-backup. Detection + status file are always written regardless.
#
# Cron (root crontab):
#   */5 * * * * /usr/local/bin/thingery-llm-guard >> /var/log/thingery-llm-guard.log 2>&1
#
# Optional config: /etc/thingery-llm-guard.env (root:root 0600, VPS only):
#   ROUTINE_WEBHOOK_URL=    # push target (Paperclip routine webhook or any alert endpoint); unset = log only
#   ROUTINE_WEBHOOK_TOKEN=  # bearer token for the above
#   ALERT_REPEAT_HOURS=24   # reminder cadence while a failure persists
#   STREAK_THRESHOLD=5      # outcome=error lines in window that trip llm_error_streak
#   STREAK_WINDOW_SEC=900   # lookback window for the streak count
#   PROBE_TIMEOUT_SEC=20
#
# Test modes (never touch the production state/status files):
#   --test             normal run, but state goes to state.test / status.test
#   --test-signature   inject the balance-exhausted signature (probe skipped) - drills the full alert path
#   PROBE_URL / PROBE_MODEL / PROBE_KEY env overrides are honored in test modes only.
#
# HARD RULE (docs/security.md): never log the API key; provider bodies are
# reduced to error.code + a 300-char error.message before logging.

set -u

CONF_FILE=${LLM_GUARD_CONF_FILE:-/etc/thingery-llm-guard.env}
STATE_DIR=${LLM_GUARD_STATE_DIR:-/var/lib/thingery-llm-guard}

ALERT_REPEAT_HOURS=24
STREAK_THRESHOLD=5
STREAK_WINDOW_SEC=900
PROBE_TIMEOUT_SEC=20
ROUTINE_WEBHOOK_URL=""
ROUTINE_WEBHOOK_TOKEN=""

# shellcheck disable=SC1090
[ -f "$CONF_FILE" ] && . "$CONF_FILE"

TEST=0
FORCE_SIGNATURE=0
for arg in "$@"; do
  case "$arg" in
    --test) TEST=1 ;;
    --test-signature) TEST=1; FORCE_SIGNATURE=1 ;;
    *) echo "usage: thingery-llm-guard [--test|--test-signature]" >&2; exit 2 ;;
  esac
done

mkdir -p "$STATE_DIR" && chmod 700 "$STATE_DIR"
SUFFIX=""
[ "$TEST" = 1 ] && SUFFIX=".test"
STATE_FILE="$STATE_DIR/state$SUFFIX"
STATUS_FILE="$STATE_DIR/status$SUFFIX"

# One run at a time; a second concurrent run exits quietly (no double alert).
# (flock is Linux; where absent the lock is skipped - single-host cron overlap
# is also bounded by the short runtime.)
exec 9>"$STATE_DIR/.lock"
if command -v flock >/dev/null 2>&1 && ! flock -n 9; then
  echo "$(date -u '+%FT%TZ') [llm-guard] another run holds the lock - exiting"
  exit 0
fi

now_s=$(date -u +%s)
now_iso=$(date -u +%FT%TZ)
host=$(hostname -s)

# --- helpers ------------------------------------------------------------------

# read one key from the state file (empty string when absent)
st() {
  if [ -f "$STATE_FILE" ]; then
    grep -m1 "^$1=" "$STATE_FILE" | cut -d= -f2-
  fi
}

# atomic rewrite: $1=file, rest=lines
write_file() {
  f=$1; shift
  tmp=$(mktemp "$STATE_DIR/.tmp.XXXXXX") || return 1
  printf '%s\n' "$@" > "$tmp"
  mv "$tmp" "$f"
}

log() { echo "$(date -u '+%FT%TZ') [llm-guard] $*"; }

# fire the webhook; $1=kind, $2=class, $3=detail, $4=http, $5=streak, $6=model.
# Returns 0 for delivered (or log-only when unconfigured); 1 on POST failure
# (the alert epoch is then NOT advanced, so the next run retries).
notify() {
  if [ -z "$ROUTINE_WEBHOOK_URL" ]; then
    log "notify: log-only (ROUTINE_WEBHOOK_URL not configured): kind=$1 class=$2"
    return 0
  fi
  payload=$(python3 -c '
import json, sys
kind, cls, detail, http, streak, model, host, ts, test = sys.argv[1:10]
print(json.dumps({"kind": kind, "class": cls, "detail": detail, "http": http,
                  "streak_errors": int(streak), "model": model, "host": host,
                  "ts": ts, "test": test == "1"}))
' "$1" "$2" "$3" "$4" "$5" "$6" "$host" "$now_iso" "$TEST") || return 1
  if [ -n "$ROUTINE_WEBHOOK_TOKEN" ]; then
    code=$(curl -sS -m 10 -o /dev/null -w '%{http_code}' -X POST "$ROUTINE_WEBHOOK_URL" \
      -H "Authorization: Bearer $ROUTINE_WEBHOOK_TOKEN" \
      -H "Content-Type: application/json" -d "$payload" 2>/dev/null) || code=000
  else
    code=$(curl -sS -m 10 -o /dev/null -w '%{http_code}' -X POST "$ROUTINE_WEBHOOK_URL" \
      -H "Content-Type: application/json" -d "$payload" 2>/dev/null) || code=000
  fi
  case "$code" in
    2*) return 0 ;;
    *) log "notify: webhook POST failed (http=$code)"; return 1 ;;
  esac
}

# --- 1. locate the app container + read its LLM config -------------------------

cid=$(docker ps --filter name=thingery-app --format '{{.ID}}' | head -1)
probe_url=""; api_key=""; model=""

if [ -n "$cid" ]; then
  cenv=$(docker inspect "$cid" --format '{{range .Config.Env}}{{println .}}{{end}}')
  probe_url=$(printf '%s\n' "$cenv" | grep -m1 '^LLM_API_URL=' | cut -d= -f2-)
  api_key=$(printf '%s\n' "$cenv" | grep -m1 '^LLM_API_KEY=' | cut -d= -f2-)
  model=$(printf '%s\n' "$cenv" | grep -m1 '^LLM_MODEL=' | cut -d= -f2-)
fi

# Same default as src/chat.ts when LLM_MODEL is unset.
[ -z "$model" ] && model="gpt-4o-mini"

if [ "$TEST" = 1 ] && [ -n "${PROBE_URL:-}" ]; then
  probe_url=$PROBE_URL
  [ -n "${PROBE_MODEL:-}" ] && model=$PROBE_MODEL
  api_key=${PROBE_KEY:-test-key}
fi

# --- 2. classify this run -------------------------------------------------------

probe_class="ok"
probe_detail=""
http="-"
streak=0
skip_reason=""

if [ "$FORCE_SIGNATURE" = 1 ]; then
  probe_class="llm_balance_exhausted"
  probe_detail="TEST SIGNATURE INJECTED (drill) - no probe was sent"
  http="429"
elif [ -z "$cid" ]; then
  probe_class="app_down"
  probe_detail="app container not found (docker ps name=thingery-app) - cannot probe"
elif [ -z "$api_key" ] || [ -z "$probe_url" ]; then
  skip_reason="company key not configured (LLM_API_KEY/LLM_API_URL absent) - probe skipped"
else
  body_file="$STATE_DIR/probe.body.$$"
  http=$(curl -sS -m "$PROBE_TIMEOUT_SEC" -o "$body_file" -w '%{http_code}' \
    -X POST "$probe_url" \
    -H "Authorization: Bearer $api_key" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"$model\",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}],\"max_tokens\":1}" 2>/dev/null) || http="000"
  err_msg=""
  if [ -s "$body_file" ]; then
    err_msg=$(python3 -c '
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    e = d.get("error") or {}
    print((str(e.get("code", "")) + " " + str(e.get("message", ""))).strip().replace("\n", " "))
except Exception:
    pass
' "$body_file" | head -c 300)
  fi
  rm -f "$body_file"

  case "$http" in
    2*)
      probe_class="ok"
      ;;
    000)
      probe_class="llm_provider_fail"
      probe_detail="probe curl error (timeout/DNS/conn) model=$model url_host=$(printf '%s' "$probe_url" | sed -E 's#(https?://[^/]+).*#\1#')"
      ;;
    402 | 429)
      if printf '%s' "$err_msg" | grep -qiE '1113|insufficient balance|recharge|resource package'; then
        probe_class="llm_balance_exhausted"
      else
        probe_class="llm_provider_fail"
      fi
      probe_detail="http=$http provider_error=\"$err_msg\" model=$model"
      ;;
    401 | 403)
      probe_class="llm_auth_error"
      probe_detail="http=$http provider_error=\"$err_msg\" model=$model"
      ;;
    *)
      probe_class="llm_provider_fail"
      probe_detail="http=$http provider_error=\"$err_msg\" model=$model"
      ;;
  esac

  # Error streak in the app logs - only when the probe is healthy (a failed
  # probe already covers the shared root cause; this catches tool-loop
  # breakage where single calls succeed).
  if [ "$probe_class" = "ok" ]; then
    streak=$(docker logs --since "${STREAK_WINDOW_SEC}s" "$cid" 2>/dev/null \
      | grep -F '"type":"chat_turn_usage"' | grep -cF '"outcome":"error"' || true)
    case "$streak" in '' | *[!0-9]*) streak=0 ;; esac
    if [ "$streak" -ge "$STREAK_THRESHOLD" ]; then
      probe_class="llm_error_streak"
      probe_detail="$streak chat_turn_usage outcome=error lines in ${STREAK_WINDOW_SEC}s (>= $STREAK_THRESHOLD) while probe is healthy"
    fi
  fi
fi

# --- 3. stateful first-occurrence alerting --------------------------------------

prev_status=$(st prev_status)
prev_class=$(st alerting_class)
prev_since=$(st alerting_since)

# carry alert epochs of other classes across rewrites
carry=""
if [ -f "$STATE_FILE" ]; then
  carry=$(grep '^last_alert_epoch_' "$STATE_FILE" 2>/dev/null | grep -v "^last_alert_epoch_$probe_class=" || true)
fi

action="none"

if [ "$probe_class" = "ok" ]; then
  status="ok"
  note="probe healthy"
  [ -n "$skip_reason" ] && note="$skip_reason"
  if [ "$prev_status" = "alerting" ]; then
    action="recovered"
    log "RECOVERED from ${prev_class:-?} (was alerting since ${prev_since:-?}) - $note http=$http"
    notify "llm_guard_recovery" "${prev_class:-?}" "recovered at $now_iso (was alerting since ${prev_since:-unknown})" "$http" "$streak" "$model" \
      || log "recovery notice not delivered (webhook failure above)"
  fi
  write_file "$STATE_FILE" $carry "prev_status=ok" "alerting_class=" "alerting_since=" \
    "last_change=$now_iso" "last_probe=$http" "streak_errors=$streak" "test=$TEST"
  write_file "$STATUS_FILE" "status=ok" "class=-" "note=$note" "last_change=$now_iso" \
    "last_probe=$http" "last_probe_ts=$now_iso" "model=$model" "streak_errors=$streak" "test=$TEST"
else
  status="alerting"
  if [ "$prev_status" = "alerting" ] && [ "$prev_class" = "$probe_class" ]; then
    since=$prev_since
  else
    since=$now_iso
  fi
  last_alert=$(st "last_alert_epoch_$probe_class")
  due=1
  if [ -n "$last_alert" ] && [ "$((now_s - last_alert))" -lt "$((ALERT_REPEAT_HOURS * 3600))" ]; then
    due=0
  fi
  if [ "$due" = 1 ]; then
    if [ "$prev_status" = "alerting" ] && [ "$prev_class" = "$probe_class" ]; then
      action="remind"
    else
      action="alert"
    fi
    if notify "llm_guard_alert" "$probe_class" "$probe_detail" "$http" "$streak" "$model"; then
      last_alert=$now_s
    else
      last_alert=${last_alert:-0}
    fi
    log "ALERT [$action] class=$probe_class since=$since http=$http streak=$streak detail=$probe_detail"
  else
    action="quiet"
  fi
  write_file "$STATE_FILE" $carry "prev_status=alerting" "alerting_class=$probe_class" \
    "alerting_since=$since" "last_change=$now_iso" "last_alert_epoch_$probe_class=$last_alert" \
    "last_probe=$http" "streak_errors=$streak" "test=$TEST"
  write_file "$STATUS_FILE" "status=alerting" "class=$probe_class" "detail=$probe_detail" \
    "since=$since" "last_change=$now_iso" "last_probe=$http" "last_probe_ts=$now_iso" \
    "model=$model" "streak_errors=$streak" "test=$TEST"
fi

log "run status=$status class=$probe_class http=$http streak=$streak action=$action test=$TEST"
exit 0
