const { assertDownloadPolicy } = require('../dist/services/downloadPolicy');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { DownloadService, downloadCredentials, verifyDecision } = require('../dist/services/downloadService');
const { createDownloadsRouter } = require('../dist/routes/downloads');

const mp4 = Buffer.from('\x00\x00\x00\x18ftypmp42MOCK-CONVERTED-MEDIA');
const decision = (quality = '720p-2') => ({ MediaContainer: {
  allowSync: true,
  Metadata: [{ Media: [{ selected: true, Part: [{ selected: true, decision: 'transcode',
    container: 'mp4', protocol: 'http', Stream: [{ streamType: 1, codec: 'h264',
      decision: 'transcode', width: quality === '1080p-8' ? 1920 : 1280,
      height: quality === '1080p-8' ? 1080 : 720,
      bitrate: quality === '720p-2' ? 2000 : quality === '720p-4' ? 4000 : 8000 }] }] }] }],
} });
function media(id) {
  return { ratingKey: String(id), type: id === '100' ? 'season' : id === '1' ? 'movie' : 'episode',
    title: `Title ${id}`, grandparentTitle: 'Show', parentTitle: 'Show', parentIndex: 1,
    index: Number(id), librarySectionID: '1', duration: 60000, allowSync: true,
    Media: [{ Part: [{ key: `/library/parts/${id}/file.mkv`, duration: 60000 }] }] };
}
async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function fixture(t, options = {}) {
  const requests = [];
  const queues = new Map();
  let nextQueue = 1;
  let nextItem = 1;
  const state = { status: 'processing', denied: false, wrongDecision: false, huge: false, ...options };
  const plex = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://mock');
    const token = req.headers['x-plex-token'];
    requests.push({ path: url.pathname, method: req.method, token, params: url.searchParams,
      client: req.headers['x-plex-client-identifier'] });
    const send = (body, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (!['shared-token', 'other-token', 'admin-token'].includes(token)) return send({}, 401);
    if (state.denied) return send({}, 403);
    if (url.pathname === '/identity') return send({ MediaContainer: { version: '1.43.0-test' } });
    if (url.pathname.startsWith('/library/metadata/')) {
      const id = url.pathname.split('/')[3];
      if (id === '999') return send({}, 403);
      const items = url.pathname.endsWith('/children') ? [media('2'), media('3')] : [media(id)];
      items.forEach(item => { if (state.durations?.[item.ratingKey] !== undefined) item.duration = state.durations[item.ratingKey]; });
      if (state.allowSyncFalse) items.forEach(item => { item.allowSync = false; });
      return send({ MediaContainer: { Metadata: items, totalSize: items.length } });
    }
    if (url.pathname === '/downloadQueue' && req.method === 'POST') {
      if (state.unsupported) return send({}, 404);
      const id = nextQueue++;
      queues.set(id, { owner: token, client: req.headers['x-plex-client-identifier'], items: [] });
      return send({ MediaContainer: { DownloadQueue: [{ id }] } });
    }
    const [, , queueId, operation, itemId, action] = url.pathname.split('/');
    const queue = queues.get(Number(queueId));
    if (!queue) return send({}, 404);
    if (queue.owner !== token || queue.client !== req.headers['x-plex-client-identifier']) return send({}, 403);
    if (operation === 'add') {
      // Linux PMS resolves the supplied name to a case-sensitive profile file.
      // Unknown names with no platform/device fallback fail before transcoding.
      queue.invalidProfile = req.headers['x-plex-client-profile-name'] !== 'Generic';
      queue.quality = url.searchParams.get('videoBitrate') === '2000' ? '720p-2' : url.searchParams.get('videoBitrate') === '4000' ? '720p-4' : '1080p-8';
      queue.items = url.searchParams.get('keys').split(',').map(key => ({ key, id: nextItem++, queueId: Number(queueId) }));
      return send({ MediaContainer: { AddedQueueItems: queue.items } });
    }
    if (operation === 'items' && req.method === 'DELETE') {
      const ids = itemId.split(',').map(Number);
      queue.items = queue.items.filter(item => !ids.includes(item.id));
      return send({});
    }
    if (operation === 'items') return send({ MediaContainer: { DownloadQueueItem: (state.missing ? [] : queue.items).map(item => ({ ...item,
      status: queue.invalidProfile ? 'error' : state.status,
      TranscodeSession: state.session,
      DecisionResult: queue.invalidProfile
        ? { generalDecisionCode: 2004, generalDecisionText: 'Could not construct decision request' }
        : state.decisionError,
      ...state.itemUpdates?.[item.id],
    })) } });
    if (action === 'decision') {
      const result = decision(queue.quality);
      if (state.wrongDecision) result.MediaContainer.Metadata[0].Media[0].Part[0].Stream[0].height = 2160;
      return send(result);
    }
    if (action === 'media') {
      res.writeHead(200, { 'Content-Type': state.playlist ? 'application/vnd.apple.mpegurl' : 'video/mp4',
        'Content-Length': state.huge ? '50000000000' : String(mp4.length) });
      return res.end(mp4);
    }
    send({}, 404);
  });
  const serverUrl = await listen(plex);
  const service = new DownloadService(options.ttlMs || 100000);
  const credentials = { serverUrl, token: 'shared-token' };
  t.after(async () => { await service.close(); await new Promise(resolve => plex.close(resolve)); });
  return { requests, queues, state, service, credentials };
}
const request = { ratingKey: '1', partKey: '/library/parts/1/file.mkv', quality: '720p-2' };

test('shared users receive real queue conversion progress through waiting, finalizing and verified readiness', async t => {
  const f = await fixture(t, { status: 'waiting' });
  const job = await f.service.create('alice', f.credentials, request);
  assert.equal(job.stage, 'deciding');
  assert.equal(job.progress, 0);
  let status = await f.service.status(job.id, 'alice', f.credentials);
  assert.equal(status.stage, 'waiting');
  assert.equal(status.progress, 0);
  f.state.status = 'processing';
  f.state.session = { progress: '42.7', key: '/transcode/sessions/private', token: 'secret' };
  status = await f.service.status(job.id, 'alice', f.credentials);
  assert.equal(status.stage, 'processing');
  assert.equal(status.progress, 42);
  assert.doesNotMatch(JSON.stringify(status), /private|secret|TranscodeSession/);
  f.state.session.progress = 0.5;
  assert.equal((await f.service.status(job.id, 'alice', f.credentials)).progress, 0);
  f.state.session.progress = 100;
  status = await f.service.status(job.id, 'alice', f.credentials);
  assert.equal(status.progress, 99);
  assert.equal(status.stage, 'finalizing');
  assert.equal(status.state, 'preparing');
  await assert.rejects(f.service.beginTransfer(job.id, 'alice', f.credentials), { status: 409 });
  f.state.status = 'available';
  status = await f.service.status(job.id, 'alice', f.credentials);
  assert.equal(status.progress, 100);
  assert.equal(status.stage, 'ready');
  assert.equal(status.state, 'ready');
  assert.ok(f.requests.every(r => r.token === 'shared-token'));
  assert.ok(!f.requests.some(r => /transcode\/sessions|status\/sessions|activities/.test(r.path)));
});

test('missing and malformed progress stay indeterminate; legacy and array sessions are supported', async t => {
  const f = await fixture(t);
  const job = await f.service.create('alice', f.credentials, request);
  for (const value of [undefined, null, '', ' ', false, -1, 101, 'invalid', Infinity]) {
    f.state.session = { progress: value };
    const status = await f.service.status(job.id, 'alice', f.credentials);
    assert.equal(status.progress, null);
    assert.equal(status.state, 'preparing');
  }
  f.state.session = [{ progress: 23 }];
  assert.equal((await f.service.status(job.id, 'alice', f.credentials)).progress, 23);
  f.state.session = undefined;
  f.state.itemUpdates = { 1: { transcode: { progress: 35 } } };
  assert.equal((await f.service.status(job.id, 'alice', f.credentials)).progress, 35);
  f.state.missing = true;
  const status = await f.service.status(job.id, 'alice', f.credentials);
  assert.equal(status.progress, null);
  assert.equal(status.stage, 'deciding');
});

test('season progress includes completed episodes and weights the remaining work by duration', async t => {
  const f = await fixture(t, { durations: { 2: 60000, 3: 180000 }, itemUpdates: {
    1: { status: 'available' }, 2: { status: 'processing', TranscodeSession: { progress: 50 } },
  } });
  const job = await f.service.create('alice', f.credentials, { ratingKey: '100', season: true, quality: '720p-2' });
  const status = await f.service.status(job.id, 'alice', f.credentials);
  assert.equal(status.readyCount, 1);
  assert.equal(status.fileCount, 2);
  assert.equal(status.progress, 62); // (60 * 100 + 180 * 50) / 240
  f.state.itemUpdates[2].TranscodeSession = undefined;
  assert.equal((await f.service.status(job.id, 'alice', f.credentials)).progress, null);
});

test('season progress falls back to equal weights when durations are missing and errors never become ready', async t => {
  const f = await fixture(t, { durations: { 2: 0 }, itemUpdates: {
    1: { status: 'available' }, 2: { status: 'processing', TranscodeSession: { progress: 50 } },
  } });
  const job = await f.service.create('alice', f.credentials, { ratingKey: '100', season: true, quality: '720p-2' });
  assert.equal((await f.service.status(job.id, 'alice', f.credentials)).progress, 75);
  f.state.itemUpdates[2] = { status: 'error', TranscodeSession: { progress: 100 } };
  const status = await f.service.status(job.id, 'alice', f.credentials);
  assert.equal(status.state, 'error');
  assert.notEqual(status.stage, 'ready');
  assert.notEqual(status.progress, 100);
});

test('shared users never inherit the administrator token', () => {
  const setting = key => ({ plex_url: 'http://plex:32400', plex_token: 'admin-token' })[key];
  assert.throws(() => downloadCredentials(setting, { isAdmin: false }), { status: 403 });
  assert.equal(downloadCredentials(setting, { isAdmin: false, plexToken: 'shared-token' }).token, 'shared-token');
  assert.equal(downloadCredentials(setting, { isAdmin: true }).token, 'admin-token');
});

test('720p request queues a forced conversion, waits, then streams the converted file', async t => {
  const f = await fixture(t);
  const created = await f.service.create('alice', f.credentials, request);
  assert.equal(created.state, 'preparing');
  const add = f.requests.find(r => r.path.endsWith('/add'));
  assert.equal(add.params.get('videoResolution'), '1280x720');
  assert.equal(add.params.get('videoBitrate'), '2000');
  assert.equal(add.params.get('directPlay'), '0');
  assert.equal(add.params.get('directStream'), '0');
  assert.equal(add.params.get('protocol'), 'http');
  assert.match(add.params.get('X-Plex-Client-Profile-Extra'), /context=static&protocol=http&container=mp4/);
  assert.equal(add.params.get('partIndex'), '0');
  assert.ok(f.requests.every(r => r.token === 'shared-token'));
  assert.equal(JSON.stringify(created).includes('shared-token'), false);
  assert.equal((await f.service.status(created.id, 'alice', f.credentials)).state, 'preparing');
  await assert.rejects(f.service.beginTransfer(created.id, 'alice', f.credentials), { status: 409 });
  f.state.status = 'available';
  assert.equal((await f.service.status(created.id, 'alice', f.credentials)).state, 'ready');
  const transfer = await f.service.beginTransfer(created.id, 'alice', f.credentials);
  const output = await transfer.open(transfer.files[0]);
  const chunks = [];
  for await (const chunk of output.stream) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), mp4);
  assert.ok(f.requests.some(r => /\/downloadQueue\/\d+\/item\/\d+\/media/.test(r.path)));
  assert.ok(!f.requests.some(r => r.path.startsWith('/library/parts')));
  await f.service.cancel(created.id, 'alice');
  assert.ok([...f.queues.values()].every(queue => !queue.items.length));
});

test('ownership, invalid quality and unrelated part paths are rejected', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.create('alice', f.credentials, { ...request, quality: '4k' }), { status: 400 });
  assert.equal(f.requests.length, 0);
  await assert.rejects(f.service.create('alice', f.credentials, { ...request, partKey: 'http://evil/file' }), { status: 400 });
  const job = await f.service.create('alice', f.credentials, request);
  await assert.rejects(f.service.status(job.id, 'bob', { ...f.credentials, token: 'other-token' }), { status: 404 });
  await assert.rejects(f.service.cancel(job.id, 'bob'), { status: 404 });
  await assert.rejects(f.service.create('alice', f.credentials, { ...request, ratingKey: '999' }), { status: 403 });
});

test('denied downloads and old PMS fail without trying an original file', async t => {
  const f = await fixture(t, { allowSyncFalse: true });
  await assert.rejects(f.service.create('alice', f.credentials, request), { status: 403 });
  assert.ok(!f.requests.some(r => r.path === '/downloadQueue'));
  f.state.allowSyncFalse = false; f.state.unsupported = true;
  await assert.rejects(f.service.create('alice', f.credentials, request), /1.41.9/);
  assert.ok(!f.requests.some(r => r.path.startsWith('/library/parts')));
});

test('4K fallback and missing output evidence are refused and cleaned up', async t => {
  const f = await fixture(t, { status: 'available', wrongDecision: true });
  const job = await f.service.create('alice', f.credentials, request);
  const result = await f.service.status(job.id, 'alice', f.credentials);
  assert.equal(result.state, 'error');
  assert.match(result.error, /requested MP4 quality/);
  assert.ok([...f.queues.values()].every(queue => !queue.items.length));
  assert.throws(() => verifyDecision({}, '720p-2'), /requested MP4 quality/);
  const original = decision();
  original.MediaContainer.Metadata[0].Media[0].Part[0].decision = 'directplay';
  assert.throws(() => verifyDecision(original.MediaContainer, '720p-2'), /requested MP4 quality/);
});

test('real PMS static MP4 decision omits protocol; explicit playlists and originals still fail', () => {
  // Captured from official Linux PMS 1.43.4.10903-e5521bd8c, generated UHD clip.
  // Probe: https://github.com/hloiseau/LibraryDownloadarr/actions/runs/36254437804
  // Keep the actual Media/Part/Stream shape rather than inventing Plex fields.
  const captured = require('./fixtures/pms-1.43-static-decision.json');
  assert.doesNotThrow(() => verifyDecision(captured.MediaContainer, '720p-2'));
  for (const change of [
    part => { part.protocol = 'hls'; },
    part => { part.container = 'mkv'; },
    part => { part.decision = 'directplay'; },
    part => { part.Stream[0].height = 2160; },
    part => { part.Stream[0].bitrate = 50000; },
  ]) {
    const invalid = structuredClone(captured);
    change(invalid.MediaContainer.Metadata[0].Media[0].Part[0]);
    assert.throws(() => verifyDecision(invalid.MediaContainer, '720p-2'), /requested MP4 quality/);
  }
});

test('permission revocation during conversion is enforced before transfer', async t => {
  const f = await fixture(t, { status: 'available' });
  const job = await f.service.create('alice', f.credentials, request);
  await f.service.status(job.id, 'alice', f.credentials);
  f.state.allowSyncFalse = true;
  await assert.rejects(f.service.beginTransfer(job.id, 'alice', f.credentials), { status: 403 });
  assert.ok(!f.requests.some(r => r.path.endsWith('/media')));
});

test('queue failures, cancellation, and per-user limits are handled', async t => {
  const f = await fixture(t);
  const jobs = await Promise.all([f.service.create('alice', f.credentials, request), f.service.create('alice', f.credentials, request)]);
  await assert.rejects(f.service.create('alice', f.credentials, request), { status: 429 });
  assert.notEqual(f.requests.filter(r => r.path === '/downloadQueue')[0].client, f.requests.filter(r => r.path === '/downloadQueue')[1].client);
  await f.service.cancel(jobs[0].id, 'alice');
  assert.ok([...f.queues.values()].some(queue => queue.items.length === 1));
  f.state.status = 'error';
  assert.equal((await f.service.status(jobs[1].id, 'alice', f.credentials)).state, 'error');
});

test('MP4-only and maximum output size checks prevent wrong downloads', async t => {
  const f = await fixture(t, { status: 'available', huge: true });
  const job = await f.service.create('alice', f.credentials, request);
  await f.service.status(job.id, 'alice', f.credentials);
  const transfer = await f.service.beginTransfer(job.id, 'alice', f.credentials);
  await assert.rejects(transfer.open(transfer.files[0]), /larger/);
  f.state.huge = false; f.state.playlist = true;
  await assert.rejects(transfer.open(transfer.files[0]), /file type/);
});

async function application(t, f) {
  const sessions = new Map(['alice', 'bob'].map(name => [`session-${name}`, { id: name, userId: name, token: `session-${name}` }]));
  const logs = [];
  const settings = { plex_url: f.credentials.serverUrl, plex_token: 'admin-token', plex_machine_id: 'server-1' };
  const db = {
    getSetting: key => settings[key],
    getSessionByToken: token => sessions.get(token), getAdminUserById: () => undefined,
    getPlexUserById: id => ({ id, username: id, isAdmin: false, plexToken: id === 'alice' ? 'shared-token' : 'other-token' }),
    logDownload: (...args) => logs.push(args),
  };
  const app = express(); app.use(express.json()); app.use(express.urlencoded({ extended: false }));
  const downloads = createDownloadsRouter(db, f.service); app.use('/api/downloads', downloads.router);
  const server = http.createServer(app); const url = await listen(server);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const call = (path, options = {}, user = 'alice') => fetch(`${url}/api/downloads${path}`, { ...options,
    headers: { Authorization: `Bearer session-${user}`, 'Content-Type': 'application/json', ...options.headers } });
  return { call, sessions, logs, settings };
}

test('native ticket streams a file, is single-use and respects session revocation', async t => {
  const f = await fixture(t, { status: 'available' });
  const app = await application(t, f);
  const created = await app.call('', { method: 'POST', body: JSON.stringify(request) });
  assert.equal(created.status, 202); const job = await created.json();
  assert.equal((await app.call(`/${job.id}`, {}, 'bob')).status, 404);
  assert.equal((await app.call(`/${job.id}/ticket`, { method: 'POST' }, 'bob')).status, 404);
  assert.equal((await app.call(`/${job.id}/file`, { method: 'POST', body: '{}' })).status, 403);
  let ticket = (await (await app.call(`/${job.id}/ticket`, { method: 'POST' })).json()).ticket;
  app.sessions.delete('session-alice');
  assert.equal((await app.call(`/${job.id}/file`, { method: 'POST', body: JSON.stringify({ ticket }) })).status, 401);
  app.sessions.set('session-alice', { id: 'alice', userId: 'alice', token: 'session-alice' });
  ticket = (await (await app.call(`/${job.id}/ticket`, { method: 'POST' })).json()).ticket;
  const file = await app.call(`/${job.id}/file`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ticket }) });
  assert.equal(file.status, 200);
  assert.match(file.headers.get('content-disposition'), /720p-2\.mp4/);
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), mp4);
  assert.equal((await app.call(`/${job.id}/file`, { method: 'POST', body: JSON.stringify({ ticket }) })).status, 403);
  assert.equal(app.logs.length, 1);
});

test('a season ZIP contains converted episode files at the selected quality', async t => {
  const f = await fixture(t, { status: 'available' });
  const app = await application(t, f);
  const job = await (await app.call('', { method: 'POST', body: JSON.stringify({ ratingKey: '100', quality: '1080p-8', season: true }) })).json();
  assert.equal(job.fileCount, 2);
  const ticket = (await (await app.call(`/${job.id}/ticket`, { method: 'POST' })).json()).ticket;
  const response = await app.call(`/${job.id}/file`, { method: 'POST', body: JSON.stringify({ ticket }) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/zip');
  const zip = Buffer.from(await response.arrayBuffer());
  assert.equal(zip.subarray(0, 4).toString('hex'), '504b0304');
  assert.ok(zip.includes(Buffer.from('S01E02 - Title 2 - 1080p-8.mp4')));
  assert.ok(zip.includes(Buffer.from('S01E03 - Title 3 - 1080p-8.mp4')));
  assert.equal(zip.toString().split('MOCK-CONVERTED-MEDIA').length - 1, 2);
  assert.equal(f.requests.filter(r => r.path.endsWith('/media')).length, 2);
  assert.equal(app.logs.length, 1);
});


test('refreshed credentials replace the original token on every request', async t => {
  const f = await fixture(t);
  const job = await f.service.create('alice', f.credentials, request);
  await f.service.status(job.id, 'alice', { ...f.credentials, token: 'other-token' });
  const queueReads = f.requests.filter(r => r.method === 'GET' && r.path.includes('/downloadQueue/'));
  assert.ok(queueReads.length > 0);
  assert.ok(queueReads.every(r => r.token === 'other-token'));
});


test('Plex queue error exposes decision and PMS version without tokens', async t => {
  const f = await fixture(t, { status: 'error', decisionError: {
    generalDecisionCode: 4005, generalDecisionText: 'Conversion failed: encoder unavailable; X-Plex-Token=shared-token at http://plex:32400/file?token=other-secret',
  } });
  const job = await f.service.create('alice', f.credentials, request);
  const result = await f.service.status(job.id, 'alice', f.credentials);
  assert.equal(result.state, 'error');
  assert.match(result.error, /general 4005: Conversion failed: encoder unavailable/);
  assert.match(result.error, /PMS 1.43.0-test/);
  assert.doesNotMatch(result.error, /shared-token|other-secret|http:\/\/plex/);
});

test('Conversion OK followed by queue error reports file creation failure, not direct-play refusal', async t => {
  const f = await fixture(t, { status: 'error', decisionError: {
    generalDecisionCode: 1001, generalDecisionText: 'Direct play not available; Conversion OK.',
    transcodeDecisionCode: 1001, transcodeDecisionText: 'Direct play not available; Conversion OK.',
    directPlayDecisionCode: 3000, directPlayDecisionText: 'App cannot direct play this item. Direct play is disabled.',
  } });
  const job = await f.service.create('alice', f.credentials, request);
  const result = await f.service.status(job.id, 'alice', f.credentials);
  assert.equal(result.state, 'error');
  assert.match(result.error, /approved conversion but failed to create the file/);
  assert.match(result.error, /PMS 1.43.0-test/);
  assert.match(result.error, /queue 1, item 1/);
  assert.doesNotMatch(result.error, /Direct play is disabled|shared-token|Conversion OK/);
  await assert.rejects(f.service.beginTransfer(job.id, 'alice', f.credentials), { status: 409 });
  assert.ok(!f.requests.some(r => r.path.endsWith('/media')));
  assert.ok([...f.queues.values()].every(queue => !queue.items.length));
});

test('a transcode refusal is retained even if the general decision says conversion is possible', async t => {
  const f = await fixture(t, { status: 'error', decisionError: {
    generalDecisionCode: 1001, transcodeDecisionCode: 4005, transcodeDecisionText: 'Encoder unavailable',
  } });
  const job = await f.service.create('alice', f.credentials, request);
  const result = await f.service.status(job.id, 'alice', f.credentials);
  assert.match(result.error, /transcode 4005: Encoder unavailable/);
  assert.doesNotMatch(result.error, /decision response does not explain/);
});

test('temporarily missing queue item is retried, while expiry is reported distinctly', async t => {
  const f = await fixture(t, { missing: true });
  const job = await f.service.create('alice', f.credentials, request);
  assert.equal((await f.service.status(job.id, 'alice', f.credentials)).state, 'preparing');
  f.state.missing = false; f.state.status = 'available';
  assert.equal((await f.service.status(job.id, 'alice', f.credentials)).state, 'ready');
  await f.service.cancel(job.id, 'alice');
  f.state.status = 'expired';
  const next = await f.service.create('alice', f.credentials, request);
  assert.match((await f.service.status(next.id, 'alice', f.credentials)).error, /expired/);
});

test('app policy blocks quality and library, and revocation prevents ticket delivery', async t => {
  const f = await fixture(t, { status: 'available' });
  const app = await application(t, f);
  const policy = { enabled: true, libraries: ['1'], qualities: ['720p-2'], serverId: 'server-1' };
  const save = value => { app.settings['download_policy:alice'] = JSON.stringify(value); };
  save(policy);
  assert.equal((await app.call('', { method: 'POST', body: JSON.stringify({ ...request, quality: '1080p-8' }) })).status, 403);
  save({ ...policy, libraries: ['2'] });
  assert.equal((await app.call('', { method: 'POST', body: JSON.stringify(request) })).status, 403);
  save(policy);
  const created = await app.call('', { method: 'POST', body: JSON.stringify(request) });
  assert.equal(created.status, 202); const job = await created.json();
  const ticket = (await (await app.call(`/${job.id}/ticket`, { method: 'POST' })).json()).ticket;
  save({ ...policy, enabled: false });
  const response = await app.call(`/${job.id}/file`, { method: 'POST', body: JSON.stringify({ ticket }) });
  assert.equal(response.status, 403);
  assert.ok(!f.requests.some(r => r.path.endsWith('/media')));
});

test('restricted season checks every episode library before queue creation', async t => {
  const f = await fixture(t);
  const db = { getSetting: key => key === 'download_policy:alice' ? JSON.stringify({ enabled: true, qualities: ['720p-2'], libraries: ['2'], serverId: '' }) : '' };
  const credentials = { ...f.credentials, authorize: (quality, item, container) => assertDownloadPolicy(db, { id: 'alice', isAdmin: false }, quality, item, container) };
  await assert.rejects(f.service.create('alice', credentials, { ratingKey: '100', quality: '720p-2', season: true }), { status: 403 });
  assert.ok(!f.requests.some(r => r.path === '/downloadQueue'));
});
