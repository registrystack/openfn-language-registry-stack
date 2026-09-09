#!/bin/sh
set -eu
# Generated credentials remain owner-only on the host. Prepare postgres-owned
# copies inside this container before the upstream entrypoint drops root.
install -d -o postgres -g postgres -m 0700 /var/lib/postgresql/tls
install -o postgres -g postgres -m 0600 /config/postgres/server.key /var/lib/postgresql/tls/server.key
install -o postgres -g postgres -m 0644 /config/postgres/server.crt /var/lib/postgresql/tls/server.crt
install -o postgres -g postgres -m 0600 /config/postgres/bootstrap.sql /docker-entrypoint-initdb.d/bootstrap.sql
exec /usr/local/bin/docker-entrypoint.sh "$@"
