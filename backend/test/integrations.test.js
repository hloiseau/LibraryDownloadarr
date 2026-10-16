const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { DatabaseService } = require('../dist/models/database');
const { createIntegrationsRouter, integrationBuildRevision } = require('../dist/routes/integrations');

async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
async function fixture(t) {
  const db = new DatabaseService(':memory:'); t.after(() => db.close());
  const state = { machine: 'server-fixture', denied: false, check: null, calls: [] };
  const source = await listen(t, (req, res) => {
    state.calls.push({ path: req.url, token: req.headers['x-plex-token'] });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/identity') return res.end(JSON.stringify({ MediaContainer: { machineIdentifier: state.machine } }));
    assert.equal(req.url, '/library/sections'); assert.equal(req.headers['x-plex-token'], 'personal-secret');
    state.check?.();
    if (state.denied) { res.statusCode = 403; return res.end('private-provider-error'); }
    return res.end(JSON.stringify({ MediaContainer: { Directory: [{ key: '1' }], friendlyName: 'private-server-name' } }));
  });
  db.setSetting('plex_url', source); db.setSetting('plex_machine_id', 'server-fixture'); db.setSetting('plex_token', 'admin-secret');
  const user = db.createOrUpdatePlexUser({ username: 'private-name', email: 'private-email', plexId: 'plex:42', plexToken: 'personal-secret' });
  const session = db.createSession(user.id, 60000);
  const app = express(); app.use('/api/integrations', createIntegrationsRouter(db));
  const base = await listen(t, app);
  const get = (token = session.token, suffix = '') => fetch(base + '/api/integrations/concierge' + suffix, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { db, user, session, state, get };
}

test('integration identifies the personal Plex account, exact server and real session deadline', async t => {
  const f = await fixture(t);
  f.db.setSetting(`download_policy:${f.user.id}`, JSON.stringify({ enabled: true, libraries: ['1'], qualities: ['original', '720p-2'], serverId: 'server-fixture' }));
  const response = await f.get(); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const data = await response.json();
  assert.deepEqual(data, { contractVersion: 1, buildRevision: integrationBuildRevision(), user: { plexId: '42' }, plexServerId: 'server-fixture', sessionExpiresAt: f.session.expiresAt,
    capabilities: { qualityOptions: ['720p-2'], streamOptions: true, preparedDownloads: true, singleUseTickets: true, queuePersistence: 'memory' } });
  assert.doesNotMatch(JSON.stringify(data), /secret|private|https?:|plexToken|bearer/i);
  assert.equal(f.state.calls[0].token, undefined);
  assert.equal(f.state.calls[1].token, 'personal-secret');
  assert.equal((await f.get(f.session.token, '?plexId=other')).status, 400);
});

test('integration refuses anonymous, local administrator, legacy identity and expired sessions before source access', async t => {
  const f = await fixture(t);
  assert.equal((await f.get('')).status, 401);
  const admin = f.db.createAdminUser({ username: 'owner', email: '', passwordHash: 'unused', isAdmin: true });
  assert.equal((await f.get(f.db.createSession(admin.id).token)).status, 403);
  const legacy = f.db.createOrUpdatePlexUser({ username: 'legacy', email: '', plexId: 'old-uuid', plexToken: 'personal-secret' });
  assert.equal((await f.get(f.db.createSession(legacy.id).token)).status, 403);
  assert.equal((await f.get(f.db.createSession(f.user.id, -1).token)).status, 401);
  f.db.deleteSession(f.session.token); assert.equal((await f.get()).status, 401);
  assert.equal(f.state.calls.length, 0);
});

test('integration fails closed on disabled policy, unavailable configuration, wrong server and revoked Plex access', async t => {
  const f = await fixture(t);
  f.db.setSetting(`download_policy:${f.user.id}`, JSON.stringify({ enabled: false, libraries: null, qualities: ['720p-2'], serverId: 'server-fixture' }));
  assert.equal((await f.get()).status, 403); assert.equal(f.state.calls.length, 0);
  f.db.setSetting(`download_policy:${f.user.id}`, '');
  f.state.machine = 'wrong'; assert.equal((await f.get()).status, 503); assert.equal(f.state.calls.length, 1);
  f.state.machine = 'server-fixture'; f.state.denied = true;
  const denied = await f.get(); assert.equal(denied.status, 403); assert.doesNotMatch(await denied.text(), /private|http|secret/);
  f.db.setSetting('plex_machine_id', ''); assert.equal((await f.get()).status, 503);
});

for (const mode of ['logout', 'policy', 'server', 'identity']) test(`integration revalidates ${mode} changes during source verification`, async t => {
  const f = await fixture(t);
  f.state.check = () => {
    if (mode === 'logout') f.db.deleteSession(f.session.token);
    if (mode === 'policy') f.db.setSetting(`download_policy:${f.user.id}`, JSON.stringify({ enabled: false, libraries: null, qualities: [], serverId: 'server-fixture' }));
    if (mode === 'server') f.db.setSetting('plex_machine_id', 'changed');
    if (mode === 'identity') f.db.createOrUpdatePlexUser({ username: 'same', email: '', plexId: 'plex:42', plexToken: 'changed-token' });
  };
  const response = await f.get(); assert.equal(response.status, mode === 'logout' ? 401 : 403);
  assert.doesNotMatch(await response.text(), /plexId|personal-secret|admin-secret/);
});

test('build revision only accepts an immutable full revision, never labels or arbitrary input', () => {
  assert.equal(integrationBuildRevision('a'.repeat(40)), 'a'.repeat(40));
  for (const invalid of ['', 'quality-preview', 'main', 'a'.repeat(39), 'secret\nvalue']) assert.equal(integrationBuildRevision(invalid), null);
});
