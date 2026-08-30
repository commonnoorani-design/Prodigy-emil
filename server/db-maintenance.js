'use strict';

/**
 * Looking after the database file itself: proving it is sound, keeping copies
 * of it, and putting one back when it is not.
 *
 * There is no shell on the far side of a deploy, so `sqlite3 db "PRAGMA
 * integrity_check"` is not available when it is most wanted. Everything here
 * is therefore reachable from the app: the check runs at every start and from
 * the administration screen, backups are taken automatically, and a restore is
 * asked for with an environment variable — the one lever a hosting panel
 * always has.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const config = require('./config');

const BACKUP_DIR = path.join(config.dataDir, 'backups');
const BACKUPS_KEPT = Math.max(2, Number(process.env.DB_BACKUPS_KEPT || 12));
const BACKUP_EVERY_MS = 6 * 3600 * 1000;
const PREFIX = 'prodigy-mail-';
const RESTORE_MARKER = path.join(BACKUP_DIR, '.restored');

function stamp(date = new Date()) {
  return date.toISOString().replace(/[:T]/g, '-').replace(/\..+$/, '');
}

function ensureDir() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// Integrity
// ---------------------------------------------------------------------------
/**
 * `quick_check` skips the index cross-checks, which is most of the cost; it
 * still finds a corrupt page. The full check is offered from the admin screen
 * for when the answer matters more than the wait.
 */
function integrity(db, { quick = false } = {}) {
  try {
    const rows = db.pragma(quick ? 'quick_check' : 'integrity_check') || [];
    const messages = rows.map((row) => String(Object.values(row)[0]));
    return { ok: messages.length === 1 && messages[0] === 'ok', messages, quick };
  } catch (err) {
    // "database disk image is malformed" arrives as a throw, not as a row.
    return { ok: false, messages: [err.message], quick };
  }
}

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------
function list() {
  try {
    return fs
      .readdirSync(BACKUP_DIR)
      .filter((name) => name.startsWith(PREFIX) && name.endsWith('.db'))
      .map((name) => {
        const stats = fs.statSync(path.join(BACKUP_DIR, name));
        return { name, bytes: stats.size, createdAt: stats.mtime.toISOString() };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [];
  }
}

function prune(keep = BACKUPS_KEPT) {
  for (const old of list().slice(keep)) {
    try {
      fs.rmSync(path.join(BACKUP_DIR, old.name), { force: true });
    } catch {
      /* it will be caught by the next prune */
    }
  }
}

/**
 * A backup taken with VACUUM INTO rather than a file copy: SQLite writes a
 * consistent snapshot itself, so it is safe while the app is running, and the
 * result is a plain database file — openable anywhere, restorable by copying
 * it back.
 */
function backup(db, { reason = 'scheduled' } = {}) {
  ensureDir();

  // Two backups inside the same second must not land on the same name — the
  // second would silently replace the first.
  let file = path.join(BACKUP_DIR, `${PREFIX}${stamp()}.db`);
  for (let n = 2; fs.existsSync(file); n += 1) {
    file = path.join(BACKUP_DIR, `${PREFIX}${stamp()}-${n}.db`);
  }

  // SQLite will not VACUUM while a statement is live, and the wrapper keeps
  // prepared statements cached; let them go first.
  if (typeof db.finalizeAll === 'function') db.finalizeAll();
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  prune();
  const { size } = fs.statSync(file);
  console.log(`[db] backup written (${reason}): ${path.basename(file)}, ${size} bytes`);
  return { name: path.basename(file), bytes: size, createdAt: new Date().toISOString() };
}

/** Skip it when the newest backup is recent — a restart loop must not churn. */
function backupIfDue(db, options = {}) {
  const newest = list()[0];
  if (newest && Date.now() - Date.parse(newest.createdAt) < BACKUP_EVERY_MS) return null;
  return backup(db, options);
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------
/**
 * Put a backup back, before anything opens the database.
 *
 * Set RESTORE_BACKUP to a backup's filename (or `latest`) and restart. The
 * database in place is never deleted — it is moved aside as replaced-… first,
 * because a file that will not open is still the only copy of anything written
 * since the last backup.
 *
 * The applied value is remembered in a marker file rather than in the database,
 * which by definition cannot be trusted at this point. Restarting with the same
 * value does nothing; changing it restores again.
 */
function restoreIfRequested() {
  const wanted = String(process.env.RESTORE_BACKUP || '').trim();
  if (!wanted) return null;

  let applied = null;
  try {
    applied = fs.readFileSync(RESTORE_MARKER, 'utf8').trim();
  } catch {
    /* never restored before */
  }
  if (applied === wanted) return null;

  const backups = list();
  const chosen = wanted === 'latest' ? backups[0] : backups.find((b) => b.name === wanted);
  if (!chosen) {
    console.error(
      `[db] RESTORE_BACKUP is set to "${wanted}", but there is no such backup. ` +
        `Available: ${backups.map((b) => b.name).join(', ') || '(none)'}`
    );
    return null;
  }

  const source = path.join(BACKUP_DIR, chosen.name);
  const replaced = path.join(BACKUP_DIR, `replaced-${stamp()}.db`);

  if (fs.existsSync(config.dbFile)) fs.renameSync(config.dbFile, replaced);
  // Anything left of a journal belongs to the file we just moved away.
  for (const suffix of ['-journal', '-wal', '-shm']) {
    fs.rmSync(`${config.dbFile}${suffix}`, { force: true });
  }
  fs.rmSync(`${config.dbFile}.lock`, { recursive: true, force: true });
  fs.rmSync(`${config.dbFile}.owner`, { force: true });
  fs.copyFileSync(source, config.dbFile);
  fs.writeFileSync(RESTORE_MARKER, wanted);

  console.log('\n──────────────────────────────────────────────');
  console.log(` Database restored from ${chosen.name}`);
  console.log(`   The database that was in place is kept as ${path.basename(replaced)}`);
  console.log('   Clear RESTORE_BACKUP once you have checked the result.');
  console.log('──────────────────────────────────────────────\n');
  return { restored: chosen.name, replaced: path.basename(replaced) };
}

// ---------------------------------------------------------------------------
// Repair
// ---------------------------------------------------------------------------
/**
 * Damage is not always loss.
 *
 * The common case — the one that took this app down — is a broken *index*:
 * the rows are all still there, the b-tree that points at them is not.
 * Rebuilding the indexes fixes that outright and keeps everything. Only when
 * that fails is it worth rewriting the file, and only when that fails too is
 * it worth salvaging what can still be read into a fresh database.
 *
 * Asked for with REPAIR_DB=1, and attempted once per value of it, so a restart
 * loop cannot grind away at a file that is beyond repair. The damaged file is
 * always kept.
 */
const REPAIR_MARKER = path.join(BACKUP_DIR, '.repaired');

// The complaints SQLite makes when an index has drifted out of step with the
// table it indexes. The rows are all present and readable; only the structure
// over them is wrong, and REINDEX rebuilds that from the rows themselves.
const INDEX_ONLY = [
  /^wrong # of entries in index /,
  /^row \d+ missing from index /,
  /^non-unique entry in index /,
  /^NULL value in \S+ but no index entry/,
  // Free-space accounting on a page being a few bytes out. Benign on its own,
  // and it comes along with the index complaints above often enough to be
  // worth allowing beside them.
  /^Fragmentation of \d+ bytes reported as \d+ on page \d+/,
];

/**
 * Is every complaint about an index, and nothing about the data?
 *
 * Worth asking, because that case is safe to put right without being told to:
 * rebuilding an index cannot lose a row, and leaving the app down overnight
 * waiting for someone to set a variable costs more than the repair does.
 */
function indexOnly(messages = []) {
  // A single message can carry several lines — the "*** in database main ***"
  // banner arrives glued to the first complaint. Judge line by line, or a real
  // fault hides behind a banner.
  const lines = messages
    .flatMap((m) => String(m || '').split('\n'))
    .map((line) => line.trim())
    .filter((line) => line && !/^\*\*\* in database /.test(line));
  return lines.length > 0 && lines.every((line) => INDEX_ONLY.some((pattern) => pattern.test(line)));
}

function repairRequested() {
  const wanted = String(process.env.REPAIR_DB || '').trim();
  if (!wanted || wanted === '0' || wanted.toLowerCase() === 'false') return false;
  try {
    if (fs.readFileSync(REPAIR_MARKER, 'utf8').trim() === wanted) return false;
  } catch {
    /* never repaired before */
  }
  return true;
}

function markRepaired() {
  try {
    fs.writeFileSync(REPAIR_MARKER, String(process.env.REPAIR_DB || '1').trim());
  } catch {
    /* the worst case is repairing twice */
  }
}

/** Put a rebuilt file in place of the live one. */
function swapIn(candidate) {
  for (const suffix of ['-journal', '-wal', '-shm']) {
    fs.rmSync(`${config.dbFile}${suffix}`, { force: true });
  }
  fs.rmSync(`${config.dbFile}.lock`, { recursive: true, force: true });
  fs.rmSync(`${config.dbFile}.owner`, { force: true });
  fs.rmSync(config.dbFile, { force: true });
  fs.renameSync(candidate, config.dbFile);
}

/** Read a table even when part of it will not come back. */
function readRows(source, table) {
  try {
    return { rows: source.prepare(`SELECT * FROM "${table}"`).all(), whole: true };
  } catch {
    // Something in there is unreadable. Take it in pieces and keep the pieces
    // that come back, rather than losing the table for one bad page.
    const rows = [];
    let missed = 0;
    for (let offset = 0; offset < 200_000; offset += 100) {
      let chunk;
      try {
        chunk = source.prepare(`SELECT * FROM "${table}" LIMIT 100 OFFSET ${offset}`).all();
      } catch {
        missed += 100;
        continue;
      }
      if (!chunk.length) break;
      rows.push(...chunk);
    }
    return { rows, whole: false, missed };
  }
}

/** Tables worth nothing once the app restarts — never worth salvaging. */
const DISPOSABLE = new Set(['sessions', 'oauth_codes']);

function salvage(Database, notes) {
  const target = `${config.dbFile}.salvaged`;
  fs.rmSync(target, { force: true });

  const source = new Database(config.dbFile);
  const fresh = new Database(target);
  try {
    const objects = source.prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'"
    ).all();
    const tables = objects.filter((o) => o.type === 'table');
    const rest = objects.filter((o) => o.type !== 'table');

    tables.forEach((t) => fresh.exec(t.sql));

    for (const { name } of tables) {
      if (DISPOSABLE.has(name)) {
        notes.push(`${name}: left empty (it holds nothing worth keeping)`);
        continue;
      }
      const { rows, whole, missed } = readRows(source, name);
      if (!rows.length) {
        notes.push(`${name}: ${whole ? 'empty' : 'nothing could be read'}`);
        continue;
      }
      const columns = Object.keys(rows[0]);
      const insert = fresh.prepare(
        `INSERT OR IGNORE INTO "${name}" (${columns.map((c) => `"${c}"`).join(', ')}) ` +
          `VALUES (${columns.map(() => '?').join(', ')})`
      );
      let saved = 0;
      let lost = 0;
      for (const row of rows) {
        try {
          insert.run(columns.map((c) => row[c]));
          saved += 1;
        } catch {
          lost += 1;
        }
      }
      notes.push(
        `${name}: ${saved} row${saved === 1 ? '' : 's'} recovered` +
          (lost ? `, ${lost} rejected` : '') +
          (whole ? '' : `, about ${missed} unreadable`)
      );
    }

    // Indexes last: building them over the rows is the point of the exercise.
    rest.forEach((o) => {
      try {
        fresh.exec(o.sql);
      } catch (err) {
        notes.push(`could not rebuild ${o.type} ${o.name}: ${err.message}`);
      }
    });

    const after = integrity(fresh, {});
    fresh.close();
    source.close();
    if (!after.ok) {
      notes.push('the salvaged copy did not come out clean either');
      fs.rmSync(target, { force: true });
      return false;
    }
    swapIn(target);
    return true;
  } catch (err) {
    notes.push(`salvage failed: ${err.message}`);
    try {
      fresh.close();
    } catch {
      /* already gone */
    }
    try {
      source.close();
    } catch {
      /* already gone */
    }
    fs.rmSync(target, { force: true });
    return false;
  }
}

function repair(Database, { indexesOnly = false } = {}) {
  ensureDir();
  const notes = [];
  const kept = path.join(BACKUP_DIR, `before-repair-${stamp()}.db`);
  fs.copyFileSync(config.dbFile, kept);
  notes.push(`the damaged file is kept as ${path.basename(kept)}`);

  const attempt = (label, fn) => {
    try {
      return fn();
    } catch (err) {
      notes.push(`${label}: ${err.message}`);
      return false;
    }
  };

  // 1. Rebuild the indexes in place. Loses nothing when it works.
  const reindexed = attempt('rebuilding the indexes', () => {
    const db = new Database(config.dbFile);
    try {
      db.exec('REINDEX');
      return integrity(db, {}).ok;
    } finally {
      db.close();
    }
  });
  if (reindexed) {
    notes.push('rebuilding the indexes was enough — no rows were lost');
    if (!indexesOnly) markRepaired();
    return { ok: true, method: 'reindex', notes };
  }
  notes.push('rebuilding the indexes did not fix it');

  // Everything past here rewrites or replaces the file. That is a fair trade
  // for a database somebody has asked to have repaired, and too much to do
  // uninvited to one whose only fault looked like a stale index.
  if (indexesOnly) {
    notes.push('leaving the rest alone — set REPAIR_DB=1 to go further');
    return { ok: false, method: 'reindex', notes };
  }

  // 2. Rewrite the file from its own contents.
  const rebuilt = attempt('rewriting the file', () => {
    const candidate = `${config.dbFile}.rebuilt`;
    fs.rmSync(candidate, { force: true });
    const db = new Database(config.dbFile);
    try {
      db.finalizeAll();
      db.exec(`VACUUM INTO '${candidate.replace(/'/g, "''")}'`);
    } finally {
      db.close();
    }
    const check = new Database(candidate);
    const after = integrity(check, {});
    check.close();
    if (!after.ok) {
      fs.rmSync(candidate, { force: true });
      return false;
    }
    swapIn(candidate);
    return true;
  });
  if (rebuilt) {
    notes.push('the file was rewritten from its own contents — no rows were lost');
    markRepaired();
    return { ok: true, method: 'rebuild', notes };
  }
  notes.push('rewriting the file did not fix it — keeping what can still be read');

  // 3. Keep whatever can still be read.
  if (salvage(Database, notes)) {
    markRepaired();
    return { ok: true, method: 'salvage', notes };
  }

  markRepaired();
  notes.push('nothing could be repaired — restore a backup instead (RESTORE_BACKUP=latest)');
  return { ok: false, method: 'none', notes };
}

// ---------------------------------------------------------------------------
// Start-up routine
// ---------------------------------------------------------------------------
let lastCheck = null;
let lastRepair = null;

/** Keep what a repair attempt did, for the log and for /api/health. */
function recordRepair(outcome) {
  lastRepair = { ...outcome, at: new Date().toISOString() };
  console.log('\n──────────────────────────────────────────────');
  console.log(outcome.ok ? ` Database repaired (${outcome.method})` : ' Database could not be repaired');
  outcome.notes.forEach((note) => console.log(`   ${note}`));
  console.log('──────────────────────────────────────────────\n');
  return lastRepair;
}

/** Keep a check result as the current verdict on the file. */
function record(result) {
  lastCheck = { ...result, at: new Date().toISOString(), host: os.hostname() };
  return lastCheck;
}

/**
 * Prove the database before trusting it, and take a copy while it is known
 * good. A corrupt file is never backed up over a healthy one — that is how a
 * good backup gets lost.
 */
function onStart(db) {
  // db.js checks the file the moment it opens it, before writing a thing.
  if (!lastCheck) record(integrity(db, { quick: true }));

  if (!lastCheck.ok) {
    console.error('\n──────────────────────────────────────────────');
    console.error(' The database failed its integrity check:');
    lastCheck.messages.slice(0, 5).forEach((m) => console.error(`   ${m}`));
    console.error('');
    console.error(' Do not let it keep writing. Restore the newest good copy:');
    console.error('   set RESTORE_BACKUP=latest and restart.');
    console.error(` Backups: ${list().map((b) => b.name).join(', ') || '(none yet)'}`);
    console.error('──────────────────────────────────────────────\n');
    return lastCheck;
  }

  try {
    backupIfDue(db, { reason: 'start-up' });
  } catch (err) {
    console.error(`[db] could not write a backup: ${err.message}`);
  }
  return lastCheck;
}

function lastIntegrity() {
  return lastCheck;
}

module.exports = {
  BACKUP_DIR,
  backup,
  record,
  repair,
  repairRequested,
  recordRepair,
  indexOnly,
  lastRepair: () => lastRepair,
  backupIfDue,
  integrity,
  lastIntegrity,
  list,
  onStart,
  prune,
  restoreIfRequested,
};
