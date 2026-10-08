#!/bin/sh
# DB-IP publishes a new database every month. It lives on a volume, so it is fetched on the first
# start and again on any later start (each deploy is one) once it is over 35 days old. A failed
# refresh is not fatal while an older copy is there.
set -eu
db=/app/data/dbip-city-lite.mmdb
if [ ! -s "$db" ] || [ -n "$(find "$db" -mtime +35)" ]; then
  /app/scripts/fetch-geo.sh || [ -s "$db" ]
fi
exec netstats "$@"
