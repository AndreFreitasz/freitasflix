import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import classNames from 'classnames';
import React, { type FC, useSyncExternalStore } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';

import RemotePlayButton from 'apps/modern/components/AppToolbar/RemotePlayButton';
import SyncPlayButton from 'apps/modern/components/AppToolbar/SyncPlayButton';
import { appRouter } from 'components/router/appRouter';
import UserMenuButton from 'components/toolbar/UserMenuButton';
import { useApi } from 'hooks/useApi';

import { useLibraries } from '../api';
import { Icon } from './Icons';

/* A tiny store so pages (e.g. the title page) can tell the header which library is active. */
let activeLibraryId: string | undefined;
const listeners = new Set<() => void>();
export function setActiveLibrary(id?: string) {
    if (activeLibraryId === id) return;
    activeLibraryId = id;
    for (const l of listeners) l();
}
const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
};
const getActive = () => activeLibraryId;

function libraryIcon(view: BaseItemDto) {
    if (/anime/i.test(view.Name || '')) return 'sparkles';
    switch (view.CollectionType) {
        case 'movies': return 'film';
        case 'tvshows': return 'tv';
        case 'music': return 'music';
        default: return 'folder';
    }
}

function libraryUrl(view: BaseItemDto) {
    try {
        return appRouter.getRouteUrl(view, { context: view.CollectionType }) as string;
    } catch {
        return `#/list?parentId=${view.Id}`;
    }
}

interface HeaderProps {
    /** Transparent header that floats over a hero image. */
    overlay?: boolean
    /** Rendered inside the stock app bar (other pages of the modern layout). */
    inline?: boolean
}

const Header: FC<HeaderProps> = ({ overlay = false, inline = false }) => {
    const { user } = useApi();
    const location = useLocation();
    const [ searchParams ] = useSearchParams();
    const { data: libraries } = useLibraries();
    const pageLibraryId = useSyncExternalStore(subscribe, getActive);

    const tab = searchParams.get('tab');
    const isHome = location.pathname === '/home' && tab !== 'favoritos' && tab !== '1';
    const isFavorites = location.pathname === '/home' && (tab === 'favoritos' || tab === '1');
    const currentLibraryId = searchParams.get('topParentId') || searchParams.get('parentId')
        || (location.pathname === '/titulo' ? pageLibraryId : undefined);

    if (!user) return null;

    return (
        <header className={classNames('fp-header', 'focus-lowpriority', { 'fp-header--overlay': overlay, 'fp-header--inline': inline })}>
            <a className='fp-brand' href='#/home' aria-label='FREITAS+ — início'>
                <span className='fp-logo'>FREITAS<span className='fp-logo__plus'>+</span></span>
            </a>

            <nav className='fp-nav' aria-label='Principal'>
                <a className='fp-nav__item' href='#/home' aria-current={isHome ? 'page' : undefined}>
                    <Icon name='home' /><span className='fp-nav__label'>Início</span>
                </a>
                <a className='fp-nav__item' href='#/home?tab=favoritos' aria-current={isFavorites ? 'page' : undefined}>
                    <Icon name='heart' /><span className='fp-nav__label'>Favoritos</span>
                </a>
                {(libraries || []).map(view => (
                    <a
                        key={view.Id}
                        className='fp-nav__item'
                        href={libraryUrl(view)}
                        aria-current={currentLibraryId === view.Id ? 'page' : undefined}
                    >
                        <Icon name={libraryIcon(view)} /><span className='fp-nav__label'>{view.Name}</span>
                    </a>
                ))}
            </nav>

            <div className='fp-actions'>
                <span className='fp-action fp-action--extra' title='Assistir juntos'><SyncPlayButton /></span>
                <span className='fp-action fp-action--extra' title='Transmitir'><RemotePlayButton /></span>
                <a className='fp-action fp-btn-icon' href='#/search' aria-label='Buscar' title='Buscar'>
                    <Icon name='search' />
                </a>
                <span className='fp-action fp-action--avatar'><UserMenuButton /></span>
            </div>
        </header>
    );
};

export default Header;
