# crd-postgres-loader

One-off loader that runs `Database/crd_tracker_postgres.sql` against the live `crd_tracker`
Postgres server. Reads connection info from `config/credentials/postgres.env` (copy
`config/credentials/postgres.env.example` and fill it in if that file doesn't exist yet).

```
npm install
node load-schema.js
```

## What it touches

The SQL file only creates/drops objects inside the `crd` schema (`crd.line`, `crd.component`,
`crd.week_status`, `crd.revision_code`, plus 2 views and their indexes). Nothing outside that
schema is read or written.

## Safety check

Before running the file, the script checks whether schema `crd` already exists on the server
with tables/views in it. If so, it **refuses to run** (the SQL file unconditionally
`DROP ... CASCADE`s and recreates those objects, which would destroy any existing data there).
Pass `--force` to override once you've confirmed it's safe to overwrite:

```
node load-schema.js --force
```

On success it prints row counts for all 4 tables as a sanity check.
