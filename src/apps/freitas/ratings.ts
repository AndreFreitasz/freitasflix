import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import type { MediaStream } from '@jellyfin/sdk/lib/generated-client/models/media-stream';
import { getLibraryApi } from '@jellyfin/sdk/lib/utils/api/library-api';
import { useQuery } from '@tanstack/react-query';

import { useApi } from 'hooks/useApi';
import { currentSettings as userSettings } from 'scripts/settings/userSettings';

/*
 * Ratings shown by Freitas+:
 *  - TMDB:            item.CommunityRating (Jellyfin's default movie/series provider is TMDb)
 *  - Rotten Tomatoes: item.CriticRating when Jellyfin has it, otherwise OMDb
 *  - Metacritic:      OMDb "Metascore" (Jellyfin does not store it)
 *
 * OMDb needs a free API key. It is saved in the user's Jellyfin display preferences,
 * so typing it once (on any device) enables it on the TV, phone and desktop.
 */

export const OMDB_KEY_SETTING = 'freitas-omdb-key';
const OMDB_CACHE_PREFIX = 'fp-omdb:';
const OMDB_CACHE_DAYS = 14;

export function getOmdbKey(): string {
    try {
        return (userSettings.get(OMDB_KEY_SETTING) || '').trim();
    } catch {
        return '';
    }
}

export function setOmdbKey(key: string) {
    userSettings.set(OMDB_KEY_SETTING, key.trim(), true);
}

export interface OmdbRatings {
    metascore?: number
    rottenTomatoes?: number
    imdb?: number
}

function parseOmdb(json: Record<string, unknown>): OmdbRatings {
    const out: OmdbRatings = {};
    const meta = parseInt(String(json.Metascore), 10);
    if (!isNaN(meta)) out.metascore = meta;
    const imdb = parseFloat(String(json.imdbRating));
    if (!isNaN(imdb)) out.imdb = imdb;
    const list = Array.isArray(json.Ratings) ? json.Ratings as { Source?: string, Value?: string }[] : [];
    const rt = list.find(r => r.Source === 'Rotten Tomatoes');
    if (rt?.Value) {
        const v = parseInt(rt.Value, 10);
        if (!isNaN(v)) out.rottenTomatoes = v;
    }
    return out;
}

function readCache(imdbId: string): OmdbRatings | undefined {
    try {
        const raw = localStorage.getItem(OMDB_CACHE_PREFIX + imdbId);
        if (!raw) return undefined;
        const { t, v } = JSON.parse(raw) as { t: number, v: OmdbRatings };
        if (Date.now() - t > OMDB_CACHE_DAYS * 86400000) return undefined;
        return v;
    } catch {
        return undefined;
    }
}

function writeCache(imdbId: string, v: OmdbRatings) {
    try {
        localStorage.setItem(OMDB_CACHE_PREFIX + imdbId, JSON.stringify({ t: Date.now(), v }));
    } catch {
        // storage full or blocked: just skip caching
    }
}

export async function fetchOmdb(imdbId: string, key: string, signal?: AbortSignal): Promise<OmdbRatings> {
    const cached = readCache(imdbId);
    if (cached) return cached;
    const res = await fetch(`https://www.omdbapi.com/?i=${encodeURIComponent(imdbId)}&apikey=${encodeURIComponent(key)}`, { signal });
    const json = await res.json() as Record<string, unknown>;
    if (json.Response === 'False') {
        if (String(json.Error || '').toLowerCase().includes('api key')) throw new Error(String(json.Error));
        writeCache(imdbId, {});
        return {};
    }
    const out = parseOmdb(json);
    writeCache(imdbId, out);
    return out;
}

export function imdbIdOf(item?: BaseItemDto | null): string | undefined {
    const ids = item?.ProviderIds || {};
    return ids.Imdb || ids.IMDB || ids.imdb || undefined;
}

/** OMDb ratings for an item; disabled when there is no key or no IMDb id. */
export function useOmdb(item?: BaseItemDto | null, enabled = true) {
    const key = getOmdbKey();
    const imdbId = imdbIdOf(item);
    return useQuery({
        queryKey: [ 'freitas', 'omdb', imdbId ],
        queryFn: ({ signal }) => fetchOmdb(imdbId!, key, signal),
        enabled: enabled && !!key && !!imdbId,
        staleTime: Infinity,
        gcTime: 60 * 60 * 1000,
        retry: false
    });
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

export interface Ratings {
    tmdb?: number
    rottenTomatoes?: number
    metascore?: number
}

export function combineRatings(item?: BaseItemDto | null, omdb?: OmdbRatings): Ratings {
    return {
        tmdb: item?.CommunityRating || undefined,
        rottenTomatoes: item?.CriticRating ?? omdb?.rottenTomatoes,
        metascore: omdb?.metascore
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
