import React, { type FC, type FormEvent, useCallback, useState } from 'react';

import { useApi } from 'hooks/useApi';

import { bridgeFetch, defaultBridgeUrl, getBridgeOverride, setBridgeOverride } from '../bridge';
import FreitasPage from '../components/Layout';
import {
    clearRatingsCache,
    getMdblistKey,
    getOmdbKey,
    setMdblistKey,
    setOmdbKey,
    testKeys
} from '../ratings';

type Status = { kind: 'idle' } | { kind: 'testing' } | { kind: 'ok', text: string } | { kind: 'error', text: string };

/** Address of freitas-bridge (catalog and downloads); empty = Jellyfin host on port 8099. */
const BridgeSettings: FC = () => {
    const { api } = useApi();
    const [ url, setUrl ] = useState(getBridgeOverride());
    const [ status, setStatus ] = useState<Status>({ kind: 'idle' });
    const onChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => setUrl(e.target.value), []);

    const onSubmit = useCallback(async (e: FormEvent) => {
        e.preventDefault();
        if (!api) return;
        const value = url.trim();
        if (value && !/^https?:\/\/[^\s/]+/i.test(value)) {
            setStatus({ kind: 'error', text: 'Use um endereço como http://192.168.1.250:8099' });
            return;
        }
        setBridgeOverride(value);
        setStatus({ kind: 'testing' });
        try {
            const me = await bridgeFetch<{ name: string, canDownload: boolean }>(api, '/api/me');
            setStatus({
                kind: 'ok',
                text: `Ponte funcionando. ${me.canDownload ? 'Você pode baixar títulos.' : 'Seu usuário pode navegar, mas não baixar.'}`
            });
        } catch (err) {
            setStatus({ kind: 'error', text: (err instanceof Error ? err.message : 'Erro') + ' Confira o endereço e se o app freitas-bridge está rodando.' });
        }
    }, [ api, url ]);

    return (
        <>
            <h2 className='fp-settings__subtitle'>Descobrir e baixar</h2>
            <p className='fp-settings__text'>
                O catálogo e o botão <strong>Baixar</strong> usam a ponte do Freitas+ (app <strong>freitas-bridge</strong> no servidor).
                Deixe em branco para usar o padrão: <code>{defaultBridgeUrl(api)}</code>.
            </p>
            <form className='fp-settings__form' onSubmit={onSubmit}>
                <label className='fp-settings__label' htmlFor='fpBridgeUrl'>Endereço da ponte</label>
                <input
                    id='fpBridgeUrl'
                    className='fp-settings__input'
                    type='text'
                    inputMode='url'
                    autoComplete='off'
                    spellCheck={false}
                    placeholder={defaultBridgeUrl(api)}
                    value={url}
                    onChange={onChange}
                />
                <button type='submit' className='fp-btn-play' disabled={status.kind === 'testing'}>
                    <span>{status.kind === 'testing' ? 'Testando…' : 'Salvar e testar'}</span>
                </button>
            </form>
            {(status.kind === 'ok' || status.kind === 'error') && (
                <p className={`fp-settings__status fp-settings__status--${status.kind}`} role='status'>{status.text}</p>
            )}
        </>
    );
};

/** One-time setup of the free keys that bring IMDb, Rotten Tomatoes, Metacritic, Letterboxd and MyAnimeList. */
const Notas: FC = () => {
    const [ mdblist, setMdblist ] = useState(getMdblistKey());
    const [ omdb, setOmdb ] = useState(getOmdbKey());
    const [ status, setStatus ] = useState<Status>({ kind: 'idle' });

    const onMdblist = useCallback((e: React.ChangeEvent<HTMLInputElement>) => setMdblist(e.target.value), []);
    const onOmdb = useCallback((e: React.ChangeEvent<HTMLInputElement>) => setOmdb(e.target.value), []);

    const onSubmit = useCallback(async (e: FormEvent) => {
        e.preventDefault();
        const m = mdblist.trim();
        const o = omdb.trim();
        setStatus({ kind: 'testing' });
        try {
            const lines = await testKeys(m, o);
            setMdblistKey(m);
            setOmdbKey(o);
            clearRatingsCache();
            setStatus({
                kind: 'ok',
                text: (lines.length ? lines.join(' ') + ' ' : 'Chaves removidas. ') + 'Vale para todos os seus aparelhos.'
            });
        } catch (err) {
            setStatus({ kind: 'error', text: 'Não funcionou: ' + (err instanceof Error ? err.message : 'erro desconhecido') });
        }
    }, [ mdblist, omdb ]);

    return (
        <FreitasPage id='freitasNotasPage' title='Notas'>
            <main className='fp-settings fp-pad'>
                <h1 className='fp-settings__title'>Notas dos títulos</h1>
                <p className='fp-settings__text'>
                    O Freitas+ mostra as notas do <strong>IMDb</strong>, <strong>Rotten Tomatoes</strong>, <strong>Metacritic</strong>,{' '}
                    <strong>Letterboxd</strong> e, nos animes, <strong>MyAnimeList</strong>. Elas vêm do MDBList, que é gratuito e pede uma chave.
                </p>
                <ol className='fp-settings__steps'>
                    <li>Entre em <a href='https://mdblist.com' target='_blank' rel='noopener noreferrer'>mdblist.com</a> (dá para usar a conta do Trakt ou do Google).</li>
                    <li>Abra <strong>Preferences</strong>, desça até <strong>API Access</strong> e gere a chave.</li>
                    <li>Cole abaixo e salve. Basta fazer isso uma vez, em qualquer aparelho.</li>
                </ol>
                <form className='fp-settings__form' onSubmit={onSubmit}>
                    <label className='fp-settings__label' htmlFor='fpMdblistKey'>Chave do MDBList</label>
                    <input
                        id='fpMdblistKey'
                        className='fp-settings__input'
                        type='text'
                        autoComplete='off'
                        spellCheck={false}
                        placeholder='Cole aqui a chave do MDBList'
                        value={mdblist}
                        onChange={onMdblist}
                    />
                    <label className='fp-settings__label' htmlFor='fpOmdbKey'>
                        Chave do OMDb <span className='fp-settings__hint'>(opcional, reserva para IMDb, Rotten Tomatoes e Metacritic)</span>
                    </label>
                    <input
                        id='fpOmdbKey'
                        className='fp-settings__input'
                        type='text'
                        autoComplete='off'
                        spellCheck={false}
                        placeholder='Chave do OMDb'
                        value={omdb}
                        onChange={onOmdb}
                    />
                    <button type='submit' className='fp-btn-play' disabled={status.kind === 'testing'}>
                        <span>{status.kind === 'testing' ? 'Testando…' : 'Salvar'}</span>
                    </button>
                </form>
                {(status.kind === 'ok' || status.kind === 'error') && (
                    <p className={`fp-settings__status fp-settings__status--${status.kind}`} role='status'>{status.text}</p>
                )}
                <BridgeSettings />
            </main>
        </FreitasPage>
    );
};

export default Notas;
