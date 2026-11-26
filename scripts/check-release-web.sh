#!/usr/bin/env bash
set -euo pipefail
base=${1:?expected HTTP origin}
response=$(mktemp)
trap 'rm -f "$response"' EXIT
curl -fsS --retry 15 --retry-delay 2 --retry-all-errors --max-time 5 -o "$response" "$base/healthz"
jq -es 'length == 1 and .[0].status == "ok"' "$response"
curl -fsS --max-time 10 -o "$response" "$base/"
grep -Fq '<title>WeNote' "$response"
