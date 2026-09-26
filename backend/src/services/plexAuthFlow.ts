import { randomBytes } from 'crypto';
import axios from 'axios';
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
export function normalizePlexUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new DownloadError(400, 'Enter a complete HTTP or HTTPS Plex URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new DownloadError(400, 'Invalid Plex server URL.');
  }
  return url.toString().replace(/\/$/, '');
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
    }
    if (!flow.servers) flow.servers = await this.provider.getUserServers(flow.auth.authToken);
    return { auth: flow.auth, servers: flow.servers };
  }
  async ownedServers(flowId: string, sessionId: string) {
    const result = await this.authorize(flowId, sessionId);
    if (!result) return null;
    return result.servers.filter(server => serverDevice(server) && enabled(server.owned)).map(server => {
      const connections = server.Connection || server.connections || [];
      return { id: server.clientIdentifier, name: server.name || 'Plex server',
        connections: (Array.isArray(connections) ? connections : [connections])
          .filter((connection: any) => typeof connection.uri === 'string')
          .map((connection: any) => ({ url: connection.uri, local: enabled(connection.local) })) };
    });
  }
  async configure(flowId: string, sessionId: string, id: string, address: string) {
    const flow = this.get(flowId, sessionId);
    if (flow.busy) throw new DownloadError(409, 'Connection is already being checked.');
    if (!flow.auth || !flow.servers) throw new DownloadError(400, 'Complete Plex sign-in first.');
    const server = exactServer(flow.servers, id);
    if (!enabled(server.owned)) throw new DownloadError(403, 'Connect with the owner of this Plex server.');
    const url = normalizePlexUrl(address);
    const token = serverToken(server, flow.auth.authToken);
    flow.busy = true;
    try {
      // Probe identity without credentials before sending a token to a custom URL.
      const identity = await axios.get(`${url}/identity`, { timeout: 10000, maxRedirects: 0, headers: { Accept: 'application/json' } });
      if (identity.data.MediaContainer?.machineIdentifier !== id) throw new DownloadError(400, 'This address belongs to a different Plex server.');
      await axios.get(`${url}/library/sections`, { timeout: 10000, maxRedirects: 0,
        headers: { Accept: 'application/json', 'X-Plex-Token': token } });
      this.flows.delete(flowId);
      return { url, token, machineId: id, name: server.name || 'Plex server' };
    } finally { flow.busy = false; }
  }
  consume(flowId: string): void { this.flows.delete(flowId); }
}
