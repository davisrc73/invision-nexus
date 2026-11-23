# Manual de Operações: Guia Prático de Auditoria Periódica de Cibersegurança & Testes em Box Android

> **Invision Nexus — FNAC & DARTY**  
> **Classificação:** Documento Técnico Operacional / Procedimento de Auditoria de Cibersegurança (SOP)  
> **Versão:** 1.0 (Novembro 2026) • **Conformidade:** NIS2, RGPD & Arquitetura Zero-Trust

---

## 1. Objetivo & Âmbito de Aplicação

Este manual estabelece o **Procedimento Operacional Padrão (SOP)** para a realização de testes periódicos de cibersegurança e hardening na plataforma **Invision Nexus**.

O objetivo é garantir que o parque de ecrãs de retalho da **FNAC** e da **DARTY** mantém permanentemente ativas as suas defesas contra:
1. **Defacement / Sequestro de Ecrãs:** Injeção de vídeos não autorizados ou pornográficos/concorrentes nas lojas.
2. **Ataques Man-in-the-Middle (MITM):** Adulteração de manifestos na rede Wi-Fi/VLAN local.
3. **Equipamentos Clonados/Impostores:** Terminais piratas a tentar aceder à infraestrutura.
4. **Vandalismo em Loja:** Clientes a tentar sair do Player ou aceder ao Android da Box via teclado/rato.
5. **Quebras de Emissão (Ecrã Preto):** Perda de sinal por falhas de conectividade na loja.

---

## 2. Preparação & Endereçamento de Rede

Antes de iniciar a auditoria, determine o endereço de rede correto a utilizar consoante o ponto de execução:

| Ponto de Execução do Teste | Endereço da API a Usar | Justificação Técnica |
| :--- | :--- | :--- |
| **Dentro do Synology NAS** *(via SSH)* | `http://127.0.0.1:3000` ou `http://192.168.68.117:3000` | Dentro do NAS, o loopback `127.0.0.1` e o IP da interface LAN mapeiam diretamente para a porta do contentor Docker. |
| **A partir do Mac / PC de Gestão** *(na rede da loja/escritório)* | `http://192.168.68.117:3000` | O Mac está fora do NAS; deve utilizar o endereço IP do servidor na rede local. |

---

## 3. Fase 1: Auditoria Automatizada da API & Infraestrutura (CLI)

A plataforma inclui uma suíte automatizada de testes de penetração desenvolvida especificamente para o Invision Nexus: `tests/security-suite.mjs`.

### 3.1. Execução do Comando
No terminal (do Mac ou do NAS):

```bash
cd /volume1/docker/invision-nexus   # Se estiver no NAS
# ou cd ~/invision-nexus           # Se estiver no seu computador

# Executar a suíte de testes contra o Backend:
./scripts/run-security-tests.sh http://192.168.68.117:3000
```

### 3.2. Os 6 Vetores Validados
O script testa automaticamente os 6 pilares de cibersegurança e devolve o resultado de cada vetor:

```text
===========================================================================
🛡️  INVISION NEXUS — SUÍTE DE TESTES DE CIBERSEGURANÇA & HARDENING
🎯 Alvo de Teste: http://192.168.68.117:3000
===========================================================================

[TESTE 1] Magic Bytes Guardrail (Upload de Ficheiro Falso .mp4)...        ✅ PASSOU
[TESTE 2] Device Token Spoofing (Heartbeat com Token Forjado)...          ✅ PASSOU
[TESTE 3] Anti-Defacement HMAC-SHA256 (Deteção de Adulteração MITM)...    ✅ PASSOU
[TESTE 4] Autenticação Break-Glass (Proteção contra Password Incorreta)... ✅ PASSOU
[TESTE 5] Isolamento de Portas e Serviços (PostgreSQL & Redis Loopback)... ✅ PASSOU
[TESTE 6] Audit Trail Imutável (Rastreio de Tentativas Maliciosas)...     ✅ PASSOU

===========================================================================
🏆 TODOS OS 6 TESTES DE CIBERSEGURANÇA FORAM APROVADOS COM DISTINÇÃO (100%)!
🛡️  A plataforma Invision Nexus cumpre as diretivas NIS2, RGPD e Zero-Trust.
===========================================================================
```

#### O que cada teste valida:
1. **Magic Bytes Guardrail:** Tenta fazer upload de um ficheiro de texto executável com extensão `.mp4`. O backend inspeciona os primeiros bytes binários, aborta imediatamente a escrita em disco com **HTTP 415 (`FILE_GUARDRAIL_BLOCKED`)**, apaga o ficheiro temporário e regista um alerta no Audit Trail.
2. **Device Token Spoofing:** Simula um terminal atacante na rede que tenta enviar um heartbeat fingindo ser a Box `X98-PLUS-01` com um token forjado. O backend rejeita imediatamente com **HTTP 401 (`UNAUTHORIZED_DEVICE`)**.
3. **Anti-Defacement HMAC-SHA256:** Altera o URL de vídeo no manifesto mantendo a assinatura original. A verificação matemática falha, rejeita o pacote e dispara um alerta de intrusão para o Dashboard.
4. **Proteção Brute-Force Break-Glass:** Testa palavra-passe incorreta e comprova que a autenticação de contingência é protegida pelo algoritmo **PBKDF2-HMAC-SHA512** com 100.000 iterações e salt individual.
5. **Isolamento de Portas Docker:** Verifica se o **PostgreSQL (5434)** e o **Redis (6380)** estão restritos a `127.0.0.1`, ficando completamente inacessíveis a outras máquinas na rede LAN da loja.
6. **Audit Trail Imutável (NIS2 / RGPD):** Valida que 100% das tentativas de intrusão simuladas ficaram gravadas com timestamp ISO 8601, IP de origem e detalhe técnico.

---

## 4. Fase 2: Testes Práticos no Hardware (Box Android X98 Plus em Bancada)

Para validar a segurança física no ecrã da loja, execute os seguintes **4 testes manuais**:

### 🧪 Teste 1: Simulação de Ataque MITM & Gestão de Incidentes no Dashboard
* **Objetivo:** Verificar a reação em tempo real do Dashboard quando um terminal deteta adulteração de sinal.
* **Passo a Passo:**
  1. Abra o Dashboard no seu navegador: `http://192.168.68.117:4322/devices`
  2. Execute a suíte de testes no terminal (`./scripts/run-security-tests.sh http://192.168.68.117:3000`).
  3. Observe o ecrã do Dashboard:
     * O cartão do terminal passa imediatamente a exibir a etiqueta vermelha a pulsar:  
       `🚨 ALERTA MITM / ASSINATURA INVÁLIDA`
     * Fica visível o botão de operador de segurança: **`🛡️ Repor Alerta`**.
  4. Clique em **`🛡️ Repor Alerta`**: o alerta é reposto, a normalidade é restabelecida e é gerado um registo `SECURITY_ALERT_RESET` no histórico de auditoria.

---

### 🧪 Teste 2: Resiliência "Zero Ecrã Preto" (Corte Físico de Rede)
* **Objetivo:** Comprovar que um corte de rede ou falha de Wi-Fi nunca provoca ecrã preto ou mensagens de erro aos clientes na loja.
* **Passo a Passo:**
  1. Com a Box Android ligada à TV e a reproduzir a emissão comercial normalmente:
  2. **Desligue fisicamente o cabo de rede Ethernet** (ou desligue o Wi-Fi nas definições da Box).
  3. **Comportamento no Ecrã da TV:**
     * A reprodução de vídeo **não para e não falha**.
     * O Player mantém o loop comercial contínuo a partir da cache segura local (`Cache API / OPFS` e `IndexedDB`).
     * Nenhum aviso de erro, janela do Android ou cursor aparece no ecrã.
  4. **Comportamento no Dashboard:** Após 90 segundos sem receber *heartbeat*, o terminal passa automaticamente ao estado `🔴 OFFLINE`.
  5. **Reconexão:** Volte a ligar o cabo de rede. Em poucos segundos, a Box retoma a comunicação e passa automaticamente para `🟢 ONLINE` sem necessidade de reinício nem de intervenção manual.

---

### 🧪 Teste 3: Kiosk Lockout na TV (Proteção Anti-Vandalismo)
* **Objetivo:** Impedir que clientes ou pessoas não autorizadas na loja consigam sair da reprodução ou aceder ao sistema operativo da Box.
* **Passo a Passo:**
  1. Ligue um rato USB ou teclado USB à Box Android.
  2. Tente as seguintes interações na TV:
     * **Clique com o botão direito do rato:** Bloqueado (nenhum menu de contexto do Chrome é exibido).
     * **Atalhos de teclado de desenvolvedor (`F12`, `Ctrl+Shift+I`, `Ctrl+U`):** Bloqueados pela aplicação.
     * **Toque prolongado (*long-press*):** Desativado (não seleciona texto nem abre opções de partilha).
     * **Navegação externa:** A política **CSP (Content Security Policy)** bloqueia qualquer tentativa de redirecionamento para URLs externos.

---

### 🧪 Teste 4: Verificação OSD da Assinatura Criptográfica no Ecrã
* **Objetivo:** Auditoria visual no próprio ecrã da loja para atestar a autenticidade dos dados recebidos.
* **Passo a Passo:**
  1. No ecrã da TV com a emissão ativa, abra a camada técnica OSD:
     * Prima a tecla **`i`** no teclado USB da Box, **OU**
     * Efetue **5 cliques rápidos no canto superior esquerdo** do ecrã.
  2. Verifique os indicadores de segurança no painel OSD sobreposto:
     * **Assinatura Digital:** `🛡️ HMAC-SHA256: VÁLIDO`
     * **Hash SHA-256 do Vídeo:** Exibição do hash criptográfico único do ficheiro ativo.
     * **Modo Kiosk:** Status ativo do motor de resiliência e fail-safe offline.

---

## 5. Fase 3: Inspeção Visual do Audit Trail no Dashboard

Para satisfazer os requisitos de auditoria das diretivas **NIS2** e **RGPD**:

1. Aceda a **Configurações & Setup** (`/settings/`) no menu lateral.
2. Abra o separador **`🛡️ 6. Segurança & SSO`**.
3. **Cartões de Hardening:** Confirme que todos os 5 pilares apresentam semáforo verde:
   * `🟢 Portas Isoladas (127.0.0.1)`
   * `🟢 Magic Bytes Guardrail (Ativo)`
   * `🟢 Tokens Criptográficos (Ativo)`
   * `🟢 Anti-Defacement HMAC (Ativo)`
   * `🟢 Fail-Safe Kiosk (Zero Black Screen)`
4. **Tabela de Audit Trail:** Inspecione os registos de tentativas de invasão travadas pelo sistema, comprovando que cada tentativa regista:
   * Data e hora precisa (ISO 8601).
   * Ação (`UPLOAD_BLOCKED_MAGIC_BYTES`, `HEARTBEAT_REJECTED_DEVICE_TOKEN_MISMATCH`, `SECURITY_TAMPER_ALERT`, `LOGIN_FAILED`).
   * Endereço IP do emissor.
   * Resultado com selo `Bloqueado` a vermelho.

---

## 6. Calendário & Cadência Recomendada de Auditoria

| Frequência | Ação de Teste | Responsável |
| :--- | :--- | :--- |
| **Semanal** | Execução da suíte automatizada CLI (`./scripts/run-security-tests.sh`). | Técnico de TI / IT Ops |
| **Mensal** | Teste prático de corte de rede (Zero Black Screen) e inspeção OSD em 1 Box por loja. | Gestor de Suporte de Loja |
| **Pré-Campanha** *(Black Friday, Natal, Lançamentos)* | Auditoria completa dos 6 vetores + validação de integridade do Audit Trail em `/settings/`. | Administrador Global de Multimédia |
| **Pós-Atualização** | Execução obrigatória após qualquer comando `./scripts/update-nas.sh`. | Equipa de Engenharia / DevOps |

---

*Manual aprovado para conformidade operacional Invision Nexus — FNAC & DARTY.*
