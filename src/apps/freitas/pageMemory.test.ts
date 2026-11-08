import { act, createElement, type FC, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, type NavigateFunction, Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { pageKey, recall, remember, useFocusMemory, useIsRestoring, usePageState } from './pageMemory';

beforeAll(() => {
    Object.assign(globalThis, { ['IS_REACT_ACT_ENVIRONMENT']: true });
    window.scrollTo = () => undefined;
});

let root: Root | undefined;
let host: HTMLElement;

afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    host?.remove();
});

const setters: Record<string, (v: string) => void> = {};
let restoringSeen: boolean[] = [];

const Season: FC<{ name: string }> = ({ name }) => {
    const [ v, set ] = usePageState(name, 'S1');
    setters[name] = set;
    return createElement('span', { id: name }, v);
};

const Page: FC = () => {
    const ref = useRef<HTMLDivElement>(null);
    useFocusMemory(ref);
    restoringSeen.push(useIsRestoring());
    return createElement('div', { ref },
        createElement(Season, { name: 'season' }),
        createElement('button', { 'data-fkey': 'ep:1', id: 'ep1' }, 'e1'),
        createElement('button', { 'data-fkey': 'ep:2', id: 'ep2' }, 'e2')
    );
};

let nav: NavigateFunction;
const Grab: FC = () => {
    nav = useNavigate();
    return null;
};

function mount(initial: string) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(
        createElement(MemoryRouter, { initialEntries: [ initial ] },
            createElement(Grab),
            createElement(Routes, null,
                createElement(Route, { path: '/titulo', element: createElement(Page) }),
                createElement(Route, { path: '/video', element: createElement('p', null, 'player') })
            )
        )
    ));
    return {
        // nav(-1) is a POP, nav('/x') a PUSH
        navigate: (to: string | number) => Promise.resolve(nav(to as string))
    };
}

const text = (id: string) => document.getElementById(id)?.textContent;

describe('pageMemory', () => {
    it('usePageState keeps value per page key across remount', async () => {
        const router = mount('/titulo?id=a');
        expect(text('season')).toBe('S1');
        act(() => setters.season('S2'));
        expect(text('season')).toBe('S2');
        await act(() => router.navigate('/video'));
        expect(text('season')).toBeUndefined();
        await act(() => router.navigate(-1));
        expect(text('season')).toBe('S2');
    });

    it('different pages do not share state', async () => {
        const router = mount('/titulo?id=b');
        act(() => setters.season('S3'));
        await act(() => router.navigate('/titulo?id=c'));
        expect(text('season')).toBe('S1');
    });

    it('a new visit (PUSH) starts fresh', async () => {
        const router = mount('/titulo?id=d');
        act(() => setters.season('S4'));
        await act(() => router.navigate('/video'));
        await act(() => router.navigate('/titulo?id=d'));
        expect(text('season')).toBe('S1');
    });

    it('recall returns last fkey, rowKey and scrollY', () => {
        remember('/x?id=1', { fkey: 'item:9', rowKey: 'fp-row-a', scrollY: 640 });
        remember('/x?id=1', { fkey: 'item:10' });
        expect(recall('/x?id=1')).toMatchObject({ fkey: 'item:10', rowKey: 'fp-row-a', scrollY: 640 });
        expect(recall('/x?id=2')).toBeUndefined();
    });

    it('pageKey is pathname + search', () => {
        expect(pageKey({ pathname: '/titulo', search: '?id=1' })).toBe('/titulo?id=1');
    });

    it('going back focuses the element that had focus', async () => {
        const router = mount('/titulo?id=e');
        act(() => document.getElementById('ep2')!.focus());
        await act(() => router.navigate('/video'));
        restoringSeen = [];
        await act(() => router.navigate(-1));
        expect(restoringSeen[0]).toBe(true);
        await act(() => new Promise(r => setTimeout(r, 50)));
        expect(document.activeElement?.id).toBe('ep2');
    });

    it('a new visit does not restore focus', async () => {
        const router = mount('/titulo?id=f');
        act(() => document.getElementById('ep2')!.focus());
        await act(() => router.navigate('/video'));
        restoringSeen = [];
        await act(() => router.navigate('/titulo?id=f'));
        await act(() => new Promise(r => setTimeout(r, 50)));
        expect(restoringSeen[0]).toBe(false);
        expect(document.activeElement?.id).not.toBe('ep2');
    });
});

