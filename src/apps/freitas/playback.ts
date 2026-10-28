import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';

import { playbackManager } from 'components/playback/playbackmanager';

/** Version / audio / subtitle chosen on the title page (-1 = subtitles off). */
export interface PlayTracks {
    mediaSourceId?: string
    audioStreamIndex?: number
    subtitleStreamIndex?: number
}

/** Plays an item, resuming where the user stopped, with the chosen tracks if any. */
export function playItem(item: BaseItemDto, fromStart = false, tracks?: PlayTracks) {
    const startPositionTicks = fromStart ? 0 : (item.UserData?.PlaybackPositionTicks || 0);
    playbackManager.play({
        items: [ item ],
        startPositionTicks,
        ...(tracks?.mediaSourceId ? { mediaSourceId: tracks.mediaSourceId } : {}),
        ...(tracks?.audioStreamIndex != null ? { audioStreamIndex: tracks.audioStreamIndex } : {}),
        ...(tracks?.subtitleStreamIndex != null ? { subtitleStreamIndex: tracks.subtitleStreamIndex } : {})
    }).catch((err: unknown) => {
        console.error('[Freitas] failed to play', err);
    });
}

export function playTrailer(item: BaseItemDto) {
    playbackManager.playTrailers(item).catch((err: unknown) => {
        console.error('[Freitas] failed to play trailer', err);
    });
}
