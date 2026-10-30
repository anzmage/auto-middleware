#!/usr/bin/env bash
# Runs the MySQL integration test against a disposable container, then removes it.
set -euo pipefail
NAME=auto-middleware-test-mysql
PORT=${MYSQL_TEST_PORT:-33117}

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --rm --name "$NAME" -e MYSQL_ROOT_PASSWORD=testpass -p "127.0.0.1:${PORT}:3306" mysql:8.0 >/dev/null
trap 'docker stop "$NAME" >/dev/null 2>&1 || true' EXIT

echo "waiting for MySQL on port ${PORT}..."
for _ in $(seq 1 60); do
  if docker exec "$NAME" mysql -uroot -ptestpass -e 'SELECT 1' >/dev/null 2>&1; then break; fi
  sleep 2
done

MYSQL_TEST_PORT="$PORT" node --disable-warning=ExperimentalWarning --test test/mysql.integration.test.ts
