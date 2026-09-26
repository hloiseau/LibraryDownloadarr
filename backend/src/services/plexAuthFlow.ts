import { randomBytes } from 'crypto';
import { checkPlexConnection, normalizePlexUrl } from './plexConnection';
export { normalizePlexUrl } from './plexConnection';
import { PlexAuthResponse, PlexService } from './plexService';
import { DownloadError } from './downloadService';

type Provider = Pick<PlexService, 'generatePin' | 'checkPin' | 'getUserServers'>;
interface Flow { pinId: number; sessionId?: string; expires: number; auth?: PlexAuthResponse; servers?: any[]; busy?: boolean }
const enabled = (value: unknown) => value === true || value === 1 || value === '1';
const serverDevice = (server: any) => String(server.provides || '').split(',').includes('server');
export function exactServer(servers: any[], id: string): any {
  const server = servers.find(item => serverDevice(item) && item.clientIdentifier === id);
  if (!server) throw new DownloadError(403, 'Your Plex account does not have access to the configured server.');
  return server;
}
export function serverToken(server: any, accountToken: string): string {
  if (server.accessToken) return server.accessToken;
  if (enabled(server.owned)) return accountToken;
  throw new DownloadError(403, 'Plex did not grant a token for this shared server.');
}
function serverConnections(server: any): { url: string; local: boolean; relay: boolean }[] {
  const entries = server.Connection || server.connections || [];
  const seen = new Set<string>();
  const connections: { url: string; local: boolean; relay: boolean }[] = [];
  for (const entry of Array.isArray(entries) ? entries : [entries]) {
    try {
      const url = normalizePlexUrl(entry.uri);
      if (seen.has(url)) continue;
      seen.add(url);
      connections.push({ url, local: enabled(entry.local), relay: enabled(entry.relay) });
    } catch { /* Ignore unusable resource entries; the owner can enter a URL. */ }
  }
  return connections;
}

export class PlexAuthFlows {
  private flows = new Map<string, Flow>();
  constructor(private provider: Provider, private clientId: string) {}
  async start(sessionId?: string) {
    for (const [id, flow] of this.flows) if (flow.expires < Date.now()) this.flows.delete(id);
    if (this.flows.size >= 100) throw new DownloadError(429, 'Too many sign-in attempts. Try again later.');
    const pin = await this.provider.generatePin(this.clientId);
    const flowId = randomBytes(32).toString('hex');
    this.flows.set(flowId, { pinId: pin.id, sessionId, expires: Date.now() + 5 * 60 * 1000 });
    const query = new URLSearchParams({ clientID: this.clientId, code: pin.code, 'context[device][product]': 'LibraryDownloadarr' });
    return { ...pin, flowId, url: `https://app.plex.tv/auth#?${query}` };
  }
  private get(flowId: string, sessionId?: string): Flow {
    const flow = typeof flowId === 'string' ? this.flows.get(flowId) : undefined;
    if (!flow || flow.expires <= Date.now() || flow.sessionId !== sessionId) {
      throw new DownloadError(400, 'Sign-in expired. Please connect with Plex again.');
    }
    return flow;
  }
  async authorize(flowId: string, sessionId?: string) {
    const flow = this.get(flowId, sessionId);
    if (!flow.auth) {
      const auth = await this.provider.checkPin(flow.pinId, this.clientId);
      if (!auth) return null;
      flow.auth = auth;
      if (flow.sessionId) flow.expires = Date.now() + 15 * 60 * 1000;
    }
    if (!flow.servers) flow.servers = await this.provider.getUserServers(flow.auth.authToken);
    return { auth: flow.auth, servers: flow.servers };
  }
  async ownedServers(flowId: string, sessionId: string) {
    const result = await this.authorize(flowId, sessionId);
    if (!result) return null;
    return result.servers.filter(server => serverDevice(server) && enabled(server.owned)).map(server => ({
      id: server.clientIdentifier, name: server.name || 'Plex server', connections: serverConnections(server),
    }));
  }

  async configure(flowId: string, sessionId: string, id: string, address?: string) {
    const flow = this.get(flowId, sessionId);
    if (flow.busy) throw new DownloadError(409, 'Connection is already being checked.');
    if (!flow.auth || !flow.servers) throw new DownloadError(400, 'Complete Plex sign-in first.');
    const server = exactServer(flow.servers, id);
    if (!enabled(server.owned)) throw new DownloadError(403, 'Connect with the owner of this Plex server.');
    if (typeof address !== 'string' || !address.trim()) throw new DownloadError(400, 'Select a Plex address or enter a custom address.');
    const url = normalizePlexUrl(address.trim());
    if (enabled(server.httpsRequired) && !url.startsWith('https://')) {
      throw new DownloadError(400, 'This Plex server requires HTTPS. Choose one of its advertised HTTPS addresses.');
    }
    const token = serverToken(server, flow.auth.authToken);
    flow.busy = true;
    try {
      // Test exactly the owner's selection. A failure must never switch to
      // another advertised connection or consume the flow needed for retrying.
      const connection = await checkPlexConnection(url, token, id,
        serverConnections(server).some(entry => entry.url === url));
      this.flows.delete(flowId);
      return { ...connection, name: server.name || connection.name };
    } finally { flow.busy = false; }
  }
  consume(flowId: string): void { this.flows.delete(flowId); }
}
