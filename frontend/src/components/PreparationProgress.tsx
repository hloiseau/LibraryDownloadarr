import React, { useEffect, useState } from 'react';
import { PreparationStage } from '../types';

export const preparationLabel = (stage?: PreparationStage) => ({
  deciding: 'Preparing conversion…',
  waiting: 'Waiting for Plex…',
  processing: 'Converting with Plex…',
  finalizing: 'Finalizing file…',
  ready: 'Converted file ready',
}[stage || 'deciding']);

export const ProgressBar: React.FC<{ progress: number | null; label: string; complete?: boolean }> = ({ progress, label, complete }) => {
  const value = progress !== null && Number.isFinite(progress) ? Math.max(0, Math.min(100, progress)) : null;
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={value ?? undefined} aria-valuetext={value === null ? 'In progress' : `${value}%`}
      className="w-full h-2 bg-dark-200 rounded-full overflow-hidden">
      <div className={`h-full rounded-full ${complete ? 'bg-green-400' : 'bg-gradient-to-r from-primary-500 to-primary-400'} ${value === null
        ? 'w-1/3 animate-preparation motion-reduce:animate-none' : 'transition-[width] duration-500 motion-reduce:transition-none'}`}
        style={value === null ? undefined : { width: `${value}%` }} />
    </div>
  );
};

export const PreparationProgress: React.FC<{
  stage?: PreparationStage; progress?: number | null; readyCount?: number; fileCount?: number; startedAt: number;
}> = ({ stage = 'deciding', progress, readyCount = 0, fileCount = 1, startedAt }) => {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (stage === 'ready') return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [stage]);
  const complete = stage === 'ready';
  const value = complete ? 100 : typeof progress === 'number' && Number.isFinite(progress)
    ? Math.max(0, Math.min(99, Math.floor(progress))) : null;
  const active = stage === 'processing' || stage === 'finalizing';
  // Animate a waiting/starting single-file job instead of leaving an empty bar.
  const displayed = !complete && !active && value === 0 ? null : value;
  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000));
  const elapsedText = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
  const label = preparationLabel(stage);
  return (
    <div className="space-y-2">
      <div className={`flex items-center justify-between gap-2 text-xs ${complete ? 'text-green-400' : 'text-primary-400'}`}>
        <span role="status">{label}</span>
        {displayed !== null && <span className="font-semibold tabular-nums">{displayed}%</span>}
      </div>
      <ProgressBar progress={displayed} label="File preparation" complete={complete} />
      <div className="flex items-center justify-between gap-2 text-xs text-gray-400">
        {fileCount > 1 && <span>{readyCount} / {fileCount} files ready</span>}
        {!complete && <span className="tabular-nums">Elapsed {elapsedText}</span>}
      </div>
      {!complete && <p className="text-xs text-gray-400">{active && value === null
        ? 'Plex is converting; the percentage is not available yet.'
        : 'You can close this page. Find the file in Downloads when it is ready.'}</p>}
    </div>
  );
};
