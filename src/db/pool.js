const sql = require("mssql");
const { env } = require("../config/env");

let poolPromise;

function getPool() {
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool({
      server: env.sql.server,
      port: env.sql.port,
      database: env.sql.database,
      user: env.sql.user,
      password: env.sql.password,
      options: env.sql.options,
      pool: { max: 10, min: 0, idleTimeoutMillis: 30000 }
    })
      .connect()
      .catch(err => {
        // Let the next call try again instead of caching a dead pool forever.
        poolPromise = null;
        throw err;
      });
  }
  return poolPromise;
}

function bind(request, params) {
  for (const [key, value] of Object.entries(params || {})) {
    request.input(key, value === undefined ? null : value);
  }
  return request;
}

// Every query in the app goes through here with named parameters — there is no
// string-built SQL carrying user input anywhere (the old Export system's
// biggest problem).
async function query(text, params = {}) {
  const pool = await getPool();
  return bind(pool.request(), params).query(text);
}

// Runs fn(tx) inside one transaction. tx.query(text, params) has the same shape
// as query() above. Rolls back on any throw.
async function withTransaction(fn) {
  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  const tx = {
    query: (text, params = {}) => bind(new sql.Request(transaction), params).query(text)
  };
  try {
    const result = await fn(tx);
    await transaction.commit();
    return result;
  } catch (err) {
    try {
      await transaction.rollback();
    } catch {
      // Already rolled back by SQL Server (e.g. after a deadlock) — the
      // original error is the one worth reporting.
    }
    throw err;
  }
}

async function closePool() {
  if (!poolPromise) return;
  const pool = await poolPromise.catch(() => null);
  poolPromise = null;
  if (pool) await pool.close();
}

module.exports = { sql, getPool, query, withTransaction, closePool };
