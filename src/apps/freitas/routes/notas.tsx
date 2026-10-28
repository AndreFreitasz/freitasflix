import React, { type FC, type FormEvent, useCallback, useState } from 'react';

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
            </main>
        </FreitasPage>
    );
};

export default Notas;
