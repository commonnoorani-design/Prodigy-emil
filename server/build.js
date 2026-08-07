'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const config = require('./config');

/**
 * A short fingerprint of the code actually running.
 *
 * There is no build step and no git checkout on the far side of a deploy, so
 * there is nothing to stamp a version from. Hashing the source files instead
 * gives a stable id that can be compared against the same computation on any
 * commit — which answers "did the redeploy actually take?" without guessing.
 */
function fingerprint() {
  const hash = crypto.createHash('sha256');
  const roots = [path.join(config.root, 'server'), path.join(config.root, 'public')];

  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(js|html|css)$/.test(entry.name)) {
        hash.update(path.relative(config.root, full));
        try {
          hash.update(fs.readFileSync(full));
        } catch {
          /* unreadable — leave it out of the digest */
        }
      }
    }
  };

  roots.forEach(walk);
  return hash.digest('hex').slice(0, 12);
}

let cached = null;
function buildId() {
  if (!cached) cached = fingerprint();
  return cached;
}

module.exports = { buildId };
