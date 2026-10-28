import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import type { MediaSourceInfo } from '@jellyfin/sdk/lib/generated-client/models/media-source-info';
import type { MediaStream } from '@jellyfin/sdk/lib/generated-client/models/media-stream';
import React, { type FC, useCallback, useEffect, useMemo, useState } from 'react';

import actionSheet from 'components/actionSheet/actionSheet';

import type { PlayTracks } from '../playback';
import { useItemDetails } from '../ratings';
import { languageName } from '../utils';
import { Icon } from './Icons';

/* ---------- labels ---------- */

const CODECS: Record<string, string> = {
    aac: 'AAC', ac3: 'Dolby Digital', eac3: 'Dolby Digital+', truehd: 'Dolby TrueHD', dts: 'DTS',
    flac: 'FLAC', opus: 'Opus', mp3: 'MP3', vorbis: 'Vorbis'
};

function codecName(codec?: string | null): string {
    const c = (codec || '').toLowerCase();
    if (c.startsWith('pcm')) return 'PCM';
    return CODECS[c] || c.toUpperCase();
}

function channelsLabel(n?: number | null) {
    if (!n) return '';
    if (n === 1) return 'Mono';
    if (n === 2) return 'Estéreo';
    if (n === 6) return '5.1';
    if (n === 8) return '7.1';
    return `${n} canais`;
}

function langOrTitle(s: MediaStream): string {
    return languageName(s) || s.Title || s.DisplayTitle || `Faixa ${s.Index}`;
}

export function audioLabel(s: MediaStream): string {
    const text = `${s.Profile || ''} ${s.DisplayTitle || ''}`.toLowerCase();
    const codec = text.includes('atmos') ? 'Dolby Atmos' : codecName(s.Codec);
    const extra = s.Title && !/^(stereo|surround|5\.1|7\.1|default)$/i.test(s.Title) ? s.Title : '';
    return [ langOrTitle(s), extra, channelsLabel(s.Channels), codec ].filter(Boolean).join(' · ');
}

export function subtitleLabel(s: MediaStream): string {
    const flags = [
        s.IsForced && 'forçada',
        s.IsHearingImpaired && 'SDH',
        s.IsExternal && 'externa'
    ].filter(Boolean);
    const extra = s.Title && !/^(forced|sdh|full|default)$/i.test(s.Title) ? s.Title : '';
    return [ langOrTitle(s), extra, ...flags ].filter(Boolean).join(' · ');
}

function sourceLabel(src: MediaSourceInfo): string {
    const video = src.MediaStreams?.find(s => s.Type === 'Video');
    let res = video?.Height ? `${video.Height}p` : '';
    if (video?.Width && video.Width >= 3800) res = '4K';
    return src.Name || [ res, video?.VideoRangeType && video.VideoRangeType !== 'SDR' ? video.VideoRangeType : '' ].filter(Boolean).join(' ') || 'Versão';
}

/* ---------- selection state ---------- */

/**
 * Version / audio / subtitle choice for what the play button will start
 * (the movie, or the episode a series would continue with).
 */
export function useTrackSelection(target?: BaseItemDto | null) {
    const { data: full } = useItemDetails(target?.Id);
    const sources = useMemo(() => (full?.MediaSources || []).filter(s => s.Type !== 'Placeholder'), [ full ]);
    const [ sourceId, setSourceId ] = useState<string>();
    const [ audio, setAudio ] = useState<number>();
    const [ subtitle, setSubtitle ] = useState<number>();

    // start from the server defaults whenever the target changes
    useEffect(() => {
        setSourceId(undefined);
        setAudio(undefined);
        setSubtitle(undefined);
    }, [ target?.Id ]);

    const source = sources.find(s => s.Id === sourceId) || sources[0];
    const audioTracks = (source?.MediaStreams || []).filter(s => s.Type === 'Audio');
    const subtitleTracks = (source?.MediaStreams || []).filter(s => s.Type === 'Subtitle');
    const audioIndex = audio ?? source?.DefaultAudioStreamIndex ?? audioTracks[0]?.Index ?? undefined;
    const subtitleIndex = subtitle ?? source?.DefaultSubtitleStreamIndex ?? -1;

    const pickSource = useCallback((id: string) => {
        setSourceId(id);
        setAudio(undefined);
        setSubtitle(undefined);
    }, []);

    const tracks: PlayTracks | undefined = source ? {
        mediaSourceId: source.Id || undefined,
        audioStreamIndex: audioIndex,
        subtitleStreamIndex: subtitleIndex
    } : undefined;

    return {
        sources, source, audioTracks, subtitleTracks, audioIndex, subtitleIndex,
        pickSource, setAudio, setSubtitle, tracks
    };
}

export type TrackSelection = ReturnType<typeof useTrackSelection>;

/* ---------- UI ---------- */

interface PickerProps {
    label: string
    value: string
    title: string
    items: { id: string, name: string, selected: boolean }[]
    onPick: (id: string) => void
}

const Picker: FC<PickerProps> = ({ label, value, title, items, onPick }) => {
    const onClick = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
        actionSheet.show({ items, title, positionTo: e.currentTarget })
            .then(id => {
                if (id != null) onPick(String(id));
            })
            .catch(() => {
                // closed without choosing
            });
    }, [ items, title, onPick ]);

    return (
        <button type='button' className='fp-track' onClick={onClick} aria-label={`${title}: ${value}`}>
            <span className='fp-track__label'>{label}</span>
            <span className='fp-track__value'>{value}</span>
            <Icon name='chevronDown' size={16} className='fp-track__chev' />
        </button>
    );
};

/** "Versão · Áudio · Legenda" buttons, like the original details page. */
export const TrackPickers: FC<{ sel: TrackSelection }> = ({ sel }) => {
    const { sources, source, audioTracks, subtitleTracks, audioIndex, subtitleIndex, pickSource, setAudio, setSubtitle } = sel;

    const onAudio = useCallback((id: string) => setAudio(Number(id)), [ setAudio ]);
    const onSubtitle = useCallback((id: string) => setSubtitle(Number(id)), [ setSubtitle ]);

    if (!source) return null;

    const currentAudio = audioTracks.find(t => t.Index === audioIndex);
    const currentSub = subtitleTracks.find(t => t.Index === subtitleIndex);

    return (
        <div className='fp-tracks'>
            {sources.length > 1 && (
                <Picker
                    label='Versão'
                    title='Versão'
                    value={sourceLabel(source)}
                    items={sources.map(s => ({ id: s.Id || '', name: sourceLabel(s), selected: s.Id === source.Id }))}
                    onPick={pickSource}
                />
            )}
            {audioTracks.length > 0 && (
                <Picker
                    label='Áudio'
                    title='Áudio'
                    value={currentAudio ? audioLabel(currentAudio) : '—'}
                    items={audioTracks.map(t => ({ id: String(t.Index), name: audioLabel(t), selected: t.Index === audioIndex }))}
                    onPick={onAudio}
                />
            )}
            {subtitleTracks.length > 0 && (
                <Picker
                    label='Legenda'
                    title='Legenda'
                    value={currentSub ? subtitleLabel(currentSub) : 'Desligada'}
                    items={[
                        { id: '-1', name: 'Desligada', selected: subtitleIndex === -1 },
                        ...subtitleTracks.map(t => ({ id: String(t.Index), name: subtitleLabel(t), selected: t.Index === subtitleIndex }))
                    ]}
                    onPick={onSubtitle}
                />
            )}
        </div>
    );
};
