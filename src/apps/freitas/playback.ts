import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';

import { playbackManager } from 'components/playback/playbackmanager';
import { ServerConnections } from 'lib/jellyfin-apiclient';

/** Version / audio / subtitle chosen on the title page (-1 = subtitles off). */
export interface PlayTracks {
    mediaSourceId?: string
    audioStreamIndex?: number
    subtitleStreamIndex?: number
}

/**
 * Movies handed to the player as they are never get refetched, so they would lack the
 * trickplay info (frame preview on the seek bar). Episodes are refetched by the player.
 */
async function withTrickplay(item: BaseItemDto): Promise<BaseItemDto> {
    if (item.Type !== 'Movie' || item.Trickplay || !item.Id) return item;
    try {
        const apiClient = ServerConnections.getApiClient(item.ServerId);
        if (!apiClient) return item;
        const res = await apiClient.getItems(apiClient.getCurrentUserId(), {
            Ids: item.Id,
            Fields: 'Trickplay,Chapters,MediaSources'
        }) as { Items?: BaseItemDto[] };
        return res.Items?.[0] || item;
    } catch {
        return item; // play without the preview rather than not at all
    }
}

/** Plays an item, resuming where the user stopped, with the chosen tracks if any. */
export function playItem(item: BaseItemDto, fromStart = false, tracks?: PlayTracks) {
    const startPositionTicks = fromStart ? 0 : (item.UserData?.PlaybackPositionTicks || 0);
    withTrickplay(item).then(full => playbackManager.play({
        items: [ full ],
        startPositionTicks,
        ...(tracks?.mediaSourceId ? { mediaSourceId: tracks.mediaSourceId } : {}),
        ...(tracks?.audioStreamIndex != null ? { audioStreamIndex: tracks.audioStreamIndex } : {}),
        ...(tracks?.subtitleStreamIndex != null ? { subtitleStreamIndex: tracks.subtitleStreamIndex } : {})
    })).catch((err: unknown) => {
        console.error('[Freitas] failed to play', err);
    });
}

export function playTrailer(item: BaseItemDto) {
    playbackManager.playTrailers(item).catch((err: unknown) => {
        console.error('[Freitas] failed to play trailer', err);
    });
}
