const path = require('path');
const sql = require('mssql');

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

module.exports = { sql, getPool, query, closePool };
