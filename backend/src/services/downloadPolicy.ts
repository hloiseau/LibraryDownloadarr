import { DatabaseService } from '../models/database';
import { DOWNLOAD_PROFILES, DownloadError, DownloadQuality } from './downloadService';

export type PolicyQuality = 'original' | DownloadQuality;
export interface DownloadPolicy {
  enabled: boolean;
  libraries: string[] | null;
  qualities: PolicyQuality[];
  serverId: string;
}
type User = { id: string; isAdmin: boolean };
const qualities: PolicyQuality[] = ['original', ...Object.keys(DOWNLOAD_PROFILES) as DownloadQuality[]];
export const policyKey = (id: string) => `download_policy:${id}`;
export function validatePolicy(input: any, serverId: string): DownloadPolicy {
  if (!input || typeof input.enabled !== 'boolean' ||
      !(input.libraries === null || Array.isArray(input.libraries) && input.libraries.every((id: unknown) => typeof id === 'string' && /^\d+$/.test(id))) ||
      !Array.isArray(input.qualities) || !input.qualities.every((quality: PolicyQuality) => qualities.includes(quality))) {
    throw new DownloadError(400, 'Choose valid libraries and download qualities.');
  }
  return { enabled: input.enabled, libraries: input.libraries === null ? null : [...new Set<string>(input.libraries)],
    qualities: [...new Set<PolicyQuality>(input.qualities)], serverId };
}
export function readPolicy(db: DatabaseService, user: User): DownloadPolicy {
  const serverId = db.getSetting('plex_machine_id') || '';
  const unrestricted: DownloadPolicy = { enabled: true, libraries: null, qualities: [...qualities], serverId };
  if (user.isAdmin) return unrestricted;
  const raw = db.getSetting(policyKey(user.id)) || db.getSetting(policyKey('default'));
  if (!raw) return unrestricted;
  try {
    const stored = JSON.parse(raw);
    if (stored.serverId !== serverId) return { ...unrestricted, enabled: false };
    return validatePolicy(stored, serverId);
  } catch { return { ...unrestricted, enabled: false }; }
}
export function assertDownloadPolicy(db: DatabaseService, user: User, quality: PolicyQuality, metadata?: any, container?: any): void {
  const policy = readPolicy(db, user);
  if (!policy.enabled) throw new DownloadError(403, 'Downloads are disabled for your account in LibraryDownloadarr.');
  if (!policy.qualities.includes(quality)) throw new DownloadError(403, 'This download quality is not allowed for your account.');
  if (policy.libraries !== null) {
    const section = String(metadata?.librarySectionID ?? container?.librarySectionID ?? '');
    if (!policy.libraries.includes(section)) throw new DownloadError(403, 'Downloads from this library are not allowed for your account.');
  }
}
