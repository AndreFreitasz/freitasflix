import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import React, { type FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import layoutManager from 'components/layoutManager';

import { type CatalogTitle, type MediaKind, useBridgeMe, useCatalogState, useCatalogTitle } from '../bridge';
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

function lengthOf(t: CatalogTitle) {
    if (t.type === 'movie') return formatRuntime((t.runtime || 0) * TICKS_PER_MINUTE);
    const n = t.seasons?.length || 0;
    if (!n) return '';
    return n > 1 ? `${n} temporadas` : '1 temporada';
}

const Progress: FC<{ progress?: number, timeleft?: string, status?: string }> = ({ progress = 0, timeleft, status }) => {
    const importing = status === 'importing' || progress >= 100;
    return (
        <div className='fp-dlstate' role='status'>
            <div className='fp-dlstate__row'>
                <Icon name='download' size={18} className='' />
                <span>{importing ? 'Download concluído · chegando na biblioteca…' : `Baixando ${Math.floor(progress)}%`}</span>
                {!importing && timeleft && <span className='fp-dlstate__eta'>{timeleft.replace(/^00:/, '')} restantes</span>}
            </div>
            <div className='fp-progress fp-progress--inline' aria-hidden='true'>
                <div className='fp-progress__bar' style={{ width: `${Math.max(2, Math.min(100, progress))}%` }} />
            </div>
        </div>
    );
};

const CatalogHero: FC<{ title: CatalogTitle, onDownload?: () => void, canDownload: boolean, panelOpen: boolean }> = ({ title: t, onDownload, canDownload, panelOpen }) => {
    const item = useMemo(() => asItem(t), [ t ]);
    const { data: st } = useCatalogState(t.type, t.tmdbId, { state: t.state, jellyfinId: t.jellyfinId, progress: t.progress, status: t.status, timeleft: t.timeleft });
    const state = st || t;
    const downloadRef = useRef<HTMLButtonElement>(null);
    const h = itemHue(item);
    const kind = kindOf(t);
    const length = lengthOf(t);

    useEffect(() => {
        if (layoutManager.tv) downloadRef.current?.focus();
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

                <div className='fp-actions-row'>
                    {state.state === 'library' && state.jellyfinId && (
                        <a className='fp-btn-play' href={`#/titulo?id=${state.jellyfinId}`}>
                            <PlayGlyph size={22} />
                            <span>Assistir</span>
                        </a>
                    )}
                    {state.state === 'none' && t.type === 'movie' && canDownload && (
                        <button ref={downloadRef} type='button' className='fp-btn-play' onClick={onDownload} aria-expanded={panelOpen}>
                            <Icon name='download' size={22} className='' />
                            <span>{panelOpen ? 'Escolha uma opção abaixo' : 'Baixar'}</span>
                        </button>
                    )}
                    {state.state === 'none' && t.type === 'tv' && canDownload && (
                        <button type='button' className='fp-btn-play' disabled title='Download de séries chega na próxima versão'>
                            <Icon name='download' size={22} className='' />
                            <span>Séries: em breve</span>
                        </button>
                    )}
                    {t.trailer && !layoutManager.tv && (
                        <a className='fp-btn-round' href={t.trailer} target='_blank' rel='noopener noreferrer' aria-label='Assistir trailer' title='Assistir trailer'>
                            <Icon name='trailer' size={22} className='' />
                        </a>
                    )}
                </div>
                {state.state === 'downloading' && <Progress progress={state.progress} timeleft={state.timeleft} status={state.status} />}
            </div>
        </section>
    );
};

/** Title page for something found in the catalog (usually not in the library yet). */
const Catalogo: FC = () => {
    const [ params ] = useSearchParams();
    const type = (params.get('type') === 'tv' ? 'tv' : 'movie') as MediaKind;
    const tmdbId = Number(params.get('tmdb')) || undefined;
    const { data: title, isError, error } = useCatalogTitle(type, tmdbId);
    const { data: me } = useBridgeMe();
    const [ panel, setPanel ] = useState(false);

    const openPanel = useCallback(() => setPanel(true), []);
    const closePanel = useCallback(() => setPanel(false), []);

    // already downloaded and in the library: go to the normal title page
    useEffect(() => {
        if (title?.state === 'library' && title.jellyfinId) window.location.replace(`#/titulo?id=${title.jellyfinId}`);
    }, [ title ]);

    return (
        <FreitasPage id='freitasCatalogPage' title={title?.title || 'Catálogo'}>
            {isError && (
                <div className='fp-back-wrap fp-pad'><BackButton /><BridgeHelp message={(error as Error)?.message} /></div>
            )}
            {!title && !isError && <section className='fp-hero fp-hero--title fp-skel' aria-busy='true' />}
            {title && (
                <>
                    <CatalogHero title={title} canDownload={!!me?.canDownload} onDownload={openPanel} panelOpen={panel} />
                    <main className='fp-title-main'>
                        {panel && tmdbId && <ReleasesPanel tmdbId={tmdbId} onClose={closePanel} onStarted={closePanel} />}
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
