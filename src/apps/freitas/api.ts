import type { Api } from '@jellyfin/sdk';
import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import { BaseItemKind } from '@jellyfin/sdk/lib/generated-client/models/base-item-kind';
import { ImageType } from '@jellyfin/sdk/lib/generated-client/models/image-type';
import { ItemFields } from '@jellyfin/sdk/lib/generated-client/models/item-fields';
import { ItemSortBy } from '@jellyfin/sdk/lib/generated-client/models/item-sort-by';
import { MediaType } from '@jellyfin/sdk/lib/generated-client/models/media-type';
import { SortOrder } from '@jellyfin/sdk/lib/generated-client/models/sort-order';
import { getLibraryApi } from '@jellyfin/sdk/lib/utils/api/library-api';
import { getPlaylistApi } from '@jellyfin/sdk/lib/utils/api/playlist-api';
import { getShowApi } from '@jellyfin/sdk/lib/utils/api/show-api';
import { getUserDataApi } from '@jellyfin/sdk/lib/utils/api/user-data-api';
import { getUserViewApi } from '@jellyfin/sdk/lib/utils/api/user-view-api';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useApi } from 'hooks/useApi';

/** Fields every card needs. */
export const CARD_FIELDS: ItemFields[] = [
    ItemFields.Genres,
    ItemFields.DateCreated,
    ItemFields.PrimaryImageAspectRatio,
    ItemFields.Overview,
    ItemFields.ChildCount
];

const VIDEO_TYPES: BaseItemKind[] = [ BaseItemKind.Movie, BaseItemKind.Series ];
const MY_LIST_NAME = 'Minha lista';

function useCtx() {
    const { api, user } = useApi();
    return { api, userId: user?.Id, enabled: !!api && !!user?.Id };
}

/* ---------- Libraries (header nav + per-library rows) ---------- */

export function useLibraries() {
    const { api, userId, enabled } = useCtx();
    return useQuery({
        queryKey: [ 'freitas', userId, 'libraries' ],
        queryFn: async ({ signal }) => {
            const res = await getUserViewApi(api!).getUserViews({ userId }, { signal });
            return (res.data.Items || []).filter(v => v.CollectionType !== 'playlists' && v.CollectionType !== 'livetv');
        },
        enabled,
        staleTime: 5 * 60 * 1000
    });
}

/* ---------- Home rows ---------- */

export function useHeroItems(parentId?: string) {
    const { api, userId, enabled } = useCtx();
    return useQuery({
        queryKey: [ 'freitas', userId, 'hero', parentId ],
        queryFn: async ({ signal }) => {
            const res = await getLibraryApi(api!).getItems({
                userId,
                parentId,
                includeItemTypes: VIDEO_TYPES,
                recursive: true,
                imageTypes: [ ImageType.Backdrop ],
                sortBy: [ ItemSortBy.DateCreated ],
                sortOrder: [ SortOrder.Descending ],
                fields: CARD_FIELDS,
                enableUserData: true,
                limit: 5
            }, { signal });
            return res.data.Items || [];
        },
        enabled
    });
}

export function useLatestItems(parentId?: string, limit = 16) {
    const { api, userId, enabled } = useCtx();
    return useQuery({
        queryKey: [ 'freitas', userId, 'latest', parentId, limit ],
        queryFn: async ({ signal }) => {
            const res = await getLibraryApi(api!).getItems({
                userId,
                parentId,
                includeItemTypes: VIDEO_TYPES,
                recursive: true,
                sortBy: [ ItemSortBy.DateCreated ],
                sortOrder: [ SortOrder.Descending ],
                fields: CARD_FIELDS,
                enableUserData: true,
                limit
            }, { signal });
            return res.data.Items || [];
        },
        enabled
    });
}

/** Resume items + next episodes, newest activity first, one entry per series. */
export function useContinueWatching(parentId?: string) {
    const { api, userId, enabled } = useCtx();
    return useQuery({
        queryKey: [ 'freitas', userId, 'continue', parentId ],
        queryFn: async ({ signal }) => {
            const fields = [ ...CARD_FIELDS, ItemFields.MediaSourceCount ];
            const [ resume, nextUp ] = await Promise.all([
                getLibraryApi(api!).getResumeItems({
                    userId, parentId, limit: 16, fields, mediaTypes: [ MediaType.Video ], enableUserData: true
                }, { signal }),
                getShowApi(api!).getNextUp({
                    userId, parentId, limit: 16, fields, enableUserData: true, enableResumable: false
                }, { signal })
            ]);
            const seen = new Set<string>();
            const out: BaseItemDto[] = [];
            for (const it of [ ...(resume.data.Items || []), ...(nextUp.data.Items || []) ]) {
                const key = it.SeriesId || it.Id || '';
                if (seen.has(key)) continue;
                seen.add(key);
                out.push(it);
            }
            return out;
        },
        enabled
    });
}

export function useTopRated(parentId?: string) {
    const { api, userId, enabled } = useCtx();
    return useQuery({
        queryKey: [ 'freitas', userId, 'top', parentId ],
        queryFn: async ({ signal }) => {
            const res = await getLibraryApi(api!).getItems({
                userId,
                parentId,
                includeItemTypes: VIDEO_TYPES,
                recursive: true,
                sortBy: [ ItemSortBy.CommunityRating, ItemSortBy.DateCreated ],
                sortOrder: [ SortOrder.Descending ],
                fields: CARD_FIELDS,
                enableUserData: true,
                limit: 10
            }, { signal });
            return (res.data.Items || []).filter(i => i.CommunityRating);
        },
        enabled
    });
}

export function useLibraryItems(parentId: string | undefined, sort: 'random' | 'rating' | 'latest' = 'random', limit = 16) {
    const { api, userId, enabled } = useCtx();
    const SORTS: Record<typeof sort, ItemSortBy> = {
        random: ItemSortBy.Random,
        rating: ItemSortBy.CommunityRating,
        latest: ItemSortBy.DateCreated
    };
    const sortBy = [ SORTS[sort] ];
    return useQuery({
        queryKey: [ 'freitas', userId, 'library', parentId, sort, limit ],
        queryFn: async ({ signal }) => {
            const res = await getLibraryApi(api!).getItems({
                userId,
                parentId,
                includeItemTypes: VIDEO_TYPES,
                recursive: true,
                sortBy,
                sortOrder: [ SortOrder.Descending ],
                fields: CARD_FIELDS,
                enableUserData: true,
                limit
            }, { signal });
            return res.data.Items || [];
        },
        enabled: enabled && !!parentId,
        staleTime: 10 * 60 * 1000
    });
}

export function useFavoriteItems() {
    const { api, userId, enabled } = useCtx();
    return useQuery({
        queryKey: [ 'freitas', userId, 'favorites' ],
        queryFn: async ({ signal }) => {
            const res = await getLibraryApi(api!).getItems({
                userId,
                includeItemTypes: [ ...VIDEO_TYPES, BaseItemKind.Episode ],
                recursive: true,
                isFavorite: true,
                sortBy: [ ItemSortBy.SortName ],
                sortOrder: [ SortOrder.Ascending ],
                fields: CARD_FIELDS,
                enableUserData: true,
                limit: 60
            }, { signal });
            return res.data.Items || [];
        },
        enabled
    });
}

/* ---------- "Minha lista" (a playlist kept per user) ---------- */

async function findMyList(api: Api, userId?: string) {
    const res = await getLibraryApi(api).getItems({
        userId,
        includeItemTypes: [ BaseItemKind.Playlist ],
        recursive: true,
        searchTerm: MY_LIST_NAME
    });
    return (res.data.Items || []).find(p => p.Name === MY_LIST_NAME);
}

export function useMyList() {
    const { api, userId, enabled } = useCtx();
    return useQuery({
        queryKey: [ 'freitas', userId, 'mylist' ],
        queryFn: async () => {
            const list = await findMyList(api!, userId);
            if (!list?.Id) return { playlistId: undefined as string | undefined, items: [] as BaseItemDto[] };
            const res = await getPlaylistApi(api!).getPlaylistItems({
                playlistId: list.Id, userId, fields: CARD_FIELDS, enableUserData: true
            });
            return { playlistId: list.Id, items: res.data.Items || [] };
        },
        enabled
    });
}

export function useToggleMyList() {
    const { api, userId } = useCtx();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ item, inList }: { item: BaseItemDto, inList: boolean }) => {
            if (!api || !item.Id) return;
            const list = await findMyList(api, userId);
            if (inList) {
                if (!list?.Id) return;
                const res = await getPlaylistApi(api).getPlaylistItems({ playlistId: list.Id, userId });
                const entry = (res.data.Items || []).find(i => i.Id === item.Id);
                if (entry?.PlaylistItemId) {
                    await getPlaylistApi(api).removeItemFromPlaylist({ playlistId: list.Id, entryIds: [ entry.PlaylistItemId ] });
                }
                return;
            }
            if (!list?.Id) {
                await getPlaylistApi(api).createPlaylist({
                    createPlaylistDto: { Name: MY_LIST_NAME, Ids: [ item.Id ], UserId: userId, MediaType: MediaType.Video }
                });
                return;
            }
            await getPlaylistApi(api).addItemToPlaylist({ playlistId: list.Id, ids: [ item.Id ], userId });
        },
        onSettled: () => queryClient.invalidateQueries({ queryKey: [ 'freitas', userId, 'mylist' ] })
    });
}

export function useToggleFavorite() {
    const { api, userId } = useCtx();
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async ({ itemId, isFavorite }: { itemId: string, isFavorite: boolean }) => {
            if (!api) return;
            if (isFavorite) {
                await getUserDataApi(api).unmarkFavoriteItem({ itemId, userId });
            } else {
                await getUserDataApi(api).markFavoriteItem({ itemId, userId });
            }
        },
        onSettled: (_d, _e, vars) => {
            void queryClient.invalidateQueries({ queryKey: [ 'freitas', userId, 'item', vars.itemId ] });
            void queryClient.invalidateQueries({ queryKey: [ 'freitas', userId, 'favorites' ] });
        }
    });
}

/* ---------- Title page ---------- */

export function useTitle(itemId?: string) {
    const { api, userId, enabled } = useCtx();
    return useQuery({
        queryKey: [ 'freitas', userId, 'item', itemId ],
        queryFn: async ({ signal }) => {
            const res = await getLibraryApi(api!).getItem({ itemId: itemId!, userId }, { signal });
            return res.data;
        },
        enabled: enabled && !!itemId
    });
}

export function useAncestorLibraryId(itemId?: string) {
    const { api, userId, enabled } = useCtx();
    return useQuery({
        queryKey: [ 'freitas', userId, 'ancestors', itemId ],
        queryFn: async ({ signal }) => {
            const res = await getLibraryApi(api!).getAncestors({ itemId: itemId!, userId }, { signal });
            return (res.data || []).find(a => a.Type === 'CollectionFolder')?.Id;
        },
        enabled: enabled && !!itemId,
        staleTime: Infinity
    });
}

export function useSeasons(seriesId?: string) {
    const { api, userId, enabled } = useCtx();
    return useQuery({
        queryKey: [ 'freitas', userId, 'seasons', seriesId ],
        queryFn: async ({ signal }) => {
            const res = await getShowApi(api!).getSeasons({ seriesId: seriesId!, userId, enableUserData: true }, { signal });
            return res.data.Items || [];
        },
        enabled: enabled && !!seriesId
    });
}

export function useEpisodes(seriesId?: string, seasonId?: string) {
    const { api, userId, enabled } = useCtx();
    return useQuery({
        queryKey: [ 'freitas', userId, 'episodes', seriesId, seasonId ],
        queryFn: async ({ signal }) => {
            const res = await getShowApi(api!).getEpisodes({
                seriesId: seriesId!,
                seasonId,
                userId,
                fields: [ ItemFields.Overview, ItemFields.PrimaryImageAspectRatio ],
                enableUserData: true
            }, { signal });
            return res.data.Items || [];
        },
        enabled: enabled && !!seriesId && !!seasonId
    });
}

export function useSeriesNextUp(seriesId?: string) {
    const { api, userId, enabled } = useCtx();
    return useQuery({
        queryKey: [ 'freitas', userId, 'nextup', seriesId ],
        queryFn: async ({ signal }) => {
            const res = await getShowApi(api!).getNextUp({
                userId, seriesId, limit: 1, enableResumable: true, enableUserData: true, fields: [ ItemFields.MediaSourceCount ]
            }, { signal });
            return res.data.Items?.[0] ?? null;
        },
        enabled: enabled && !!seriesId
    });
}

/** First episode of a series, used when there is nothing to continue. */
export function useFirstEpisode(seriesId?: string) {
    const { api, userId, enabled } = useCtx();
    return useQuery({
        queryKey: [ 'freitas', userId, 'firstep', seriesId ],
        queryFn: async ({ signal }) => {
            const res = await getShowApi(api!).getEpisodes({
                seriesId: seriesId!, userId, limit: 1, enableUserData: true,
                fields: [ ItemFields.MediaStreams, ItemFields.MediaSources ]
            }, { signal });
            return res.data.Items?.[0] ?? null;
        },
        enabled: enabled && !!seriesId
    });
}

export function useSimilar(itemId?: string) {
    const { api, userId, enabled } = useCtx();
    return useQuery({
        queryKey: [ 'freitas', userId, 'similar', itemId ],
        queryFn: async ({ signal }) => {
            const res = await getLibraryApi(api!).getSimilarItems({ itemId: itemId!, userId, limit: 16, fields: CARD_FIELDS }, { signal });
            return res.data.Items || [];
        },
        enabled: enabled && !!itemId
    });
}

export function useExtras(itemId?: string) {
    const { api, userId, enabled } = useCtx();
    return useQuery({
        queryKey: [ 'freitas', userId, 'extras', itemId ],
        queryFn: async ({ signal }) => {
            const [ trailers, features ] = await Promise.all([
                getLibraryApi(api!).getLocalTrailers({ itemId: itemId!, userId }, { signal }),
                getLibraryApi(api!).getSpecialFeatures({ itemId: itemId!, userId }, { signal })
            ]);
            return [ ...(trailers.data || []), ...(features.data || []) ];
        },
        enabled: enabled && !!itemId
    });
}

export const TITLE_FIELDS: ItemFields[] = [
    ...CARD_FIELDS,
    ItemFields.People,
    ItemFields.Studios,
    ItemFields.MediaSources,
    ItemFields.MediaStreams,
    ItemFields.RemoteTrailers,
    ItemFields.LocalTrailerCount,
    ItemFields.SpecialFeatureCount,
    ItemFields.Taglines
];
