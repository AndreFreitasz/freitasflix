import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { groupOf, installTvNav, isNavigable, pickInGroup } from './tvNav';

// jsdom has no layout: lay elements out from data-x / data-y (100×100 boxes)
beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
        configurable: true,
        get(this: HTMLElement) {
            return this.closest('[hidden]') ? null : this.parentElement;
        }
    });
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
        const x = Number(this.dataset.x ?? 0);
        const y = Number(this.dataset.y ?? 0);
        return { x, y, left: x, top: y, right: x + 100, bottom: y + 100, width: 100, height: 100, toJSON: () => ({}) } as DOMRect;
    };
});

let root: HTMLElement;
let cleanup: () => void;

function row(y: number, xs: number[], id: string) {
    return `<div class="fp-scroller focuscontainer-x" id="${id}">${
        xs.map((x, i) => `<button id="${id}-${i}" data-x="${x}" data-y="${y}">${i}</button>`).join('')
    }</div>`;
}

function press(key: string) {
    const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    (document.activeElement || document.body).dispatchEvent(ev);
    return ev;
}

const focused = () => document.activeElement?.id;

beforeEach(() => {
    document.body.innerHTML = `<div class="fp-root">
        <header data-nav-group id="hdr"><a href="#a" id="h-0" data-x="0" data-y="0">a</a><a href="#b" id="h-1" data-x="200" data-y="0">b</a></header>
        ${row(200, [ 0, 200, 400, 600 ], 'r1')}
        <div class="fp-scroller focuscontainer-x" id="skel"><div data-x="0" data-y="350"></div></div>
        ${row(500, [ 100, 300, 500 ], 'r2')}
        <input id="q" data-x="0" data-y="700">
        <div data-nav="native" id="grid"><button id="g-0" data-x="0" data-y="900">g</button><button id="g-1" data-x="200" data-y="900">g</button></div>
        <button id="solo" data-x="0" data-y="1100">solo</button>
    </div>`;
    root = document.querySelector('.fp-root')!;
    cleanup = installTvNav(root);
});

afterEach(() => cleanup());

describe('tvNav', () => {
    it('→ moves to next card in same row', () => {
        document.getElementById('r1-0')!.focus();
        const ev = press('ArrowRight');
        expect(focused()).toBe('r1-1');
        expect(ev.defaultPrevented).toBe(true);
    });

    it('← at row start does nothing (handled, focus unchanged)', () => {
        document.getElementById('r1-0')!.focus();
        const ev = press('ArrowLeft');
        expect(focused()).toBe('r1-0');
        expect(ev.defaultPrevented).toBe(true);
    });

    it('↓ goes to next row choosing nearest centre x', () => {
        document.getElementById('r1-2')!.focus(); // x 400
        press('ArrowDown');
        expect(focused()).toBe('r2-1'); // 300 and 500 are both 100 away → first wins
    });

    it('↓ from the last card lands on the nearest card of a row never visited', () => {
        document.getElementById('r1-3')!.focus(); // x 600
        press('ArrowDown');
        expect(focused()).toBe('r2-2');
    });

    it('↑ returns to remembered card of previous row', () => {
        document.getElementById('r1-3')!.focus();
        press('ArrowDown');
        expect(focused()).toBe('r2-2');
        press('ArrowLeft');
        press('ArrowLeft');
        expect(focused()).toBe('r2-0');
        press('ArrowUp');
        expect(focused()).toBe('r1-3');
    });

    it('skips a row with no navigable elements (skeleton)', () => {
        document.getElementById('r1-0')!.focus();
        press('ArrowDown');
        expect(focused()).toBe('r2-0');
    });

    it('↓ from a header link skips the links on the same line', () => {
        document.getElementById('h-1')!.focus();
        press('ArrowDown');
        expect(focused()).toBe('r1-1');
    });

    it('ignores ← → inside input', () => {
        document.getElementById('q')!.focus();
        const ev = press('ArrowLeft');
        expect(ev.defaultPrevented).toBe(false);
        expect(focused()).toBe('q');
    });

    it('does not handle keys inside [data-nav="native"]', () => {
        document.getElementById('g-0')!.focus();
        for (const k of [ 'ArrowRight', 'ArrowDown', 'ArrowUp' ]) {
            const ev = press(k);
            expect(ev.defaultPrevented).toBe(false);
        }
        expect(focused()).toBe('g-0');
    });

    it('single-element group: ← → not handled', () => {
        document.getElementById('solo')!.focus();
        expect(press('ArrowLeft').defaultPrevented).toBe(false);
        expect(press('ArrowRight').defaultPrevented).toBe(false);
    });

    it('keys with modifiers are not handled', () => {
        document.getElementById('r1-0')!.focus();
        const ev = new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true, cancelable: true });
        document.activeElement!.dispatchEvent(ev);
        expect(ev.defaultPrevented).toBe(false);
        expect(focused()).toBe('r1-0');
    });

    it('marks the root while the remote drives and clears it when the pointer moves', () => {
        document.getElementById('r1-0')!.focus();
        press('ArrowRight');
        expect(root.classList.contains('fp-keynav')).toBe(true);
        document.dispatchEvent(new MouseEvent('mousemove', { movementX: 3 } as MouseEventInit));
        expect(root.classList.contains('fp-keynav')).toBe(false);
    });

    it('cleanup removes the handler', () => {
        cleanup();
        document.getElementById('r1-0')!.focus();
        expect(press('ArrowRight').defaultPrevented).toBe(false);
        cleanup = () => undefined;
    });
});

describe('helpers', () => {
    it('groupOf returns the closest group or the element itself', () => {
        expect(groupOf(document.getElementById('r1-1')!, root).id).toBe('r1');
        expect(groupOf(document.getElementById('h-0')!, root).id).toBe('hdr');
        expect(groupOf(document.getElementById('solo')!, root).id).toBe('solo');
    });

    it('isNavigable rejects hidden, disabled and tabindex -1', () => {
        const b = document.getElementById('solo') as HTMLButtonElement;
        expect(isNavigable(b)).toBe(true);
        b.disabled = true;
        expect(isNavigable(b)).toBe(false);
        b.disabled = false;
        b.tabIndex = -1;
        expect(isNavigable(b)).toBe(false);
        b.tabIndex = 0;
        b.hidden = true;
        expect(isNavigable(b)).toBe(false);
    });

    it('pickInGroup prefers the remembered element, else nearest x', () => {
        const g = document.getElementById('r2')!;
        expect(pickInGroup(g, 520)?.id).toBe('r2-2');
        expect(pickInGroup(g, 520, document.getElementById('r2-0')!)?.id).toBe('r2-0');
    });
});
