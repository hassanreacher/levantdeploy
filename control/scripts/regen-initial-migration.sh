#!/usr/bin/env bash
# Regenerates prisma/migrations/0001_init from the current schema (ops area).
# Use before the first public release, while no installation depends on the migration history yet.
# After the first release, create real migrations instead: npx prisma migrate dev --name <change>
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p prisma/migrations/0001_init
npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > prisma/migrations/0001_init/migration.sql
echo "prisma/migrations/0001_init/migration.sql: $(wc -l < prisma/migrations/0001_init/migration.sql) lines"
