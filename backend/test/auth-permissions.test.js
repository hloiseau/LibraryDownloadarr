const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const axios = require('axios');
const { DatabaseService } = require('../dist/models/database');
const { PlexService, plexService } = require('../dist/services/plexService');
const { PlexAuthFlows, exactServer, serverToken } = require('../dist/services/plexAuthFlow');
const { createAuthRouter } = require('../dist/routes/auth');
const { createSettingsRouter } = require('../dist/routes/settings');
const { createPermissionsRouter } = require('../dist/routes/permissions');
const { createMediaRouter } = require('../dist/routes/media');
const { readPolicy, assertDownloadPolicy } = require('../dist/services/downloadPolicy');

async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
function database(t) {
  const db = new DatabaseService(':memory:'); t.after(() => db.close()); return db;
}
function provider(overrides = {}) {
  let pinId = 0;
  return {
    generatePin: async () => ({ id: ++pinId, code: 'ABCD' }),
    checkPin: async () => ({ authToken: 'private-account-token', user: { uuid: 'plex:42', id: 42, username: 'alice', email: 'alice@example.test' } }),
    getUserServers: async () => [{ provides: 'server', clientIdentifier: 'server-1', owned: '0', accessToken: 'shared-server-token' }],
    ...overrides,
  };
}
async function application(t, db, flows) {
  const app = express(); app.use(express.json());
  app.use('/auth', createAuthRouter(db, flows));
  app.use('/settings', createSettingsRouter(db, flows));
  app.use('/permissions', createPermissionsRouter(db));
  app.use('/media', createMediaRouter(db));
  const url = await listen(t, app);
  return (route, body, token, method = body === undefined ? 'GET' : 'POST') => fetch(url + route, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// Identity comes from Plex's user endpoint, never the temporary PIN id.
test('different authorized PINs resolve to the same verified Plex account', async t => {
  const calls = [];
  t.mock.method(axios, 'get', async (url, options) => {
    calls.push({ url, options });
    return { data: url.endsWith('/user') ? { id: 42, username: 'alice' } : { id: Number(url.split('/').pop()), authToken: 'account-token' } };
  });
  const service = new PlexService();
  const first = await service.checkPin(123, 'installation-id');
  const second = await service.checkPin(456, 'installation-id');
  assert.equal(first.user.uuid, 'plex:42'); assert.equal(second.user.uuid, first.user.uuid);
  assert.equal(calls[1].options.headers['X-Plex-Token'], 'account-token');
});

test('a requested server never falls back to a different accessible server', () => {
  const servers = [{ provides: 'server', clientIdentifier: 'different-server', owned: '1', Connection: [{ uri: 'http://other:32400', local: '1' }] }];
  assert.throws(() => exactServer(servers, 'server-1'), { status: 403 });
  assert.equal(new PlexService().findBestServerConnection(servers, 'server-1').serverUrl, null);
  assert.throws(() => serverToken({ owned: '0' }, 'owner-token'), { status: 403 });
});

test('Plex login preserves per-user policy across logins and never returns Plex credentials', async t => {
  const db = database(t); db.setSetting('plex_url', 'http://plex:32400'); db.setSetting('plex_machine_id', 'server-1');
  const call = await application(t, db, new PlexAuthFlows(provider(), 'install-id'));
  const signIn = async () => {
    const pin = await (await call('/auth/plex/pin', {})).json();
    const response = await call('/auth/plex/authenticate', { flowId: pin.flowId });
    assert.equal(response.status, 200); const result = await response.json();
    assert.doesNotMatch(JSON.stringify(result), /private-account-token|shared-server-token|plexToken/);
    assert.equal((await call('/auth/plex/authenticate', { flowId: pin.flowId })).status, 400);
    return result;
  };
  const first = await signIn();
  const policy = { enabled: true, libraries: ['1'], qualities: ['720p-2'], serverId: 'server-1' };
  db.setSetting(`download_policy:${first.user.id}`, JSON.stringify(policy));
  const next = await signIn(); assert.equal(next.user.id, first.user.id);
  assert.equal(db.listPlexUsers().length, 1);
  const me = await (await call('/auth/me', undefined, next.token)).json();
  assert.equal(me.user.username, 'alice'); assert.equal(me.user.plexToken, undefined);
  assert.deepEqual(await (await call('/permissions/me', undefined, next.token)).json(), policy);
  assert.equal((await call('/permissions', undefined, next.token)).status, 403);
  assert.equal((await call('/settings/plex/connect', {}, next.token)).status, 403);
  assert.equal((await call('/permissions/default', policy, next.token, 'PUT')).status, 403);
});

test('login denies users whose resources do not include the configured server', async t => {
  const db = database(t); db.setSetting('plex_url', 'http://plex:32400'); db.setSetting('plex_machine_id', 'missing');
  const call = await application(t, db, new PlexAuthFlows(provider(), 'install-id'));
  const pin = await (await call('/auth/plex/pin', {})).json();
  assert.equal((await call('/auth/plex/authenticate', { flowId: pin.flowId })).status, 403);
  assert.equal(db.listPlexUsers().length, 0);
});

test('owner setup binds authorization to the admin session and verifies server before sending token', async t => {
  const requests = [];
  let machineId = 'wrong-server';
  const url = await listen(t, (req, res) => {
    requests.push({ path: req.url, token: req.headers['x-plex-token'] });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ MediaContainer: { machineIdentifier: machineId, Directory: [] } }));
  });
  const db = database(t);
  const admin = db.createAdminUser({ username: 'owner', email: 'owner@example.test', passwordHash: 'unused', isAdmin: true });
  const one = db.createSession(admin.id); const two = db.createSession(admin.id);
  const guest = db.createOrUpdatePlexUser({ username: 'old', email: '', plexId: 'plex:99', plexToken: 'old' });
  const oldSession = db.createSession(guest.id);
  db.setSetting('plex_machine_id', 'old-server');
  const flows = new PlexAuthFlows(provider({ getUserServers: async () => [
    { provides: 'server', clientIdentifier: 'server-1', name: 'My NAS', owned: '1', accessToken: 'owner-server-token', Connection: [{ uri: url, local: '1' }] },
    { provides: 'server', clientIdentifier: 'shared', name: 'Other NAS', owned: '0', accessToken: 'secret-other' },
  ] }), 'installation-id');
  const call = await application(t, db, flows);
  const pin = await (await call('/settings/plex/connect', {}, one.token)).json();
  assert.equal(new URLSearchParams(new URL(pin.url).hash.slice(2)).get('clientID'), 'installation-id');
  assert.equal((await call('/settings/plex/servers', { flowId: pin.flowId }, two.token)).status, 400);
  const choices = await (await call('/settings/plex/servers', { flowId: pin.flowId }, one.token)).json();
  assert.equal(choices.servers.length, 1); assert.equal(choices.servers[0].name, 'My NAS');
  assert.doesNotMatch(JSON.stringify(choices), /token|secret-other/);
  const body = { flowId: pin.flowId, serverId: 'server-1', url };
  assert.equal((await call('/settings/plex/select', body, one.token)).status, 400);
  assert.equal(requests.length, 1); assert.equal(requests[0].token, undefined);
  machineId = 'server-1';
  assert.equal((await call('/settings/plex/select', body, one.token)).status, 200);
  assert.equal(db.getSetting('plex_token'), 'owner-server-token');
  assert.equal(db.getSetting('plex_url'), url);
  assert.equal(requests.find(req => req.path === '/library/sections').token, 'owner-server-token');
  assert.equal(db.getSessionByToken(oldSession.token), undefined);
  assert.ok(db.getSessionByToken(one.token));
  assert.equal((await call('/settings/plex/select', body, one.token)).status, 400);
});

test('legacy sessions are invalidated once without losing admin or download history', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lda-identity-'));
  const file = path.join(dir, 'app.db');
  let db;
  try {
    db = new DatabaseService(file);
    const admin = db.createAdminUser({ username: 'admin', email: 'admin@example.test', passwordHash: 'unused', isAdmin: true });
    const adminSession = db.createSession(admin.id);
    const legacy = db.createOrUpdatePlexUser({ username: 'alice', email: '', plexId: '12345', plexToken: 'old' });
    const legacySession = db.createSession(legacy.id);
    db.logDownload(legacy.id, 'Old download', '1', 100);
    db.setSetting('plex_identity_version', ''); db.close();
    db = new DatabaseService(file);
    assert.equal(db.getSessionByToken(legacySession.token), undefined);
    assert.ok(db.getSessionByToken(adminSession.token));
    assert.equal(db.getDownloadHistory(legacy.id).length, 1);
    const stable = db.createOrUpdatePlexUser({ username: 'alice', email: '', plexId: 'plex:42', plexToken: 'new' });
    const fresh = db.createSession(stable.id); db.close(); db = new DatabaseService(file);
    assert.ok(db.getSessionByToken(fresh.token)); assert.equal(db.listPlexUsers().length, 1);
  } finally { db?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('default rules, user overrides, reset and server changes are enforced', async t => {
  const db = database(t); db.setSetting('plex_machine_id', 'server-1');
  const user = db.createOrUpdatePlexUser({ username: 'alice', email: '', plexId: 'plex:42', plexToken: 'shared' });
  const admin = db.createAdminUser({ username: 'owner', email: 'owner@example.test', passwordHash: 'unused', isAdmin: true });
  const session = db.createSession(admin.id);
  const call = await application(t, db, new PlexAuthFlows(provider(), 'install'));
  const defaults = { enabled: false, libraries: null, qualities: ['720p-2'] };
  assert.equal((await call('/permissions/default', defaults, session.token, 'PUT')).status, 200);
  assert.equal(readPolicy(db, user).enabled, false);
  assert.equal(readPolicy(db, admin).enabled, true);
  const custom = { enabled: true, libraries: ['1'], qualities: ['720p-2'] };
  assert.equal((await call(`/permissions/${user.id}`, custom, session.token, 'PUT')).status, 200);
  assert.doesNotThrow(() => assertDownloadPolicy(db, user, '720p-2', { librarySectionID: 1 }));
  assert.throws(() => assertDownloadPolicy(db, user, 'original', { librarySectionID: 1 }), { status: 403 });
  assert.throws(() => assertDownloadPolicy(db, user, '720p-2', {}), { status: 403 });
  assert.equal((await call(`/permissions/${user.id}`, { ...custom, qualities: ['4k'] }, session.token, 'PUT')).status, 400);
  db.setSetting('plex_machine_id', 'another-server');
  assert.throws(() => assertDownloadPolicy(db, user, '720p-2', { librarySectionID: 1 }), { status: 403 });
  db.setSetting('plex_machine_id', 'server-1');
  assert.equal((await call(`/permissions/${user.id}`, { inherit: true }, session.token, 'PUT')).status, 200);
  assert.equal(readPolicy(db, user).enabled, false);
});

test('original and bulk download routes enforce policy and reject forged part keys before bytes', async t => {
  const db = database(t); db.setSetting('plex_url', 'http://unused'); db.setSetting('plex_machine_id', 'server-1');
  const user = db.createOrUpdatePlexUser({ username: 'alice', email: '', plexId: 'plex:42', plexToken: 'shared' });
  const session = db.createSession(user.id);
  const item = { ratingKey: '1', type: 'movie', title: 'Sample', librarySectionID: '1', allowSync: true, Media: [{ Part: [{ key: '/library/parts/1/file.mkv', file: 'sample.mkv' }] }] };
  t.mock.method(plexService, 'getMediaMetadata', async () => item);
  t.mock.method(plexService, 'getEpisodes', async () => [item]);
  t.mock.method(plexService, 'getTracks', async () => [item]);
  const call = await application(t, db, new PlexAuthFlows(provider(), 'install'));
  const policy = { enabled: true, qualities: ['720p-2'], libraries: ['1'], serverId: 'server-1' };
  db.setSetting(`download_policy:${user.id}`, JSON.stringify(policy));
  for (const route of ['/media/1/download?partKey=%2Flibrary%2Fparts%2F1%2Ffile.mkv', '/media/season/1/download', '/media/album/1/download']) {
    assert.equal((await call(route, undefined, session.token)).status, 403, route);
  }
  db.setSetting(`download_policy:${user.id}`, JSON.stringify({ ...policy, qualities: ['original'] }));
  assert.equal((await call('/media/1/download?partKey=%2Flibrary%2Fparts%2F999%2Ffile.mkv', undefined, session.token)).status, 400);
});
