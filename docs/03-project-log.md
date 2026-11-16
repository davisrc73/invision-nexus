# 03 - Project Log (Diário de Bordo)

## [2026-11-13] - Kickoff do Projeto e Inicialização da Documentação Viva

### Contexto e Objetivo
Arranque do desenvolvimento de uma plataforma enterprise de Digital Signage interna para o universo **Fnac e Darty**.
- **Infraestrutura Base (Host):** NAS Synology DS220+ via Docker.
- **Dispositivos (Edge Players):** Boxes Android (Chip X98 Plus, 4GB RAM, 64GB ROM) em modo Kiosk.
- **Stack Prevista:**
  - **Backend:** PocketBase ou Node.js + PostgreSQL (decisão em aberto na Fase 1/2).
  - **Dashboard Central:** Astro + Tailwind CSS.
  - **Player Offline-First:** Svelte PWA (IndexedDB / Cache API / File System Access).

### Pilares Arquiteturais Definidos
1. **Governance & RBAC rigoroso:** Perfis de Administrador Global, Diretor de Loja e Chefe de Departamento.
2. **Resiliência (Offline-first):** Cache local persistente nos 64GB de ROM para garantir operação contínua sem rede ou durante incidentes de cibersegurança.
3. **Proof of Play (Logs):** Registo local de exibição com sincronização diferida (batch/queue) quando houver conectividade.
4. **Sincronização Multi-Ecrã:** Preparação para sincronismo ao milissegundo via WebSockets / NTP.

### Metodologia de Trabalho
- Desenvolvimento estritamente dividido em **5 Fases**:
  1. Modelação de Dados / Governance
  2. Backend / API
  3. Dashboard
  4. PWA Player
  5. Sincronização e Kiosk
- **Gatekeeping:** Proibido avançar de fase ou gerar código funcional sem validação prévia e questionamento técnico ao utilizador.
- **Documentação Viva:** Estrutura `/docs/` inicializada (`/docs/01-arquitetura.md`, `/docs/02-database-schema.md`, `/docs/03-project-log.md`, `/docs/04-manuais/`).

### Estado Atual
- **Fase 1 (Modelação de Dados e Matriz de Governance):** Iniciada fase de questionamento e validação de requisitos junto do Product Owner / Stakeholder.


---

## [2026-11-13] - Fase 1 (Iteração 1): Definição de Escala, Prioridades e Modelo Operacional

### Respostas e Decisões do Stakeholder
1. **Hierarquia e Multi-Marca (Fnac / Darty):**
   - Árvore confirmada: `Insígnia -> País/Região -> Loja -> Departamento/Zona -> Grupo de Sincronização -> Ecrã (Device)`.
   - **Isolamento de Conteúdos:** Estrito por Insígnia (conteúdo Fnac não toca em Darty e vice-versa).
   - **Partilha de Utilizadores:** A equipa central gere ambas as insígnias simultaneamente (acesso cross-brand).
2. **Modelo Operacional, Prioridades e Share of Voice (SoV):**
   - Upload de conteúdos e gestão de playlists são **centralizados na equipa de gestão multimédia** (alinhada com Marketing e Comercial), baseados numa **Matriz de Conteúdos / Slots**.
   - **4 Níveis de Prioridade:**
     1. `EXCLUSIVA` (override absoluto sobre todas as restantes).
     2. `PRIORITARIA` (sobrepõe-se à Normal).
     3. `NORMAL` (default operacional).
     4. `FALLBACK` (playlist institucional de segurança quando não há conteúdos válidos/ativos).
   - **Share of Voice (SoV):** Distribuição de campanhas/conteúdos por percentagem de tempo de antena / slots.
   - **Validação Técnica de Formato (Guardrail):** O sistema deve validar a resolução/aspect-ratio/formato do ficheiro de media contra a configuração física do terminal de destino (ex: impedir envio de vídeo 16:9 para um LEDwall com resolução customizada ou ecrã 9:16).
   - **Visibilidade Loja:** Perfis de loja (Diretor de Loja / Chefe de Departamento) precisam de visualização clara do que está em exibição por playlist/ecrã (ex: LEDwall entrada de loja).
3. **RBAC e Gestão de Hardware:**
   - A equipa multimédia tem gestão global do parque ativo.
   - Provisionamento, emparelhamento e comandos críticos de hardware (Reboot, Cache, Orientação, Kill Switch) exclusivos para **Admin Global** e **IT**.
4. **Agendamento (Scheduling):**
   - Suporte a `start_date` / `end_date` + **Dayparting** (janelas horárias e dias da semana).
   - Fallback configurável ao nível da prioridade da playlist ou do conteúdo.
5. **Escala Enterprise e Proof of Play (Decisão Crítica de Stack):**
   - **Ambiente Dev/Staging:** NAS Synology DS220+ (Docker).
   - **Ambiente Produção:** Servidor corporativo dedicado (Compliance enterprise).
   - **Escala Real:** ~70 Lojas (2 insígnias) e **~4.000 dispositivos** (incluindo boxes Android X98 Plus, LEDwalls, e parque de exposição: Portáteis, Smartphones e Tablets).
   - **Proof of Play:** Opção B confirmada (**Agregação Horária/Diária** no Player antes de enviar para o servidor), com **retenção de 1 ano** (~35 milhões de registos/ano se horário para 4.000 devices).

---

## [2026-11-13] - Fase 1 (Iteração 2): Fecho da Arquitetura de Dados e Documentação v1.0

### Decisões Técnicas Consolidadas
1. **Base de Dados Oficial:** Fechado **PostgreSQL 16+** (em conjunto com Node.js/Fastify e Redis para heartbeats), descartando SQLite/PocketBase para suportar os ~4.000 dispositivos e ~175M de registos anuais com particionamento mensal.
2. **Tipologia de Dispositivos e Interatividade:**
   - Categorias suportadas: `ANDROID_BOX`, `LEDWALL`, `TV_DEMO`, `LAPTOP_EXPO`, `TABLET_EXPO`, `SMARTPHONE_EXPO`.
   - Adicionado suporte a **Modo Idle Screensaver** (para Portáteis, Tablets e Smartphones em bancada) com recolha de telemetria de `TOUCH_WAKE` e tempo de utilização (`total_engaged_seconds`).
   - Adicionado suporte a **Modo Catálogo Interativo (`TV_DEMO`)** permitindo escolher vídeos de teste de imagem por categoria (*Desporto, Filmes, Gaming, etc.*) com respetiva telemetria.
3. **Motor Híbrido de Playlists e Prioridades:**
   - Suporte aos **2 modelos de construção de Playlist** à escolha no momento da criação: `FIXED_SLOTS` (Matriz de slots fixas) e `DYNAMIC_SOV` (Share of Voice por percentagem).
   - Regra de precedência estrita confirmada: `EXCLUSIVA` > `PRIORITARIA` > `NORMAL` > `FALLBACK`, onde `PRIORITARIA` silencia a 100% a `NORMAL` durante a sua janela ativa.
4. **Format Guardrail:**
   - Criada entidade `screen_profiles` associada aos terminais e às playlists, bloqueando a associação de conteúdos cuja resolução/aspect-ratio viole a configuração física do terminal.
5. **Governance de Loja:**
   - Perfis `STORE_MANAGER` (Diretor de Loja) e `DEPT_HEAD` (Chefe de Departamento) definidos como **100% Read-Only + Monitorização**, com capacidade de abrir incidentes (`device_incidents`) sobre anomalias nos ecrãs do seu escopo.

### Ficheiros Atualizados
- Preenchido `/docs/01-arquitetura.md` com topologia Hub-and-Spoke, diagramas Mermaid e fluxos de sincronização e telemetria.
- Preenchido `/docs/02-database-schema.md` com a Matriz RBAC completa, ERD e especificação de todas as tabelas PostgreSQL.
- Próximo Passo: Validação final da Fase 1 pelo utilizador e resposta às questões da **Fase 2 (Backend / API & Infraestrutura Docker)**.

---

## [2026-11-13] - Fase 2 Concluída: Construção do Backend, Base de Dados PostgreSQL e Infraestrutura Docker

### Respostas e Validações do Stakeholder (Fase 2)
1. **Autenticação Dual:** Confirmada autenticação JWT local (preparada para futuro SSO) para utilizadores do Dashboard, e fluxo **Zero-Touch Pairing Code (6 dígitos)** para os ~4.000 dispositivos.
2. **Format Guardrail via `ffprobe`:** Confirmada inspeção rápida de metadados (`width`, `height`, `aspect_ratio`, `codec`, `sha256`) e geração de 1 thumbnail `.webp` sem recodificação de vídeo no servidor, rejeitando uploads fora do `ScreenProfile`.
3. **Proteção de Rede (Staggered Rollout & HTTP Range):** Confirmada implementação de *jitter* determinístico de download (`stagger_delay_sec`) no manifesto e suporte a `HTTP 206 Partial Content (Range Requests)` no streaming de media.
4. **Heartbeat e Supressão Inteligente de Alertas:** Intervalo de 60s (timeout 180s / 3 falhas). Confirmada a supressão automática de alertas de `OFFLINE` fora do horário de funcionamento da loja (`opening_hours`) para dispositivos do parque de exposição (`LAPTOP_EXPO`, `TABLET_EXPO`, `SMARTPHONE_EXPO`, `TV_DEMO`).

### Entregáveis Construídos na Fase 2
- `docker-compose.yml` e `.env.example` afinados para o Synology DS220+ (PostgreSQL 16 + Redis 7 + Fastify API).
- `backend/sql/001_init_schema.sql`: DDL completo com tabelas de hierarquia, RBAC, Playlists híbridas (`FIXED_SLOTS` / `DYNAMIC_SOV`), Catálogo `TV_DEMO` e tabelas particionadas `pop_logs_hourly` e `interaction_logs_hourly`.
- `backend/src/`:
  - `middleware/rbac.ts`: Controlo estrito por perfil (`GLOBAL_ADMIN`, `IT_OPS`, `MEDIA_MANAGER`, `STORE_MANAGER`, `DEPT_HEAD`) e autenticação de `X-Device-Token`.
  - `services/formatGuardrail.ts`: Inspeção `ffprobe`, hashing SHA-256 em stream e bloqueio de formatos incompatíveis.
  - `services/manifestEngine.ts`: Compilador de Manifesto com silenciamento estrito (`EXCLUSIVA` > `PRIORITARIA` > `NORMAL` > `FALLBACK`), motor Weighted Round-Robin para *Share of Voice (%)* e cálculo de *Staggered Rollout*.
  - `services/heartbeatMonitor.ts`: Monitorização Redis/PG e supressão de alertas noturnos em bancadas de exposição.
  - `routes/` (`auth.ts`, `devices.ts`, `media.ts`, `telemetry.ts`) + `server.ts`.
- Criado manual `/docs/04-manuais/01-setup-synology-docker.md`.

### Estado Atual
- **Fase 2 Concluída.** Aguardando validação e respostas às questões da **Fase 3: Dashboard Central de Gestão (Astro + Tailwind CSS)**.

---

## [2026-11-13] - Fase 3 Concluída: Dashboard Central de Gestão (Astro + Tailwind CSS)

### Validações do Stakeholder (Fase 3)
1. **Brand Switcher Global:** Confirmado no topo da barra lateral (`FNAC`, `DARTY`, `GLOBAL`) para isolar o contexto operacional da equipa transversal e impedir mistura de conteúdos entre insígnias.
2. **Construtor Híbrido de Playlists:** Confirmada interface que suporta tanto a grelha visual de **Matriz de Slots Fixas (`FIXED_SLOTS`)** como os *sliders* de **Share of Voice (`DYNAMIC_SOV`)** com pré-visualização da sequência intercalada (*Weighted Round-Robin*) e validação interativa do **Format Guardrail**.
3. **Live Wall de Loja & Incidentes:** Confirmada vista *Read-Only* para Diretores de Loja e Chefes de Departamento com estado em tempo real por departamento e modal de 2 cliques para abrir incidentes.
4. **Relatórios & Exportação CSV:** Confirmada exportação direta de CSV para Proof of Play (auditoria de fornecedores) e painel dedicado às métricas de Touch (`LAPTOP_EXPO`, `SMARTPHONE_EXPO`, `TABLET_EXPO`) e categorias `TV_DEMO`.

### Entregáveis Construídos na Fase 3
- `dashboard/` (Projeto Astro + Tailwind CSS + Dockerfile Nginx):
  - `src/layouts/DashboardLayout.astro`: Brand Switcher Global (`FNAC` / `DARTY` / `ALL`) e seletor/controlador RBAC em tempo real.
  - `src/pages/index.astro`: Visão global das 70 lojas (~4.000 dispositivos), formulário de aprovação Zero-Touch Pairing (6 dígitos) exclusivo para `GLOBAL_ADMIN` e `IT_OPS`, e monitorização das 4 prioridades.
  - `src/pages/playlists.astro`: Construtor híbrido (`FIXED_SLOTS` + `DYNAMIC_SOV`) e validador interativo do *Format Guardrail*.
  - `src/pages/store-wall.astro`: Live Wall por zona física (LEDwall entrada, TVs Demo, Bancadas Expo) com supressão de alertas noturnos e modal de reporte de incidentes.
  - `src/pages/telemetry.astro`: Relatórios de Proof of Play (1 ano) + Métricas Touch/TV Demo com exportação CSV imediata.
- Criado manual `/docs/04-manuais/02-manual-governance-dashboard.md`.

### Estado Atual
- **Fase 3 Concluída.** Aguardando validação e respostas às questões da **Fase 4: PWA Player Offline-First (Svelte)**.

---

## [2026-11-13] - Fase 4 Concluída: PWA Player Offline-First em Svelte

### Validações do Stakeholder (Fase 4)
1. **Armazenamento Persistente nos 64GB ROM (`navigator.storage.persist()`) + Atomic Swap + Garbage Collection:** Confirmada validação SHA-256 antes de ativar nova programação e purga automática de vídeos de campanhas antigas (mantendo `FALLBACK`).
2. **Transição Gapless (Dual-Buffer Video Deck):** Confirmada sobreposição de dois decks (`Deck A` e `Deck B`) onde o vídeo seguinte aguarda no *frame 0*, eliminando o "flash negro" de 150-300ms do descodificador de hardware das Boxes Android X98 Plus.
3. **Suporte aos 3 Modos num Único Binário PWA:**
   - `PASSIVE` (Boxes X98 Plus e LEDwalls com cursor oculto).
   - `IDLE_SCREENSAVER` (Portáteis, Tablets e Smartphones em exposição com interrupção ao toque, contagem de tempo de sessão e retoma automática após inatividade).
   - `INTERACTIVE_CATALOG` (TVs em exposição com dock navegável por Comando D-Pad Setas + OK ou Touch para testar Desporto, Filmes OLED, Gaming 120Hz e Natureza).
4. **Hidden OSD Diagnostic Menu:** Confirmado atalho secreto (5 toques no canto superior esquerdo ou tecla `F12` / `i`) para técnicos em loja inspecionarem espaço livre nos 64GB ROM, contadores PoP/Touch no IndexedDB, offset NTP e alternarem modos de teste.

### Entregáveis Construídos na Fase 4
- `player/` (Svelte PWA + Vite + Dockerfile Nginx):
  - `public/sw.js` e `public/manifest.webmanifest`: Service Worker que interceta streams de vídeo e os serve diretamente da Cache ROM local mesmo com rede cortada.
  - `src/lib/offlineStorage.ts`: Persistência de storage, verificação WebCrypto SHA-256, *Atomic Manifest Swap* e *Garbage Collection* (`purgeOrphanedMediaFromRom`).
  - `src/lib/telemetryQueue.ts`: Base de dados local IndexedDB (`pop_buckets` e `interaction_buckets`) com agregação horária e sincronização idempotente em lote.
  - `src/App.svelte`: Motor visual Dual-Buffer (`Deck A` / `Deck B`), ecrã Zero-Touch Pairing (6 dígitos), modos `PASSIVE`, `IDLE_SCREENSAVER`, `INTERACTIVE_CATALOG` e *Hidden OSD Menu*.

### Estado Atual
- **Fase 4 Concluída.** Aguardando validação e respostas às questões da **Fase 5 (Última Fase): Sincronização Multi-Ecrã ao Milissegundo (WebSockets/NTP) e Provisionamento Kiosk (Android X98 Plus & Parque Expo)**.

---

## [2026-11-13] - Fase 5 Concluída: Sincronização Multi-Ecrã ao Milissegundo, Provisionamento ADB Kiosk e Stack Docker Unificada

### Validações do Stakeholder (Fase 5)
1. **Algoritmo de Sincronização ao Milissegundo:** Confirmado motor **Deterministic Epoch Timecode + WebSocket Micro-Pacing** (`playbackRate` `0.98x` / `1.02x` para desvios entre 15ms e 150ms, e *Hard Seek* apenas acima de 150ms).
2. **Resiliência da Sincronização em Corte de WAN:** Confirmada persistência do `clockOffsetMs` e declive de deriva (`driftSlopePpm`) em `localStorage` + fallback para o gateway local da loja.
3. **Provisionamento Automatizado ADB para Boxes Android X98 Plus:** Confirmada criação do script `scripts/provision-x98-kiosk.sh`.
4. **Orquestração Unificada no `docker-compose.yml`:** Confirmada inclusão dos 5 serviços (`postgres`, `redis`, `backend`, `dashboard`, `player`) com limites de memória afinados para o Synology DS220+.

### Entregáveis Construídos na Fase 5
- `player/src/lib/syncEngine.ts`: Classe `MillisecondSyncEngine` integrada no `App.svelte` e visível em tempo real no *Hidden OSD Diagnostic Menu*.
- `scripts/provision-x98-kiosk.sh`: Script Bash/ADB para provisionamento Kiosk das Boxes Android X98 Plus (desativa standby/CEC, ativa Immersive Mode e Autoplay sem gesto humano).
- `docker-compose.yml`: Atualizado com os 5 contentores (`invision_postgres`, `invision_redis`, `invision_backend`, `invision_dashboard`, `invision_player`).
- `/docs/04-manuais/03-provisionamento-kiosk-x98-sync.md`: Manual técnico de provisionamento Kiosk e sincronização.

### Estado Final do Projeto
- **Todas as 5 Fases Concluídas e Validadas.**

---

## [2026-11-14] - Arranque Local e Validação dos Servidores (Dashboard & Player PWA)

### Ações Executadas e Bugs Resolvidos
1. **Instalação de Dependências:**
   - Instaladas todas as dependências do `player/` (Svelte + Vite) e do `dashboard/` (Astro + Tailwind CSS).
   - *Fix:* Contornado erro de permissões de cache global `~/.npm` utilizando cache isolada em `/tmp/invision-npm-cache`.
2. **Resolução de Bug no Arranque do Astro (`EPERM` em `~/Library/Preferences/astro/config.json`):**
   - *Causa:* O módulo `@astrojs/telemetry` tentava escrever fora da pasta do projeto no macOS.
   - *Solução:* Adicionadas as variáveis `ASTRO_TELEMETRY_DISABLED=1 XDG_CONFIG_HOME=/tmp/astro-config HOME=/tmp` nos scripts de execução do [dashboard/package.json](file:///Users/daviscorreia/Antigravity%20/invision-nexus/dashboard/package.json).
3. **Servidores Ativos Localmente:**
   - **Dashboard Central (Astro + Tailwind):** Online em `http://localhost:4321/` (e na LAN em `http://192.168.68.118:4321/`).
   - **Player PWA Offline-First (Svelte):** Online em `http://localhost:5173/` (e na LAN em `http://192.168.68.118:5173/`).

---

## [2026-11-14] - Hotfix no Player PWA: Preprocessor TypeScript no Svelte (`vitePreprocess`)

### Problema Reportado
- Ao abrir o Player PWA (`http://localhost:5173`), o Vite exibia erro `[plugin:vite-plugin-svelte] App.svelte:5:9 Unexpected token — Did you forget to add a TypeScript preprocessor?`.

### Causa e Solução Aplicada
- O ficheiro `player/svelte.config.js` com `vitePreprocess()` não estava presente e o bloco `<script>` em `App.svelte` continha sintaxe `import { type StorageHealth }`.
- Criado `player/svelte.config.js` com `preprocess: vitePreprocess()` e simplificado o script do `App.svelte` para compilação instantânea sem dependências extras de pré-processador.

---

## [2026-11-14] - Ativação de Upload Real de Vídeos e Imagens + Sincronização Instantânea (Live Media Bridge)

### Funcionalidade Implementada
- Criado e levantado na porta `3000` o serviço [backend/live-bridge.mjs](file:///Users/daviscorreia/Antigravity%20/invision-nexus/backend/live-bridge.mjs) (HTTP Range Streaming `206 Partial Content` + Cálculo SHA-256 + Servidor WebSocket nativo RFC 6455 em `/ws/sync`).
- Atualizada a página [dashboard/src/pages/playlists.astro](file:///Users/daviscorreia/Antigravity%20/invision-nexus/dashboard/src/pages/playlists.astro) com formulário de **Upload Real de Vídeos (`.mp4`, `.webm`, `.mov`) e Imagens (`.jpg`, `.png`, `.webp`)**, deteção automática de resolução (`width`, `height`, `aspectRatio`, `durationMs`) e publicação em tempo real nas slots da Playlist.
- Atualizado o [player/src/App.svelte](file:///Users/daviscorreia/Antigravity%20/invision-nexus/player/src/App.svelte) para renderizar tags `<video>` e `<img>` reais nos `Deck A` e `Deck B` e atualizar a programação ao milissegundo via WebSocket assim que um ficheiro é carregado no Dashboard.

---

## [2026-11-14] - Etapa 1 + Etapa 2 Concluídas: Integração End-to-End Real-Time (Multi-Playlist, Prioridades, SoV, Live Wall & Telemetria)

### O que foi implementado
1. **Motor Multi-Playlist, Override de Prioridades & Share of Voice Real (`backend/live-bridge.mjs` v2 + `dashboard/src/pages/playlists.astro`):**
   - Suporte a múltiplas playlists simultâneas com os 4 níveis de precedência (`EXCLUSIVA` > `PRIORITARIA` > `NORMAL` > `FALLBACK`), janelas de *Dayparting* (`daypartStart`..`daypartEnd`) e alternância entre `FIXED_SLOTS` e `DYNAMIC_SOV` (*Weighted Round-Robin*).
   - Quando o utilizador ativa uma Playlist `EXCLUSIVA` ou `PRIORITARIA` (com pelo menos 1 vídeo/imagem), o servidor recalcula a Playlist Dominante (`effectivePlayback`) e faz *push* instantâneo por WebSocket para todos os Players.
2. **Live Wall Real-Time & Zero-Touch Pairing via WebSocket (`dashboard/src/pages/index.astro` + `store-wall.astro`):**
   - Os Players abertos no Mac e no Telemóvel enviam *heartbeats* reais a cada 4 segundos (`/api/v1/live/heartbeat`) reportando `hardwareUid`, `currentMediaTitle`, miniatura/stream em reprodução, espaço livre nos 64GB ROM e offset NTP.
   - O formulário de **Zero-Touch Pairing** em `/` desbloqueia remotamente via WebSocket qualquer Player que esteja no ecrã de código de 6 dígitos (`NX-849201`).
   - Os incidentes abertos em `/store-wall` ficam persistidos no servidor e podem ser marcados como resolvidos.
3. **Telemetria Real de Proof of Play & Touch / TV Demo (`dashboard/src/pages/telemetry.astro`):**
   - Cada vez que um vídeo ou imagem termina a reprodução no Player (ou o utilizador toca no ecrã em modo `IDLE_SCREENSAVER` / `INTERACTIVE_CATALOG`), o evento é registado no IndexedDB local e sincronizado com `/api/v1/live/telemetry`, atualizando automaticamente as tabelas e o ficheiro CSV exportado.

---

## [2026-11-14] - Correção da Sequência Multi-Item na Playlist & Suporte Multi-Equipamento (Boxes Android)

### Problemas Resolvidos e Melhorias
1. **Fix de Reprodução Completa de Todos os Ficheiros da Playlist (`player/src/App.svelte` + `backend/live-bridge.mjs` v3):**
   - *Causa:* O `applyLiveManifest()` reiniciava `currentIndex = 0` sempre que havia uma atualização de estado/heartbeat, e o cálculo de `evalSync` forçava a posição para o primeiro slot quando as durações variavam.
   - *Solução:* Introduzida assinatura determinística (`manifestSignature` MD5) no servidor — o Player só reinicia o Loop quando os itens ou a prioridade da Playlist mudam efetivamente. Para vídeos, o avanço (`Slot #1 -> Slot #2 -> Slot #3...`) é agora governado pelos eventos nativos `on:ended` / `on:timeupdate`, e no menu OSD foi adicionado um botão **"⏭ Saltar para Próximo Vídeo/Imagem Agora"**.
2. **Suporte Multi-Equipamento para Testes com Várias Boxes Android:**
   - Cada Box Android, Telemóvel ou Mac gera agora um **Código Zero-Touch Único (`NX-xxxxxx`)** e `hardwareUid` próprio.
   - Na página principal do Dashboard (`/`), cada Box detetada na rede tem um botão **"⚡ Emparelhar Esta Box / ✎ Configurar"** que preenche automaticamente o código único dessa Box.
   - Na página de Playlists (`/playlists`), cada Playlist tem agora um seletor **"Equipamentos Alvo desta Playlist"**, permitindo escolher se a Playlist toca em **Todos os Equipamentos** ou apenas na **Box Android 1**, **Box Android 2**, **Telemóvel**, etc.

---

## [2026-11-14] - Auto-Instalação do ADB no Script de Provisionamento (`provision-x98-kiosk.sh`)

### Problema Reportado
- Ao executar `bash scripts/provision-x98-kiosk.sh 192.168.68.115` no Mac, ocorria o erro `adb: command not found` por o *Android Platform Tools* não estar instalado globalmente no macOS.

### Solução Implementada
- Atualizado [scripts/provision-x98-kiosk.sh](file:///Users/daviscorreia/Antigravity%20/invision-nexus/scripts/provision-x98-kiosk.sh) com um bloco `[AUTO-SETUP]`: se o binário `adb` não existir no Mac, o próprio script descarrega e extrai automaticamente o pacote oficial `platform-tools-latest-darwin.zip` da Google para `./tools/platform-tools/adb` e aponta por defeito o `PLAYER_URL` para `http://192.168.68.118:5173`.

---

## [2026-11-14] - Fix de Compatibilidade WebView Android X98 Plus (Resolução de Ecrã Preto em HTTP LAN)

### Problema Reportado
- Após o script ADB abrir o browser na Box Android X98 Plus (`192.168.68.115`), o ecrã aparecia a preto (`#000000`).

### Causa e Solução Implementada
1. **APIs Web restritas a HTTPS (`navigator.storage`, `crypto.subtle`, `performance.timeOrigin`):** Em ligações HTTP por IP local (`http://192.168.68.118:5173`), os browsers Android desativam `navigator.storage` e `crypto.subtle`, lançando exceção não tratada na montagem do componente Svelte.
   - *Fix:* Adicionados blocos `try/catch` e *fallbacks* seguros em [offlineStorage.ts](file:///Users/daviscorreia/Antigravity%20/invision-nexus/player/src/lib/offlineStorage.ts) e `safeNowMs()` em [syncEngine.ts](file:///Users/daviscorreia/Antigravity%20/invision-nexus/player/src/lib/syncEngine.ts).
2. **Target ES2015 & Ecrã de Boot Visível ([index.html](file:///Users/daviscorreia/Antigravity%20/invision-nexus/player/index.html) e [vite.config.ts](file:///Users/daviscorreia/Antigravity%20/invision-nexus/player/vite.config.ts)):**
   - Configurado `target: 'es2015'` no Vite para suportar WebViews Android de fábrica mais antigos e adicionado um ecrã de *Boot Fallback* visível na TV com captura de erros JS (`window.onerror`) caso algum módulo falhe.

---

## [2026-11-14] - Resolução Definitiva do `SyntaxError: Unexpected token '.'` nas Boxes Android X98 Plus

### Causa Identificada pelo Ecrã de Diagnóstico na TV
- A foto da TV ligada à Box Android X98 Plus mostrou: `Uncaught SyntaxError: Unexpected token '.' (http://192.168.68.118:5173/src/App.svelte:1234)`.
- O browser Chromium nativo das Boxes Android X98 Plus (versão < 80) não suporta o operador de *Optional Chaining* (`?.`) nem *Nullish Coalescing* (`??`), e o servidor `vite dev` enviava módulos não transpilados.

### Solução Aplicada
1. Substituídos todos os operadores `?.` e `??` em `App.svelte`, `offlineStorage.ts` e `syncEngine.ts` por verificações clássicas compatíveis com ES2015.
2. Compilado o bundle otimizado (`npm --prefix player run build` com `target: 'es2015'`) e confirmado via `grep` que existem **zero** ocorrências de `?.` ou `??` no ficheiro final `dist/assets/index-*.js`.
3. O servidor da porta `5173` corre agora em modo `vite preview --port 5173 --host`, servindo o bundle ES2015 100% compatível com qualquer Box Android X98 Plus, telemóvel e Mac.

---

## [2026-11-14] - Fix de Ecrã Inteiro (100vw x 100vh) no Browser da Box Android X98 Plus

### Problema Reportado
- Na Box Android X98 Plus (`192.168.68.115`), o vídeo da Playlist aparecia reduzido num retângulo pequeno no canto superior esquerdo e a barra de endereço/separadores do Chrome permanecia visível.

### Causa e Solução Implementada
1. **Incompatibilidade da propriedade CSS `inset: 0` em Chromium < 87 & Minificador CSS do Vite:**
   - A propriedade abreviada `inset: 0` só foi introduzida no Chrome 87. Além disso, o minificador CSS do `esbuild` convertia automaticamente `top: 0; left: 0; right: 0; bottom: 0` de volta para `inset: 0` durante o `vite build`, fazendo com que o `<video>` com `position: fixed` assumisse a posição estática dentro do contentor `.video-deck`, que tinha `padding: 2.5rem` (`40px` de margem escura à volta do vídeo).
   - *Fix:* Configurado `cssTarget: 'chrome61'` e `cssMinify: false` em [player/vite.config.ts](file:///Users/daviscorreia/Antigravity%20/invision-nexus/player/vite.config.ts), removido o `padding: 2.5rem` de `.video-deck` (`padding: 0; margin: 0;`) e utilizado `position: fixed; top: 0; left: 0; width: 100%; height: 100%;` em [player/src/App.svelte](file:///Users/daviscorreia/Antigravity%20/invision-nexus/player/src/App.svelte).
2. **Ocultação da Barra de Ferramentas Superior do Chrome (Fullscreen API em Eventos de Ativação):**
   - No Chromium do Android, a chamada `requestFullscreen()` / `webkitRequestFullscreen()` é rejeitada em eventos `pointerdown` (só é aceite em eventos de ativação `click`, `touchend`, `mouseup` ou `keydown`). Na versão anterior, o `pointerdown` marcava `isFullscreen = true` antes do `click` ocorrer, impedindo a entrada em Fullscreen.
   - *Fix:* Substituída a flag manual por verificação real de `document.fullscreenElement || document.webkitFullscreenElement`, registados *listeners* globais de captura (`click`, `touchend`, `mouseup`) e atualizado o [scripts/provision-x98-kiosk.sh](file:///Users/daviscorreia/Antigravity%20/invision-nexus/scripts/provision-x98-kiosk.sh) com `am set-debug-app --persistent com.android.chrome`, `am force-stop com.android.chrome`, *cache-busting* URL (`?kiosk=...`) e duplo toque ADB automático.

---

## [2026-11-14] - Preparação do Repositório GitHub & Pipeline de Atualização Contínua para o Synology NAS

### O que foi configurado
1. **Repositório Git & Controlo de Versões (`.gitignore` + `README.md`):**
   - Criado [.gitignore](file:///Users/daviscorreia/Antigravity%20/invision-nexus/.gitignore) para excluir artefactos pesados (`node_modules/`, `dist/`, `.astro/`, `tools/platform-tools/`, `data/postgres/`, `data/redis/`, vídeos de teste locais) mantendo a estrutura persistente (`data/storage/media/.gitkeep`).
   - Criado [README.md](file:///Users/daviscorreia/Antigravity%20/invision-nexus/README.md) com a arquitetura completa e comandos de operação Mac -> GitHub -> Synology NAS -> Boxes Android X98 Plus.
2. **Alinhamento Docker para o Synology NAS (`docker-compose.yml` + `backend/Dockerfile` + `dashboard/Dockerfile`):**
   - Atualizado [backend/Dockerfile](file:///Users/daviscorreia/Antigravity%20/invision-nexus/backend/Dockerfile) e [docker-compose.yml](file:///Users/daviscorreia/Antigravity%20/invision-nexus/docker-compose.yml) para que o contentor `invision_backend` execute `live-bridge.mjs` com persistência em volume NAS (`./data/storage:/app/data/storage`), preservando todos os vídeos carregados, playlists, boxes emparelhadas e telemetria entre atualizações.
3. **Scripts de Sincronização Contínua (`scripts/git-sync.sh` e `scripts/update-nas.sh`):**
   - [scripts/git-sync.sh](file:///Users/daviscorreia/Antigravity%20/invision-nexus/scripts/git-sync.sh): Script para comitar e enviar evoluções para o GitHub num único comando.
   - [scripts/update-nas.sh](file:///Users/daviscorreia/Antigravity%20/invision-nexus/scripts/update-nas.sh): Script para correr no Synology NAS que faz `git pull origin main` e `docker compose up -d --build --remove-orphans`.

---

## [2026-11-14] - Resolução de Conflito de Portas no Synology NAS (`5432` DSM & Coexistência com `BandOS`)

### Problema Reportado no Synology NAS
- Ao executar `bash scripts/update-nas.sh` no NAS, as imagens compilaram com sucesso mas o arranque do `invision_postgres` devolveu: `Error starting userland proxy: listen tcp4 0.0.0.0:5432: bind: address already in use`.

### Causa e Solução Implementada
1. **Conflito de Porta `5432` no Synology DSM (e `5433`/`5173` do `BandOS`):**
   - O sistema operativo Synology DSM utiliza nativamente a porta `5432` para a sua base de dados PostgreSQL interna de sistema, e o projeto `BandOS` utiliza a porta `5433` (Postgres) e `5173` (Frontend).
2. **Isolamento Automático de Portas Externas ([docker-compose.yml](file:///Users/daviscorreia/Antigravity%20/invision-nexus/docker-compose.yml), [.env.example](file:///Users/daviscorreia/Antigravity%20/invision-nexus/.env.example) e [scripts/update-nas.sh](file:///Users/daviscorreia/Antigravity%20/invision-nexus/scripts/update-nas.sh)):**
   - Alteradas as portas base para **`5434`** (`invision_postgres`), **`6380`** (`invision_redis`), **`3000`** (`invision_backend`), **`4322`** (`invision_dashboard`) e **`5174`** (`invision_player`).
   - Implementado um **Auto-Port Scanner** (`pick_free_port` via `docker ps` + `ss -tuln` / `netstat -tuln`) no [scripts/update-nas.sh](file:///Users/daviscorreia/Antigravity%20/invision-nexus/scripts/update-nas.sh): antes de arrancar o Docker Compose, o script verifica individualmente cada uma das 5 portas no NAS e, se alguma estiver ocupada por outro projeto/serviço, avança automaticamente para a porta seguinte livre (`+1`) e grava-a no `.env`, além de saltar o `--build` quando as imagens já estão compiladas e sem alterações de código.

---

## [2026-11-14] - Suporte Multi-Plataforma (Synology NAS Linux & macOS) no Script `provision-x98-kiosk.sh`

### Problema Reportado
- Ao executar `bash scripts/provision-x98-kiosk.sh 192.168.68.115 http://<IP_DO_NAS>:5173` diretamente no terminal SSH do Synology NAS, ocorria o erro `unzip: command not found` e o pacote descarregado era a versão macOS (`darwin`).

### Solução Implementada
1. **Deteção Automática de Sistema Operativo (`uname -s`) em [scripts/provision-x98-kiosk.sh](file:///Users/daviscorreia/Antigravity%20/invision-nexus/scripts/provision-x98-kiosk.sh):**
   - Descarrega automaticamente `platform-tools-latest-linux.zip` quando executado no Synology NAS (`Linux`) e `platform-tools-latest-darwin.zip` quando executado no Mac (`Darwin`).
2. **Extração ZIP sem dependência de `unzip` no Synology DSM:**
   - Função `extract_zip` com *fallbacks* nativos do Synology DSM (`python3 -m zipfile`, `/usr/syno/bin/7z`, `busybox unzip` ou contentor `alpine`).
3. **Deteção Automática do IP e Porta do Player no NAS (`.env`):**
   - Lê automaticamente o `PLAYER_PORT` do `.env` (ex: `5174` no NAS para não colidir com o `BandOS` na `5173`) e ajusta o URL caso o utilizador passe `:5173` ou omita o segundo parâmetro.

---

## [2026-11-15] - Fix de Redirecionamento de Porta Nginx no Dashboard (`:4322`) & Watchdog de Auto-Boot Pós-Reboot das Boxes Android

### Problemas Resolvidos e Evoluções
1. **Validação Noturna em Produção Real (Box Android X98 Plus + Synology NAS):**
   - A Box X98 Plus correu ininterruptamente durante toda a madrugada, registando mais de **12.500 exibições (Proof of Play)** distribuídas sequencialmente pelos 3 conteúdos da Playlist ativa (`CRÉDITO - Modalidades`, `NATAL - Solidário`, `NATAL - Kids`).
2. **Fix de Redirecionamento Nginx nas Sub-Rotas do Dashboard (`http://192.168.68.117:4322/playlists/`):**
   - *Causa:* No contentor `invision_dashboard` (`nginx:alpine` mapeado na porta externa `4322:80`), ao clicar num link sem barra final (`/playlists`), o Nginx emitia um redirecionamento `301` para a porta interna `80` (`http://192.168.68.117/playlists/`), perdendo a porta `:4322`.
   - *Solução:* Criados [dashboard/nginx.conf](file:///Users/daviscorreia/Antigravity%20/invision-nexus/dashboard/nginx.conf) e [player/nginx.conf](file:///Users/daviscorreia/Antigravity%20/invision-nexus/player/nginx.conf) com `absolute_redirect off; port_in_redirect off;` e `try_files $uri $uri/index.html`, e atualizados os links em [DashboardLayout.astro](file:///Users/daviscorreia/Antigravity%20/invision-nexus/dashboard/src/layouts/DashboardLayout.astro) e [index.astro](file:///Users/daviscorreia/Antigravity%20/invision-nexus/dashboard/src/pages/index.astro) para `/playlists/`, `/store-wall/` e `/telemetry/`.
3. **Persistência de ID (`hardwareUid`) e Auto-Arranque Pós-Reboot da Box ([scripts/kiosk-watchdog.sh](file:///Users/daviscorreia/Antigravity%20/invision-nexus/scripts/kiosk-watchdog.sh) e [scripts/provision-x98-kiosk.sh](file:///Users/daviscorreia/Antigravity%20/invision-nexus/scripts/provision-x98-kiosk.sh)):**
   - **Persistência do ID:** O `hardwareUid`, `pairingCode` e estado de emparelhamento ficam gravados no `localStorage` do Chrome na Box e no `live_state.json` do NAS (com fallback determinístico para o `android_id` físico da motherboard da Box via `?hw_uid=X98-...`).
   - **Auto-Boot Watchdog (`scripts/kiosk-watchdog.sh`):** Configurado `persist.adb.tcp.port=5555` na Box e criado o serviço `kiosk-watchdog.sh` que corre em background no NAS, verificando a cada 25 segundos se alguma Box registada reiniciou para o menu Home do Android e relançando automaticamente o Chrome em Fullscreen no URL do Player.

---

## [2026-11-15] - Fix de Separador em Branco no Chrome Android (`hostname -I` / `clear-debug-app`) & Provisionamento ADB Direto pelo Backoffice

### Problemas Resolvidos e Evoluções
1. **Fix do Separador sem Endereço no Chrome da Box Android:**
   - *Causa 1:* No Synology DSM (BusyBox), o comando `hostname -I` não é suportado e devolvia uma string vazia `""`, gerando o URL inválido `http://:5174`.
   - *Causa 2:* O comando `am set-debug-app --persistent com.android.chrome` com `/data/local/tmp/chrome-command-line` no Chrome Android sobrepunha o URL do Intent e abria uma tab em branco (`about:blank`).
   - *Solução:* Substituído `hostname -I` por deteção via `ip -4 route get 1.1.1.1` / `ip -4 addr show` (com fallback `192.168.68.117`) em [scripts/provision-x98-kiosk.sh](file:///Users/daviscorreia/Antigravity%20/invision-nexus/scripts/provision-x98-kiosk.sh) e [scripts/update-nas.sh](file:///Users/daviscorreia/Antigravity%20/invision-nexus/scripts/update-nas.sh), e adicionado `am clear-debug-app` + `rm -f /data/local/tmp/chrome-command-line` antes de lançar o Intent `VIEW` com o URL limpo.
2. **Provisionamento Kiosk ADB & Watchdog 24/7 Integrados no Backoffice (`http://192.168.68.117:4322/`):**
   - Instalado o pacote nativo `android-tools` (`adb`) dentro do contentor `invision_backend` ([backend/Dockerfile](file:///Users/daviscorreia/Antigravity%20/invision-nexus/backend/Dockerfile)) com chaves RSA persistidas em `/app/data/storage/.android`.
   - Adicionados os endpoints `POST /api/v1/live/adb/provision` e `POST /api/v1/live/adb/action` e o ciclo Watchdog de 25s diretamente no [backend/live-bridge.mjs](file:///Users/daviscorreia/Antigravity%20/invision-nexus/backend/live-bridge.mjs).
   - Adicionado painel visual **"📺 Provisionamento Kiosk ADB & Auto-Boot Watchdog"** na página principal do Dashboard ([dashboard/src/pages/index.astro](file:///Users/daviscorreia/Antigravity%20/invision-nexus/dashboard/src/pages/index.astro)), permitindo provisionar novas Boxes Android, relançar o URL, forçar Fullscreen ou fazer Reboot remoto diretamente pelo navegador sem precisar de SSH/Bash.

---

## [2026-11-15] - Self-Healing Video Watchdog (Prevenção de Ecrã Preto), Supressão da Barra de Tradução Chrome, Single-Tab Reuse & Auto-Boot Pós-Reboot

### Problemas Identificados nos Testes Físicos na Box X98 Plus e Soluções Implementadas
1. **Playlist parou num ecrã preto após o toque automático de Fullscreen / transição de vídeo:**
   - *Causa:* O bloco `{#key}` recriava um novo elemento `<video>` a cada slot (podendo esgotar as instâncias `MediaCodec` de hardware da Box X98 Plus) e, quando o Chrome entrava em modo Fullscreen (ou após o toque ADB), podia pausar o `<video>`. Como o `playbackTimer` ignorava `mediaType === 'VIDEO'`, um vídeo pausado ou estagnado nunca disparava `on:ended`.
   - *Solução ([player/src/App.svelte](file:///Users/daviscorreia/Antigravity%20/invision-nexus/player/src/App.svelte)):* Removido o `{#key}` para reutilizar sempre a mesma instância `<video>` e adicionado um **Self-Healing Video Watchdog** no `playbackTimer`: se o vídeo ficar pausado (`videoElement.paused && !videoElement.ended`), retoma automaticamente (`.play()`), e se exceder a duração esperada + `2.5s`, avança automaticamente (`advanceSlotGapless()`).
2. **Abertura de Nova Tab ao clicar em "Abrir URL Player":**
   - *Solução ([backend/live-bridge.mjs](file:///Users/daviscorreia/Antigravity%20/invision-nexus/backend/live-bridge.mjs) e [scripts/provision-x98-kiosk.sh](file:///Users/daviscorreia/Antigravity%20/invision-nexus/scripts/provision-x98-kiosk.sh)):* Adicionadas as flags Android Intent `-f 0x14000000 --es com.android.browser.application_id com.invision.nexus.kiosk --ez create_new_tab false` para reutilizar sempre a mesma Tab única no Chrome.
3. **Barra Inferior de Tradução de Idioma do Google Chrome:**
   - *Solução ([player/index.html](file:///Users/daviscorreia/Antigravity%20/invision-nexus/player/index.html) e [dashboard/src/layouts/DashboardLayout.astro](file:///Users/daviscorreia/Antigravity%20/invision-nexus/dashboard/src/layouts/DashboardLayout.astro)):* Adicionados `translate="no" class="notranslate"` nas tags `<html>` e `<body>` e `<meta name="google" content="notranslate" />`, desativando permanentemente o popup de tradução do Chrome.
4. **Auto-Arranque do Browser após Reiniciar Box (`Reiniciar Box`):**
   - *Causa:* No Android 11+ da Box X98 Plus, o comando `dumpsys window windows` produzia >1 MB de texto e excedia o buffer do `execFile`, devolvendo string vazia e impedindo o Watchdog de detetar que a Box estava no Desktop do Android.
   - *Solução ([backend/live-bridge.mjs](file:///Users/daviscorreia/Antigravity%20/invision-nexus/backend/live-bridge.mjs) e [scripts/kiosk-watchdog.sh](file:///Users/daviscorreia/Antigravity%20/invision-nexus/scripts/kiosk-watchdog.sh)):* O Watchdog corre agora a cada **12 segundos**, verifica `getprop sys.boot_completed == 1` e executa uma consulta leve (`dumpsys activity activities | grep -iE "ResumedActivity|mFocusedApp"` + `pidof com.android.chrome`). Se o Chrome não estiver em primeiro plano após o reboot, abre automaticamente o Player em Fullscreen!
5. **Eliminação do Bloqueio de Rede / Socket Pool (6-Socket HTTP/1.1 Limit) após Vários Loops da Playlist:**
   - *Diagnóstico Exato:* Na versão anterior em execução na Box antes desta atualização, após **2 loops de 3 vídeos** (`2 × 3 = 6` streams), o Chrome atingia o limite de **6 ligações TCP simultâneas por origem (`:3000`)** porque os elementos `<video>` criados pelo antigo `{#key}` e os `fs.createReadStream` de HTTP 206 no servidor não fechavam imediatamente os *file descriptors* / *sockets*, deixando o ecrã preto no 3.º loop (e disparando `on:error={advanceSlotGapless}`, o que também inflacionava artificialmente o contador de Proof of Play).
   - *Solução Definitiva ([player/src/App.svelte](file:///Users/daviscorreia/Antigravity%20/invision-nexus/player/src/App.svelte) e [backend/live-bridge.mjs](file:///Users/daviscorreia/Antigravity%20/invision-nexus/backend/live-bridge.mjs)):*
     1. **Local RAM Blob Preloader (`preloadMediaBlobs` / `URL.createObjectURL`):** Assim que a Playlist é carregada, o Player descarrega os vídeos e imagens uma única vez para a memória local da Box (`blob:http://...`). A partir do 2.º loop, a reprodução é **100% local a partir da RAM da Box**, com **zero** pedidos HTTP Range ao NAS!
     2. **Fecho Estrito de Streams no Servidor (`stream.destroy()`):** No endpoint `GET /api/v1/media/:id/stream` do [backend/live-bridge.mjs](file:///Users/daviscorreia/Antigravity%20/invision-nexus/backend/live-bridge.mjs), qualquer fecho de socket (`req.on('close')`, `res.on('close')`, `res.on('error')`) destrói imediatamente o `fs.createReadStream`.
     3. **Isolamento de Erros (`handleMediaError`):** Os eventos `on:error` deixaram de chamar `advanceSlotGapless`, garantindo que uma falha de rede nunca regista um Proof of Play falso.

---

## [2026-11-15] - Arquitetura Modular do Backoffice: Visão Global Executiva (Mapa + Compliance), Módulo de Equipamentos (`/devices/`) & Biblioteca de Conteúdos com Smart TAGs (`/content/`)

### Decisões Arquiteturais & Operacionais Consolidadas
1. **Separação Modular do Backoffice ([dashboard/src/layouts/DashboardLayout.astro](file:///Users/daviscorreia/Antigravity%20/invision-nexus/dashboard/src/layouts/DashboardLayout.astro)):**
   - Para manter o Backoffice limpo, rápido e escalável rumo a um verdadeiro **"Controlo Central de Operações — Digital In-Store Customer Experience"**, a navegação lateral foi estruturada em **6 módulos independentes** (+ placeholder visível para a futura Fase 6 de Catálogo SKU & Preços):
     1. **`🏠 Visão Global (Home)`** (`/`)
     2. **`🖥️ Equipamentos (Parque IT)`** (`/devices/`)
     3. **`🎬 Conteúdos & Media (Smart TAGs)`** (`/content/`)
     4. **`🎞️ Playlists (Slots & SoV)`** (`/playlists/`)
     5. **`🏪 Lojas & Live Wall`** (`/store-wall/`)
     6. **`📊 Relatórios & Proof of Play`** (`/telemetry/`)
2. **Nova `Visão Global` Executiva & Mapa de Saúde da Rede ([dashboard/src/pages/index.astro](file:///Users/daviscorreia/Antigravity%20/invision-nexus/dashboard/src/pages/index.astro)):**
   - **Faixa de Resumo por Tipologia com Drill-Down Direto:** 5 cartões com contagem por categoria (`📺 Smart TVs & Demo`, `💻 Laptops Exposição`, `📱 Smartphones Expo`, `📟 Tablets Expo`, `🖥️ Boxes X98 & LEDwalls`) que ao clicar encaminham diretamente para `/devices/?category=...`.
   - **5 KPIs Executivos:** *Lojas Ativas*, *Total Equipamentos*, *Interações & Plays (PoP)*, *Compliance de Programação (%)* e *Conectados Online (%)*.
   - **Mapa Interativo Colapsável (Leaflet + CartoDB Dark Matter):** Sem marcas de água e sem necessidade de chave paga, com pins semafóricos (🟢 `>=75%`, 🟡 `25-75%`, 🔴 `<=25%`), alternância entre *Conectividade (%)* e *Compliance de Programação (%)* e popup de drill-down por loja.
   - **Tabela de Compliance por Loja:** Com pesquisa instantânea, filtros por país/saúde, exportação CSV e *drill-down* direto para `/devices/?store=...` ao clicar em qualquer loja.
3. **Novo Módulo Dedicado `Gestão e Controlo de Parque Informático & Equipamentos` ([dashboard/src/pages/devices.astro](file:///Users/daviscorreia/Antigravity%20/invision-nexus/dashboard/src/pages/devices.astro)):**
   - Isola toda a operação técnica (Inventário Real-Time LAN/Heartbeat, Provisionamento Kiosk ADB & Auto-Boot Watchdog das Boxes Android X98 Plus, Comandos Remotos *Abrir URL / Fullscreen / Reboot*, e Emparelhamento Zero-Touch de 6 dígitos), suportando filtros automáticos vindos do *drill-down* da Visão Global (`?store=...&category=...`).
4. **Novo Módulo Dedicado `Biblioteca de Conteúdos & Media` com Motor de Smart TAGs ([dashboard/src/pages/content.astro](file:///Users/daviscorreia/Antigravity%20/invision-nexus/dashboard/src/pages/content.astro), [dashboard/src/pages/playlists.astro](file:///Users/daviscorreia/Antigravity%20/invision-nexus/dashboard/src/pages/playlists.astro) e [backend/live-bridge.mjs](file:///Users/daviscorreia/Antigravity%20/invision-nexus/backend/live-bridge.mjs)):**
   - Separa o upload e curadoria de ficheiros da gestão de Playlists.
   - **Auto-Binding por Smart TAGs (`syncPlaylistsByTags`):** Ao fazer upload de um vídeo/imagem com TAGs (ex: `NATAL, CREDITO, FLASH_SALE`) ou ao editar as TAGs de um conteúdo existente (`PUT /api/v1/live/media/:id/tags`), o backend associa-o **automaticamente** a todas as Playlists que tenham essas mesmas `autoTags` configuradas, mantendo também a possibilidade de adição/remoção manual e ajuste de *Share of Voice (%)*.
5. **Módulo de Tema "Dia e Noite" (Manual + Automático por Horário) ([dashboard/src/layouts/DashboardLayout.astro](file:///Users/daviscorreia/Antigravity%20/invision-nexus/dashboard/src/layouts/DashboardLayout.astro) e [dashboard/src/pages/index.astro](file:///Users/daviscorreia/Antigravity%20/invision-nexus/dashboard/src/pages/index.astro)):**
   - Adicionado seletor global na barra superior do Backoffice com **3 modos**: `☀️ Dia` (Light Mode), `🌙 Noite` (Dark Mode) e `🔄 Auto` (muda automaticamente para **Dia** entre as `07:00` e as `19:59`, e para **Noite** entre as `20:00` e as `06:59`, reavaliando a cada 60 segundos).
   - O Mapa Interativo de Lojas (`Leaflet`) sincroniza em tempo real com o tema ativo, alternando automaticamente entre o mapa claro (`CartoDB Light`) durante o dia e o mapa escuro (`CartoDB Dark Matter`) durante a noite.

---

## [2026-11-15] - Módulo de Configurações & Setup de Sistema (`/settings/`): Limpeza de Dados Demo, Lojas com Região & Sub-rede IP, Importação CSV e Inversão de Ecrã 180°

### Novas Funcionalidades & Arquitetura de Master Data
1. **Pop-up Automático de Transição para Dados Reais (`PURGE_DEMO_DATA`):**
   - Sempre que um utilizador acede a **`⚙️ Configurações & Setup`** ([dashboard/src/pages/settings.astro](file:///Users/daviscorreia/Antigravity%20/invision-nexus/dashboard/src/pages/settings.astro)) enquanto existirem lojas de demonstração ativas, o sistema apresenta um modal de confirmação perguntando se deseja **apagar os Dados de Simulação** e entrar em **Modo de Produção Real Estrito** (preservando os equipamentos reais ligados na LAN, as Boxes Android no Watchdog ADB e os vídeos carregados). Inclui também botão para restaurar dados de simulação caso necessário.
2. **Catálogo de Lojas com Região, Auto-Deteção por Gateway/Sub-rede IP e Importação em Lote (CSV):**
   - Cada Loja em `storesCatalog` inclui agora **`region`** (ex: *Grande Lisboa*, *Grande Porto*, *Algarve*, *Centro*, *Île-de-France*) e **`gatewaySubnet`** (ex: `192.168.68.` ou `10.20.1.0/24`).
   - **Auto-Deteção de Loja por IP (`matchStoreByClientIp` em [backend/live-bridge.mjs](file:///Users/daviscorreia/Antigravity%20/invision-nexus/backend/live-bridge.mjs)):** Quando uma Box Android ou Player comunica via Heartbeat, o backend compara automaticamente o IP do equipamento com a sub-rede/gateway das lojas registadas e atribui-o à Loja correspondente sem intervenção manual.
   - **Importação Rápida CSV / Lote (`BULK_IMPORT_STORES`):** Permite colar dezenas de lojas de uma só vez a partir do Excel (`Codigo;Insignia;Pais;Regiao;Cidade;Nome;Gateway;Lat;Lng`), além do formulário visual individual.
3. **Formatos de Ecrã (`1920x1080`, `1080x1920`, `3840x1080`) & Inversão 180° ("Pernas para o ar"):**
   - Suporte nativo para perfis de ecrã (`screenProfilesCatalog`) e **Inversão de Ecrã 180° (`invert180`)** em [player/src/App.svelte](file:///Users/daviscorreia/Antigravity%20/invision-nexus/player/src/App.svelte) (`.player-root.invert-180 { transform: rotate(180deg); }`), pensado especificamente para painéis LED/LCD montados de cabeça para baixo pelos instaladores.
   - Pode ser ativado/desativado **em tempo real num único clique** diretamente no cartão de cada equipamento em **`🖥️ Equipamentos`** ([dashboard/src/pages/devices.astro](file:///Users/daviscorreia/Antigravity%20/invision-nexus/dashboard/src/pages/devices.astro) via `POST /api/v1/live/devices/invert`), como predefinição de um Formato em **`⚙️ Configurações & Setup`**, ou localmente no menu secreto OSD do Player.
4. **Áreas / Zonas de Loja & Tipologias de Equipamento Dinâmicas:**
   - Todos os seletores de Loja, Zona/Departamento, Formato de Ecrã e Tipologia de Equipamento em `/devices/` e `/playlists/` passam a ser alimentados dinamicamente pelos catálogos configurados em `/settings/`.

---

## [2026-11-15] - Otimização UI/UX: Switch Estrito FNAC / DARTY, Janelas Pop-up (Modais) em Equipamentos e Precedência em Configurações

### Decisões de Arquitetura e Ajustes de Janelas Implementados
1. **Isolamento Estrito por Insígnia (`FNAC` vs `DARTY`) sem Modo Misto "GLOBAL":**
   - Removida a opção `"GLOBAL"` do seletor de marca no menu lateral ([dashboard/src/layouts/DashboardLayout.astro](file:///Users/daviscorreia/Antigravity%20/invision-nexus/dashboard/src/layouts/DashboardLayout.astro)), ficando apenas o alternador direto `[ 🟨 FNAC ]` ou `[ 🟥 DARTY ]`.
   - Todos os módulos do Backoffice (`Visão Global /`, `Equipamentos /devices/`, `Conteúdos /content/`, `Playlists /playlists/`, `Live Wall /store-wall/`, `Relatórios /telemetry/` e `Configurações /settings/`) filtram 100% dos dados pela marca ativa e reagem instantaneamente ao evento `invision:brand-change`.
2. **Otimização do Módulo de Equipamentos ([dashboard/src/pages/devices.astro](file:///Users/daviscorreia/Antigravity%20/invision-nexus/dashboard/src/pages/devices.astro)):**
   - **Remoção de Elementos Redundantes:** Retirado o botão `"← Voltar à Visão Global"` e removida a coluna lateral de precedência de prioridades.
   - **Inventário em Full-Width:** A lista de equipamentos reais ativos passa a ocupar 100% da largura horizontal, garantindo máxima legibilidade para centenas de equipamentos.
   - **Pop-up de Configuração / Emparelhamento (`#pairing-modal`):** Clicar em `"✎ Configurar"` ou no novo botão `"+ Emparelhar Terminal"` abre uma janela modal centrada no ecrã com os campos de código, nome, loja, zona, categoria, formato e inversão 180°, sem empurrar a lista para baixo.
   - **Pop-up de Provisionamento Kiosk ADB (`#adb-modal`):** A ferramenta técnica de ligação ADB e controlo de boxes (reboot, fullscreen, URL) foi encapsulada numa janela modal acionada pelo botão `"📺 Provisionamento ADB & Watchdog"`, com contador dinâmico de boxes monitorizadas.
   - **Alinhamento e Hierarquia Visual:** Os botões de ação (`+ Emparelhar Terminal` e `Provisionamento ADB`) ficam agora perfeitamente alinhados à direita na barra superior, e o resumo de rede (`X/Y Terminais (FNAC) na LAN`) foi integrado diretamente no cabeçalho do Inventário Real-Time, no ponto oposto ao título.
3. **Transferência da Precedência de Programação para `⚙️ Configurações & Setup` ([dashboard/src/pages/settings.astro](file:///Users/daviscorreia/Antigravity%20/invision-nexus/dashboard/src/pages/settings.astro)):**
   - Adicionada a nova aba **`⚖️ 5. Precedência & Regras de Playlists`**, centralizando a explicação e auditoria em tempo real dos 4 níveis de prioridade (`EXCLUSIVA > PRIORITÁRIA > NORMAL > FALLBACK`), contagem de playlists ativas por nível na marca selecionada, regras do Guardrail de Formato, RAM Blob Caching e Auto-Binding de TAGs.
4. **Otimização da Biblioteca de Conteúdos & Media ([dashboard/src/pages/content.astro](file:///Users/daviscorreia/Antigravity%20/invision-nexus/dashboard/src/pages/content.astro)):**
   - **Remoção de Atalho Redundante:** Retirado o botão `"Ir para Playlists & Prioridades"` da caixa de upload.
   - **Duração Padrão Atualizada:** Ajustada a duração por defeito de imagens/vídeos de 8s para **10 segundos** (`value="10"`).
   - **Alinhamento à Direita:** Os controlos de pesquisa de título/TAG e o seletor de TAGs foram alinhados à direita no cabeçalho do catálogo.
   - **Novo Modo de Visualização em Lista Enterprise:** Criado o alternador `[ 📋 Lista ]` e `[ 🎴 Cartões ]` (com persistência no `localStorage`). O modo lista apresenta uma tabela compacta de alta densidade (Prévia, Título, Formato/Resolução, Duração, TAGs, Playlists e Ações).
   - **Janela Pop-up de Detalhes (`#media-detail-modal`):** Clicar em qualquer linha da lista ou no botão `"✎ Detalhes"` abre um modal completo com leitor de pré-visualização grande, metadados técnicos (resolução, rácio, duração), editor de Smart TAGs com feedback visual e seletor de inserção direta em Playlists.

---

## [2026-11-16] - Correção Crítica no Módulo de Playlists (`/playlists/`): Resolução de SyntaxError e Blindagem de Renderização

### Causa Raiz do Bug Identificada
- **`SyntaxError: Identifier 'activeBrand' has already been declared`:** No ficheiro [dashboard/src/pages/playlists.astro](file:///Users/daviscorreia/Antigravity%20/invision-nexus/dashboard/src/pages/playlists.astro), a variável `activeBrand` estava a ser declarada com `const` duas vezes no mesmo âmbito da função `renderAll()` (na linha 351 para filtragem de playlists e na linha 636 para filtragem do catálogo). Em JavaScript moderno, uma redeclaração com `const` no mesmo bloco impede o motor V8 do browser de compilar o script, abortando a execução antes de qualquer linha de JavaScript ser executada.
- Consequentemente, o banner ficava permanentemente preso no estado HTML estático inicial (*"A calcular Playlist Dominante..."*), as abas de playlists não eram geradas e a grelha de slots e catálogo de media ficavam vazios.

### Correções Implementadas
1. **Eliminação do Conflito de Variáveis:** Removida a redeclaração redundante de `activeBrand` na secção de catálogo de `renderAll()`.
2. **Blindagem Contra Estado Nulo (`currentPl = null`):** Adicionado bloco `else` defensivo na verificação de `if (currentPl)`, limpando os formulários e apresentando uma mensagem amigável caso não existam playlists configuradas para a marca ativa em vez de gerar erros de propriedades nulas.
3. **Resiliência a Playlists Globais / Legadas:** Atualizado o filtro de marca em `getSelectedPlaylist()` e `renderAll()` para `!p.brand || p.brand === activeBrand || p.brand === 'ALL'`, garantindo que playlists legadas ou partilhadas não são ocultadas inadvertidamente.
4. **Tratamento de Exceções com `try/catch`:** O carregamento do estado via `fetchLiveState()` foi encapsulado em bloco `try/catch` para evitar paragens silenciosas em caso de quebra temporária de rede.
5. **Limpeza de Código Morto:** Removidos *event listeners* residuais de upload no módulo de playlists, uma vez que o envio de novos ficheiros é agora gerido de forma dedicada pelo módulo `Conteúdos & Media` (`/content/`).

---

## [2026-11-16] - Implementação de Cibersegurança, Hardening de Infraestrutura & SSO Microsoft Entra ID (Passos 1 e 2)

### Contexto & Requisitos de Segurança
- Operação em ambiente de retalho (FNAC e DARTY) com ecrãs e dispositivos em bancadas de loja, exigindo proteção contra *defacement*, sequestro de ecrãs (*ransomware*), injeção de ficheiros maliciosos e intrusão na rede de loja.
- Infraestrutura corporativa confirmada: VLAN Wi-Fi dedicada e reservada para Sinalética Digital, hardware protegido atrás dos displays, hosting privado corporativo (sem exposição à internet pública) e federação de utilizadores via **Microsoft Entra ID (Office 365 SSO)**.

### Implementações Realizadas (Passo 1: Infraestrutura & Passo 2: Autenticação)
1. **Blindagem de Infraestrutura Docker no Synology NAS ([docker-compose.yml](file:///Users/daviscorreia/Antigravity%20/invision-nexus/docker-compose.yml) e [scripts/update-nas.sh](file:///Users/daviscorreia/Antigravity%20/invision-nexus/scripts/update-nas.sh)):**
   - Mapeamento das portas do **PostgreSQL 16 (`5434`)** e do **Redis 7 (`6380`)** restrito exclusivamente a `127.0.0.1` (loopback local do NAS). As bases de dados deixam de estar acessíveis a quaisquer outros dispositivos da rede local/LAN.
   - Comunicação inter-contentores mantida de forma segura e direta via rede bridge interna Docker (`nexus-network`).
2. **Validador de Assinatura Binária Real (*Magic Bytes Guardrail*) ([backend/live-bridge.mjs](file:///Users/daviscorreia/Antigravity%20/invision-nexus/backend/live-bridge.mjs)):**
   - Inspeciona os primeiros bytes binários de cada upload antes de gravar no disco, garantindo que o ficheiro é estritamente um formato multimédia seguro (MP4/MOV com `ftyp`/`moov`/`mdat`, WebM com `0x1A45DFA3`, JPEG `0xFFD8FF`, PNG `0x89504E47` ou WebP).
   - Bloqueia e elimina imediatamente ficheiros disfarçados (executáveis, PHP, scripts shell) com erro HTTP 415 (`FILE_GUARDRAIL_BLOCKED`) e alerta no trilho de auditoria.
3. **Identidade Criptográfica de Hardware (*Hardware Device Tokens*) ([backend/live-bridge.mjs](file:///Users/daviscorreia/Antigravity%20/invision-nexus/backend/live-bridge.mjs) e [player/src/App.svelte](file:///Users/daviscorreia/Antigravity%20/invision-nexus/player/src/App.svelte)):**
   - Ao emparelhar um terminal (`NX-XXXXXX`), o backend gera uma chave secreta de hardware (`deviceToken` de 48 caracteres hexadecimais em CSPRNG).
   - O Edge Player PWA armazena o token e envia-o no cabeçalho `X-Device-Token` em todos os *heartbeats*. O servidor valida a correspondência e rejeita dispositivos impostores ou forjados com erro HTTP 401 (`UNAUTHORIZED_DEVICE`).
4. **Motor de Autenticação Híbrido: Microsoft Entra ID (SSO) + Break-Glass Local ([backend/live-bridge.mjs](file:///Users/daviscorreia/Antigravity%20/invision-nexus/backend/live-bridge.mjs)):**
   - **SSO Microsoft Entra ID (OIDC / OAuth2):** Endpoints `/api/v1/auth/microsoft/login` e `/api/v1/auth/microsoft/callback` preparados para federação com o Office 365 da Fnac Darty com mapeamento de grupos de segurança (`SG_FNAC_*`) para os perfis RBAC do Invision Nexus.
   - **Acesso Local de Contingência ("Break-Glass"):** Conta de emergência `admin` com palavras-passe protegidas por PBKDF2 com HMAC-SHA512 (100.000 iterações), permitindo operação no NAS sem dependência de internet.
   - **Sessões no Servidor:** Emissão de cookies assinadas `invision_session` (`HttpOnly, SameSite=Lax, Max-Age=86400`) e endpoint de inspeção `/api/v1/auth/me`.
5. **Portal de Login Corporativo Dedicado ([dashboard/src/pages/login.astro](file:///Users/daviscorreia/Antigravity%20/invision-nexus/dashboard/src/pages/login.astro)):**
   - Novo ecrã corporativo com botão direto *"Iniciar Sessão com Conta Fnac Darty (Office 365)"*, formulário de contingência local break-glass e painel de indicadores de segurança ativos.
6. **Sub-módulo de Cibersegurança & Trilho de Auditoria em Tempo Real ([dashboard/src/pages/settings.astro](file:///Users/daviscorreia/Antigravity%20/invision-nexus/dashboard/src/pages/settings.astro)):**
   - Ativada a aba **`🛡️ 6. Segurança, Controlo de Acessos & SSO Microsoft Entra ID`** em `/settings/`.
   - Inclui Painel de Hardening em Camadas, painel de configuração e credenciais para a equipa de TI da Fnac Darty, tabela de utilizadores locais e Tabela de Auditoria em tempo real (*Audit Trail* para conformidade NIS2 e RGPD).
7. **Documento Técnico de Referência ([docs/05-cybersecurity-hardening.md](file:///Users/daviscorreia/Antigravity%20/invision-nexus/docs/05-cybersecurity-hardening.md)):**
   - Criado manual completo de cibersegurança com modelação de ameaças, descrição dos 5 pilares de segurança, guia de registo de aplicação no Microsoft Entra e playbook de resposta a incidentes.

---

## [2026-11-16] - Implementação de Cibersegurança: Passo 3 (Anti-Defacement, Assinatura HMAC-SHA256 & Fail-Safe Kiosk)

### Contexto & Desafio de Segurança
- Proteção dos ecrãs físicos em bancadas de loja (FNAC & DARTY) contra ataques de **Man-in-the-Middle (MITM)** e adulteração de playlists na rede Wi-Fi/VLAN.
- Garantia de **resiliência total sem ecrã preto (*Zero Black Screen*)**: se a rede cair ou o manifesto for adulterado, o ecrã deve manter a emissão do cache local sem nunca exibir a área de trabalho do Android ou mensagens de erro aos clientes.

### Implementações Realizadas
1. **Assinatura Criptográfica de Manifestos no Servidor ([backend/live-bridge.mjs](file:///Users/daviscorreia/Antigravity%20/invision-nexus/backend/live-bridge.mjs)):**
   - Implementado o gerador de assinaturas digitais determinísticas utilizando o algoritmo **HMAC-SHA256** (`generateManifestSignature`).
   - A assinatura cobre o ID da playlist, insígnia, prioridade, modo de agendamento e o resumo ordenado de todos os ficheiros (`id:streamUrl:durationMs`).
   - Cada manifesto emitido via *heartbeat* ou WebSocket transporta `manifestSignature`, `signatureAlgorithm` e `signatureTimestamp`.
2. **Validação Criptográfica Nativa no Player ([player/src/lib/cryptoSign.ts](file:///Users/daviscorreia/Antigravity%20/invision-nexus/player/src/lib/cryptoSign.ts) e [player/src/App.svelte](file:///Users/daviscorreia/Antigravity%20/invision-nexus/player/src/App.svelte)):**
   - Validação matemática de integridade via **W3C Web Cryptography API** (`window.crypto.subtle`).
   - **Bloqueio Anti-Defacement:** Se a assinatura não coincidir (adulteração de conteúdo ou ataque MITM), o Player rejeita 100% do pacote recebido, mantém o cache local seguro e notifica de imediato o backend via `POST /api/v1/live/security/tamper-alert`.
3. **Modo Fail-Safe Resiliente & Cache Offline:**
   - O Player persiste automaticamente o último manifesto seguro em `localStorage` (`invision_verified_manifest`).
   - No arranque (*boot*), o Player hidrata-se imediatamente da cache antes mesmo de contactar a rede, garantindo arranque instantâneo mesmo sem ligação à Internet.
4. **Kiosk Lockout & Content Security Policy ([player/index.html](file:///Users/daviscorreia/Antigravity%20/invision-nexus/player/index.html)):**
   - Configurada política **CSP (Content-Security-Policy)** estrita, impedindo injeção de scripts externos.
   - Bloqueio de menus de contexto (`contextmenu`), atalhos de depuração (`F12`, `Ctrl+Shift+I`) e toques prolongados em ecrãs táteis.
   - Substituição do ecrã de arranque por uma animação institucional elegante com logo corporativo, sem traces de erro expostos ao público de loja.
5. **Gestão de Alertas de Segurança no Dashboard ([dashboard/src/pages/devices.astro](file:///Users/daviscorreia/Antigravity%20/invision-nexus/dashboard/src/pages/devices.astro) e [dashboard/src/pages/settings.astro](file:///Users/daviscorreia/Antigravity%20/invision-nexus/dashboard/src/pages/settings.astro)):**
   - Sinalização de terminais com alerta de intrusão/MITM com badge vermelha a pulsar (`🚨 ALERTA MITM / ASSINATURA INVÁLIDA`).
   - Botão para operadores autorizados reconhecerem e reporem o alerta (`🛡️ Repor Alerta`), comunicando com `POST /api/v1/live/security/reset-alert` e registando o evento no Audit Trail.
   - Cartões de Hardening em Configurações atualizados para refletir os 5 pilares ativos de segurança.

---

## [2026-11-16] - Implementação de Telemetria Comercial, Proof of Play (PoP) & Auditoria de Share of Voice (SoV)

### Contexto & Requisitos de Retalho Comercial
- Em ambiente de retalho (FNAC e DARTY), as marcas de tecnologia (Samsung, Apple, Sony, Dyson, LG, Philips, Whirlpool, etc.) negoceiam e contratam percentagens estritas de tempo de antena (*Share of Voice / SoV*) nas bancadas de loja e ecrãs LED.
- É imperativo fornecer uma ferramenta de **Auditoria Comercial e Proof of Play** rigorosa, que permita validar o cumprimento do contrato publicitário (*SLA*) e exportar relatórios certificados para faturação.

### Implementações Realizadas
1. **Motor de Deteção de Parceiros Comerciais & Fita Forense ([backend/live-bridge.mjs](file:///Users/daviscorreia/Antigravity%20/invision-nexus/backend/live-bridge.mjs)):**
   - Criada a função `resolveCommercialPartner` que classifica automaticamente cada reprodução pelo título e TAGs de campanha (Samsung, Apple, Sony, Dyson, LG, Philips, Whirlpool, DeLonghi, FNAC Editorial, DARTY Editorial).
   - O endpoint `POST /api/v1/live/telemetry` enriquece cada registo com a loja (`storeName`), zona de bancada (`zone`), parceiro comercial, SoV contratado e terminal responsável.
   - Criado o anel de auditoria forense `popAuditLogs` (últimas 500 exibições validadas) com registo do hash criptográfico SHA-256 de cada ficheiro exibido.
2. **Dashboard de Telemetria Comercial & Proof of Play ([dashboard/src/pages/telemetry.astro](file:///Users/daviscorreia/Antigravity%20/invision-nexus/dashboard/src/pages/telemetry.astro)):**
   - **4 Cartões de KPIs Comerciais:** Total de Exibições (Plays), Tempo de Antena Total (Horas/Minutos/Segundos), Cumprimento Médio de SoV (%) e Parceiro Líder em Loja (% do ar total).
   - **Barra de Filtros Dinâmicos:** Filtro por Loja (Colombo, Chiado, NorteShopping, Montparnasse, etc.), Filtro por Parceiro Comercial e Filtro de Período, com sincronização em tempo real à insígnia ativa (`FNAC` vs `DARTY`).
   - **Matriz de Cumprimento de Share of Voice (SoV):** Tabela comercial comparando SoV Contratado (%) vs SoV Entregue (%), com barra de progresso de conformidade SLA (`🟢 APROVADO`, `🟡 EM CURSO`, `⚠️ EM DÉFICE`) e estado de faturação.
   - **Fita Forense de Proof of Play:** Tabela cronológica em tempo real com data/hora, loja, terminal, parceiro, título do anúncio, duração e hash SHA-256.
   - **Interatividades em Bancada:** Registo de toques e envolvimento em smartphones/portáteis (`IDLE_SCREENSAVER`) e seleção de categorias em televisores (`TV_DEMO`).
3. **Exportação & Certificado Oficial em PDF / Impressão:**
   - Botão **"Exportar Auditoria PoP (CSV)"** para auditoria detalhada de conformidade.
   - Botão **"Exportar Resumo SoV (CSV)"** para processamento financeiro e faturação comercial.
   - Botão **"Certificado PDF"**: Gera um layout formal de impressão A4 (*Certificado Oficial de Exibição Publicitária*) com identidade corporativa FNAC DARTY, resumo de exibições e linhas de assinatura para Diretor de Loja e Auditor Multimédia.
