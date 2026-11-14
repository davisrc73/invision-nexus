# Invision Nexus — Enterprise Digital Signage & Store Telemetry (Fnac & Darty)

Plataforma corporativa **Offline-First** de Digital Signage, Sincronização Multi-Ecrã ao Milissegundo e Telemetria de Experiência em Loja (**Proof of Play & Touch / TV Demo Analytics**) desenhada para o ecossistema **Fnac & Darty** (~70 lojas, ~4.000 dispositivos).

---

## Arquitetura do Sistema

1. **Control Plane & Live Sync Bridge (`backend/`, Porta `3000`):**
   - Motor de playlists com 4 níveis de precedência (`EXCLUSIVA` > `PRIORITARIA` > `NORMAL` > `FALLBACK`), *Dayparting* e *Share of Voice* dinâmico (`FIXED_SLOTS` e `DYNAMIC_SOV` *Weighted Round-Robin*).
   - Segmentação por equipamento individual (`targetDeviceIds` — todas as boxes ou boxes específicas).
   - Streaming de vídeo HTTP `206 Partial Content`, validação de integridade `SHA-256` e sincronização instantânea por WebSockets RFC 6455 (`/ws/sync`).
   - Esquema PostgreSQL 16 particionado mensalmente (`backend/sql/001_init_schema.sql`) + Redis 7 para *heartbeats* de 60s.
2. **Dashboard Central de Governance (`dashboard/`, Porta `4321`):**
   - Interface **Astro + Tailwind CSS** com *Tenancy Dual-Brand* (`FNAC` / `DARTY` / `GLOBAL`).
   - **Visão Global & Zero-Touch Pairing (`/`)**, **Gestor de Playlists & Upload Real (`/playlists`)**, **Live Store Wall & Incidentes (`/store-wall`)** e **Telemetria Proof of Play & Touch CSV (`/telemetry`)**.
3. **Edge Player PWA Offline-First (`player/`, Porta `5173`):**
   - Compilado para compatibilidade universal **ES2015 / Chrome 61+** (totalmente compatível com **Boxes Android X98 Plus** 4GB RAM / 64GB ROM, LEDwalls, TVs em exposição `TV_DEMO` e bancadas `SMARTPHONE_EXPO` / `LAPTOP_EXPO`).
   - Suporta os 3 modos de operação num único binário (`PASSIVE`, `IDLE_SCREENSAVER` e `INTERACTIVE_CATALOG`) + **Hidden OSD Diagnostic Menu** (5 toques no canto superior esquerdo ou tecla `i` / `F12`).

---

## Fluxo de Trabalho: Mac -> GitHub -> Synology NAS

### 1. Enviar evoluções do Mac para o GitHub
Sempre que existirem evoluções no desenvolvimento:
```bash
bash scripts/git-sync.sh "Descrição da evolução"
```

### 2. Clonar pela primeira vez no Synology NAS (via SSH)
```bash
cd /volume1/docker
git clone <URL_DO_REPOSITORIO_GITHUB> invision-nexus
cd invision-nexus
bash scripts/update-nas.sh
```

### 3. Atualizar o Synology NAS após cada evolução no GitHub
No Synology NAS (por SSH ou agendado no *Task Scheduler* do DSM):
```bash
cd /volume1/docker/invision-nexus
bash scripts/update-nas.sh
```

### 4. Provisionar uma Box Android X98 Plus apontada para o NAS (ou Mac)
```bash
bash scripts/provision-x98-kiosk.sh <IP_DA_BOX_X98_PLUS> http://<IP_DO_NAS>:5173
```

---

## Documentação Técnica (`/docs`)
- [01-arquitetura.md](docs/01-arquitetura.md) — Arquitetura de Sistemas, Rede, Cache Offline e Sincronização.
- [02-database-schema.md](docs/02-database-schema.md) — Modelo Relacional PostgreSQL 16, Particionamento Mensal e RBAC.
- [03-project-log.md](docs/03-project-log.md) — Registo cronológico de todas as decisões e evoluções do projeto.
- [04-manuais/01-setup-synology-docker.md](docs/04-manuais/01-setup-synology-docker.md) — Guia passo-a-passo de instalação e atualização no Synology NAS (`DS220+`).
- [04-manuais/02-manual-governance-dashboard.md](docs/04-manuais/02-manual-governance-dashboard.md) — Manual de operação do Dashboard Central.
- [04-manuais/03-provisionamento-kiosk-x98-sync.md](docs/04-manuais/03-provisionamento-kiosk-x98-sync.md) — Manual de provisionamento Kiosk ADB nas Boxes Android X98 Plus.
