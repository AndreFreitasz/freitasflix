import type { Api } from '@jellyfin/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useApi } from 'hooks/useApi';
import { currentSettings as userSettings } from 'scripts/settings/userSettings';

/*
 * Client for freitas-bridge (bridge/freitas-bridge.mjs): the server-side helper that
 * talks to TMDB / Radarr / Prowlarr / qBittorrent so their API keys never reach the
 * browser or the TV. Requests are authenticated with the user's Jellyfin token.
 *
 * Its address defaults to the Jellyfin host on port 8099 (works at home and through
 * Tailscale alike) and can be changed at #/notas.
 */

export const BRIDGE_URL_SETTING = 'freitas-bridge-url';
export const DEFAULT_BRIDGE_PORT = 8099;

export function defaultBridgeUrl(api?: Api): string {
    try {
        const base = new URL(api?.basePath || window.location.href);
        return `${base.protocol}//${base.hostname}:${DEFAULT_BRIDGE_PORT}`;
    } catch {
        return '';
    }
}

export function getBridgeOverride(): string {
    try {
        return (userSettings.get(BRIDGE_URL_SETTING) || '').trim();
    } catch {
        return '';
    }
}

function stripSlashes(url: string) {
    let out = url.trim();
    while (out.endsWith('/')) out = out.slice(0, -1);
    return out;
}

export function setBridgeOverride(url: string) {
    userSettings.set(BRIDGE_URL_SETTING, stripSlashes(url), true);
}

export const bridgeUrl = (api?: Api) => stripSlashes(getBridgeOverride() || defaultBridgeUrl(api));

export class BridgeError extends Error {
    status: number;
    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

export async function bridgeFetch<T>(api: Api, path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
    let res: Response;
    try {
        res = await fetch(bridgeUrl(api) + path, {
            ...init,
            signal,
            headers: {
                'X-Emby-Token': api.accessToken,
                ...(init.body ? { 'Content-Type': 'application/json' } : {}),
                ...(init.headers || {})
            }
        });
    } catch (err) {
        if (signal?.aborted) throw err;
        throw new BridgeError(0, 'Não consegui falar com a ponte do Freitas+.');
    }
    let body: unknown = null;
    try {
        body = await res.json();
    } catch {
        // empty / not json
    }
    if (!res.ok) {
        const msg = (body as { error?: string } | null)?.error || `Erro ${res.status}`;
        throw new BridgeError(res.status, msg);
    }
    return body as T;
}

/* ---------- types (mirror the bridge responses) ---------- */

export type MediaKind = 'movie' | 'tv';
export type CatalogState = 'library' | 'downloading' | 'none';

export interface CatalogItem {
    type: MediaKind
    tmdbId: number
    title: string
    originalTitle: string
    year?: number
    poster: string
    backdrop: string
    overview: string
    rating?: number
    originalLanguage: string
    state: CatalogState
    jellyfinId?: string
    progress?: number
}

export interface CatalogSection {
    id: string
    title: string
    items: CatalogItem[]
}

export interface StateInfo {
    state: CatalogState
    jellyfinId?: string
    progress?: number
    status?: string
    timeleft?: string
    title?: string
}

export interface CatalogTitle extends CatalogItem, Omit<StateInfo, 'title'> {
    imdbId: string
    tvdbId?: number
    runtime?: number
    genres: string[]
    certification: string
    logo: string
    tagline: string
    cast: { name: string, character: string, photo: string }[]
    directors: string[]
    studios: string[]
    seasons?: { number: number, name: string, episodes: number, year?: number }[]
    trailer: string
    status: string
}

export interface Release {
    key: string
    origin: 'radarr' | 'prowlarr'
    indexer: string
    title: string
    size: number
    seeders: number
    leechers: number
    ageDays: number
    resolution: number
    source: string
    quality: string
    languages: string[]
    ptbr: '' | 'dual' | 'dublado' | 'pt'
    freeleech: number
    doubleUpload: boolean
    rejected: boolean
    rejections: string[]
    infoUrl: string
    score: number
}

export interface ReleasesResponse {
    movieId: number
    releases: Release[]
    errors: string[]
}

/* ---------- hooks ---------- */

function useBridgeCtx() {
    const { api, user } = useApi();
    return { api, userId: user?.Id, enabled: !!api && !!user?.Id };
}

export function useBridgeMe() {
    const { api, userId, enabled } = useBridgeCtx();
    return useQuery({
        queryKey: [ 'freitas', 'bridge', userId, 'me', bridgeUrl(api) ],
        queryFn: ({ signal }) => bridgeFetch<{ name: string, canDownload: boolean, services: { movies: boolean, series: boolean } }>(api!, '/api/me', {}, signal),
        enabled,
        retry: false,
        staleTime: 5 * 60 * 1000
    });
}

export function useDiscover() {
    const { api, userId, enabled } = useBridgeCtx();
    return useQuery({
        queryKey: [ 'freitas', 'bridge', userId, 'discover' ],
        queryFn: ({ signal }) => bridgeFetch<{ sections: CatalogSection[] }>(api!, '/api/discover', {}, signal),
        enabled,
        retry: 1,
        staleTime: 5 * 60 * 1000
    });
}

export function useCatalogTitle(type?: MediaKind, tmdbId?: number) {
    const { api, userId, enabled } = useBridgeCtx();
    return useQuery({
        queryKey: [ 'freitas', 'bridge', userId, 'title', type, tmdbId ],
        queryFn: ({ signal }) => bridgeFetch<CatalogTitle>(api!, `/api/title/${type}/${tmdbId}`, {}, signal),
        enabled: enabled && !!type && !!tmdbId,
        retry: 1,
        staleTime: 10 * 60 * 1000
    });
}

/** Library / download state; polled while a download is running. */
export function useCatalogState(type?: MediaKind, tmdbId?: number, initial?: StateInfo) {
    const { api, userId, enabled } = useBridgeCtx();
    return useQuery({
        queryKey: [ 'freitas', 'bridge', userId, 'state', type, tmdbId ],
        queryFn: ({ signal }) => bridgeFetch<StateInfo>(api!, `/api/state/${type}/${tmdbId}`, {}, signal),
        enabled: enabled && !!type && !!tmdbId,
        initialData: initial,
        refetchInterval: q => (q.state.data?.state === 'downloading' ? 10000 : false),
        staleTime: 5000
    });
}

/** Download options from the user's trackers; started on demand (it can take a minute). */
export function useReleases(tmdbId: number | undefined, enabled: boolean) {
    const { api, userId, enabled: ready } = useBridgeCtx();
    return useQuery({
        queryKey: [ 'freitas', 'bridge', userId, 'releases', tmdbId ],
        queryFn: ({ signal }) => bridgeFetch<ReleasesResponse>(api!, `/api/releases/movie/${tmdbId}`, {}, signal),
        enabled: ready && enabled && !!tmdbId,
        retry: false,
        staleTime: 10 * 60 * 1000,
        gcTime: 30 * 60 * 1000
    });
}

export function useGrab(tmdbId?: number) {
    const { api, userId } = useBridgeCtx();
    const qc = useQueryClient();
    return useMutation({
        mutationFn: (key: string) => bridgeFetch<{ ok: boolean }>(api!, '/api/grab', {
            method: 'POST',
            body: JSON.stringify({ key, tmdbId })
        }),
        onSuccess: () => {
            void qc.invalidateQueries({ queryKey: [ 'freitas', 'bridge', userId, 'state' ] });
            void qc.invalidateQueries({ queryKey: [ 'freitas', 'bridge', userId, 'discover' ] });
            qc.removeQueries({ queryKey: [ 'freitas', 'bridge', userId, 'releases', tmdbId ] });
        }
    });
}

/* ---------- formatting ---------- */

export function formatBytes(n: number): string {
    if (!n) return '';
    const gb = n / 1024 ** 3;
    if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 1 : 2).replace('.', ',')} GB`;
    return `${Math.round(n / 1024 ** 2)} MB`;
}

export function formatAge(days: number): string {
    if (days <= 0) return 'hoje';
    if (days === 1) return 'ontem';
    if (days < 30) return `${days} dias`;
    if (days < 365) return `${Math.round(days / 30)} meses`;
    const y = Math.round(days / 365);
    return y === 1 ? '1 ano' : `${y} anos`;
}

export function resolutionLabel(r: number): string {
    if (r >= 2160) return '4K';
    if (r >= 1080) return '1080p';
    if (r >= 720) return '720p';
    if (r > 0) return 'SD';
    return '';
}

export function freeleechLabel(r: Release): string {
    if (r.freeleech >= 100) return 'FL';
    if (r.freeleech > 0) return `FL ${r.freeleech}%`;
    return '';
}

export function ptbrLabel(r: Release): string {
    switch (r.ptbr) {
        case 'dual': return 'DUAL';
        case 'dublado': return 'Dublado';
        case 'pt': return 'PT-BR';
        default: return '';
    }
}
