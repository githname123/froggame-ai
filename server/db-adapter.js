/**
 * db-adapter.js — PostgreSQL 数据访问层
 *
 * 环境变量:
 *   DATABASE_URL=postgres://...  (必填)
 *
 * 用法:
 *   const { createAdapter } = require('./db-adapter');
 *   const db = createAdapter();       // 返回 PgAdapter
 *   await db.init();
 *   const rows = await db.all(sql, params);
 */

// ─── 通用辅助 ───────────────────────────────────────────
function rewritePlaceholders(sql) {
    // 将 ? 占位符转为 PG 的 $1 $2 ...
    let idx = 0;
    return sql.replace(/\?/g, () => `$${++idx}`);
}

// ─── PostgreSQL Adapter ────────────────────────────────
class PgAdapter {
    constructor(connString) {
        this._connString = connString;
        this._pool = null;
    }

    async init() {
        const { Pool } = require('pg');
        this._pool = new Pool({
            connectionString: this._connString,
            max: 20,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 5000
        });
        // 验证连接
        const client = await this._pool.connect();
        client.release();
    }

    get raw() { return this._pool; }

    async run(sql, params = []) {
        let pgSql = rewritePlaceholders(sql);
        // INSERT OR IGNORE → INSERT ... ON CONFLICT DO NOTHING
        pgSql = pgSql.replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, 'INSERT INTO');
        // 如果原 SQL 有 INSERT OR IGNORE 但没有 ON CONFLICT，自动加 ON CONFLICT DO NOTHING
        if (/INSERT\s+OR\s+IGNORE/i.test(sql) && !/ON\s+CONFLICT/i.test(pgSql)) {
            pgSql = pgSql.replace(/(VALUES\s*\([^)]*\))/i, '$1 ON CONFLICT DO NOTHING');
        }
        const res = await this._pool.query(pgSql, params);
        return { changes: res.rowCount, lastID: res.rows?.[0]?.id ?? null };
    }

    async get(sql, params = []) {
        const pgSql = rewritePlaceholders(sql);
        const res = await this._pool.query(pgSql, params);
        return res.rows[0] || null;
    }

    async all(sql, params = []) {
        const pgSql = rewritePlaceholders(sql);
        const res = await this._pool.query(pgSql, params);
        return res.rows || [];
    }

    serialize(fn) {
        // PG 无 serialize 概念，直接执行
        fn();
    }

    async transaction(fn) {
        const client = await this._pool.connect();
        try {
            await client.query('BEGIN');
            const txAdapter = {
                run: async (sql, params = []) => {
                    let pgSql = rewritePlaceholders(sql);
                    pgSql = pgSql.replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, 'INSERT INTO');
                    if (/INSERT\s+OR\s+IGNORE/i.test(sql) && !/ON\s+CONFLICT/i.test(pgSql)) {
                        pgSql = pgSql.replace(/(VALUES\s*\([^)]*\))/i, '$1 ON CONFLICT DO NOTHING');
                    }
                    const res = await client.query(pgSql, params);
                    return { changes: res.rowCount, lastID: res.rows?.[0]?.id ?? null };
                },
                get: async (sql, params = []) => {
                    const pgSql = rewritePlaceholders(sql);
                    const res = await client.query(pgSql, params);
                    return res.rows[0] || null;
                },
                all: async (sql, params = []) => {
                    const pgSql = rewritePlaceholders(sql);
                    const res = await client.query(pgSql, params);
                    return res.rows || [];
                }
            };
            const result = await fn(txAdapter);
            await client.query('COMMIT');
            return result;
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    }

    async checkpoint() { /* no-op for PG */ }

    async close() {
        if (this._pool) await this._pool.end();
    }

    get driver() { return 'postgres'; }
}

// ─── 工厂 ──────────────────────────────────────────────
function createAdapter(options = {}) {
    const connStr = options.connectionString || process.env.DATABASE_URL;
    if (!connStr) throw new Error('未设置 DATABASE_URL');
    return new PgAdapter(connStr);
}

const DB_DRIVER = 'postgres';

module.exports = { createAdapter, rewritePlaceholders, DB_DRIVER };
