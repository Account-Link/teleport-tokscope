#!/usr/bin/env bash
set -euo pipefail
BASE_IMG='node:18-slim@sha256:f9ab18e354e6855ae56ef2b290dd225c1e51a564f87584b9bd21dd651838830e'

# derive from base image creation + 3 days unless seed is provided
CREATED=$(docker image inspect "$BASE_IMG" --format '{{.Created}}')
SEED="${1:-$(date -u -d "$CREATED + 3 days" +%Y-%m-%dT%H%M%SZ)}"

# parse package pins from your Dockerfiles
mapfile -t PKGS < <(grep -hE 'apt-get install.*--no-install-recommends' tokscope-enclave/Dockerfile.* \
  | sed -E 's/.*--no-install-recommends(.*)/\1/' \
  | tr '\\' ' ' | tr -s ' ' \
  | tr ' ' '\n' | grep -E '^[a-z0-9.+-]+=[a-z0-9.:+~ -]+$' | sort -u)

date="$SEED"
for _ in {1..10}; do
  echo "Trying $date"
  if docker run --rm "$BASE_IMG" bash -lc "
    set -e
    echo 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/$date bookworm main' > /etc/apt/sources.list
    echo 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/$date bookworm-updates main' >> /etc/apt/sources.list
    echo 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/$date bookworm-security main' >> /etc/apt/sources.list
    apt-get -o Acquire::Check-Valid-Until=false update >/dev/null
    apt-get install -y --no-install-recommends ${PKGS[*]} >/dev/null
  "; then
    echo "SNAPSHOT_DATE=$date"
    exit 0
  fi
  date=$(date -u -d "${date%Z} + 3 days" +%Y-%m-%dT%H%M%SZ)
done
echo "No acceptable snapshot found." >&2
exit 1