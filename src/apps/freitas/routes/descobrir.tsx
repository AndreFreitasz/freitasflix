import React, { type FC, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import layoutManager from 'components/layoutManager';

import { useCatalogSearch, useDiscover } from '../bridge';
import { Row } from '../components/Cards';
import { CatalogCard } from '../components/Catalog';
import { Icon } from '../components/Icons';
import FreitasPage, { SkeletonRow } from '../components/Layout';

/** Bridge not reachable / not configured: explain what to do instead of an empty page. */
export const BridgeHelp: FC<{ message?: string }> = ({ message }) => (
    <div className='fp-pad fp-empty fp-bridge-help' role='alert'>
        <p><strong>O catálogo não está disponível.</strong> {message || 'Não consegui falar com a ponte do Freitas+.'}</p>
        <p className='fp-bridge-help__more'>
            Confira se o app <strong>freitas-bridge</strong> está rodando no servidor. O endereço da ponte pode ser
            ajustado nas <a href='#/notas'>configurações do Freitas+</a>.
        </p>
    </div>
);

function useDebounced<T>(value: T, ms: number) {
    const [ v, setV ] = useState(value);
    useEffect(() => {
        const t = window.setTimeout(() => setV(value), ms);
        return () => window.clearTimeout(t);
    }, [ value, ms ]);
    return v;
}

function countLabel(n: number) {
    if (!n) return 'Nada encontrado no catálogo.';
    return n === 1 ? '1 resultado' : `${n} resultados`;
}

/** Results of the catalog search: movies and series, in the library or not. */
const SearchResults: FC<{ query: string, focusTick: number }> = ({ query, focusTick }) => {
    const { data, isFetching, isError, error } = useCatalogSearch(query);
    const gridRef = useRef<HTMLDivElement>(null);

    // TV: "OK" on the keyboard moves the remote to the first result
    useEffect(() => {
        if (focusTick && layoutManager.tv && data) gridRef.current?.querySelector<HTMLElement>('.fp-card')?.focus();
    }, [ focusTick, data ]);
    const libraryHref = `#/search?query=${encodeURIComponent(query)}`;
    const stale = isFetching && data?.query.toLowerCase() !== query.trim().toLowerCase();

    if (isError) return <BridgeHelp message={(error as Error)?.message} />;
    if (!data) {
        return (
            <div className='fp-pad fp-searchstate' role='status'>
                <span className='fp-spinner' aria-hidden='true' />Buscando…
            </div>
        );
    }
    return (
        <section className={'fp-pad fp-searchres' + (stale ? ' is-stale' : '')} aria-label='Resultados da busca'>
            <p className='fp-searchres__count'>
                {countLabel(data.items.length)}
                {' '}<a href={libraryHref}>Buscar só na sua biblioteca</a>
            </p>
            {data.items.length > 0 && (
                <div className='fp-catgrid' ref={gridRef}>
                    {data.items.map(item => <CatalogCard key={`${item.type}-${item.tmdbId}`} item={item} />)}
                </div>
            )}
        </section>
    );
};

/** "Descobrir": search everything, and what is trending / new / coming. */
const Descobrir: FC = () => {
    const [ params, setParams ] = useSearchParams();
    const [ text, setText ] = useState(params.get('q') || '');
    const query = useDebounced(text.trim(), 450);
    const inputRef = useRef<HTMLInputElement>(null);
    const [ focusTick, setFocusTick ] = useState(0);
    const searching = query.length >= 2;
    const { data, isLoading, isError, error } = useDiscover();

    // the header's search button opens this page ready to type
    useEffect(() => {
        if (params.get('busca')) inputRef.current?.focus();
    }, [ params ]);

    // keep the query in the address so "Voltar" from a title returns to the results
    useEffect(() => {
        const cur = params.get('q') || '';
        if (cur === query) return;
        const next = new URLSearchParams(params);
        next.delete('busca');
        if (query) next.set('q', query);
        else next.delete('q');
        setParams(next, { replace: true });
    }, [ query, params, setParams ]);

    const onChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => setText(e.target.value), []);
    const onSubmit = useCallback((e: React.FormEvent) => {
        e.preventDefault();
        setText(t => t.trim());
        setFocusTick(n => n + 1);
        if (!layoutManager.tv) inputRef.current?.blur(); // hides the phone keyboard
    }, []);
    const onClear = useCallback(() => {
        setText('');
        inputRef.current?.focus();
    }, []);

    return (
        <FreitasPage id='freitasDiscoverPage' title='Descobrir'>
            <main className='fp-rows fp-rows--plain'>
                <div className='fp-pad fp-page-title'>
                    <h1>Descobrir</h1>
                    <p>Busque qualquer filme ou série, mesmo o que você ainda não tem. O que já está aqui aparece como “Na biblioteca”.</p>
                </div>

                <form className='fp-pad fp-search' role='search' onSubmit={onSubmit}>
                    <label className='fp-search__box'>
                        <Icon name='search' size={20} className='' />
                        <input
                            ref={inputRef}
                            type='search'
                            enterKeyHint='search'
                            autoComplete='off'
                            spellCheck={false}
                            aria-label='Buscar filmes e séries'
                            placeholder='Nome, ID do TMDB ou link do IMDb'
                            value={text}
                            onChange={onChange}
                        />
                    </label>
                    {text && (
                        <button type='button' className='fp-btn-ghost' onClick={onClear} aria-label='Limpar busca'>
                            <Icon name='close' size={18} className='' /><span>Limpar</span>
                        </button>
                    )}
                </form>

                {searching && <SearchResults query={query} focusTick={focusTick} />}

                {!searching && isLoading && (
                    <>
                        <SkeletonRow />
                        <SkeletonRow />
                    </>
                )}

                {!searching && isError && <BridgeHelp message={(error as Error)?.message} />}

                {!searching && data && !data.sections.length && <BridgeHelp message='O catálogo veio vazio.' />}

                {!searching && data?.sections.map(section => (
                    <Row key={section.id} title={section.title}>
                        {section.items.map(item => <CatalogCard key={`${item.type}-${item.tmdbId}`} item={item} />)}
                    </Row>
                ))}
            </main>
        </FreitasPage>
    );
};

export default Descobrir;
