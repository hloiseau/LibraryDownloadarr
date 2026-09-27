const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

function load(file, modules, globals = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../src', file), 'utf8');
  const javascript = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
    jsx: ts.JsxEmit.React, esModuleInterop: true,
  } }).outputText;
  const exports = {};
  vm.runInNewContext(javascript, { exports, require: name => {
    if (!(name in modules)) throw new Error(`Unexpected import ${name}`);
    return modules[name];
  }, ...globals });
  return exports;
}
const { PreparationProgress } = load('components/PreparationProgress.tsx', { react: React });
const render = props => renderToStaticMarkup(React.createElement(PreparationProgress, { startedAt: Date.now() - 65000, ...props }));

test('conversion card renders measured percentage, elapsed time and season counts', () => {
  const html = render({ stage: 'processing', progress: 42, readyCount: 1, fileCount: 3 });
  assert.match(html, /Converting with Plex/);
  assert.match(html, /aria-valuenow="42"/);
  assert.match(html, /width:42%/);
  assert.match(html, /1 \/ 3 files ready/);
  assert.match(html, /Elapsed 1m/);
});

test('waiting or unknown progress shows animation without an invented percentage', () => {
  for (const props of [{ stage: 'waiting', progress: 0 }, { stage: 'processing', progress: null }]) {
    const html = render(props);
    assert.match(html, /animate-preparation/);
    assert.doesNotMatch(html, /aria-valuenow|>0%/);
  }
  assert.match(render({ stage: 'waiting', progress: 0 }), /Waiting for Plex/);
  assert.match(render({ stage: 'processing', progress: null }), /percentage is not available yet/);
});

test('finalization remains below 100 and only ready state shows a completed bar', () => {
  const pending = render({ stage: 'finalizing', progress: 100 });
  assert.match(pending, /Finalizing file/);
  assert.match(pending, /aria-valuenow="99"/);
  const ready = render({ stage: 'ready', progress: 100 });
  assert.match(ready, /Converted file ready/);
  assert.match(ready, /aria-valuenow="100"/);
  assert.doesNotMatch(ready, /Elapsed|Keep this tab open/);
});

test('the download provider carries polled preparation progress to the UI until ready', async () => {
  const updates = [];
  let downloads = [];
  const react = {
    createElement: (type, props) => ({ type, props }),
    createContext: () => ({ Provider: 'provider' }), useEffect: () => {},
    useRef: current => ({ current }),
    useState: () => [downloads, value => { downloads = value(downloads); updates.push(downloads); }],
  };
  const stages = [
    { state: 'preparing', stage: 'waiting', progress: 0 },
    { state: 'preparing', stage: 'processing', progress: 42 },
    { state: 'preparing', stage: 'finalizing', progress: 99 },
    { state: 'ready', stage: 'ready', progress: 100 },
  ];
  let calls = 0;
  const next = async () => ({ id: 'job-1', filename: 'converted.mp4', fileCount: 1, readyCount: 0, ...stages[calls++] });
  const { DownloadProvider } = load('contexts/DownloadContext.tsx', {
    react, '../services/api': { api: { prepareDownload: next, getPreparedDownload: next } },
    '../services/nativeDownload': {},
  }, { setTimeout: callback => setTimeout(callback, 0) });
  const provider = DownloadProvider({ children: null });
  await provider.props.value.startDownload('1', '/library/parts/1/file.mkv', 'source.mkv', 'Movie', '720p-2');
  assert.equal(calls, 4);
  assert.deepEqual(updates.slice(1).map(items => items[0].preparationProgress), [0, 42, 99, 100]);
  assert.equal(downloads[0].status, 'ready');
  assert.ok(downloads[0].startedAt > 0);
});

function retryProvider(ticketImpl, prepareImpl) {
  let downloads = [];
  const refs = [];
  let refIndex = 0;
  let cleanup;
  let preparations = 0;
  const cancellations = [];
  const submitted = [];
  const react = {
    createElement: (type, props) => ({ type, props }),
    createContext: () => ({ Provider: 'provider' }),
    useEffect: (fn, deps) => { if (deps.length === 0) cleanup = fn(); },
    useRef: value => refs[refIndex++] || (refs[refIndex - 1] = { current: value }),
    useState: () => [downloads, update => { downloads = update(downloads); }],
  };
  const document = {
    body: { appendChild: () => {} },
    createElement: tag => ({ tag, children: [], appendChild(child) { this.children.push(child); },
      remove() {}, submit() { submitted.push({ method: this.method, action: this.action, ticket: this.children[0].value }); } }),
  };
  const { DownloadProvider } = load('contexts/DownloadContext.tsx', {
    '../services/nativeDownload': load('services/nativeDownload.ts', { './api': { api: { getDownloadTicket: ticketImpl } } }, { document }),
    react, '../services/api': { api: {
      prepareDownload: async () => { preparations++; if (prepareImpl) return prepareImpl(); return { id: 'cached-job', filename: 'movie.mp4', state: 'ready',
        stage: 'ready', progress: 100, fileCount: 1, readyCount: 1, expiresAt: Date.now() + 60000, reused: true }; },
      getDownloadTicket: ticketImpl,
      cancelPreparedDownload: async id => cancellations.push(id),
    } },
  }, { document });
  const renderProvider = () => { refIndex = 0; return DownloadProvider({ children: null }).props.value; };
  return { renderProvider, submitted, cancellations, cleanup: () => cleanup(), prepareCount: () => preparations };
}

test('retry uses a new ticket for the retained job; ready files survive dismissal and page unmount', async () => {
  let tickets = 0;
  const h = retryProvider(async () => `ticket-${++tickets}`);
  await h.renderProvider().startDownload('1', '/library/parts/1/file.mkv', 'movie.mkv', 'Movie', '720p-2');
  let provider = h.renderProvider();
  const id = provider.downloads[0].id;
  assert.equal(provider.downloads[0].reused, true);
  await provider.savePreparedDownload(id);
  provider = h.renderProvider();
  assert.equal(provider.downloads[0].status, 'handedOff');
  await Promise.all([provider.savePreparedDownload(id), provider.savePreparedDownload(id)]);
  assert.equal(h.prepareCount(), 1);
  assert.equal(tickets, 2, 'double clicks must not issue competing single-use tickets');
  assert.deepEqual(h.submitted.map(x => x.ticket), ['ticket-1', 'ticket-2']);
  assert.ok(h.submitted.every(x => x.method === 'POST' && x.action === '/api/downloads/cached-job/file'));
  h.cleanup();
  assert.deepEqual(h.cancellations, []);
  h.renderProvider().removeDownload(id);
  assert.deepEqual(h.cancellations, []);
});

test('a retry during an active transfer keeps the retry action and explains when to retry', async () => {
  let tickets = 0;
  const h = retryProvider(async () => {
    if (++tickets === 2) throw { response: { status: 409, data: { error: 'Download is not ready.' } } };
    return 'fresh-ticket';
  });
  await h.renderProvider().startDownload('1', '/library/parts/1/file.mkv', 'movie.mkv', 'Movie', '720p-2');
  let provider = h.renderProvider();
  const id = provider.downloads[0].id;
  await provider.savePreparedDownload(id);
  await h.renderProvider().savePreparedDownload(id);
  provider = h.renderProvider();
  assert.equal(provider.downloads[0].status, 'handedOff');
  assert.match(provider.downloads[0].error, /transfer is still running/);
  assert.equal(h.submitted.length, 1);
  assert.equal(h.prepareCount(), 1);
});

test('download manager exposes retry and cache reuse without claiming a browser save succeeded', () => {
  const { DownloadManager } = load('components/DownloadManager.tsx', {
    react: React,
    'react-router-dom': { useLocation: () => ({ pathname: '/' }), Link: ({ to, children, ...props }) => React.createElement('a', { href: to, ...props }, children) },
    '../contexts/DownloadContext': { useDownloads: () => ({ downloads: [{
      id: '1', title: 'Movie', filename: 'movie.mp4', status: 'handedOff', expiresAt: Date.now() + 60000,
    }], removeDownload() {}, savePreparedDownload() {} }) },
    './PreparationProgress': { PreparationProgress },
  });
  const html = renderToStaticMarkup(React.createElement(DownloadManager));
  assert.match(html, /Retry download/);
  assert.match(html, /without converting again/);
  assert.match(html, /Kept until/);
  assert.doesNotMatch(html, /Download completed/);
});

test('closing the page while preparation starts keeps the server job; explicit cancellation removes it', async () => {
  for (const cancel of [false, true]) {
    let resolve;
    const h = retryProvider(async () => 'unused', () => new Promise(done => { resolve = done; }));
    const pending = h.renderProvider().startDownload('1', '/library/parts/1/file.mkv', 'movie.mkv', 'Movie', '720p-2');
    if (cancel) {
      const provider = h.renderProvider();
      provider.removeDownload(provider.downloads[0].id);
    } else h.cleanup();
    resolve({ id: 'background-job', state: 'preparing' });
    await pending;
    assert.deepEqual(h.cancellations, cancel ? ['background-job'] : []);
  }
});

const Link = ({ to, children, ...props }) => React.createElement('a', { href: to, ...props }, children);
const pageModules = {
  react: React, 'react-router-dom': { Link },
  '../components/Header': { Header: () => null }, '../components/Sidebar': { Sidebar: () => null },
  '../components/PreparationProgress': { PreparationProgress },
  '../hooks/useMobileMenu': { useMobileMenu: () => ({}) },
  '../contexts/DownloadContext': { useDownloads: () => ({ downloads: [], removeDownload() {} }) },
  '../services/api': { api: {} }, '../services/nativeDownload': {},
};

test('downloads cards expose progress, ready save, transfer and failure states; history does not claim a disk save', () => {
  const { DownloadJobCard, DownloadHistoryList } = load('pages/Downloads.tsx', pageModules);
  const job = { id: '1', title: 'Movie', ratingKey: '25', quality: '720p-2', filename: 'movie.mp4',
    createdAt: Date.now(), expiresAt: Date.now() + 60000, readyCount: 0, fileCount: 1, stage: 'processing', progress: 42 };
  const card = state => renderToStaticMarkup(React.createElement(DownloadJobCard, { job: { ...job, state }, busy: false }));
  assert.match(card('preparing'), /aria-valuenow="42"/);
  assert.match(card('preparing'), /Cancel task/);
  assert.match(card('ready'), /Save file/);
  assert.match(card('ready'), /720p · 2 Mbps/);
  assert.match(card('ready'), /href="\/media\/25"/);
  assert.match(card('sending'), /Transferring to your browser/);
  assert.doesNotMatch(card('sending'), /Save file/);
  assert.match(card('error'), /Open media to retry/);
  const history = renderToStaticMarkup(React.createElement(DownloadHistoryList, { entries: [
    { id: 'one', media_title: 'New', media_key: '1', downloaded_at: 1, file_size: 100, quality: '720p-2', transfer_status: 'transferred' },
    { id: 'two', media_title: 'Old', media_key: '2', downloaded_at: 1, file_size: null, quality: null, transfer_status: 'recorded' },
    { id: 'three', media_title: 'Original', media_key: '3', downloaded_at: 1, file_size: 200, quality: 'original', transfer_status: 'requested' },
  ] }));
  assert.match(history, /Transferred to browser/);
  assert.match(history, /Quality not recorded/);
  assert.match(history, /Download requested/);
  assert.doesNotMatch(history, /Download completed|Saved to/);
});

test('ordinary users can find Downloads in the sidebar without access to the admin history', () => {
  const { Sidebar } = load('components/Sidebar.tsx', {
    react: React, 'react-router-dom': { useNavigate: () => () => {}, useLocation: () => ({ pathname: '/downloads' }) },
    '../services/api': {}, '../stores/authStore': { useAuthStore: () => ({ user: { isAdmin: false } }) },
  });
  const html = renderToStaticMarkup(React.createElement(Sidebar, { isOpen: true, onClose() {} }));
  assert.match(html, /Downloads/);
  assert.doesNotMatch(html, /All download history|Download permissions|Settings/);
});

test('the page recovers existing jobs, saves without preparation, pages history and stops polling on exit', async () => {
  const slots = [], effects = [];
  let index = 0;
  const timers = new Map();
  let nextTimer = 0;
  const react = { ...React,
    useState: initial => {
      const i = index++;
      if (!(i in slots)) slots[i] = initial;
      return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }];
    },
    useRef: initial => { const i = index++; return slots[i] || (slots[i] = { current: initial }); },
    useEffect: (fn, deps) => {
      const i = index++;
      const old = slots[i];
      if (!old || deps.some((value, n) => value !== old.deps[n])) {
        effects.push(() => { old?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; });
      }
    },
  };
  const jobs = [{ id: 'recovered', title: 'Movie', ratingKey: '1', state: 'ready', quality: '720p-2', filename: 'movie.mp4', expiresAt: Date.now() + 60000 }];
  const historyCalls = [], saves = [], removals = [];
  let resolveSave;
  const modules = { ...pageModules, react,
    '../services/api': { api: {
      listPreparedDownloads: async () => jobs,
      getDownloadHistoryPage: async filters => { historyCalls.push(filters); return { history: [], hasMore: true }; },
      cancelPreparedDownload: async id => removals.push(id),
    } },
    '../services/nativeDownload': { savePreparedFile: async id => { saves.push(id); await new Promise(resolve => { resolveSave = resolve; }); return true; } },
  };
  const { Downloads, DownloadJobCard } = load('pages/Downloads.tsx', modules, {
    setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
  });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const renderPage = async () => {
    index = 0; const tree = Downloads(); effects.splice(0).forEach(effect => effect()); await settle(); return tree;
  };
  const elements = node => !node || typeof node !== 'object' ? [] : Array.isArray(node)
    ? node.flatMap(elements) : [node, ...elements(node.props?.children)];
  await renderPage();
  let tree = await renderPage();
  const card = elements(tree).find(node => node.type === DownloadJobCard);
  assert.equal(card.props.job.id, 'recovered');
  card.props.onSave(); card.props.onSave();
  assert.deepEqual(saves, ['recovered']);
  resolveSave(); await settle(); await renderPage();
  tree = await renderPage();
  elements(tree).find(node => node.type === 'button' && node.props.children === 'Next').props.onClick();
  await renderPage();
  assert.equal(historyCalls.at(-1).offset, 20);
  assert.equal(historyCalls.at(-1).limit, 20);
  tree = await renderPage();
  elements(tree).find(node => node.type === 'input').props.onChange({ target: { value: 'Movie' } });
  tree = await renderPage();
  elements(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await renderPage();
  assert.equal(historyCalls.at(-1).offset, 0);
  assert.equal(historyCalls.at(-1).search, 'Movie');
  assert.deepEqual(removals, []);
  slots.forEach(slot => slot?.cleanup?.());
  assert.equal(timers.size, 0);
  assert.deepEqual(removals, [], 'leaving the page must not cancel a server conversion');
});
