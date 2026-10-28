import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import React, { type FC } from 'react';
import { useSearchParams } from 'react-router-dom';

import { appRouter } from 'components/router/appRouter';

import {
    useContinueWatching,
    useFavoriteItems,
    useHeroItems,
    useLatestItems,
    useLibraries,
    useLibraryItems,
    useMyList,
    useTopRated
} from '../api';
import { PosterCard, RankCard, Row, WideCard } from '../components/Cards';
import Hero from '../components/Hero';
import FreitasPage, { SkeletonRow } from '../components/Layout';

function libraryRowTitle(view: BaseItemDto) {
    const name = view.Name || '';
    if (/anime/i.test(name)) return `${name} para maratonar`;
    if (view.CollectionType === 'movies') return `${name} para esta noite`;
    if (view.CollectionType === 'tvshows') return `${name} em alta`;
    return name;
}

function libraryHref(view: BaseItemDto) {
    try {
        return appRouter.getRouteUrl(view, { context: view.CollectionType }) as string;
    } catch {
        return undefined;
    }
}

const LibraryRow: FC<{ view: BaseItemDto }> = ({ view }) => {
    const { data, isPending } = useLibraryItems(view.Id, 'random');
    if (isPending) return <SkeletonRow />;
    if (!data?.length) return null;
    return (
        <Row title={libraryRowTitle(view)} seeAllHref={libraryHref(view)}>
            {data.map(item => <PosterCard key={item.Id} item={item} />)}
        </Row>
    );
};

const ContinueRow: FC = () => {
    const { data } = useContinueWatching();
    if (!data?.length) return null;
    return (
        <Row title='Continuar assistindo' variant='wide'>
            {data.map(item => <WideCard key={item.Id} item={item} />)}
        </Row>
    );
};

const HomeTab: FC = () => {
    const { data: heroItems } = useHeroItems();
    const { data: latest, isPending: latestPending } = useLatestItems();
    const { data: top } = useTopRated();
    const { data: libraries } = useLibraries();

    const videoLibraries = (libraries || []).filter(v => v.CollectionType === 'movies' || v.CollectionType === 'tvshows');

    return (
        <>
            <Hero items={heroItems || []} />
            <main className='fp-rows'>
                {latestPending && <SkeletonRow />}
                {!!latest?.length && (
                    <Row title='Adicionados recentemente'>
                        {latest.map(item => <PosterCard key={item.Id} item={item} showNew />)}
                    </Row>
                )}
                <ContinueRow />
                {!!top?.length && top.length >= 3 && (
                    <Row title='Mais bem avaliados' variant='rank'>
                        {top.map((item, i) => <RankCard key={item.Id} item={item} rank={i + 1} />)}
                    </Row>
                )}
                {videoLibraries.map(view => <LibraryRow key={view.Id} view={view} />)}
            </main>
        </>
    );
};

const FavoritesTab: FC = () => {
    const { data: myList } = useMyList();
    const { data: favorites, isPending } = useFavoriteItems();
    const hasAny = !!myList?.items.length || !!favorites?.length;

    return (
        <main className='fp-rows fp-rows--plain'>
            <div className='fp-pad fp-page-title'>
                <h1>Favoritos</h1>
                <p>O que você marcou com ♥ e o que guardou na sua lista.</p>
            </div>
            {!!myList?.items.length && (
                <Row title='Minha lista'>
                    {myList.items.map(item => <PosterCard key={item.Id} item={item} />)}
                </Row>
            )}
            {isPending && <SkeletonRow />}
            {!!favorites?.length && (
                <Row title='Seus favoritos'>
                    {favorites.map(item => <PosterCard key={item.Id} item={item} />)}
                </Row>
            )}
            <ContinueRow />
            {!isPending && !hasAny && (
                <p className='fp-pad fp-empty'>
                    Nada por aqui ainda. Use o ♥ ou o + na página de um título para guardar.
                </p>
            )}
        </main>
    );
};

const Home: FC = () => {
    const [ searchParams ] = useSearchParams();
    const tab = searchParams.get('tab');
    const isFavorites = tab === 'favoritos' || tab === '1';

    return (
        <FreitasPage id='freitasHomePage' title='Início'>
            {isFavorites ? <FavoritesTab /> : <HomeTab />}
        </FreitasPage>
    );
};

export default Home;
