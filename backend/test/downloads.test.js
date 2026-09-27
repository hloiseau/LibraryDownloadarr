const { assertDownloadPolicy } = require('../dist/services/downloadPolicy');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { DownloadService, downloadCredentials, verifyDecision } = require('../dist/services/downloadService');
const { createDownloadsRouter } = require('../dist/routes/downloads');
const { logger } = require('../dist/utils/logger');

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
  const selections = new Map();
  const addStreams = (item, token) => {
    const base = Number(item.ratingKey) * 100;
    const part = item.Media[0].Part[0]; part.id = Number(item.ratingKey) * 10;
    const current = selections.get(`${token}:${part.id}`) || { audio: base + 1, subtitle: 0 };
    part.Stream = [
      { id: base + 1, streamType: 2, language: 'English', languageCode: 'eng', codec: 'aac', channels: 2 },
      { id: base + 2, streamType: 2, language: 'French', languageCode: 'fra', codec: 'aac', channels: 2 },
      { id: base + 3, streamType: 3, language: 'French', languageCode: 'fra', codec: 'srt' },
      { id: base + 4, streamType: 3, language: 'French', languageCode: 'fra', codec: 'srt', forced: true },
    ].filter(stream => !(state.missingFrench && item.ratingKey === '3' && stream.id === base + 2))
      .map(stream => ({ ...stream, selected: stream.id === (stream.streamType === 2 ? current.audio : current.subtitle) }));
    return item;
  };
  const plex = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://mock');
    const token = req.headers['x-plex-token'];
    requests.push({ path: url.pathname, method: req.method, token, params: url.searchParams,
      client: req.headers['x-plex-client-identifier'] });
    const send = (body, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (!['shared-token', 'other-token', 'admin-token'].includes(token)) return send({}, 401);
    if (state.denied) return send({}, 403);
    if (url.pathname === '/identity') return send({ MediaContainer: { version: '1.43.0-test' } });
    if (url.pathname.startsWith('/library/parts/') && req.method === 'PUT') {
      const partId = Number(url.pathname.split('/')[3]);
      const base = partId * 10;
      const current = selections.get(`${token}:${partId}`) || { audio: base + 1, subtitle: 0 };
      if (!state.ignoreStreamSelection) selections.set(`${token}:${partId}`, {
        audio: url.searchParams.has('audioStreamID') ? Number(url.searchParams.get('audioStreamID')) : current.audio,
        subtitle: url.searchParams.has('subtitleStreamID') ? Number(url.searchParams.get('subtitleStreamID')) : current.subtitle,
      });
      return send({});
    }
    if (url.pathname.startsWith('/library/metadata/')) {
      const id = url.pathname.split('/')[3];
      if (id === '999') return send({}, 403);
      const items = url.pathname.endsWith('/children') ? [media('2'), media('3')] : [media(id)];
      items.forEach(item => { if (state.durations?.[item.ratingKey] !== undefined) item.duration = state.durations[item.ratingKey]; });
      if (state.sourceSize) items.forEach(item => { item.Media[0].Part[0].size = state.sourceSize; });
      if (state.streams) items.forEach(item => addStreams(item, token));
      if (state.audioSelection) items.forEach(item => { item.Media[0].Part[0].Stream = [
        { id: 'audio-en', streamType: 2, selected: state.audioSelection === 'en' },
        { id: 'audio-fr', streamType: 2, selected: state.audioSelection === 'fr' },
      ]; });
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
      queue.items = url.searchParams.get('keys').split(',').map(key => ({ key, id: nextItem++, queueId: Number(queueId),
        streams: state.streams ? addStreams(media(key.split('/').pop()), token).Media[0].Part[0].Stream.filter(stream => stream.selected)
          .filter(stream => stream.streamType !== 3 || url.searchParams.get('subtitles') !== 'none') : undefined }));
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
      const entry = queue.items.find(item => item.id === Number(itemId));
      if (entry?.streams) result.MediaContainer.Metadata[0].Media[0].Part[0].Stream.push(...entry.streams.map(stream => ({
        ...stream, id: state.wrongTrack && stream.streamType === 2 ? 9999 : stream.id,
        decision: stream.streamType === 2 ? 'transcode' : state.wrongSubtitle ? 'copy' : 'burn',
      })));
      if (state.wrongDecision) result.MediaContainer.Metadata[0].Media[0].Part[0].Stream[0].height = 2160;
      return send(result);
    }
    if (action === 'media') {
      if (state.mediaStatus) return send({ token: 'upstream-secret' }, state.mediaStatus);
      if (state.streamMedia) return state.streamMedia(req, res);
      res.writeHead(200, { 'Content-Type': state.playlist ? 'application/vnd.apple.mpegurl' : 'video/mp4',
        'Content-Length': state.huge ? '50000000000' : String(mp4.length) });
      return res.end(mp4);
    }
    send({}, 404);
  });
  const serverUrl = await listen(plex);
  const service = new DownloadService(options.ttlMs || 100000, options.cacheTtlMs || 100000);
  const credentials = { serverUrl, token: 'shared-token' };
  t.after(async () => { await service.close(); await new Promise(resolve => plex.close(resolve)); });
  return { requests, queues, state, service, credentials };
}
const request = { ratingKey: '1', partKey: '/library/parts/1/file.mkv', quality: '720p-2' };

test('track options are authenticated, read-only, part-scoped and distinguish forced subtitles', async t => {
  const f = await fixture(t, { streams: true });
  const app = await application(t, f);
  const response = await app.call('/options?' + new URLSearchParams(request));
  assert.equal(response.status, 200);
  const options = await response.json();
  assert.deepEqual(options.audio.map(option => option.id), ['plex', 'stream:101', 'stream:102']);
  assert.deepEqual(options.subtitle.map(option => option.id), ['plex', 'none', 'stream:103', 'stream:104']);
  assert.match(options.subtitle[3].label, /Forced/);
  assert.ok(f.requests.every(req => req.method === 'GET' && req.token === 'shared-token'));
  assert.doesNotMatch(JSON.stringify(options), /token|library\/parts/);
  assert.equal((await app.call('/options?' + new URLSearchParams(request), {}, 'missing')).status, 401);
  assert.equal((await app.call('/options?' + new URLSearchParams({ ...request, partKey: '/library/parts/999/file.mkv' }))).status, 400);
  app.settings['download_policy:alice'] = JSON.stringify({ enabled: false, qualities: ['720p-2'], libraries: null, serverId: 'server-1' });
  assert.equal((await app.call('/options?' + new URLSearchParams(request))).status, 403);
});

test('explicit tracks are applied to the caller before queuing and rechecked before transfer', async t => {
  const f = await fixture(t, { streams: true, status: 'available' });
  const app = await application(t, f);
  const chosen = { ...request, audio: 'stream:102', subtitle: 'stream:104' };
  const job = await (await app.call('', { method: 'POST', body: JSON.stringify(chosen) })).json();
  assert.match(job.audioLabel, /French/); assert.match(job.subtitleLabel, /Forced/);
  assert.match(job.filename, /Audio French.*Subs French/);
  const selection = f.requests.find(req => req.method === 'PUT');
  assert.equal(selection.path, '/library/parts/10');
  assert.equal(selection.params.get('audioStreamID'), '102');
  assert.equal(selection.params.get('subtitleStreamID'), '104');
  assert.equal(selection.params.get('allParts'), '0');
  assert.ok(f.requests.indexOf(selection) < f.requests.findIndex(req => req.path.endsWith('/add')));
  assert.equal((await f.service.status(job.id, 'alice', f.credentials)).state, 'ready');
  const ticket = await (await app.call(`/${job.id}/ticket`, { method: 'POST' })).json();
  const response = await app.call(`/${job.id}/file`, { method: 'POST', body: JSON.stringify(ticket) });
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), mp4);
  assert.match(app.logs[0][4].audio, /French/); assert.match(app.logs[0][4].subtitle, /Forced/);
  assert.ok(f.requests.every(req => req.token === 'shared-token'));
  f.state.wrongTrack = true;
  await assert.rejects(f.service.beginTransfer(job.id, 'alice', f.credentials), /selected audio or subtitles/);
});

test('None disables subtitles, and differently selected cached conversions remain distinct and reusable', async t => {
  const f = await fixture(t, { streams: true, status: 'available' });
  const french = { ...request, audio: 'stream:102', subtitle: 'none' };
  const english = { ...request, audio: 'stream:101', subtitle: 'stream:103' };
  const first = await f.service.create('alice', f.credentials, french);
  await f.service.status(first.id, 'alice', f.credentials);
  assert.equal(f.requests.find(req => req.path.endsWith('/add')).params.get('subtitles'), 'none');
  const second = await f.service.create('alice', f.credentials, english);
  await f.service.status(second.id, 'alice', f.credentials);
  assert.notEqual(first.id, second.id);
  const reused = await f.service.create('alice', f.credentials, french);
  assert.equal(reused.id, first.id); assert.equal(reused.reused, true);
  assert.equal(f.requests.filter(req => req.path.endsWith('/add')).length, 2);
  assert.equal(f.requests.filter(req => req.method === 'PUT').length, 2, 'a cache hit must not change Plex preferences again');
  const transfer = await f.service.beginTransfer(first.id, 'alice', f.credentials);
  await transfer.finish();
});

test('forged tracks, ignored selections and incorrect decisions never silently download another language', async t => {
  const f = await fixture(t, { streams: true, status: 'available' });
  for (const input of [{ audio: 'none' }, { audio: 102 }, { audio: 'stream:999' }, { subtitle: 'stream:102' }]) {
    await assert.rejects(f.service.create('alice', f.credentials, { ...request, ...input }), { status: 400 });
  }
  assert.equal(f.requests.filter(req => req.method === 'PUT' || req.path === '/downloadQueue').length, 0);
  f.state.ignoreStreamSelection = true;
  await assert.rejects(f.service.create('alice', f.credentials, { ...request, audio: 'stream:102' }), /did not apply/);
  assert.equal(f.requests.filter(req => req.path === '/downloadQueue').length, 0);
  f.state.ignoreStreamSelection = false; f.state.wrongSubtitle = true;
  const job = await f.service.create('alice', f.credentials, { ...request, subtitle: 'stream:103' });
  const failed = await f.service.status(job.id, 'alice', f.credentials);
  assert.equal(failed.state, 'error'); assert.match(failed.error, /did not confirm/);
  assert.ok([...f.queues.values()].every(queue => queue.items.length === 0));
});

test('a season resolves matching tracks to each episode id and rejects a disappeared track before any mutation', async t => {
  const f = await fixture(t, { streams: true, status: 'available' });
  const season = { ratingKey: '100', quality: '720p-2', season: true };
  const options = await f.service.options(f.credentials, season);
  const audio = options.audio.find(option => option.label.includes('French')).id;
  const subtitle = options.subtitle.find(option => option.label.includes('Forced')).id;
  f.state.missingFrench = true;
  assert.ok(!(await f.service.options(f.credentials, season)).audio.some(option => option.id === audio));
  await assert.rejects(f.service.create('alice', f.credentials, { ...season, audio, subtitle }), { status: 400 });
  assert.equal(f.requests.filter(req => req.method === 'PUT').length, 0);
  f.state.missingFrench = false;
  const job = await f.service.create('alice', f.credentials, { ...season, audio, subtitle });
  assert.deepEqual(f.requests.filter(req => req.method === 'PUT').map(req => req.params.get('audioStreamID')), ['202', '302']);
  assert.equal((await f.service.status(job.id, 'alice', f.credentials)).state, 'ready');
  const transfer = await f.service.beginTransfer(job.id, 'alice', f.credentials); await transfer.finish();
});

test('simultaneous conflicting selections cannot change an active conversion, but other users can select independently', async t => {
  const f = await fixture(t, { streams: true });
  const results = await Promise.allSettled([
    f.service.create('alice', f.credentials, { ...request, audio: 'stream:102' }),
    f.service.create('alice', f.credentials, { ...request, audio: 'stream:101' }),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected'); assert.equal(results[1].reason.status, 409);
  assert.equal(f.requests.filter(req => req.method === 'PUT').length, 1);
  const bob = await f.service.create('bob', { ...f.credentials, token: 'other-token' }, { ...request, audio: 'stream:101' });
  assert.notEqual(bob.id, results[0].value.id);
  assert.equal(f.requests.filter(req => req.method === 'PUT').at(-1).token, 'other-token');
});

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
  const jobs = await Promise.all([f.service.create('alice', f.credentials, request), f.service.create('alice', f.credentials, { ...request, quality: '1080p-8' })]);
  await assert.rejects(f.service.create('alice', f.credentials, { ...request, quality: '720p-4' }), { status: 429 });
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
  await transfer.finish();
  await assert.rejects(f.service.status(job.id, 'alice', f.credentials), { status: 404 });
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
  return { call, sessions, logs, settings, url };
}

test('transfer diagnostics identify shared-user Plex refusal without credentials', async t => {
  const warnings = [];
  t.mock.method(logger, 'warn', message => warnings.push(message));
  const f = await fixture(t, { status: 'available', mediaStatus: 403 });
  const app = await application(t, f);
  const job = await (await app.call('', { method: 'POST', body: JSON.stringify(request) })).json();
  const { ticket } = await (await app.call(`/${job.id}/ticket`, { method: 'POST' })).json();
  const response = await app.call(`/${job.id}/file`, { method: 'POST', body: JSON.stringify({ ticket }) });
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /Plex denied/);
  const message = warnings.find(message => message.startsWith('Converted download failed '));
  const details = JSON.parse(message.slice('Converted download failed '.length));
  assert.equal(details.jobId, job.id);
  assert.equal(details.stage, 'open-plex-file');
  assert.equal(details.upstreamStatus, 403);
  assert.equal(details.bytesSent, 0);
  assert.doesNotMatch(message, /shared-token|other-token|admin-token|upstream-secret|session-alice|http:/);
  assert.ok(f.requests.every(r => r.token === 'shared-token'));
  assert.equal(app.logs.length, 0);
});

test('the downloads page lists only the signed-in account and follows preparation, transfer and removal', async t => {
  const f = await fixture(t, { session: { progress: 42 } });
  const app = await application(t, f);
  const alice = await (await app.call('', { method: 'POST', body: JSON.stringify(request) })).json();
  const bob = await (await app.call('', { method: 'POST', body: JSON.stringify(request) }, 'bob')).json();
  const response = await app.call('');
  assert.match(response.headers.get('cache-control'), /no-store/);
  let { jobs } = await response.json();
  assert.deepEqual(jobs.map(job => job.id), [alice.id]);
  assert.equal(jobs[0].title, 'Title 1');
  assert.equal(jobs[0].ratingKey, '1');
  assert.equal(jobs[0].season, false);
  assert.ok(jobs[0].createdAt <= Date.now());
  assert.equal(jobs[0].progress, 42);
  assert.doesNotMatch(JSON.stringify(jobs), /shared-token|other-token|admin-token|client|queueId|sourceSignature/);
  assert.deepEqual((await (await app.call('', {}, 'bob')).json()).jobs.map(job => job.id), [bob.id]);
  assert.equal((await app.call('', {}, 'missing')).status, 401);
  f.state.status = 'available';
  assert.equal((await (await app.call('')).json()).jobs[0].state, 'ready');
  const transfer = await f.service.beginTransfer(alice.id, 'alice', f.credentials);
  assert.equal((await (await app.call('')).json()).jobs[0].state, 'sending');
  await transfer.finish();
  assert.equal((await (await app.call('')).json()).jobs[0].state, 'ready');
  assert.equal(f.requests.filter(req => req.path.endsWith('/add')).length, 2, 'listing/reopening never creates another conversion');
  assert.equal((await app.call(`/${alice.id}`, { method: 'DELETE' }, 'bob')).status, 404);
  assert.equal((await app.call(`/${alice.id}`, { method: 'DELETE' })).status, 204);
  assert.deepEqual((await (await app.call('')).json()).jobs, []);
  assert.equal((await (await app.call('', {}, 'bob')).json()).jobs.length, 1);
});

test('the list excludes another server and expired jobs, and exposes missing prepared files as errors', async t => {
  const f = await fixture(t, { status: 'available', cacheTtlMs: 100 });
  const job = await f.service.create('alice', f.credentials, request);
  assert.equal((await f.service.list('alice', f.credentials))[0].state, 'ready');
  assert.deepEqual(await f.service.list('alice', { ...f.credentials, serverUrl: 'http://another-plex:32400' }), []);
  f.state.missing = true;
  const missing = await f.service.list('alice', f.credentials);
  assert.equal(missing[0].state, 'error');
  assert.match(missing[0].error, /no longer available/);
  await assert.rejects(f.service.beginTransfer(job.id, 'alice', f.credentials), { status: 409 });
  await new Promise(resolve => setTimeout(resolve, 110));
  assert.deepEqual(await f.service.list('alice', f.credentials), []);
});

test('a Plex stream cut short is logged and can be retried without conversion', async t => {
  const warnings = [];
  t.mock.method(logger, 'warn', message => warnings.push(message));
  const f = await fixture(t, { status: 'available', streamMedia: (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': mp4.length * 2 });
    res.write(mp4);
    setTimeout(() => res.destroy(), 40);
  } });
  const app = await application(t, f);
  const job = await (await app.call('', { method: 'POST', body: JSON.stringify(request) })).json();
  const { ticket } = await (await app.call(`/${job.id}/ticket`, { method: 'POST' })).json();
  const response = await app.call(`/${job.id}/file`, { method: 'POST', body: JSON.stringify({ ticket }) });
  assert.equal(response.status, 200);
  await assert.rejects(response.arrayBuffer());
  const message = warnings.find(message => message.startsWith('Converted download failed '));
  const details = JSON.parse(message.slice('Converted download failed '.length));
  assert.equal(details.stage, 'stream-mp4');
  assert.equal(details.bytesSent, mp4.length);
  assert.equal(details.expectedBytes, mp4.length * 2);
  assert.equal(details.responseFinished, false);
  assert.equal(app.logs.length, 0);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.ok([...f.queues.values()].every(queue => queue.items.length === 1));
  assert.equal((await (await app.call(`/${job.id}`)).json()).state, 'ready');
  f.state.streamMedia = undefined;
  const retryTicket = await (await app.call(`/${job.id}/ticket`, { method: 'POST' })).json();
  const retry = await app.call(`/${job.id}/file`, { method: 'POST', body: JSON.stringify(retryTicket) });
  assert.deepEqual(Buffer.from(await retry.arrayBuffer()), mp4);
  assert.equal(f.requests.filter(r => r.path.endsWith('/add')).length, 1);
  assert.equal(app.logs.length, 1);
  assert.deepEqual(app.logs[0][4], { quality: '720p-2', status: 'transferred', audio: 'Plex selection', subtitle: 'Plex selection' });
});

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

test('completed files can be saved twice and reselected after reload without a second conversion', async t => {
  const f = await fixture(t, { status: 'available' });
  const app = await application(t, f);
  const job = await (await app.call('', { method: 'POST', body: JSON.stringify(request) })).json();
  let expiresAt;
  for (let attempt = 0; attempt < 2; attempt++) {
    const { ticket } = await (await app.call(`/${job.id}/ticket`, { method: 'POST' })).json();
    const response = await app.call(`/${job.id}/file`, { method: 'POST', body: JSON.stringify({ ticket }) });
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), mp4);
    const ready = await (await app.call(`/${job.id}`)).json();
    assert.equal(ready.state, 'ready');
    if (expiresAt) assert.equal(ready.expiresAt, expiresAt, 'retry must not extend retention indefinitely');
    expiresAt = ready.expiresAt;
  }
  const reused = await (await app.call('', { method: 'POST', body: JSON.stringify(request) })).json();
  assert.equal(reused.id, job.id);
  assert.equal(reused.reused, true);
  assert.equal(reused.state, 'ready');
  assert.equal(f.requests.filter(r => r.path.endsWith('/add')).length, 1);
  assert.equal(app.logs.length, 2);
  assert.ok(f.requests.every(r => r.token === 'shared-token'));
});

test('reuse is isolated by user and quality and rechecks access and changed source files', async t => {
  const f = await fixture(t, { status: 'available' });
  const job = await f.service.create('alice', f.credentials, request);
  await f.service.status(job.id, 'alice', f.credentials);
  assert.equal((await f.service.create('alice', f.credentials, request)).id, job.id);
  const otherUser = await f.service.create('bob', { ...f.credentials, token: 'other-token' }, request);
  assert.notEqual(otherUser.id, job.id);
  const otherQuality = await f.service.create('alice', f.credentials, { ...request, quality: '1080p-8' });
  assert.notEqual(otherQuality.id, job.id);
  f.state.allowSyncFalse = true;
  await assert.rejects(f.service.create('alice', f.credentials, request), { status: 403 });
  f.state.allowSyncFalse = false;
  f.state.sourceSize = 123456;
  const replacement = await f.service.create('alice', f.credentials, request);
  assert.notEqual(replacement.id, job.id);
  await assert.rejects(f.service.status(job.id, 'alice', f.credentials), { status: 404 });
});

test('simultaneous matching requests share a single Plex conversion', async t => {
  const f = await fixture(t);
  const jobs = await Promise.all(Array.from({ length: 8 }, () => f.service.create('alice', f.credentials, request)));
  assert.equal(new Set(jobs.map(j => j.id)).size, 1);
  assert.equal(f.requests.filter(r => r.path.endsWith('/add')).length, 1);
});

test('idle cache entries yield to new jobs without evicting a live transfer', async t => {
  const f = await fixture(t, { status: 'available' });
  const active = await f.service.create('alice', f.credentials, request);
  await f.service.status(active.id, 'alice', f.credentials);
  const transfer = await f.service.beginTransfer(active.id, 'alice', f.credentials);
  const idle = await f.service.create('alice', f.credentials, { ...request, quality: '1080p-8' });
  await f.service.status(idle.id, 'alice', f.credentials);
  const fresh = await f.service.create('alice', f.credentials, { ...request, quality: '720p-4' });
  assert.notEqual(fresh.id, idle.id);
  await assert.rejects(f.service.status(idle.id, 'alice', f.credentials), { status: 404 });
  assert.equal((await f.service.status(active.id, 'alice', f.credentials)).state, 'sending');
  const source = await transfer.open(transfer.files[0]);
  const chunks = [];
  for await (const chunk of source.stream) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), mp4);
  await transfer.finish();
});

test('cache expiry triggers fresh conversion but never interrupts an already running transfer', async t => {
  const f = await fixture(t, { status: 'available', cacheTtlMs: 60000 });
  const job = await f.service.create('alice', f.credentials, request);
  const ready = await f.service.status(job.id, 'alice', f.credentials);
  const transfer = await f.service.beginTransfer(job.id, 'alice', f.credentials);
  const clock = t.mock.method(Date, 'now', () => ready.expiresAt + 1);
  assert.equal((await f.service.status(job.id, 'alice', f.credentials)).state, 'sending');
  const source = await transfer.open(transfer.files[0]);
  for await (const chunk of source.stream) assert.ok(chunk.length);
  await transfer.finish();
  await assert.rejects(f.service.status(job.id, 'alice', f.credentials), { status: 404 });
  clock.mock.restore();
  const next = await f.service.create('alice', f.credentials, request);
  assert.notEqual(next.id, job.id);
  assert.equal(f.requests.filter(r => r.path.endsWith('/add')).length, 2);
});

test('Plex-evicted files are prepared again only when reselected', async t => {
  const f = await fixture(t, { status: 'available' });
  const job = await f.service.create('alice', f.credentials, request);
  await f.service.status(job.id, 'alice', f.credentials);
  for (const q of f.queues.values()) q.items = [];
  const fresh = await f.service.create('alice', f.credentials, request);
  assert.notEqual(fresh.id, job.id);
  assert.equal(f.requests.filter(r => r.path.endsWith('/add')).length, 2);
});

test('old finalizers and simultaneous file requests cannot release a newer transfer', async t => {
  const f = await fixture(t, { status: 'available' });
  const job = await f.service.create('alice', f.credentials, request);
  await f.service.status(job.id, 'alice', f.credentials);
  const first = await f.service.beginTransfer(job.id, 'alice', f.credentials);
  await assert.rejects(f.service.beginTransfer(job.id, 'alice', f.credentials), { status: 409 });
  await first.finish();
  const second = await f.service.beginTransfer(job.id, 'alice', f.credentials);
  await first.finish();
  assert.equal((await f.service.status(job.id, 'alice', f.credentials)).state, 'sending');
  const source = await second.open(second.files[0]);
  for await (const chunk of source.stream) assert.ok(chunk.length);
  await second.finish();
  assert.equal((await f.service.status(job.id, 'alice', f.credentials)).state, 'ready');
});

test('cached conversions still obey changed per-user policies before reuse and bytes', async t => {
  const f = await fixture(t, { status: 'available' });
  const app = await application(t, f);
  const job = await (await app.call('', { method: 'POST', body: JSON.stringify(request) })).json();
  const { ticket } = await (await app.call(`/${job.id}/ticket`, { method: 'POST' })).json();
  const file = await app.call(`/${job.id}/file`, { method: 'POST', body: JSON.stringify({ ticket }) });
  await file.arrayBuffer();
  app.settings['download_policy:alice'] = JSON.stringify({ enabled: false, libraries: null, qualities: ['720p-2'], serverId: 'server-1' });
  assert.equal((await app.call('', { method: 'POST', body: JSON.stringify(request) })).status, 403);
  const retryTicket = await (await app.call(`/${job.id}/ticket`, { method: 'POST' })).json();
  const denied = await app.call(`/${job.id}/file`, { method: 'POST', body: JSON.stringify(retryTicket) });
  assert.equal(denied.status, 403);
  assert.equal(f.requests.filter(r => r.path.endsWith('/media')).length, 1);
  assert.equal(app.logs.length, 1);
});

test('browser disconnect releases the stream but retains the conversion for a fresh ticket', async t => {
  const f = await fixture(t, { status: 'available', streamMedia: (_req, res) => {
    const chunk = Buffer.alloc(65536, 1);
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': chunk.length * 32 });
    res.write(chunk);
    let count = 1;
    const timer = setInterval(() => { if (++count === 32) { clearInterval(timer); res.end(chunk); } else res.write(chunk); }, 20);
    res.once('close', () => clearInterval(timer));
  } });
  const app = await application(t, f);
  const job = await (await app.call('', { method: 'POST', body: JSON.stringify(request) })).json();
  const { ticket } = await (await app.call(`/${job.id}/ticket`, { method: 'POST' })).json();
  const response = await app.call(`/${job.id}/file`, { method: 'POST', body: JSON.stringify({ ticket }) });
  const reader = response.body.getReader();
  assert.ok((await reader.read()).value.length > 0);
  await reader.cancel();
  let ready;
  for (let i = 0; i < 50; i++) {
    ready = await (await app.call(`/${job.id}`)).json();
    if (ready.state === 'ready') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(ready.state, 'ready');
  assert.equal(app.logs.length, 0);
  f.state.streamMedia = undefined;
  const retryTicket = await (await app.call(`/${job.id}/ticket`, { method: 'POST' })).json();
  const retry = await app.call(`/${job.id}/file`, { method: 'POST', body: JSON.stringify(retryTicket) });
  assert.deepEqual(Buffer.from(await retry.arrayBuffer()), mp4);
  assert.equal(f.requests.filter(r => r.path.endsWith('/add')).length, 1);
  assert.equal(f.requests.filter(r => r.method === 'DELETE').length, 0);
});

test('season retries rebuild the ZIP from retained conversions without retranscoding episodes', async t => {
  const f = await fixture(t, { status: 'available' });
  const app = await application(t, f);
  const input = { ratingKey: '100', season: true, quality: '720p-2' };
  const job = await (await app.call('', { method: 'POST', body: JSON.stringify(input) })).json();
  for (let attempt = 0; attempt < 2; attempt++) {
    const grant = await (await app.call(`/${job.id}/ticket`, { method: 'POST' })).json();
    const response = await app.call(`/${job.id}/file`, { method: 'POST', body: JSON.stringify(grant) });
    assert.equal(response.status, 200);
    const zip = Buffer.from(await response.arrayBuffer());
    assert.equal(zip.toString().split('MOCK-CONVERTED-MEDIA').length - 1, 2);
  }
  const reused = await (await app.call('', { method: 'POST', body: JSON.stringify(input) })).json();
  assert.equal(reused.id, job.id);
  assert.equal(reused.reused, true);
  assert.equal(f.requests.filter(r => r.path.endsWith('/add')).length, 1);
  assert.equal(f.requests.filter(r => r.path.endsWith('/media')).length, 4);
});

test('changing the selected Plex audio stream invalidates a retained conversion', async t => {
  const f = await fixture(t, { status: 'available', audioSelection: 'en' });
  const job = await f.service.create('alice', f.credentials, request);
  await f.service.status(job.id, 'alice', f.credentials);
  f.state.audioSelection = 'fr';
  const fresh = await f.service.create('alice', f.credentials, request);
  assert.notEqual(fresh.id, job.id);
  assert.equal(f.requests.filter(r => r.path.endsWith('/add')).length, 2);
});
