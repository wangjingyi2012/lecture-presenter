const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const authPath = path.join(__dirname, '..', 'src', 'js', 'auth.js');
const source = fs.readFileSync(authPath, 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
const authCss = fs.readFileSync(path.join(__dirname, '..', 'src', 'css', 'auth.css'), 'utf8');

function makeElement() {
  return {
    src: '',
    value: '',
    style: {},
    classList: { add() {}, remove() {} },
    addEventListener() {},
    focus() {},
  };
}

function createHarness(handler) {
  const calls = [];
  const storage = new Map();
  const elements = new Map([
    ['auth-captcha-image', makeElement()],
    ['auth-login-captcha', makeElement()],
  ]);
  const context = {
    console,
    fetch: async () => { throw new Error('desktop auth must not use WebView fetch'); },
    localStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    document: {
      getElementById: (id) => elements.get(id) || null,
      createElement: () => makeElement(),
      addEventListener() {},
      removeEventListener() {},
    },
    Tracker: { track() {} },
    window: {
      errorLogs: [],
      __TAURI__: {
        core: {
          async invoke(command, args) {
            calls.push({ command, args });
            return handler(command, args);
          },
        },
      },
    },
  };
  context.window.window = context.window;
  vm.createContext(context);
  vm.runInContext(source, context);
  return { Auth: context.window.Auth, calls, storage, elements };
}

(async () => {
  assert.match(html, /css\/auth\.css\?v=2/, 'auth stylesheet URL should invalidate stale WebView cache');
  assert.match(
    authCss,
    /grid-template-columns:\s*160px minmax\(0, 1fr\) auto;/,
    'captcha image, input, and refresh button should share one row'
  );
  assert.match(authCss, /grid-template-rows:\s*54px;/);

  {
    const harness = createHarness((_command, args) => {
      assert.equal(args.action, 'login');
      assert.deepEqual(JSON.parse(JSON.stringify(args.payload)), {
        username: 'alice',
        password: 'secret123',
        captcha_id: 'captcha-12345678',
        captcha_code: 'A1B2',
      });
      return {
        ok: true,
        status: 200,
        data: {
          token: 'token-1',
          user: { id: '1', username: 'alice', role: 'user', membership: 1 },
        },
      };
    });
    harness.Auth._captchaId = 'captcha-12345678';

    const result = await harness.Auth.login('alice', 'secret123', 'A1B2');

    assert.equal(result.success, true);
    assert.equal(harness.calls[0].command, 'auth_api_request');
    assert.equal(harness.storage.get('auth_token'), 'token-1');
  }

  {
    const harness = createHarness(() => ({
      ok: false,
      status: 401,
      data: { detail: '用户名或密码错误' },
    }));
    harness.Auth._captchaId = 'captcha-12345678';

    const result = await harness.Auth.login('alice', 'wrong-pass', 'A1B2');

    assert.deepEqual(JSON.parse(JSON.stringify(result)), {
      success: false,
      detail: '用户名或密码错误',
    });
  }

  {
    const harness = createHarness((_command, args) => {
      assert.equal(args.action, 'captcha');
      return {
        ok: true,
        status: 200,
        data: {
          captcha_id: 'captcha-abcdefgh',
          image_base64: 'data:image/svg+xml;base64,PHN2Zy8+',
          expires_in: 300,
        },
      };
    });

    await harness.Auth._loadCaptcha();

    assert.equal(harness.Auth._captchaId, 'captcha-abcdefgh');
    assert.equal(
      harness.elements.get('auth-captcha-image').src,
      'data:image/svg+xml;base64,PHN2Zy8+'
    );
  }

  {
    const harness = createHarness((_command, args) => {
      assert.equal(args.action, 'register');
      assert.deepEqual(JSON.parse(JSON.stringify(args.payload)), {
        username: 'new-user',
        password: 'password123',
        email: 'new@example.com',
      });
      return {
        ok: true,
        status: 200,
        data: {
          token: 'token-2',
          user: { id: '2', username: 'new-user', role: 'user', membership: 1 },
        },
      };
    });

    const result = await harness.Auth.register('new-user', 'password123', 'new@example.com');

    assert.equal(result.success, true);
    assert.equal(harness.storage.get('auth_token'), 'token-2');
  }

  {
    const harness = createHarness((_command, args) => {
      assert.equal(args.action, 'me');
      assert.equal(args.token, 'token-3');
      return {
        ok: true,
        status: 200,
        data: { id: '3', username: 'saved-user', role: 'user', membership: 2 },
      };
    });
    harness.Auth._token = 'token-3';

    await harness.Auth._validateToken();

    assert.equal(harness.Auth._user.username, 'saved-user');
    assert.match(harness.storage.get('auth_user'), /saved-user/);
  }

  console.log('auth tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
