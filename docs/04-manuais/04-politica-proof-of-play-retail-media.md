# Manual de Operações: Governação de Telemetria Comercial, Proof of Play & Minimização de Dados (PoP Governance)

> **Invision Nexus — FNAC & DARTY**  
> **Classificação:** Documento Técnico Operacional / Compliance NIS2 & RGPD  
> **Versão:** 1.0 (Novembro 2026)

---

## 1. Objetivo & Enquadramento de Retalho
Nos pontos de venda **FNAC** e **DARTY**, os ecrãs digitais (LEDwalls, ecrãs de montra, bancadas interativas e expositores de tecnologia) combinam dois tipos fundamentais de emissão:
1. **Retail Media Comercial (Patrocinado por Marcas Parceiras):** Campanhas contratadas por fornecedores de eletrónica de consumo (Samsung, Apple, Sony, Dyson, LG, Philips, Whirlpool, DeLonghi, etc.) onde cada segundo de emissão está sujeito a contratos rigorosos de **Share of Voice (SoV)** e SLAs para faturação financeira.
2. **Emissão Institucional, Editorial e Fallback:** Conteúdos próprios do Grupo (*Avisos de Loja, Promoções Editoriais de Livros/Música, Modalidades de Crédito, Campanhas Solidárias e Loops de Segurança*).

Para proteger a integridade financeira das faturas e evitar a saturação de armazenamento no servidor local/NAS (Synology DS220+), a plataforma Invision Nexus opera sob o princípio de **Auditoria Seletiva de Retail Media e Minimização de Dados**.

---

## 2. As Três Políticas de Auditoria (Modos Operacionais)

| Modo de Operação | Descrição | Comportamento no Ecrã | Impacto no Armazenamento | Finalidade Recomendada |
| :--- | :--- | :--- | :--- | :--- |
| **`RETAIL_MEDIA_ONLY`** *(Padrão & Recomendado)* | Audita apenas campanhas de fornecedores comerciais contratados. | Exibição normal de 100% dos conteúdos (comerciais e institucionais). | **Poupança de ~75% de disco** (~35 KB/dia por ecrã). | Operação regular diária em todas as lojas. Faturação 100% precisa. |
| **`FULL_AUDIT`** | Regista 100% de todas as exibições (incluindo avisos de loja e fallbacks). | Exibição normal de 100% dos conteúdos. | Crescimento nominal elevado (~150 KB/dia por ecrã). | Testes de conformidade, auditorias globais pontuais e homologação. |
| **`PAUSED`** | Pausa o registo de novos tuplos de PoP na base de dados. | Exibição normal sem interrupção. Heartbeats e controlo ativos. | **0 KB/dia** (Crescimento nulo). | Janelas de manutenção de storage ou testes de bancada controlados. |

---

## 3. Gestão da Política no Dashboard Central

O Gestor Multimédia e o Administrador Global podem alterar a política de telemetria em tempo real a partir da página **Telemetria Comercial & Proof of Play** (`/telemetry`):

1. **Aceder ao Dashboard:** Navegar para o menu lateral **"Telemetria"**.
2. **Localizar o Seletor de Política PoP:** Na barra de ações superior, selecionar o modo desejado no dropdown:
   - 🟢 `💎 Retail Media (Fornecedores SLA • ~75% Poupança)`
   - 🔵 `🔍 Auditoria Total (100% dos Conteúdos)`
   - 🟡 `⏸️ Telemetria Pausada (Manutenção)`
3. **Aplicação Instantânea:** A alteração é comunicada imediatamente ao backend via `POST /api/v1/live/telemetry/policy` e registada no **Audit Trail** corporativo (NIS2 / RGPD).

---

## 4. Purga Inteligente de Ruído Institucional

Se a base de dados acumulou dados de testes ou histórico institucional antigo, o operador pode libertar espaço no NAS sem perder os dados de faturação dos parceiros comerciais:

1. Clicar no botão **"🗑️ Purgar Telemetria"**.
2. No pop-up de confirmação, selecionar a opção recomendada:
   - **`💎 Purgar Ruído Não-Comercial / Institucional (Recomendado)`**: Remove todas as exibições de "Campanha Geral", "FNAC Crédito & Serviços" e editoriais antigos.
   - **Garantia de Negócio:** Mantém **100% intactos** os registos reais de marcas comerciais (Samsung, Sony, LG, Apple, Dyson, etc.).
3. Confirmar a operação. O semáforo de saúde de storage no 5.º cartão de KPI atualizará imediatamente para `● OTIMIZADO`.

---

## 5. Emissão do Certificado Oficial A4 (Proof of Play)

O **Certificado Oficial de Exibição Publicitária** é o documento executivo para prestação de contas com validade legal e de faturação:
- **Zero-Noise Filtering:** Quando a política é `RETAIL_MEDIA_ONLY`, o certificado agrega estritamente as marcas comerciais parceiras.
- **Cálculo Real de SoV:** O Share of Voice entregue reflete a percentagem real negociada, eliminando a diluição artificial causada pelos anúncios institucionais da loja.
- **Impressão Isolada:** Ao clicar em **"Certificado Oficial PDF"**, o documento abre numa pré-visualização elegante e é impresso via iframe técnico isolado em folha única A4, pronto para receber as assinaturas do Diretor de Loja e do Responsável de Auditoria Multimédia.
