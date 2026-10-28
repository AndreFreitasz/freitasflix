import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import { ImageType } from '@jellyfin/sdk/lib/generated-client/models/image-type';
import React, { type FC, type ReactNode, useCallback, useState } from 'react';

import { appRouter } from 'components/router/appRouter';
import { useApi } from 'hooks/useApi';

import { playItem } from '../playback';
import {
    episodeCode,
    imageUrl,
    isRecent,
    plateLabel,
    posterPlaceholder,
    progressPercent,
    remainingLabel
} from '../utils';
import { Icon, PlayGlyph } from './Icons';
import { CardInsight, useCardActive } from './Ratings';

export function itemUrl(item: BaseItemDto): string {
    try {
        return appRouter.getRouteUrl(item, { serverId: item.ServerId }) as string;
    } catch {
        return `#/details?id=${item.Id}`;
    }
}

/** Image with a gradient placeholder underneath; hides itself when it fails. */
const Art: FC<{ src?: string, alt?: string, item?: BaseItemDto, className?: string }> = ({ src, alt = '', item, className }) => {
    const [ failed, setFailed ] = useState(false);
    const onError = useCallback(() => setFailed(true), []);
    return (
        <div className={'fp-art ' + (className || '')} style={{ background: posterPlaceholder(item) }}>
            {src && !failed && (
                <img
                    src={src}
                    alt={alt}
                    loading='lazy'
                    decoding='async'
                    onError={onError}
                />
            )}
        </div>
    );
};

const Plate: FC<{ eyebrow?: string, title: string, compact?: boolean }> = ({ eyebrow, title, compact }) => (
    <div className={'fp-plate' + (compact ? ' fp-plate--compact' : '')}>
        {eyebrow && <span className='fp-plate__eyebrow'>{eyebrow}</span>}
        <span className='fp-plate__title'>{title}</span>
    </div>
);

const hasInsight = (item: BaseItemDto) => item.Type === 'Movie' || item.Type === 'Series';

export const PosterCard: FC<{ item: BaseItemDto, showNew?: boolean }> = ({ item, showNew }) => {
    const { api } = useApi();
    const { active, handlers } = useCardActive();
    const title = item.Type === 'Episode' ? (item.SeriesName || item.Name || '') : (item.Name || '');
    return (
        <a className='fp-card fp-card--poster' href={itemUrl(item)} aria-label={title} {...handlers}>
            <div className='fp-card__frame fp-ratio-poster'>
                <Art src={imageUrl(api, item, ImageType.Primary, 220)} item={item} />
                <div className='fp-sheen' aria-hidden='true' />
                {showNew && isRecent(item) && !active && (
                    <span className='fp-badge fp-glass'><span className='fp-badge__dot' />Novo</span>
                )}
                {active && hasInsight(item) && <CardInsight item={item} />}
                <Plate eyebrow={plateLabel(item)} title={title} />
            </div>
        </a>
    );
};

export const RankCard: FC<{ item: BaseItemDto, rank: number }> = ({ item, rank }) => {
    const { api } = useApi();
    const { active, handlers } = useCardActive();
    return (
        <a
            className='fp-card fp-card--rank'
            href={itemUrl(item)}
            aria-label={`${rank}º: ${item.Name}`}
            {...handlers}
        >
            <span className='fp-rank__num' aria-hidden='true'>{rank}</span>
            <div className='fp-card__frame fp-ratio-poster fp-rank__poster'>
                <Art src={imageUrl(api, item, ImageType.Primary, 160)} item={item} />
                <div className='fp-sheen' aria-hidden='true' />
                {active && hasInsight(item) && <CardInsight item={item} />}
                <Plate title={item.Name || ''} compact />
            </div>
        </a>
    );
};

export const WideCard: FC<{ item: BaseItemDto }> = ({ item }) => {
    const { api } = useApi();
    const isEpisode = item.Type === 'Episode';
    const title = isEpisode ? (item.SeriesName || item.Name || '') : (item.Name || '');
    const progress = progressPercent(item);
    const code = episodeCode(item);
    const remaining = remainingLabel(item);
    const sub = [ code, remaining ].filter(Boolean).join(' — ')
        || (isEpisode ? `Próximo: ${item.Name}` : '');
    const capitalized = sub ? sub.charAt(0).toUpperCase() + sub.slice(1) : '';
    const onClick = useCallback(() => playItem(item), [ item ]);

    return (
        <button
            type='button'
            className='fp-card fp-card--wide'
            aria-label={`Continuar ${title}`}
            onClick={onClick}
        >
            <div className='fp-card__frame fp-ratio-wide'>
                <Art src={imageUrl(api, item, ImageType.Thumb, 360)} item={item} />
                <div className='fp-sheen' aria-hidden='true' />
                <span className='fp-wide__play fp-glass' aria-hidden='true'><PlayGlyph size={20} /></span>
                <div className='fp-plate fp-plate--row'>
                    <span className='fp-plate__title'>{title}</span>
                </div>
                {progress > 0 && (
                    <div className='fp-progress' aria-hidden='true'>
                        <div className='fp-progress__bar' style={{ width: `${progress}%` }} />
                    </div>
                )}
            </div>
            {capitalized && <div className='fp-card__sub'>{capitalized}</div>}
        </button>
    );
};

interface RowProps {
    title: string
    seeAllHref?: string
    variant?: 'poster' | 'wide' | 'rank'
    children: ReactNode
}

export const Row: FC<RowProps> = ({ title, seeAllHref, variant = 'poster', children }) => {
    const id = 'fp-row-' + title.replace(/\W+/g, '-').toLowerCase();
    return (
        <section className='fp-row' aria-labelledby={id}>
            <div className='fp-row__head fp-pad'>
                <h2 id={id} className='fp-row__title'>{title}</h2>
                {seeAllHref && (
                    <a className='fp-seeall' href={seeAllHref}>
                        Ver tudo <Icon name='chevronRight' size={16} />
                    </a>
                )}
            </div>
            <div className={`fp-scroller fp-pad fp-scroller--${variant} focuscontainer-x`}>
                {children}
            </div>
        </section>
    );
};
