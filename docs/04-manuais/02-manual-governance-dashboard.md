# Manual 02: Operação do Dashboard e Governance (RBAC, Slots, SoV & Auditoria)

Este manual explica como operar o **Dashboard Central (Astro + Tailwind CSS)** de acordo com os perfis de Governance da Fnac e Darty.

---

## 1. Brand Switcher Global (Isolamento Fnac vs. Darty)

No canto superior esquerdo da barra lateral encontra-se o seletor **Insígnia Ativa (Guardrail)**:
- **`FNAC`:** Filtra o catálogo de media, playlists, Live Wall e relatórios exclusivamente para a marca Fnac. Impede que qualquer vídeo Darty seja adicionado por engano.
- **`DARTY`:** Filtra e isola toda a operação para as lojas Darty.
- **`GLOBAL`:** Visão consolidada do parque (~4.000 dispositivos) para a direção e equipa de suporte IT.

---

## 2. Construção de Playlists: Matriz de Slots vs. Share of Voice (%)

Aceda ao menu **Playlists (Slots & SoV)** (disponível apenas para `GLOBAL_ADMIN` e `MEDIA_MANAGER`):
1. **Escolha o Nível de Prioridade:**
   - `1. EXCLUSIVA` (Silencia a 100% todas as outras playlists).
   - `2. PRIORITÁRIA` (Silencia a 100% as playlists `NORMAL` durante a sua janela ativa).
   - `3. NORMAL` (Programação regular).
   - `4. FALLBACK` (Segurança institucional).
2. **Escolha o Perfil de Terminal (`Format Guardrail`):**
   - Ao selecionar `Standard 16:9`, `LEDwall 32:9` ou `Vertical 9:16`, qualquer tentativa de adicionar um ficheiro com resolução/aspect-ratio incompatível será bloqueada automaticamente com alerta visual.
3. **Escolha o Modelo de Programação:**
   - **Modelo 1 (`FIXED_SLOTS`):** Atribua vídeos diretamente às Slots numeradas (`#01` a `#N`) e veja a duração exata do Loop.
   - **Modelo 2 (`DYNAMIC_SOV`):** Defina a percentagem de *Share of Voice* de cada campanha através dos *sliders* e visualize em tempo real a sequência intercalada gerada pelo algoritmo *Weighted Round-Robin*.

---

## 3. Auditoria de Loja e Reporte de Incidentes (`STORE_MANAGER` & `DEPT_HEAD`)

Os Diretores de Loja e Chefes de Departamento operam em modo **100% Read-Only + Monitorização**:
1. Aceda a **Live Wall Loja & Incidentes**.
2. Filtre pelo departamento (`LEDwall Entrada`, `Informática`, `TV & Vídeo`, `Telecom`, `Gaming`).
3. Caso identifique um ecrã desligado ou conteúdo desatualizado, clique em **`! Reportar Anomalia`**, escolha o tipo de incidente e envie o alerta em 2 cliques para a equipa Multimédia / IT.

