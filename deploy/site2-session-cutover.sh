#!/usr/bin/env bash
set -euo pipefail
umask 077
cd /opt/sites/2

expected_revision=8592f4a241d674d1c93741d2bc55d4913ac128a4
revision=$(docker inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' site2-api)
[[ "$revision" == "$expected_revision" ]]
[[ "$(stat -c '%a' .env)" == 600 ]]
audit=backups/security-session-cutover-20261106

read -r -d '' probe <<'NODE' || true
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createHmac } = require('node:crypto');
const { Client } = require('pg');
const mode = process.argv[1];
const base = 'http://127.0.0.1:3000';
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');

async function check(path, token, expectedStatus, photo = false) {
  const response = await fetch(base + path, {
    headers: token ? { authorization: 'Bearer ' + token } : {},
    signal: AbortSignal.timeout(8000),
  });
  assert.equal(response.status, expectedStatus);
  if (photo) {
    assert.match(response.headers.get('content-type'), /^image\/(jpeg|png|webp)$/);
    assert.match(response.headers.get('cache-control'), /no-store/);
  }
  await response.body?.cancel();
}

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    await db.query('BEGIN READ ONLY');
    const { rows: [staff] } = await db.query(
      "SELECT id, login, role FROM staff WHERE is_active AND role = 'ADMIN' ORDER BY id LIMIT 1",
    );
    const { rows: [photo] } = await db.query(
      'SELECT photo_object_key FROM services WHERE photo_object_key IS NOT NULL ORDER BY id DESC LIMIT 1',
    );
    assert(staff && photo);
    const sign = claims => {
      const header = encode({ alg: 'HS256', typ: 'JWT' });
      const body = encode({ sub: staff.id, login: staff.login, role: staff.role,
        exp: Math.floor(Date.now() / 1000) + 300, ...claims });
      const message = header + '.' + body;
      return message + '.' + createHmac('sha256', process.env.JWT_SECRET).update(message).digest('base64url');
    };
    const path = '/api/photos/' + photo.photo_object_key.split('/').map(encodeURIComponent).join('/');
    const legacy = sign({});
    const compatibility = mode === 'before' || mode === 'check';
    await check('/api/auth/me', legacy, compatibility ? 200 : 401);
    if (compatibility) {
      await check(path, legacy, 200, true);
      if (mode === 'before') process.stdout.write(legacy);
    } else {
      const old = fs.readFileSync(0, 'utf8');
      assert(old && old !== legacy);
      await check('/api/auth/me', old, 401);
      const automation = sign({ purpose: 'automation' });
      await check('/api/auth/me', automation, 200);
      await check(path, automation, 200, true);
      await check(path + '?token=' + automation, null, 401);
    }
  } finally {
    await db.end();
  }
}

main().catch(error => {
  console.error('API cutover probe failed:', error.code ?? error.name);
  process.exitCode = 1;
});
NODE

if [[ "${1:-}" == --check ]]; then
  docker exec site2-api node -e "$probe" check
  echo 'PASS: active API and stored raster photo'
  exit
fi
[[ $# == 0 ]]
date --iso-8601=seconds
now=$(date +%s)
start=$(date -d 'TZ="Europe/Moscow" 2026-11-06 20:00:00' +%s)
(( now >= start && now < start + 900 ))
test -f /run/reboot-required
test "$(readlink -f /boot/vmlinuz)" != "/boot/vmlinuz-$(uname -r)"
test -z "$(dpkg --audit)"
for unit in apt-daily.service apt-daily-upgrade.service; do
  if systemctl is-active --quiet "$unit"; then
    echo "Maintenance blocked by $unit" >&2
    exit 1
  fi
done
mkdir -- "$audit"
cp -p -- .env "$audit/env.previous"
cat /proc/sys/kernel/random/boot_id > "$audit/boot-id.previous"
db_id=$(docker inspect -f '{{.Id}}' site2-db)
docker exec site2-api node -e "$probe" before > "$audit/probe.jwt"
changed=0
rollback() {
  trap - ERR HUP INT TERM
  set +e
  rm -f -- "$audit/probe.jwt" "$audit/env.candidate"
  if [[ "$changed" == 1 ]]; then
    install -m 600 "$audit/env.previous" .env
    docker compose up -d --no-deps --no-build api
  fi
  echo 'Session cutover stopped; reboot not requested' >&2
  exit 1
}
trap rollback ERR HUP INT TERM
python3 - "$audit/env.candidate" <<'PY'
from pathlib import Path
import re
import secrets
import sys

env = Path(".env").read_text()
env, count = re.subn(r"(?m)^JWT_SECRET=.*$", "JWT_SECRET=" + secrets.token_hex(48), env)
if count != 1:
    sys.exit("Expected one active JWT_SECRET definition")
env = re.sub(r"(?m)^ACCEPT_LEGACY_SESSIONS=.*\n?", "", env)
Path(sys.argv[1]).write_text(env.rstrip("\n") + "\nACCEPT_LEGACY_SESSIONS=0\n")
PY
changed=1
mv -- "$audit/env.candidate" .env
docker compose config --format json | python3 -c '
import json, sys
env = json.load(sys.stdin)["services"]["api"]["environment"]
assert env["ACCEPT_LEGACY_SESSIONS"] == "0"
assert env["DB_MIGRATE_ON_START"] == "0"
'
docker compose up -d --no-deps --no-build api
curl --retry 12 --retry-delay 2 --retry-all-errors --max-time 8 -fsS \
  https://2.apixspb.ru/api/health > "$audit/health.json"
[[ "$(docker inspect -f '{{.Id}}' site2-db)" == "$db_id" ]]
docker exec -i site2-api node -e "$probe" after < "$audit/probe.jwt"
rm -- "$audit/probe.jwt"
trap - ERR HUP INT TERM
touch "$audit/legacy-revoked"
echo 'PASS: old tokens and photo URL tokens rejected, authorized image and API available'
sync
systemctl --no-block reboot
