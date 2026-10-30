import React, { type FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import layoutManager from 'components/layoutManager';

import {
    type CatalogItem,
    type MediaKind,
    type Release,
    type SeasonProgress,
    episodesLabel,
    formatAge,
    formatBytes,
    freeleechLabel,
    ptbrLabel,
    resolutionLabel,
    shortDate,
    useGrab,
    useReleases
} from '../bridge';
import { posterPlaceholder } from '../utils';
import { Icon } from './Icons';

/** Where a catalog item leads: the normal title page when it is already in the library. */
export function catalogUrl(item: Pick<CatalogItem, 'type' | 'tmdbId' | 'state' | 'jellyfinId'>): string {
    // complete titles open the normal page; incomplete series open the catalog page to download what is missing
    if (item.state === 'library' && item.jellyfinId) return `#/titulo?id=${item.jellyfinId}`;
    return `#/catalogo?type=${item.type}&tmdb=${item.tmdbId}`;
}

const kindLabel = (item: CatalogItem) => {
    if (item.type === 'movie') return 'Filme';
    return item.originalLanguage === 'ja' ? 'Anime' : 'Série';
};

const CardBadge: FC<{ item: CatalogItem }> = ({ item }) => {
    switch (item.state) {
        case 'library':
            return <span className='fp-badge fp-badge--lib'><Icon name='check' size={14} strokeWidth={2.6} className='' />Na biblioteca</span>;
        case 'partial':
            return <span className='fp-badge fp-badge--part'>{item.missing === 1 ? 'Falta 1 episódio' : `Faltam ${item.missing} episódios`}</span>;
        case 'downloading':
            return (
                <span className='fp-badge fp-badge--dl'>
                    <Icon name='download' size={14} className='' />
                    {item.progress != null ? `${Math.floor(item.progress)}%` : 'Baixando'}
                </span>
            );
        default:
            if (item.availability === 'cinema') return <span className='fp-badge fp-badge--cine'>No cinema</span>;
            if (item.availability === 'upcoming') {
                const when = shortDate(item.availableDate || item.date);
                return <span className='fp-badge fp-badge--soon'>{when ? `Estreia ${when}` : 'Em breve'}</span>;
            }
            return null;
    }
};

/** Poster card for a TMDB title (may or may not be in the library). */
export const CatalogCard: FC<{ item: CatalogItem }> = ({ item }) => {
    const [ failed, setFailed ] = useState(false);
    const onError = useCallback(() => setFailed(true), []);
    const eyebrow = [ kindLabel(item), item.year ].filter(Boolean).join(' · ');
    const fakeForHue = useMemo(() => ({ Id: `tmdb-${item.tmdbId}`, Name: item.title }), [ item.tmdbId, item.title ]);
    return (
        <a className='fp-card fp-card--poster' href={catalogUrl(item)} aria-label={item.title}>
            <div className='fp-card__frame fp-ratio-poster'>
                <div className='fp-art' style={{ background: posterPlaceholder(fakeForHue) }}>
                    {item.poster && !failed && (
                        <img src={item.poster} alt='' loading='lazy' decoding='async' onError={onError} />
                    )}
                </div>
                <CardBadge item={item} />
                <div className='fp-plate'>
                    <span className='fp-plate__eyebrow'>{eyebrow}</span>
                    <span className='fp-plate__title'>{item.title}</span>
                </div>
            </div>
        </a>
    );
};

/* ---------------- download options ---------------- */

type ResFilter = 'all' | '2160' | '1080' | '720';
type SortBy = 'rec' | 'seeders' | 'size';

interface ChipProps {
    active: boolean
    label: string
    value: string
    onPick: (v: string) => void
}

const Chip: FC<ChipProps> = ({ active, label, value, onPick }) => {
    const onClick = useCallback(() => onPick(value), [ onPick, value ]);
    return (
        <button type='button' className='fp-chipbtn' aria-pressed={active} onClick={onClick}>{label}</button>
    );
};

const RES_OPTIONS: { value: ResFilter, label: string }[] = [
    { value: 'all', label: 'Todas' },
    { value: '2160', label: '4K' },
    { value: '1080', label: '1080p' },
    { value: '720', label: '720p' }
];
const SORT_OPTIONS: { value: SortBy, label: string }[] = [
    { value: 'rec', label: 'Recomendadas' },
    { value: 'seeders', label: 'Mais seeders' },
    { value: 'size', label: 'Menores' }
];

/** A series release that brings at least one episode the user does not have. */
function coversMissing(r: Release, season?: SeasonProgress) {
    if (!season) return true;
    if (r.fullSeason) return season.missingEpisodes.length > 0 || season.owned < season.episodes;
    const eps = r.episodes || [];
    if (!eps.length) return true;
    return eps.some(e => season.missingEpisodes.includes(e) || e > season.aired);
}

function alreadyHave(r: Release, season?: SeasonProgress) {
    if (!season || r.fullSeason) return false;
    const eps = r.episodes || [];
    return eps.length > 0 && eps.every(e => e <= season.aired && !season.missingEpisodes.includes(e));
}

interface Filters {
    res: ResFilter
    onlyPt: boolean
    onlyFl: boolean
    onlyMissing: boolean
    sort: SortBy
}

function applyFilters(list: Release[], f: Filters, season?: SeasonProgress) {
    const { res, onlyPt, onlyFl, onlyMissing, sort } = f;
    const out = list.filter(r => {
        if (onlyMissing && !coversMissing(r, season)) return false;
        if (res !== 'all') {
            const want = Number(res);
            if (want === 720 ? r.resolution > 720 || r.resolution === 0 : r.resolution !== want) return false;
        }
        if (onlyPt && !r.ptbr) return false;
        if (onlyFl && !r.freeleech) return false;
        return true;
    });
    if (sort === 'seeders') return [ ...out ].sort((a, b) => b.seeders - a.seeders);
    if (sort === 'size') return [ ...out ].sort((a, b) => a.size - b.size);
    return out;
}

interface ReleaseRowProps {
    release: Release
    season?: SeasonProgress
    selected: boolean
    busy: boolean
    onSelect: (key?: string) => void
    onConfirm: (key: string) => void
}

const ReleaseRow: FC<ReleaseRowProps> = ({ release: r, season, selected, busy, onSelect, onConfirm }) => {
    const confirmRef = useRef<HTMLButtonElement>(null);
    const mainRef = useRef<HTMLButtonElement>(null);
    const onClick = useCallback(() => onSelect(selected ? undefined : r.key), [ onSelect, selected, r.key ]);
    const onCancel = useCallback(() => {
        onSelect(undefined);
        // keep the remote's focus on this option instead of losing it with the removed buttons
        mainRef.current?.focus();
    }, [ onSelect ]);
    const onOk = useCallback(() => onConfirm(r.key), [ onConfirm, r.key ]);
    useEffect(() => {
        if (selected) confirmRef.current?.focus();
    }, [ selected ]);

    const fl = freeleechLabel(r);
    const pt = ptbrLabel(r);
    const res = resolutionLabel(r.resolution);
    const eps = episodesLabel(r);
    const have = alreadyHave(r, season);
    const why = r.rejected ? `O Radarr não recomenda: ${r.rejections.join('; ')}` : undefined;

    return (
        <li className={'fp-rel' + (selected ? ' is-selected' : '') + (r.rejected ? ' is-rejected' : '')}>
            <button ref={mainRef} type='button' className='fp-rel__main' onClick={onClick} title={why} aria-expanded={selected}>
                <span className='fp-rel__tags'>
                    {eps && <span className='fp-tag fp-tag--ep'>{eps}</span>}
                    {res && <span className='fp-tag fp-tag--res'>{res}</span>}
                    {r.source && <span className='fp-tag'>{r.source}</span>}
                    {pt && <span className='fp-tag fp-tag--pt'>{pt}</span>}
                    {fl && <span className='fp-tag fp-tag--fl'>{fl}</span>}
                    {r.doubleUpload && <span className='fp-tag fp-tag--up'>2× UP</span>}
                    {have && <span className='fp-tag fp-tag--have'>Você já tem</span>}
                    {r.rejected && <span className='fp-tag fp-tag--warn'>Não recomendado</span>}
                </span>
                <span className='fp-rel__title'>{r.title}</span>
                <span className='fp-rel__meta'>
                    <span className='fp-rel__tracker'>{r.indexer}</span>
                    <span>{formatBytes(r.size)}</span>
                    <span className={'fp-rel__seed' + (r.seeders ? '' : ' is-dead')}>
                        <Icon name='arrowUp' size={13} strokeWidth={2.4} className='' />{r.seeders}
                    </span>
                    <span>{formatAge(r.ageDays)}</span>
                </span>
            </button>
            {selected && (
                <div className='fp-rel__confirm'>
                    <span>Baixar {formatBytes(r.size)} do {r.indexer}?</span>
                    <button ref={confirmRef} type='button' className='fp-btn-play fp-btn-play--sm' disabled={busy} onClick={onOk}>
                        <Icon name='download' size={18} className='' />
                        <span>{busy ? 'Enviando…' : 'Baixar'}</span>
                    </button>
                    <button type='button' className='fp-btn-ghost' onClick={onCancel}>Cancelar</button>
                </div>
            )}
        </li>
    );
};

function useElapsed(running: boolean) {
    const [ s, setS ] = useState(0);
    useEffect(() => {
        if (!running) return;
        setS(0);
        const t = window.setInterval(() => setS(x => x + 1), 1000);
        return () => window.clearInterval(t);
    }, [ running ]);
    return s;
}

interface ReleasesPanelProps {
    type: MediaKind
    tmdbId: number
    /** series: the season being downloaded, with what is on disk */
    season?: SeasonProgress
    seasonNumber?: number
    onClose: () => void
    onStarted: () => void
}

/** "Baixar" panel: the options found in the user's trackers, with filters. */
export const ReleasesPanel: FC<ReleasesPanelProps> = ({ type, tmdbId, season, seasonNumber, onClose, onStarted }) => {
    const { data, isLoading, isError, error, refetch, isFetching } = useReleases(type, tmdbId, seasonNumber, true);
    const grab = useGrab(type, tmdbId);
    const [ res, setRes ] = useState<ResFilter>('all');
    const [ sort, setSort ] = useState<SortBy>('rec');
    const [ onlyPt, setOnlyPt ] = useState(false);
    const [ onlyFl, setOnlyFl ] = useState(false);
    const canFilterMissing = type === 'tv' && !!season && season.owned > 0;
    const [ onlyMissing, setOnlyMissing ] = useState(canFilterMissing);
    const [ selected, setSelected ] = useState<string>();
    const elapsed = useElapsed(isLoading);
    const panelRef = useRef<HTMLElement>(null);

    useEffect(() => setOnlyMissing(canFilterMissing), [ canFilterMissing, seasonNumber ]);

    const list = useMemo(
        () => applyFilters(data?.releases || [], { res, onlyPt, onlyFl, onlyMissing: onlyMissing && canFilterMissing, sort }, season),
        [ data, res, onlyPt, onlyFl, onlyMissing, canFilterMissing, sort, season ]
    );

    useEffect(() => {
        if (!layoutManager.tv) return;
        const panel = panelRef.current;
        (panel?.querySelector<HTMLElement>('.fp-rel__main') || panel?.querySelector<HTMLElement>('button'))?.focus();
    }, [ isLoading ]);

    const onRes = useCallback((v: string) => setRes(v as ResFilter), []);
    const onSort = useCallback((v: string) => setSort(v as SortBy), []);
    const togglePt = useCallback(() => setOnlyPt(v => !v), []);
    const toggleFl = useCallback(() => setOnlyFl(v => !v), []);
    const toggleMissing = useCallback(() => setOnlyMissing(v => !v), []);
    const onRetry = useCallback(() => {
        refetch().catch(() => undefined);
    }, [ refetch ]);
    const onConfirm = useCallback((key: string) => {
        grab.mutate(key, { onSuccess: onStarted });
    }, [ grab, onStarted ]);

    const heading = type === 'tv' && seasonNumber != null ? `Temporada ${seasonNumber} nos seus trackers` : 'Opções nos seus trackers';

    return (
        <section className='fp-releases fp-pad' ref={panelRef} aria-label='Opções de download'>
            <div className='fp-releases__head'>
                <h2 className='fp-releases__title'>{heading}</h2>
                <button type='button' className='fp-btn-ghost' onClick={onClose} aria-label='Fechar opções'>
                    <Icon name='close' size={18} className='' /><span>Fechar</span>
                </button>
            </div>

            {isLoading && (
                <div className='fp-releases__loading' role='status'>
                    <span className='fp-spinner' aria-hidden='true' />
                    <span>Procurando nos seus trackers… {elapsed > 3 ? `${elapsed}s` : ''}<br /><small>Pode levar até um minuto.</small></span>
                </div>
            )}

            {isError && (
                <div className='fp-releases__error' role='alert'>
                    <p className='fp-releases__error-text'>{(error as Error)?.message || 'Não deu para buscar agora.'}</p>
                    <button type='button' className='fp-btn-ghost' onClick={onRetry}>Tentar de novo</button>
                </div>
            )}

            {data && (
                <>
                    <div className='fp-releases__filters'>
                        <div className='fp-chipgroup' role='group' aria-label='Ordenar'>
                            {SORT_OPTIONS.map(o => <Chip key={o.value} active={sort === o.value} label={o.label} value={o.value} onPick={onSort} />)}
                        </div>
                        <div className='fp-chipgroup' role='group' aria-label='Resolução'>
                            {RES_OPTIONS.map(o => <Chip key={o.value} active={res === o.value} label={o.label} value={o.value} onPick={onRes} />)}
                        </div>
                        <div className='fp-chipgroup' role='group' aria-label='Filtros'>
                            <button type='button' className='fp-chipbtn' aria-pressed={onlyPt} onClick={togglePt}>Só PT-BR</button>
                            <button type='button' className='fp-chipbtn' aria-pressed={onlyFl} onClick={toggleFl}>Só freeleech</button>
                            {canFilterMissing && (
                                <button type='button' className='fp-chipbtn' aria-pressed={onlyMissing} onClick={toggleMissing}>Só o que falta</button>
                            )}
                        </div>
                    </div>

                    <p className='fp-releases__count'>
                        {list.length === 1 ? '1 opção' : `${list.length} opções`}
                        {list.length !== data.releases.length ? ` de ${data.releases.length}` : ''}
                        {isFetching ? ' · atualizando…' : ''}
                    </p>

                    {data.errors.length > 0 && (
                        <p className='fp-releases__warn'>Algumas fontes falharam: {data.errors.join(' · ')}</p>
                    )}

                    {grab.isError && (
                        <p className='fp-releases__warn' role='alert'>{(grab.error as Error)?.message}</p>
                    )}

                    {list.length ? (
                        <ul className='fp-rel-list'>
                            {list.map(r => (
                                <ReleaseRow
                                    key={r.key}
                                    release={r}
                                    season={season}
                                    selected={selected === r.key}
                                    busy={grab.isPending}
                                    onSelect={setSelected}
                                    onConfirm={onConfirm}
                                />
                            ))}
                        </ul>
                    ) : (
                        <p className='fp-releases__empty'>
                            {data.releases.length ? 'Nenhuma opção com esses filtros.' : 'Nenhum dos seus trackers tem esse título agora.'}
                        </p>
                    )}
                </>
            )}
        </section>
    );
};
