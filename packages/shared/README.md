# @leo/shared

This package contains our database schema and functions for interacting with it.

## Getting Started

### 1. Environment Setup

1. Copy the `.env.example` file to create `.env.development.local`:

```bash
cp .env.example .env.development.local
```

2. Update the following variables in `.env.development.local`:

| Environment Variable | What                                                     |
| -------------------- | -------------------------------------------------------- |
| `DATABASE_URL`       | "postgresql://postgres:postgres@localhost:5432/postgres" |

### 3. Database Migrations

The project uses drizzle for database migrations.

```bash
pnpm drizzle-kit-push-dev
```
