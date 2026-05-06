# Deployment

HyperDispatch is deployed as a Docker container on Coolify at `https://dispatch.tools.hyperbolic.dk`.

## Dockerfile

The `Dockerfile` uses a two-stage build:

1. **Builder stage** (`node:22-alpine`): installs all dependencies (including devDependencies), compiles TypeScript via `npm run build`.
2. **Production stage** (`node:22-alpine`): installs production dependencies only, copies the compiled `dist/` from the builder stage.

This keeps the final image free of build tooling.

## Coolify Setup

- **Context**: `hb-internal` (`https://tools.hyperbolic.dk`)
- **Project**: Orchestra
- **Build pack**: `dockerfile`
- **GitHub App**: `hyperbolic-coolify` (org: `Hyperbolic-ApS`)
- **Repository**: `Hyperbolic-ApS/hyper-dispatch`, branch `main`
- **Domain**: `dispatch.tools.hyperbolic.dk`
- **Exposed port**: `3000`
- **Health check**: `GET /health` (returns `{"status":"ok"}`)

## Database

HyperDispatch uses a dedicated database on the shared AWS RDS PostgreSQL 16.6 instance in `eu-west-1`:

- **Host**: `internal-projects-db.c5y2m8c6aios.eu-west-1.rds.amazonaws.com`
- **Database**: `hyperdispatch`
- **User**: `hyperdispatch_user`

RDS enforces SSL. The connection automatically enables SSL for non-localhost `DATABASE_URL` values.

Migrations are applied automatically on startup via `runMigrations()`.

## Environment Variables

Set all required environment variables in Coolify's environment configuration. See [configuration.md](./configuration.md) for the full list.
