import React, { type FC } from 'react';

const PATHS: Record<string, React.ReactNode> = {
    home: <><path d='m3 11 9-8 9 8' /><path d='M5 10v10h14V10' /></>,
    heart: <path d='M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z' />,
    sparkles: <><path d='M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z' /><path d='M19 16v4M17 18h4' /></>,
    film: <><rect x='2' y='2' width='20' height='20' rx='2.2' /><path d='M7 2v20M17 2v20M2 12h20M2 7h5M2 17h5M17 17h5M17 7h5' /></>,
    tv: <><rect x='2' y='7' width='20' height='15' rx='2' /><path d='m17 2-5 5-5-5' /></>,
    folder: <path d='M3 6.5A1.5 1.5 0 0 1 4.5 5H10l2 2h7.5A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z' />,
    music: <><path d='M9 18V5l12-2v13' /><circle cx='6' cy='18' r='3' /><circle cx='18' cy='16' r='3' /></>,
    search: <><circle cx='11' cy='11' r='7' /><path d='m21 21-4.3-4.3' /></>,
    users: <><path d='M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2' /><circle cx='9' cy='7' r='4' /><path d='M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75' /></>,
    cast: <><path d='M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6' /><path d='M2 12a9 9 0 0 1 8 8M2 16a5 5 0 0 1 4 4M2 20h.01' /></>,
    user: <><path d='M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2' /><circle cx='12' cy='7' r='4' /></>,
    plus: <path d='M12 5v14M5 12h14' />,
    check: <path d='m5 12.5 4.5 4.5L19 7.5' />,
    info: <><circle cx='12' cy='12' r='9' /><path d='M12 11v5.5M12 7.5h.01' /></>,
    chevronRight: <path d='m9 6 6 6-6 6' />,
    chevronLeft: <path d='m15 6-6 6 6 6' />,
    trailer: <><rect x='2' y='4' width='20' height='16' rx='3' /><path d='m10 9 5 3-5 3z' fill='currentColor' /></>
};

interface IconProps {
    name: keyof typeof PATHS | string
    size?: number
    strokeWidth?: number
    className?: string
}

export const Icon: FC<IconProps> = ({ name, size, strokeWidth = 2, className = 'fp-icon' }) => (
    <svg
        className={className}
        viewBox='0 0 24 24'
        width={size}
        height={size}
        fill='none'
        stroke='currentColor'
        strokeWidth={strokeWidth}
        strokeLinecap='round'
        strokeLinejoin='round'
        aria-hidden='true'
        focusable='false'
    >
        {PATHS[name]}
    </svg>
);

export const PlayGlyph: FC<{ size?: number }> = ({ size = 18 }) => (
    <svg width={size} height={size} viewBox='0 0 24 24' aria-hidden='true' focusable='false'>
        <path d='M7 4.5v15l13-7.5z' fill='currentColor' />
    </svg>
);

export const StarGlyph: FC = () => (
    <svg width='15' height='15' viewBox='0 0 24 24' aria-hidden='true' focusable='false'>
        <path d='m12 2.8 2.8 6 6.5.8-4.8 4.5 1.3 6.5L12 17.3 6.2 20.6l1.3-6.5L2.7 9.6l6.5-.8z' fill='#fbbf24' />
    </svg>
);
