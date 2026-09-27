export interface User {
  id: string;
  username: string;
  email?: string;
  isAdmin: boolean;
}

export interface AuthResponse {
  user: User;
  token: string;
}

export interface Library {
  key: string;
  title: string;
  type: string;
}

export interface MediaItem {
  librarySectionID?: string;
  ratingKey: string;
  key: string;
  title: string;
  type: string;
  year?: number;
  thumb?: string;
  art?: string;
  summary?: string;
  rating?: number;
  duration?: number;
  addedAt?: number;
  updatedAt?: number;
  originallyAvailableAt?: string;
  studio?: string;
  contentRating?: string;
  // Episode/Season/Track context fields
  grandparentTitle?: string; // Show name for episodes, Artist for tracks
  parentTitle?: string; // Season name for episodes, Album for tracks
  index?: number; // Episode number or Track number
  parentIndex?: number; // Season number
  Media?: MediaPart[];
}

export interface MediaPart {
  id: number;
  duration: number;
  bitrate: number;
  width: number;
  height: number;
  aspectRatio: number;
  videoCodec: string;
  videoResolution: string;
  container: string;
  videoFrameRate: string;
  Part: Part[];
}

export interface Part {
  id: number;
  key: string;
  duration: number;
  file: string;
  size: number;
  container: string;
}

export interface PlexPin {
  flowId: string;
  id: number;
  code: string;
  url: string;
}

export interface Settings {
  plexUrl: string;
  hasPlexToken: boolean;
  plexMachineId?: string;
  plexServerName?: string;
}

export type DownloadQuality = 'original' | '720p-2' | '720p-4' | '1080p-8';
export type PreparationStage = 'deciding' | 'waiting' | 'processing' | 'finalizing' | 'ready';
export interface PreparedDownload {
  id: string;
  title: string;
  ratingKey: string;
  createdAt: number;
  season: boolean;
  filename: string;
  quality: Exclude<DownloadQuality, 'original'>;
  state: 'preparing' | 'ready' | 'sending' | 'error';
  readyCount: number;
  fileCount: number;
  stage: PreparationStage;
  progress: number | null;
  error?: string;
  expiresAt: number;
  reused?: boolean;
}

export interface DownloadHistoryEntry {
  id: string;
  media_key: string;
  media_title: string;
  file_size: number | null;
  downloaded_at: number;
  quality: DownloadQuality | null;
  transfer_status: 'recorded' | 'requested' | 'transferred';
}

export interface PlexServerChoice {
  id: string;
  name: string;
  connections: { url: string; local: boolean; relay?: boolean }[];
}
export interface DownloadPolicy {
  enabled: boolean;
  libraries: string[] | null;
  qualities: DownloadQuality[];
  serverId: string;
}
export interface PermissionUser {
  id: string;
  username: string;
  custom: boolean;
  policy: DownloadPolicy;
}
