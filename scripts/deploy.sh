#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ ! -f .env ]; then
  echo 'Create .env from .env.example and fill in credentials.' >&2
  exit 1
fi
chmod 600 .env
docker compose config --quiet
docker compose build --pull app
docker compose up -d --wait --wait-timeout 180
echo 'Started. Check docker compose logs --tail=50 app and http://localhost:8080/health.'
