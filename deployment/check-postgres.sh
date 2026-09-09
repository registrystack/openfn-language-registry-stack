#!/bin/sh
# Exercise the Linux host-operator to postgres UID handoff using only synthetic
# inputs inside a disposable, network-disabled container. Never mount pilot data.
set -eu
docker run --rm -i --platform linux/amd64 --network none --user root \
  --tmpfs /var/lib/postgresql/data:rw,nosuid,nodev,size=256m \
  --env POSTGRES_HOST_AUTH_METHOD=trust --entrypoint sh \
  registry-openfn-postgres:pilot -se <<'CHECK'
install -d -o 1001 -g 1001 -m 0700 /config/postgres
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=synthetic-check \
  -keyout /config/postgres/server.key -out /config/postgres/server.crt >/dev/null 2>&1
printf '%s\n' 'CREATE ROLE pilot_permission_probe NOLOGIN;' >/config/postgres/bootstrap.sql
chown 1001:1001 /config/postgres/*
chmod 0600 /config/postgres/*
# Reproduce the old direct bind's ownership before the wrapper stages its copy.
install -o 1001 -g 1001 -m 0600 /config/postgres/bootstrap.sql /docker-entrypoint-initdb.d/bootstrap.sql
if gosu postgres test -r /docker-entrypoint-initdb.d/bootstrap.sql; then
  echo 'PostgreSQL ownership check did not establish its negative precondition.' >&2
  exit 1
fi
/usr/local/bin/pilot-postgres-entrypoint postgres -c listen_addresses='' >/tmp/postgres-check.log 2>&1 &
database_pid=$!
trap 'kill "$database_pid" 2>/dev/null || true; wait "$database_pid" 2>/dev/null || true' EXIT
attempt=0
while [ "$attempt" -lt 45 ]; do
  if ! kill -0 "$database_pid" 2>/dev/null; then
    echo 'PostgreSQL initialization failed under its runtime UID; raw diagnostics withheld.' >&2
    exit 1
  fi
  if [ "$(gosu postgres psql -U postgres -d postgres -Atqc "SELECT count(*) FROM pg_roles WHERE rolname = 'pilot_permission_probe'" 2>/dev/null || true)" = 1 ]; then
    test "$(stat -c '%u:%g:%a' /docker-entrypoint-initdb.d/bootstrap.sql)" = "$(id -u postgres):$(id -g postgres):600"
    test "$(stat -c '%u:%g:%a' /config/postgres/bootstrap.sql)" = '1001:1001:600'
    gosu postgres test -r /var/lib/postgresql/tls/server.key
    echo 'PostgreSQL initialized with private operator-owned inputs and a private runtime-owned copy.'
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 1
done
echo 'PostgreSQL ownership check timed out.' >&2
exit 1
CHECK
