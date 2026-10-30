#!/usr/bin/env node
/*
 * freitas-bridge — the small server-side helper behind Freitas+ "Descobrir" / "Baixar".
 *
 * Why it exists: Radarr/Sonarr/Prowlarr/qBittorrent API keys give full control over
 * those apps and must never reach a browser or TV. This service keeps them on the
 * server, only accepts requests from users logged into Jellyfin, and exposes just
 * what Freitas+ needs: a TMDB catalog, title details, the download options found in
 * the user's trackers, starting a download and its progress.
 *
 * No dependencies: Node 18+ (global fetch). Configured with environment variables:
 *
 *   PORT                  8099
 *   JELLYFIN_URL          http://192.168.1.250:8097         (required)
 *   TMDB_API_KEY          TMDB v3 key or v4 read token      (required for the catalog)
 *   RADARR_URL / RADARR_API_KEY
 *   SONARR_URL / SONARR_API_KEY                             (series)
 *   PROWLARR_URL / PROWLARR_API_KEY                         (extra search by title)
 *   QBIT_URL / QBIT_USER / QBIT_PASS                        (grabs found only by title)
 *   QBIT_MOVIE_CATEGORY   radarr
 *   QBIT_TV_CATEGORY      tv-sonarr   (the category Sonarr uses in qBittorrent)
 *   RADARR_ROOT_FOLDER    first root folder in Radarr
 *   RADARR_QUALITY_PROFILE  name; first profile in Radarr when empty
 *   SONARR_ROOT_FOLDER / SONARR_QUALITY_PROFILE            (same, for Sonarr)
 *   ALLOW_DOWNLOAD        admins | all | comma separated user names   (default admins)
 *   TMDB_LANGUAGE         pt-BR
 *   TMDB_REGION           BR
 */

import http from 'node:http';
import { URL } from 'node:url';

const env = process.env;
const trimSlash = s => (s || '').replace(/\/+$/, '');

export const config = {
    port: Number(env.PORT || 8099),
    jellyfin: trimSlash(env.JELLYFIN_URL),
    tmdbKey: (env.TMDB_API_KEY || '').trim(),
    tmdbBase: trimSlash(env.TMDB_BASE_URL || 'https://api.themoviedb.org/3'),
    language: env.TMDB_LANGUAGE || 'pt-BR',
    region: env.TMDB_REGION || 'BR',
    radarr: { url: trimSlash(env.RADARR_URL), key: (env.RADARR_API_KEY || '').trim() },
    sonarr: { url: trimSlash(env.SONARR_URL), key: (env.SONARR_API_KEY || '').trim() },
    prowlarr: { url: trimSlash(env.PROWLARR_URL), key: (env.PROWLARR_API_KEY || '').trim() },
    qbit: { url: trimSlash(env.QBIT_URL), user: env.QBIT_USER || '', pass: env.QBIT_PASS || '' },
    qbitMovieCategory: env.QBIT_MOVIE_CATEGORY || 'radarr',
    qbitTvCategory: env.QBIT_TV_CATEGORY || 'tv-sonarr',
    sonarrRoot: env.SONARR_ROOT_FOLDER || '',
    sonarrProfile: env.SONARR_QUALITY_PROFILE || '',
    radarrRoot: env.RADARR_ROOT_FOLDER || '',
    radarrProfile: env.RADARR_QUALITY_PROFILE || '',
    allowDownload: (env.ALLOW_DOWNLOAD || 'admins').trim()
};

const IMG = env.TMDB_IMAGE_BASE || 'https://image.tmdb.org/t/p/';
const log = (...a) => console.log(new Date().toISOString(), ...a);

/* ---------------- small helpers ---------------- */

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

const cache = new Map();
async function cached(key, ttlMs, fn) {
    const hit = cache.get(key);
    if (hit && hit.exp > Date.now()) return hit.value;
    const value = await fn();
    cache.set(key, { value, exp: Date.now() + ttlMs });
    if (cache.size > 2000) {
        for (const [k, v] of cache) if (v.exp < Date.now()) cache.delete(k);
    }
    return value;
}

/** Runs at most n async jobs at once (TMDB allows ~40 requests/s; be polite). */
function limiter(n) {
    let active = 0;
    const waiting = [];
    const next = () => {
        if (active >= n || !waiting.length) return;
        active++;
        const job = waiting.shift();
        job.fn().then(job.resolve, job.reject).finally(() => {
            active--;
            next();
        });
    };
    return fn => new Promise((resolve, reject) => {
        waiting.push({ fn, resolve, reject });
        next();
    });
}

const DAY = 86400000;
const isoDay = t => new Date(t).toISOString().slice(0, 10);

async function fetchJson(url, init = {}, timeoutMs = 20000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(url, { ...init, signal: ctrl.signal });
        const text = await res.text();
        let body;
        try {
            body = text ? JSON.parse(text) : null;
        } catch {
            body = text;
        }
        if (!res.ok) {
            const msg = (body && (body.message || body.status_message || (Array.isArray(body) && body[0]?.errorMessage))) || `${res.status}`;
            throw new HttpError(res.status, String(msg));
        }
        // a block page or proxy answering with HTML instead of the API
        if (typeof body === 'string' && /^\s*</.test(body)) throw new HttpError(502, `resposta inesperada (HTML) de ${new URL(url).host}`);
        return body;
    } catch (err) {
        if (err.name === 'AbortError') throw new HttpError(504, 'tempo esgotado');
        // network failures come as "fetch failed"; the cause says why (ENOTFOUND, ECONNREFUSED…)
        if (!(err instanceof HttpError) && err.cause) throw new HttpError(502, `sem conexão: ${err.cause.code || err.cause.message} em ${new URL(url).host}`);
        throw err;
    } finally {
        clearTimeout(t);
    }
}

const year = d => (d ? Number(String(d).slice(0, 4)) || undefined : undefined);

/* ---------------- Jellyfin auth ---------------- */

function tokenOf(req) {
    const h = req.headers;
    if (h['x-emby-token']) return String(h['x-emby-token']);
    const auth = String(h.authorization || h['x-emby-authorization'] || '');
    const m = auth.match(/Token="?([^",\s]+)"?/i);
    return m ? m[1] : '';
}

// Jellyfin 10.11+ ignores the legacy X-Emby-Token header by default; use the current scheme
const jellyfinAuth = token => ({
    Authorization: `MediaBrowser Client="Freitas+ Bridge", Device="freitas-bridge", DeviceId="freitas-bridge", Version="1.0", Token="${token}"`
});

const users = new Map();
async function authenticate(req) {
    const token = tokenOf(req);
    if (!token) throw new HttpError(401, 'Faça login no Freitas+.');
    const hit = users.get(token);
    if (hit && hit.exp > Date.now()) return hit.user;
    let me;
    try {
        me = await fetchJson(`${config.jellyfin}/Users/Me`, { headers: jellyfinAuth(token) }, 10000);
    } catch (err) {
        if (err.status === 401 || err.status === 403) throw new HttpError(401, 'Sessão do Jellyfin inválida.');
        // Jellyfin answers 503 to addresses it considers remote when remote access is off;
        // a container on Docker's bridge network looks remote (172.x)
        if (err.status === 503) throw new HttpError(502, 'O Jellyfin recusou a ponte como acesso remoto (503). Coloque o freitas-bridge na rede "host" do CasaOS.');
        throw new HttpError(502, 'Não consegui falar com o Jellyfin: ' + err.message);
    }
    const user = {
        id: me.Id,
        name: me.Name,
        token,
        isAdmin: !!me.Policy?.IsAdministrator
    };
    users.set(token, { user, exp: Date.now() + 5 * 60000 });
    return user;
}

export function canDownload(user) {
    const rule = config.allowDownload.toLowerCase();
    if (rule === 'all') return true;
    if (rule === 'admins' || rule === '') return user.isAdmin;
    return user.isAdmin || rule.split(',').map(s => s.trim()).includes(String(user.name).toLowerCase());
}

/* ---------------- TMDB ---------------- */

function tmdb(path, params = {}, ttlMs = 6 * 3600000) {
    if (!config.tmdbKey) throw new HttpError(503, 'Configure TMDB_API_KEY na ponte.');
    const bearer = config.tmdbKey.startsWith('eyJ');
    const url = new URL(config.tmdbBase + path);
    const q = { language: config.language, ...params };
    if (!bearer) q.api_key = config.tmdbKey;
    for (const [k, v] of Object.entries(q)) if (v != null && v !== '') url.searchParams.set(k, String(v));
    const headers = bearer ? { Authorization: `Bearer ${config.tmdbKey}` } : {};
    return cached('tmdb:' + url.toString(), ttlMs, () => fetchJson(url.toString(), { headers }));
}

export function mapTmdbItem(r, forcedType) {
    const type = forcedType || (r.media_type === 'tv' ? 'tv' : 'movie');
    return {
        type,
        tmdbId: r.id,
        title: r.title || r.name || r.original_title || r.original_name || '',
        originalTitle: r.original_title || r.original_name || '',
        year: year(r.release_date || r.first_air_date),
        date: r.release_date || r.first_air_date || '',
        poster: r.poster_path ? IMG + 'w342' + r.poster_path : '',
        backdrop: r.backdrop_path ? IMG + 'w1280' + r.backdrop_path : '',
        overview: r.overview || '',
        rating: r.vote_average ? Math.round(r.vote_average * 10) / 10 : undefined,
        genreIds: r.genre_ids || [],
        originalLanguage: r.original_language || ''
    };
}

const tmdbLimit = limiter(8);

/*
 * Where a movie can be had. Trackers only have a movie once it is out digitally (or on disc),
 * so movies still only in theaters, or not released yet, are kept out of the regular rows
 * and shown only in "No cinema" / "Futuros lançamentos".
 */
export async function movieAvailability(tmdbId, releaseDate) {
    const now = Date.now();
    const rel = releaseDate ? Date.parse(releaseDate) : NaN;
    if (rel && now - rel > 240 * DAY) return { availability: 'digital' };
    return cached('avail:' + tmdbId, 12 * 3600000, async () => {
        let body;
        try {
            body = await tmdbLimit(() => tmdb(`/movie/${tmdbId}/release_dates`, {}, 12 * 3600000));
        } catch {
            return { availability: 'digital' }; // unknown: don't hide it
        }
        let firstTheater = 0;
        let nextLocal = 0;
        let nextAny = 0;
        let digitalSoon = 0;
        for (const country of body?.results || []) {
            for (const d of country.release_dates || []) {
                const t = Date.parse(d.release_date);
                if (!t) continue;
                if (d.type >= 4) {
                    // 4 digital, 5 physical, 6 TV
                    if (t <= now) return { availability: 'digital' };
                    digitalSoon = digitalSoon ? Math.min(digitalSoon, t) : t;
                } else if (t <= now) {
                    firstTheater = firstTheater ? Math.min(firstTheater, t) : t;
                } else {
                    nextAny = nextAny ? Math.min(nextAny, t) : t;
                    if (country.iso_3166_1 === config.region) nextLocal = nextLocal ? Math.min(nextLocal, t) : t;
                }
            }
        }
        // old movies often have no digital entry at all; after months in theaters it is out
        if (firstTheater && now - firstTheater > 150 * DAY) return { availability: 'digital' };
        if (firstTheater) return { availability: 'cinema', ...(digitalSoon ? { availableDate: isoDay(digitalSoon) } : {}) };
        const when = nextLocal || nextAny || rel;
        return { availability: 'upcoming', ...(when ? { availableDate: isoDay(when) } : {}) };
    });
}

const recentWindow = () => ({ 'release_date.gte': isoDay(Date.now() - 120 * DAY), 'release_date.lte': isoDay(Date.now()) });

/*
 * only: 'digital' keeps movies that can be downloaded (plus anything in the library),
 *       'cinema' keeps movies only in theaters, 'upcoming' those not released yet.
 */
const SECTIONS = [
    { id: 'trending-movies', title: 'Filmes em alta', type: 'movie', path: '/trending/movie/week', pages: 2, only: 'digital' },
    { id: 'new-digital', title: 'Chegaram para baixar', type: 'movie', path: '/discover/movie', pages: 2, only: 'digital', params: () => ({ sort_by: 'popularity.desc', with_release_type: '4|5', 'vote_count.gte': 15, ...recentWindow() }) },
    { id: 'trending-tv', title: 'Séries em alta', type: 'tv', path: '/trending/tv/week' },
    { id: 'anime', title: 'Animes em alta', type: 'tv', path: '/discover/tv', params: () => ({ with_genres: 16, with_original_language: 'ja', sort_by: 'popularity.desc' }) },
    { id: 'popular-movies', title: 'Filmes populares', type: 'movie', path: '/movie/popular', pages: 2, only: 'digital' },
    { id: 'now-playing', title: 'No cinema', type: 'movie', path: '/movie/now_playing', region: true, pages: 2, only: 'cinema' },
    { id: 'upcoming', title: 'Futuros lançamentos', type: 'movie', path: '/movie/upcoming', region: true, pages: 2, only: 'upcoming' },
    { id: 'top-movies', title: 'Filmes mais bem avaliados', type: 'movie', path: '/movie/top_rated', only: 'digital' },
    { id: 'top-tv', title: 'Séries mais bem avaliadas', type: 'tv', path: '/tv/top_rated' }
];

/* ---------------- Jellyfin library index (what the user already has) ---------------- */

async function libraryIndex(user) {
    return cached('lib:' + user.id, 3 * 60000, async () => {
        const url = new URL(`${config.jellyfin}/Items`);
        url.searchParams.set('userId', user.id);
        url.searchParams.set('Recursive', 'true');
        url.searchParams.set('IncludeItemTypes', 'Movie,Series');
        url.searchParams.set('Fields', 'ProviderIds');
        url.searchParams.set('EnableImages', 'false');
        url.searchParams.set('EnableUserData', 'false');
        const body = await fetchJson(url.toString(), { headers: jellyfinAuth(user.token) }, 20000);
        const map = new Map();
        for (const it of body?.Items || []) {
            const ids = it.ProviderIds || {};
            const tmdbId = ids.Tmdb || ids.TMDB || ids.tmdb;
            if (tmdbId) map.set(`${it.Type === 'Series' ? 'tv' : 'movie'}:${tmdbId}`, it.Id);
        }
        return map;
    });
}

/** Episodes on disk, per Jellyfin series id: Map(season -> Set(episode numbers)). */
async function libraryEpisodes(user) {
    return cached('eps:' + user.id, 3 * 60000, async () => {
        const url = new URL(`${config.jellyfin}/Items`);
        url.searchParams.set('userId', user.id);
        url.searchParams.set('Recursive', 'true');
        url.searchParams.set('IncludeItemTypes', 'Episode');
        url.searchParams.set('IsMissing', 'false');
        url.searchParams.set('EnableImages', 'false');
        url.searchParams.set('EnableUserData', 'false');
        const body = await fetchJson(url.toString(), { headers: jellyfinAuth(user.token) }, 30000);
        const out = new Map();
        for (const ep of body?.Items || []) {
            if (!ep.SeriesId || ep.LocationType === 'Virtual' || ep.IndexNumber == null) continue;
            const season = ep.ParentIndexNumber ?? 1;
            if (!out.has(ep.SeriesId)) out.set(ep.SeriesId, new Map());
            const seasons = out.get(ep.SeriesId);
            if (!seasons.has(season)) seasons.set(season, new Set());
            const last = Math.max(ep.IndexNumber, ep.IndexNumberEnd || 0); // "S01E01-E02" files
            for (let n = ep.IndexNumber; n <= last; n++) seasons.get(season).add(n);
        }
        return out;
    });
}

/**
 * What the user has of a series compared with what has aired (TMDB), per season.
 * A series with one or two episodes on disk is not "in the library" for downloading purposes.
 */
export function seasonProgress(details, owned, now = Date.now()) {
    const last = details.last_episode_to_air;
    const next = details.next_episode_to_air;
    const seasons = (details.seasons || []).filter(x => x.season_number > 0).map(x => {
        const n = x.season_number;
        let aired = 0;
        if (last?.season_number != null) {
            if (n < last.season_number) aired = x.episode_count || 0;
            else if (n === last.season_number) aired = Math.max(last.episode_number || 0, 0);
        } else if (x.air_date && Date.parse(x.air_date) <= now) {
            aired = x.episode_count || 0;
        }
        const have = owned?.get(n) || new Set();
        const missingEpisodes = [];
        for (let e = 1; e <= aired; e++) if (!have.has(e)) missingEpisodes.push(e);
        return {
            number: n,
            name: x.name || `Temporada ${n}`,
            episodes: x.episode_count || 0,
            aired,
            have: aired - missingEpisodes.length,
            owned: have.size,
            missingEpisodes,
            year: year(x.air_date)
        };
    });
    const aired = seasons.reduce((t, x) => t + x.aired, 0);
    const missing = seasons.reduce((t, x) => t + x.missingEpisodes.length, 0);
    return {
        seasons,
        aired,
        have: aired - missing,
        missing,
        ongoing: !!next || /returning|in production/i.test(details.status || ''),
        nextEpisode: next ? { season: next.season_number, episode: next.episode_number, date: next.air_date || '' } : undefined
    };
}

async function tvProgress(user, tmdbId, jellyfinId) {
    const d = await tmdbLimit(() => tmdb(`/tv/${tmdbId}`, {}, 6 * 3600000));
    const owned = jellyfinId ? (await libraryEpisodes(user)).get(jellyfinId) : undefined;
    return seasonProgress(d, owned);
}

/* ---------------- Radarr / Sonarr / Prowlarr / qBittorrent ---------------- */

const arr = (svc, path, init = {}, timeoutMs = 20000) => {
    if (!svc.url || !svc.key) throw new HttpError(503, 'Serviço não configurado na ponte.');
    return fetchJson(svc.url + path, {
        ...init,
        headers: { 'X-Api-Key': svc.key, 'Content-Type': 'application/json', ...(init.headers || {}) }
    }, timeoutMs);
};
const radarr = (path, init, t) => arr(config.radarr, path, init, t);
const sonarr = (path, init, t) => arr(config.sonarr, path, init, t);
const prowlarr = (path, init, t) => arr(config.prowlarr, path, init, t);

let qbitCookie = '';
async function qbit(path, form, retry = true) {
    if (!config.qbit.url) throw new HttpError(503, 'Configure QBIT_URL na ponte.');
    if (!qbitCookie) {
        const res = await fetch(`${config.qbit.url}/api/v2/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: config.qbit.url },
            body: new URLSearchParams({ username: config.qbit.user, password: config.qbit.pass })
        });
        const text = await res.text();
        const sid = (res.headers.get('set-cookie') || '').match(/SID=[^;]+/);
        if (!res.ok || !sid || text.trim() !== 'Ok.') throw new HttpError(502, 'Login no qBittorrent falhou');
        qbitCookie = sid[0];
    }
    const res = await fetch(`${config.qbit.url}/api/v2/${path}`, {
        method: form ? 'POST' : 'GET',
        headers: { Cookie: qbitCookie, Referer: config.qbit.url, ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
        body: form ? new URLSearchParams(form) : undefined
    });
    if (res.status === 403 && retry) {
        qbitCookie = '';
        return qbit(path, form, false);
    }
    if (!res.ok) throw new HttpError(502, `qBittorrent respondeu ${res.status}`);
    const text = await res.text();
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

/* ---------------- download state (library / downloading) ---------------- */

async function movieQueue() {
    if (!config.radarr.url) return new Map();
    return cached('queue:movies', 8000, async () => {
        const out = new Map();
        try {
            const q = await radarr('/api/v3/queue?pageSize=500&includeMovie=true&includeUnknownMovieItems=true');
            for (const r of q?.records || []) {
                const tmdbId = r.movie?.tmdbId;
                if (!tmdbId) continue;
                const size = r.size || 0;
                const left = r.sizeleft ?? size;
                out.set(String(tmdbId), {
                    progress: size ? Math.max(0, Math.min(100, Math.round((1 - left / size) * 1000) / 10)) : 0,
                    status: String(r.trackedDownloadState || r.status || 'downloading').toLowerCase(),
                    timeleft: r.timeleft || '',
                    downloadTitle: r.title || ''
                });
            }
        } catch (err) {
            log('radarr queue', err.message);
        }
        if (config.qbit.url) {
            try {
                const list = await qbit(`torrents/info?category=${encodeURIComponent(config.qbitMovieCategory)}`);
                for (const t of Array.isArray(list) ? list : []) {
                    const m = String(t.tags || '').match(/fp-movie-(\d+)/);
                    if (!m || out.has(m[1])) continue;
                    out.set(m[1], {
                        progress: Math.round((t.progress || 0) * 1000) / 10,
                        status: t.progress >= 1 ? 'importing' : 'downloading',
                        timeleft: '',
                        downloadTitle: safeName(t.name)
                    });
                }
            } catch (err) {
                log('qbit queue', err.message);
            }
        }
        return out;
    });
}

/** Series downloads in progress (Sonarr queue + torrents sent by the bridge), by TMDB id. */
async function tvQueue() {
    if (!config.sonarr.url && !config.qbit.url) return new Map();
    return cached('queue:tv', 8000, async () => {
        const agg = new Map();
        const add = (tmdbId, downloadId, size, left, extra) => {
            const key = String(tmdbId);
            const cur = agg.get(key) || { ids: new Set(), size: 0, left: 0, title: '', timeleft: '', status: 'downloading' };
            if (cur.ids.has(downloadId)) return; // a season pack shows once per episode
            cur.ids.add(downloadId);
            cur.size += size;
            cur.left += left;
            Object.assign(cur, extra);
            agg.set(key, cur);
        };
        if (config.sonarr.url) {
            try {
                const q = await sonarr('/api/v3/queue?pageSize=1000&includeSeries=true&includeUnknownSeriesItems=false');
                for (const r of q?.records || []) {
                    const tmdbId = r.series?.tmdbId;
                    if (!tmdbId) continue;
                    add(tmdbId, r.downloadId || r.id, r.size || 0, r.sizeleft ?? r.size ?? 0, {
                        title: r.title || '',
                        timeleft: r.timeleft || '',
                        status: String(r.trackedDownloadState || r.status || 'downloading').toLowerCase()
                    });
                }
            } catch (err) {
                log('sonarr queue', err.message);
            }
        }
        if (config.qbit.url) {
            try {
                const list = await qbit(`torrents/info?category=${encodeURIComponent(config.qbitTvCategory)}`);
                for (const t of Array.isArray(list) ? list : []) {
                    const m = String(t.tags || '').match(/fp-tv-(\d+)/);
                    if (!m || t.progress >= 1) continue;
                    add(m[1], t.hash || t.name, t.size || 1, (t.size || 1) * (1 - (t.progress || 0)), { title: safeName(t.name) });
                }
            } catch (err) {
                log('qbit tv queue', err.message);
            }
        }
        const out = new Map();
        for (const [k, v] of agg) {
            out.set(k, {
                progress: v.size ? Math.max(0, Math.min(100, Math.round((1 - v.left / v.size) * 1000) / 10)) : 0,
                status: v.status,
                timeleft: v.timeleft,
                downloadTitle: v.ids.size > 1 ? `${v.ids.size} downloads` : v.title
            });
        }
        return out;
    });
}

/** Never echo links (Prowlarr download links carry its API key). */
const safeName = n => (/^(https?|magnet):|apikey=/i.test(String(n || '')) ? '' : String(n || ''));

const progressFields = p => (p ? { have: p.have, aired: p.aired, missing: p.missing, ongoing: p.ongoing } : {});

/**
 * library     everything that is out is on disk
 * partial     series on disk with episodes missing (can still download)
 * downloading something is on its way
 * none        nothing
 * Movies that are not on disk also carry their availability (digital / cinema / upcoming).
 */
async function stateFor(user, ctx, it, full = false) {
    const key = `${it.type}:${it.tmdbId}`;
    const jellyfinId = ctx.lib.get(key);
    if (it.type === 'movie') {
        if (jellyfinId) return { state: 'library', jellyfinId };
        const dl = ctx.movies.get(String(it.tmdbId));
        if (dl) return { state: 'downloading', ...dl };
        return { state: 'none', ...(await movieAvailability(it.tmdbId, it.date)) };
    }
    const dl = ctx.tv.get(String(it.tmdbId));
    let prog = null;
    if (jellyfinId || full) prog = await tvProgress(user, it.tmdbId, jellyfinId).catch(() => null);
    const extra = full && prog ? { seasons: prog.seasons, nextEpisode: prog.nextEpisode } : {};
    if (dl) return { state: 'downloading', jellyfinId, ...dl, ...progressFields(prog), ...extra };
    if (!jellyfinId) return { state: 'none', ...progressFields(prog), ...extra };
    const complete = !prog || prog.missing === 0;
    return { state: complete ? 'library' : 'partial', jellyfinId, ...progressFields(prog), ...extra };
}

async function stateContext(user) {
    const [ lib, movies, tv ] = await Promise.all([
        libraryIndex(user).catch(() => new Map()),
        movieQueue().catch(() => new Map()),
        tvQueue().catch(() => new Map())
    ]);
    return { lib, movies, tv };
}

async function decorate(user, items, ctx) {
    const c = ctx || await stateContext(user);
    return Promise.all(items.map(async it => ({ ...it, ...(await stateFor(user, c, it)) })));
}

async function stateOf(user, type, tmdbId) {
    const ctx = await stateContext(user);
    let date;
    if (type === 'movie') date = (await tmdb(`/movie/${tmdbId}`, {}, 24 * 3600000).catch(() => null))?.release_date;
    const st = await stateFor(user, ctx, { type, tmdbId, date }, true);
    if (type === 'tv') st.following = await sonarrFollowing(tmdbId).catch(() => undefined);
    return st;
}

/* ---------------- releases ---------------- */

const PTBR_RE = /\b(dual|multi|dublado|nacional|pt-?br|ptbr|br-?dub|portuguese|portugu[eê]s)\b/i;

export function parseResolution(title) {
    const t = String(title || '');
    if (/\b(2160p|4k|uhd)\b/i.test(t)) return 2160;
    if (/\b1080[pi]\b/i.test(t)) return 1080;
    if (/\b720p\b/i.test(t)) return 720;
    if (/\b(480p|576p|dvdrip|sd)\b/i.test(t)) return 480;
    return 0;
}

export function parseSource(title) {
    const t = String(title || '');
    if (/\bremux\b/i.test(t)) return 'REMUX';
    if (/\b(blu-?ray|bdrip|brrip)\b/i.test(t)) return 'Blu-ray';
    if (/\bweb-?dl\b/i.test(t)) return 'WEB-DL';
    if (/\bwebrip\b/i.test(t)) return 'WEBRip';
    if (/\bhdtv\b/i.test(t)) return 'HDTV';
    if (/\b(cam|hdcam|ts|telesync)\b/i.test(t)) return 'CAM';
    return '';
}

/** Discount (100 = freeleech) and double upload, from Radarr or Prowlarr flag names. */
export function parseFlags(flags) {
    let free = 0;
    let doubleUp = false;
    for (const f of flags || []) {
        const s = String(f).toLowerCase();
        if (s === 'g_freeleech' || s === 'freeleech' || s === 'neutralleech') free = Math.max(free, 100);
        else if (s === 'g_freeleech75') free = Math.max(free, 75);
        else if (s === 'g_halfleech' || s === 'halfleech') free = Math.max(free, 50);
        else if (s === 'g_freeleech25') free = Math.max(free, 25);
        if (s === 'g_doubleupload' || s === 'doubleupload') doubleUp = true;
    }
    return { freeleech: free, doubleUpload: doubleUp };
}

export function ptbrOf(title, languages) {
    const langs = (languages || []).map(l => String(l).toLowerCase());
    const t = String(title || '');
    if (/\b(dual|multi)\b/i.test(t)) return 'dual';
    if (/\b(dublado|nacional|br-?dub)\b/i.test(t)) return 'dublado';
    if (langs.some(l => l.startsWith('portuguese')) || PTBR_RE.test(t)) return 'pt';
    return '';
}

const cleanIndexer = s => String(s || '').replace(/\s*\((prowlarr)\)\s*$/i, '').trim();

export function recommendScore(r) {
    let s = 0;
    if (r.rejected) s -= 5000;
    if (r.ptbr) s += 1000;
    s += (r.freeleech || 0) * 4;
    if (r.doubleUpload) s += 40;
    s += { 1080: 400, 2160: 250, 720: 150, 480: 0, 0: 50 }[r.resolution] ?? 0;
    s += Math.min(r.seeders || 0, 60) * 6;
    if (r.source === 'CAM') s -= 3000;
    if (r.size > 45 * 1024 ** 3) s -= 200;
    if (!r.seeders) s -= 800;
    return s;
}

// Releases are kept server side; the client only gets an opaque key. Prowlarr download
// links embed the Prowlarr API key, so they must never be sent to the browser.
const releaseStore = new Map();
function storeRelease(rec) {
    const key = 'r' + Math.random().toString(36).slice(2, 12);
    releaseStore.set(key, { ...rec, exp: Date.now() + 45 * 60000 });
    if (releaseStore.size > 5000) {
        for (const [k, v] of releaseStore) if (v.exp < Date.now()) releaseStore.delete(k);
    }
    return key;
}

function publicRelease(r) {
    const { downloadUrl, magnetUrl, guid, exp, ...pub } = r;
    return pub;
}

async function ensureRadarrMovie(tmdbId) {
    const existing = await radarr(`/api/v3/movie?tmdbId=${tmdbId}`);
    if (Array.isArray(existing) && existing[0]) return existing[0];
    const lookup = await radarr(`/api/v3/movie/lookup/tmdb?tmdbId=${tmdbId}`);
    const roots = await cached('radarr:roots', 60000, () => radarr('/api/v3/rootfolder'));
    const profiles = await cached('radarr:profiles', 60000, () => radarr('/api/v3/qualityprofile'));
    const rootFolderPath = config.radarrRoot || roots?.[0]?.path;
    const profile = profiles?.find(p => p.name.toLowerCase() === config.radarrProfile.toLowerCase()) || profiles?.[0];
    if (!rootFolderPath || !profile) throw new HttpError(503, 'Configure uma pasta raiz e um perfil de qualidade no Radarr.');
    // Not monitored: Radarr must never download on its own; the user picks the release.
    return radarr('/api/v3/movie', {
        method: 'POST',
        body: JSON.stringify({
            ...lookup,
            rootFolderPath,
            qualityProfileId: profile.id,
            monitored: false,
            minimumAvailability: 'released',
            addOptions: { searchForMovie: false, monitor: 'none' }
        })
    });
}

function normalizeRadarr(r, movieId) {
    const flags = parseFlags(r.indexerFlags);
    const langs = (r.languages || []).map(l => l.name).filter(Boolean);
    const rec = {
        kind: 'movie',
        origin: 'radarr',
        movieId,
        guid: r.guid,
        indexerId: r.indexerId,
        indexer: cleanIndexer(r.indexer),
        title: r.title,
        size: r.size || 0,
        seeders: r.seeders ?? 0,
        leechers: r.leechers ?? 0,
        ageDays: r.age ?? 0,
        resolution: r.quality?.quality?.resolution || parseResolution(r.title),
        source: parseSource(r.title) || String(r.quality?.quality?.source || ''),
        quality: r.quality?.quality?.name || '',
        languages: langs,
        ptbr: ptbrOf(r.title, langs),
        ...flags,
        rejected: !!r.rejected && !(r.rejections || []).every(x => /not wanted in profile|not monitored|already meets cutoff|existing file/i.test(x)),
        rejections: r.rejections || [],
        infoUrl: r.infoUrl || '',
        infoHash: (r.infoHash || '').toLowerCase()
    };
    rec.score = recommendScore(rec);
    return rec;
}

function normalizeProwlarr(r, kind = 'movie') {
    const flags = parseFlags(r.indexerFlags);
    const rec = {
        kind,
        origin: 'prowlarr',
        guid: r.guid,
        indexerId: r.indexerId,
        indexer: cleanIndexer(r.indexer),
        title: r.title,
        size: r.size || 0,
        seeders: r.seeders ?? 0,
        leechers: r.leechers ?? 0,
        ageDays: r.age ?? 0,
        resolution: parseResolution(r.title),
        source: parseSource(r.title),
        quality: '',
        languages: [],
        ptbr: ptbrOf(r.title, []),
        ...flags,
        rejected: false,
        rejections: [],
        infoUrl: r.infoUrl || '',
        infoHash: (r.infoHash || '').toLowerCase(),
        downloadUrl: r.downloadUrl || '',
        magnetUrl: r.magnetUrl || ''
    };
    rec.score = recommendScore(rec);
    return rec;
}

const isTorrent = r => r.protocol === 'torrent' || r.protocol === 1 || !r.protocol;

const words = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** A text-search hit must contain the whole movie name and, when it has a year, the right one. */
export function titleMatches(releaseTitle, name, movieYear) {
    const t = ` ${words(releaseTitle)} `;
    // leading articles are often dropped in release names ("Dark Knight Rises")
    const core = words(name).replace(/^(the|a|an|o|os|as|le|la|les|el|los|der|die|das) /, '');
    if (!t.includes(` ${core} `)) return false;
    const years = (t.match(/ (19\d\d|20\d\d) /g) || []).map(Number);
    if (!movieYear || !years.length) return true;
    return years.some(y => Math.abs(y - movieYear) <= 1);
}

const sameRelease = (a, b) => (a.infoHash && a.infoHash === b.infoHash)
    || (a.indexer.toLowerCase() === b.indexer.toLowerCase() && a.title.replace(/\W+/g, '').toLowerCase() === b.title.replace(/\W+/g, '').toLowerCase());

async function movieReleases(tmdbId) {
    const details = await tmdb(`/movie/${tmdbId}`, { language: 'en-US' }, 24 * 3600000).catch(() => null);
    const movie = await ensureRadarrMovie(tmdbId);
    const errors = [];

    const byId = radarr(`/api/v3/release?movieId=${movie.id}`, {}, 120000)
        .then(list => (list || []).map(r => normalizeRadarr(r, movie.id)))
        .catch(err => {
            errors.push('Radarr: ' + err.message);
            return [];
        });

    // Also search by title: some trackers have uploads with missing/wrong IMDb ids.
    // Brazilian trackers often use the Portuguese title, so that one is searched too.
    const clean = n => (n || '').replace(/[:'’]/g, ' ').replace(/\s+/g, ' ').trim();
    const name = clean(details?.title || movie.title);
    const ptDetails = await tmdb(`/movie/${tmdbId}`, { language: 'pt-BR' }, 24 * 3600000).catch(() => null);
    const names = [ ...new Set([ name, clean(ptDetails?.title), clean(details?.original_title) ].filter(Boolean)) ].slice(0, 3);
    const yr = movie.year || year(details?.release_date);
    const searchText = n => prowlarr(`/api/v1/search?query=${encodeURIComponent(`${n} ${yr || ''}`.trim())}&type=search&categories=2000&limit=100`, {}, 120000)
        .then(list => (list || []).filter(isTorrent).map(r => normalizeProwlarr(r)))
        .catch(err => {
            errors.push('Prowlarr: ' + err.message);
            return [];
        });
    const byText = config.prowlarr.url && names.length ?
        Promise.all(names.map(searchText)).then(lists => lists.flat()) :
        Promise.resolve([]);

    const [a, b] = await Promise.all([ byId, byText ]);
    // the text search can bring other movies with similar names ("The Dark Knight" vs "... Rises")
    const extra = [];
    for (const x of b) {
        if (!names.some(n => titleMatches(x.title, n, yr))) continue;
        if (a.some(y => sameRelease(x, y)) || extra.some(y => sameRelease(x, y))) continue;
        extra.push(x);
    }
    const all = [ ...a, ...extra ].sort((x, y) => y.score - x.score);
    return {
        movieId: movie.id,
        releases: all.map(r => ({ key: storeRelease(r), ...publicRelease(r) })),
        errors: [ ...new Set(errors) ]
    };
}

/* ---------------- series (Sonarr) ---------------- */

const pad2 = n => String(n).padStart(2, '0');

/** Season / episodes a release covers, from its name ("S02", "S02E05", "S02E05-E06", "Temporada 2"). */
export function parseEpisodes(title) {
    const t = String(title || '');
    let m = t.match(/\bS(\d{1,2})[ ._-]?E(\d{1,3})(?:[ ._-]?-?[ ._-]?E?(\d{1,3}))?\b/i);
    if (m) {
        const a = Number(m[2]);
        const b = m[3] ? Number(m[3]) : a;
        const eps = [];
        for (let e = a; e <= Math.min(b, a + 40); e++) eps.push(e);
        return { season: Number(m[1]), episodes: eps, fullSeason: false };
    }
    m = t.match(/\bS(\d{1,2})\b(?!E)/i) || t.match(/\b(?:season|temporada)[ ._-]?(\d{1,2})\b/i);
    if (m) return { season: Number(m[1]), episodes: [], fullSeason: true };
    return null;
}

async function sonarrSeriesByTmdb(tmdbId) {
    const ext = await tmdb(`/tv/${tmdbId}/external_ids`, {}, 24 * 3600000);
    const tvdbId = ext?.tvdb_id;
    if (!tvdbId) throw new HttpError(404, 'Essa série não tem ID no TVDB, então o Sonarr não consegue baixá-la.');
    const existing = await sonarr(`/api/v3/series?tvdbId=${tvdbId}`);
    return { tvdbId, series: Array.isArray(existing) ? existing[0] : undefined };
}

async function sonarrFollowing(tmdbId) {
    if (!config.sonarr.url) return undefined;
    return cached('follow:' + tmdbId, 30000, async () => {
        const { series } = await sonarrSeriesByTmdb(tmdbId);
        return !!series?.monitored;
    });
}

// Sonarr loads the episode list in the background after a series is added; searching
// before that finds nothing. Concurrent requests share one setup.
const seriesSetup = new Map();
async function waitForEpisodes(seriesId) {
    if (cache.get('eps-ready:' + seriesId)?.exp > Date.now()) return;
    for (let i = 0; i < 16; i++) {
        const eps = await sonarr(`/api/v3/episode?seriesId=${seriesId}`).catch(() => []);
        if (Array.isArray(eps) && eps.length) {
            cache.set('eps-ready:' + seriesId, { value: true, exp: Date.now() + 3600000 });
            return;
        }
        await new Promise(r => setTimeout(r, 1500));
    }
}

function ensureSonarrSeries(tmdbId) {
    const key = String(tmdbId);
    if (!seriesSetup.has(key)) {
        const job = addSonarrSeries(tmdbId)
            .then(async series => {
                await waitForEpisodes(series.id);
                return series;
            })
            .finally(() => seriesSetup.delete(key));
        seriesSetup.set(key, job);
    }
    return seriesSetup.get(key);
}

async function addSonarrSeries(tmdbId) {
    const { tvdbId, series } = await sonarrSeriesByTmdb(tmdbId);
    if (series) return series;
    const lookup = await sonarr(`/api/v3/series/lookup?term=${encodeURIComponent('tvdb:' + tvdbId)}`);
    const base = Array.isArray(lookup) ? lookup[0] : undefined;
    if (!base) throw new HttpError(404, 'O Sonarr não encontrou essa série.');
    const roots = await cached('sonarr:roots', 60000, () => sonarr('/api/v3/rootfolder'));
    const profiles = await cached('sonarr:profiles', 60000, () => sonarr('/api/v3/qualityprofile'));
    // Sonarr v3 also needs a language profile (v4 removed it)
    const langs = await cached('sonarr:langs', 60000, () => sonarr('/api/v3/languageprofile').catch(() => null));
    const rootFolderPath = config.sonarrRoot || roots?.[0]?.path;
    const profile = profiles?.find(x => x.name.toLowerCase() === config.sonarrProfile.toLowerCase()) || profiles?.[0];
    if (!rootFolderPath || !profile) throw new HttpError(503, 'Configure uma pasta raiz e um perfil de qualidade no Sonarr.');
    const details = await tmdb(`/tv/${tmdbId}`, {}, 24 * 3600000).catch(() => null);
    const anime = details?.original_language === 'ja' && (details?.genres || []).some(g => g.id === 16);
    // Not monitored: nothing is downloaded unless the user picks it (or turns on "Acompanhar").
    const added = await sonarr('/api/v3/series', {
        method: 'POST',
        body: JSON.stringify({
            ...base,
            rootFolderPath,
            qualityProfileId: profile.id,
            ...(Array.isArray(langs) && langs[0] ? { languageProfileId: langs[0].id } : {}),
            seriesType: anime ? 'anime' : (base.seriesType || 'standard'),
            seasonFolder: true,
            monitored: false,
            seasons: (base.seasons || []).map(x => ({ ...x, monitored: false })),
            addOptions: { monitor: 'none', searchForMissingEpisodes: false, searchForCutoffUnmetEpisodes: false }
        })
    });
    cache.delete('follow:' + tmdbId);
    return added;
}

/** "Acompanhar": Sonarr downloads new episodes by itself as they air. */
async function setFollowing(tmdbId, on) {
    const series = await ensureSonarrSeries(tmdbId);
    if (on) {
        try {
            await sonarr('/api/v3/seasonpass', {
                method: 'POST',
                body: JSON.stringify({ series: [ { id: series.id, monitored: true } ], monitoringOptions: { monitor: 'future' } })
            });
        } catch {
            // fallback: monitor the series and its last season
            const lastSeason = Math.max(0, ...(series.seasons || []).map(x => x.seasonNumber));
            await sonarr(`/api/v3/series/${series.id}`, {
                method: 'PUT',
                body: JSON.stringify({ ...series, monitored: true, monitorNewItems: 'all', seasons: (series.seasons || []).map(x => ({ ...x, monitored: x.seasonNumber === lastSeason })) })
            });
        }
    } else {
        const fresh = await sonarr(`/api/v3/series/${series.id}`);
        await sonarr(`/api/v3/series/${series.id}`, { method: 'PUT', body: JSON.stringify({ ...fresh, monitored: false }) });
    }
    cache.delete('follow:' + tmdbId);
    log('follow', tmdbId, on);
    return { ok: true, following: on };
}

function normalizeSonarr(r, seriesId) {
    const flags = parseFlags(r.indexerFlags);
    const langs = (r.languages || []).map(l => l.name).filter(Boolean);
    const parsed = parseEpisodes(r.title);
    const episodes = (r.mappedEpisodeNumbers?.length ? r.mappedEpisodeNumbers : r.episodeNumbers) || parsed?.episodes || [];
    const rec = {
        kind: 'tv',
        origin: 'sonarr',
        seriesId,
        guid: r.guid,
        indexerId: r.indexerId,
        indexer: cleanIndexer(r.indexer),
        title: r.title,
        size: r.size || 0,
        seeders: r.seeders ?? 0,
        leechers: r.leechers ?? 0,
        ageDays: r.age ?? 0,
        resolution: r.quality?.quality?.resolution || parseResolution(r.title),
        source: parseSource(r.title) || String(r.quality?.quality?.source || ''),
        quality: r.quality?.quality?.name || '',
        languages: langs,
        ptbr: ptbrOf(r.title, langs),
        ...flags,
        seasonNumber: r.mappedSeasonNumber ?? r.seasonNumber ?? parsed?.season,
        episodes,
        fullSeason: !!r.fullSeason || (!!parsed?.fullSeason && !episodes.length),
        rejected: !!r.rejected && !(r.rejections || []).every(x => /not wanted in profile|not monitored|already meets cutoff|existing file|is not monitored/i.test(x)),
        rejections: r.rejections || [],
        infoUrl: r.infoUrl || '',
        infoHash: (r.infoHash || '').toLowerCase()
    };
    rec.score = recommendScore(rec) + (rec.fullSeason ? 120 : 0);
    return rec;
}

function tvTextRelease(r, season) {
    const rec = normalizeProwlarr(r, 'tv');
    const parsed = parseEpisodes(r.title);
    if (!parsed || parsed.season !== season) return null;
    rec.seasonNumber = parsed.season;
    rec.episodes = parsed.episodes;
    rec.fullSeason = parsed.fullSeason;
    rec.score += rec.fullSeason ? 120 : 0;
    return rec;
}

async function tvReleases(tmdbId, season) {
    const series = await ensureSonarrSeries(tmdbId);
    const errors = [];
    const byId = sonarr(`/api/v3/release?seriesId=${series.id}&seasonNumber=${season}`, {}, 150000)
        .then(list => (list || []).map(r => normalizeSonarr(r, series.id)).filter(r => r.seasonNumber == null || r.seasonNumber === season))
        .catch(err => {
            errors.push('Sonarr: ' + err.message);
            return [];
        });

    const clean = n => (n || '').replace(/[:'’]/g, ' ').replace(/\s+/g, ' ').trim();
    const [ en, pt ] = await Promise.all([
        tmdb(`/tv/${tmdbId}`, { language: 'en-US' }, 24 * 3600000).catch(() => null),
        tmdb(`/tv/${tmdbId}`, {}, 24 * 3600000).catch(() => null)
    ]);
    const names = [ ...new Set([ clean(en?.name || series.title), clean(pt?.name), clean(en?.original_name) ].filter(Boolean)) ].slice(0, 3);
    const searchText = n => prowlarr(`/api/v1/search?query=${encodeURIComponent(`${n} S${pad2(season)}`)}&type=search&categories=5000&limit=100`, {}, 120000)
        .then(list => (list || []).filter(isTorrent).map(r => tvTextRelease(r, season)).filter(Boolean))
        .catch(err => {
            errors.push('Prowlarr: ' + err.message);
            return [];
        });
    const byText = config.prowlarr.url && names.length ? Promise.all(names.map(searchText)).then(l => l.flat()) : Promise.resolve([]);

    const [ a, b ] = await Promise.all([ byId, byText ]);
    const extra = [];
    for (const x of b) {
        if (!names.some(n => titleMatches(x.title, n))) continue;
        if (a.some(y => sameRelease(x, y)) || extra.some(y => sameRelease(x, y))) continue;
        extra.push(x);
    }
    const all = [ ...a, ...extra ].sort((x, y) => y.score - x.score);
    return {
        seriesId: series.id,
        season,
        releases: all.map(r => ({ key: storeRelease(r), ...publicRelease(r) })),
        errors: [ ...new Set(errors) ]
    };
}

async function grabRelease(key, tmdbId) {
    const r = releaseStore.get(key);
    if (!r || r.exp < Date.now()) throw new HttpError(410, 'As opções expiraram. Busque de novo.');
    if (r.origin === 'sonarr') {
        try {
            await sonarr('/api/v3/release', { method: 'POST', body: JSON.stringify({ guid: r.guid, indexerId: r.indexerId }) }, 60000);
        } catch (err) {
            if (err.status === 404) throw new HttpError(410, 'As opções expiraram no Sonarr. Busque de novo.');
            throw err;
        }
    } else if (r.origin === 'radarr') {
        try {
            await radarr('/api/v3/release', {
                method: 'POST',
                body: JSON.stringify({ guid: r.guid, indexerId: r.indexerId, movieId: r.movieId })
            }, 60000);
        } catch (err) {
            if (err.status === 404) throw new HttpError(410, 'As opções expiraram no Radarr. Busque de novo.');
            throw err;
        }
    } else {
        const source = r.downloadUrl || r.magnetUrl;
        if (!source) throw new HttpError(400, 'Essa opção não tem link de download.');
        const tv = r.kind === 'tv';
        const res = await qbit('torrents/add', {
            urls: source,
            category: tv ? config.qbitTvCategory : config.qbitMovieCategory,
            tags: `freitas,fp-${tv ? 'tv' : 'movie'}-${tmdbId}`
        });
        if (String(res).trim() !== 'Ok.') throw new HttpError(502, 'O qBittorrent recusou o torrent.');
    }
    cache.delete('queue:movies');
    cache.delete('queue:tv');
    releaseStore.delete(key);
    log('grab', r.origin, r.indexer, r.title);
    return { ok: true };
}

/* ---------------- title details ---------------- */

function pickLogo(images) {
    const logos = images?.logos || [];
    const pick = logos.find(l => l.iso_639_1 === 'pt') || logos.find(l => l.iso_639_1 === 'en') || logos.find(l => !l.iso_639_1);
    return pick ? IMG + 'w500' + pick.file_path : '';
}

function certificationBR(type, d) {
    if (type === 'movie') {
        const br = d.release_dates?.results?.find(r => r.iso_3166_1 === 'BR');
        return br?.release_dates?.map(x => x.certification).find(Boolean) || '';
    }
    return d.content_ratings?.results?.find(r => r.iso_3166_1 === 'BR')?.rating || '';
}

async function titleDetails(user, type, tmdbId) {
    const append = type === 'movie' ? 'external_ids,credits,videos,images,release_dates' : 'external_ids,credits,videos,images,content_ratings';
    const d = await tmdb(`/${type}/${tmdbId}`, { append_to_response: append, include_image_language: 'pt,en,null' }, 24 * 3600000);
    let overview = d.overview;
    if (!overview) {
        const en = await tmdb(`/${type}/${tmdbId}`, { language: 'en-US' }, 24 * 3600000).catch(() => null);
        overview = en?.overview || '';
    }
    const trailer = (d.videos?.results || []).find(v => v.site === 'YouTube' && v.type === 'Trailer');
    const crew = d.credits?.crew || [];
    return {
        ...mapTmdbItem(d, type),
        overview,
        imdbId: d.external_ids?.imdb_id || d.imdb_id || '',
        tvdbId: d.external_ids?.tvdb_id || undefined,
        runtime: d.runtime || d.episode_run_time?.[0] || undefined,
        genres: (d.genres || []).map(g => g.name),
        certification: certificationBR(type, d),
        logo: pickLogo(d.images),
        tagline: d.tagline || '',
        cast: (d.credits?.cast || []).slice(0, 12).map(c => ({ name: c.name, character: c.character, photo: c.profile_path ? IMG + 'w185' + c.profile_path : '' })),
        directors: type === 'movie' ? crew.filter(c => c.job === 'Director').map(c => c.name) : (d.created_by || []).map(c => c.name),
        studios: (d.production_companies || []).slice(0, 2).map(c => c.name),
        seasons: type === 'tv' ? (d.seasons || []).filter(s => s.season_number > 0).map(s => ({ number: s.season_number, name: s.name, episodes: s.episode_count, year: year(s.air_date) })) : undefined,
        trailer: trailer ? `https://www.youtube.com/watch?v=${trailer.key}` : '',
        status: d.status || '',
        ...(await stateOf(user, type, tmdbId))
    };
}

/* ---------------- catalog & search ---------------- */

async function sectionItems(s) {
    const params = { ...(s.params ? s.params() : {}), ...(s.region ? { region: config.region } : {}) };
    const pages = await Promise.all(Array.from({ length: s.pages || 1 }, (_, i) => tmdb(s.path, { ...params, page: i + 1 }).catch(err => {
        if (i === 0) throw err;
        return null;
    })));
    const seen = new Set();
    const out = [];
    for (const body of pages) {
        for (const r of body?.results || []) {
            if (!r.poster_path || seen.has(r.id)) continue;
            seen.add(r.id);
            out.push(mapTmdbItem(r, s.type));
        }
    }
    return out;
}

function keepFor(only, it) {
    if (!only || it.type !== 'movie') return true;
    if (only === 'digital') return it.state !== 'none' || it.availability === 'digital';
    return it.state === 'none' && it.availability === only;
}

async function discover(user) {
    const ctx = await stateContext(user);
    const sections = await Promise.all(SECTIONS.map(async s => {
        try {
            const items = await decorate(user, await sectionItems(s), ctx);
            let list = items.filter(it => keepFor(s.only, it));
            if (s.only === 'upcoming') list.sort((a, b) => String(a.availableDate || a.date).localeCompare(String(b.availableDate || b.date)));
            list = list.slice(0, 20);
            return { id: s.id, title: s.title, items: list };
        } catch (err) {
            log('section', s.id, err.message);
            return { id: s.id, title: s.title, items: [], error: err.message };
        }
    }));
    const ok = sections.filter(s => s.items.length);
    if (!ok.length) {
        const why = sections.find(s => s.error)?.error || 'nenhum resultado';
        throw new HttpError(502, `O TMDB não respondeu (${why}). Confira a TMDB_API_KEY e se o servidor acessa api.themoviedb.org.`);
    }
    return { sections: ok };
}

async function byTmdbId(type, id) {
    try {
        const d = await tmdb(`/${type}/${id}`, {}, 24 * 3600000);
        return d?.id ? mapTmdbItem(d, type) : null;
    } catch {
        return null;
    }
}

/**
 * Finds any movie or series, not only what is in the library. Accepts a name, a TMDB id
 * ("550", "tmdb:550", "tv 1399"), a TMDB link or an IMDb id / link ("tt0137523").
 */
export function parseQuery(q) {
    const text = String(q || '').trim().slice(0, 200);
    let m = text.match(/themoviedb\.org\/(movie|tv)\/(\d+)/i);
    if (m) return { ids: [ [ m[1].toLowerCase(), Number(m[2]) ] ] };
    m = text.match(/\b(tt\d{5,10})\b/i);
    if (m) return { imdb: m[1].toLowerCase() };
    m = text.match(/^(filme|movie|s[ée]rie|serie|tv|anime)\s*[:#/ ]\s*(\d{1,8})$/i);
    if (m) return { ids: [ [ /^(filme|movie)$/i.test(m[1]) ? 'movie' : 'tv', Number(m[2]) ] ] };
    m = text.match(/^(?:tmdb\s*[:#]?\s*)(\d{1,8})$/i);
    if (m) return { ids: [ [ 'movie', Number(m[1]) ], [ 'tv', Number(m[1]) ] ] };
    // a bare number may be an id or a title ("1917", "300")
    m = text.match(/^\d{1,8}$/);
    if (m) return { ids: [ [ 'movie', Number(text) ], [ 'tv', Number(text) ] ], text };
    return { text };
}

async function search(user, q) {
    const parsed = parseQuery(q);
    const found = [];
    if (parsed.ids) found.push(...(await Promise.all(parsed.ids.map(([ t, id ]) => byTmdbId(t, id)))).filter(Boolean));
    if (parsed.imdb) {
        const r = await tmdb(`/find/${parsed.imdb}`, { external_source: 'imdb_id' }, 24 * 3600000).catch(() => null);
        for (const x of r?.movie_results || []) found.push(mapTmdbItem(x, 'movie'));
        for (const x of r?.tv_results || []) found.push(mapTmdbItem(x, 'tv'));
    }
    if (parsed.text && parsed.text.length >= 2) {
        const pages = await Promise.all([ 1, 2 ].map(page => tmdb('/search/multi', { query: parsed.text, include_adult: false, page }, 3600000).catch(err => {
            if (page === 1) throw err;
            return null;
        })));
        for (const body of pages) {
            for (const r of body?.results || []) {
                if (r.media_type !== 'movie' && r.media_type !== 'tv') continue;
                found.push(mapTmdbItem(r));
            }
        }
    }
    const seen = new Set();
    const unique = found.filter(it => {
        const k = `${it.type}:${it.tmdbId}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    }).slice(0, 40);
    // titles without a poster are usually obscure duplicates; keep them last
    unique.sort((a, b) => Number(!a.poster) - Number(!b.poster));
    return { query: String(q || '').trim(), items: await decorate(user, unique) };
}

/* ---------------- HTTP ---------------- */

async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
        size += c.length;
        if (size > 64 * 1024) throw new HttpError(413, 'corpo grande demais');
        chunks.push(c);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text) return {};
    try {
        return JSON.parse(text);
    } catch {
        throw new HttpError(400, 'JSON inválido');
    }
}

function send(res, status, body, origin) {
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': origin || '*',
        'Access-Control-Allow-Headers': 'Authorization, X-Emby-Token, X-Emby-Authorization, Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Max-Age': '600',
        Vary: 'Origin',
        'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify(body));
}

const intId = s => {
    const n = Number(s);
    if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'id inválido');
    return n;
};
const typeOf = s => {
    if (s !== 'movie' && s !== 'tv') throw new HttpError(400, 'tipo inválido');
    return s;
};

async function route(req, url) {
    const p = url.pathname.replace(/\/+$/, '') || '/';
    if (p === '/' || p === '/health') {
        return { ok: true, name: 'freitas-bridge', configured: { tmdb: !!config.tmdbKey, radarr: !!config.radarr.url, sonarr: !!config.sonarr.url, prowlarr: !!config.prowlarr.url, qbittorrent: !!config.qbit.url } };
    }
    const user = await authenticate(req);

    if (p === '/api/me') {
        return { name: user.name, canDownload: canDownload(user), services: { movies: !!config.radarr.url, series: !!config.sonarr.url } };
    }

    if (p === '/api/discover') return discover(user);

    if (p === '/api/search') return search(user, url.searchParams.get('q') || '');

    let m = p.match(/^\/api\/title\/(movie|tv)\/(\d+)$/);
    if (m) return titleDetails(user, typeOf(m[1]), intId(m[2]));

    m = p.match(/^\/api\/state\/(movie|tv)\/(\d+)$/);
    if (m) return stateOf(user, typeOf(m[1]), intId(m[2]));

    m = p.match(/^\/api\/releases\/movie\/(\d+)$/);
    if (m) {
        if (!canDownload(user)) throw new HttpError(403, 'Seu usuário não pode baixar.');
        return movieReleases(intId(m[1]));
    }

    m = p.match(/^\/api\/releases\/tv\/(\d+)$/);
    if (m) {
        if (!canDownload(user)) throw new HttpError(403, 'Seu usuário não pode baixar.');
        if (!config.sonarr.url) throw new HttpError(503, 'Configure o Sonarr na ponte (SONARR_URL e SONARR_API_KEY).');
        const season = Number(url.searchParams.get('season'));
        if (!Number.isInteger(season) || season < 0) throw new HttpError(400, 'temporada inválida');
        return tvReleases(intId(m[1]), season);
    }

    if (p === '/api/follow' && req.method === 'POST') {
        if (!canDownload(user)) throw new HttpError(403, 'Seu usuário não pode baixar.');
        if (!config.sonarr.url) throw new HttpError(503, 'Configure o Sonarr na ponte (SONARR_URL e SONARR_API_KEY).');
        const body = await readBody(req);
        return setFollowing(intId(body.tmdbId), !!body.on);
    }

    if (p === '/api/grab' && req.method === 'POST') {
        if (!canDownload(user)) throw new HttpError(403, 'Seu usuário não pode baixar.');
        const body = await readBody(req);
        return grabRelease(String(body.key || ''), intId(body.tmdbId));
    }

    throw new HttpError(404, 'não encontrado');
}

export function createServer() {
    return http.createServer(async (req, res) => {
        const origin = req.headers.origin;
        if (req.method === 'OPTIONS') return send(res, 204, {}, origin);
        const url = new URL(req.url, 'http://bridge');
        const started = Date.now();
        try {
            const body = await route(req, url);
            send(res, 200, body, origin);
            let extra = body?.sections ? ` seções=${body.sections.length} títulos=${body.sections.reduce((n, x) => n + x.items.length, 0)}` : '';
            if (body?.query !== undefined) extra = ` busca="${body.query}" resultados=${body.items.length}`;
            if (url.pathname !== '/health') log(req.method, url.pathname, 200, `${Date.now() - started}ms${extra}`);
        } catch (err) {
            const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
            log(req.method, url.pathname, status, `${Date.now() - started}ms`, err.message);
            send(res, status, { error: err.message || 'erro' }, origin);
        }
    });
}

if (import.meta.url === `file://${process.argv[1]}`) {
    if (!config.jellyfin) {
        console.error('Defina JELLYFIN_URL (ex.: http://192.168.1.250:8097)');
        process.exit(1);
    }
    createServer().listen(config.port, () => {
        log(`freitas-bridge na porta ${config.port}`, JSON.stringify({
            tmdb: !!config.tmdbKey, radarr: !!config.radarr.url, sonarr: !!config.sonarr.url, prowlarr: !!config.prowlarr.url, qbittorrent: !!config.qbit.url, allowDownload: config.allowDownload
        }));
    });
}
