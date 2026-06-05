const sql = require('mssql');

const config = {
  user: 'sa',
  password: 'p@ssw0rd',
  server: '10.251.231.65',
  port: 1435,
  database: '',        // set your target database name here
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
