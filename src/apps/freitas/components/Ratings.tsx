import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import React, { type FC, useCallback, useEffect, useRef, useState } from 'react';

import freshIcon from 'assets/img/fresh.svg';
import rottenIcon from 'assets/img/rotten.svg';
import layoutManager from 'components/layoutManager';

import {
    combineRatings,
    metascoreTone,
    shortBadge,
    techBadges,
    useItemDetails,
    useOmdb
} from '../ratings';
import { formatRating, isKeyboardFocus } from '../utils';

const Metascore: FC<{ score: number, small?: boolean }> = ({ score, small }) => (
    <span
        className={`fp-mc fp-mc--${metascoreTone(score)}` + (small ? ' fp-mc--small' : '')}
        title={`Metacritic: ${score}`}
        aria-label={`Metacritic ${score}`}
    >{score}</span>
);

/** TMDB · Rotten Tomatoes · Metacritic, for the title page. */
export const RatingsRow: FC<{ item: BaseItemDto }> = ({ item }) => {
    const { data: omdb } = useOmdb(item);
    const r = combineRatings(item, omdb);
    const any = r.tmdb || r.rottenTomatoes != null || r.metascore != null;

    if (!any) return null;

    return (
        <div className='fp-ratings'>
            {r.tmdb ? (
                <span className='fp-rating' title='Nota no TMDB'>
                    <span className='fp-rating__src fp-rating__src--tmdb'>TMDB</span>
                    <span className='fp-rating__val'>{formatRating(r.tmdb)}</span>
                </span>
            ) : null}
            {r.rottenTomatoes != null && (
                <span className='fp-rating' title='Rotten Tomatoes'>
                    <img
                        className='fp-rating__icon'
                        src={r.rottenTomatoes >= 60 ? freshIcon : rottenIcon}
                        alt='Rotten Tomatoes'
                        width={18}
                        height={18}
                    />
                    <span className='fp-rating__val'>{r.rottenTomatoes}%</span>
                </span>
            )}
            {r.metascore != null && (
                <span className='fp-rating' title='Metacritic'>
                    <Metascore score={r.metascore} />
                    <span className='fp-rating__src'>Metacritic</span>
                </span>
            )}
        </div>
    );
};

export const TechChips: FC<{ item?: BaseItemDto | null, className?: string }> = ({ item, className }) => {
    const badges = techBadges(item);
    if (!badges.length) return null;
    return (
        <div className={'fp-tech ' + (className || '')}>
            {badges.map(b => <span key={b} className='fp-tech__chip'>{b}</span>)}
        </div>
    );
};

const HOVER_DELAY = 250;
const FOCUS_DELAY = 450; // longer on remotes so holding an arrow key never triggers requests

function canHover() {
    try {
        return window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    } catch {
        return false;
    }
}

/**
 * True a moment after the card is hovered (mouse) or focused (remote/keyboard).
 * Touch taps never activate it.
 */
export function useCardActive() {
    const [ active, setActive ] = useState(false);
    const timer = useRef<number>();

    const start = useCallback((delay: number) => {
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setActive(true), delay);
    }, []);
    const stop = useCallback(() => {
        window.clearTimeout(timer.current);
        setActive(false);
    }, []);
    useEffect(() => () => window.clearTimeout(timer.current), []);

    const onMouseEnter = useCallback(() => {
        if (canHover()) start(HOVER_DELAY);
    }, [ start ]);
    const onFocus = useCallback((e: React.FocusEvent) => {
        if (isKeyboardFocus(e.currentTarget, layoutManager.tv)) start(FOCUS_DELAY);
    }, [ start ]);
    const onBlur = useCallback((e: React.FocusEvent) => {
        if (!e.currentTarget.matches(':hover')) stop();
    }, [ stop ]);

    return { active, handlers: { onMouseEnter, onMouseLeave: stop, onFocus, onBlur } };
}

/** Discreet Metacritic score + 4K/Dolby badges shown on an active card. */
export const CardInsight: FC<{ item: BaseItemDto }> = ({ item }) => {
    const { data: full } = useItemDetails(item.Id);
    const { data: omdb } = useOmdb(full || item, !!full);
    const badges = techBadges(full);
    const score = omdb?.metascore;
    if (score == null && !badges.length) return null;
    return (
        <div className='fp-insight' aria-hidden='true'>
            {score != null && <Metascore score={score} small />}
            {badges.map(b => <span key={b} className='fp-tech__chip fp-tech__chip--small'>{shortBadge(b)}</span>)}
        </div>
    );
};
