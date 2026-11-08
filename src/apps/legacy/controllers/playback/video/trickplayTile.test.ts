import { describe, expect, it } from 'vitest';

import { tileFor } from './trickplayTile';

const info = { Interval: 10000, TileWidth: 10, TileHeight: 10, Width: 320, Height: 180 };

describe('tileFor', () => {
    it('finds the tile inside the first sheet', () => {
        expect(tileFor(125000, info)).toEqual({ index: 0, x: -640, y: -180 });
    });

    it('moves to the next sheet after TileWidth × TileHeight frames', () => {
        expect(tileFor(1005000, info)).toEqual({ index: 1, x: 0, y: 0 });
    });

    it('starts at the first frame', () => {
        expect(tileFor(0, info)).toEqual({ index: 0, x: 0, y: 0 });
    });
});
