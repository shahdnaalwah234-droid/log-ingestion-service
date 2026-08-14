# Log Ingestion Service

A backend service for ingesting, storing, searching, filtering, and analyzing application logs.

## Technologies

- Node.js
- TypeScript
- Fastify
- PostgreSQL
- Docker
- Git

## Project Structure

```text
log-ingestion-service/
├── src/
│   ├── app.ts
│   ├── server.ts
│   └── db/
│       ├── database.ts
│       └── migrations/
│           └── 001_create_logs.sql
├── docker-compose.yml
├── package.json
├── package-lock.json
├── tsconfig.json
└── .gitignore