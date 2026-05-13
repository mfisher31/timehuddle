# Archived Migration Code

This directory contains legacy migration infrastructure that has been superseded by migrate-mongo.

## Files

- **migrate.ts** — Custom migration runner (replaced by migrate-mongo CLI)
- **sync-legacy-migrations-to-migrate-mongo.ts** — One-time sync script for migrating from custom runner to migrate-mongo

These files are preserved for historical reference only. All new migrations should use the migrate-mongo workflow in `backend/migrations/`.
