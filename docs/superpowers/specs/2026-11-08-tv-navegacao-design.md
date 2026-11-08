# Freitas+: navegação na TV, voltar ao ponto certo, prévia de frames e download de série em 1 clique

Data: 2026-11-08 · Aprovado por André (design em chat)

## Objetivo
Deixar o Freitas+ rápido e previsível no controle remoto e remover atritos de uso:
1. As setas respondem na hora, inclusive em páginas longas (abas Filmes/Séries/Animes).
2. Ao voltar do player (ou de qualquer página), a tela reabre onde o usuário estava,
   com o mesmo item focado (ex.: o episódio que estava assistindo, na mesma temporada).
3. Ao avançar/voltar no vídeo aparece o frame do ponto de destino, de 10 em 10 segundos.
4. Baixar episódios de uma série é uma ação só, na própria página da série.

Critérios de sucesso (medidos com CPU 6× mais lenta no Playwright, aba Filmes):
- Tempo médio de uma seta até a tela pintada cai pelo menos 40% em relação ao atual
  (hoje ~90 ms ↓ e ~60 ms →).
- Nenhuma requisição de rede enquanto o usuário só passa pelos cards.
- Voltar do player foca o mesmo episódio em 100% dos casos testados.

## Achados do raio X (estado atual)
| # | Problema | Evidência |
|---|----------|-----------|
| 1 | Cada card focado pede `/Items/{id}` (selo Metacritic/4K) após 450 ms | 5 pedidos em 6 cliques |
| 2 | Zoom `scale(1.07)` no card focado cria/destrói camada | −18% do custo sem zoom |
| 3 | `onBlur` usa `matches(':hover')` → hit test forçado | HitTest 87–133 ms em 10 cliques |
| 4 | focusManager do Jellyfin mede todos os focáveis a cada seta | O(n), >400 cards na aba Filmes |
| 5 | Página da série é recriada, `scrollTo(0,0)` e foco no Assistir | `titulo.tsx` |
| 6 | Filmes tocam sem campo `Trickplay`; setas na TV pulam sem prévia | `playback.ts`, controller do vídeo |
| 7 | Download de série exige ícone → outra página → "Baixar o que falta" | `titulo.tsx` / `catalogo.tsx` |

## Design

### A. Navegação espacial própria (`tvNav.ts`)
- Ativa só em `layoutManager.tv`, dentro de `.fp-root`, ligada pelo `FreitasPage`.
- **Grupo** = ancestral mais próximo com `.focuscontainer-x` ou `[data-nav-group]`;
  um focável fora de grupo é um grupo de um elemento só.
- ← / →: anterior/próximo focável do mesmo grupo (ordem do DOM). Na borda: não faz nada.
  Grupo de um elemento só: deixa o focusManager do Jellyfin decidir.
- ↑ / ↓: próximo/anterior grupo na ordem do DOM que tenha focável visível; entra no item
  lembrado daquele grupo (se ainda visível na tela) ou no de centro horizontal mais próximo.
- Mede layout apenas do elemento atual e dos itens do grupo de destino.
- Não intercepta: teclas com modificador, eventos já tratados, `input/textarea/select`
  (← →), e áreas marcadas `[data-nav="native"]` (grade de busca `.fp-catgrid`).
- Foco com `preventScroll` + `ensureVisible` instantâneo (já existente).

### Custo do foco nos cards
- `useCardActive`: na TV, atraso de 1000 ms e cancelamento ao sair; sem `matches(':hover')`.
- CSS TV: card focado sem `transform` e sem `filter`; destaque com anel roxo (outline de 3px)
  e um `box-shadow` sólido, sem desfoque, no `.fp-card__frame`.

### B. Memória por página (`pageMemory.ts`)
- Mapa em memória por chave `pathname + search`.
- `usePageState(nome, inicial)`: estado que sobrevive à volta (temporada, aba).
- `useFocusMemory(root)` no `FreitasPage`: em `focusin` guarda `data-fkey` do item focado,
  o id da `.fp-row` em que está e `scrollY`.
- Ao montar com navegação `POP` e memória existente: espera o elemento aparecer
  (MutationObserver, até 5 s), restaura `scrollY`, foca o item e garante visibilidade.
  Durante a restauração, os focos automáticos (hero, botão Assistir) e o `scrollTo(0,0)`
  da página de título não agem.
- `data-fkey` em: cards (`item:<id>`), episódios (`ep:<id>`), temporadas (`season:<id>`),
  abas (`tab:<id>`), botões do hero (`hero:play` etc.).

### C. Prévia de frames
- `playItem`: antes de tocar um filme sem `Trickplay`, busca o item com
  `Fields=Trickplay,Chapters,MediaSources` (episódios já vêm assim do playbackManager).
- Desktop/celular: a bolha da barra do Jellyfin passa a ter os dados → frame no hover/arraste.
- TV (`seekPreview` no controller do vídeo): com o OSD sem foco nos botões, ← / → movem
  uma **mira** de 10 s (acelera para 30 s após 5 toques e 60 s após 10 dentro da mesma
  sequência), mostram o frame do destino e o horário acima da barra; o vídeo pula uma vez só
  após 900 ms sem tecla ou com OK; Voltar cancela. Sem dados de prévia: mostra só o horário.

### D. Baixar série em 1 clique
- Na página da série (em `titulo.tsx`), botão rotulado **"Baixar episódios"** (+ "faltam N")
  ao lado do Assistir, quando a ponte e o Sonarr estão disponíveis e o usuário pode baixar.
- O clique abre a aba Episódios e mostra o `ReleasesPanel` logo abaixo das temporadas, para a
  **temporada selecionada**, com "Só o que falta" ligado quando há episódios faltando.
  Trocar de temporada troca a busca. Na TV, o foco vai para a primeira opção.
- Botões de temporada mostram "faltam N" quando a ponte informa episódios faltando.

## Fora do escopo
- Mudar o player nativo do Fire TV (ExoPlayer) — a prévia vale para o player web (TV Samsung,
  navegador, celular). No Fire TV a barra nativa já tem o próprio comportamento.
- Grade de busca continua com a navegação do Jellyfin.

## Testes
- Playwright com mocks (Jellyfin/TMDB/Radarr/Sonarr/Prowlarr/qBit):
  - latência de seta (keydown → 2 frames) e contagem de requisições, antes/depois, CPU 6×;
  - navegação: ↓↑ entre fileiras lembrando a coluna, ← → na fileira, header, hero, episódios;
  - voltar do player foca o episódio e a temporada certos; Início/abas restauram o card;
  - prévia: unidade do cálculo do tile (tempo → arquivo/posição) e da mira (acúmulo,
    aceleração, commit, cancelamento) em página de teste; filme passa a ter `Trickplay`;
  - download inline: botão → painel da temporada certa → baixar.
- lint, stylelint, tsc, build; publicação e checagem do CI.
