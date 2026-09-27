// Stream choices are rebuilt from authenticated Plex metadata on every request.
// A season uses exact, unambiguous track descriptions common to every episode.
export interface StreamSelection { audio?: string; subtitle?: string }
export interface StreamOption { id: string; label: string }
export interface StreamSource { metadata: any; part: any; mediaIndex: number; partIndex: number }
export interface ResolvedStreams { audioId?: number; subtitleId?: number }
export const selected = (value: unknown) => value === true || value === 1 || value === '1';
const clean = (value: unknown) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 160) : '';
const validId = (value: unknown) => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const streams = (source: StreamSource, type: number) => (source.part.Stream || []).filter((s: any) => Number(s.streamType) === type && validId(s.id));

function description(stream: any): string {
  return JSON.stringify([clean(stream.languageTag || stream.languageCode || stream.language).toLowerCase(),
    clean(stream.title), clean(stream.codec), Number(stream.channels) || 0,
    selected(stream.forced), selected(stream.hearingImpaired), selected(stream.visualImpaired), selected(stream.commentary)]);
}
function label(stream: any): string {
  const title = clean(stream.extendedDisplayTitle || stream.displayTitle) ||
    [clean(stream.language) || clean(stream.languageTag || stream.languageCode) || 'Unknown language',
      clean(stream.title), clean(stream.codec).toUpperCase(), stream.channels ? `${Number(stream.channels)} ch` : ''].filter(Boolean).join(' · ');
  return [title, selected(stream.forced) ? 'Forced' : '', selected(stream.hearingImpaired) ? 'SDH' : '',
    selected(stream.visualImpaired) ? 'Audio description' : '', selected(stream.commentary) ? 'Commentary' : ''].filter(Boolean).join(' · ');
}
const choiceId = (stream: any, season: boolean) => season
  ? `match:${Buffer.from(description(stream)).toString('base64url')}` : `stream:${Number(stream.id)}`;

function options(sources: StreamSource[], type: number, season: boolean): StreamOption[] {
  if (!sources.length) return [];
  return streams(sources[0], type).flatMap((stream: any) => {
    const id = choiceId(stream, season);
    if (!sources.every(source => streams(source, type).filter((s: any) => choiceId(s, season) === id).length === 1)) return [];
    return [{ id, label: season ? label(stream) : `${label(stream)} · Track ${stream.id}` }];
  });
}

export function streamOptions(sources: StreamSource[], season: boolean) {
  return {
    audio: [{ id: 'plex', label: 'Plex selection' }, ...options(sources, 2, season)],
    subtitle: [{ id: 'plex', label: 'Plex selection' }, { id: 'none', label: 'None' }, ...options(sources, 3, season)],
    season, fileCount: sources.length,
  };
}
export function validSelection(selection: StreamSelection): boolean {
  return [selection.audio, selection.subtitle].every(value => value === undefined ||
    typeof value === 'string' && /^(plex|none|stream:[1-9]\d{0,15}|match:[A-Za-z0-9_-]{1,1500})$/.test(value)) && selection.audio !== 'none';
}
export function explicitSelection(selection: StreamSelection): boolean {
  return !!(selection.audio && selection.audio !== 'plex' || selection.subtitle && selection.subtitle !== 'plex');
}
export function resolveStreams(sources: StreamSource[], season: boolean, selection: StreamSelection) {
  const choices = streamOptions(sources, season);
  const audio = choices.audio.find(option => option.id === (selection.audio || 'plex'));
  const subtitle = choices.subtitle.find(option => option.id === (selection.subtitle || 'plex'));
  if (!audio || !subtitle) throw new Error('The selected tracks are no longer available for every file. Reopen download options.');
  const resolved = sources.map(source => {
    const result: ResolvedStreams = {};
    if (audio.id !== 'plex') result.audioId = Number(streams(source, 2).find((s: any) => choiceId(s, season) === audio.id).id);
    if (subtitle.id === 'none') result.subtitleId = 0;
    else if (subtitle.id !== 'plex') result.subtitleId = Number(streams(source, 3).find((s: any) => choiceId(s, season) === subtitle.id).id);
    if (explicitSelection(selection) && !validId(source.part.id)) throw new Error('Plex did not provide a valid media part for track selection.');
    return result;
  });
  return { resolved, audioLabel: audio.label, subtitleLabel: subtitle.label };
}

export function selectionApplied(part: any, expected: ResolvedStreams): boolean {
  const chosen = (type: number) => (part.Stream || []).filter((s: any) => Number(s.streamType) === type && selected(s.selected));
  if (expected.audioId !== undefined && (chosen(2).length !== 1 || Number(chosen(2)[0].id) !== expected.audioId)) return false;
  if (expected.subtitleId === undefined) return true;
  if (expected.subtitleId === 0) return chosen(3).length === 0;
  return chosen(3).length === 1 && Number(chosen(3)[0].id) === expected.subtitleId;
}

export function decisionMatchesStreams(container: any, expected: ResolvedStreams): boolean {
  const media = container?.Metadata?.[0]?.Media?.find((m: any) => selected(m.selected)) || container?.Metadata?.[0]?.Media?.[0];
  const part = media?.Part?.find((p: any) => selected(p.selected)) || media?.Part?.[0];
  const entries = part?.Stream || [];
  if (expected.audioId !== undefined) {
    const audio = entries.filter((s: any) => Number(s.streamType) === 2 && s.decision !== 'ignore');
    const chosen = audio.filter((s: any) => selected(s.selected));
    const output = chosen.length ? chosen : audio;
    if (output.length !== 1 || Number(output[0].id) !== expected.audioId) return false;
  }
  if (expected.subtitleId !== undefined) {
    const subs = entries.filter((s: any) => Number(s.streamType) === 3 && s.decision !== 'ignore' &&
      (selected(s.selected) || ['burn', 'copy', 'transcode'].includes(s.decision)));
    if (expected.subtitleId === 0) return subs.length === 0;
    return subs.length === 1 && Number(subs[0].id) === expected.subtitleId && subs[0].decision === 'burn';
  }
  return true;
}
