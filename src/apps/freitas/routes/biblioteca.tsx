import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import React, { type FC, type ReactNode, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

import { appRouter } from 'components/router/appRouter';

import { useContinueWatching, useHeroItems, useLatestItems, useLibraries, useLibraryAll } from '../api';
import { type StreamingKind, type StreamingProvider, useStreaming } from '../bridge';
import { PosterCard, RankCard, Row, WideCard } from '../components/Cards';
import { CatalogCard } from '../components/Catalog';
import Hero from '../components/Hero';
import { Icon } from '../components/Icons';
import FreitasPage, { SkeletonRow } from '../components/Layout';

/** Movies / series / anime: decides the streaming rows of the tab. */
export function libraryKind(view?: BaseItemDto): StreamingKind | undefined {
    if (!view) return undefined;
    if (/anime/i.test(view.Name || '')) return 'anime';
    if (view.CollectionType === 'movies') return 'movie';
    if (view.CollectionType === 'tvshows') return 'tv';
    return undefined;
}

/** The full stock list (A–Z, filters) for whoever wants it. */
function fullListUrl(view: BaseItemDto) {
    try {
        return appRouter.getRouteUrl(view, { context: view.CollectionType }) as string;
    } catch {
        return `#/list?parentId=${view.Id}`;
    }
}

const MIN_GENRE_ITEMS = 4;
const MAX_GENRES = 8;
const ROW_SIZE = 20;

/** The library's biggest genres, each with its titles. */
function genreRows(items: BaseItemDto[]) {
    const byGenre = new Map<string, BaseItemDto[]>();
    for (const it of items) {
        for (const g of it.Genres || []) {
            if (!byGenre.has(g)) byGenre.set(g, []);
            byGenre.get(g)!.push(it);
        }
    }
    return [ ...byGenre.entries() ]
        .filter(([ , list ]) => list.length >= MIN_GENRE_ITEMS)
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, MAX_GENRES)
        .map(([ genre, list ]) => ({ genre, items: list.slice(0, ROW_SIZE) }));
}

function topTen(items: BaseItemDto[]) {
    return [ ...items ]
        .filter(i => i.CommunityRating)
        .sort((a, b) => (b.CommunityRating || 0) - (a.CommunityRating || 0))
        .slice(0, 10);
}

const STREAMING_PREP: Record<StreamingKind, string> = { movie: 'Filmes', tv: 'Séries', anime: 'Animes' };

/** "Populares na Netflix" / "Lançamentos no Prime Video" */
function streamingTitle(kind: StreamingKind, p: StreamingProvider, recent: boolean) {
    const em = /^(prime video|globoplay)$/i.test(p.name) ? 'no' : 'na';
    if (recent) return `Lançamentos ${em} ${p.name}`;
    return kind === 'anime' ? `Animes populares ${em} ${p.name}` : `${STREAMING_PREP[kind]} populares ${em} ${p.name}`;
}

const StreamingRows: FC<{ kind: StreamingKind, p: StreamingProvider }> = ({ kind, p }) => (
    <>
        {p.popular.length > 0 && (
            <Row title={streamingTitle(kind, p, false)} logo={p.logo}>
                {p.popular.map(item => <CatalogCard key={`${item.type}-${item.tmdbId}`} item={item} />)}
            </Row>
        )}
        {p.recent.length > 0 && (
            <Row title={streamingTitle(kind, p, true)} logo={p.logo}>
                {p.recent.map(item => <CatalogCard key={`${item.type}-${item.tmdbId}`} item={item} />)}
            </Row>
        )}
    </>
);

const LibraryTab: FC<{ view: BaseItemDto }> = ({ view }) => {
    const parentId = view.Id || undefined;
    const kind = libraryKind(view);
    const { data: heroItems } = useHeroItems(parentId);
    const { data: resume } = useContinueWatching(parentId);
    const { data: latest } = useLatestItems(parentId, 20);
    const { data: all, isPending } = useLibraryAll(parentId);
    const { data: streaming } = useStreaming(kind);

    const genres = useMemo(() => genreRows(all || []), [ all ]);
    const top = useMemo(() => topTen(all || []), [ all ]);

    // Netflix-like mix: streaming rows alternate with the library's genres
    const mixed = useMemo(() => {
        const out: ReactNode[] = [];
        const providers = streaming?.providers || [];
        const n = Math.max(providers.length, genres.length);
        for (let i = 0; i < n; i++) {
            const p = providers[i];
            if (p && kind) out.push(<StreamingRows key={`s-${p.key}`} kind={kind} p={p} />);
            const g = genres[i];
            if (g) {
                out.push(
                    <Row key={`g-${g.genre}`} title={g.genre}>
                        {g.items.map(item => <PosterCard key={item.Id} item={item} />)}
                    </Row>
                );
            }
        }
        return out;
    }, [ streaming, genres, kind ]);

    return (
        <>
            <Hero items={heroItems || []} />
            <main className='fp-rows'>
                <div className='fp-pad fp-libbar'>
                    <h1 className='fp-libbar__title'>{view.Name}</h1>
                    <a className='fp-btn-ghost' href={fullListUrl(view)}>
                        <Icon name='folder' size={16} className='' /><span>Todos os títulos (A–Z)</span>
                    </a>
                </div>

                {!!resume?.length && (
                    <Row title='Continuar assistindo' variant='wide'>
                        {resume.map(item => <WideCard key={item.Id} item={item} />)}
                    </Row>
                )}

                {!!latest?.length && (
                    <Row title='Adicionados recentemente'>
                        {latest.map(item => <PosterCard key={item.Id} item={item} showNew />)}
                    </Row>
                )}

                {top.length >= 3 && (
                    <Row title={`Top 10 em ${view.Name}`} variant='rank'>
                        {top.map((item, i) => <RankCard key={item.Id} item={item} rank={i + 1} />)}
                    </Row>
                )}

                {isPending && (
                    <>
                        <SkeletonRow />
                        <SkeletonRow />
                    </>
                )}

                {mixed}
            </main>
        </>
    );
};

/** Library tab (Filmes / Séries / Animes) in the Freitas+ style. */
const Biblioteca: FC = () => {
    const [ params ] = useSearchParams();
    const id = params.get('id') || '';
    const { data: libraries, isPending } = useLibraries();
    const view = libraries?.find(v => v.Id === id);

    return (
        <FreitasPage id='freitasLibraryPage' title={view?.Name || 'Biblioteca'}>
            {view && <LibraryTab key={view.Id} view={view} />}
            {!view && !isPending && (
                <main className='fp-rows fp-rows--plain'>
                    <p className='fp-pad fp-empty'>Biblioteca não encontrada. <a href='#/home'>Voltar ao início</a></p>
                </main>
            )}
        </FreitasPage>
    );
};

export default Biblioteca;
