const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const SQLite = require('better-sqlite3');
const { DatabaseService } = require('../dist/models/database');
const { createMediaRouter } = require('../dist/routes/media');

test('history migration preserves old rows and persists new quality/status across restarts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lda-history-'));
  const file = path.join(dir, 'app.db');
  let db;
  try {
    const legacy = new SQLite(file);
    legacy.exec(`CREATE TABLE download_logs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
      media_title TEXT NOT NULL, media_key TEXT NOT NULL, file_size INTEGER, downloaded_at INTEGER NOT NULL);
      INSERT INTO download_logs VALUES ('old', 'alice', 'Previous download', '1', 100, 1)`);
    legacy.close();
    db = new DatabaseService(file);
    const old = db.getDownloadHistory('alice')[0];
    assert.equal(old.quality, null);
    assert.equal(old.transfer_status, 'recorded');
    db.logDownload('alice', 'New conversion', '2', 200, { quality: '720p-2', status: 'transferred', audio: 'French', subtitle: 'None' });
    db.logDownload('alice', 'Original request', '3', 300);
    db.close(); db = new DatabaseService(file);
    const rows = db.getDownloadHistory('alice');
    assert.equal(rows.length, 3);
    assert.equal(rows.find(row => row.media_key === '2').quality, '720p-2');
    assert.equal(rows.find(row => row.media_key === '2').transfer_status, 'transferred');
    assert.equal(rows.find(row => row.media_key === '2').audio_selection, 'French');
    assert.equal(rows.find(row => row.media_key === '2').subtitle_selection, 'None');
    assert.equal(rows.find(row => row.id === 'old').audio_selection, null);
    assert.equal(rows.find(row => row.media_key === '3').transfer_status, 'requested');
    assert.equal(rows.find(row => row.id === 'old').file_size, 100);
  } finally { db?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('history search treats wildcard characters literally and pagination stays within one account', t => {
  const db = new DatabaseService(':memory:'); t.after(() => db.close());
  for (const title of ['100% movie', 'under_score', 'back\\slash', 'Plain']) db.logDownload('alice', title, '1', 100);
  db.logDownload('bob', '100% private', '2', 100);
  for (const [search, expected] of [['%', '100% movie'], ['_', 'under_score'], ['\\', 'back\\slash']]) {
    assert.deepEqual(db.getDownloadHistory('alice', 20, 0, search).map(row => row.media_title), [expected]);
  }
  const all = db.getDownloadHistory('alice');
  assert.deepEqual([...db.getDownloadHistory('alice', 2, 0), ...db.getDownloadHistory('alice', 2, 2)], all);
  assert.equal(all.length, 4);
});

test('ordinary users can page/search only their own history even when Plex is offline', async t => {
  const db = new DatabaseService(':memory:'); t.after(() => db.close());
  const user = db.createOrUpdatePlexUser({ username: 'alice', email: '', plexId: 'plex:42', plexToken: 'private-token' });
  const session = db.createSession(user.id);
  db.logDownload(user.id, 'Movie one', '1', 123, { quality: '720p-2', status: 'transferred' });
  db.logDownload(user.id, 'Movie two', '2', 456);
  db.logDownload('bob', 'Private movie', '3', 789);
  const app = express(); app.use('/media', createMediaRouter(db));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const call = (query = '', authenticated = true) => fetch(`http://127.0.0.1:${server.address().port}/media/download-history${query}`, {
    headers: authenticated ? { Authorization: `Bearer ${session.token}` } : {},
  });
  const response = await call('?limit=1&userId=bob');
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const first = await response.json();
  assert.equal(first.history.length, 1); assert.equal(first.hasMore, true);
  const second = await (await call('?limit=1&offset=1')).json();
  assert.equal(second.hasMore, false); assert.notEqual(first.history[0].id, second.history[0].id);
  const search = await (await call('?search=one')).json();
  assert.equal(search.history[0].media_title, 'Movie one');
  assert.doesNotMatch(JSON.stringify([first, second, search]), /Private movie|private-token|plexToken/);
  assert.equal((await call('/all')).status, 403);
  assert.equal((await call('', false)).status, 401);
  for (const query of ['?limit=0', '?limit=101', '?offset=-1', '?offset=1.5', '?search[x]=bad']) {
    assert.equal((await call(query)).status, 400, query);
  }
});
