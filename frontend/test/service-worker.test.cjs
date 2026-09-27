const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function worker() {
  const handlers = {};
  const fetched = [];
  const cached = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/service-worker.js'), 'utf8'), {
    self: { addEventListener: (name, handler) => { handlers[name] = handler; } },
    URL,
    fetch: async request => {
      fetched.push(request.url);
      return new Response('<html>app</html>', { headers: { 'Content-Type': 'text/html' } });
    },
    caches: { open: async () => ({ put: (request) => { cached.push(request.url); } }) },
  });
  const dispatch = (pathname, method = 'GET') => {
    let response;
    handlers.fetch({ request: new Request(`https://downloads.example.com${pathname}`, { method }),
      respondWith: promise => { response = promise; } });
    return response;
  };
  return { dispatch, fetched, cached };
}

test('native POST and original downloads bypass service worker interception entirely', () => {
  const sw = worker();
  for (const [pathname, method] of [
    ['/api/downloads/job/file', 'POST'], ['/api/plex/download/1', 'GET'],
    ['/download/movie', 'GET'], ['/season/1', 'GET'], ['/album/2', 'GET'],
  ]) assert.equal(sw.dispatch(pathname, method), undefined);
  assert.deepEqual(sw.fetched, []);
  assert.deepEqual(sw.cached, []);
});

test('authenticated APIs never receive worker responses or cache lookups', () => {
  const sw = worker();
  for (const pathname of ['/api/auth/me', '/api/permissions/me', '/api/downloads/job']) {
    assert.equal(sw.dispatch(pathname), undefined);
  }
  assert.deepEqual(sw.fetched, []);
  assert.deepEqual(sw.cached, []);
});

test('the application shell retains network-first caching', async () => {
  const sw = worker();
  const response = await sw.dispatch('/index.html');
  assert.equal(await response.text(), '<html>app</html>');
  assert.deepEqual(sw.fetched, ['https://downloads.example.com/index.html']);
  assert.deepEqual(sw.cached, ['https://downloads.example.com/index.html']);
});
