# Manual 01: Configuração e Arranque no Synology DS220+ (Container Manager / Docker)

Este manual descreve como alojar a infraestrutura de Backend e Base de Dados da plataforma **Invision Nexus** num NAS **Synology DS220+** (DSM 7.2+) e como efetuar futura migração (*lift-and-shift*) para o servidor dedicado de Produção.

---

## 1. Requisitos e Otimização de Memória (Synology DS220+)

O `docker-compose.yml` na raiz do projeto foi desenhado com limites estritos de memória (`mem_limit`) para correr com total fluidez mesmo num Synology DS220+ com **2GB de RAM**:
- **PostgreSQL 16 Alpine:** Limite de `512 MB` (`shared_buffers=128MB`, `synchronous_commit=off` para proteger os discos HDD/SSD do NAS durante a escrita de logs horários de 4.000 dispositivos).
- **Redis 7 Alpine:** Limite de `128 MB` (`maxmemory 96mb`, política `allkeys-lru` para absorver os *heartbeats* a cada 60 segundos em RAM).
- **Backend Node.js 22 + Fastify + FFprobe:** Limite de `384 MB`.

---

## 2. Instalação Inicial via GitHub no Synology NAS

1. Aceda por SSH ao Synology NAS (ou abra o terminal do DSM) e clone o repositório na pasta Docker do NAS:
   ```bash
   cd /volume1/docker
   git clone <URL_DO_TEU_REPOSITORIO_GITHUB> invision-nexus
   cd invision-nexus
   ```
2. Execute o script de arranque e atualização automática:
   ```bash
   bash scripts/update-nas.sh
   ```
   O script cria automaticamente as pastas persistentes (`data/postgres`, `data/redis`, `data/storage/media`, `data/storage/thumbs`), copia `.env.example` para `.env` (se ainda não existir) e sobe os 5 contentores (`invision_postgres`, `invision_redis`, `invision_backend`, `invision_dashboard`, `invision_player`).

---

## 3. Fluxo Contínuo de Atualização (Mac -> GitHub -> Synology NAS)

Sempre que existirem evoluções no desenvolvimento:

1. **No Mac (enviar alterações para o GitHub):**
   ```bash
   bash scripts/git-sync.sh "Descrição da evolução"
   ```
2. **No Synology NAS (puxar do GitHub e atualizar os contentores sem perder vídeos/playlists):**
   ```bash
   cd /volume1/docker/invision-nexus
   bash scripts/update-nas.sh
   ```
   *(Dica: Pode também agendar `bash /volume1/docker/invision-nexus/scripts/update-nas.sh` no **Task Scheduler** do Synology DSM para atualizar automaticamente sem precisar de abrir SSH).*

Na primeira execução, o PostgreSQL executa automaticamente o script `backend/sql/001_init_schema.sql`, criando:
- As duas insígnias (`FNAC` e `DARTY`);
- Os 4 Perfis de Ecrã base (`ScreenProfiles`) para o **Format Guardrail**;
- As tabelas particionadas de `pop_logs_hourly` e `interaction_logs_hourly`;
- O utilizador inicial `GLOBAL_ADMIN`:
  - **Email:** `admin@invision-nexus.internal`
  - **Password:** `FnacDarty2026!` *(Alterar imediatamente após o primeiro login).*

---

## 4. Verificação de Saúde da API

Execute no navegador ou terminal:
```bash
curl http://IP_DO_SYNOLOGY:3000/api/v1/health
```
Resposta esperada:
```json
{
  "status": "HEALTHY",
  "service": "invision-nexus-backend",
  "server_time_ms": 1794606000000
}
```

