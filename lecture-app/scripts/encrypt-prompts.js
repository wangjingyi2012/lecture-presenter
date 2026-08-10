#!/usr/bin/env node
/**
 * Encrypts the private PPTE prompt asset (prompts.source.txt) into prompts.enc
 * using AES-256-GCM. The Rust backend loads prompts.enc at runtime; when it is
 * absent (e.g. community builds from the public repo), the backend falls back to
 * the plaintext prompts.example.txt.
 *
 * Key source: the PPTE_PROMPT_KEY environment variable (64 hex chars = 32 bytes).
 * The same key is injected into the Rust binary at compile time via
 * option_env!("PPTE_PROMPT_KEY"), so this script and `cargo build` must run with
 * the same key to produce a working release.
 *
 * File format: nonce(12) || ciphertext || tag(16)
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const RES_DIR = path.resolve(__dirname, '..', 'src-tauri', 'resources');
const SRC = path.join(RES_DIR, 'prompts.source.txt');
const OUT = path.join(RES_DIR, 'prompts.enc');

const KEY_HEX = process.env.PPTE_PROMPT_KEY;
if (!KEY_HEX) {
  console.error('[encrypt-prompts] PPTE_PROMPT_KEY is not set.');
  console.error('  Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  console.error('  Then export PPTE_PROMPT_KEY=<hex> before building.');
  process.exit(1);
}
const key = Buffer.from(KEY_HEX, 'hex');
if (key.length !== 32) {
  console.error(`[encrypt-prompts] PPTE_PROMPT_KEY must decode to 32 bytes, got ${key.length}.`);
  process.exit(1);
}
if (!fs.existsSync(SRC)) {
  console.error(`[encrypt-prompts] Source not found: ${SRC}`);
  console.error('  prompts.source.txt is gitignored; create it from prompts.example.txt as a starting point.');
  process.exit(1);
}

const plaintext = fs.readFileSync(SRC);
const nonce = crypto.randomBytes(12);
const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
const tag = cipher.getAuthTag();
const out = Buffer.concat([nonce, enc, tag]);

fs.writeFileSync(OUT, out);
console.log(`[encrypt-prompts] Wrote ${OUT} (${out.length} bytes, plaintext ${plaintext.length} bytes).`);
