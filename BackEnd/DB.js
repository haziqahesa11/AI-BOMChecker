const path = require('path');
const sql = require('mssql');
const { Pool } = require('pg');

require('dotenv').config({ path: path.join(__dirname, '..', 'config', 'credentials', 'sql.env') });

const config = {
  user: process.env.SQL_USER,
  password: process.env.SQL_PASSWORD,
  server: process.env.SQL_HOST,
  port: Number(process.env.SQL_PORT),
  database: process.env.SQL_DATABASE || '',
  options: {
    encrypt: false,
    trustServerCertificate: true,
  },
};

let pool = null;

async function getPool() {
  if (!pool) {
    pool = await sql.connect(config);
  }
  return pool;
}

async function query(queryString, params = []) {
  const p = await getPool();
  const request = p.request();
  params.forEach(({ name, type, value }) => {
    request.input(name, type, value);
  });
  return request.query(queryString);
}

async function closePool() {
  if (pool) {
    await pool.close();
    pool = null;
  }
}

// Annon DB (local)
const annonConnConfig = {
  user: "te_admin",
  host: "10.251.231.77",
  // host: 'localhost',
  database: "annon",
  password: "P@ssw0rd!te",
  port: 5432,
};


// SFCS DB (remote)
// options: force MYT session so TIMESTAMP comparisons align with local stored times
const sfcsPool = new Pool({
  user: "tdp_admin",
  host: "10.251.228.59",
  database: "tdp_db",
  password: "tdp@WYMY",
  port: 5432,
  options: "-c timezone=Asia/Kuala_Lumpur",
});

// Same idle-client crash risk as annonPool below — without this handler a
// network blip on a pooled-but-idle client would take down the whole process.
sfcsPool.on('error', (err) => {
  console.error('Unexpected error on idle Postgres client (sfcsPool):', err);
});

// Cycle Time reporting only ever reads wymysfcs.sfctransaction/sfcmodel —
// same read-only enforcement as annonPool, applied here too since this pool
// now backs live query traffic (services/cycleTimeService.js).
sfcsPool.on('connect', (client) => {
  client.query('SET default_transaction_read_only = on').catch((err) => {
    console.error('Failed to set sfcsPool connection to read-only:', err);
  });
});


const annonPool = new Pool(annonConnConfig);

// Without this handler, a network blip on an idle pooled client fires an
// unhandled 'error' event on the Pool, which crashes the whole process.
annonPool.on('error', (err) => {
  console.error('Unexpected error on idle Postgres client (annonPool):', err);
});

// Read-only guard: existing CRD Tracker read endpoints must never write to
// this DB. Setting this per-connection makes Postgres itself reject any
// INSERT/UPDATE/DELETE/DDL statement, instead of relying on every caller to
// only ever write SELECTs.
annonPool.on('connect', (client) => {
  client.query('SET default_transaction_read_only = on').catch((err) => {
    console.error('Failed to set annonPool connection to read-only:', err);
  });
});

// Write-capable pool to the same DB, used only by the CRD Tracker "Update"
// feature's write endpoints (New SKU / WW Rev Update / Delete). Every other
// route must keep using the read-only-enforced annonPool above.
const annonWritePool = new Pool(annonConnConfig);
annonWritePool.on('error', (err) => {
  console.error('Unexpected error on idle Postgres client (annonWritePool):', err);
});

module.exports = { sql, getPool, query, closePool, annonPool, annonWritePool, sfcsPool };
