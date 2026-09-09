#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
docker build --platform linux/amd64 --target worker --build-arg "PILOT_UID=$(id -u)" --build-arg "PILOT_GID=$(id -g)" -f deployment/Worker.Dockerfile -t registry-openfn-worker:pilot .
docker run --rm --platform linux/amd64 --entrypoint node registry-openfn-worker:pilot --experimental-vm-modules /opt/registry-adaptors/check-worker.mjs
docker run --rm --platform linux/amd64 --network none --entrypoint node registry-openfn-worker:pilot /opt/registry-adaptors/check-engine.mjs
docker build --platform linux/amd64 -f deployment/Lightning.Dockerfile -t registry-openfn-lightning:pilot .
docker build --platform linux/amd64 -f deployment/Services.Dockerfile -t registry-openfn-services:pilot .
docker build --platform linux/amd64 -f deployment/Postgres.Dockerfile -t registry-openfn-postgres:pilot .
sh deployment/check-postgres.sh
docker build --platform linux/amd64 -f deployment/Tools.Dockerfile -t registry-openfn-tools:pilot .
