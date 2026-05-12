#!/usr/bin/env bash

set -o pipefail

PORT="${TEST_DB_PORT:-5433}"
CONTAINER_NAME="hyperdispatch-test-db-${RANDOM}"
DATABASE_URL="postgres://postgres:test@localhost:${PORT}/postgres"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker not found; running DB integration tests with PGlite fallback."
  RUN_DB_TESTS=1 \
  TEST_DB_MODE="pglite" \
  DATABASE_URL="${DATABASE_URL}" \
  JIRA_BASE_URL="https://example.atlassian.net" \
  JIRA_EMAIL="test@example.com" \
  JIRA_API_TOKEN="test-token" \
  WARP_API_KEY="test-key" \
  GITHUB_TOKEN="test-token" \
  npx vitest run --testNamePattern integration
  exit $?
fi

cleanup() {
  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run --rm -d \
  --name "${CONTAINER_NAME}" \
  -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=postgres \
  -p "${PORT}:5432" \
  postgres:16 >/dev/null

for _ in $(seq 1 30); do
  if docker exec "${CONTAINER_NAME}" pg_isready -U postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! docker exec "${CONTAINER_NAME}" pg_isready -U postgres >/dev/null 2>&1; then
  echo "Postgres did not become ready in time."
  exit 1
fi

RUN_DB_TESTS=1 \
DATABASE_URL="${DATABASE_URL}" \
JIRA_BASE_URL="https://example.atlassian.net" \
JIRA_EMAIL="test@example.com" \
JIRA_API_TOKEN="test-token" \
WARP_API_KEY="test-key" \
GITHUB_TOKEN="test-token" \
npx vitest run --testNamePattern integration
