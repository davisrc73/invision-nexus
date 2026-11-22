# Invision Nexus — Manual de Cibersegurança, Hardening & Compliance
> **Plataforma Central de Operações • Digital In-Store Customer Experience (FNAC & DARTY)**  
> **Versão:** 1.0.0 Enterprise • **Data:** Novembro de 2026 • **Classificação:** Documento Técnico de Segurança

---

## 1. Visão Geral & Filosofia de Segurança

A plataforma **Invision Nexus** foi desenhada segundo o princípio **Defense-in-Depth** (Defesa em Camadas) e a filosofia **Zero-Trust**:
1. Nenhum equipamento ou utilizador é considerado de confiança por omissão, mesmo estando na rede local.
2. Todo o tráfego corporativo e de loja é segregado e autenticado por chaves criptográficas.
3. O sistema cumpre os requisitos de rastreabilidade e integridade das diretivas europeias **NIS2** (segurança de redes e informação) e **RGPD** (proteção de dados e registos de acesso).

---

## 2. Modelação de Ameaças em Ambiente de Loja (Threat Modeling)

Em ambientes de retalho físico de grande dimensão (lojas FNAC e DARTY), os ecrãs de sinalética digital e dispositivos de exposição (Smart TVs, Laptops, Tablets e Smartphones) são alvos públicos de grande visibilidade.

| Vetor de Ameaça | Impacto Potencial | Mitigação Implementada no Invision Nexus |
| :--- | :--- | :--- |
| **Defacement / Rogue Takeover** | Exibição de conteúdos inapropriados ou concorrentes nos ecrãs da loja (dano reputacional imediato). | **Magic Bytes Guardrail + RBAC Estrito + Assinatura SHA-256:** Apenas ficheiros com cabeçalhos binários legítimos de vídeo/imagem são aceites e aprovados por utilizadores autenticados. |
| **Impostor Device Injection** | Um atacante na rede simula um terminal para espiar ou alterar o que é exibido. | **Device Tokens Criptográficos (`X-Device-Token`):** Cada Box Android/Player recebe um segredo único de 48 caracteres hexadecimais no emparelhamento, validado em cada *heartbeat*. |
| **Ataques via ADB sobre TCP (Porta 5555)** | Acesso shell remoto não autorizado às Boxes Android X98 Plus na bancada. | **Isolamento em VLAN Reservada:** Equipamentos operam em rede Wi-Fi exclusiva para Sinalética Digital, inacessível ao Wi-Fi público de clientes; hardware fisicamente escondido atrás dos ecrãs. |
| **Exposição da Base de Dados na LAN** | Tentativas de ligação direta ao PostgreSQL ou Redis a partir de outras máquinas da rede. | **Isolamento de Loopback (`127.0.0.1`):** Mapeamento Docker restrito a conexões locais do host; contentores comunicam via rede interna bridge `nexus-network`. |
| **Escalação de Privilégios no Dashboard** | Utilizador tenta alterar o perfil de permissões nas ferramentas de desenvolvimento do browser. | **Sessões HTTP-Only Assinadas no Servidor:** O backend valida a sessão criptográfica em cada pedido administrativo, ignorando valores manipulados no `localStorage`. |

---

## 3. Os 5 Pilares de Segurança Implementados

```
┌────────────────────────────────────────────────────────────────────────┐
│ 1. PERÍMETRO: VLAN Wi-Fi Reservada em Loja + Isolamento Docker 127.0.0.1│
└──────────────────────────────────┬─────────────────────────────────────┘
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 2. IDENTIDADE: Microsoft Entra ID (SSO) + Break-Glass PBKDF2-SHA512   │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 3. HARDWARE: Device Tokens Criptográficos (X-Device-Token 48-Hex)      │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 4. FICHEIROS: Magic Bytes Validator (Anti-Injeção de Executáveis/PHP)  │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 5. AUDITORIA: Trilho Imutável de Eventos Sensíveis (NIS2 / RGPD)       │
└────────────────────────────────────────────────────────────────────────┘
```

### Pilar 1: Isolamento de Infraestrutura no Docker & NAS
- As portas do **PostgreSQL 16 (`5434`)** e do **Redis 7 (`6380`)** no ficheiro `docker-compose.yml` estão mapeadas estritamente para `127.0.0.1`:
  ```yaml
  ports:
    - "127.0.0.1:${POSTGRES_PORT:-5434}:5432"
  ```
- O tráfego inter-contentores entre o `invision_backend` e a base de dados flui exclusivamente pela rede interna do Docker (`nexus-network`), ficando invisível para quaisquer outros dispositivos da rede local.

### Pilar 2: Validação Binária de Uploads (*Magic Bytes Guardrail*)
- Não confiamos na extensão do ficheiro nem no cabeçalho `Content-Type` enviado pelo cliente.
- Ao receber o primeiro bloco de dados no endpoint `POST /api/v1/live/upload`, o backend inspeciona a assinatura binária real:
  * **MP4 / MOV / M4V:** Verifica a caixa `ftyp` (bytes 4-8) ou `moov`/`mdat`.
  * **WebM / MKV:** Verifica o cabeçalho EBML `0x1A 0x45 0xDF 0xA3`.
  * **JPEG:** Verifica o marcador SOI `0xFF 0xD8 0xFF`.
  * **PNG:** Verifica a assinatura `0x89 0x50 0x4E 0x47 0x0D 0x0A 0x1A 0x0A`.
  * **WebP:** Verifica o contentor `RIFF....WEBP`.
- Se a assinatura for inválida ou suspeita, a escrita em disco é imediatamente abortada, o ficheiro temporário é apagado e o evento é registado no trilho de auditoria com alerta `UPLOAD_BLOCKED_MAGIC_BYTES`.

### Pilar 3: Identidade Criptográfica de Equipamentos (*Hardware Device Tokens*)
- No emparelhamento de 6 dígitos (`NX-XXXXXX`), o servidor gera um `deviceToken` aleatório de 24 bytes (48 caracteres hexadecimais em CSPRNG).
- O Edge Player PWA armazena esta chave de forma segura e envia-a no cabeçalho HTTP:
  ```http
  X-Device-Token: 3f8a4b9c1d2e...
  ```
- O backend valida a correspondência entre o `hardwareUid` e o `deviceToken`. Se um pedido for recebido com um token incorreto, o acesso é rejeitado com HTTP 401 (`UNAUTHORIZED_DEVICE`) e um incidente de segurança é registado.

### Pilar 4: Autenticação Híbrida (Microsoft Entra ID + Break-Glass)
A plataforma suporta dois motores de autenticação complementares:
1. **Microsoft Entra ID (Office 365 SSO):**
   * Padrão corporativo da FNAC & DARTY via protocolo **OpenID Connect (OIDC)** e **OAuth2**.
   * Suporta autenticação multifator (MFA) obrigatória, políticas de Acesso Condicional da empresa e revogação imediata de contas desativadas no Active Directory.
   * **Mapeamento de Funções:**
     - `SG_FNAC_INVISION_ADMINS` ➔ `GLOBAL_ADMIN`
     - `SG_FNAC_MARKETING_MULTIMEDIA` ➔ `MEDIA_MANAGER`
     - `SG_FNAC_IT_OPS_HARDWARE` ➔ `IT_OPS`
     - `SG_FNAC_STORE_MANAGERS` ➔ `STORE_MANAGER`
     - `SG_FNAC_DEPT_HEADS` ➔ `DEPT_HEAD`
2. **Conta Local de Contingência ("Break-Glass"):**
   * Utilizador de emergência `admin` com palavra-passe protegida por **PBKDF2 com HMAC-SHA512** (100.000 iterações e salt criptográfico individual).
   * Garante continuidade operacional no Synology NAS durante a fase de testes e serve de acesso de recuperação caso a conectividade externa à nuvem Microsoft esteja indisponível.

### Pilar 5: Anti-Defacement, Assinatura Criptográfica HMAC-SHA256 & Kiosk Lockout
Para garantir que os ecrãs nas bancadas de loja nunca exibem conteúdos piratas, não autorizados ou alterados por um atacante na rede Wi-Fi da loja (*Man-in-the-Middle*):
1. **Assinatura Digital no Servidor (`live-bridge.mjs`):**
   * O backend assina o manifesto com a chave mestra utilizando o algoritmo **HMAC-SHA256**:
     `HMAC_SHA256(Secret, "PlaylistId:Brand:Priority:SchedulingMode:Item1|Url1|Dur1;Item2|Url2|Dur2")`
   * A assinatura gerada (`manifestSignature`) é enviada em conjunto com o manifesto em cada *heartbeat* e evento WebSocket.
2. **Validação Criptográfica no Ecrã (`player/src/lib/cryptoSign.ts`):**
   * O Player verifica a assinatura utilizando a API nativa W3C Web Cryptography (`window.crypto.subtle`).
   * **Rejeição Imediata de Adulteração:** Se um atacante na VLAN alterar um URL ou inserir um vídeo estranho, o hash não confere, o Player rejeita 100% do pacote recebido e dispara uma notificação imediata de intrusão (`POST /api/v1/live/security/tamper-alert`).
3. **Resiliência Offline & Fail-Safe (Zero Ecrã Preto):**
   * O Player mantém o último manifesto verificado em armazenamento local seguro (`invision_verified_manifest`).
   * Em caso de quebra de rede, corte de Wi-Fi ou rejeição por adulteração, o Player comuta automaticamente para o cache local de ficheiros (*Blob ObjectURLs*), mantendo a emissão contínua sem nunca exibir ecrã preto ou janelas de erro.
4. **Kiosk Lockout no Navegador (`index.html`):**
   * **Content Security Policy (CSP):** Proíbe a execução de scripts externos e bloqueia a navegação para fora das origens seguras da plataforma.
   * **Bloqueio de Menus e Teclas:** Desativados os menus de contexto (*click direito / long-press*) e atalhos de depuração (`F12`, `Ctrl+Shift+I`, `Ctrl+U`), impedindo clientes em loja de interagir com o ambiente subjacente.

### Pilar 6: Trilho de Auditoria Imutável (*Audit Trail*)
Todas as operações de gestão de conteúdos, alteração de configurações e controlo de hardware são registadas num trilho de auditoria em memória e no disco:
- **Campos Registados:** Timestamp ISO 8601, Ação, Utilizador/Terminal, Perfil RBAC, Alvo, Detalhes técnicos, IP de Origem e Resultado (Sucesso / Bloqueado).
- **Ações Monitorizadas:** `LOGIN_SUCCESS_LOCAL`, `LOGIN_FAILED`, `LOGOUT`, `UPLOAD_MEDIA`, `UPLOAD_BLOCKED_MAGIC_BYTES`, `UPDATE_PLAYLISTS`, `PAIR_DEVICE_APPROVED`, `DEVICE_INVERT_180`, `SECURITY_TAMPER_ALERT`, `SECURITY_ALERT_RESET`, `ADB_REBOOT`, `PURGE_DEMO_DATA`.
- **Interface de Consulta:** Disponível em tempo real no módulo de **Configurações & Setup** (`/settings/`), no separador **`🛡️ 6. Segurança & SSO`**.

---

## 4. Guia de Configuração para a Equipa de TI (Microsoft Entra ID)

Para ativar a federação com o Office 365 corporativo da Fnac Darty em ambiente de produção:

1. **Registar a Aplicação no Portal Microsoft Entra:**
   - Aceder a **Microsoft Entra admin center** > **App registrations** > **New registration**.
   - **Nome:** `Invision Nexus Central Governance`
   - **Supported account types:** Accounts in this organizational directory only (Single tenant).
   - **Redirect URI (Web):** `http://<IP_OU_DOMINIO_DO_NAS>:3000/api/v1/auth/microsoft/callback`
2. **Obter as Credenciais:**
   - **Application (client) ID:** Copiar o UUID gerado.
   - **Directory (tenant) ID:** Copiar o UUID do Tenant corporativo.
   - **Certificates & Secrets:** Gerar um novo *Client Secret* e copiar o valor.
3. **Configurar as Variáveis no ficheiro `.env` do NAS:**
   ```bash
   AZURE_TENANT_ID="00000000-0000-0000-0000-000000000000"
   AZURE_CLIENT_ID="11111111-1111-1111-1111-111111111111"
   AZURE_CLIENT_SECRET="seu_segredo_corporativo_aqui"
   AZURE_REDIRECT_URI="http://192.168.68.117:3000/api/v1/auth/microsoft/callback"
   ```
4. **Reiniciar os Contentores no NAS:**
   ```bash
   bash scripts/update-nas.sh
   ```
   O botão de login da Microsoft em `/login/` passará a redirecionar diretamente para o portal de login seguro do Office 365 da Fnac Darty.

---

## 5. Procedimentos de Resposta a Incidentes (Playbook)

### Cenário A: Dispositivo Suspeito ou Forjado na Loja
1. O backend rejeita automaticamente o heartbeat com erro HTTP 401 e regista `HEARTBEAT_REJECTED_DEVICE_TOKEN_MISMATCH` no Audit Trail.
2. No módulo **`🖥️ Equipamentos`** (`/devices/`), o terminal aparece como `OFFLINE` ou não aprovado.
3. A equipa de IT Ops pode eliminar o terminal da lista com o botão `Eliminar Terminal` ou re-emparelhar presencialmente com novo código `NX-XXXXXX`.

### Cenário B: Tentativa de Upload de Ficheiro Malicioso
1. O validador de *Magic Bytes* interceta os primeiros bytes e bloqueia a escrita em disco.
2. O utilizador recebe o erro HTTP 415 (`FILE_GUARDRAIL_BLOCKED`).
3. O evento fica registado na tabela de auditoria com o IP de origem para investigação imediata.

### Cenário C: Tentativa de Adulteração de Ecrã em Loja (MITM / Defacement)
1. O Player verifica que a assinatura HMAC-SHA256 do manifesto não coincide com os dados recebidos.
2. O manifesto adulterado é descartado de imediato, sem que nenhum frame estranho chegue ao ecrã.
3. O Player emite um alarme para o servidor (`POST /api/v1/live/security/tamper-alert`) e continua a reproduzir o cache previamente validado ou os slides institucionais.
4. Na consola de **Equipamentos** (`/devices/`), o terminal passa a exibir a etiqueta vermelha a pulsar `🚨 ALERTA MITM / ASSINATURA INVÁLIDA`.
5. Após inspeção e verificação da rede de loja pela equipa de segurança, o operador pode clicar em `🛡️ Repor Alerta` para rearmar o monitor.

---

## 6. Suíte de Testes Automatizados de Cibersegurança & Auditoria Visual

A plataforma inclui uma suíte de testes de penetração e conformidade que valida os 6 pilares de segurança:

```bash
# Execução direta no servidor central ou Synology NAS:
./scripts/run-security-tests.sh http://127.0.0.1:3000
```

### Vetores Auditados pelos Testes:
1. **Magic Bytes Guardrail:** Tenta injetar código PHP/Shell com extensão `.mp4`. Valida rejeição com HTTP 415 e eliminação do ficheiro.
2. **Device Token Spoofing:** Simula um terminal clonado na rede a enviar *heartbeats* com um token forjado. Valida rejeição com HTTP 401 (`UNAUTHORIZED_DEVICE`).
3. **Anti-Defacement HMAC-SHA256:** Altera o URL de vídeo no manifesto mantendo a assinatura original. Valida a deteção de adulteração e ativação do alarme MITM.
4. **Proteção Brute-Force Break-Glass:** Testa palavra-passe incorreta e valida a resistência do PBKDF2-HMAC-SHA512 (100.000 iterações com salt individual).
5. **Isolamento de Portas:** Confirma que PostgreSQL (5434) e Redis (6380) estão restritos a `127.0.0.1` e não expostos na LAN.
6. **Integridade NIS2 / RGPD:** Confirma que todas as tentativas maliciosas acima foram gravadas no Audit Trail com timestamp, IP e detalhe técnico.

### Verificação Visual no Dashboard:
- No separador **`Configurações > 🛡️ 6. Segurança & SSO`** (`/settings/`): comprove os 5 cartões de hardening ativos e a lista de eventos de invasão bloqueados no *Audit Trail*.
- No módulo **`🖥️ Equipamentos`** (`/devices/`): comprove o alerta visual a pulsar `🚨 ALERTA MITM / ASSINATURA INVÁLIDA` e reponha o estado clicando em `🛡️ Repor Alerta`.

---

*Documento mantido e auditado pelo repositório Invision Nexus.*

