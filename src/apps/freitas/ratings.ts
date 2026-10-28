import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import type { MediaStream } from '@jellyfin/sdk/lib/generated-client/models/media-stream';
import { getLibraryApi } from '@jellyfin/sdk/lib/utils/api/library-api';
import { useQuery } from '@tanstack/react-query';

import { useApi } from 'hooks/useApi';
import { currentSettings as userSettings } from 'scripts/settings/userSettings';

/*
 * Ratings shown by Freitas+ (title page and card details):
 *   IMDb · Rotten Tomatoes · Metacritic · Letterboxd · MyAnimeList (animes) · TMDB
 *
 * Source: MDBList (one request returns every site). OMDb is an optional fallback
 * that covers IMDb, Rotten Tomatoes and Metacritic. Jellyfin's own fields fill the
 * gaps (CommunityRating = TMDb, CriticRating = Rotten Tomatoes).
 *
 * Keys are free and saved in the user's Jellyfin display preferences, so typing
 * them once (on any device, at #/notas) enables them on the TV, phone and desktop.
 * Results are cached per title for 14 days to stay far below the daily limits.
 */

export const MDBLIST_KEY_SETTING = 'freitas-mdblist-key';
export const OMDB_KEY_SETTING = 'freitas-omdb-key';
const CACHE_PREFIX = 'fp-ratings:';
const CACHE_DAYS = 14;
const EMPTY_CACHE_DAYS = 2; // titles a site does not know yet are retried sooner
const PAUSE_KEY = 'fp-ratings-paused-until';

function readSetting(name: string): string {
    try {
        return (userSettings.get(name) || '').trim();
    } catch {
        return '';
    }
}

export const getMdblistKey = () => readSetting(MDBLIST_KEY_SETTING);
export const getOmdbKey = () => readSetting(OMDB_KEY_SETTING);
export const setMdblistKey = (key: string) => userSettings.set(MDBLIST_KEY_SETTING, key.trim(), true);
export const setOmdbKey = (key: string) => userSettings.set(OMDB_KEY_SETTING, key.trim(), true);

export interface ExternalRatings {
    imdb?: number // 0–10
    rottenTomatoes?: number // %
    metascore?: number // 0–100
    letterboxd?: number // 0–5
    mal?: number // 0–10
    tmdb?: number // 0–10
}

/* ---------- ids ---------- */

export function imdbIdOf(item?: BaseItemDto | null): string | undefined {
    const ids = item?.ProviderIds || {};
    return ids.Imdb || ids.IMDB || ids.imdb || undefined;
}

export function tmdbIdOf(item?: BaseItemDto | null): string | undefined {
    const ids = item?.ProviderIds || {};
    return ids.Tmdb || ids.TMDB || ids.tmdb || undefined;
}

function cacheIdOf(item?: BaseItemDto | null): string | undefined {
    const tmdb = tmdbIdOf(item);
    if (tmdb) return `tmdb-${item?.Type}-${tmdb}`;
    const imdb = imdbIdOf(item);
    return imdb ? `imdb-${imdb}` : undefined;
}

/* ---------- cache ---------- */

function readCache(id: string): ExternalRatings | undefined {
    try {
        const raw = localStorage.getItem(CACHE_PREFIX + id);
        if (!raw) return undefined;
        const { t, v, p } = JSON.parse(raw) as { t: number, v: ExternalRatings, p?: 1 };
        const days = Object.keys(v).length && !p ? CACHE_DAYS : EMPTY_CACHE_DAYS;
        if (Date.now() - t > days * 86400000) return undefined;
        return v;
    } catch {
        return undefined;
    }
}

/** `partial`: a configured source failed, so the entry is retried sooner. */
function writeCache(id: string, v: ExternalRatings, partial = false) {
    try {
        localStorage.setItem(CACHE_PREFIX + id, JSON.stringify({ t: Date.now(), v, ...(partial ? { p: 1 } : {}) }));
    } catch {
        // storage full or blocked: just skip caching
    }
}

function isPaused(): boolean {
    try {
        return Number(localStorage.getItem(PAUSE_KEY) || 0) > Date.now();
    } catch {
        return false;
    }
}

function pauseForAnHour() {
    try {
        localStorage.setItem(PAUSE_KEY, String(Date.now() + 3600000));
    } catch {
        // ignore
    }
}

/* ---------- MDBList ---------- */

interface MdblistRating {
    source?: string
    value?: number | null
    score?: number | null
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** A rating on a 0–`max` scale, from MDBList's native value or its 0–100 score. */
function scaled(r: MdblistRating, max: number): number | undefined {
    if (typeof r.value === 'number' && r.value > 0) {
        // some endpoints return Letterboxd on 0–10 instead of 0–5
        return round1(r.value > max ? r.value / 2 : r.value);
    }
    if (typeof r.score === 'number' && r.score > 0) return round1(r.score * max / 100);
    return undefined;
}

function percent(r: MdblistRating): number | undefined {
    const v = typeof r.score === 'number' && r.score > 0 ? r.score : r.value;
    return typeof v === 'number' && v > 0 ? Math.round(v) : undefined;
}

const MDBLIST_FIELDS: Record<string, (r: MdblistRating) => [keyof ExternalRatings, number | undefined]> = {
    imdb: r => [ 'imdb', scaled(r, 10) ],
    tomatoes: r => [ 'rottenTomatoes', percent(r) ],
    metacritic: r => [ 'metascore', percent(r) ],
    letterboxd: r => [ 'letterboxd', scaled(r, 5) ],
    myanimelist: r => [ 'mal', scaled(r, 10) ],
    tmdb: r => {
        const p = percent(r);
        return [ 'tmdb', p != null ? round1(p / 10) : undefined ];
    }
};

export function parseMdblist(json: { ratings?: MdblistRating[] }): ExternalRatings {
    const out: ExternalRatings = {};
    for (const r of json.ratings || []) {
        const field = r.source ? MDBLIST_FIELDS[r.source] : undefined;
        if (!field) continue;
        const [ key, value ] = field(r);
        if (value != null) out[key] = value;
    }
    return out;
}

// A plain flag instead of an Error subclass: `instanceof` on Error subclasses breaks
// once the code is transpiled for old TV browsers.
const KEY_ERROR = 'fpKeyError';
function keyError(message: string): Error {
    return Object.assign(new Error(message), { [KEY_ERROR]: true });
}
const isKeyError = (err: unknown) => !!(err && typeof err === 'object' && (err as Record<string, unknown>)[KEY_ERROR]);

export async function fetchMdblist(path: string, key: string, signal?: AbortSignal): Promise<ExternalRatings> {
    const res = await fetch(`https://api.mdblist.com/${path}?apikey=${encodeURIComponent(key)}`, { signal });
    if (res.status === 429) {
        pauseForAnHour();
        throw new Error('Limite diário do MDBList atingido');
    }
    if (res.status === 401 || res.status === 403) throw keyError('a chave do MDBList é inválida');
    if (res.status === 404) return {};
    if (!res.ok) throw new Error(`MDBList respondeu ${res.status}`);
    return parseMdblist(await res.json() as { ratings?: MdblistRating[] });
}

function mdblistPath(item: BaseItemDto): string | undefined {
    const type = item.Type === 'Series' ? 'show' : 'movie';
    const tmdb = tmdbIdOf(item);
    if (tmdb) return `tmdb/${type}/${encodeURIComponent(tmdb)}`;
    const imdb = imdbIdOf(item);
    return imdb ? `imdb/${type}/${encodeURIComponent(imdb)}` : undefined;
}

/* ---------- OMDb (fallback) ---------- */

function parseOmdb(json: Record<string, unknown>): ExternalRatings {
    const out: ExternalRatings = {};
    const meta = parseInt(String(json.Metascore), 10);
    if (!isNaN(meta)) out.metascore = meta;
    const imdb = parseFloat(String(json.imdbRating));
    if (!isNaN(imdb)) out.imdb = imdb;
    const list = Array.isArray(json.Ratings) ? json.Ratings as { Source?: string, Value?: string }[] : [];
    const rt = parseInt(list.find(r => r.Source === 'Rotten Tomatoes')?.Value || '', 10);
    if (!isNaN(rt)) out.rottenTomatoes = rt;
    return out;
}

export async function fetchOmdb(imdbId: string, key: string, signal?: AbortSignal): Promise<ExternalRatings> {
    const res = await fetch(`https://www.omdbapi.com/?i=${encodeURIComponent(imdbId)}&apikey=${encodeURIComponent(key)}`, { signal });
    const json = await res.json() as Record<string, unknown>;
    if (json.Response !== 'False') return parseOmdb(json);
    if (String(json.Error || '').toLowerCase().includes('api key')) throw keyError('OMDb: ' + String(json.Error));
    return {};
}

/* ---------- combined ---------- */

/** Runs one source; undefined when it is not configured or failed (the other source may still answer). */
async function trySource(
    name: string,
    run: (() => Promise<ExternalRatings>) | undefined,
    signal?: AbortSignal
): Promise<ExternalRatings | undefined> {
    if (!run) return undefined;
    try {
        return await run();
    } catch (err) {
        if (signal?.aborted) throw err;
        console.warn(`[Freitas+] ${name}`, err);
        return undefined;
    }
}

const needsOmdb = (r?: ExternalRatings) => !r || r.metascore == null || r.imdb == null || r.rottenTomatoes == null;

async function fetchExternal(item: BaseItemDto, signal?: AbortSignal): Promise<ExternalRatings> {
    const id = cacheIdOf(item)!;
    const cached = readCache(id);
    if (cached) return cached;
    if (isPaused()) return {};

    const mdbKey = getMdblistKey();
    const path = mdblistPath(item);
    const mdb = await trySource('MDBList', mdbKey && path ? () => fetchMdblist(path, mdbKey, signal) : undefined, signal);

    // OMDb fills what MDBList could not give (or everything, if MDBList is off/unreachable)
    const omdbKey = getOmdbKey();
    const imdb = imdbIdOf(item);
    const omdbRun = omdbKey && imdb && needsOmdb(mdb) ? () => fetchOmdb(imdb, omdbKey, signal) : undefined;
    const omdb = await trySource('OMDb', omdbRun, signal);

    if (!mdb && !omdb) return {};
    const out = { ...omdb, ...mdb };
    writeCache(id, out, !!(mdbKey && path) && !mdb);
    return out;
}

/** External ratings for a movie/series; idle when no key is configured. */
export function useExternalRatings(item?: BaseItemDto | null, enabled = true) {
    const id = cacheIdOf(item);
    const hasKey = !!(getMdblistKey() || getOmdbKey());
    return useQuery({
        queryKey: [ 'freitas', 'ratings', id ],
        queryFn: ({ signal }) => fetchExternal(item!, signal),
        enabled: enabled && hasKey && !!id && (item?.Type === 'Movie' || item?.Type === 'Series'),
        staleTime: Infinity,
        gcTime: 60 * 60 * 1000,
        retry: false
    });
}

async function testMdblist(key: string): Promise<string> {
    try {
        const r = await fetchMdblist('tmdb/movie/278', key);
        const parts = [
            r.imdb != null && `IMDb ${r.imdb}`,
            r.metascore != null && `Metacritic ${r.metascore}`,
            r.letterboxd != null && `Letterboxd ${r.letterboxd}`
        ].filter(Boolean);
        const sample = parts.length ? ` (Um Sonho de Liberdade: ${parts.join(', ')})` : '';
        return `MDBList funcionando${sample}.`;
    } catch (err) {
        if (isKeyError(err)) throw err;
        const reason = err instanceof Error ? err.message : 'erro';
        return `MDBList: não deu para testar daqui (${reason}). A chave foi salva mesmo assim.`;
    }
}

async function testOmdb(key: string): Promise<string> {
    const r = await fetchOmdb('tt0111161', key);
    return 'OMDb funcionando' + (r.metascore != null ? ` (Metacritic ${r.metascore})` : '') + '.';
}

/** Keys are short codes: catch a pasted address or text before calling the services. */
function checkKeyShape(name: string, key: string) {
    if (key && (/[\s/:]/.test(key) || key.length > 64)) {
        throw keyError(`o campo ${name} tem um endereço ou texto, não a chave. Cole só o código da chave`);
    }
}

/** Checks the keys against a well-known title; used by the settings page. */
export async function testKeys(mdblistKey: string, omdbKey: string): Promise<string[]> {
    checkKeyShape('do MDBList', mdblistKey);
    checkKeyShape('do OMDb', omdbKey);
    const lines: string[] = [];
    if (mdblistKey) lines.push(await testMdblist(mdblistKey));
    if (omdbKey) lines.push(await testOmdb(omdbKey));
    return lines;
}

/** Clears cached ratings, e.g. after keys change. */
export function clearRatingsCache() {
    try {
        const keys = Object.keys(localStorage).filter(k => k.startsWith(CACHE_PREFIX) || k.startsWith('fp-omdb:') || k === PAUSE_KEY);
        for (const k of keys) localStorage.removeItem(k);
    } catch {
        // ignore
    }
}

/** Full item (media streams, provider ids, critic rating), fetched on demand for card details. */
export function useItemDetails(itemId?: string | null, enabled = true) {
    const { api, user } = useApi();
    const userId = user?.Id;
    return useQuery({
        queryKey: [ 'freitas', userId, 'item', itemId ],
        queryFn: async ({ signal }) => {
            const res = await getLibraryApi(api!).getItem({ itemId: itemId!, userId }, { signal });
            return res.data;
        },
        enabled: enabled && !!api && !!userId && !!itemId,
        staleTime: 10 * 60 * 1000
    });
}

/** External ratings completed with Jellyfin's own fields. */
export function combineRatings(item?: BaseItemDto | null, ext?: ExternalRatings): ExternalRatings {
    return {
        ...ext,
        tmdb: ext?.tmdb ?? (item?.CommunityRating || undefined),
        rottenTomatoes: ext?.rottenTomatoes ?? (item?.CriticRating ?? undefined)
    };
}

/** Metacritic's own colour bands. */
export function metascoreTone(score: number): 'good' | 'mixed' | 'bad' {
    if (score >= 61) return 'good';
    if (score >= 40) return 'mixed';
    return 'bad';
}

function streamText(s: MediaStream) {
    return `${s.Profile || ''} ${s.DisplayTitle || ''} ${s.Title || ''}`.toLowerCase();
}

function videoBadges(video?: MediaStream): string[] {
    if (!video) return [];
    const out: string[] = [];
    if ((video.Width || 0) >= 3800 || (video.Height || 0) >= 2100) out.push('4K');
    const range = String(video.VideoRangeType || video.VideoRange || '');
    if (range.startsWith('DOVI')) {
        out.push('Dolby Vision');
    } else if (range === 'HDR10Plus') {
        out.push('HDR10+');
    } else if (range === 'HDR10' || range === 'HLG') {
        out.push(range);
    } else if (range === 'HDR') {
        out.push('HDR');
    }
    return out;
}

function audioBadges(audio: MediaStream[]): string[] {
    if (!audio.length) return [];
    if (audio.some(s => streamText(s).includes('atmos'))) return [ 'Dolby Atmos' ];
    if (audio.some(s => streamText(s).includes('dts:x') || streamText(s).includes('dts-x'))) return [ 'DTS:X' ];
    const channels = Math.max(...audio.map(s => s.Channels || 0));
    if (channels >= 8) return [ '7.1' ];
    if (channels >= 6) return [ '5.1' ];
    return [];
}

const SHORT: Record<string, string> = { 'Dolby Vision': 'DV', 'Dolby Atmos': 'Atmos' };

/** Compact labels for small surfaces such as cards. */
export function shortBadge(label: string): string {
    return SHORT[label] || label;
}

/** "4K", "Dolby Vision", "Dolby Atmos"… from the first media source. */
export function techBadges(item?: BaseItemDto | null): string[] {
    const streams = item?.MediaSources?.[0]?.MediaStreams || item?.MediaStreams || [];
    if (!streams.length) return [];
    const video = streams.find(s => s.Type === 'Video');
    const audio = streams.filter(s => s.Type === 'Audio');
    return [ ...videoBadges(video), ...audioBadges(audio) ];
}
