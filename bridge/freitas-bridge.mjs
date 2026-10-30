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
 *   PROWLARR_URL / PROWLARR_API_KEY                         (extra search by title)
 *   QBIT_URL / QBIT_USER / QBIT_PASS                        (grabs found only by title)
 *   QBIT_MOVIE_CATEGORY   radarr
 *   RADARR_ROOT_FOLDER    first root folder in Radarr
 *   RADARR_QUALITY_PROFILE  name; first profile in Radarr when empty
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
    prowlarr: { url: trimSlash(env.PROWLARR_URL), key: (env.PROWLARR_API_KEY || '').trim() },
    qbit: { url: trimSlash(env.QBIT_URL), user: env.QBIT_USER || '', pass: env.QBIT_PASS || '' },
    qbitMovieCategory: env.QBIT_MOVIE_CATEGORY || 'radarr',
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

const users = new Map();
async function authenticate(req) {
    const token = tokenOf(req);
    if (!token) throw new HttpError(401, 'Faça login no Freitas+.');
    const hit = users.get(token);
    if (hit && hit.exp > Date.now()) return hit.user;
    let me;
    try {
        me = await fetchJson(`${config.jellyfin}/Users/Me`, { headers: { 'X-Emby-Token': token } }, 10000);
    } catch (err) {
        if (err.status === 401 || err.status === 403) throw new HttpError(401, 'Sessão do Jellyfin inválida.');
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

const SECTIONS = [
    { id: 'trending-movies', title: 'Filmes em alta', type: 'movie', path: '/trending/movie/week' },
    { id: 'now-playing', title: 'Lançamentos nos cinemas', type: 'movie', path: '/movie/now_playing', region: true },
    { id: 'trending-tv', title: 'Séries em alta', type: 'tv', path: '/trending/tv/week' },
    { id: 'anime', title: 'Animes em alta', type: 'tv', path: '/discover/tv', params: { with_genres: 16, with_original_language: 'ja', sort_by: 'popularity.desc' } },
    { id: 'upcoming', title: 'Em breve nos cinemas', type: 'movie', path: '/movie/upcoming', region: true },
    { id: 'popular-movies', title: 'Filmes populares', type: 'movie', path: '/movie/popular', region: true },
    { id: 'top-movies', title: 'Filmes mais bem avaliados', type: 'movie', path: '/movie/top_rated' },
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
        const body = await fetchJson(url.toString(), { headers: { 'X-Emby-Token': user.token } }, 20000);
        const map = new Map();
        for (const it of body?.Items || []) {
            const ids = it.ProviderIds || {};
            const tmdbId = ids.Tmdb || ids.TMDB || ids.tmdb;
            if (tmdbId) map.set(`${it.Type === 'Series' ? 'tv' : 'movie'}:${tmdbId}`, it.Id);
        }
        return map;
    });
}

/* ---------------- Radarr / Prowlarr / qBittorrent ---------------- */

const arr = (svc, path, init = {}, timeoutMs = 20000) => {
    if (!svc.url || !svc.key) throw new HttpError(503, 'Serviço não configurado na ponte.');
    return fetchJson(svc.url + path, {
        ...init,
        headers: { 'X-Api-Key': svc.key, 'Content-Type': 'application/json', ...(init.headers || {}) }
    }, timeoutMs);
};
const radarr = (path, init, t) => arr(config.radarr, path, init, t);
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
                    title: r.title || ''
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
                        title: t.name || ''
                    });
                }
            } catch (err) {
                log('qbit queue', err.message);
            }
        }
        return out;
    });
}

async function stateOf(user, type, tmdbId) {
    const lib = await libraryIndex(user).catch(() => new Map());
    const jellyfinId = lib.get(`${type}:${tmdbId}`);
    if (jellyfinId) return { state: 'library', jellyfinId };
    if (type === 'movie') {
        const dl = (await movieQueue()).get(String(tmdbId));
        if (dl) return { state: 'downloading', ...dl };
    }
    return { state: 'none' };
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

function normalizeProwlarr(r) {
    const flags = parseFlags(r.indexerFlags);
    const rec = {
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
        .then(list => (list || []).filter(r => r.protocol === 'torrent' || r.protocol === 1 || !r.protocol).map(normalizeProwlarr))
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

async function grabRelease(key, tmdbId) {
    const r = releaseStore.get(key);
    if (!r || r.exp < Date.now()) throw new HttpError(410, 'As opções expiraram. Busque de novo.');
    if (r.origin === 'radarr') {
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
        const res = await qbit('torrents/add', {
            urls: source,
            category: config.qbitMovieCategory,
            tags: `freitas,fp-movie-${tmdbId}`
        });
        if (String(res).trim() !== 'Ok.') throw new HttpError(502, 'O qBittorrent recusou o torrent.');
    }
    cache.delete('queue:movies');
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
        return { ok: true, name: 'freitas-bridge', configured: { tmdb: !!config.tmdbKey, radarr: !!config.radarr.url, prowlarr: !!config.prowlarr.url, qbittorrent: !!config.qbit.url } };
    }
    const user = await authenticate(req);

    if (p === '/api/me') {
        return { name: user.name, canDownload: canDownload(user), services: { movies: !!config.radarr.url, series: false } };
    }

    if (p === '/api/discover') {
        const lib = await libraryIndex(user).catch(() => new Map());
        const queue = await movieQueue().catch(() => new Map());
        const sections = await Promise.all(SECTIONS.map(async s => {
            try {
                const body = await tmdb(s.path, { ...(s.params || {}), ...(s.region ? { region: config.region } : {}) });
                const items = (body?.results || []).filter(r => r.poster_path).slice(0, 20).map(r => {
                    const it = mapTmdbItem(r, s.type);
                    const jellyfinId = lib.get(`${it.type}:${it.tmdbId}`);
                    const dl = it.type === 'movie' ? queue.get(String(it.tmdbId)) : undefined;
                    return { ...it, state: jellyfinId ? 'library' : (dl ? 'downloading' : 'none'), jellyfinId, progress: dl?.progress };
                });
                return { id: s.id, title: s.title, items };
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

    let m = p.match(/^\/api\/title\/(movie|tv)\/(\d+)$/);
    if (m) return titleDetails(user, typeOf(m[1]), intId(m[2]));

    m = p.match(/^\/api\/state\/(movie|tv)\/(\d+)$/);
    if (m) return stateOf(user, typeOf(m[1]), intId(m[2]));

    m = p.match(/^\/api\/releases\/movie\/(\d+)$/);
    if (m) {
        if (!canDownload(user)) throw new HttpError(403, 'Seu usuário não pode baixar.');
        return movieReleases(intId(m[1]));
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
        try {
            const body = await route(req, url);
            send(res, 200, body, origin);
        } catch (err) {
            const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
            if (status >= 500) log('error', req.method, url.pathname, err.message);
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
            tmdb: !!config.tmdbKey, radarr: !!config.radarr.url, prowlarr: !!config.prowlarr.url, qbittorrent: !!config.qbit.url, allowDownload: config.allowDownload
        }));
    });
}
