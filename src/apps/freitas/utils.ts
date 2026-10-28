import type { Api } from '@jellyfin/sdk';
import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import type { MediaStream } from '@jellyfin/sdk/lib/generated-client/models/media-stream';
import { ImageType } from '@jellyfin/sdk/lib/generated-client/models/image-type';
import { getImageApi } from '@jellyfin/sdk/lib/utils/api/image-api';
import type { FocusEvent } from 'react';

const TICKS_PER_MINUTE = 600000000;

type MakeUrl = (id: string, imgType: ImageType, tag?: string | null) => string;

function backdropUrl(item: BaseItemDto, make: MakeUrl) {
    if (item.Id && item.BackdropImageTags?.length) return make(item.Id, ImageType.Backdrop, item.BackdropImageTags[0]);
    if (item.ParentBackdropItemId && item.ParentBackdropImageTags?.length) {
        return make(item.ParentBackdropItemId, ImageType.Backdrop, item.ParentBackdropImageTags[0]);
    }
    return undefined;
}

function logoUrl(item: BaseItemDto, make: MakeUrl) {
    if (item.Id && item.ImageTags?.Logo) return make(item.Id, ImageType.Logo, item.ImageTags.Logo);
    if (item.ParentLogoItemId && item.ParentLogoImageTag) return make(item.ParentLogoItemId, ImageType.Logo, item.ParentLogoImageTag);
    return undefined;
}

function thumbUrl(item: BaseItemDto, make: MakeUrl) {
    if (item.Id && item.ImageTags?.Thumb) return make(item.Id, ImageType.Thumb, item.ImageTags.Thumb);
    // Episodes: the primary image is already a 16:9 still
    if (item.Id && item.Type === 'Episode' && item.ImageTags?.Primary) return make(item.Id, ImageType.Primary, item.ImageTags.Primary);
    if (item.ParentThumbItemId && item.ParentThumbImageTag) return make(item.ParentThumbItemId, ImageType.Thumb, item.ParentThumbImageTag);
    return backdropUrl(item, make);
}

function primaryUrl(item: BaseItemDto, make: MakeUrl) {
    if (item.Id && item.ImageTags?.Primary) return make(item.Id, ImageType.Primary, item.ImageTags.Primary);
    if (item.SeriesId && item.SeriesPrimaryImageTag) return make(item.SeriesId, ImageType.Primary, item.SeriesPrimaryImageTag);
    return undefined;
}

/** Builds an image url for an item, falling back to parent images when possible. */
export function imageUrl(
    api: Api | undefined,
    item: BaseItemDto | undefined,
    type: ImageType,
    width: number
): string | undefined {
    if (!api || !item?.Id) return undefined;
    const fillWidth = Math.ceil(width * Math.min(window.devicePixelRatio || 1, 2));
    const make: MakeUrl = (id, imgType, tag) => getImageApi(api).getItemImageUrlById(id, imgType, {
        fillWidth,
        quality: 90,
        tag: tag ?? undefined
    });

    switch (type) {
        case ImageType.Backdrop: return backdropUrl(item, make);
        case ImageType.Logo: return logoUrl(item, make);
        case ImageType.Thumb: return thumbUrl(item, make);
        default: return primaryUrl(item, make);
    }
}

/** Deterministic hue for an item, used for gradient placeholders and accents. */
export function itemHue(item?: BaseItemDto | null): number {
    const s = item?.Id || item?.Name || '';
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h * 31) + s.charCodeAt(i)) % 360;
    return h;
}

export function posterPlaceholder(item?: BaseItemDto | null) {
    const h = itemHue(item);
    return `radial-gradient(120% 70% at 28% 0%, hsl(${h} 60% 55%) 0%, transparent 62%), linear-gradient(165deg, hsl(${(h + 28) % 360} 55% 32%) 0%, hsl(${(h + 60) % 360} 45% 12%) 100%)`;
}

export function isAnime(item?: BaseItemDto | null) {
    const genres = (item?.Genres || []).map(g => g.toLowerCase());
    return genres.includes('anime') || genres.includes('animação japonesa');
}

/** "Filme", "Série" or "Anime" */
export function kindLabel(item?: BaseItemDto | null): string {
    if (!item) return '';
    if (isAnime(item)) return 'Anime';
    switch (item.Type) {
        case 'Movie': return 'Filme';
        case 'Series':
        case 'Season':
        case 'Episode': return 'Série';
        case 'BoxSet': return 'Coleção';
        default: return '';
    }
}

/** "Filme · Ação" */
export function plateLabel(item?: BaseItemDto | null): string {
    const kind = kindLabel(item);
    const genre = (item?.Genres || []).find(g => g.toLowerCase() !== 'anime');
    return [kind, genre].filter(Boolean).join(' · ');
}

export function formatRuntime(ticks?: number | null): string {
    if (!ticks) return '';
    const minutes = Math.round(ticks / TICKS_PER_MINUTE);
    if (minutes < 60) return `${minutes} min`;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m ? `${h} h ${m} min` : `${h} h`;
}

export function remainingLabel(item: BaseItemDto): string {
    const total = item.RunTimeTicks || 0;
    const pos = item.UserData?.PlaybackPositionTicks || 0;
    if (!total || !pos) return '';
    return `restam ${formatRuntime(Math.max(total - pos, TICKS_PER_MINUTE))}`;
}

export function episodeCode(item: BaseItemDto): string {
    if (item.Type !== 'Episode') return '';
    const s = item.ParentIndexNumber;
    const e = item.IndexNumber;
    if (s == null || e == null) return '';
    return `T${s} · E${e}`;
}

export function progressPercent(item?: BaseItemDto | null): number {
    const p = item?.UserData?.PlayedPercentage;
    if (p) return Math.max(2, Math.min(100, p));
    const total = item?.RunTimeTicks || 0;
    const pos = item?.UserData?.PlaybackPositionTicks || 0;
    return total && pos ? Math.max(2, Math.min(100, (pos / total) * 100)) : 0;
}

export function formatRating(value?: number | null): string {
    if (!value) return '';
    return value.toFixed(1).replace('.', ',');
}

/** "BR-14" -> "14", "PG-13" stays */
export function formatOfficialRating(value?: string | null): string {
    if (!value) return '';
    return value.replace(/^[A-Z]{2}-/, '');
}

export function lengthLabel(item: BaseItemDto): string {
    if (item.Type === 'Series') {
        const seasons = item.ChildCount || 0;
        if (seasons) return seasons === 1 ? '1 temporada' : `${seasons} temporadas`;
        return '';
    }
    return formatRuntime(item.RunTimeTicks);
}

export function isRecent(item: BaseItemDto, days = 14): boolean {
    if (!item.DateCreated) return false;
    return Date.now() - new Date(item.DateCreated).getTime() < days * 86400000;
}

const LANGS: Record<string, string> = {
    por: 'Português', pt: 'Português', 'pt-br': 'Português', pob: 'Português',
    eng: 'Inglês', en: 'Inglês',
    spa: 'Espanhol', es: 'Espanhol',
    jpn: 'Japonês', ja: 'Japonês',
    fre: 'Francês', fra: 'Francês', fr: 'Francês',
    ger: 'Alemão', deu: 'Alemão', de: 'Alemão',
    ita: 'Italiano', it: 'Italiano',
    kor: 'Coreano', ko: 'Coreano',
    chi: 'Chinês', zho: 'Chinês', zh: 'Chinês',
    rus: 'Russo', ru: 'Russo'
};

function languageName(stream: MediaStream): string {
    const code = (stream.Language || '').toLowerCase();
    return LANGS[code] || (code ? code.toUpperCase() : '');
}

/** "Português, Inglês · Legendas em 3 idiomas" */
export function audioSubtitleLabel(item?: BaseItemDto | null): string {
    const streams = item?.MediaSources?.[0]?.MediaStreams || item?.MediaStreams || [];
    if (!streams.length) return '';
    const audio = Array.from(new Set(streams.filter(s => s.Type === 'Audio').map(languageName).filter(Boolean)));
    const subs = Array.from(new Set(streams.filter(s => s.Type === 'Subtitle').map(languageName).filter(Boolean)));
    const parts: string[] = [];
    if (audio.length) parts.push(audio.join(', '));
    if (subs.length) parts.push(subs.length === 1 ? `Legendas em ${subs[0]}` : `Legendas em ${subs.length} idiomas`);
    return parts.join(' · ');
}

/**
 * Keeps the focused element (TV remote / keyboard) comfortably on screen:
 * horizontally inside its row and vertically below the floating header.
 */
export function ensureVisible(el: HTMLElement, instant = false) {
    if (el.closest('.fp-header')) return;
    const behavior: ScrollBehavior = instant ? 'auto' : 'smooth';

    // Hero controls: show the hero from the top
    if (el.closest('.fp-hero')) {
        if (window.scrollY > 0) window.scrollTo({ top: 0, behavior });
        return;
    }

    const scroller = el.closest<HTMLElement>('.fp-scroller');
    if (scroller) {
        const s = scroller.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        const pad = 48;
        if (r.left < s.left + pad) {
            scroller.scrollBy({ left: r.left - s.left - pad, behavior });
        } else if (r.right > s.right - pad) {
            scroller.scrollBy({ left: r.right - s.right + pad, behavior });
        }
    }

    const header = document.querySelector('.fp-header');
    const top = (header?.getBoundingClientRect().bottom || 0) + 56;
    const r = el.getBoundingClientRect();
    // include the row title when the element sits in a row
    const row = el.closest<HTMLElement>('.fp-row');
    const rowTop = row ? row.getBoundingClientRect().top : r.top;
    const bottomLimit = window.innerHeight - 32;
    if (rowTop < top) {
        window.scrollBy({ top: rowTop - top, behavior });
    } else if (r.bottom > bottomLimit) {
        window.scrollBy({ top: r.bottom - bottomLimit, behavior });
    }
}

/** onFocus handler kept for components that want it explicitly. */
export function revealOnFocus(e: FocusEvent<HTMLElement>) {
    ensureVisible(e.currentTarget);
}
