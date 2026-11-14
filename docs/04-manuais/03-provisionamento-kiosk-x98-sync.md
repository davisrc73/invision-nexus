# Manual 03: Provisionamento Kiosk (Boxes Android X98 Plus, Parque Expo & Sincronização ao Milissegundo)

Este manual descreve como preparar e operar os terminais em loja: **Boxes Android X98 Plus (4GB RAM / 64GB ROM)**, **LEDwalls**, **TVs em Exposição (`TV_DEMO`)** e **Parque de Exposição (`LAPTOP_EXPO`, `TABLET_EXPO`, `SMARTPHONE_EXPO`)**.

---

## 1. Provisionamento Automatizado ADB para Boxes Android X98 Plus

O script `scripts/provision-x98-kiosk.sh` automatiza a configuração de fábrica de qualquer Box Android X98 Plus na rede da loja:

```bash
chmod +x scripts/provision-x98-kiosk.sh
./scripts/provision-x98-kiosk.sh 192.168.10.45 http://IP_DO_SERVIDOR:5173
```

### O que o script configura automaticamente:
1. **Energia e HDMI-CEC:** Desativa o *Sleep*, protetor de ecrã Android e o desligar automático via HDMI-CEC (`stay_on_while_plugged_in = 7`).
2. **Modo Imersivo (Full Kiosk):** Oculta a barra de estado superior e a barra de navegação Android (`immersive.full=*`) e desativa notificações *heads-up*.
3. **Autoplay sem Gesto Humano:** Configura `--autoplay-policy=no-user-gesture-required` e descodificação de vídeo por GPU (`--enable-accelerated-video-decode`), garantindo que após um corte de energia na loja a box arranca e reproduz vídeo imediatamente sem intervenção humana.
4. **Zero-Touch Pairing (6 Dígitos):** Ao abrir o Player pela primeira vez, o ecrã exibe um código de 6 dígitos (ex: `NX-849201`). Basta um elemento `GLOBAL_ADMIN` ou `IT_OPS` aprovar o código no Dashboard Central.

---

## 2. Sincronização Multi-Ecrã ao Milissegundo (`MillisecondSyncEngine`)

Para corredores de ecrãs ou Video Walls pertencentes ao mesmo `SyncGroup`:
- **Calibração NTP via WebSockets (`/ws/sync`):** Calcula o *Round-Trip Time (RTT)* e o *Clock Offset* filtrando as amostras de menor jitter.
- **Resiliência Offline (Corte de WAN):** Guarda o último offset e o declive de deriva do cristal (`driftSlopePpm`) em `localStorage` e suporta medição de tempo via gateway local da loja.
- **Micro-Pacing sem Cortes Bruscos:**
  - Desvio `< 15ms`: Mantém `playbackRate = 1.00`.
  - Desvio entre `15ms` e `150ms`: Ajusta suavemente a velocidade (`0.98x` ou `1.02x`) até alinhar ao milissegundo sem salto visual.
  - Desvio `> 150ms`: Executa *Hard Seek* imediato para a posição determinística `SyncedEpochMs % LoopTotalDurationMs`.

---

## 3. Atalho Secreto de Diagnóstico em Loja (Hidden OSD Menu)

Em frente a qualquer ecrã na loja:
- **Com Rato / Touch:** Clique **5 vezes seguidas no canto superior esquerdo** do ecrã.
- **Com Teclado / Comando Box Android:** Pressione a tecla **`F12`** ou **`i`**.

O painel mostra em tempo real:
- Espaço livre nos **64GB ROM** e estado `PERSISTED`;
- Estado do **Dual-Buffer Video Deck** (`Deck A` vs `Deck B`);
- Contadores locais acumulados no **IndexedDB** (*Proof of Play* e *Interações Touch/TV Demo*);
- **Offset NTP em milissegundos** e estado do *Micro-Pacing*;
- Botões rápidos para alternar entre os modos `PASSIVE`, `IDLE_SCREENSAVER` e `INTERACTIVE_CATALOG`.

