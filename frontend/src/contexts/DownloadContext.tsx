import React, { createContext, useContext, useState, useRef, useEffect, ReactNode } from 'react';
import { api } from '../services/api';
import { savePreparedFile } from '../services/nativeDownload';
import { DownloadQuality, PreparationStage, StreamSelection } from '../types';

interface Download {
  id: string;
  ratingKey: string;
  partKey: string;
  filename: string;
  title: string;
  progress: number;
  startedAt: number;
  preparationStage?: PreparationStage;
  preparationProgress?: number | null;
  status: 'preparing' | 'ready' | 'sending' | 'handedOff' | 'downloading' | 'completed' | 'error';
  jobId?: string;
  readyCount?: number;
  fileCount?: number;
  expiresAt?: number;
  reused?: boolean;
  audioLabel?: string;
  subtitleLabel?: string;
  error?: string;
  isBulkDownload?: boolean; // True for season/album zips (no progress tracking)
}

interface DownloadContextType {
  downloads: Download[];
  startDownload: (ratingKey: string, partKey: string, filename: string, title: string, quality?: DownloadQuality, selection?: StreamSelection) => Promise<void>;
  savePreparedDownload: (id: string) => Promise<void>;
  removeDownload: (id: string) => void;
}

const DownloadContext = createContext<DownloadContextType | undefined>(undefined);

export const useDownloads = () => {
  const context = useContext(DownloadContext);
  if (!context) {
    throw new Error('useDownloads must be used within a DownloadProvider');
  }
  return context;
};

interface DownloadProviderProps {
  children: ReactNode;
}

export const DownloadProvider: React.FC<DownloadProviderProps> = ({ children }) => {
  const [downloads, setDownloads] = useState<Download[]>([]);
  const preparations = useRef(new Map<string, { cancelled: boolean; discard?: boolean; jobId?: string; handedOff?: boolean; ready?: boolean; saving?: boolean }>());

  useEffect(() => () => {
    for (const item of preparations.current.values()) {
      item.cancelled = true;
    }
  }, []);

  // Warn user before closing/refreshing if downloads are in progress
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      const activeDownloads = downloads.filter(d => d.status === 'downloading');

      if (activeDownloads.length > 0) {
        // Standard way to show browser confirmation dialog
        e.preventDefault();
        e.returnValue = ''; // Chrome requires returnValue to be set
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [downloads]);

  const startDownload = async (
    ratingKey: string,
    partKey: string,
    filename: string,
    title: string,
    quality: DownloadQuality = 'original',
    selection: StreamSelection = {}
  ): Promise<void> => {
    const downloadId = `${ratingKey}-${partKey}-${Date.now()}`;

    // Check if this is a bulk download (season or album ZIP)
    const isBulkDownload = partKey.includes('/season/') || partKey.includes('/album/');

    // Add download to state
    const newDownload: Download = {
      id: downloadId,
      ratingKey,
      partKey,
      filename,
      title,
      progress: 0,
      startedAt: Date.now(),
      status: quality === 'original' ? 'downloading' : 'preparing',
      isBulkDownload,
    };

    setDownloads((prev) => [...prev, newDownload]);

    if (quality !== 'original') {
      const preparation: { cancelled: boolean; discard?: boolean; jobId?: string; handedOff?: boolean; ready?: boolean; saving?: boolean } = { cancelled: false };
      preparations.current.set(downloadId, preparation);
      try {
        let job = await api.prepareDownload({ ratingKey, quality, audio: selection.audio, subtitle: selection.subtitle,
          ...(partKey.includes('/season/') ? { season: true } : { partKey }) });
        preparation.jobId = job.id;
        while (!preparation.cancelled) {
          setDownloads(prev => prev.map(d => d.id === downloadId ? {
            ...d, jobId: job.id, filename: job.filename,
            status: job.state === 'sending' ? 'handedOff' : job.state,
            readyCount: job.readyCount, fileCount: job.fileCount, error: job.error,
            expiresAt: job.expiresAt, reused: job.reused ?? d.reused,
            audioLabel: job.audioLabel, subtitleLabel: job.subtitleLabel,
            preparationStage: job.stage || 'deciding', preparationProgress: job.progress ?? null,
          } : d));
          if (job.state === 'error') {
            preparations.current.delete(downloadId);
            return;
          }
          if (job.state === 'ready' || job.state === 'sending') {
            preparation.ready = true;
            preparation.handedOff = job.state === 'sending';
            return;
          }
          await new Promise(resolve => setTimeout(resolve, 2500));
          if (!preparation.cancelled) job = await api.getPreparedDownload(job.id);
        }
        if (preparation.discard) await api.cancelPreparedDownload(job.id).catch(() => undefined);
      } catch (error: any) {
        if (!preparation.cancelled) setDownloads(prev => prev.map(d => d.id === downloadId
          ? { ...d, status: 'error', error: error.response?.data?.error || error.message || 'Preparation failed' } : d));
        preparations.current.delete(downloadId);
      }
      return;
    }

    try {
      // Check if partKey is already a full URL (for bulk downloads) or a path fragment
      const downloadUrl = partKey.startsWith('/api/')
        ? partKey // Already a full URL for bulk downloads
        : api.getDownloadUrl(ratingKey, partKey); // Single file download

      // Fetch with progress tracking
      const response = await fetch(downloadUrl, {
        headers: {
          Authorization: `Bearer ${localStorage.getItem('token')}`,
        },
      });

      if (!response.ok) {
        // Try to extract error message from JSON response
        let errorMessage = 'Download failed';
        try {
          const errorData = await response.json();
          errorMessage = errorData.error || errorMessage;
        } catch {
          // If JSON parsing fails, use status text
          errorMessage = response.statusText || errorMessage;
        }
        throw new Error(errorMessage);
      }

      const contentLength = response.headers.get('content-length');
      const total = contentLength ? parseInt(contentLength, 10) : 0;

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('Stream not available');
      }

      const chunks: Uint8Array[] = [];
      let receivedLength = 0;

      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        chunks.push(value);
        receivedLength += value.length;

        // Update progress - only for non-bulk downloads with known size
        // Bulk downloads (zips) don't have Content-Length, so we can't track progress
        if (!isBulkDownload && total > 0) {
          const progress = Math.round((receivedLength / total) * 100);
          setDownloads((prev) =>
            prev.map((d) =>
              d.id === downloadId
                ? { ...d, progress }
                : d
            )
          );
        }
      }

      // Create blob and download
      const blob = new Blob(chunks as BlobPart[]);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);

      // Mark as completed
      setDownloads((prev) =>
        prev.map((d) =>
          d.id === downloadId
            ? { ...d, status: 'completed', progress: 100 }
            : d
        )
      );

      // Remove after 3 seconds
      setTimeout(() => {
        setDownloads((prev) => prev.filter((d) => d.id !== downloadId));
      }, 3000);
    } catch (error: any) {
      // Mark as error
      setDownloads((prev) =>
        prev.map((d) =>
          d.id === downloadId
            ? { ...d, status: 'error', error: error.message }
            : d
        )
      );

      // Remove after 5 seconds
      setTimeout(() => {
        setDownloads((prev) => prev.filter((d) => d.id !== downloadId));
      }, 5000);
    }
  };

  const savePreparedDownload = async (id: string) => {
    const download = downloads.find(d => d.id === id);
    const preparation = preparations.current.get(id);
    if (!download?.jobId || !['ready', 'handedOff'].includes(download.status) ||
        !preparation || preparation.cancelled || preparation.saving) return;
    const previousStatus = download.status;
    preparation.saving = true;
    setDownloads(prev => prev.map(d => d.id === id ? { ...d, status: 'sending' } : d));
    try {
      if (!await savePreparedFile(download.jobId, () => preparation.cancelled)) return;
      preparation.handedOff = true;
      setDownloads(prev => prev.map(d => d.id === id ? { ...d, status: 'handedOff', error: undefined } : d));
    } catch (error: any) {
      const status = error.response?.status;
      setDownloads(prev => prev.map(d => d.id === id ? { ...d,
        status: status === 404 || status === 410 ? 'error' : previousStatus,
        error: status === 409 ? 'A transfer is still running. Wait for it to finish or cancel it in your browser, then retry.'
          : error.response?.data?.error || 'Could not start the download. Try again.' } : d));
    } finally {
      preparation.saving = false;
    }
  };

  const removeDownload = (id: string) => {
    const preparation = preparations.current.get(id);
    if (preparation) {
      preparation.cancelled = true;
      preparation.discard = !preparation.handedOff && !preparation.ready;
      if (preparation.jobId && !preparation.handedOff && !preparation.ready) void api.cancelPreparedDownload(preparation.jobId).catch(() => undefined);
      preparations.current.delete(id);
    }
    setDownloads((prev) => prev.filter((d) => d.id !== id));
  };

  return (
    <DownloadContext.Provider value={{ downloads, startDownload, savePreparedDownload, removeDownload }}>
      {children}
    </DownloadContext.Provider>
  );
};
