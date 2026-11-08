import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSeekPreview } from './seekPreview';

let pos = 600_000;
const duration = 3_600_000;
let previews: number[];
let commits: number[];
let cancels: number;

function make() {
    return createSeekPreview({
        getPositionMs: () => pos,
        getDurationMs: () => duration,
        onPreview: ms => previews.push(ms),
        onCommit: ms => commits.push(ms),
        onCancel: () => { cancels++; }
    });
}

beforeEach(() => {
    vi.useFakeTimers();
    pos = 600_000;
    previews = [];
    commits = [];
    cancels = 0;
});

afterEach(() => vi.useRealTimers());

describe('seekPreview', () => {
    it('first press previews position + 10 s without seeking', () => {
        const p = make();
        p.step(1);
        expect(previews).toEqual([ 610_000 ]);
        expect(commits).toEqual([]);
        expect(p.active()).toBe(true);
    });

    it('6th press steps 30 s, 11th 60 s', () => {
        const p = make();
        for (let i = 0; i < 11; i++) p.step(1);
        const steps = previews.map((v, i) => v - (i ? previews[i - 1] : pos));
        expect(steps).toEqual([ 10e3, 10e3, 10e3, 10e3, 10e3, 30e3, 30e3, 30e3, 30e3, 30e3, 60e3 ]);
    });

    it('changing direction restarts at 10 s', () => {
        const p = make();
        for (let i = 0; i < 7; i++) p.step(1);
        p.step(-1);
        expect(previews.at(-1)! - previews.at(-2)!).toBe(-10e3);
    });

    it('commits once after 900 ms idle with the final target', () => {
        const p = make();
        p.step(-1);
        vi.advanceTimersByTime(500);
        p.step(-1);
        vi.advanceTimersByTime(899);
        expect(commits).toEqual([]);
        vi.advanceTimersByTime(1);
        expect(commits).toEqual([ 580_000 ]);
        expect(p.active()).toBe(false);
        vi.advanceTimersByTime(5000);
        expect(commits).toHaveLength(1);
    });

    it('cancel never commits', () => {
        const p = make();
        p.step(1);
        p.cancel();
        vi.advanceTimersByTime(5000);
        expect(cancels).toBe(1);
        expect(commits).toEqual([]);
        expect(p.active()).toBe(false);
    });

    it('clamps to [0, duration - 1 s]', () => {
        pos = 5_000;
        const p = make();
        p.step(-1);
        expect(previews).toEqual([ 0 ]);
        p.cancel();
        pos = duration - 3_000;
        p.step(1);
        expect(previews.at(-1)).toBe(duration - 1_000);
    });

    it('commit() seeks right away (OK on the remote)', () => {
        const p = make();
        p.step(1);
        p.step(1);
        p.commit();
        expect(commits).toEqual([ 620_000 ]);
        vi.advanceTimersByTime(2000);
        expect(commits).toHaveLength(1);
    });

    it('commit and cancel do nothing when idle', () => {
        const p = make();
        p.commit();
        p.cancel();
        expect(commits).toEqual([]);
        expect(cancels).toBe(0);
    });
});
