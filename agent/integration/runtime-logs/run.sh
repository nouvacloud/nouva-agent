#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
compose_file="${script_dir}/docker-compose.yml"
compose=(docker compose -f "${compose_file}")
run_id="runtime-logs-$(date +%s)-${RANDOM}"
rejected_container="${run_id}-rejected"
dropped_container="${run_id}-dropped"
expected_lines=(
  "${run_id}:rejected-write-1"
  "${run_id}:rejected-write-2"
  "${run_id}:accepted-dropped-response"
)

cleanup() {
  docker rm -f "${rejected_container}" "${dropped_container}" >/dev/null 2>&1 || true
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_for_url() {
  local url="$1"
  local header="${2:-}"

  for _ in $(seq 1 90); do
    if [[ -n "${header}" ]]; then
      if curl --fail --silent --show-error -H "${header}" "${url}" >/dev/null 2>&1; then
        return 0
      fi
    elif curl --fail --silent --show-error "${url}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  echo "Timed out waiting for ${url}" >&2
  return 1
}

query_values() {
  curl --fail --silent --show-error \
    -H "X-Scope-OrgID: runtime-log-test" \
    --get \
    --data-urlencode "query={test_run=\"${run_id}\"}" \
    --data-urlencode "limit=1000" \
    "http://127.0.0.1:3100/loki/api/v1/query_range" |
    jq -r '.data.result[].values[]?[1]'
}

wait_for_line_count() {
  local expected_count="$1"

  for _ in $(seq 1 90); do
    local actual_count
    actual_count="$(query_values | wc -l | tr -d " ")"
    if [[ "${actual_count}" == "${expected_count}" ]]; then
      return 0
    fi
    sleep 1
  done

  echo "Timed out waiting for ${expected_count} Loki entries" >&2
  query_values >&2 || true
  return 1
}

emit_lines() {
  local container_name="$1"
  shift
  local command="sleep 3;"

  for line in "$@"; do
    command="${command}printf '%s\\n' '${line}';"
  done
  command="${command}sleep 300"

  docker run --detach \
    --name "${container_name}" \
    --label nouva_runtime_log_test=true \
    --label "nouva_runtime_log_run=${run_id}" \
    alpine:3.21 \
    sh -c "${command}" >/dev/null
}

"${compose[@]}" up --detach loki toxiproxy
wait_for_url "http://127.0.0.1:3100/ready"
wait_for_url "http://127.0.0.1:8474/version"

curl --fail --silent --show-error \
  -H "Content-Type: application/json" \
  -d '{"name":"loki","listen":"0.0.0.0:8666","upstream":"loki:3100","enabled":false}' \
  "http://127.0.0.1:8474/proxies" >/dev/null

"${compose[@]}" up --detach alloy
wait_for_url "http://127.0.0.1:12345/-/ready"

emit_lines "${rejected_container}" "${expected_lines[0]}" "${expected_lines[1]}"
sleep 8

"${compose[@]}" restart alloy
wait_for_url "http://127.0.0.1:12345/-/ready"

curl --fail --silent --show-error \
  -X POST \
  "http://127.0.0.1:8474/proxies/loki" \
  -H "Content-Type: application/json" \
  -d '{"enabled":true}' >/dev/null
wait_for_line_count 2

curl --fail --silent --show-error \
  -H "Content-Type: application/json" \
  -d '{"name":"drop-response","type":"timeout","stream":"downstream","toxicity":1,"attributes":{"timeout":5000}}' \
  "http://127.0.0.1:8474/proxies/loki/toxics" >/dev/null

emit_lines "${dropped_container}" "${expected_lines[2]}"
wait_for_line_count 3

curl --fail --silent --show-error \
  -X DELETE \
  "http://127.0.0.1:8474/proxies/loki/toxics/drop-response" >/dev/null
sleep 10

values="$(query_values)"
for line in "${expected_lines[@]}"; do
  count="$(printf "%s\n" "${values}" | grep -Fxc "${line}" || true)"
  if [[ "${count}" != "1" ]]; then
    echo "Expected exactly one Loki entry for ${line}, found ${count}" >&2
    exit 1
  fi
done

if [[ "$(printf "%s\n" "${values}" | wc -l | tr -d " ")" != "${#expected_lines[@]}" ]]; then
  echo "Loki returned unexpected entries for test run ${run_id}" >&2
  printf "%s\n" "${values}" >&2
  exit 1
fi

metrics="$(curl --fail --silent --show-error http://127.0.0.1:12345/metrics)"
for metric in loki_write_dropped_entries_total loki_write_dropped_bytes_total; do
  total="$(
    printf "%s\n" "${metrics}" |
      awk -v metric="${metric}" '$1 ~ ("^" metric "(\\{|$)") { total += $2 } END { print total + 0 }'
  )"
  if [[ "${total}" != "0" ]]; then
    echo "Expected ${metric} to remain zero, found ${total}" >&2
    exit 1
  fi
done

echo "Verified lossless Alloy retries and Loki deduplication for ${run_id}"
