// test-ppt-export-gating.js — login/quota gating of PptExtraViewer.exportToPpt
// and the export-menu quota descriptions (vm sandbox, stub DOM).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'ppt-extra-viewer.js'), 'utf8');

// Builds a fresh sandbox per scenario. `env` customizes Auth state, the fetch
// stub (quota endpoint), and the invoke stub; `calls` records side effects.
function loadViewer(env = {}) {
  const calls = {
    loginShown: 0,
    alerts: [],
    confirms: [],
    opened: [],
    invokes: [],
    imageExports: 0
  };

  const btn = { innerHTML: '<svg></svg>', disabled: false, textContent: '' };
  const descs = (env.descCount ?? 3);
  const menuDescs = Array.from({ length: descs }, () => ({ textContent: '初始' }));

  const context = {
    console,
    URL,
    Number,
    String,
    alert: (msg) => calls.alerts.push(String(msg)),
    confirm: (msg) => { calls.confirms.push(String(msg)); return env.confirmResult ?? false; },
    fetch: env.fetch || (async () => { throw new Error('fetch not stubbed'); }),
    window: {
      Auth: env.auth || null,
      __TAURI__: {
        core: {
          invoke: async (cmd, args) => {
            calls.invokes.push({ cmd, args });
            if (env.invokeError) throw new Error(env.invokeError);
            return env.invokeResult ?? '/tmp/out.pptx';
          }
        },
        shell: { open: async (url) => calls.opened.push(url) }
      },
      open: (url) => calls.opened.push(url)
    },
    document: {
      getElementById(id) { return id === 'ppt-extra-export' ? btn : null; },
      querySelectorAll(sel) {
        return sel.includes('data-export-editable') ? menuDescs : [];
      }
    },
    PpteImageExporter: {
      export: async () => { calls.imageExports += 1; return '/tmp/image.pptx'; }
    }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(`${source}\nglobalThis.PptExtraViewer = PptExtraViewer;`, context);
  const viewer = context.PptExtraViewer;
  viewer.basePath = '/deck';
  viewer.manifest = { title: '测试课件' };
  return { viewer, calls, btn, menuDescs };
}

const loggedIn = {
  isLoggedIn: () => true,
  getToken: () => 'token-123',
  serverUrl: 'https://example.test/',
  membershipUrl: 'https://example.test/membership',
  showLoginModal: () => {}
};

async function main() {
  // 1. Not logged in: every mode is intercepted by the login modal.
  async function notLoggedIn(mode) {
    let holder;
    const auth = {
      isLoggedIn: () => false,
      showLoginModal: () => { holder.calls.loginShown += 1; }
    };
    holder = loadViewer({ auth });
    await holder.viewer.exportToPpt(mode);
    return holder;
  }

  for (const mode of ['image', 'static', 'steps', 'animate']) {
    const { calls } = await notLoggedIn(mode);
    assert.equal(calls.loginShown, 1, `${mode}: login modal shown`);
    assert.equal(calls.imageExports, 0, `${mode}: image exporter not called`);
    assert.equal(calls.invokes.length, 0, `${mode}: no invoke`);
    assert.equal(calls.alerts.length, 0, `${mode}: no alert`);
  }

  // 2. Quota exhausted: alert + optional membership page, no upload.
  {
    const quota = { used: 10, limit: 10, remaining: 0, period: '2026-08', plan_code: 'pro' };
    const { viewer, calls } = loadViewer({
      auth: loggedIn,
      confirmResult: true,
      fetch: async (url, opts) => {
        assert.equal(url, 'https://example.test/api/web/desktop/pptx-export/quota');
        assert.equal(opts.headers.Authorization, 'Bearer token-123');
        return { status: 200, ok: true, json: async () => quota };
      }
    });
    await viewer.exportToPpt('static');
    assert.equal(calls.invokes.filter(c => c.cmd === 'export_pptx_editable').length, 0);
    assert.equal(calls.alerts.length, 1);
    assert.match(calls.alerts[0], /额度已用完（10\/10）/);
    assert.equal(calls.confirms.length, 1);
    assert.deepEqual(calls.opened, ['https://example.test/membership']);
  }

  // 3. Quota endpoint 401: login modal, no upload.
  {
    let holder;
    const auth = {
      ...loggedIn,
      showLoginModal: () => { holder.calls.loginShown += 1; }
    };
    holder = loadViewer({
      auth,
      fetch: async () => ({ status: 401, ok: false, json: async () => ({}) })
    });
    await holder.viewer.exportToPpt('animate');
    assert.equal(holder.calls.loginShown, 1);
    assert.equal(holder.calls.invokes.length, 0);
    assert.equal(holder.calls.alerts.length, 0);
  }

  // 4. Quota available: uploads via export_pptx_editable with contract args.
  {
    const quota = { used: 1, limit: 10, remaining: 9, period: '2026-08', plan_code: 'pro' };
    const { viewer, calls, btn } = loadViewer({
      auth: loggedIn,
      fetch: async () => ({ status: 200, ok: true, json: async () => quota })
    });
    await viewer.exportToPpt('steps');
    const exportCalls = calls.invokes.filter(c => c.cmd === 'export_pptx_editable');
    assert.equal(exportCalls.length, 1);
    // The args object comes from inside the vm realm, so compare field by field.
    assert.equal(exportCalls[0].args.dirPath, '/deck');
    assert.equal(exportCalls[0].args.mode, 'steps');
    assert.equal(exportCalls[0].args.token, 'token-123');
    assert.equal(exportCalls[0].args.serverUrl, 'https://example.test');
    assert.equal(exportCalls[0].args.defaultName, '测试课件-分步版.pptx');
    assert.equal(calls.alerts.length, 1);
    assert.match(calls.alerts[0], /PPT 导出完成/);
    assert.equal(btn.disabled, false);
    assert.equal(btn.innerHTML, '<svg></svg>');
  }

  // 5. Image mode routes to PpteImageExporter (no quota, no upload).
  {
    const { viewer, calls } = loadViewer({ auth: loggedIn });
    await viewer.exportToPpt('image');
    assert.equal(calls.imageExports, 1);
    assert.equal(calls.invokes.length, 0);
    assert.match(calls.alerts[0], /PPT 导出完成/);
  }

  // 6. Server 401 during upload ("unauthorized:" prefix): login modal, no alert.
  {
    let holder;
    const auth = {
      ...loggedIn,
      showLoginModal: () => { holder.calls.loginShown += 1; }
    };
    const quota = { used: 0, limit: 10, remaining: 10, period: '2026-08', plan_code: 'pro' };
    holder = loadViewer({
      auth,
      invokeError: 'unauthorized: 登录状态已失效，请重新登录',
      fetch: async () => ({ status: 200, ok: true, json: async () => quota })
    });
    await holder.viewer.exportToPpt('static');
    assert.equal(holder.calls.loginShown, 1);
    assert.equal(holder.calls.alerts.length, 0);
  }

  // 7. Menu descriptions: logged in shows remaining quota, logged out shows 登录后可用.
  {
    const quota = { used: 5, limit: 10, remaining: 5, period: '2026-08', plan_code: 'pro' };
    const { viewer, menuDescs } = loadViewer({
      auth: loggedIn,
      fetch: async () => ({ status: 200, ok: true, json: async () => quota })
    });
    await viewer._refreshExportMenuQuota();
    for (const desc of menuDescs) {
      assert.equal(desc.textContent, '可编辑 · 本月剩 5 次');
    }
  }
  {
    const { viewer, menuDescs } = loadViewer({
      auth: { isLoggedIn: () => false }
    });
    await viewer._refreshExportMenuQuota();
    for (const desc of menuDescs) {
      assert.equal(desc.textContent, '登录后可用');
    }
  }
  {
    // 401 while the menu is open falls back to 登录后可用.
    const { viewer, menuDescs } = loadViewer({
      auth: loggedIn,
      fetch: async () => ({ status: 401, ok: false, json: async () => ({}) })
    });
    await viewer._refreshExportMenuQuota();
    for (const desc of menuDescs) {
      assert.equal(desc.textContent, '登录后可用');
    }
  }

  console.log('test-ppt-export-gating: all assertions passed');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
