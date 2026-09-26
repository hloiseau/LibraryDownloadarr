const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Exercise the actual page click handlers with browser/API boundaries replaced.
// No live Plex credentials or additional test framework are needed.
function pageHandler(page, api, popup) {
  const updates = [], signedIn = [], navigation = [];
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: initial => [typeof initial === 'function' ? initial() : initial === true ? false : initial,
      value => updates.push(value)],
    useEffect: () => {},
    useRef: current => ({ current }),
  };
  const modules = {
    react,
    'react-router-dom': { useNavigate: () => destination => navigation.push(destination) },
    '../stores/authStore': { useAuthStore: () => ({
      setUser: user => signedIn.push(user), setToken: token => signedIn.push(token),
    }) },
    '../services/api': { api },
    '../hooks/useMobileMenu': { useMobileMenu: () => ({}) },
    '../components/Header': { Header: 'header' },
    '../components/Sidebar': { Sidebar: 'aside' },
  };
  const source = fs.readFileSync(path.join(__dirname, `../src/pages/${page}.tsx`), 'utf8');
  const javascript = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
    jsx: ts.JsxEmit.React, esModuleInterop: true,
  } }).outputText;
  const exports = {};
  vm.runInNewContext(javascript, {
    exports, require: name => {
      if (!(name in modules)) throw new Error(`Unexpected import ${name}`);
      return modules[name];
    },
    window: { open: () => popup },
    setTimeout: callback => setTimeout(callback, 0),
  });
  const tree = exports[page]();
  const buttons = [];
  const visit = node => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    if (node.type === 'button') buttons.push(node);
    node.children?.forEach(visit);
  };
  visit(tree);
  const button = buttons.find(item => JSON.stringify(item.children).includes(page === 'Login' ? 'Sign in with Plex' : 'Connect with Plex'));
  assert.ok(button, `${page} Plex connection button must exist`);
  return { click: button.props.onClick, updates, signedIn, navigation };
}

for (const page of ['Login', 'Settings']) {
  for (const detached of [true, 'throws']) {
    test(`${page}: pending authorization succeeds with a detached popup (${detached})`, async () => {
      let polls = 0;
      const result = page === 'Login' ? { user: { id: 'alice', username: 'alice' }, token: 'app-session' }
        : [{ id: 'server-1', name: 'My NAS', connections: [{ url: 'http://nas:32400', local: true }] }];
      const poll = async () => ++polls < 3 ? null : result;
      const popup = {
        location: { href: 'about:blank' },
        get closed() { if (detached === 'throws') throw new Error('Cross-origin access blocked'); return true; },
        close() { throw new Error('Popup is isolated'); },
      };
      const pin = async () => ({ flowId: 'bound-flow', url: 'https://app.plex.tv/auth#test' });
      const handler = pageHandler(page, {
        generatePlexPin: pin, connectPlexOwner: pin,
        authenticatePlexPin: poll, getPlexOwnerServers: poll,
      }, popup);
      await handler.click();
      assert.equal(polls, 3, 'must keep checking the backend after a pending result');
      assert.equal(popup.location.href, 'https://app.plex.tv/auth#test');
      if (page === 'Login') {
        assert.equal(handler.signedIn[0]?.id, 'alice');
        assert.equal(handler.signedIn[1], 'app-session');
        assert.deepEqual(handler.navigation, ['/']);
      } else {
        assert.ok(handler.updates.includes(result), 'owned server choices should be displayed');
      }
      assert.ok(!handler.updates.some(value => typeof value === 'string' && /closed|isolated|blocked/i.test(value)));
    });
  }
  test(`${page}: an actual backend denial is still displayed`, async () => {
    const pin = async () => ({ flowId: 'bound-flow', url: 'https://app.plex.tv/auth#test' });
    const deny = async () => { throw { response: { data: { error: 'Access to this server was denied.' } } }; };
    const handler = pageHandler(page, { generatePlexPin: pin, connectPlexOwner: pin,
      authenticatePlexPin: deny, getPlexOwnerServers: deny }, { location: {}, close() {} });
    await handler.click();
    assert.equal(handler.signedIn.length, 0);
    assert.ok(handler.updates.some(value => (value?.text || value) === 'Access to this server was denied.'));
  });
}
