import React, { type FC } from 'react';

import { useDiscover } from '../bridge';
import { Row } from '../components/Cards';
import { CatalogCard } from '../components/Catalog';
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

/** "Descobrir": what is trending / new / coming, including titles not in the library. */
const Descobrir: FC = () => {
    const { data, isLoading, isError, error } = useDiscover();

    return (
        <FreitasPage id='freitasDiscoverPage' title='Descobrir'>
            <main className='fp-rows fp-rows--plain'>
                <div className='fp-pad fp-page-title'>
                    <h1>Descobrir</h1>
                    <p>Em alta, lançamentos e o que vem por aí. O que você já tem aparece como “Na biblioteca”.</p>
                </div>

                {isLoading && (
                    <>
                        <SkeletonRow />
                        <SkeletonRow />
                    </>
                )}

                {isError && <BridgeHelp message={(error as Error)?.message} />}

                {data?.sections.map(section => (
                    <Row key={section.id} title={section.title}>
                        {section.items.map(item => <CatalogCard key={`${item.type}-${item.tmdbId}`} item={item} />)}
                    </Row>
                ))}
            </main>
        </FreitasPage>
    );
};

export default Descobrir;
