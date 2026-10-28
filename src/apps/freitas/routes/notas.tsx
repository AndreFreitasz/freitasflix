import React, { type FC, type FormEvent, useCallback, useState } from 'react';

import FreitasPage from '../components/Layout';
import { fetchOmdb, getOmdbKey, setOmdbKey } from '../ratings';

type Status = { kind: 'idle' } | { kind: 'testing' } | { kind: 'ok', text: string } | { kind: 'error', text: string };

const TEST_IMDB_ID = 'tt0111161'; // Um Sonho de Liberdade

/** One-time setup of the free OMDb key that powers the Metacritic score. */
const Notas: FC = () => {
    const [ key, setKey ] = useState(getOmdbKey());
    const [ status, setStatus ] = useState<Status>({ kind: 'idle' });

    const onChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => setKey(e.target.value), []);

    const onSubmit = useCallback(async (e: FormEvent) => {
        e.preventDefault();
        const value = key.trim();
        if (!value) {
            setOmdbKey('');
            setStatus({ kind: 'ok', text: 'Chave removida. A nota do Metacritic deixa de aparecer.' });
            return;
        }
        setStatus({ kind: 'testing' });
        try {
            localStorage.removeItem('fp-omdb:' + TEST_IMDB_ID);
        } catch {
            // ignore
        }
        try {
            const r = await fetchOmdb(TEST_IMDB_ID, value);
            setOmdbKey(value);
            setStatus({
                kind: 'ok',
                text: r.metascore != null ?
                    `Funcionou! Teste: Um Sonho de Liberdade tem Metacritic ${r.metascore}. A chave vale para todos os seus aparelhos.` :
                    'Chave salva. A chave vale para todos os seus aparelhos.'
            });
        } catch (err) {
            setStatus({ kind: 'error', text: 'A chave não funcionou: ' + (err instanceof Error ? err.message : 'erro desconhecido') });
        }
    }, [ key ]);

    return (
        <FreitasPage id='freitasNotasPage' title='Notas'>
            <main className='fp-settings fp-pad'>
                <h1 className='fp-settings__title'>Notas dos títulos</h1>
                <p className='fp-settings__text'>
                    A nota do TMDB vem do próprio Jellyfin. Para mostrar também o <strong>Metacritic</strong> (e o Rotten
                    Tomatoes quando o Jellyfin não tiver), o Freitas+ usa o OMDb, que é gratuito e pede uma chave.
                </p>
                <ol className='fp-settings__steps'>
                    <li>Abra <a href='https://www.omdbapi.com/apikey.aspx' target='_blank' rel='noopener noreferrer'>omdbapi.com/apikey.aspx</a>, escolha <strong>FREE</strong> e informe seu e-mail.</li>
                    <li>Clique no link de ativação que chega no e-mail.</li>
                    <li>Cole a chave abaixo e salve. Basta fazer isso uma vez, em qualquer aparelho.</li>
                </ol>
                <form className='fp-settings__form' onSubmit={onSubmit}>
                    <input
                        className='fp-settings__input'
                        type='text'
                        inputMode='text'
                        autoComplete='off'
                        spellCheck={false}
                        placeholder='Chave do OMDb (ex.: a1b2c3d4)'
                        value={key}
                        onChange={onChange}
                        aria-label='Chave do OMDb'
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
