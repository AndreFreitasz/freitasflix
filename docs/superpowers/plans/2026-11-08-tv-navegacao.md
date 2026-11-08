# Navegação na TV, memória de foco, prévia de frames e download em 1 clique — Plano

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Setas rápidas e previsíveis na TV, voltar ao item onde o usuário estava, frame de prévia a cada 10 s ao buscar no vídeo e baixar episódios de uma série com um clique.

**Architecture:** Três módulos novos e pequenos no app Freitas+ (`tvNav.ts`, `pageMemory.ts`) e no player legado (`seekPreview.ts`, `trickplayTile.ts`), ligados nos pontos existentes (`FreitasPage`, `titulo.tsx`, `playback.ts`, controller do vídeo). Lógica pura em funções testadas com vitest; comportamento de ponta a ponta verificado com Playwright contra os mocks.

**Tech Stack:** React 18 + TS, SCSS, jellyfin-web (legacy controllers JS), vitest (jsdom), Playwright (Python) + mocks Node.

**Spec:** `docs/superpowers/specs/2026-11-08-tv-navegacao-design.md`

## Global Constraints
- Comportamentos novos de navegação só em `layoutManager.tv`; desktop e celular inalterados (exceto prévia no hover/arraste, que vem do Jellyfin).
- Passos da mira: 10 s; 30 s a partir do 6º toque e 60 s a partir do 11º na mesma sequência; commit após 900 ms sem tecla ou OK; Voltar cancela.
- Selo do card na TV só após 1000 ms parado no card.
- Restauração de foco espera o elemento até 5 s.
- TVs antigas (Tizen): sem `:has()`, sem `structuredClone`, sem `Array.prototype.at`.
- Lint (`npx eslint src/apps`), `npx stylelint src/apps/freitas/freitas.scss`, `npx tsc --noEmit -p .`, `npm test` e o build dev limpos ao fim de cada tarefa.
- Commits como `Claude <noreply@anthropic.com>` com as linhas de atribuição da sessão.

## Review Focus
- Página longa com fileiras ainda carregando (skeleton): ↓ não pode “perder” o foco nem pular para o fim → teste em Task 2 (fileira skeleton sem focáveis é ignorada).
- Voltar para uma página cujo item lembrado não existe mais (episódio removido, card fora da lista): deve cair no comportamento normal sem travar → teste em Task 3 (timeout de 5 s libera os focos automáticos).
- Mira passando do fim ou antes do início do vídeo: deve ficar entre 0 e duração − 1 s → teste em Task 4.
- Filme sem prévia gerada (sem `Trickplay`): mira mostra só o horário, sem imagem quebrada → teste em Task 4.
- Série fora do Sonarr / ponte fora do ar: botão “Baixar episódios” não aparece; página da série segue normal → teste em Task 5.

Baseline (CPU 6×, mocks, aba Filmes): ↓ ~89 ms, → ~61 ms até pintar; 5 requisições em 6 cliques.
Scripts de medição: `/tmp/claude-0/-home-claude/f93117eb-6863-5701-a343-5ba81ba96e07/scratchpad/mock/tvperf2.py` e `trace.py`.

---

### Task 1: Foco barato nos cards (TV)

**Files:**
- Modify: `src/apps/freitas/components/Ratings.tsx` (`useCardActive`, `FOCUS_DELAY`)
- Modify: `src/apps/freitas/freitas.scss` (`.fp-card` TV focus)
- Test: `scratchpad/mock/cardfocus_test.py` (Playwright)

**Interfaces:** Produces nothing new; `useCardActive()` keeps its signature.

- [ ] **Step 1: Write the failing e2e test** `cardfocus_test.py`: TV login, aba Filmes, 8 setas → com 300 ms entre teclas; assert `requests_to('/Items/') == 0`; then rest 1300 ms on a card and assert `.fp-insight` count ≥ 0 and exactly 1 new `/Items/` request; assert focused `.fp-card` computed `transform == 'none'`.
- [ ] **Step 2: Run it, expect FAIL** (requests > 0, transform is a matrix).
- [ ] **Step 3: Implement** — TV delay `1000`; on TV `onBlur` calls `stop()` directly (no `matches(':hover')`); TV `.fp-card:focus` → `transform: none`, `.fp-card:focus .fp-card__frame` → `box-shadow: 0 0 0 u(3) var(--fp-purple), 0 0 0 u(6) rgba(139, 92, 246, 0.35)` (solid, no blur).
- [ ] **Step 4: Run test, expect PASS**; run `tvperf2.py`, record numbers.
- [ ] **Step 5: Commit** `perf(tv): no requests or layer churn while passing over cards`.

### Task 2: Navegação espacial `tvNav.ts`

**Files:**
- Create: `src/apps/freitas/tvNav.ts`
- Create: `src/apps/freitas/tvNav.test.ts`
- Modify: `src/apps/freitas/components/Layout.tsx` (install on TV), `routes/descobrir.tsx` (`.fp-catgrid` gets `data-nav='native'`), `routes/titulo.tsx` + `components/Hero.tsx` + `routes/catalogo.tsx` (`.fp-actions-row`/hero buttons get `data-nav-group`)

**Interfaces:**
- Produces: `installTvNav(root: HTMLElement): () => void` (adds a capturing `keydown` on `document`, returns cleanup);
  `groupOf(el: HTMLElement, root: HTMLElement): HTMLElement` (closest `.focuscontainer-x, [data-nav-group]` inside root, else `el`);
  `pickInGroup(group: HTMLElement, fromX: number, remembered?: HTMLElement): HTMLElement | null`;
  `isNavigable(el: HTMLElement): boolean` (focusable, not disabled, `offsetParent !== null`, `tabIndex >= 0`).

- [ ] **Step 1: Write failing unit tests** (`tvNav.test.ts`, jsdom, stub `getBoundingClientRect`):
  `→ moves to next card in same row`; `← at row start does nothing (handled, focus unchanged)`;
  `↓ goes to next row choosing nearest centre x`; `↑ returns to remembered card of previous row`;
  `skips a row with no navigable elements (skeleton)`; `ignores ← → inside input`;
  `does not handle keys inside [data-nav="native"]` (event not defaultPrevented);
  `single-element group: ← → not handled`.
- [ ] **Step 2: Run** `npx vitest run src/apps/freitas/tvNav.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** `tvNav.ts`. ↑/↓ walk `root.querySelectorAll(FOCUSABLE)` in DOM order from the current element to the first element whose `groupOf` differs and `isNavigable`; then `pickInGroup` over that group's navigable elements (remembered element wins when its rect intersects the viewport). Remember last focused element per group in a `WeakMap`. Focus with `{ preventScroll: true }`; `FreitasPage`'s existing `focusin` → `ensureVisible` scrolls. `preventDefault()` + `stopPropagation()` only when handled.
- [ ] **Step 4: Run unit tests, expect PASS.**
- [ ] **Step 5: e2e** — extend `lib2.py` TV section: ↓×5, →×2, ↓, ↑ lands on same card (row memory), header reachable with ↑ from hero; run `tvperf2.py` and compare with Task 1 numbers (goal: −40% vs baseline on ↓ and →).
- [ ] **Step 6: Commit** `perf(tv): row-by-row spatial navigation with per-row memory`.

### Task 3: Memória de página e volta do player

**Files:**
- Create: `src/apps/freitas/pageMemory.ts`, `src/apps/freitas/pageMemory.test.ts`
- Modify: `components/Layout.tsx` (use `useFocusMemory`), `components/Cards.tsx` + `components/Catalog.tsx` (`data-fkey={'item:' + id}`), `routes/titulo.tsx` (`ep:<id>`, `season:<id>`, `tab:<id>`, `usePageState` for season and tab; skip `scrollTo(0,0)` and PlayButton TV autofocus while restoring), `components/Hero.tsx` (skip autofocus while restoring)

**Interfaces:**
- Produces: `pageKey(location: { pathname: string, search: string }): string`;
  `usePageState<T>(name: string, initial: T): [T, (v: T) => void]`;
  `useFocusMemory(root: RefObject<HTMLElement>): void`;
  `useIsRestoring(): boolean` (true from mount on POP with memory until restored or 5 s);
  internal store `remember(key, patch)`, `recall(key)`.

- [ ] **Step 1: Failing unit tests** (`pageMemory.test.ts`): `usePageState keeps value per page key across remount`; `different pages do not share state`; `recall returns last fkey, rowId and scrollY`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** store (module `Map`), hooks with `useLocation`/`useNavigationType` from react-router; restoration: on POP with memory → `MutationObserver` on root until `[data-fkey="…"]` (inside `#rowId` when present) exists or 5 s → `window.scrollTo(0, scrollY)`, `el.focus({ preventScroll: true })`, `ensureVisible(el, true)`.
- [ ] **Step 4: Run unit tests, expect PASS.**
- [ ] **Step 5: e2e** `back_test.py` (mocks): TV, série → aba Episódios → temporada 2 → foca 3º episódio → Enter (player) → `history.back()` → assert focused `[data-fkey="ep:<id>"]` same id and season 2 pressed; Início: foca card na 4ª fileira → abre título → back → mesmo card focado; removed item case: memory with unknown fkey → after 5 s hero Play focused.
- [ ] **Step 6: Commit** `feat: return to the same item (episode, season, card) when going back`.

### Task 4: Prévia de frames (trickplay)

**Files:**
- Create: `src/apps/legacy/controllers/playback/video/trickplayTile.ts` + `.test.ts`
- Create: `src/apps/legacy/controllers/playback/video/seekPreview.ts` + `.test.ts`
- Modify: `src/apps/legacy/controllers/playback/video/index.js` (use `trickplayTile` in `updateTrickplayBubbleHtml`; TV capture of ←/→ on `nowPlayingPositionSlider` → `seekPreview`; preview element `.fp-seekpreview` in `osdBottomElement`), `src/apps/freitas/playback.ts` (fetch Trickplay for movies), `src/apps/freitas/freitas.scss` (preview style)

**Interfaces:**
- Produces: `tileFor(positionMs: number, info: { Interval: number, TileWidth: number, TileHeight: number, Width: number, Height: number }): { index: number, x: number, y: number }` (x/y = negative background offsets);
  `createSeekPreview(opts: { getPositionMs(): number, getDurationMs(): number, onPreview(ms: number): void, onCommit(ms: number): void, onCancel(): void, idleMs?: number }): { step(dir: 1 | -1): void, commit(): void, cancel(): void, active(): boolean }`;
  `playItem` unchanged signature (now async inside).

- [ ] **Step 1: Failing unit tests**: `tileFor(125000, {Interval:10000,TileWidth:10,TileHeight:10,Width:320,Height:180})` → `{index:0,x:-640,y:-180}`; `tileFor(1005000, same)` → `{index:1,x:0,y:0}`;
  seekPreview (fake timers): `first → previews pos+10s`; `6th press steps 30s, 11th 60s`; `commits once after 900 ms idle with final target`; `cancel restores and never commits`; `clamps to [0, duration-1000]`; `commit() immediately on OK`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** both modules; replace the inline math in `updateTrickplayBubbleHtml` with `tileFor`. In controller (TV only): capturing `keydown` on `nowPlayingPositionSlider` for ←/→ → `preventDefault`, `stopImmediatePropagation`, `preview.step(dir)`; `onPreview` sets `nowPlayingPositionSlider.dragging = true`, updates slider value and renders `.fp-seekpreview` (thumb via `updateTrickplayBubbleHtml` when `trickplayResolution`, else only time text) positioned at the slider %; `onCommit` → `playbackManager.seek(ms * 10000, currentPlayer)`, hide preview, `dragging = false`; Enter while active → `commit()`; Back while active → `cancel()` and stop propagation.
  `playItem`: when `item.Type === 'Movie'` and no `item.Trickplay`, fetch via `getUserLibraryApi(api).getItem` (or `getItems({ ids, fields: [Trickplay, Chapters, MediaSources] })`) then play the fetched item.
- [ ] **Step 4: Run unit tests, expect PASS.**
- [ ] **Step 5: e2e** `playinfo_test.py`: playing a movie from Freitas+ issues an items request with `Fields` containing `Trickplay` before `PlaybackInfo`.
- [ ] **Step 6: Commit** `feat(player): frame preview every 10 s and aim-then-seek on TV`.

### Task 5: Baixar série em 1 clique

**Files:**
- Modify: `src/apps/freitas/routes/titulo.tsx` (replace `SeriesDownloadButton` with labeled button; `Episodes` renders `ReleasesPanel` inline; season buttons show "faltam N"), `src/apps/freitas/freitas.scss`

**Interfaces:**
- Consumes: `useBridgeMe`, `useCatalogState('tv', tmdbId)` → `seasons: SeasonProgress[]`; `ReleasesPanel({ type:'tv', tmdbId, season, seasonNumber, onClose, onStarted })`; `usePageState` (Task 3) for `downloadOpen`.

- [ ] **Step 1: Failing e2e** `seriesdl_test.py`: série parcial (mock 645 → Jellyfin item) → button text matches `Baixar episódios` and `faltam 1`; click → tab Episódios active, `.fp-releases__title` says `Temporada 2`, “Só o que falta” pressed; click season 1 → title says `Temporada 1`; bridge down (`run_bridge` stopped) → button absent and page renders.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement**; TV: focus first `.fp-rel__main` when the panel loads (ReleasesPanel already does).
- [ ] **Step 4: Run e2e, expect PASS.**
- [ ] **Step 5: Commit** `feat: download a series' missing episodes from its own page in one click`.

### Task 6: Verificação final e publicação

- [ ] **Step 1:** `npm test`, eslint, stylelint, tsc, build dev — all clean.
- [ ] **Step 2:** `tvperf2.py` + `trace.py` → compare with baseline; must meet spec criteria (−40% ↓/→, 0 requests while passing).
- [ ] **Step 3:** Re-run regressions: `lib_test.py`, `tv_test.py`, `cat_test.py`, `cat_tv.py`, `autoimport_test.sh`.
- [ ] **Step 4:** Push; wait for CI (web, tizen, firetv, release) success.
- [ ] **Step 5:** Tell André how to update (server script, TV .wgt), with measured before/after numbers.
