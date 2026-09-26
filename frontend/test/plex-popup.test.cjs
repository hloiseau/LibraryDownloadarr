const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Exercise the actual page click handlers with browser/API boundaries replaced.
// No live Plex credentials or additional test framework are needed.
function pageHandler(page, api, popup) {
  const updates = [], signedIn = [], navigation = [], state = [];
  let cursor = 0;
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: initial => {
      const index = cursor++;
      if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial === true ? false : initial;
      return [state[index], value => {
        state[index] = typeof value === 'function' ? value(state[index]) : value;
        updates.push(state[index]);
      }];
    },
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
  const render = () => {
    cursor = 0;
    const tree = exports[page]();
    const nodes = [];
    const visit = node => {
      if (Array.isArray(node)) return node.forEach(visit);
      if (!node || typeof node !== 'object') return;
      nodes.push(node);
      node.children?.forEach(visit);
    };
    visit(tree);
    return nodes;
  };
  const button = render().find(item => item.type === 'button' && JSON.stringify(item.children).includes(page === 'Login' ? 'Sign in with Plex' : 'Connect with Plex'));
  assert.ok(button, `${page} Plex connection button must exist`);
  return { click: button.props.onClick, updates, signedIn, navigation, render };
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


test('Settings offers every address, submits the selected URL and permits a custom retry', async () => {
  const urls = { local: 'http://192.168.1.10:32400', remote: 'https://remote.plex.direct:32400', relay: 'https://relay.plex.tv' };
  const calls = [];
  const choices = [{ id: 'server-1', name: 'NAS', connections: [
    { url: urls.local, local: true }, { url: urls.remote, local: false }, { url: urls.relay, local: false, relay: true },
  ] }];
  const handler = pageHandler('Settings', {
    connectPlexOwner: async () => ({ flowId: 'flow', url: 'https://app.plex.tv/auth' }),
    getPlexOwnerServers: async () => choices,
    selectPlexServer: async (...args) => {
      calls.push(args);
      if (args[2] === urls.remote) throw { response: { data: { error: 'Connection refused (ECONNREFUSED).' } } };
    },
    getSettings: async () => ({ plexUrl: 'http://custom-nas:32400', hasPlexToken: true }),
  }, { location: {}, close() {} });
  await handler.click();
  let nodes = handler.render();
  let select = nodes.find(node => node.props.id === 'plex-address');
  assert.equal(select.props.value, '', 'owner must choose; do not silently pick the first local URL');
  for (const url of Object.values(urls)) assert.ok(nodes.some(node => node.type === 'option' && node.props.value === url));
  assert.ok(nodes.some(node => node.type === 'option' && node.children.includes('Relay')));
  assert.equal(calls.length, 0, 'listing addresses must not connect to any server');
  select.props.onChange({ target: { value: urls.remote } });
  nodes = handler.render();
  const form = () => handler.render().find(node => node.type === 'form' && JSON.stringify(node.children).includes('plex-address'));
  await form().props.onSubmit({ preventDefault() {} });
  assert.deepEqual(calls, [['flow', 'server-1', urls.remote]]);
  nodes = handler.render(); select = nodes.find(node => node.props.id === 'plex-address');
  assert.equal(select.props.value, urls.remote, 'keep the failed selection so the owner can change it');
  assert.ok(handler.updates.some(value => value?.text === 'Connection refused (ECONNREFUSED).'));
  select.props.onChange({ target: { value: 'custom' } });
  nodes = handler.render();
  nodes.find(node => node.props.id === 'plex-custom-address').props.onChange({ target: { value: 'http://custom-nas:32400' } });
  await form().props.onSubmit({ preventDefault() {} });
  assert.deepEqual(calls[1], ['flow', 'server-1', 'http://custom-nas:32400']);
});
