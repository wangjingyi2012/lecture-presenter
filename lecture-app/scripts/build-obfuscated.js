#!/usr/bin/env node
/**
 * Build script that obfuscates JS before Tauri bundles the app.
 *
 * Flow:
 *   1. Copy  src/ -> dist/   (fresh copy every run)
 *   2. Obfuscate every .js in dist/js/  (skip vendor/)
 *   2b. Encrypt the prompt asset when PPTE_PROMPT_KEY is set
 *   3. Patch tauri.conf.json  frontendDist -> "../dist" (+ prompts.enc if encrypted)
 *   4. Run `tauri build`
 *   5. Restore tauri.conf.json
 *   6. Clean up dist/
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const TAURI_CONF = path.join(ROOT, 'src-tauri', 'tauri.conf.json');

// Obfuscator options - high obfuscation, keep runtime perf reasonable
const OBF_OPTIONS = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.5,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.2,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,          // don't rename window.Auth etc.
  selfDefending: false,          // can break in strict CSP
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.75,
  unicodeEscapeSequence: false,
};

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function rmSync(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function obfuscateDir(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      obfuscateDir(fullPath);
    } else if (entry.name.endsWith('.js')) {
      const code = fs.readFileSync(fullPath, 'utf-8');
      console.log(`  obfuscating: ${path.relative(DIST, fullPath)}`);
      const result = JavaScriptObfuscator.obfuscate(code, OBF_OPTIONS);
      fs.writeFileSync(fullPath, result.getObfuscatedCode());
    }
  }
}

// ── Main ──

console.log('=== Obfuscated Build ===\n');

// 1. Clean & copy
console.log('1. Copying src -> dist ...');
rmSync(DIST);
copyDirSync(SRC, DIST);

// 2. Obfuscate JS (skip vendor/)
console.log('2. Obfuscating JS files ...');
const jsDir = path.join(DIST, 'js');
if (fs.existsSync(jsDir)) {
  obfuscateDir(jsDir);
}

// 2b. Encrypt the prompt asset when a key is configured.
let encAvailable = false;
if (process.env.PPTE_PROMPT_KEY) {
  console.log('2b. Encrypting prompt asset ...');
  execSync('node scripts/encrypt-prompts.js', { cwd: ROOT, stdio: 'inherit' });
  encAvailable = true;
} else {
  console.log('2b. PPTE_PROMPT_KEY not set; release will use the plaintext prompt example.');
}

// 3. Patch tauri.conf.json
console.log('3. Patching tauri.conf.json -> frontendDist: "../dist" ...');
const confRaw = fs.readFileSync(TAURI_CONF, 'utf-8');
let confPatched = confRaw.replace('"frontendDist": "../src"', '"frontendDist": "../dist"');
if (encAvailable) {
  confPatched = confPatched.replace(
    '"resources/prompts.example.txt"',
    '"resources/prompts.example.txt",\n      "resources/prompts.enc"'
  );
}
fs.writeFileSync(TAURI_CONF, confPatched);

// 4. Build
const targetArg = process.argv[2] || '';
const buildCmd = targetArg
  ? `npx tauri build --target ${targetArg}`
  : 'npx tauri build';
console.log(`4. Running: ${buildCmd} ...\n`);
try {
  execSync(buildCmd, { cwd: ROOT, stdio: 'inherit' });
} finally {
  // 5. Restore tauri.conf.json (always, even if build fails)
  console.log('\n5. Restoring tauri.conf.json -> frontendDist: "../src" ...');
  const confNow = fs.readFileSync(TAURI_CONF, 'utf-8');
  let restored = confNow.replace('"frontendDist": "../dist"', '"frontendDist": "../src"');
  restored = restored.replace(
    '"resources/prompts.example.txt",\n      "resources/prompts.enc"',
    '"resources/prompts.example.txt"'
  );
  fs.writeFileSync(TAURI_CONF, restored);

  // 6. Clean dist/
  console.log('6. Cleaning dist/ ...');
  rmSync(DIST);
}

console.log('\n=== Build complete ===');
