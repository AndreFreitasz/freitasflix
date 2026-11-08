export interface TrickplaySheetInfo {
    /** ms between frames */
    Interval: number
    /** frames per row / column of a sheet */
    TileWidth: number
    TileHeight: number
    /** size of one frame in px */
    Width: number
    Height: number
}

/** Which trickplay sheet holds the frame at `positionMs`, and the background offset of that frame. */
export function tileFor(positionMs: number, info: TrickplaySheetInfo): { index: number, x: number, y: number } {
    const frame = Math.floor(Math.max(0, positionMs) / info.Interval);
    const perSheet = info.TileWidth * info.TileHeight;
    const inSheet = frame % perSheet;
    return {
        index: Math.floor(frame / perSheet),
        // `|| 0` turns -0 into 0
        x: -((inSheet % info.TileWidth) * info.Width) || 0,
        y: -(Math.floor(inSheet / info.TileWidth) * info.Height) || 0
    };
}
