import React, { useEffect, useRef, useState } from 'react';
import { api } from '../services/api';
import { DownloadChoice, DownloadQuality, DownloadStreamOptions } from '../types';

export interface DownloadTarget {
  ratingKey: string; partKey: string; title: string; filename: string; fileSize?: number; season?: boolean;
}
export const DownloadOptionsDialog: React.FC<{
  target: DownloadTarget; initialQuality: DownloadQuality; allowedQualities: DownloadQuality[];
  onClose: () => void; onConfirm: (choice: DownloadChoice) => void;
}> = ({ target, initialQuality, allowedQualities, onClose, onConfirm }) => {
  const dialog = useRef<HTMLDialogElement>(null);
  const submitted = useRef(false);
  const [quality, setQuality] = useState(initialQuality);
  const [audio, setAudio] = useState('plex');
  const [subtitle, setSubtitle] = useState('plex');
  const [loaded, setLoaded] = useState<{ key: string; options: DownloadStreamOptions } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [retry, setRetry] = useState(0);
  const key = JSON.stringify([target.ratingKey, target.partKey, !!target.season, quality, retry]);
  const options = loaded?.key === key ? loaded.options : null;
  const error = failure?.key === key ? failure.message : '';
  const converted = quality !== 'original';

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  useEffect(() => {
    let stopped = false;
    setAudio('plex'); setSubtitle('plex');
    if (quality !== 'original') {
      void api.getDownloadStreamOptions({ ratingKey: target.ratingKey, quality,
        ...(target.season ? { season: true } : { partKey: target.partKey }) }).then(result => {
        if (!stopped) setLoaded({ key, options: result });
      }).catch((err: any) => {
        if (!stopped) setFailure({ key, message: err.response?.data?.error || 'Could not load audio and subtitle tracks. Try again.' });
      });
    }
    return () => { stopped = true; };
  }, [key]);

  const valid = allowedQualities.includes(quality) && (!converted || !!options && !error &&
    options.audio.some(option => option.id === audio) && options.subtitle.some(option => option.id === subtitle));
  const fieldClass = 'w-full rounded-lg border border-dark-50 bg-dark-200 px-3 py-2 text-white';
  return (
    <dialog ref={dialog} onCancel={onClose} aria-labelledby="download-options-title"
      className="m-auto w-[calc(100%-2rem)] max-w-2xl rounded-xl border border-dark-50 bg-dark-100 text-white p-5 md:p-6 backdrop:bg-black/70">
      <form className="space-y-5" onSubmit={event => {
        event.preventDefault();
        if (valid && !submitted.current) {
          submitted.current = true;
          onConfirm(converted ? { quality, audio, subtitle } : { quality });
        }
      }}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="download-options-title" className="text-xl font-semibold">Download options</h2>
            <p className="text-sm text-gray-400 mt-1 break-words">{target.title}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close download options" className="px-2 py-1 text-gray-400 hover:text-white">✕</button>
        </div>
        <div className="grid sm:grid-cols-3 gap-4">
          <label className="text-sm space-y-2"><span className="block">Quality</span>
            <select autoFocus className={fieldClass} value={quality} onChange={event => setQuality(event.target.value as DownloadQuality)}>
              <option value="original" disabled={!allowedQualities.includes('original')}>Original file</option>
              <option value="720p-2" disabled={!allowedQualities.includes('720p-2')}>720p · 2 Mbps</option>
              <option value="720p-4" disabled={!allowedQualities.includes('720p-4')}>720p · 4 Mbps</option>
              <option value="1080p-8" disabled={!allowedQualities.includes('1080p-8')}>1080p · 8 Mbps</option>
            </select>
          </label>
          <label className="text-sm space-y-2"><span className="block">Audio</span>
            <select className={fieldClass} disabled={!converted || !options} value={converted ? audio : 'all'} onChange={event => setAudio(event.target.value)}>
              {!converted ? <option value="all">All original tracks</option> : options
                ? options.audio.map(option => <option key={option.id} value={option.id}>{option.label}</option>)
                : <option value="plex">{error ? 'Unavailable' : 'Loading tracks…'}</option>}
            </select>
          </label>
          <label className="text-sm space-y-2"><span className="block">Subtitles</span>
            <select className={fieldClass} disabled={!converted || !options} value={converted ? subtitle : 'all'} onChange={event => setSubtitle(event.target.value)}>
              {!converted ? <option value="all">Original embedded tracks</option> : options
                ? options.subtitle.map(option => <option key={option.id} value={option.id}>{option.label}</option>)
                : <option value="plex">{error ? 'Unavailable' : 'Loading tracks…'}</option>}
            </select>
          </label>
        </div>
        {converted ? <div className="space-y-2 text-sm text-gray-400">
          <p>The MP4 contains one audio track. Selected subtitles are burned into the video and cannot be turned off later. Choose None for no subtitles.</p>
          {target.season && <p>Only matching tracks available in every episode are listed. Choose Plex selection to use each episode’s current selection.</p>}
          <p>Choosing a track also updates this title’s selection in your Plex account.</p>
        </div> : <p className="text-sm text-gray-400">Downloads the original file with its embedded tracks and original size. Separate subtitle files are not included.</p>}
        {error && <div role="alert" className="text-sm text-red-400">
          <p>{error}</p><button type="button" onClick={() => setRetry(value => value + 1)} className="mt-2 underline">Retry loading tracks</button>
        </div>}
        <div className="flex justify-end gap-3">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={!valid} className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed">
            {converted ? 'Prepare download' : 'Download original'}
          </button>
        </div>
      </form>
    </dialog>
  );
};
