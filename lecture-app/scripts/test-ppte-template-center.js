const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'ppte-create.js'), 'utf8');
const calls = [];
const storage = new Map();
let remoteAvailable = true;
const context = {
  console,
  document: {},
  localStorage: {
    getItem(key) { return storage.get(key) || null; },
    setItem(key, value) { storage.set(key, String(value)); },
  },
  window: {
    Settings: {},
    Auth: {
      serverUrl: 'https://example.test',
      isLoggedIn() { return true; },
      getToken() { return 'token'; },
      getUser() { return { id: 'user-1' }; },
    },
    __TAURI__: {
      core: {
        async invoke(command, payload) {
          calls.push({ command, payload });
          if (command === 'list_deck_templates_builtin') {
            return [{ id: 'scholar-blue', name: '学术蓝', version: '1.1.0', source: 'builtin', hasPreview: true }];
          }
          if (command === 'deck_templates_fetch_list') {
            if (!remoteAvailable) throw new Error('offline');
            return {
              mine: [{ id: '11111111-1111-1111-1111-111111111111', name: '我的模板', digest: 'sha256:a', status: 'private' }],
              center: [{ id: '22222222-2222-2222-2222-222222222222', name: '公开模板', digest: 'sha256:b', status: 'approved' }],
            };
          }
          if (command === 'read_ppte_template_blueprints') {
            return { roles: {
              'cover.html': '<main>cover</main>',
              'content-text.html': '<main>text</main>',
              'content-visual.html': '<main>visual</main>',
              'finish.html': '<main>finish</main>',
            } };
          }
          throw new Error(`unexpected command ${command}`);
        },
      },
    },
  },
};

vm.createContext(context);
vm.runInContext(`${source}\nglobalThis.PpteCreate = window.PpteCreate;`, context);
const create = context.PpteCreate;
create._escapeHtml = value => String(value);
create._escapeAttr = value => String(value);

(async () => {
  const templates = await create._loadTemplates();
  assert.deepEqual(Array.from(templates, item => `${item.section}:${item.source}`), [
    'builtin:builtin', 'mine:custom', 'center:cloud',
  ]);
  assert.deepEqual(calls[1], {
    command: 'deck_templates_fetch_list',
    payload: { serverUrl: 'https://example.test', token: 'token' },
  });
  remoteAvailable = false;
  const offlineTemplates = await create._loadTemplates();
  assert.equal(offlineTemplates.filter(item => item.cached).length, 2, 'verified catalog metadata remains selectable offline');

  const manifest = {
    agentTemplate: {
      schemaVersion: 2,
      roles: {
        cover: { blueprintFile: '.ppte-template/roles/cover.html' },
        content: [
          { id: 'text', blueprintFile: '.ppte-template/roles/content-text.html' },
          { id: 'visual', blueprintFile: '.ppte-template/roles/content-visual.html' },
        ],
        finish: { blueprintFile: '.ppte-template/roles/finish.html' },
      },
    },
  };
  const editorFiles = await create._loadEditorTemplateFiles('/tmp/deck', manifest);
  assert.equal(editorFiles.cover, '<main>cover</main>');
  assert.equal(editorFiles.content, '<main>text</main>', 'manual editor uses the first content variant by default');
  assert.equal(editorFiles.finish, '<main>finish</main>');
  assert.equal(editorFiles.catalog, undefined);

  const card = create._templateCardHtml(templates[1], true);
  assert.match(card, /我的模板/);
  assert.match(card, /selected/);
  console.log('test-ppte-template-center: all assertions passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
