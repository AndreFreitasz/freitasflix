import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';

import { playbackManager } from 'components/playback/playbackmanager';

/** Plays an item, resuming where the user stopped. */
export function playItem(item: BaseItemDto, fromStart = false) {
    const startPositionTicks = fromStart ? 0 : (item.UserData?.PlaybackPositionTicks || 0);
    playbackManager.play({
        items: [ item ],
        startPositionTicks
    }).catch((err: unknown) => {
        console.error('[Freitas] failed to play', err);
    });
}

export function playTrailer(item: BaseItemDto) {
    playbackManager.playTrailers(item).catch((err: unknown) => {
        console.error('[Freitas] failed to play trailer', err);
    });
}
