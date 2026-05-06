# Deployment

HyperDispatch is deployed as a Docker container on Coolify.

## Dockerfile

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY dist/ ./dist/
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

## Build

TypeScript is compiled to `dist/` before building the Docker image:

```sh
npm run build
```

In Coolify, set the build command to `npm run build` or use a multi-stage Dockerfile.

## Environment

Set all required environment variables in Coolify's environment configuration. See [configuration.md](./configuration.md) for the full list.

## Database

HyperDispatch expects a PostgreSQL database. The connection string is provided via `DATABASE_URL`. Migrations are applied automatically on startup.

## Health Check

`GET /health` returns `200 OK` when the service is running and the database connection is healthy. Use this as Coolify's health check endpoint.
