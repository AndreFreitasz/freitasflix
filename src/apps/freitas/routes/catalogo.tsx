import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import React, { type FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import layoutManager from 'components/layoutManager';

import {
    type CatalogTitle,
    type MediaKind,
    type SeasonProgress,
    type StateInfo,
    shortDate,
    useBridgeMe,
    useCatalogState,
    useCatalogTitle,
    useFollow
} from '../bridge';
import { ReleasesPanel } from '../components/Catalog';
import { TitleArt } from '../components/Hero';
import { Icon, PlayGlyph } from '../components/Icons';
import FreitasPage from '../components/Layout';
import { RatingsRow } from '../components/Ratings';
import { formatRuntime, itemHue } from '../utils';
import { BridgeHelp } from './descobrir';
import { BackButton, InfoBlock } from './titulo';

const TICKS_PER_MINUTE = 600000000;

/** Enough of a Jellyfin item for the shared title/rating components. */
function asItem(t: CatalogTitle): BaseItemDto {
    return {
        Id: `tmdb-${t.type}-${t.tmdbId}`,
        Name: t.title,
        Type: t.type === 'movie' ? 'Movie' : 'Series',
        ProviderIds: { Tmdb: String(t.tmdbId), ...(t.imdbId ? { Imdb: t.imdbId } : {}) },
        CommunityRating: t.rating,
        Genres: t.genres,
        ProductionYear: t.year
    } as BaseItemDto;
}

function kindOf(t: CatalogTitle) {
    if (t.type === 'movie') return 'Filme';
    return t.originalLanguage === 'ja' ? 'Anime' : 'Série';
}

function lengthOf(t: CatalogTitle, st: StateInfo) {
    if (t.type === 'movie') return formatRuntime((t.runtime || 0) * TICKS_PER_MINUTE);
    const n = st.seasons?.length || 0;
    if (!n) return '';
    return n > 1 ? `${n} temporadas` : '1 temporada';
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** First season with something missing, else the latest one. */
function defaultSeason(seasons: SeasonProgress[]) {
    const owned = seasons.some(s => s.owned > 0);
    const gap = owned ? seasons.find(s => s.aired > 0 && s.have < s.aired) : undefined;
    const aired = seasons.filter(s => s.aired > 0);
    return gap?.number ?? (owned ? aired[aired.length - 1]?.number : aired[0]?.number) ?? seasons[0]?.number;
}

const Progress: FC<{ progress?: number, timeleft?: string, status?: string, title?: string }> = ({ progress = 0, timeleft, status, title }) => {
    const importing = status === 'importing' || status === 'importpending' || progress >= 100;
    return (
        <div className='fp-dlstate' role='status'>
            <div className='fp-dlstate__row'>
                <Icon name='download' size={18} className='' />
                <span>{importing ? 'Download concluído · chegando na biblioteca…' : `Baixando ${Math.floor(progress)}%`}{title?.endsWith(' downloads') ? ` (${title})` : ''}</span>
                {!importing && timeleft && <span className='fp-dlstate__eta'>{timeleft.replace(/^00:/, '')} restantes</span>}
            </div>
            <div className='fp-progress fp-progress--inline' aria-hidden='true'>
                <div className='fp-progress__bar' style={{ width: `${Math.max(2, Math.min(100, progress))}%` }} />
            </div>
        </div>
    );
};

function movieNote(t: CatalogTitle, st: StateInfo) {
    if (st.state !== 'none') return '';
    if (st.availability === 'cinema') {
        const when = shortDate(st.availableDate);
        const digital = when ? ' · digital previsto para ' + when : '';
        return `Ainda só nos cinemas${digital}. Os trackers normalmente ainda não têm.`;
    }
    if (st.availability === 'upcoming') {
        const when = shortDate(st.availableDate || t.date);
        return when ? `Ainda não estreou · estreia ${when}.` : 'Ainda não estreou.';
    }
    return '';
}

function seriesNote(st: StateInfo) {
    if (!st.aired) return '';
    const next = st.nextEpisode;
    let nextTxt = '';
    if (next) nextTxt = ` · próximo: T${next.season}E${pad2(next.episode)}` + (next.date ? ' em ' + shortDate(next.date) : '');
    if (!st.jellyfinId) return `${st.aired} episódios lançados${nextTxt}.`;
    const txt = st.missing ? `Você tem ${st.have} de ${st.aired} episódios lançados` : 'Você tem todos os episódios lançados';
    return txt + nextTxt + '.';
}

/** One line on whether a movie can be downloaded yet / how complete a series is. */
const StatusLine: FC<{ t: CatalogTitle, st: StateInfo }> = ({ t, st }) => {
    const text = t.type === 'movie' ? movieNote(t, st) : seriesNote(st);
    if (!text) return null;
    const warn = t.type === 'tv' && !!st.jellyfinId && !!st.missing;
    return <p className={'fp-availnote' + (warn ? ' fp-availnote--warn' : '')}>{text}</p>;
};

const FollowButton: FC<{ tmdbId: number, following?: boolean }> = ({ tmdbId, following }) => {
    const follow = useFollow(tmdbId);
    const on = !!following;
    const toggle = useCallback(() => follow.mutate(!on), [ follow, on ]);
    const label = on ? 'Acompanhando: episódios novos baixam sozinhos (toque para parar)' : 'Acompanhar: baixar episódios novos automaticamente';
    return (
        <button
            type='button'
            className={'fp-btn-round' + (on ? ' is-on' : '')}
            onClick={toggle}
            disabled={follow.isPending}
            aria-pressed={on}
            aria-label={label}
            title={follow.isError ? (follow.error as Error)?.message : label}
        >
            <Icon name={on ? 'bellOn' : 'bell'} size={22} className='' />
        </button>
    );
};

interface HeroProps {
    title: CatalogTitle
    st: StateInfo
    canDownload: boolean
    seriesOk: boolean
    panelOpen: boolean
    onDownload: () => void
}

const CatalogHero: FC<HeroProps> = ({ title: t, st, canDownload, seriesOk, panelOpen, onDownload }) => {
    const item = useMemo(() => asItem(t), [ t ]);
    const firstRef = useRef<HTMLDivElement>(null);
    const h = itemHue(item);
    const kind = kindOf(t);
    const length = lengthOf(t, st);
    const isTv = t.type === 'tv';
    const canGetMore = isTv ?
        seriesOk && (st.state !== 'library' || !!st.ongoing) :
        st.state === 'none' && st.availability !== 'upcoming';
    let downloadLabel = 'Baixar';
    if (panelOpen) downloadLabel = 'Escolha uma opção abaixo';
    else if (isTv && st.jellyfinId && st.missing) downloadLabel = 'Baixar o que falta';
    else if (isTv && st.jellyfinId) downloadLabel = 'Baixar episódios';

    useEffect(() => {
        if (layoutManager.tv) firstRef.current?.querySelector<HTMLElement>('a, button:not([disabled])')?.focus();
    }, []);

    return (
        <section className='fp-hero fp-hero--title'>
            <div
                className='fp-hero__bg'
                style={{ background: `radial-gradient(70% 80% at 78% 40%, hsl(${h} 55% 32%) 0%, transparent 70%), linear-gradient(170deg, hsl(${(h + 30) % 360} 45% 14%) 0%, #0b0b0e 80%)` }}
            />
            {t.backdrop && <img className='fp-hero__img' src={t.backdrop} alt='' aria-hidden='true' />}
            <div className='fp-hero__shade-x fp-hero__shade-x--strong' aria-hidden='true' />
            <div className='fp-hero__shade-y' aria-hidden='true' />

            <div className='fp-pad fp-back-wrap'>
                <BackButton />
            </div>

            <div className='fp-hero__body fp-hero__body--title fp-pad'>
                <div className='fp-kind'><span className='fp-kind__dot' />{kind}</div>
                {t.logo ? (
                    <h1 className='fp-title-art fp-title-art--logo' aria-label={t.title}><img src={t.logo} alt={t.title} /></h1>
                ) : (
                    <TitleArt item={item} />
                )}
                <div className='fp-meta'>
                    {t.year && <span>{t.year}</span>}
                    {t.certification && <span className='fp-chip'>{t.certification}</span>}
                    {length && <span>{length}</span>}
                    {t.genres.length > 0 && <span>{t.genres.slice(0, 3).join(' · ')}</span>}
                </div>
                <div className='fp-ratings-wrap'>
                    <RatingsRow item={item} />
                </div>
                {t.overview && <p className='fp-hero__syn fp-hero__syn--wide'>{t.overview}</p>}
                <StatusLine t={t} st={st} />

                <div className='fp-actions-row' ref={firstRef}>
                    {st.jellyfinId && (
                        <a className='fp-btn-play' href={`#/titulo?id=${st.jellyfinId}`}>
                            <PlayGlyph size={22} />
                            <span>Assistir</span>
                        </a>
                    )}
                    {canDownload && canGetMore && (
                        <button type='button' className={st.jellyfinId ? 'fp-btn-play fp-btn-play--alt' : 'fp-btn-play'} onClick={onDownload} aria-expanded={panelOpen}>
                            <Icon name='download' size={22} className='' />
                            <span>{downloadLabel}</span>
                        </button>
                    )}
                    {isTv && canDownload && !seriesOk && (
                        <button type='button' className='fp-btn-play' disabled title='Configure o Sonarr na ponte'>
                            <Icon name='download' size={22} className='' />
                            <span>Configure o Sonarr</span>
                        </button>
                    )}
                    {isTv && canDownload && seriesOk && (st.ongoing || st.following) && <FollowButton tmdbId={t.tmdbId} following={st.following} />}
                    {t.trailer && !layoutManager.tv && (
                        <a className='fp-btn-round' href={t.trailer} target='_blank' rel='noopener noreferrer' aria-label='Assistir trailer' title='Assistir trailer'>
                            <Icon name='trailer' size={22} className='' />
                        </a>
                    )}
                </div>
                {st.state === 'downloading' && <Progress progress={st.progress} timeleft={st.timeleft} status={st.status} title={st.downloadTitle} />}
            </div>
        </section>
    );
};

const SeasonChip: FC<{ s: SeasonProgress, active: boolean, owned: boolean, onPick: (n: number) => void }> = ({ s, active, owned, onPick }) => {
    const onClick = useCallback(() => onPick(s.number), [ onPick, s.number ]);
    let sub = `${s.episodes} ep.`;
    if (!s.aired) sub = 'ainda não lançada';
    else if (owned && s.have >= s.aired) sub = s.aired < s.episodes ? `em dia · ${s.aired} de ${s.episodes}` : 'completa';
    else if (owned && s.have > 0) sub = `${s.have} de ${s.aired}`;
    else if (owned) sub = `não tem · ${s.aired} ep.`;
    const gap = owned && s.aired > 0 && s.have < s.aired;
    return (
        <button type='button' className={'fp-cseason' + (gap ? ' is-gap' : '')} aria-pressed={active} onClick={onClick}>
            <span className='fp-cseason__n'>T{s.number}</span>
            <span className='fp-cseason__sub'>{sub}</span>
        </button>
    );
};

/** Title page for something found in the catalog (not in the library, or a series with episodes missing). */
const Catalogo: FC = () => {
    const [ params ] = useSearchParams();
    const type = (params.get('type') === 'tv' ? 'tv' : 'movie') as MediaKind;
    const tmdbId = Number(params.get('tmdb')) || undefined;
    const { data: title, isError, error } = useCatalogTitle(type, tmdbId);
    const { data: live } = useCatalogState(type, tmdbId, title ? {
        state: title.state, jellyfinId: title.jellyfinId, progress: title.progress, status: title.status, timeleft: title.timeleft,
        availability: title.availability, availableDate: title.availableDate, aired: title.aired, have: title.have, missing: title.missing,
        ongoing: title.ongoing, seasons: title.seasons, nextEpisode: title.nextEpisode, following: title.following
    } : undefined);
    const { data: me } = useBridgeMe();
    const [ panel, setPanel ] = useState(false);
    const [ season, setSeason ] = useState<number>();

    const st: StateInfo | undefined = live || title;
    const seasons = st?.seasons || [];
    const currentSeason = season ?? defaultSeason(seasons);
    const seasonInfo = seasons.find(s => s.number === currentSeason);

    const openPanel = useCallback(() => setPanel(true), []);
    const closePanel = useCallback(() => setPanel(false), []);
    const pickSeason = useCallback((n: number) => setSeason(n), []);

    // a movie already in the library: go to the normal title page
    useEffect(() => {
        if (type === 'movie' && title?.state === 'library' && title.jellyfinId) window.location.replace(`#/titulo?id=${title.jellyfinId}`);
    }, [ type, title ]);

    return (
        <FreitasPage id='freitasCatalogPage' title={title?.title || 'Catálogo'}>
            {isError && (
                <div className='fp-back-wrap fp-pad'><BackButton /><BridgeHelp message={(error as Error)?.message} /></div>
            )}
            {!title && !isError && <section className='fp-hero fp-hero--title fp-skel' aria-busy='true' />}
            {title && st && (
                <>
                    <CatalogHero
                        title={title}
                        st={st}
                        canDownload={!!me?.canDownload}
                        seriesOk={!!me?.services?.series}
                        panelOpen={panel}
                        onDownload={openPanel}
                    />
                    <main className='fp-title-main'>
                        {type === 'tv' && seasons.length > 0 && (
                            <section className='fp-cseasons fp-pad' aria-label='Temporadas'>
                                <h2 className='fp-cseasons__title'>Temporadas</h2>
                                <div className='fp-cseasons__list focuscontainer-x'>
                                    {seasons.map(s => (
                                        <SeasonChip key={s.number} s={s} owned={!!st.jellyfinId} active={s.number === currentSeason} onPick={pickSeason} />
                                    ))}
                                </div>
                                {seasonInfo && st.jellyfinId && seasonInfo.missingEpisodes.length > 0 && (
                                    <p className='fp-cseasons__missing'>
                                        Faltam na T{seasonInfo.number}: {seasonInfo.missingEpisodes.slice(0, 30).map(e => 'E' + pad2(e)).join(', ')}
                                        {seasonInfo.missingEpisodes.length > 30 ? '…' : ''}
                                    </p>
                                )}
                            </section>
                        )}
                        {panel && tmdbId && (type === 'movie' || currentSeason != null) && (
                            <ReleasesPanel
                                key={`${type}-${currentSeason ?? 0}`}
                                type={type}
                                tmdbId={tmdbId}
                                season={seasonInfo}
                                seasonNumber={currentSeason}
                                onClose={closePanel}
                                onStarted={closePanel}
                            />
                        )}
                        <div className='fp-info fp-pad'>
                            <InfoBlock label='Elenco principal' value={title.cast.slice(0, 3).map(c => c.name).join(', ')} />
                            <InfoBlock label={type === 'tv' ? 'Criação' : 'Direção'} value={title.directors.slice(0, 2).join(', ')} />
                            <InfoBlock label='Estúdio' value={title.studios.join(', ')} />
                            {title.tagline && <InfoBlock label='Frase' value={title.tagline} />}
                        </div>
                    </main>
                </>
            )}
        </FreitasPage>
    );
};

export default Catalogo;
