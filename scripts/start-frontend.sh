#!/bin/sh
set -e

if [ -f /app/client/.next/standalone/server.js ]; then
  exec env HOSTNAME=0.0.0.0 PORT=${PORT:-3000} bun /app/client/.next/standalone/server.js
else
  cd /app/client && exec env HOSTNAME=0.0.0.0 bun run start
fi
