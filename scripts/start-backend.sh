#!/bin/sh
set -e

INSTANCE=${INSTANCE:-private}

case "$INSTANCE" in
  private)
    export DATABASE_URL="${DATABASE_URL:-file:///app/data/sqlite.db}"
    SCHEMA="/app/prisma/schema.sqlite.prisma"
    DB_FILE="${DATABASE_URL#file:}"
    DB_DIR="$(dirname "$DB_FILE")"
    mkdir -p "$DB_DIR" 2>/dev/null || true
    chmod 775 "$DB_DIR" 2>/dev/null || true
    touch "$DB_FILE" 2>/dev/null || true
    bunx prisma db push --schema "$SCHEMA" --accept-data-loss --skip-generate || true
    ;;
  public)
    SCHEMA="/app/prisma/schema.postgres.prisma"
    bunx prisma migrate deploy --schema "$SCHEMA" || true
    bunx prisma db push --schema "$SCHEMA" --accept-data-loss --skip-generate || true
    ;;
  *)
    echo "Unknown INSTANCE: $INSTANCE. Must be 'private' or 'public'"
    exit 1
    ;;
esac

exec bun server/index.js
