import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Header } from '../components/Header';
import { Sidebar } from '../components/Sidebar';
import { PreparationProgress } from '../components/PreparationProgress';
import { useMobileMenu } from '../hooks/useMobileMenu';
import { useDownloads } from '../contexts/DownloadContext';
import { api } from '../services/api';
import { savePreparedFile } from '../services/nativeDownload';
import { DownloadHistoryEntry, PreparedDownload } from '../types';

const qualityLabel = (quality: string | null) => ({
  original: 'Original', '720p-2': '720p · 2 Mbps', '720p-4': '720p · 4 Mbps', '1080p-8': '1080p · 8 Mbps',
}[quality || ''] || 'Quality not recorded');
const dateLabel = (timestamp: number) => new Date(timestamp).toLocaleString();
const sizeLabel = (bytes: number | null) => bytes == null ? 'Size not recorded'
  : bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(2)} GB`;
const mediaPath = (key: string) => `/media/${encodeURIComponent(key)}`;
const actionClass = 'px-3 py-2 rounded-lg text-sm bg-dark-200 hover:bg-dark-50 disabled:opacity-50 disabled:cursor-not-allowed';

export const DownloadJobCard: React.FC<{
  job: PreparedDownload; busy: boolean; unavailable: boolean;
  onSave: () => void; onRemove: () => void;
}> = ({ job, busy, unavailable, onSave, onRemove }) => (
  <article className="rounded-xl border border-dark-50 bg-dark-100 p-4 space-y-3 min-w-0">
    <div>
      <Link to={mediaPath(job.ratingKey)} className="font-semibold hover:text-primary-400 break-words">{job.title}</Link>
      <p className="text-sm text-gray-400 mt-1">{qualityLabel(job.quality)}{job.season ? ` · ${job.fileCount} episodes` : ''}</p>
      {job.audioLabel && <p className="text-xs text-gray-400 mt-1">Audio: {job.audioLabel} · Subtitles: {job.subtitleLabel}</p>}
      <p className="text-xs text-gray-500 mt-1 break-all">{job.filename}</p>
    </div>
    {job.state === 'preparing' && <PreparationProgress stage={job.stage} progress={job.progress}
      readyCount={job.readyCount} fileCount={job.fileCount} startedAt={job.createdAt} />}
    {job.state === 'sending' && <p role="status" className="text-sm text-primary-400">Transferring to your browser. Check its download manager for progress.</p>}
    {job.state === 'ready' && <p className="text-sm text-green-400">Ready · kept until {dateLabel(job.expiresAt)}</p>}
    {job.state === 'error' && <p className="text-sm text-red-400 break-words">{job.error || 'Preparation failed. Open the media to try again.'}</p>}
    <div className="flex flex-wrap gap-2">
      {job.state === 'ready' && <button className="btn-primary text-sm disabled:opacity-50" disabled={busy || unavailable || job.expiresAt <= Date.now()}
        onClick={onSave}>{busy ? 'Please wait…' : 'Save file'}</button>}
      {job.state === 'error' && <Link className={actionClass} to={mediaPath(job.ratingKey)}>Open media to retry</Link>}
      <button className={actionClass} disabled={busy} onClick={onRemove}>
        {job.state === 'preparing' || job.state === 'sending' ? 'Cancel task' : 'Remove prepared file'}
      </button>
    </div>
  </article>
);

export const DownloadHistoryList: React.FC<{ entries: DownloadHistoryEntry[] }> = ({ entries }) => (
  <ul className="divide-y divide-dark-50 rounded-xl border border-dark-50 bg-dark-100">
    {entries.map(entry => <li key={entry.id} className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
      <div className="min-w-0">
        <Link className="font-medium hover:text-primary-400 break-words" to={mediaPath(entry.media_key)}>{entry.media_title}</Link>
        <p className="text-sm text-gray-400 mt-1">{qualityLabel(entry.quality)} · {sizeLabel(entry.file_size)}</p>
        {entry.audio_selection && <p className="text-xs text-gray-400 mt-1">Audio: {entry.audio_selection} · Subtitles: {entry.subtitle_selection}</p>}
        <p className="text-xs text-gray-500 mt-1">{dateLabel(entry.downloaded_at)} · {entry.transfer_status === 'transferred'
          ? 'Transferred to browser' : entry.transfer_status === 'requested' ? 'Download requested' : 'Recorded download'}</p>
      </div>
      <Link className={`${actionClass} self-start sm:self-auto whitespace-nowrap`} to={mediaPath(entry.media_key)}>Open media</Link>
    </li>)}
  </ul>
);

export const Downloads: React.FC = () => {
  const { isMobileMenuOpen, toggleMobileMenu, closeMobileMenu } = useMobileMenu();
  const { downloads, removeDownload } = useDownloads();
  const [jobs, setJobs] = useState<PreparedDownload[]>([]);
  const [history, setHistory] = useState<DownloadHistoryEntry[]>([]);
  const [jobsLoading, setJobsLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [jobsError, setJobsError] = useState('');
  const [historyError, setHistoryError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<string[]>([]);
  const actions = useRef(new Set<string>());
  const mounted = useRef(true);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const pageSize = 20;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await api.listPreparedDownloads();
        if (!stopped) { setJobs(result); setJobsError(''); }
      } catch {
        if (!stopped) setJobsError('Cannot refresh tasks. The list may be out of date; your conversions continue on the server.');
      } finally {
        if (!stopped) { setJobsLoading(false); timer = setTimeout(poll, 5000); }
      }
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [refresh]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    setHistoryLoading(true);
    const poll = async () => {
      try {
        const result = await api.getDownloadHistoryPage({ limit: pageSize, offset, search });
        if (!stopped) { setHistory(result.history); setHasMore(result.hasMore); setHistoryError(''); }
      } catch {
        if (!stopped) setHistoryError('Cannot load your download history. Try refreshing.');
      } finally {
        if (!stopped) { setHistoryLoading(false); timer = setTimeout(poll, 5000); }
      }
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [offset, search, refresh]);

  const act = async (job: PreparedDownload, action: 'save' | 'remove') => {
    if (actions.current.has(job.id)) return;
    actions.current.add(job.id); setBusy([...actions.current]);
    setActionError(''); setNotice('');
    try {
      if (action === 'save') {
        if (!await savePreparedFile(job.id, () => !mounted.current)) return;
        if (mounted.current) setNotice('Sent to your browser. If it fails, use Save file again while the prepared file is available.');
      } else {
        await api.cancelPreparedDownload(job.id);
        if (mounted.current) {
          downloads.filter(download => download.jobId === job.id).forEach(download => removeDownload(download.id));
          setJobs(previous => previous.filter(item => item.id !== job.id));
          setNotice('Task removed. Your download history is kept.');
        }
      }
    } catch (error: any) {
      if (mounted.current) setActionError(error.response?.status === 409
        ? 'A transfer is still running. Wait for it to finish or cancel it in your browser, then retry.'
        : error.response?.data?.error || 'Could not complete this action. Please try again.');
    } finally {
      actions.current.delete(job.id);
      if (mounted.current) { setBusy([...actions.current]); setRefresh(value => value + 1); }
    }
  };

  const active = jobs.filter(job => job.state === 'preparing' || job.state === 'sending');
  const ready = jobs.filter(job => job.state === 'ready');
  const failed = jobs.filter(job => job.state === 'error');
  const card = (job: PreparedDownload) => <DownloadJobCard key={job.id} job={job} busy={busy.includes(job.id)}
    unavailable={!!jobsError} onSave={() => void act(job, 'save')} onRemove={() => void act(job, 'remove')} />;

  return (
    <div className="flex h-screen overflow-hidden bg-dark">
      <Sidebar isOpen={isMobileMenuOpen} onClose={closeMobileMenu} />
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <Header onMenuClick={toggleMobileMenu} />
        <main className="flex-1 p-4 md:p-8 overflow-y-auto">
          <div className="max-w-5xl mx-auto space-y-8">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h1 className="text-2xl md:text-3xl font-bold">Downloads</h1>
                <p className="text-gray-400 mt-2">Your conversions, prepared files and download history.</p>
              </div>
              <button className={actionClass} onClick={() => setRefresh(value => value + 1)}>Refresh</button>
            </div>
            <nav aria-label="Download sections" className="grid grid-cols-3 gap-2 text-sm">
              <a className={`${actionClass} text-center`} href="#in-progress">In progress ({active.length})</a>
              <a className={`${actionClass} text-center`} href="#ready">Ready ({ready.length})</a>
              <a className={`${actionClass} text-center`} href="#history">History</a>
            </nav>
            {actionError && <p role="alert" className="text-red-400">{actionError}</p>}
            {notice && <p role="status" className="text-sm text-green-400">{notice}</p>}
            {jobsError && <p role="alert" className="text-amber-400">{jobsError}</p>}
            <section id="in-progress" className="space-y-3 scroll-mt-4">
              <h2 className="text-xl font-semibold">In progress</h2>
              {jobsLoading ? <p className="text-gray-400">Loading tasks…</p> : active.length
                ? <div className="grid md:grid-cols-2 gap-4">{active.map(card)}</div>
                : <p className="text-sm text-gray-400">No conversions in progress. Choose a quality on a movie or season to prepare a file.</p>}
            </section>
            <section id="ready" className="space-y-3 scroll-mt-4">
              <h2 className="text-xl font-semibold">Ready to download</h2>
              {!jobsLoading && (ready.length ? <div className="grid md:grid-cols-2 gap-4">{ready.map(card)}</div>
                : <p className="text-sm text-gray-400">Your prepared files will appear here.</p>)}
              <p className="text-xs text-gray-500">Files are kept for up to six hours, unless Plex expires them, space is needed or the app restarts. Saving again uses the prepared file.</p>
            </section>
            {failed.length > 0 && <section className="space-y-3">
              <h2 className="text-xl font-semibold">Needs attention</h2>
              <div className="grid md:grid-cols-2 gap-4">{failed.map(card)}</div>
            </section>}
            <section id="history" className="space-y-4 scroll-mt-4">
              <div>
                <h2 className="text-xl font-semibold">Download history</h2>
                <p className="text-sm text-gray-400 mt-1">Kept after prepared files expire. Open a title to download it again.</p>
              </div>
              <form className="flex gap-2" onSubmit={event => { event.preventDefault(); setOffset(0); setSearch(searchInput.trim()); }}>
                <input type="search" aria-label="Search your download history" placeholder="Search your downloads…" maxLength={200}
                  value={searchInput} onChange={event => setSearchInput(event.target.value)}
                  className="flex-1 min-w-0 rounded-lg bg-dark-100 border border-dark-50 px-3 py-2" />
                <button className={actionClass} type="submit">Search</button>
              </form>
              {historyError && <p role="alert" className="text-red-400">{historyError}</p>}
              {historyLoading ? <p className="text-gray-400">Loading history…</p> : !historyError && (history.length
                ? <DownloadHistoryList entries={history} />
                : <p className="text-sm text-gray-400">{search ? 'No downloads match your search.' : 'No downloads recorded yet.'}</p>)}
              <div className="flex items-center justify-between gap-3">
                <button className={actionClass} disabled={offset === 0 || historyLoading} onClick={() => setOffset(value => Math.max(0, value - pageSize))}>Previous</button>
                <span className="text-sm text-gray-400">Page {Math.floor(offset / pageSize) + 1}</span>
                <button className={actionClass} disabled={!hasMore || historyLoading || !!historyError} onClick={() => setOffset(value => value + pageSize)}>Next</button>
              </div>
              <p className="text-xs text-gray-500">“Transferred to browser” means the server finished sending the file. Check your browser to confirm it was saved on your device.</p>
            </section>
          </div>
        </main>
      </div>
    </div>
  );
};
