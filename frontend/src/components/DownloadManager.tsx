import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useDownloads } from '../contexts/DownloadContext';
import { PreparationProgress } from './PreparationProgress';

export const DownloadManager: React.FC = () => {
  const { downloads, removeDownload, savePreparedDownload } = useDownloads();
  const location = useLocation();
  const visible = location.pathname === '/downloads'
    ? downloads.filter(download => !download.jobId && download.status !== 'preparing') : downloads;

  if (visible.length === 0) {
    return null;
  }

  return (
    <div className="fixed top-20 right-4 sm:right-6 z-50 space-y-2 w-[calc(100%-2rem)] max-w-sm">
      <Link to="/downloads" className="block bg-dark-100 rounded-lg px-4 py-2 text-sm text-primary-400 hover:underline">Open Downloads →</Link>
      {visible.map((download) => (
        <div
          key={download.id}
          className="bg-dark-100 border border-dark-50 rounded-lg shadow-lg p-4"
        >
          <div className="flex items-start justify-between mb-2">
            <div className="flex-1 min-w-0 pr-2">
              <div className="text-sm font-medium truncate">{download.title}</div>
              <div className="text-xs text-gray-400 truncate">{download.filename}</div>
            </div>
            <button
              onClick={() => removeDownload(download.id)}
              aria-label={download.status === 'preparing' ? 'Cancel download' : 'Dismiss download'}
              className="text-gray-400 hover:text-white transition-colors flex-shrink-0"
            >
              ✕
            </button>
          </div>

          {download.status === 'preparing' && (
            <PreparationProgress stage={download.preparationStage} progress={download.preparationProgress}
              readyCount={download.readyCount} fileCount={download.fileCount} startedAt={download.startedAt} />
          )}
          {download.status === 'ready' && (
            <div className="space-y-2">
              <PreparationProgress stage="ready" progress={100} readyCount={download.readyCount}
                fileCount={download.fileCount} startedAt={download.startedAt} />
              {download.reused && <p className="text-xs text-green-400">Reusing your prepared file — no new conversion.</p>}
              {download.error && <p className="text-xs text-red-400">{download.error}</p>}
              <button className="btn-primary text-sm" onClick={() => savePreparedDownload(download.id)}>Save file</button>
            </div>
          )}
          {download.status === 'sending' && <p className="text-xs text-primary-400">Starting download…</p>}
          {download.status === 'handedOff' && (
            <div className="space-y-2">
              <p className="text-xs text-gray-300">Sent to your browser. Check its download manager for progress.</p>
              {download.error && <p className="text-xs text-red-400">{download.error}</p>}
              <button className="btn-primary text-sm" onClick={() => savePreparedDownload(download.id)}>Retry download</button>
              <p className="text-xs text-gray-400">Uses the prepared file without converting again.</p>
            </div>
          )}
          {download.expiresAt && ['ready', 'handedOff'].includes(download.status) && (
            <p className="text-xs text-gray-400 mt-2">Kept until {new Date(download.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}, unless Plex expires it or space is needed for another download.</p>
          )}
          {download.status === 'downloading' && (
            <>
              {download.isBulkDownload ? (
                // Indeterminate progress for bulk downloads (no Content-Length)
                <>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="text-gray-400">Creating ZIP archive...</span>
                    <span className="text-primary-400 font-semibold animate-pulse">●</span>
                  </div>
                  <div className="w-full h-2 bg-dark-200 rounded-full overflow-hidden">
                    <div className="h-full bg-gradient-to-r from-primary-500 to-primary-400 animate-pulse" />
                  </div>
                </>
              ) : (
                // Percentage-based progress for single file downloads
                <>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="text-gray-400">Downloading...</span>
                    <span className="text-primary-400 font-semibold">{download.progress}%</span>
                  </div>
                  <div className="w-full h-2 bg-dark-200 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-primary-500 to-primary-400 transition-all duration-300 ease-out"
                      style={{ width: `${download.progress}%` }}
                    />
                  </div>
                </>
              )}
            </>
          )}

          {download.status === 'completed' && (
            <div className="flex items-center text-xs text-green-400">
              <span>✓ Download completed</span>
            </div>
          )}

          {download.status === 'error' && (
            <div className="flex items-center text-xs text-red-400">
              <span>✗ Download failed: {download.error || 'Unknown error'}</span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
};
