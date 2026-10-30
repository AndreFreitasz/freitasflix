import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import { ImageType } from '@jellyfin/sdk/lib/generated-client/models/image-type';
import React, { type FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import layoutManager from 'components/layoutManager';
import { appRouter } from 'components/router/appRouter';
import { useApi } from 'hooks/useApi';

import {
    useAncestorLibraryId,
    useEpisodes,
    useExtras,
    useFirstEpisode,
    useMyList,
    useSeasons,
    useSeriesNextUp,
    useSimilar,
    useTitle,
    useToggleFavorite,
    useToggleMyList
} from '../api';
import { PosterCard, Row, itemUrl } from '../components/Cards';
import { setActiveLibrary } from '../components/Header';
import { MetaLine, TitleArt } from '../components/Hero';
import { Icon, PlayGlyph } from '../components/Icons';
import { RatingsRow, TechChips } from '../components/Ratings';
import { TrackPickers, useTrackSelection } from '../components/Tracks';
import FreitasPage from '../components/Layout';
import { type PlayTracks, playItem, playTrailer } from '../playback';
import { useItemDetails } from '../ratings';
import {
    audioSubtitleLabel,
    backdropWidth,
    episodeCode,
    formatRating,
    formatRuntime,
    imageUrl,
    itemHue,
    kindLabel,
    posterPlaceholder,
    progressPercent
} from '../utils';

type TabId = 'episodes' | 'extras' | 'cast';

/* ---------- small pieces ---------- */

export const InfoBlock: FC<{ label: string, value?: string }> = ({ label, value }) => {
    if (!value) return null;
    return (
        <div className='fp-info__block'>
            <span className='fp-info__label'>{label}</span>
            <span className='fp-info__value'>{value}</span>
        </div>
    );
};

interface PlayButtonProps {
    target: BaseItemDto
    label: string
    focusOnTv?: boolean
    tracks?: PlayTracks
}

const PlayButton: FC<PlayButtonProps> = ({ target, label, focusOnTv, tracks }) => {
    const ref = useRef<HTMLButtonElement>(null);
    const onClick = useCallback(() => playItem(target, false, tracks), [ target, tracks ]);
    useEffect(() => {
        // TV remotes need a starting point
        if (focusOnTv && layoutManager.tv) ref.current?.focus();
    }, [ focusOnTv ]);
    return (
        <button ref={ref} type='button' className='fp-btn-play' onClick={onClick}>
            <PlayGlyph size={22} />
            <span>{label}</span>
        </button>
    );
};

const ListButton: FC<{ item: BaseItemDto }> = ({ item }) => {
    const { data: myList } = useMyList();
    const toggleList = useToggleMyList();
    const inList = !!myList?.items.some(i => i.Id === item.Id);
    const label = inList ? 'Remover da minha lista' : 'Adicionar à minha lista';
    const onClick = useCallback(() => toggleList.mutate({ item, inList }), [ toggleList, item, inList ]);
    return (
        <button type='button' className='fp-btn-round' aria-pressed={inList} aria-label={label} title={label} onClick={onClick}>
            <Icon name={inList ? 'check' : 'plus'} size={24} strokeWidth={2.2} className='' />
        </button>
    );
};

const FavoriteButton: FC<{ item: BaseItemDto }> = ({ item }) => {
    const toggleFavorite = useToggleFavorite();
    const isFavorite = !!item.UserData?.IsFavorite;
    const label = isFavorite ? 'Remover dos favoritos' : 'Favoritar';
    const onClick = useCallback(() => {
        if (item.Id) toggleFavorite.mutate({ itemId: item.Id, isFavorite });
    }, [ toggleFavorite, item.Id, isFavorite ]);
    return (
        <button
            type='button'
            className={'fp-btn-round' + (isFavorite ? ' is-on' : '')}
            aria-pressed={isFavorite}
            aria-label={label}
            title={label}
            onClick={onClick}
        >
            <Icon name='heart' size={22} className={isFavorite ? 'fp-icon-fill' : ''} />
        </button>
    );
};

const TrailerButton: FC<{ item: BaseItemDto }> = ({ item }) => {
    const onClick = useCallback(() => playTrailer(item), [ item ]);
    if (!item.LocalTrailerCount && !item.RemoteTrailers?.length) return null;
    return (
        <button type='button' className='fp-btn-round' aria-label='Assistir trailer' title='Assistir trailer' onClick={onClick}>
            <Icon name='trailer' size={22} className='' />
        </button>
    );
};

export const BackButton: FC = () => {
    const onClick = useCallback(() => {
        if (window.history.length > 1) {
            appRouter.back().catch(() => {
                window.location.hash = '#/home';
            });
        } else {
            window.location.hash = '#/home';
        }
    }, []);
    return (
        <button type='button' className='fp-back fp-glass' onClick={onClick}>
            <Icon name='chevronLeft' size={20} className='' />
            <span>Voltar</span>
        </button>
    );
};

/* ---------- episodes ---------- */

const EpisodeRow: FC<{ ep: BaseItemDto }> = ({ ep }) => {
    const { api } = useApi();
    const progress = progressPercent(ep);
    const thumb = imageUrl(api, ep, ImageType.Primary, 260);
    const played = !!ep.UserData?.Played;
    const onClick = useCallback(() => playItem(ep), [ ep ]);
    const rating = ep.CommunityRating ? formatRating(ep.CommunityRating) : '';
    const runtime = formatRuntime(ep.RunTimeTicks);
    return (
        <button
            type='button'
            className='fp-ep'
            aria-label={`Episódio ${ep.IndexNumber ?? ''}: ${ep.Name}`}
            onClick={onClick}
        >
            <span className='fp-ep__num'>{ep.IndexNumber ?? ''}</span>
            <div className='fp-ep__thumb fp-ratio-wide' style={{ background: posterPlaceholder(ep) }}>
                {thumb && <img src={thumb} alt='' loading='lazy' decoding='async' />}
                <span className='fp-ep__play' aria-hidden='true'><PlayGlyph size={16} /></span>
                {progress > 0 && !played && (
                    <div className='fp-ep__progress' aria-hidden='true'><div style={{ width: `${progress}%` }} /></div>
                )}
                {played && (
                    <span className='fp-ep__seen fp-glass' aria-label='Assistido'>
                        <Icon name='check' size={14} strokeWidth={2.6} className='' />
                    </span>
                )}
            </div>
            <div className='fp-ep__text'>
                <span className='fp-ep__title'>{ep.Name}</span>
                {(rating || runtime) && (
                    <span className='fp-ep__meta'>
                        {rating && (
                            <span className='fp-ep__rating' title='Nota do episódio no TMDB'>
                                <span className='fp-rating__src fp-rating__src--tmdb fp-ep__src'>TMDB</span>
                                {rating}
                            </span>
                        )}
                        {runtime && <span className='fp-ep__meta-dur'>{runtime}</span>}
                    </span>
                )}
                {ep.Overview && <span className='fp-ep__syn'>{ep.Overview}</span>}
            </div>
            <span className='fp-ep__dur'>{runtime}</span>
        </button>
    );
};

const SeasonButton: FC<{ season: BaseItemDto, active: boolean, onPick: (id?: string) => void }> = ({ season, active, onPick }) => {
    const onClick = useCallback(() => onPick(season.Id || undefined), [ season.Id, onPick ]);
    return (
        <button type='button' className='fp-season' aria-pressed={active} onClick={onClick}>
            {season.Name}
        </button>
    );
};

const Episodes: FC<{ series: BaseItemDto, initialSeasonId?: string }> = ({ series, initialSeasonId }) => {
    const { data: seasons } = useSeasons(series.Id || undefined);
    const [ seasonId, setSeasonId ] = useState<string | undefined>(initialSeasonId);

    useEffect(() => {
        if (initialSeasonId) setSeasonId(initialSeasonId);
    }, [ initialSeasonId ]);

    useEffect(() => {
        if (!seasonId && seasons?.length) {
            const firstRegular = seasons.find(s => (s.IndexNumber ?? 0) > 0) || seasons[0];
            setSeasonId(firstRegular.Id || undefined);
        }
    }, [ seasons, seasonId ]);

    const { data: episodes, isPending } = useEpisodes(series.Id || undefined, seasonId);
    const count = episodes?.length || 0;

    return (
        <section aria-label='Episódios' className='fp-episodes'>
            <div className='fp-seasons focuscontainer-x'>
                {(seasons || []).map(s => (
                    <SeasonButton key={s.Id} season={s} active={s.Id === seasonId} onPick={setSeasonId} />
                ))}
                {count > 0 && (
                    <span className='fp-seasons__count'>{count === 1 ? '1 episódio' : `${count} episódios`}</span>
                )}
            </div>
            <div className='fp-ep-list'>
                {isPending && seasonId && <div className='fp-skel fp-skel--ep' />}
                {(episodes || []).map(ep => <EpisodeRow key={ep.Id} ep={ep} />)}
            </div>
        </section>
    );
};

/* ---------- extras & cast ---------- */

const ExtraCard: FC<{ extra: BaseItemDto }> = ({ extra }) => {
    const { api } = useApi();
    const thumb = imageUrl(api, extra, ImageType.Thumb, 360);
    const onClick = useCallback(() => playItem(extra, true), [ extra ]);
    return (
        <button
            type='button'
            className='fp-card fp-card--extra'
            aria-label={`Assistir ${extra.Name}`}
            onClick={onClick}
        >
            <div className='fp-card__frame fp-ratio-wide' style={{ background: posterPlaceholder(extra) }}>
                {thumb && <img src={thumb} alt='' loading='lazy' />}
                <div className='fp-extra__shade' aria-hidden='true' />
                <span className='fp-ep__play fp-ep__play--lg' aria-hidden='true'><PlayGlyph size={20} /></span>
                {!!extra.RunTimeTicks && <span className='fp-extra__dur'>{formatRuntime(extra.RunTimeTicks)}</span>}
            </div>
            <div className='fp-extra__title'>{extra.Name}</div>
        </button>
    );
};

const Cast: FC<{ item: BaseItemDto }> = ({ item }) => {
    const { api } = useApi();
    const people = (item.People || []).filter(p => p.Type === 'Actor').slice(0, 24);
    return (
        <section aria-label='Elenco' className='fp-cast fp-pad'>
            {people.map(p => {
                const img = p.Id && p.PrimaryImageTag ?
                    imageUrl(api, { Id: p.Id, ImageTags: { Primary: p.PrimaryImageTag } }, ImageType.Primary, 140) :
                    undefined;
                const initials = (p.Name || '').split(' ').map(w => w[0]).slice(0, 2).join('');
                return (
                    <a
                        key={p.Id || p.Name}
                        className='fp-person'
                        href={p.Id ? `#/details?id=${p.Id}&serverId=${item.ServerId}` : undefined}
                    >
                        <span className='fp-person__avatar' style={{ background: posterPlaceholder({ Id: p.Id }) }}>
                            {img ? <img src={img} alt='' loading='lazy' /> : initials}
                        </span>
                        <span className='fp-person__name'>{p.Name}</span>
                        {p.Role && <span className='fp-person__role'>{p.Role}</span>}
                    </a>
                );
            })}
        </section>
    );
};

const TabButton: FC<{ id: TabId, label: string, active: boolean, onPick: (id: TabId) => void }> = ({ id, label, active, onPick }) => {
    const onClick = useCallback(() => onPick(id), [ id, onPick ]);
    return (
        <button type='button' role='tab' className='fp-tab' aria-selected={active} onClick={onClick}>
            {label}
        </button>
    );
};

/* ---------- page ---------- */

function getPlayLabel(isSeries: boolean, target: BaseItemDto | undefined, firstEp?: BaseItemDto | null) {
    const resumeTicks = target?.UserData?.PlaybackPositionTicks || 0;
    if (!isSeries) return resumeTicks > 0 ? 'Continuar' : 'Assistir';
    if (!target) return 'Assistir';
    const code = episodeCode(target);
    const started = resumeTicks > 0 || (!!firstEp && target.Id !== firstEp.Id);
    return `${started ? 'Continuar' : 'Assistir'}${code ? ' ' + code : ''}`;
}

function getCreators(item: BaseItemDto) {
    const people = item.People || [];
    const directors = people.filter(p => p.Type === 'Director').map(p => p.Name || '');
    const writers = people.filter(p => p.Type === 'Writer' || p.Type === 'Creator').map(p => p.Name || '');
    if (item.Type === 'Series') return writers.length ? writers : directors;
    return directors.length ? directors : writers;
}

interface TitleHeroProps {
    item: BaseItemDto
    playTarget: BaseItemDto
    playLabel: string
    techItem?: BaseItemDto | null
}

const TitleHero: FC<TitleHeroProps> = ({ item, playTarget, playLabel, techItem }) => {
    const { api } = useApi();
    const backdrop = imageUrl(api, item, ImageType.Backdrop, backdropWidth(720), 2400);
    const h = itemHue(item);
    const kind = kindLabel(item);
    const trackSel = useTrackSelection(playTarget);

    return (
        <section className='fp-hero fp-hero--title'>
            <div
                className='fp-hero__bg'
                style={{ background: `radial-gradient(70% 80% at 78% 40%, hsl(${h} 55% 32%) 0%, transparent 70%), linear-gradient(170deg, hsl(${(h + 30) % 360} 45% 14%) 0%, #0b0b0e 80%)` }}
            />
            {backdrop && <img className='fp-hero__img' src={backdrop} alt='' aria-hidden='true' />}
            <div className='fp-hero__shade-x fp-hero__shade-x--strong' aria-hidden='true' />
            <div className='fp-hero__shade-y' aria-hidden='true' />

            <div className='fp-pad fp-back-wrap'>
                <BackButton />
            </div>

            <div className='fp-hero__body fp-hero__body--title fp-pad'>
                {kind && <div className='fp-kind'><span className='fp-kind__dot' />{kind}</div>}
                <TitleArt item={item} />
                <MetaLine item={item} maxGenres={3} showScore={false} />
                <div className='fp-ratings-wrap'>
                    <RatingsRow item={item} />
                    <TechChips item={techItem} />
                </div>
                {item.Overview && <p className='fp-hero__syn fp-hero__syn--wide'>{item.Overview}</p>}
                <div className='fp-actions-row'>
                    <PlayButton target={playTarget} label={playLabel} focusOnTv tracks={trackSel.tracks} />
                    <ListButton item={item} />
                    <FavoriteButton item={item} />
                    <TrailerButton item={item} />
                </div>
                <TrackPickers sel={trackSel} />
            </div>
        </section>
    );
};

const TitleView: FC<{ item: BaseItemDto }> = ({ item }) => {
    const isSeries = item.Type === 'Series';
    const seriesId = isSeries ? item.Id || undefined : undefined;
    const { data: nextUp } = useSeriesNextUp(seriesId);
    const { data: firstEp } = useFirstEpisode(seriesId);
    const { data: firstEpFull } = useItemDetails(firstEp?.Id);
    const { data: extras } = useExtras(item.Id || undefined);
    const { data: similar } = useSimilar(item.Id || undefined);

    const actors = (item.People || []).filter(p => p.Type === 'Actor');
    const creators = getCreators(item);

    const tabs = useMemo(() => {
        const list: { id: TabId, label: string }[] = [];
        if (isSeries) list.push({ id: 'episodes', label: 'Episódios' });
        if (extras?.length) list.push({ id: 'extras', label: 'Extras' });
        if (actors.length) list.push({ id: 'cast', label: 'Elenco' });
        return list;
    }, [ isSeries, extras, actors.length ]);
    const [ tab, setTab ] = useState<TabId | undefined>();
    const activeTab = tab && tabs.some(t => t.id === tab) ? tab : tabs[0]?.id;

    const playTarget = (isSeries ? (nextUp || firstEp) : item) || item;
    const playLabel = getPlayLabel(isSeries, isSeries ? (nextUp || firstEp || undefined) : item, firstEp);

    return (
        <>
            <TitleHero item={item} playTarget={playTarget} playLabel={playLabel} techItem={isSeries ? firstEpFull : item} />

            <main className='fp-title-main'>
                <div className='fp-info fp-pad'>
                    <InfoBlock label='Elenco principal' value={actors.slice(0, 3).map(a => a.Name).join(', ')} />
                    <InfoBlock label={isSeries ? 'Criação' : 'Direção'} value={creators.slice(0, 2).join(', ')} />
                    <InfoBlock label='Áudio e legendas' value={audioSubtitleLabel(isSeries ? firstEp : item)} />
                    <InfoBlock label='Estúdio' value={(item.Studios || []).slice(0, 2).map(s => s.Name).join(', ')} />
                </div>

                {tabs.length > 0 && (
                    <div className='fp-pad'>
                        <div className='fp-tabs fp-glass focuscontainer-x' role='tablist' aria-label='Seções do título'>
                            {tabs.map(t => (
                                <TabButton key={t.id} id={t.id} label={t.label} active={t.id === activeTab} onPick={setTab} />
                            ))}
                        </div>
                    </div>
                )}

                {activeTab === 'episodes' && isSeries && (
                    <Episodes series={item} initialSeasonId={nextUp?.SeasonId || undefined} />
                )}
                {activeTab === 'extras' && !!extras?.length && (
                    <section aria-label='Extras' className='fp-scroller fp-pad fp-scroller--wide focuscontainer-x'>
                        {extras.map(ex => <ExtraCard key={ex.Id} extra={ex} />)}
                    </section>
                )}
                {activeTab === 'cast' && <Cast item={item} />}

                {!!similar?.length && (
                    <Row title='Mais como este'>
                        {similar.map(s => <PosterCard key={s.Id} item={s} />)}
                    </Row>
                )}
            </main>
        </>
    );
};

const Titulo: FC = () => {
    const [ searchParams ] = useSearchParams();
    const id = searchParams.get('id') || undefined;
    const { data: item, isError } = useTitle(id);
    const { data: libraryId } = useAncestorLibraryId(id);

    useEffect(() => {
        setActiveLibrary(libraryId);
        return () => setActiveLibrary();
    }, [ libraryId ]);

    // Anything that is not a movie or a series keeps the classic details page.
    useEffect(() => {
        if (item && item.Type !== 'Movie' && item.Type !== 'Series') {
            window.location.replace(itemUrl(item).replace('#/titulo', '#/details'));
        }
    }, [ item ]);

    useEffect(() => {
        window.scrollTo(0, 0);
    }, [ id ]);

    return (
        <FreitasPage id='freitasTitlePage' title={item?.Name || ''}>
            {item ? <TitleView key={item.Id} item={item} /> : (
                <section className='fp-hero fp-hero--title' aria-busy={!isError}>
                    {isError && <p className='fp-pad fp-empty'>Não foi possível carregar este título.</p>}
                </section>
            )}
        </FreitasPage>
    );
};

export default Titulo;
