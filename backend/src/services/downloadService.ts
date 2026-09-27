import axios, { AxiosInstance } from 'axios';
import { randomUUID } from 'crypto';
import { Readable } from 'stream';

export const DOWNLOAD_PROFILES = {
  '720p-2': { label: '720p · 2 Mbps', width: 1280, height: 720, bitrate: 2000 },
  '720p-4': { label: '720p · 4 Mbps', width: 1280, height: 720, bitrate: 4000 },
  '1080p-8': { label: '1080p · 8 Mbps', width: 1920, height: 1080, bitrate: 8000 },
} as const;
export type DownloadQuality = keyof typeof DOWNLOAD_PROFILES;
export interface DownloadCredentials {
  serverUrl: string; token: string;
  authorize?: (quality: DownloadQuality, metadata: any, container: any) => void;
}
export interface DownloadRequest { ratingKey: string; quality: DownloadQuality; partKey?: string; season?: boolean }
export class DownloadError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
type PreparationStage = 'deciding' | 'waiting' | 'processing' | 'finalizing' | 'ready';
interface QueueFile {
  id: number; ratingKey: string; filename: string; verified: boolean; maxBytes?: number; missingCount?: number;
  durationMs?: number;
  stage: 'deciding' | 'waiting' | 'processing' | 'available';
  progress: number | null;
  sourceSignature: string;
}
interface DownloadJob {
  id: string;
  owner: string;
  quality: DownloadQuality;
  title: string;
  ratingKey: string;
  filename: string;
  client: AxiosInstance;
  serverUrl: string;
  queueId: number;
  files: QueueFile[];
  readyCount: number;
  state: 'preparing' | 'ready' | 'sending' | 'error';
  error?: string;
  expiresAt: number;
  refreshing?: Promise<void>;
  transfer?: AbortController;
  cacheKey: string;
  lastUsedAt: number;
  retained: boolean;
  season: boolean;
  removing?: Promise<void>;
}
export interface DownloadSnapshot {
  id: string;
  quality: DownloadQuality;
  filename: string;
  state: DownloadJob['state'];
  readyCount: number;
  fileCount: number;
  stage: PreparationStage;
  progress: number | null;
  error?: string;
  expiresAt: number;
  reused?: boolean;
}

function transcodeProgress(entry: any): number | null {
  // These fields belong to the authenticated queue item. Never query all
  // server sessions or borrow an administrator token for progress reporting.
  const value = entry.TranscodeSession ?? entry.transcode;
  const session = Array.isArray(value) ? value[0] : value;
  const raw = session?.progress;
  if (typeof raw !== 'number' && (typeof raw !== 'string' || raw.trim() === '')) return null;
  const progress = Number(raw);
  return Number.isFinite(progress) && progress >= 0 && progress <= 100 ? progress : null;
}

// Match the existing admin/user credential policy without ever borrowing the
// server owner's token for a shared user.
export function downloadCredentials(
  getSetting: (key: string) => string | null | undefined,
  user: { isAdmin: boolean; plexToken?: string }
): DownloadCredentials {
  const serverUrl = getSetting('plex_url');
  const token = user.plexToken || (user.isAdmin ? getSetting('plex_token') : undefined);
  if (!serverUrl || !token) throw new DownloadError(403, 'Plex access unavailable. Please sign in again or contact the administrator.');
  return { serverUrl, token };
}

// Plex can include paths or credentials in diagnostic text. Only expose known
// decision fields; never serialize an Axios request, headers, or raw response.
const plexDecision = (value: any) => Array.isArray(value?.DecisionResult)
  ? value.DecisionResult[0] : value?.DecisionResult || value;

export function plexDecisionSummary(value: any, secrets: string[] = []): string {
  const decision = plexDecision(value);
  if (!decision || typeof decision !== 'object') return '';
  const clean = (text: string) => {
    for (const secret of secrets.filter(Boolean)) text = text.split(secret).join('[redacted]').split(encodeURIComponent(secret)).join('[redacted]');
    return text.replace(/https?:\/\/[^\s<>"']+/gi, '[URL]')
      .replace(/((?:X-Plex-Token|authToken|accessToken|token)\s*[=:]\s*)[^\s&;,]+/gi, '$1[redacted]')
      .replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 240);
  };
  return ['transcode', 'general', 'directPlay', 'directStream'].flatMap(kind => {
    const code = decision[`${kind}DecisionCode`];
    const text = decision[`${kind}DecisionText`];
    if (!Number.isInteger(Number(code)) || code === undefined || Number(code) < 0 || Number(code) > 99999) return [];
    return [`${kind} ${Number(code)}${typeof text === 'string' && text ? `: ${clean(text)}` : ''}`];
  }).join('; ').slice(0, 700);
}

export function downloadFailure(error: unknown): DownloadError {
  if (error instanceof DownloadError) return error;
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    if (status === 401 || status === 403) return new DownloadError(403, 'Plex denied this download. Check your account access, download permission and Plex download entitlement.');
    if (status === 404 || status === 405) return new DownloadError(502, 'Plex could not find this download or does not support Download Queue. Plex Media Server 1.41.9 or newer is required.');
    const details = plexDecisionSummary(error.response?.data?.MediaContainer, [String(error.config?.headers?.['X-Plex-Token'] || '')]);
    if (details) return new DownloadError(502, `Plex refused preparation: ${details}`);
    if (status === 503) return new DownloadError(503, 'Plex is still preparing the file. Please try again.');
  }
  // Axios errors include request headers and tokens: never return or log them.
  return new DownloadError(502, 'Unable to prepare the download on Plex. No original file was downloaded.');
}

const denied = (value: unknown) => value === false || value === 0 || value === '0';
const positiveId = (value: unknown): number => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new DownloadError(502, 'Plex returned an invalid download response.');
  return n;
};
const safeFilename = (value: string) => value.replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_').slice(0, 150) || 'download';
const sourceSignature = (metadata: any): string => JSON.stringify((metadata.Media || []).map((media: any) =>
  [media.id, (media.Part || []).map((part: any) => [part.id, part.key, part.size, part.duration,
    (part.Stream || []).filter((stream: any) => [2, 3].includes(Number(stream.streamType)))
      .map((stream: any) => [stream.id, stream.streamType, stream.selected])])]
));
const normalizeServer = (value: string) => {
  const url = new URL(value.includes('://') ? value : `http://${value}`);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new DownloadError(400, 'Invalid configured Plex server URL.');
  }
  if (!url.port && !value.includes('://')) url.port = '32400';
  return url.toString().replace(/\/$/, '');
};

// A separate client per job avoids the mutable global Plex connection used by
// older routes. Redirects are disabled so Plex tokens stay on the configured host.
function plexClient(credentials: DownloadCredentials, clientId: string): AxiosInstance {
  return axios.create({
    baseURL: normalizeServer(credentials.serverUrl), timeout: 30000, maxRedirects: 0,
    headers: {
      Accept: 'application/json', 'X-Plex-Token': credentials.token,
      'X-Plex-Client-Identifier': `librarydownloadarr-${clientId}`,
      'X-Plex-Product': 'LibraryDownloadarr', 'X-Plex-Pms-Api-Version': '1.0',
      // PMS loads <name>.xml. Linux ships Generic.xml; lowercase "generic"
      // has no matching profile and fails with decision code 2004.
      'X-Plex-Client-Profile-Name': 'Generic',
    },
  });
}

function checkPermission(container: any, metadata?: any): void {
  if (denied(container?.allowSync) || denied(metadata?.allowSync)) {
    throw new DownloadError(403, 'Downloads are disabled for your Plex account.');
  }
}

// Check the output decision, not the source file's resolution. Fail closed if
// PMS ignores the quality/profile or offers a playlist/original file instead.
export function verifyDecision(container: any, quality: DownloadQuality): void {
  checkPermission(container);
  const profile = DOWNLOAD_PROFILES[quality];
  const metadata = container?.Metadata?.[0];
  checkPermission(container, metadata);
  const media = metadata?.Media?.find((m: any) => m.selected === true || m.selected === 1 || m.selected === '1') || metadata?.Media?.[0];
  const part = media?.Part?.find((p: any) => p.selected === true || p.selected === 1 || p.selected === '1') || media?.Part?.[0];
  const video = part?.Stream?.find((s: any) => Number(s.streamType) === 1);
  const width = Number(video?.width ?? part?.width ?? media?.width);
  const height = Number(video?.height ?? part?.height ?? media?.height);
  const bitrate = Number(video?.bitrate);
  // Static MP4 decisions on PMS 1.43 omit protocol. If present it must still
  // be HTTP; the verified MP4 container and transfer content type stay required.
  const protocol = part?.protocol ?? media?.protocol;
  if (part?.decision !== 'transcode' || video?.decision !== 'transcode' ||
      (part?.container ?? media?.container) !== 'mp4' ||
      (protocol !== undefined && protocol !== 'http') || video?.codec !== 'h264' ||
      !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 ||
      width > profile.width || height > profile.height ||
      !Number.isFinite(bitrate) || bitrate <= 0 || bitrate > profile.bitrate * 1.25) {
    throw new DownloadError(502, 'Plex did not confirm the requested MP4 quality. The download was stopped to avoid serving the original file.');
  }
}

export class DownloadService {
  private jobs = new Map<string, DownloadJob>();
  private reservations = new Map<string, number>();
  private creations = new Map<string, Promise<DownloadSnapshot>>();
  private reservationLock = Promise.resolve();
  private timer: NodeJS.Timeout;
  constructor(private ttlMs = 24 * 60 * 60 * 1000, private cacheTtlMs = 6 * 60 * 60 * 1000) {
    this.timer = setInterval(() => { void this.sweep(); }, 60000);
    this.timer.unref();
  }

  private snapshot(job: DownloadJob): DownloadSnapshot {
    const complete = job.state === 'ready' || job.state === 'sending';
    const processing = job.files.filter(file => file.stage === 'processing');
    const stage: PreparationStage = complete ? 'ready' : processing.length
      ? processing.every(file => file.progress === 100) ? 'finalizing' : 'processing'
      : job.files.some(file => file.stage === 'waiting') ? 'waiting' : 'deciding';
    // Weight season progress by duration when every duration is known. If an
    // active item's progress is missing, leave the bar indeterminate.
    const weighted = job.files.every(file => file.durationMs !== undefined);
    const weight = (file: QueueFile) => weighted ? file.durationMs! : 1;
    const progress = complete ? 100 : job.files.some(file => file.progress === null) ? null
      : Math.min(99, Math.floor(job.files.reduce((sum, file) => sum + file.progress! * weight(file), 0) /
          job.files.reduce((sum, file) => sum + weight(file), 0)));
    return { id: job.id, quality: job.quality, filename: job.filename, state: job.state,
      readyCount: job.readyCount, fileCount: job.files.length, stage, progress, error: job.error, expiresAt: job.expiresAt };
  }
  private owned(id: string, owner: string): DownloadJob {
    const job = this.jobs.get(id);
    if (!job || job.owner !== owner || job.removing || (job.state !== 'sending' && job.expiresAt <= Date.now())) {
      throw new DownloadError(404, 'Download expired or not found. Please prepare it again.');
    }
    return job;
  }
  private authorize(job: DownloadJob, credentials: DownloadCredentials): void {
    if (job.serverUrl !== normalizeServer(credentials.serverUrl)) throw new DownloadError(409, 'Plex server changed. Please prepare the download again.');
    job.client.defaults.headers['X-Plex-Token'] = credentials.token;
  }

  async create(owner: string, credentials: DownloadCredentials, input: DownloadRequest): Promise<DownloadSnapshot> {
    if (!input || typeof input.ratingKey !== 'string' || !/^\d+$/.test(input.ratingKey) ||
        typeof input.quality !== 'string' || !Object.prototype.hasOwnProperty.call(DOWNLOAD_PROFILES, input.quality) ||
        (input.partKey !== undefined && typeof input.partKey !== 'string') ||
        (input.season !== undefined && typeof input.season !== 'boolean')) {
      throw new DownloadError(400, 'Choose a supported quality and media item.');
    }
    const key = JSON.stringify([owner, normalizeServer(credentials.serverUrl), input.ratingKey,
      input.quality, !!input.season, input.season ? null : input.partKey || null]);
    const pending = this.creations.get(key);
    if (pending) return pending;
    const creation = this.createOrReuse(owner, credentials, input, key);
    this.creations.set(key, creation);
    try { return await creation; }
    finally { this.creations.delete(key); }
  }

  private async createOrReuse(owner: string, credentials: DownloadCredentials, input: DownloadRequest, key: string): Promise<DownloadSnapshot> {
    const cached = [...this.jobs.values()].find(job => job.cacheKey === key && !job.removing &&
      job.state !== 'error' && (job.expiresAt > Date.now() || job.state === 'sending'));
    if (cached) {
      this.authorize(cached, credentials);
      const unchanged = await this.checkAccess(cached, credentials);
      let available = unchanged;
      if (unchanged && cached.state === 'ready') {
        try { await this.checkAvailable(cached); }
        catch (error) {
          if (!(error instanceof DownloadError) || error.status !== 410) throw downloadFailure(error);
          available = false;
        }
      }
      if (available && !cached.removing && (cached.expiresAt > Date.now() || cached.state === 'sending')) {
        cached.lastUsedAt = Date.now();
        return { ...this.snapshot(cached), reused: true };
      }
      if (cached.state === 'sending') throw new DownloadError(409, 'A transfer is still running. Wait for it to finish.');
      await this.remove(cached);
    }
    await this.reserve(owner);
    const id = randomUUID();
    const client = plexClient(credentials, id);
    let queueId: number | undefined;
    try {
      const { data } = await client.get(`/library/metadata/${input.ratingKey}`);
      const container = data.MediaContainer;
      const root = container?.Metadata?.[0];
      if (!root) throw new DownloadError(404, 'Media unavailable for your Plex account.');
      checkPermission(container, root);
      credentials.authorize?.(input.quality, root, container);
      let items = [root];
      if (input.season) {
        if (root.type !== 'season') throw new DownloadError(400, 'Select a season.');
        const response = await client.get(`/library/metadata/${input.ratingKey}/children`, {
          headers: { 'X-Plex-Container-Start': '0', 'X-Plex-Container-Size': '101' },
        });
        checkPermission(response.data.MediaContainer);
        items = response.data.MediaContainer?.Metadata || [];
        const total = Number(response.data.MediaContainer?.totalSize ?? items.length);
        if (!items.length || total !== items.length || items.length > 100) {
          throw new DownloadError(400, 'This season is empty or too large. Download individual episodes instead.');
        }
        // Children responses may omit streams. Capture source/selection details
        // from the same metadata endpoint used by later reuse and transfer checks.
        for (let index = 0; index < items.length; index++) {
          const key = String(items[index].ratingKey);
          if (!/^\d+$/.test(key)) throw new DownloadError(502, 'Plex returned an invalid episode.');
          const episode = await client.get(`/library/metadata/${key}`);
          const metadata = episode.data.MediaContainer?.Metadata?.[0];
          if (!metadata) throw new DownloadError(403, 'An episode is no longer available.');
          checkPermission(episode.data.MediaContainer, metadata);
          credentials.authorize?.(input.quality, metadata, episode.data.MediaContainer);
          items[index] = metadata;
        }
      }
      for (const item of items) {
        checkPermission({}, item);
        credentials.authorize?.(input.quality, item, { librarySectionID: root.librarySectionID ?? container.librarySectionID });
        if (!['movie', 'episode'].includes(item.type) || !/^\d+$/.test(String(item.ratingKey)) || !item.Media?.length) {
          throw new DownloadError(400, 'Quality selection supports movies and episodes with available media.');
        }
      }
      let mediaIndex = 0;
      let partIndex = -1;
      if (!input.season && input.partKey) {
        mediaIndex = root.Media.findIndex((m: any) => m.Part?.some((p: any) => p.key === input.partKey));
        if (mediaIndex < 0) throw new DownloadError(400, 'Selected file does not belong to this media item.');
        partIndex = root.Media[mediaIndex].Part.findIndex((p: any) => p.key === input.partKey);
      }
      const queue = await client.post('/downloadQueue');
      queueId = positiveId(queue.data.MediaContainer?.DownloadQueue?.[0]?.id);
      const profile = DOWNLOAD_PROFILES[input.quality];
      const added = await client.post(`/downloadQueue/${queueId}/add`, null, { params: {
        keys: items.map(item => `/library/metadata/${item.ratingKey}`).join(','),
        'X-Plex-Client-Profile-Extra': ['static', 'streaming'].map(context =>
          `add-transcode-target(type=videoProfile&context=${context}&protocol=http&container=mp4&videoCodec=h264&audioCodec=aac&replace=true)`
        ).join('+'),
        mediaIndex, partIndex, protocol: 'http', directPlay: 0, directStream: 0, directStreamAudio: 0,
        videoBitrate: profile.bitrate, videoResolution: `${profile.width}x${profile.height}`,
        audioChannelCount: 2, subtitles: 'burn', advancedSubtitles: 'burn', autoAdjustQuality: 0,
      } });
      const addedItems = added.data.MediaContainer?.AddedQueueItems;
      if (!Array.isArray(addedItems) || addedItems.length !== items.length) throw new DownloadError(502, 'Plex did not queue all requested files.');
      const files: QueueFile[] = items.map(item => {
        const queued = addedItems.find((entry: any) => entry.key === `/library/metadata/${item.ratingKey}`);
        const name = item.type === 'episode'
          ? `${item.grandparentTitle || root.parentTitle || 'Show'} - S${String(item.parentIndex ?? root.index ?? 0).padStart(2, '0')}E${String(item.index ?? 0).padStart(2, '0')} - ${item.title}`
          : item.title;
        const durationMs = Number(!input.season && partIndex >= 0
          ? item.Media[mediaIndex]?.Part?.[partIndex]?.duration || item.duration : item.duration);
        // Generous VBR/audio/container allowance, but never accept a 50-GB
        // original in place of a short, low-bitrate conversion.
        const maxBytes = durationMs > 0
          ? durationMs / 1000 * (profile.bitrate * 1.5 + 512) * 1000 / 8 + 8 * 1024 * 1024 : undefined;
        return { id: positiveId(queued?.id), ratingKey: String(item.ratingKey), verified: false, maxBytes,
          durationMs: Number.isFinite(durationMs) && durationMs > 0 ? durationMs : undefined,
          stage: 'deciding', progress: 0, sourceSignature: sourceSignature(item),
          filename: `${safeFilename(name)} - ${input.quality}.mp4` };
      });
      if (new Set(files.map(file => file.id)).size !== files.length) throw new DownloadError(502, 'Plex returned duplicate queue items.');
      const job: DownloadJob = { id, owner, client, quality: input.quality, title: root.title,
        ratingKey: input.ratingKey, serverUrl: normalizeServer(credentials.serverUrl), queueId, files,
        filename: input.season ? `${safeFilename(`${root.parentTitle || 'Show'} - ${root.title}`)} - ${input.quality}.zip` : files[0].filename,
        state: 'preparing', readyCount: 0, expiresAt: Date.now() + this.ttlMs,
        cacheKey: key, lastUsedAt: Date.now(), retained: false, season: !!input.season };
      this.jobs.set(id, job);
      return this.snapshot(job);
    } catch (error) {
      if (queueId) await this.clearQueue(client, queueId);
      throw downloadFailure(error);
    } finally {
      const count = (this.reservations.get(owner) || 1) - 1;
      if (count) this.reservations.set(owner, count); else this.reservations.delete(owner);
    }
  }

  private async reserve(owner: string): Promise<void> {
    // Eviction awaits Plex cleanup. Serialize reservations so simultaneous
    // requests cannot reuse the same free slot or evict an active transfer.
    const previous = this.reservationLock;
    let unlock!: () => void;
    this.reservationLock = new Promise<void>(resolve => { unlock = resolve; });
    await previous;
    try {
      await this.sweep();
      while (true) {
        const pending = [...this.reservations.values()].reduce((sum, n) => sum + n, 0);
        const ownFull = [...this.jobs.values()].filter(j => j.owner === owner).length +
          (this.reservations.get(owner) || 0) >= 2;
        if (!ownFull && this.jobs.size + pending < 8) break;
        const oldest = [...this.jobs.values()].filter(j => !j.removing &&
          (j.state === 'ready' || j.state === 'error') && (!ownFull || j.owner === owner))
          .sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
        if (!oldest) throw new DownloadError(429, 'Download queue is full. Finish or cancel an existing download first.');
        await this.remove(oldest);
      }
      this.reservations.set(owner, (this.reservations.get(owner) || 0) + 1);
    } finally { unlock(); }
  }

  private async checkAccess(job: DownloadJob, credentials: DownloadCredentials, signal?: AbortSignal): Promise<boolean> {
    let unchanged = true;
    if (job.season) {
      const response = await job.client.get(`/library/metadata/${job.ratingKey}/children`, {
        signal, headers: { 'X-Plex-Container-Start': '0', 'X-Plex-Container-Size': '101' },
      });
      checkPermission(response.data.MediaContainer);
      const episodes = response.data.MediaContainer?.Metadata;
      unchanged = Array.isArray(episodes) && Number(response.data.MediaContainer.totalSize ?? episodes.length) === job.files.length &&
        episodes.length === job.files.length && job.files.every(file => episodes.some((item: any) => String(item.ratingKey) === file.ratingKey));
    }
    for (const file of job.files) {
      const result = await job.client.get(`/library/metadata/${file.ratingKey}`, { signal });
      const metadata = result.data.MediaContainer?.Metadata?.[0];
      if (!metadata) throw new DownloadError(403, 'Media access has been removed.');
      checkPermission(result.data.MediaContainer, metadata);
      credentials.authorize?.(job.quality, metadata, result.data.MediaContainer);
      unchanged = unchanged && file.sourceSignature === sourceSignature(metadata);
    }
    return unchanged;
  }

  private async checkAvailable(job: DownloadJob, signal?: AbortSignal): Promise<void> {
    try {
      const response = await job.client.get(`/downloadQueue/${job.queueId}/items/${job.files.map(f => f.id).join(',')}`, { signal });
      const items = response.data.MediaContainer?.DownloadQueueItem;
      if (!Array.isArray(items)) throw new DownloadError(502, 'Plex returned an invalid queue status.');
      if (!job.files.every(file => items.some((item: any) => Number(item.id) === file.id && item.status === 'available'))) {
        throw new DownloadError(410, 'The prepared file is no longer available on Plex. Prepare the download again.');
      }
    } catch (error) {
      if (axios.isAxiosError(error) && [404, 410].includes(error.response?.status || 0)) {
        throw new DownloadError(410, 'The prepared file expired on Plex. Prepare the download again.');
      }
      throw error;
    }
  }

  async status(id: string, owner: string, credentials: DownloadCredentials): Promise<DownloadSnapshot> {
    const job = this.owned(id, owner);
    this.authorize(job, credentials);
    if (job.state === 'preparing') {
      if (!job.refreshing) job.refreshing = this.refresh(job).finally(() => { job.refreshing = undefined; });
      await job.refreshing;
    }
    return this.snapshot(job);
  }
  private async refresh(job: DownloadJob): Promise<void> {
    try {
      const result = await job.client.get(`/downloadQueue/${job.queueId}/items/${job.files.map(f => f.id).join(',')}`);
      const entries = result.data.MediaContainer?.DownloadQueueItem;
      if (!Array.isArray(entries)) throw new DownloadError(502, 'Plex returned an invalid queue status.');
      let ready = 0;
      for (const file of job.files) {
        const entry = entries.find((item: any) => Number(item.id) === file.id);
        if (!entry) {
          file.stage = 'deciding';
          file.progress = null;
          file.missingCount = (file.missingCount || 0) + 1;
          if (file.missingCount < 4) continue;
          throw new DownloadError(502, 'Plex no longer lists this file in its download queue. Prepare the download again.');
        }
        file.missingCount = 0;
        if (entry.status === 'expired') throw new DownloadError(410, 'Plex expired the prepared file. Prepare the download again.');
        if (entry.status === 'error') {
          const secrets = [String(job.client.defaults.headers['X-Plex-Token'] || '')];
          let decisionPayload = entry;
          let detail = plexDecisionSummary(entry, secrets);
          if (!detail) {
            try {
              const decision = await job.client.get(`/downloadQueue/${job.queueId}/item/${file.id}/decision`);
              decisionPayload = decision.data.MediaContainer;
              detail = plexDecisionSummary(decision.data.MediaContainer, secrets);
            } catch (error) {
              if (axios.isAxiosError(error)) {
                decisionPayload = error.response?.data?.MediaContainer;
                detail = plexDecisionSummary(decisionPayload, secrets);
              }
            }
          }
          let version = '';
          try {
            const identity = await job.client.get('/identity');
            const value = identity.data.MediaContainer?.version;
            if (typeof value === 'string' && /^[a-zA-Z0-9.\-]{1,60}$/.test(value)) version = `, PMS ${value}`;
          } catch { /* Diagnostic lookup must not hide the queue failure. */ }
          const decision = plexDecision(decisionPayload);
          if (Number(decision?.generalDecisionCode) === 1001 &&
              (decision?.transcodeDecisionCode === undefined || [1000, 1001].includes(Number(decision.transcodeDecisionCode)))) {
            // A successful decision is only a plan. The queue's error state
            // still wins; directPlay=0 is intentional and is not the failure.
            throw new DownloadError(502, `Plex approved conversion but failed to create the file (${job.quality}${version}). ` +
              `The decision response does not explain this failure. Check Plex Media Server logs near ${new Date().toISOString()} ` +
              `(queue ${job.queueId}, item ${file.id}).`);
          }
          throw new DownloadError(502, `Plex download failed (status error${version}, ${job.quality}). ${detail || 'Plex supplied no decision reason. Check the Plex Media Server logs at the time of this download.'}`);
        }
        if (entry.status === 'available') {
          if (!file.verified) {
            const result = await job.client.get(`/downloadQueue/${job.queueId}/item/${file.id}/decision`);
            verifyDecision(result.data.MediaContainer, job.quality);
            file.verified = true;
          }
          ready++;
          file.stage = 'available';
          file.progress = 100;
        } else if (!['deciding', 'waiting', 'processing'].includes(entry.status)) {
          throw new DownloadError(502, 'Plex returned an unsupported download state.');
        } else {
          file.stage = entry.status;
          file.progress = entry.status === 'processing' ? transcodeProgress(entry) : 0;
        }
      }
      job.readyCount = ready;
      if (ready === job.files.length) {
        job.state = 'ready';
        if (!job.retained) {
          job.retained = true;
          job.expiresAt = Date.now() + this.cacheTtlMs;
          job.lastUsedAt = Date.now();
        }
      }
    } catch (error) {
      job.state = 'error';
      job.error = downloadFailure(error).message;
      await this.clearQueue(job.client, job.queueId);
    }
  }

  async beginTransfer(id: string, owner: string, credentials: DownloadCredentials): Promise<{
    filename: string; title: string; ratingKey: string; files: QueueFile[];
    open: (file: QueueFile) => Promise<{ stream: Readable; size?: number }>;
    abort: () => void;
    finish: () => Promise<void>;
  }> {
    const job = this.owned(id, owner);
    this.authorize(job, credentials);
    if (job.state !== 'ready') throw new DownloadError(409, job.error || 'Download is not ready or already in progress.');
    // Claim the job before awaiting so two tickets cannot start two transfers.
    job.state = 'sending';
    const transfer = new AbortController();
    job.transfer = transfer;
    job.lastUsedAt = Date.now();
    try {
      // Re-check every item's visibility and permissions when handing out bytes.
      // A permission change while a long conversion runs must take effect here.
      if (!await this.checkAccess(job, credentials, transfer.signal)) {
        throw new DownloadError(409, 'The source media changed. Prepare the download again.');
      }
      await this.checkAvailable(job, transfer.signal);
      for (const file of job.files) {
        const decision = await job.client.get(`/downloadQueue/${job.queueId}/item/${file.id}/decision`, { signal: transfer.signal });
        verifyDecision(decision.data.MediaContainer, job.quality);
      }
    } catch (error) {
      const safe = downloadFailure(error);
      transfer.abort();
      job.transfer = undefined;
      if (!job.removing && this.jobs.get(job.id) === job) {
        // A temporary PMS connection failure must not destroy a good conversion.
        if (axios.isAxiosError(error) && (!error.response || error.response.status >= 500)) job.state = 'ready';
        else {
          job.state = 'error';
          job.error = safe.message;
          await this.clearQueue(job.client, job.queueId);
        }
      }
      throw safe;
    }
    return {
      filename: job.filename, title: job.title, ratingKey: job.ratingKey, files: job.files,
      abort: () => transfer.abort(),
      finish: async () => {
        // Each finalizer belongs to one attempt. An old response must never
        // release or cancel a newer retry of the same retained job.
        if (job.transfer !== transfer) return;
        transfer.abort();
        job.transfer = undefined;
        if (job.removing || this.jobs.get(job.id) !== job) return;
        if (job.expiresAt <= Date.now() || job.state === 'error') await this.remove(job);
        else { job.state = 'ready'; job.lastUsedAt = Date.now(); }
      },
      open: async (file: QueueFile) => {
        const response = await job.client.get<Readable>(`/downloadQueue/${job.queueId}/item/${file.id}/media`, {
          responseType: 'stream', signal: transfer.signal, headers: { Accept: 'video/mp4, application/octet-stream' },
        }).catch(error => {
          if (axios.isAxiosError(error)) {
            if (job.transfer === transfer && [401, 403, 404, 410].includes(error.response?.status || 0)) job.state = 'error';
            if (error.response?.data instanceof Readable) error.response.data.destroy();
          }
          throw error;
        });
        const type = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (!['video/mp4', 'application/mp4', 'application/octet-stream', 'binary/octet-stream'].includes(type)) {
          response.data.destroy();
          if (job.transfer === transfer) job.state = 'error';
          throw new DownloadError(502, 'Plex returned an unexpected file type. Download stopped.');
        }
        const size = Number(response.headers['content-length']);
        if (file.maxBytes && size > file.maxBytes) {
          response.data.destroy();
          if (job.transfer === transfer) job.state = 'error';
          throw new DownloadError(502, 'Plex returned a file much larger than the selected quality allows. Download stopped.');
        }
        return { stream: response.data, size: Number.isFinite(size) && size > 0 ? size : undefined };
      },
    };
  }
  async cancel(id: string, owner: string): Promise<void> {
    const job = this.owned(id, owner);
    await this.remove(job);
  }
  private async clearQueue(client: AxiosInstance, queueId: number): Promise<void> {
    try {
      // This client ID is unique to this job, so cleanup cannot delete another
      // job or a user's downloads from a different Plex application.
      const response = await client.get(`/downloadQueue/${queueId}/items`);
      const ids = (response.data.MediaContainer?.DownloadQueueItem || []).map((entry: any) => positiveId(entry.id));
      if (ids.length) await client.delete(`/downloadQueue/${queueId}/items/${ids.join(',')}`);
    } catch { /* Plex also expires queue items; do not mask the initial error. */ }
  }
  private async remove(job: DownloadJob): Promise<void> {
    if (!job.removing) job.removing = (async () => {
      job.transfer?.abort();
      // Retain the slot during cleanup to keep cancellation/retry bursts bounded.
      await job.refreshing;
      await this.clearQueue(job.client, job.queueId);
      this.jobs.delete(job.id);
    })();
    await job.removing;
  }
  private async sweep(): Promise<void> {
    await Promise.all([...this.jobs.values()].filter(job => job.state !== 'sending' && job.expiresAt <= Date.now()).map(job => this.remove(job)));
  }
  async close(): Promise<void> {
    clearInterval(this.timer);
    await Promise.all([...this.jobs.values()].map(job => this.remove(job)));
  }
}
