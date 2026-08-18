// Tests for Updater's ignore-version logic: the dialog offers 立即更新 /
// 忽略这个版本 / 下次再提醒我, and an ignored version is skipped on later
// checks (unless force_update or a newer version). Runs updater.js in a vm
// sandbox with stubbed __TAURI__ and document.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const updaterPath = path.join(__dirname, '..', 'src', 'js', 'updater.js');
const source = fs.readFileSync(updaterPath, 'utf8');

// Build a fresh sandbox per test so Updater state never leaks between cases.
function makeSandbox({ updateResult, savedConfigs = [], readConfig = {} } = {}) {
  const invokeCalls = [];
  const context = {
    console,
    document: {
      querySelector: () => null,
    },
    window: {
      __TAURI__: {
        core: {
          invoke: async (cmd, args) => {
            invokeCalls.push({ cmd, args });
            if (cmd === 'check_update') return updateResult;
            if (cmd === 'read_app_config') return { ...readConfig };
            if (cmd === 'save_app_config') {
              savedConfigs.push(JSON.parse(args.configJson));
              return null;
            }
            throw new Error('unexpected command: ' + cmd);
          },
        },
      },
    },
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  return { Updater: context.window.Updater, invokeCalls };
}

async function testSkipsIgnoredVersion() {
  const { Updater } = makeSandbox({
    updateResult: { has_update: true, version: '2.2.0', download_url: 'https://x/dl' },
  });
  let shown = null;
  Updater.showUpdateDialog = (info) => { shown = info; };
  await Updater.init({ updateServer: 'https://x', ignoredUpdateVersion: '2.2.0' });
  assert.strictEqual(Updater.ignoredVersion, '2.2.0');
  assert.strictEqual(shown, null, 'ignored version must not show the dialog');
}

async function testShowsDialogForNewerVersion() {
  const { Updater } = makeSandbox({
    updateResult: { has_update: true, version: '2.3.0', download_url: 'https://x/dl' },
  });
  let shown = null;
  Updater.showUpdateDialog = (info) => { shown = info; };
  await Updater.init({ updateServer: 'https://x', ignoredUpdateVersion: '2.2.0' });
  assert.strictEqual(shown && shown.version, '2.3.0');
}

async function testForceUpdateIgnoresSkipList() {
  const { Updater } = makeSandbox({
    updateResult: { has_update: true, version: '2.2.0', force_update: true, download_url: 'https://x/dl' },
  });
  let shown = null;
  Updater.showUpdateDialog = (info) => { shown = info; };
  await Updater.init({ updateServer: 'https://x', ignoredUpdateVersion: '2.2.0' });
  assert.strictEqual(shown && shown.version, '2.2.0');
}

async function testNoUpdateKeepsQuiet() {
  const { Updater } = makeSandbox({
    updateResult: { has_update: false },
  });
  let shown = null;
  Updater.showUpdateDialog = (info) => { shown = info; };
  await Updater.init({ updateServer: 'https://x' });
  assert.strictEqual(shown, null);
}

async function testIgnoreVersionPersistsConfig() {
  const savedConfigs = [];
  const { Updater } = makeSandbox({
    savedConfigs,
    readConfig: { theme: 'dark', fontSize: 18 },
  });
  Updater.closeDialog = () => {};
  await Updater.ignoreVersion('2.2.0');
  assert.strictEqual(Updater.ignoredVersion, '2.2.0');
  assert.strictEqual(savedConfigs.length, 1);
  // Existing fields must survive the read-modify-write round trip.
  assert.deepStrictEqual(savedConfigs[0], { theme: 'dark', fontSize: 18, ignoredUpdateVersion: '2.2.0' });
}

(async () => {
  await testSkipsIgnoredVersion();
  await testShowsDialogForNewerVersion();
  await testForceUpdateIgnoresSkipList();
  await testNoUpdateKeepsQuiet();
  await testIgnoreVersionPersistsConfig();
  console.log('updater tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
