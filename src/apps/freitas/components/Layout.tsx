import React, { type FC, type PropsWithChildren, useEffect, useRef } from 'react';

import layoutManager from 'components/layoutManager';
import Page from 'components/Page';

import { ensureVisible } from '../utils';

import Header from './Header';

import '../freitas.scss';

interface FreitasPageProps {
    id: string
    title?: string
}

/** Page shell shared by every Freitas+ screen: hides the stock header and draws ours over the content. */
const FreitasPage: FC<PropsWithChildren<FreitasPageProps>> = ({ id, title, children }) => {
    const rootRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        document.body.classList.add('fp-route');
        return () => document.body.classList.remove('fp-route');
    }, []);

    // Remote / keyboard navigation: keep whatever gets focus visible
    useEffect(() => {
        const root = rootRef.current;
        if (!root) return;
        const onFocusIn = (e: Event) => {
            const target = e.target as HTMLElement;
            let keyboard = layoutManager.tv;
            try {
                keyboard = keyboard || target.matches(':focus-visible');
            } catch {
                // older TV browsers do not know :focus-visible
            }
            if (keyboard) ensureVisible(target, layoutManager.tv);
        };
        root.addEventListener('focusin', onFocusIn);
        return () => root.removeEventListener('focusin', onFocusIn);
    }, []);

    return (
        <Page
            id={id}
            title={title}
            className='mainAnimatedPage libraryPage noSecondaryNavPage fp-page'
            isBackButtonEnabled={false}
        >
            <div className='fp-root' ref={rootRef}>
                <div className='fp-glow fp-glow--a' aria-hidden='true' />
                <div className='fp-glow fp-glow--b' aria-hidden='true' />
                <div className='fp-glow fp-glow--c' aria-hidden='true' />
                <Header overlay />
                {children}
            </div>
        </Page>
    );
};

export default FreitasPage;

export const SkeletonRow: FC<{ variant?: 'poster' | 'wide' }> = ({ variant = 'poster' }) => (
    <section className='fp-row' aria-hidden='true'>
        <div className='fp-row__head fp-pad'><span className='fp-skel fp-skel--title' /></div>
        <div className={`fp-scroller fp-pad fp-scroller--${variant}`}>
            {Array.from({ length: 7 }, (_, i) => (
                <div key={i} className={`fp-card fp-card--${variant}`}>
                    <div className={`fp-card__frame ${variant === 'wide' ? 'fp-ratio-wide' : 'fp-ratio-poster'} fp-skel`} />
                </div>
            ))}
        </div>
    </section>
);
