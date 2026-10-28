import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import { ImageType } from '@jellyfin/sdk/lib/generated-client/models/image-type';
import React, { type FC, useCallback, useEffect, useRef, useState } from 'react';

import layoutManager from 'components/layoutManager';
import { useApi } from 'hooks/useApi';

import { useMyList, useToggleMyList } from '../api';
import { playItem } from '../playback';
import {
    backdropWidth,
    formatOfficialRating,
    formatRating,
    imageUrl,
    isKeyboardFocus,
    itemHue,
    lengthLabel
} from '../utils';
import { itemUrl } from './Cards';
import { Icon, PlayGlyph, StarGlyph } from './Icons';

/** The title of a work: its logo image when available, otherwise styled type. */
export const TitleArt: FC<{ item: BaseItemDto, level?: 'h1' | 'h2' }> = ({ item, level = 'h1' }) => {
    const { api } = useApi();
    const logo = imageUrl(api, item, ImageType.Logo, 560);
    const [ logoFailed, setLogoFailed ] = useState(false);
    const name = item.Name || '';
    const Tag = level;

    useEffect(() => setLogoFailed(false), [ logo ]);
    const onLogoError = useCallback(() => setLogoFailed(true), []);

    if (logo && !logoFailed) {
        return (
            <Tag className='fp-title-art fp-title-art--logo' aria-label={name}>
                <img src={logo} alt={name} onError={onLogoError} />
            </Tag>
        );
    }

    const words = name.split(' ');
    const lead = words.length > 1 ? words.slice(0, -1).join(' ') : '';
    const main = words.length > 1 ? words[words.length - 1] : name;
    const h = itemHue(item);
    const long = main.length > 9;

    return (
        <Tag
            className='fp-title-art'
            aria-label={name}
            style={{ filter: `drop-shadow(0 0 28px hsl(${h} 90% 65% / .45))` }}
        >
            {lead && <span className='fp-title-art__lead' aria-hidden='true'>{lead}</span>}
            <span
                className={'fp-title-art__main' + (long ? ' fp-title-art__main--long' : '')}
                aria-hidden='true'
                style={{ backgroundImage: `linear-gradient(180deg, #ffffff 0%, hsl(${h} 90% 85%) 48%, hsl(${h} 85% 66%) 100%)` }}
            >{main}</span>
        </Tag>
    );
};

export const MetaLine: FC<{ item: BaseItemDto, showScore?: boolean, maxGenres?: number }> = ({ item, showScore = true, maxGenres = 2 }) => {
    const rating = formatOfficialRating(item.OfficialRating);
    const length = lengthLabel(item);
    const score = formatRating(item.CommunityRating);
    const genres = (item.Genres || []).slice(0, maxGenres);
    return (
        <div className='fp-meta'>
            {item.ProductionYear && <span>{item.ProductionYear}</span>}
            {rating && <span className='fp-chip'>{rating}</span>}
            {length && <span>{length}</span>}
            {showScore && score && <span className='fp-meta__score'><StarGlyph /><span>{score}</span></span>}
            {genres.length > 0 && <span>{genres.join(' · ')}</span>}
        </div>
    );
};

const ROTATE_MS = 8000;
const SWIPE_MIN = 45;

interface HeroDotProps {
    index: number
    count: number
    name: string
    active: boolean
    paused: boolean
    onPick: (i: number) => void
}

const HeroDot: FC<HeroDotProps> = ({ index, count, name, active, paused, onPick }) => {
    const onClick = useCallback(() => onPick(index), [ index, onPick ]);
    return (
        <button
            type='button'
            className='fp-dot'
            aria-label={`Destaque ${index + 1} de ${count}: ${name}`}
            aria-pressed={active}
            onClick={onClick}
        >
            <span className={'fp-dot__bar' + (active ? ' is-active' : '')}>
                {active && (
                    <span
                        className={'fp-dot__fill' + (paused ? ' is-paused' : '')}
                        style={{ animationDuration: `${ROTATE_MS}ms` }}
                    />
                )}
            </span>
        </button>
    );
};

function canHover() {
    try {
        return window.matchMedia('(hover: hover)').matches;
    } catch {
        return true;
    }
}

type PauseReason = 'hover' | 'focus' | 'offscreen' | 'hidden' | 'touch';

/**
 * Auto-advancing slides. The timer keeps its remaining time across pauses so
 * the progress bar on the active dot and the slide change stay in sync.
 */
function useRotation(count: number) {
    const [ index, setIndex ] = useState(0);
    const [ reasons, setReasons ] = useState<Partial<Record<PauseReason, boolean>>>({});
    const remaining = useRef(ROTATE_MS);
    const paused = Object.values(reasons).some(Boolean);

    const setPaused = useCallback((reason: PauseReason, on: boolean) => {
        setReasons(r => (!!r[reason] === on ? r : { ...r, [reason]: on }));
    }, []);

    useEffect(() => {
        remaining.current = ROTATE_MS;
    }, [ index ]);

    useEffect(() => {
        if (count < 2 || paused) return;
        const started = Date.now();
        const t = window.setTimeout(() => setIndex(i => (i + 1) % count), remaining.current);
        return () => {
            window.clearTimeout(t);
            remaining.current = Math.max(0, remaining.current - (Date.now() - started));
        };
    }, [ index, paused, count ]);

    useEffect(() => {
        // guarded: old TV browsers without the Page Visibility API just never pause
        // eslint-disable-next-line compat/compat
        const onVisibility = () => setPaused('hidden', !!document.hidden);
        document.addEventListener('visibilitychange', onVisibility);
        return () => document.removeEventListener('visibilitychange', onVisibility);
    }, [ setPaused ]);

    const go = useCallback((delta: number) => {
        if (count < 2) return;
        setIndex(i => (i + delta + count) % count);
    }, [ count ]);

    return { index: Math.min(index, Math.max(0, count - 1)), setIndex, paused, setPaused, go };
}

const Hero: FC<{ items: BaseItemDto[] }> = ({ items }) => {
    const { api } = useApi();
    const { data: myList } = useMyList();
    const toggleList = useToggleMyList();
    const sectionRef = useRef<HTMLElement>(null);
    const touch = useRef<{ x: number, y: number } | null>(null);

    const count = items.length;
    const { index, setIndex, paused, setPaused, go } = useRotation(count);
    const item = items[index];
    const width = backdropWidth();

    // Only rotate while the hero is actually on screen
    useEffect(() => {
        const el = sectionRef.current;
        if (!el || typeof IntersectionObserver === 'undefined') return;
        const io = new IntersectionObserver(
            ([ entry ]) => setPaused('offscreen', entry.intersectionRatio < 0.35),
            { threshold: [ 0, 0.35, 1 ] }
        );
        io.observe(el);
        return () => io.disconnect();
    }, [ setPaused, item ]);

    // Warm up the next backdrop so the change is instant
    useEffect(() => {
        if (count < 2) return;
        const next = imageUrl(api, items[(index + 1) % count], ImageType.Backdrop, width, 2400);
        if (next) new Image().src = next;
    }, [ api, items, index, count, width ]);

    // Mouse hover pauses; a finger tap must not (iOS never sends the matching "leave")
    const onPointerEnter = useCallback((e: React.PointerEvent) => {
        if (e.pointerType === 'mouse' && canHover()) setPaused('hover', true);
    }, [ setPaused ]);
    const onPointerLeave = useCallback(() => setPaused('hover', false), [ setPaused ]);
    const onFocus = useCallback((e: React.FocusEvent) => {
        if (isKeyboardFocus(e.target, layoutManager.tv)) setPaused('focus', true);
    }, [ setPaused ]);
    const onBlur = useCallback((e: React.FocusEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPaused('focus', false);
    }, [ setPaused ]);

    const onTouchStart = useCallback((e: React.TouchEvent) => {
        const t = e.touches[0];
        touch.current = { x: t.clientX, y: t.clientY };
        setPaused('touch', true);
    }, [ setPaused ]);
    const onTouchEnd = useCallback((e: React.TouchEvent) => {
        const start = touch.current;
        touch.current = null;
        setPaused('touch', false);
        const t = e.changedTouches[0];
        if (!start || !t) return;
        const dx = t.clientX - start.x;
        const dy = t.clientY - start.y;
        if (Math.abs(dx) > SWIPE_MIN && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
    }, [ go, setPaused ]);

    const onPlay = useCallback(() => {
        if (item) playItem(item);
    }, [ item ]);
    const inList = !!item && !!myList?.items.some(i => i.Id === item.Id);
    const onToggleList = useCallback(() => {
        if (item) toggleList.mutate({ item, inList });
    }, [ item, inList, toggleList ]);

    if (!item) return <section className='fp-hero fp-hero--empty' aria-hidden='true' />;

    const backdrop = imageUrl(api, item, ImageType.Backdrop, width, 2400);
    const h = itemHue(item);

    return (
        <section
            ref={sectionRef}
            className='fp-hero fp-hero--home'
            aria-label='Destaques'
            aria-roledescription='carrossel'
            onFocus={onFocus}
            onBlur={onBlur}
            onPointerEnter={onPointerEnter}
            onPointerLeave={onPointerLeave}
            onTouchStart={onTouchStart}
            onTouchEnd={onTouchEnd}
            onTouchCancel={onTouchEnd}
        >
            <div
                className='fp-hero__bg'
                style={{ background: `radial-gradient(80% 90% at 82% 24%, hsl(${h} 55% 30%) 0%, transparent 70%), linear-gradient(170deg, hsl(${(h + 30) % 360} 50% 16%) 0%, hsl(${(h + 50) % 360} 40% 8%) 60%, #0b0b0e 100%)` }}
            />
            {backdrop && <img key={backdrop} className='fp-hero__img' src={backdrop} alt='' aria-hidden='true' />}
            <div className='fp-hero__shade-x' aria-hidden='true' />
            <div className='fp-hero__shade-y' aria-hidden='true' />

            <div className='fp-hero__body fp-pad' key={item.Id}>
                <div className='fp-hero__titlebox'>
                    <TitleArt item={item} />
                </div>
                <MetaLine item={item} />
                {item.Overview && <p className='fp-hero__syn'>{item.Overview}</p>}
                <div className='fp-actions-row'>
                    <button type='button' className='fp-btn-play' onClick={onPlay}>
                        <PlayGlyph />
                        <span>Assistir</span>
                    </button>
                    <button
                        type='button'
                        className='fp-btn-round'
                        aria-pressed={inList}
                        aria-label={inList ? 'Remover da minha lista' : 'Adicionar à minha lista'}
                        title={inList ? 'Remover da minha lista' : 'Adicionar à minha lista'}
                        onClick={onToggleList}
                    >
                        <Icon name={inList ? 'check' : 'plus'} size={22} strokeWidth={2.2} className='' />
                    </button>
                    <a className='fp-btn-round' href={itemUrl(item)} aria-label='Mais informações' title='Mais informações'>
                        <Icon name='info' size={22} className='' />
                    </a>
                </div>
            </div>

            {count > 1 && (
                <div className='fp-hero__dots' role='group' aria-label='Escolher destaque'>
                    {items.map((it, i) => (
                        <HeroDot
                            key={it.Id}
                            index={i}
                            count={count}
                            name={it.Name || ''}
                            active={i === index}
                            paused={paused}
                            onPick={setIndex}
                        />
                    ))}
                </div>
            )}
        </section>
    );
};

export default Hero;
