# TimeHuddle Backend

Backend monorepo for [TimeHuddle](../README.md) — a Fastify API server with a shared time calculation engine.

## Tech Stack

| Layer     | Technology                                   |
| --------- | -------------------------------------------- |
| Framework | Fastify v5                                   |
| Database  | MongoDB (native driver, no Mongoose)         |
| Auth      | Better Auth with MongoDB adapter             |
| Real-time | Server-Sent Events (SSE) for live streams    |
| API docs  | @fastify/swagger (auto-generated at `/docs`) |

## Getting Started

```bash
npm install
```

Create a `.env` file:

```env
PORT=4000
NODE_ENV=development
MONGODB_URI=mongodb://localhost:27017/timeharbor
BETTER_AUTH_SECRET=your-secret
BETTER_AUTH_URL=http://localhost:4000
TRUSTED_ORIGINS=http://localhost:3000
APP_URL=http://localhost:3000

# GitHub OAuth — required for "Continue with GitHub" sign-in.
# Create an OAuth App at https://github.com/settings/developers
# Set the Authorization callback URL to: {BETTER_AUTH_URL}/api/auth/callback/github
# e.g. http://localhost:8080/api/auth/callback/github (when using the dev proxy)
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
```

```bash
npm run dev
```

API available at `http://localhost:4000`.

## Build

```bash
npm run build    # Compiles to dist/
node dist/server.js
```

## Migrations

Use migrate-mongo to manage database migrations stored in `backend/migrations/`:

```bash
npm run migrate          # Run pending migrations
npm run migrate:status   # Check applied vs pending
npm run migrate:down     # Undo last migration
```

Create a new migration with auto-generated timestamp:

```bash
npx migrate-mongo create -f migrate-mongo-config.cjs "add-users-index"
```
