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
// Start-up routine
// ---------------------------------------------------------------------------
let lastCheck = null;

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
  backupIfDue,
  integrity,
  lastIntegrity,
  list,
  onStart,
  prune,
  restoreIfRequested,
};
