/**
 * "Aim, then seek" for remotes: each ←/→ moves a target (10 s; 30 s from the
 * 6th press, 60 s from the 11th) and previews it; the video seeks once, when the
 * remote rests (900 ms) or on OK. Back cancels.
 */
export interface SeekPreviewOptions {
    getPositionMs(): number
    getDurationMs(): number
    onPreview(ms: number): void
    onCommit(ms: number): void
    onCancel(): void
    idleMs?: number
}

export interface SeekPreview {
    step(dir: 1 | -1): void
    commit(): void
    cancel(): void
    active(): boolean
}

const STEPS: [ fromPress: number, ms: number ][] = [ [ 11, 60_000 ], [ 6, 30_000 ], [ 1, 10_000 ] ];
const END_MARGIN = 1000;

function stepFor(press: number) {
    return (STEPS.find(([ from ]) => press >= from) || STEPS[STEPS.length - 1])[1];
}

export function createSeekPreview(opts: SeekPreviewOptions): SeekPreview {
    const idleMs = opts.idleMs ?? 900;
    let target: number | null = null;
    let presses = 0;
    let lastDir: 1 | -1 = 1;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const reset = () => {
        clearTimeout(timer);
        timer = undefined;
        target = null;
        presses = 0;
    };

    const commit = () => {
        if (target === null) return;
        const t = target;
        reset();
        opts.onCommit(t);
    };

    return {
        step(dir) {
            if (target === null) {
                target = opts.getPositionMs();
                presses = 0;
            }
            if (dir !== lastDir) presses = 0;
            lastDir = dir;
            presses++;
            const duration = opts.getDurationMs();
            const max = duration > 0 ? Math.max(0, duration - END_MARGIN) : Infinity;
            target = Math.min(max, Math.max(0, target + dir * stepFor(presses)));
            opts.onPreview(target);
            clearTimeout(timer);
            timer = setTimeout(commit, idleMs);
        },
        commit,
        cancel() {
            if (target === null) return;
            reset();
            opts.onCancel();
        },
        active: () => target !== null
    };
}
