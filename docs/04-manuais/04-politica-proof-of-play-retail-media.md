# Manual de Operações: Governação de Telemetria Comercial, Proof of Play & Minimização de Dados (PoP Governance)

> **Invision Nexus — FNAC & DARTY**  
> **Classificação:** Documento Técnico Operacional / Compliance NIS2 & RGPD  
> **Versão:** 1.1 (Novembro 2026)

---

## 1. Objetivo & Enquadramento de Retalho
Nos pontos de venda **FNAC** e **DARTY**, os ecrãs digitais (LEDwalls, ecrãs de montra, bancadas interativas e expositores de tecnologia) combinam dois tipos fundamentais de emissão:
1. **Retail Media Comercial (Patrocinado por Marcas Parceiras):** Campanhas contratadas por fornecedores de eletrónica de consumo (Samsung, Apple, Sony, Dyson, LG, Philips, Whirlpool, DeLonghi, etc.) onde cada segundo de emissão está sujeito a contratos rigorosos de **Share of Voice (SoV)** e SLAs para faturação financeira.
2. **Emissão Institucional, Editorial e Fallback:** Conteúdos próprios do Grupo (*Avisos de Loja, Promoções Editoriais de Livros/Música, Modalidades de Crédito, Campanhas Solidárias e Loops de Segurança*).

Para proteger a integridade financeira das faturas e evitar a saturação de armazenamento no servidor local/NAS (Synology DS220+), a plataforma Invision Nexus opera sob o princípio de **Auditoria Seletiva de Retail Media e Minimização de Dados (RGPD / NIS2)**.

---

## 2. As Três Políticas de Auditoria (Modos Operacionais)

| Modo de Operação | Descrição | Comportamento no Ecrã | O que é Gravado no Disco/BD | Impacto no Armazenamento | Finalidade Recomendada |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`RETAIL_MEDIA_ONLY`** *(Padrão & Recomendado)* | Audita exclusivamente campanhas de fornecedores comerciais contratados. | Exibição normal de 100% dos conteúdos (comerciais e institucionais). | **Apenas marcas comerciais parceiras.** Conteúdos institucionais e fallbacks são descartados da gravação (`SKIPPED_NON_COMMERCIAL`). | **Poupança de ~75% de disco** (~35 KB/dia por ecrã vs ~150 KB/dia). | Operação regular diária em todas as lojas. Faturação 100% precisa. |
| **`FULL_AUDIT`** | Regista 100% de todas as exibições (incluindo avisos de loja e fallbacks). | Exibição normal de 100% dos conteúdos. | **100% dos eventos concluídos**, sem qualquer filtro ou exceção. | Crescimento nominal elevado (~150 KB/dia por ecrã; ~3.5 GB/dia em 4.000 ecrãs). | Testes de conformidade, auditorias globais pontuais e homologação técnica. |
| **`PAUSED`** | Pausa o registo de novos tuplos de PoP na base de dados. | Exibição normal sem interrupção. Heartbeats e controlo ativos. | **Nenhum registo de PoP gravado** (`SKIPPED_PAUSED`). | **0 KB/dia** (Crescimento nulo). | Janelas de manutenção de storage ou testes de bancada controlados. |

---

## 3. Mecânica Técnica & Ciclo de Vida de Registo (Pipeline PoP)

### 3.1. Como Funciona a Ingestão no Backend
1. **Emissão no Terminal Edge:** O Player (Svelte PWA / Box Android X98 Plus) reproduz um item de vídeo ou imagem até ao fim da sua duração.
2. **Disparo da Telemetria:** No término do spot, o Player emite um payload `POST /api/v1/live/telemetry` com `{ type: "POP", mediaId, mediaTitle, durationMs, priority, hardwareUid, storeName }`.
3. **Avaliação pelo Motor de Governação (`live-bridge.mjs`):**
   - **Se `PAUSED`:** Responde imediatamente `status: "SKIPPED_PAUSED"`. Nenhuma linha é escrita na base de dados ou em `state.json`.
   - **Se `RETAIL_MEDIA_ONLY`:** O backend avalia o conteúdo através do classificador determinístico `isCommercialRetailMedia(partner, title, tags)`:
     - **Critérios de Marca Comercial:** Pertence a uma marca parceira catalogada (*Samsung, Apple, Sony, Dyson, LG, Philips, Whirlpool, DeLonghi, Bose, Microsoft, Asus, Lenovo, HP, Canon, Nikon, Xiaomi, Tefal, Rowenta, Nespresso, Google, etc.*) OU possui TAGs contratuais explícitas (`RETAIL_MEDIA`, `AUDIT`, `COMERCIAL`, `SPONSOR`).
     - **Se Comercial:** Atualiza o contador de plays (`playCount`), soma o tempo de emissão (`totalDurationMs`) na tabela agregada `popRecords` e anexa uma entrada com hash criptográfico SHA-256 no anel de auditoria forense `popAuditLogs`.
     - **Se Não-Comercial (Ruído Institucional):** Conteúdos identificados como `FNAC Editorial`, `DARTY Editorial`, `Campanha Geral`, `Crédito & Serviços`, `Avisos` ou `Fallback` são descartados da gravação com `status: "SKIPPED_NON_COMMERCIAL"`.
   - **Se `FULL_AUDIT`:** Grava indistintamente todos os eventos concluídos no anel forense e na tabela agregada.

---

## 4. Persistência Atómica, Efeito Imediato & Natureza Cumulativa

### 4.1. Gravação Imediata no Disco (Sem Downtime)
* **Ativação Instantânea:** Ao selecionar uma nova política no Dashboard Central, o browser envia `POST /api/v1/live/telemetry/policy`.
* **Persistência Atómica no NAS:** O backend atualiza `state.telemetryAuditPolicy` e invoca `saveState()`, persistindo o novo estado em disco no ficheiro `state.json`.
* **Zero Reinício:** Não é necessário reiniciar contentores Docker, reemparelhar boxes nem recarregar o Player. A nova regra entra em vigor no milissegundo seguinte.
* **Audit Trail Corporativo (NIS2 / RGPD):** A operação gera um evento de auditoria imutável (`TELEMETRY_POLICY_CHANGED`) com registo do operador, timestamp e IP de origem.

### 4.2. Natureza Cumulativa dos Dados (Invariabilidade Retroativa)
* **A mudança de política é um filtro de entrada (*Inflow Filter*):**
  * Afeta estritamente o que é gravado a partir do momento da mudança.
  * **NUNCA apaga nem altera retroativamente os dados previamente registados.**
* **Exemplo de Comportamento Acumulativo:**
  1. Se o sistema operar 3 dias em modo `FULL_AUDIT`, acumula 15.000 plays de marcas e 45.000 plays institucionais.
  2. Ao alternar para `RETAIL_MEDIA_ONLY`, todos os 60.000 registos permanecem intactos na base de dados/disco. Apenas os novos plays institucionais deixam de ser adicionados.
  3. Se, mais tarde, regressar a `FULL_AUDIT`, os dados históricos mantêm-se e os novos eventos voltam a somar cumulativamente sobre o histórico pré-existente.

---

## 5. Purga Inteligente de Ruído Institucional

Os dados antigos não são eliminados automaticamente pela mudança de política; a sua limpeza física requer uma ação expressa e deliberada no Dashboard:

1. **Aceder à Purga:** Clicar no botão **"🗑️ Purgar Telemetria"** no cabeçalho.
2. **Seleção de Âmbito:**
   - **`💎 Purgar Ruído Não-Comercial / Institucional (Recomendado)`:** Remove apenas "Campanha Geral", "FNAC Crédito & Serviços" e editoriais herdados do passado.
   - **Garantia de Negócio:** Mantém **100% intactos** os registos reais de marcas parceiras (Samsung, Apple, Sony, Dyson, LG, etc.) para faturação e cumprimento de SLA.
   - **`⚪ Purgar apenas a insígnia ativa (FNAC)`:** Elimina todo o histórico da marca ativa.
   - **`⚪ Reset Total (Todas as Marcas)`:** Limpeza integral absoluta de todas as insígnias.
3. **Efeito Físico:** Reduz de imediato a pegada em disco no NAS e atualiza o semáforo de saúde de storage para `● OTIMIZADO`.

---

## 6. Arquitetura do Layout do Dashboard & Emissão do Certificado

### 6.1. Ergonomia do Cabeçalho em 2 Níveis
Para garantir estabilidade visual e evitar que o título executivo e as badges de insígnia sejam esmagados em ecrãs com larguras padrão (1280px a 1440px), o cabeçalho foi estruturado em dois níveis verticais no lado direito:
- **Nível Superior (Topo):** Seletor de Governance da **Política PoP** com semáforo animado (`inline-block w-2 h-2 rounded-full`).
- **Nível Inferior (Base):** Os quatro botões de ação horizontais (`Exportar PoP (CSV)`, `Exportar SoV (CSV)`, `Certificado Oficial PDF`, `Purgar Telemetria`).
- **Lado Esquerdo Expandido (`flex-1 min-w-0`):** As etiquetas de conformidade e o título mantêm a sua largura natural sem quebras forçadas palavra-a-palavra.

### 6.2. Certificado Oficial A4 (Proof of Play)
- **Filtragem de Faturação:** Quando emitido com a política `RETAIL_MEDIA_ONLY`, o gerador filtra automaticamente o ruído institucional e agrega os registos por Marca e Campanha.
- **Share of Voice (SoV) Real:** O cálculo de SoV entregue reflete a percentagem real negociada com os fornecedores, eliminando a diluição provocada pelos anúncios institucionais da loja.
- **Impressão Segura em Iframe:** A emissão A4 ocorre numa sandbox isolada (`printOfficialCertificate`), garantindo uma página impressa limpa e pronta para assinaturas do Diretor de Loja e do Responsável Multimédia.
