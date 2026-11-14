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
