#!/usr/bin/env bash
# Downloads the DB-IP "IP to City Lite" database (CC BY 4.0, no account needed) into data/.
# DB-IP publishes one file per month; early in a month it may not be out yet, so fall back a month.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data
out=data/dbip-city-lite.mmdb
for month in "$(date +%Y-%m)" "$(date -d "$(date +%Y-%m-01) -1 month" +%Y-%m)"; do
  url="https://download.db-ip.com/free/dbip-city-lite-${month}.mmdb.gz"
  echo "fetching $url"
  if curl -fsSL "$url" | gunzip > "$out.tmp"; then
    mv "$out.tmp" "$out"
    echo "wrote $out ($(du -h "$out" | cut -f1))"
    exit 0
  fi
done
rm -f "$out.tmp"
echo "could not download DB-IP City Lite" >&2
exit 1
