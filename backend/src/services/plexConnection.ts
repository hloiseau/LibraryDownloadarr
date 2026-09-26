import axios from 'axios';
import { parseStringPromise } from 'xml2js';
import { DownloadError } from './downloadService';

export class PlexConnectionError extends DownloadError {
  constructor(public code: string, public stage: string, public url: string, message: string, status = 502) {
    super(status, message);
  }
}
export function normalizePlexUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new DownloadError(400, 'Enter a complete HTTP or HTTPS Plex URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new DownloadError(400, 'Invalid Plex server URL.');
  }
  return url.toString().replace(/\/$/, '');
}
const displayAddress = (url: string) => {
  try { return new URL(url).origin; } catch { return 'Plex'; }
};

// Never expose Axios messages, headers or response bodies: they can contain tokens.
export function plexConnectionFailure(error: unknown, url = '', stage = 'Plex account lookup'): PlexConnectionError {
  if (error instanceof PlexConnectionError) return error;
  const address = displayAddress(url);
  const prefix = `${address}: ${stage} failed`;
  if (axios.isAxiosError(error)) {
    const nested = error.cause as any;
    const code = error.code || nested?.code || nested?.errors?.[0]?.code;
    const status = error.response?.status;
    if (['ENOTFOUND', 'EAI_AGAIN'].includes(code || '')) return new PlexConnectionError(code!, stage, address,
      `${prefix}: DNS could not resolve the hostname (${code}). Check DNS inside the container; plex.direct can be affected by DNS rebinding protection.`);
    if (code === 'ECONNREFUSED') return new PlexConnectionError(code, stage, address,
      `${prefix}: connection refused (ECONNREFUSED). Check the Plex address and published port.`);
    if (['ETIMEDOUT', 'ECONNABORTED'].includes(code || '')) return new PlexConnectionError('TIMEOUT', stage, address,
      `${prefix}: connection timed out. This address may be unreachable from the container.`, 504);
    if (['ENETUNREACH', 'EHOSTUNREACH'].includes(code || '')) return new PlexConnectionError(code!, stage, address,
      `${prefix}: no network route (${code}). Try the NAS LAN address or another advertised connection.`);
    if (['ERR_TLS_CERT_ALTNAME_INVALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(code || '')) {
      return new PlexConnectionError('TLS_CERTIFICATE', stage, address,
        `${prefix}: HTTPS certificate validation failed (${code}). Use the advertised HTTPS plex.direct name or fix the certificate. Certificate checking remains enabled.`);
    }
    if (String(code).startsWith('ERR_SSL') || String(code).startsWith('ERR_TLS')) return new PlexConnectionError('TLS_HANDSHAKE', stage, address,
      `${prefix}: TLS handshake failed. Check that the protocol and port match this Plex endpoint.`);
    if (status === 401 || status === 403) return new PlexConnectionError(`HTTP_${status}`, stage, address,
      `${prefix}: HTTP ${status}. The server or its reverse proxy refused access; this is not a connection timeout.`);
    if (status && status >= 300 && status < 400) return new PlexConnectionError('REDIRECT', stage, address,
      `${prefix}: HTTP ${status} redirect. Use the direct Plex API address; redirects are not followed with credentials.`);
    if (status) return new PlexConnectionError(`HTTP_${status}`, stage, address,
      `${prefix}: HTTP ${status}. Check the Plex API port and reverse proxy route.`);
    if (code === 'ECONNRESET') return new PlexConnectionError(code, stage, address, `${prefix}: the connection was reset (ECONNRESET).`);
  }
  return new PlexConnectionError('CONNECTION_FAILED', stage, address, `${prefix}. No usable Plex API response was received.`);
}

async function readContainer(data: unknown, url: string, stage: string): Promise<any> {
  let parsed = data as any;
  if (typeof data === 'string') {
    const text = data.trim();
    try {
      if (text.startsWith('{')) parsed = JSON.parse(text);
      else if (/^(?:<\?xml[^>]*>\s*)?<MediaContainer(?:\s|>)/.test(text) && !/<!DOCTYPE|<!ENTITY/i.test(text)) {
        parsed = await parseStringPromise(text, { explicitArray: false, mergeAttrs: true });
      }
    } catch { parsed = undefined; }
  }
  const container = parsed?.MediaContainer;
  if (!container || typeof container !== 'object' || Array.isArray(container)) {
    throw new PlexConnectionError('INVALID_RESPONSE', stage, displayAddress(url),
      `${displayAddress(url)}: ${stage} returned an unexpected response. Expected the Plex API, not a web page or proxy login.`);
  }
  return container;
}

export async function checkPlexConnection(urlInput: string, token: string, expectedId?: string, allowAuthenticatedIdentity = false) {
  const url = normalizePlexUrl(urlInput);
  const options = { timeout: 5000, maxRedirects: 0, maxContentLength: 1024 * 1024,
    headers: { Accept: 'application/json', 'X-Plex-Product': 'LibraryDownloadarr' } };
  let identity;
  try {
    let response;
    try { response = await axios.get(`${url}/identity`, options); }
    catch (error) {
      // Retry with credentials only for an exact connection advertised by this
      // owned Plex server (or explicit manual token setup), never a custom URL.
      if (!allowAuthenticatedIdentity || !axios.isAxiosError(error) || ![401, 403].includes(error.response?.status || 0)) throw error;
      response = await axios.get(`${url}/identity`, { ...options, headers: { ...options.headers, 'X-Plex-Token': token } });
    }
    identity = await readContainer(response.data, url, 'server identity');
    if (typeof identity.machineIdentifier !== 'string' || !identity.machineIdentifier) {
      throw new PlexConnectionError('INVALID_IDENTITY', 'server identity', displayAddress(url), `${displayAddress(url)}: Plex did not return a server identity.`);
    }
    if (expectedId && identity.machineIdentifier !== expectedId) {
      throw new PlexConnectionError('WRONG_SERVER', 'server identity', displayAddress(url), 'This address belongs to a different Plex server.', 400);
    }
  } catch (error) { throw plexConnectionFailure(error, url, 'server identity'); }
  try {
    const response = await axios.get(`${url}/library/sections`, { ...options,
      headers: { ...options.headers, 'X-Plex-Token': token } });
    const sections = await readContainer(response.data, url, 'library access');
    return { url, token, machineId: identity.machineIdentifier as string,
      name: String(sections.friendlyName || identity.friendlyName || 'Plex server') };
  } catch (error) { throw plexConnectionFailure(error, url, 'library access'); }
}
