const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

require('dotenv').config({
  path: path.join(__dirname, '..', '..', 'config', 'credentials', 'postgres.env'),
});

const SQL_FILE = path.join(__dirname, '..', '..', 'Database', 'crd_tracker_postgres.sql');
const FORCE = process.argv.includes('--force');

const config = {
  host: process.env.PG_HOST,
  port: Number(process.env.PG_PORT),
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  database: process.env.PG_DATABASE,
  connectionTimeoutMillis: 8000,
};

function describeError(err) {
  switch (err.code) {
    case 'ECONNREFUSED':
    case 'ETIMEDOUT':
      return `cannot reach ${config.host}:${config.port} (connection refused/timed out) - check network/VPN/firewall`;
    case 'ENOTFOUND':
      return `cannot resolve host ${config.host} - check PG_HOST`;
    case '28P01':
      return 'authentication failed - check PG_USER/PG_PASSWORD';
    case '3D000':
      return `database "${config.database}" not found - check PG_DATABASE`;
    default:
      return err.message;
  }
}

async function main() {
  console.log(`Connecting to postgres://${config.user}@${config.host}:${config.port}/${config.database} ...`);
  const client = new Client(config);

  try {
    await client.connect();
  } catch (err) {
    console.error(`Connection failed: ${describeError(err)}`);
    process.exit(1);
  }

  try {
    const { rows: [{ exists: schemaExists }] } = await client.query(
      "SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'crd') AS exists"
    );

    if (schemaExists && !FORCE) {
      const { rows: [{ count }] } = await client.query(
        "SELECT COUNT(*)::int AS count FROM information_schema.tables WHERE table_schema = 'crd'"
      );
      if (Number(count) > 0) {
        console.error(
          `Schema "crd" already exists on this server with ${count} table(s)/view(s).\n` +
          'This script DROPs and recreates crd.* objects - refusing to run to avoid clobbering ' +
          'existing data. Re-run with --force if you are sure you want to overwrite it.'
        );
        process.exit(1);
      }
    }

    console.log('Schema "crd" not present (or empty) - safe to load. Running crd_tracker_postgres.sql ...');
    const sqlText = fs.readFileSync(SQL_FILE, 'utf8');
    await client.query(sqlText);
    console.log('Load complete. Verifying row counts:');

    for (const table of ['revision_code', 'line', 'component', 'week_status']) {
      const { rows: [{ count }] } = await client.query(`SELECT COUNT(*)::int AS count FROM crd.${table}`);
      console.log(`  crd.${table}: ${count} rows`);
    }
  } catch (err) {
    console.error(`Load failed: ${describeError(err)}`);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
