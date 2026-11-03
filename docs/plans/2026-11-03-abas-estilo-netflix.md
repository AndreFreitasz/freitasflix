# Abas Filmes, Séries e Animes no estilo Netflix + fileiras por streaming

## Objetivo
As abas de biblioteca deixam de abrir as páginas padrão do Jellyfin e passam a ter
uma página própria do Freitas+, no estilo Netflix. Os populares e os lançamentos de cada
streaming ficam em cada aba (e não mais na Descobrir).

## Decisões (respostas do André)
- As fileiras de streaming mostram **tudo**: o que já está na biblioteca abre para
  assistir, o resto abre para baixar. Cada streaming tem **Populares** e **Lançamentos**.
- Streamings: Netflix, Prime Video, Disney+, Max, Apple TV+, Paramount+, Globoplay
  (Filmes e Séries) e Crunchyroll (Animes, junto com Netflix e Prime Video).
- A aba Descobrir fica com: busca, Chegaram para baixar, No cinema, Futuros lançamentos.

## Página da aba (`#/biblioteca?id=<biblioteca>`)
1. Destaque rotativo (hero) com títulos da biblioteca.
2. Continuar assistindo (da biblioteca).
3. Adicionados recentemente.
4. Top 10 da biblioteca (cards com número).
5. Fileiras alternando: streaming (Populares / Lançamentos, com o logo do serviço) e
   gêneros da biblioteca (os gêneros com mais títulos).
6. "Ver todos (A–Z)" leva à página completa do Jellyfin, para quem quiser filtrar.

Tipo da aba: nome com "anime" → Animes; coleção de filmes → Filmes; senão → Séries.
Séries exclui animes japoneses (que ficam na aba Animes).

## Ponte (freitas-bridge)
- `GET /api/streaming/:kind` (`movie` | `tv` | `anime`) → `{ providers: [{ id, name, logo,
  popular: Item[], recent: Item[] }] }`.
- IDs dos serviços resolvidos pelo nome em `/watch/providers/{movie|tv}?watch_region=BR`
  (com IDs conhecidos como reserva), para não quebrar se o TMDB mudar números.
- Populares: `discover` com `with_watch_providers`, `watch_region=BR`, assinatura (flatrate),
  por popularidade. Lançamentos: o mesmo, limitado ao último ano de estreia.
- Itens com estado (biblioteca / faltando episódios / baixando). Filmes num streaming
  já são digitais: sem consulta extra de datas.
- Descobrir: seções reduzidas a Chegaram para baixar, No cinema, Futuros lançamentos.

## Frontend
- `api.ts`: `useLibraryAll(parentId)` — uma única consulta com todos os títulos da
  biblioteca (gêneros e Top 10 calculados no aparelho, sem requisições extras).
- `bridge.ts`: `useStreaming(kind)`.
- `routes/biblioteca.tsx`: a página; rotas legacy/modern + `AppLayout`.
- `Header.tsx`: abas apontam para `#/biblioteca?id=`; destaque da aba ativa.
- `Cards.tsx`: `Row` aceita um logo ao lado do título.
- TV: mesmas otimizações do resto (sem blur, imagens lazy), foco inicial no hero.

## Verificação
- Mocks: providers, discover por streaming, biblioteca com gêneros.
- Desktop, iPhone e controle de TV (Playwright); lint, stylelint, tsc, build.
- Publicar (web + ponte), conferir CI e release.
