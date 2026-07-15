# Credentials

One `<system>.env` file per system (e.g. `sql.env`, `plm.env`). Copy the matching
`.example` file, fill in real values, and never commit the filled-in version —
`config/credentials/*.env` is gitignored, only `*.env.example` and this README are tracked.

Apps read these via `dotenv` (Node) or a small loader (Python) at startup. Never hardcode
credentials in application source.
