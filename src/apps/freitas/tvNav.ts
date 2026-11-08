/**
 * Row-by-row remote navigation for the Freitas+ pages on TVs.
 *
 * Jellyfin's focusManager measures every focusable element on each arrow press
 * (hundreds of cards on the library tabs). Here ← → walk the current row in DOM
 * order and ↑ ↓ jump to the next row, measuring only the elements involved.
 * Each row remembers its last focused element, so ↓ then ↑ returns to it.
 */

const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]';
const GROUP = '.focuscontainer-x, [data-nav-group]';

/** class on the root while the remote drives (no pointer hit tests) */
export const KEYNAV = 'fp-keynav';

type Dir = 'left' | 'right' | 'up' | 'down';

const KEYS: Record<string, Dir> = {
    ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
    Left: 'left', Right: 'right', Up: 'up', Down: 'down'
};
const KEY_CODES: Record<number, Dir> = { 37: 'left', 38: 'up', 39: 'right', 40: 'down' };

const TEXT_INPUTS = new Set([ 'TEXTAREA', 'SELECT' ]);
const NON_TEXT_INPUT_TYPES = new Set([ 'button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'reset', 'submit' ]);

function isTextInput(el: Element) {
    if (TEXT_INPUTS.has(el.tagName)) return true;
    return el.tagName === 'INPUT' && !NON_TEXT_INPUT_TYPES.has((el as HTMLInputElement).type);
}

/** Focusable, enabled, rendered and in the tab order. */
export function isNavigable(el: HTMLElement): boolean {
    if (!el.matches(FOCUSABLE)) return false;
    if ((el as HTMLButtonElement).disabled) return false;
    if (el.tabIndex < 0) return false;
    return el.offsetParent !== null;
}

/** The row an element belongs to: closest group inside root, else the element itself. */
export function groupOf(el: HTMLElement, root: HTMLElement): HTMLElement {
    const g = el.parentElement?.closest<HTMLElement>(GROUP);
    return g && root.contains(g) && g !== root ? g : el;
}

function members(group: HTMLElement): HTMLElement[] {
    if (group.matches(GROUP)) {
        return [ ...group.querySelectorAll<HTMLElement>(FOCUSABLE) ].filter(isNavigable);
    }
    return isNavigable(group) ? [ group ] : [];
}

function centreX(r: DOMRect) {
    return r.left + r.width / 2;
}

function centreY(r: DOMRect) {
    return r.top + r.height / 2;
}

function inViewport(r: DOMRect) {
    return r.right > 0 && r.left < window.innerWidth;
}

/** Element of the group to land on: the remembered one when on screen, else the nearest centre x. */
export function pickInGroup(group: HTMLElement, fromX: number, remembered?: HTMLElement): HTMLElement | null {
    const list = members(group);
    if (!list.length) return null;
    if (remembered && list.includes(remembered) && inViewport(remembered.getBoundingClientRect())) return remembered;
    let best: HTMLElement | null = null;
    let bestD = Infinity;
    for (const el of list) {
        const d = Math.abs(centreX(el.getBoundingClientRect()) - fromX);
        if (d < bestD) {
            best = el;
            bestD = d;
        }
    }
    return best;
}

function focusEl(el: HTMLElement) {
    try {
        el.focus({ preventScroll: true });
    } catch {
        el.focus();
    }
}

/**
 * Installs the navigation on a page root. Returns the cleanup.
 * `onActivity` runs for each key handled here (Jellyfin no longer sees it, and its
 * idle timers — screensaver — must still know the user is there).
 */
export function installTvNav(root: HTMLElement, onActivity?: () => void): () => void {
    const memory = new WeakMap<HTMLElement, HTMLElement>();

    const onFocusIn = (e: Event) => {
        const el = e.target as HTMLElement;
        const g = groupOf(el, root);
        if (g !== el) memory.set(g, el);
    };

    const horizontal = (cur: HTMLElement, dir: Dir) => {
        const group = groupOf(cur, root);
        if (group === cur) return false; // single element: leave it to Jellyfin
        const list = members(group);
        const i = list.indexOf(cur);
        if (i < 0) return false;
        const next = list[dir === 'right' ? i + 1 : i - 1];
        if (next) focusEl(next);
        return true; // at the row's edge: stay put
    };

    const vertical = (cur: HTMLElement, dir: Dir) => {
        const all = [ ...root.querySelectorAll<HTMLElement>(FOCUSABLE) ];
        const start = all.indexOf(cur);
        if (start < 0) return false;
        const curGroup = groupOf(cur, root);
        const curRect = cur.getBoundingClientRect();
        const step = dir === 'down' ? 1 : -1;
        const seen = new Set<HTMLElement>([ curGroup ]);

        for (let i = start + step; i >= 0 && i < all.length; i += step) {
            const el = all[i];
            const g = groupOf(el, root);
            if (seen.has(g) || !isNavigable(el)) continue;
            seen.add(g);
            // a row on the same line (header links, buttons side by side) is not "below"
            const y = centreY(el.getBoundingClientRect());
            const cy = centreY(curRect);
            if (dir === 'down' ? y <= cy : y >= cy) continue;
            const target = pickInGroup(g, centreX(curRect), memory.get(g));
            if (target) {
                focusEl(target);
                return true;
            }
        }
        return false;
    };

    const onKeyDown = (e: KeyboardEvent) => {
        if (e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
        // eslint-disable-next-line @typescript-eslint/no-deprecated -- old Tizen sends only keyCode
        const dir = KEYS[e.key] || KEY_CODES[e.keyCode];
        if (!dir) return;
        const cur = document.activeElement as HTMLElement | null;
        if (!cur || !root.contains(cur) || cur === root) return;
        if (cur.closest('[data-nav="native"]')) return;
        const handled = dir === 'left' || dir === 'right' ?
            !isTextInput(cur) && horizontal(cur, dir) :
            vertical(cur, dir);
        if (handled) {
            e.preventDefault();
            e.stopPropagation();
            root.classList.add(KEYNAV);
            onActivity?.();
        }
    };

    // a real pointer (Samsung remote) gives the page its hover back
    const onMouseMove = (e: MouseEvent) => {
        if (e.movementX || e.movementY) root.classList.remove(KEYNAV);
    };

    root.addEventListener('focusin', onFocusIn);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('mousemove', onMouseMove, { passive: true });
    return () => {
        root.classList.remove(KEYNAV);
        document.removeEventListener('mousemove', onMouseMove);
        root.removeEventListener('focusin', onFocusIn);
        document.removeEventListener('keydown', onKeyDown, true);
    };
}
