#!/usr/bin/env node
'use strict';

/**
 * The database, from a shell — for hosts that have one.
 *
 *   node scripts/db-tool.js check     full integrity check
 *   node scripts/db-tool.js backup    write a backup now
 *   node scripts/db-tool.js list      what backups exist
 *
 * Stop the app first for `check` on a database you suspect: a second process
 * writing while you read is the thing that damages SQLite files in the first
 * place. `backup` is safe while it runs — SQLite writes the snapshot itself.
 */

const config = require('../server/config');
const Database = require('../server/sqlite');
const maintenance = require('../server/db-maintenance');

const [command = 'check'] = process.argv.slice(2);

function open() {
  return new Database(config.dbFile);
}

function report(result) {
  if (result.ok) {
    console.log('ok — no corruption found');
    return 0;
  }
  console.error('DAMAGED:');
  result.messages.slice(0, 20).forEach((m) => console.error(`  ${m}`));
  console.error('');
  console.error('Restore the newest good copy: set RESTORE_BACKUP=latest and restart the app.');
  console.error('Do not delete the file that is there — it holds everything written since.');
  return 1;
}

function main() {
  console.log(`database: ${config.dbFile}\n`);

  if (command === 'list') {
    const backups = maintenance.list();
    if (!backups.length) return console.log('no backups yet');
    backups.forEach((b) => console.log(`${b.name}  ${b.createdAt}  ${b.bytes} bytes`));
    return 0;
  }

  const db = open();
  try {
    if (command === 'backup') {
      const made = maintenance.backup(db, { reason: 'command line' });
      console.log(`${made.name}  ${made.bytes} bytes`);
      return 0;
    }
    if (command === 'check') {
      return report(maintenance.integrity(db));
    }
    console.error(`unknown command "${command}" — expected check, backup or list`);
    return 2;
  } finally {
    db.close();
  }
}

process.exit(main() || 0);
