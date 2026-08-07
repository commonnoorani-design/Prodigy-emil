'use strict';

/**
 * A small better-sqlite3-shaped wrapper over node-sqlite3-wasm.
 *
 * Why not better-sqlite3 itself: it is a native addon. On a host without a
 * compiler and without Python — which is the normal case for shared hosting —
 * `npm install` falls back to `node-gyp rebuild` and fails outright. The WASM
 * build has no such step, so it installs on any Node 18+ anywhere.
 *
 * Only the surface this app actually uses is implemented: exec, pragma,
 * prepare().run/get/all, and transaction().
 */

const fs = require('fs');
const { Database: WasmDatabase } = require('node-sqlite3-wasm');

// The WASM driver takes its write lock by creating a `<db>.lock` directory and
// removing it again when the write completes — so it is only ever held for a
// few milliseconds. If the process is killed during one of those windows the
// directory survives, and every later start dies with "database is locked".
// A restart or redeploy would then brick the app permanently, so recover the
// same way SQLite recovers a hot journal: if nothing alive owns the lock,
// clear it.
const STALE_LOCK_MS = 30_000;

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists, owned by someone else
  }
}

function clearStaleLock(file) {
  const lockDir = `${file}.lock`;
  if (!fs.existsSync(lockDir)) return;

  let owner = null;
  try {
    owner = Number(fs.readFileSync(`${file}.owner`, 'utf8').trim()) || null;
  } catch {
    /* no owner recorded — predates this check, or the writer died early */
  }

  const heldByLiveProcess = owner && owner !== process.pid && processAlive(owner);
  let age = Infinity;
  try {
    age = Date.now() - fs.statSync(lockDir).mtimeMs;
  } catch {
    /* vanished underneath us */
  }

  if (heldByLiveProcess && age < STALE_LOCK_MS) return; // genuinely in use

  try {
    fs.rmSync(lockDir, { recursive: true, force: true });
    console.log(`[db] cleared a stale lock left by a previous run (${lockDir})`);
  } catch (err) {
    console.error(`[db] could not clear stale lock ${lockDir}: ${err.message}`);
  }
}

/**
 * node-sqlite3-wasm wants bind parameters as a single array, or as an object
 * whose keys carry the `@`/`:`/`$` sigil. better-sqlite3 accepts loose
 * varargs and bare object keys, which is how the callers here are written.
 */
function normaliseParams(args) {
  if (args.length === 0) return undefined;
  if (args.length === 1) {
    const only = args[0];
    if (Array.isArray(only)) return only;
    if (only && typeof only === 'object' && !Buffer.isBuffer(only) && !(only instanceof Uint8Array)) {
      const out = {};
      for (const [key, value] of Object.entries(only)) {
        out[/^[@:$]/.test(key) ? key : `@${key}`] = value;
      }
      return out;
    }
    return [only];
  }
  return args;
}

class Statement {
  constructor(db, sql) {
    this._db = db;
    this._sql = sql;
    this._stmt = db._raw.prepare(sql);
  }

  _exec(method, args) {
    const params = normaliseParams(args);
    try {
      return params === undefined ? this._stmt[method]() : this._stmt[method](params);
    } catch (err) {
      // A statement that threw mid-flight can hold stale bindings; drop it so
      // the next call to the same SQL starts from a fresh one.
      this._db._forget(this._sql);
      try {
        this._stmt.finalize();
      } catch {
        /* already gone */
      }
      throw err;
    }
  }

  run(...args) {
    return this._exec('run', args);
  }

  get(...args) {
    const row = this._exec('get', args);
    return row === null ? undefined : row;
  }

  all(...args) {
    return this._exec('all', args) || [];
  }
}

class Database {
  constructor(file) {
    clearStaleLock(file);
    this._file = file;
    this._raw = new WasmDatabase(file);
    this._statements = new Map();
    try {
      fs.writeFileSync(`${file}.owner`, String(process.pid), { mode: 0o600 });
    } catch {
      /* advisory only — a missing owner file just means locks look stale */
    }
  }

  /** Prepared statements are cached — the callers prepare the same SQL constantly. */
  prepare(sql) {
    let stmt = this._statements.get(sql);
    if (!stmt) {
      stmt = new Statement(this, sql);
      this._statements.set(sql, stmt);
    }
    return stmt;
  }

  _forget(sql) {
    this._statements.delete(sql);
  }

  exec(sql) {
    return this._raw.exec(sql);
  }

  /**
   * better-sqlite3 exposes `pragma('foreign_keys = ON')` and returns the rows.
   * Note that WAL is unavailable in the WASM build; SQLite falls back to its
   * default journal, which is fine for a single-process app like this one.
   */
  pragma(statement) {
    const text = String(statement).trim();
    if (/=/.test(text)) {
      this._raw.run(`PRAGMA ${text}`);
      return undefined;
    }
    return this._raw.all(`PRAGMA ${text}`);
  }

  /** Returns a function that runs `fn` inside BEGIN/COMMIT, rolling back on throw. */
  transaction(fn) {
    return (...args) => {
      if (this._raw.inTransaction) return fn(...args); // already inside one
      this._raw.run('BEGIN');
      try {
        const result = fn(...args);
        this._raw.run('COMMIT');
        return result;
      } catch (err) {
        try {
          this._raw.run('ROLLBACK');
        } catch {
          /* the transaction was already unwound */
        }
        throw err;
      }
    };
  }

  close() {
    for (const stmt of this._statements.values()) {
      try {
        stmt._stmt.finalize();
      } catch {
        /* ignore */
      }
    }
    this._statements.clear();
    this._raw.close();
    try {
      fs.rmSync(`${this._file}.owner`, { force: true });
    } catch {
      /* nothing depends on this being removed */
    }
  }
}

module.exports = Database;
