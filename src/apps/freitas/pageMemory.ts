/**
 * Per-page memory: going back to a Freitas+ page (from the player, a title,
 * anything) reopens it where the user was — same season/tab, same focused
 * item (episode, card…) and scroll — instead of the top of the page.
 *
 * Kept in memory only (a reload starts fresh). Items opt in with `data-fkey`.
 */
import { type RefObject, useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';

import { ensureVisible } from './utils';

export interface PageMemory {
    /** `data-fkey` of the last focused element */
    fkey?: string
    /** `aria-labelledby` of its `.fp-row` (the same item can be in several rows) */
    rowKey?: string
    scrollY?: number
    state: Record<string, unknown>
}

const MAX_PAGES = 60;
const RESTORE_TIMEOUT = 5000;

const store = new Map<string, PageMemory>();
/** pages being restored → deadline */
const pending = new Map<string, number>();

export function pageKey(location: { pathname: string, search: string }): string {
    return location.pathname + location.search;
}

export function recall(key: string): PageMemory | undefined {
    return store.get(key);
}

export function remember(key: string, patch: Partial<PageMemory>) {
    const cur = store.get(key) || { state: {} };
    const next = { ...cur, ...patch, state: { ...cur.state, ...patch.state } };
    // most recent last, so the oldest page is dropped first
    store.delete(key);
    store.set(key, next);
    if (store.size > MAX_PAGES) store.delete(store.keys().next().value!);
}

/** Same as useIsRestoring, for code that runs outside render (effects of parent components). */
export function isRestoring(key: string) {
    return isPending(key);
}

function isPending(key: string) {
    const until = pending.get(key);
    return !!until && until > Date.now();
}

/** True while a page that is coming back is putting the focus where it was. */
export function useIsRestoring(): boolean {
    return isPending(pageKey(useLocation()));
}

/** State that survives going back to the page (season, tab…). A new visit starts from `initial`. */
export function usePageState<T>(name: string, initial: T): [ T, (v: T) => void ] {
    const location = useLocation();
    const nav = useNavigationType();
    const key = pageKey(location);
    const load = (): T => {
        const saved = recall(key)?.state;
        return nav === 'POP' && saved && name in saved ? saved[name] as T : initial;
    };
    const [ cur, setCur ] = useState<{ key: string, value: T }>(() => ({ key, value: load() }));
    const set = useCallback((v: T) => {
        remember(key, { state: { [name]: v } });
        setCur({ key, value: v });
    }, [ key, name ]);
    // same component, another page (title → similar title): that page's own value
    if (cur.key !== key) {
        const value = load();
        setCur({ key, value });
        return [ value, set ];
    }
    return [ cur.value, set ];
}

/** fkeys are ids and slugs; quotes and backslashes are the only characters to escape in "…" */
function cssEscape(s: string) {
    return s.replace(/["\\]/g, '\\$&');
}

function findTarget(root: HTMLElement, mem: PageMemory): HTMLElement | null {
    if (!mem.fkey) return null;
    const sel = `[data-fkey="${cssEscape(mem.fkey)}"]`;
    if (mem.rowKey) {
        const row = root.querySelector(`[aria-labelledby="${cssEscape(mem.rowKey)}"]`);
        const inRow = row?.querySelector<HTMLElement>(sel);
        if (inRow) return inRow;
    }
    return root.querySelector<HTMLElement>(sel);
}

function restore(root: HTMLElement, key: string, mem: PageMemory, onGiveUp?: () => void) {
    let done = false;
    const finish = () => {
        done = true;
        pending.delete(key);
        observer.disconnect();
        window.clearTimeout(timer);
        window.cancelAnimationFrame(raf);
    };
    const attempt = () => {
        if (done) return;
        const el = findTarget(root, mem);
        if (!el) return;
        finish();
        window.scrollTo(0, mem.scrollY || 0);
        try {
            el.focus({ preventScroll: true });
        } catch {
            el.focus();
        }
        ensureVisible(el, true);
    };
    const observer = new MutationObserver(attempt);
    observer.observe(root, { childList: true, subtree: true });
    const timer = window.setTimeout(() => {
        if (done) return;
        finish();
        onGiveUp?.(); // the item is gone: start from the top
    }, Math.max(0, (pending.get(key) || 0) - Date.now()));
    // never synchronously: the page's own mount effects (scroll to top, autofocus) run first and check useIsRestoring
    const raf = window.requestAnimationFrame(attempt);
    return () => {
        if (done) return;
        observer.disconnect();
        window.clearTimeout(timer);
        window.cancelAnimationFrame(raf);
    };
}

/**
 * Remembers what has focus on the page; when the page comes back (POP), focuses it again.
 * `onGiveUp` runs when the remembered item does not show up within 5 s.
 */
export function useFocusMemory(root: RefObject<HTMLElement>, onGiveUp?: () => void): void {
    const location = useLocation();
    const nav = useNavigationType();
    const key = pageKey(location);

    // decided while rendering, before the children read useIsRestoring()
    useMemo(() => {
        if (nav === 'POP' && recall(key)?.fkey) {
            if (!pending.has(key)) pending.set(key, Date.now() + RESTORE_TIMEOUT);
        } else {
            pending.delete(key);
        }
    }, [ key, nav ]);

    useEffect(() => {
        const el = root.current;
        if (!el) return;
        const onFocusIn = (e: Event) => {
            const t = (e.target as HTMLElement).closest<HTMLElement>('[data-fkey]');
            if (!t || !el.contains(t)) return;
            remember(key, {
                fkey: t.dataset.fkey,
                rowKey: t.closest('.fp-row')?.getAttribute('aria-labelledby') || undefined,
                scrollY: window.scrollY
            });
        };
        const onScroll = () => {
            if (!isPending(key)) remember(key, { scrollY: window.scrollY });
        };
        el.addEventListener('focusin', onFocusIn);
        window.addEventListener('scroll', onScroll, { passive: true });
        const mem = recall(key);
        const stop = isPending(key) && mem ? restore(el, key, mem, onGiveUp) : undefined;
        return () => {
            stop?.();
            el.removeEventListener('focusin', onFocusIn);
            window.removeEventListener('scroll', onScroll);
        };
    }, [ key, root ]); // onGiveUp is read once per page
}
