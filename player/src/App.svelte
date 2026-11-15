<script>
  import { onMount, onDestroy } from 'svelte';
  import { ensurePersistentStorage } from './lib/offlineStorage';
  import {
    recordLocalProofOfPlay,
    recordLocalInteraction,
    getAllLocalTelemetry,
  } from './lib/telemetryQueue';
  import { MillisecondSyncEngine } from './lib/syncEngine';

  const API_BASE = `${window.location.protocol}//${window.location.hostname}:3000`;

  // Cada equipamento (Box Android 1, Box Android 2, Box Android 3, Telemóvel, Mac) mantém o seu UID e Código Único após reboot
  const urlParams = new URLSearchParams(window.location.search);
  const hwFromUrl = urlParams.get('hw_uid');
  let hardwareUid =
    localStorage.getItem('invision_hw_uid') ||
    hwFromUrl ||
    `X98-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
  localStorage.setItem('invision_hw_uid', hardwareUid);

  let pairingCode =
    localStorage.getItem('invision_pairing_code') ||
    `NX-${Math.floor(100000 + Math.random() * 900000)}`;
  localStorage.setItem('invision_pairing_code', pairingCode);

  let deviceName = localStorage.getItem('invision_device_name') || `Terminal (${hardwareUid})`;
  let isPaired = localStorage.getItem('invision_is_paired') !== 'false';
  let interactionMode = localStorage.getItem('invision_mode') || 'PASSIVE';
  let invert180 = localStorage.getItem('invision_invert_180') === 'true';

  const WS_URL = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.hostname}:3000/ws/sync?hw_uid=${encodeURIComponent(hardwareUid)}`;

  let activePriority = 'NORMAL';
  let activeBrand = 'FNAC';
  let activePlaylistName = 'Programação Regular';
  let activeSchedulingMode = 'FIXED_SLOTS';
  let currentManifestSignature = '';
  let heartbeatTimer = null;

  // Fallback institucional por defeito
  const fallbackSlides = [
    {
      id: '11111111-aaaa-1111-aaaa-111111111111',
      playlistId: 'aaaa0000-0000-0000-0000-000000000001',
      title: 'Apple MacBook Pro M4 — Já Disponível na Fnac',
      subtitle: 'Campanha Demo #01 • Carregue vídeos/imagens em localhost:4321/playlists',
      badge: 'FALLBACK DEMO • SLOT 1/2',
      mediaType: 'SLIDE',
      streamUrl: null,
      durationMs: 8000,
      bgGradient: 'linear-gradient(135deg, #0f172a 0%, #1e1b4b 50%, #000000 100%)',
      accentColor: '#E1A924',
    },
    {
      id: '22222222-bbbb-2222-bbbb-222222222222',
      playlistId: 'aaaa0000-0000-0000-0000-000000000001',
      title: 'Samsung OLED 4K S95D — Contraste Infinito',
      subtitle: 'Campanha Demo #02 • Adicione vídeos .mp4 ou imagens .jpg/.png no Dashboard',
      badge: 'FALLBACK DEMO • SLOT 2/2',
      mediaType: 'SLIDE',
      streamUrl: null,
      durationMs: 8000,
      bgGradient: 'linear-gradient(135deg, #042f2e 0%, #0f172a 60%, #000000 100%)',
      accentColor: '#38bdf8',
    },
  ];

  let activeLoop = [...fallbackSlides];
  let currentIndex = 0;
  let currentSlot = activeLoop[0];
  let slotProgressPct = 0;
  let slotElapsedMs = 0;
  let playbackTimer = null;
  let isAdvancing = false;
  let videoElement = null;

  const tvDemoCategories = [
    {
      code: 'GAMING_4K_120HZ',
      name: '🎮 Gaming 4K 120Hz',
      title: 'Gran Turismo 7 & PS5 Pro — Teste VRR 120fps / Baixo Input Lag',
      specs: '3840x2160 • 120fps • HDMI 2.1 VRR • HDR10',
      bgGradient: 'linear-gradient(135deg, #3b0764 0%, #0f172a 60%, #000000 100%)',
    },
    {
      code: 'CINEMA_OLED_HDR',
      name: '🎬 Filmes & Cinema OLED',
      title: 'Dune Part Two — Teste de Pretos Puros & Dolby Vision',
      specs: '3840x2160 • 24fps Cinema • Dolby Vision • Contraste Infinito',
      bgGradient: 'linear-gradient(135deg, #451a03 0%, #0c0a09 65%, #000000 100%)',
    },
    {
      code: 'SPORTS_MOTION',
      name: '⚽ Desporto Motion Clarity',
      title: 'UEFA Champions League & F1 — Teste de Nitidez em Movimento Rápido',
      specs: '3840x2160 • 60fps • AI Motion Enhancer Pro',
      bgGradient: 'linear-gradient(135deg, #064e3b 0%, #0f172a 65%, #000000 100%)',
    },
    {
      code: 'NATURE_QLED',
      name: '🌿 Natureza & Volume de Cor',
      title: 'Costa Rica 8K Master — Teste de Brilho de Pico em Loja Iluminada',
      specs: '3840x2160 • 60fps • 2000 Nits Peak Brightness • 100% DCI-P3',
      bgGradient: 'linear-gradient(135deg, #14532d 0%, #022c22 65%, #000000 100%)',
    },
  ];

  // Estado do Modo IDLE_SCREENSAVER
  let isCustomerUsingDevice = false;
  let idleTimeoutSec = 45;
  let idleCountdown = idleTimeoutSec;
  let engagementStartMs = 0;
  let idleInterval = null;

  // Estado do Modo INTERACTIVE_CATALOG
  let selectedTvCategory = null;
  let tvFocusedIndex = 0;

  // Estado do Hidden OSD Diagnostic Menu
  let showOsd = false;
  let showHudBadges = false; // Em produção na loja, o vídeo fica 100% limpo sem textos por cima!
  let isFullscreen = false;
  let secretCornerClicks = 0;
  let secretClickTimeout = null;
  let storageHealth = {
    persisted: true,
    usageBytes: 1420000000,
    quotaBytes: 68719476736,
    freeBytes: 67299476736,
  };
  let totalLocalPlays = 0;
  let totalLocalInteractions = 0;
  let lastSyncStatus = 'Live Bridge Conectado';
  let ntpOffsetMs = 1.2;

  const syncEngine = new MillisecondSyncEngine(WS_URL, window.location.origin);
  let liveSocket = null;
  let blobUrlMap = {};
  let preloadingUrls = new Set();

  /**
   * Faz download dos ficheiros de vídeo/imagem para a RAM local da Box (`Blob` ObjectURL).
   * Após a 1.ª transferência, os loops seguintes correm 100% da memória local com ZERO sockets HTTP abertos!
   */
  async function preloadMediaBlobs(items) {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      const remoteUrl = item.remoteUrl || item.streamUrl;
      if (
        !remoteUrl ||
        remoteUrl.startsWith('blob:') ||
        blobUrlMap[remoteUrl] ||
        preloadingUrls.has(remoteUrl)
      ) {
        continue;
      }
      preloadingUrls.add(remoteUrl);
      try {
        const res = await fetch(remoteUrl);
        if (res.ok) {
          const blob = await res.blob();
          if (blob && blob.size > 0) {
            const localBlobUrl = URL.createObjectURL(blob);
            blobUrlMap[remoteUrl] = localBlobUrl;
            // Atualiza os slots para usarem o ObjectURL local na próxima passagem
            activeLoop = activeLoop.map((slot) =>
              slot.remoteUrl === remoteUrl ? { ...slot, streamUrl: localBlobUrl } : slot
            );
          }
        }
      } catch {
        // Fallback para stream HTTP direto se falhar
      } finally {
        preloadingUrls.delete(remoteUrl);
      }
    }
  }

  /**
   * Aplica o Manifesto enviado para este equipamento específico:
   * - Só reinicia o Loop se a assinatura (`manifestSignature`) tiver mudado!
   *   Isto impede que um heartbeat ou uma alteração noutro ecrã interrompa a reprodução do Slot #2, #3, etc.
   */
  function applyEffectivePlayback(eff, forceRestart = false) {
    if (!eff) return;

    const newSignature = eff.manifestSignature || 'DEFAULT';
    if (!forceRestart && newSignature === currentManifestSignature) {
      return; // A playlist deste equipamento não mudou -> continua a tocar os restantes ficheiros sem interromper!
    }

    currentManifestSignature = newSignature;
    activeBrand = eff.activeBrand || 'FNAC';
    activePriority = eff.activePriority || 'NORMAL';
    activePlaylistName = eff.activePlaylistName || 'Programação Regular';
    activeSchedulingMode = eff.activeSchedulingMode || 'FIXED_SLOTS';

    const resolvedItems = eff.resolvedSequence || [];
    if (Array.isArray(resolvedItems) && resolvedItems.length > 0) {
      activeLoop = resolvedItems.map((item, idx) => {
        const remoteUrl = `${API_BASE}${item.streamUrl}`;
        return {
          id: item.id,
          playlistId: eff.activePlaylistId || 'aaaa0000-0000-0000-0000-000000000001',
          title: item.title,
          subtitle: `${activePlaylistName} • Item ${idx + 1} de ${resolvedItems.length} (${activeSchedulingMode === 'DYNAMIC_SOV' ? `SoV ${item.sovPct || 50}%` : `Slot #0${idx + 1}`}) • ${item.widthPx}x${item.heightPx} (${item.aspectRatio})`,
          badge: `ITEM ${idx + 1}/${resolvedItems.length} • ${item.mediaType} • ${activePriority}`,
          mediaType: item.mediaType,
          remoteUrl,
          streamUrl: blobUrlMap[remoteUrl] || remoteUrl,
          durationMs: Math.max(3000, Number(item.durationMs || 8000)),
          bgGradient: 'linear-gradient(135deg, #090d16 0%, #000000 100%)',
          accentColor: '#E1A924',
        };
      });
      lastSyncStatus = `Playlist "${activePlaylistName}" [${activePriority}] (${activeLoop.length} itens)`;
      preloadMediaBlobs(activeLoop);
    } else {
      activeLoop = [...fallbackSlides];
      lastSyncStatus = 'A exibir Slides Fallback (Nenhuma Playlist atribuída)';
    }

    currentIndex = 0;
    currentSlot = { ...activeLoop[0] };
    slotProgressPct = 0;
    slotElapsedMs = 0;
    playCurrentVideoIfAny();
    sendLiveHeartbeat();
  }

  function playCurrentVideoIfAny() {
    setTimeout(() => {
      if (currentSlot && currentSlot.mediaType === 'VIDEO' && videoElement) {
        try {
          videoElement.pause();
          videoElement.muted = true;
          const targetSrc =
            (currentSlot.remoteUrl && blobUrlMap[currentSlot.remoteUrl]) ||
            currentSlot.streamUrl;
          if (videoElement.getAttribute('src') !== targetSrc) {
            videoElement.setAttribute('src', targetSrc);
          }
          videoElement.currentTime = 0;
          videoElement.load();
          const p = videoElement.play();
          if (p && p.catch) p.catch(() => {});
        } catch {
          // ignore
        }
      }
    }, 40);
  }

  /**
   * Caso um ficheiro de media dê erro de rede ou descodificação, avança para o próximo slot
   * SEM registar um Proof of Play falso!
   */
  function handleMediaError() {
    if (isAdvancing || isCustomerUsingDevice || selectedTvCategory) return;
    isAdvancing = true;
    setTimeout(() => {
      currentIndex = (currentIndex + 1) % activeLoop.length;
      currentSlot = { ...activeLoop[currentIndex] };
      slotProgressPct = 0;
      slotElapsedMs = 0;
      playCurrentVideoIfAny();
      isAdvancing = false;
    }, 600);
  }

  function handleVideoMetadataLoaded() {
    if (videoElement && videoElement.duration && isFinite(videoElement.duration) && videoElement.duration > 0) {
      currentSlot.durationMs = Math.max(2000, Math.round(videoElement.duration * 1000));
    }
    if (videoElement && videoElement.paused) {
      videoElement.play().catch(() => {});
    }
  }

  function handleVideoTimeUpdate() {
    if (videoElement && videoElement.duration && isFinite(videoElement.duration) && videoElement.duration > 0) {
      slotProgressPct = Math.min(100, (videoElement.currentTime / videoElement.duration) * 100);
    }
  }

  /**
   * Avança para o próximo ficheiro da Playlist (Slot #1 -> Slot #2 -> Slot #3 -> ... -> Slot #1)
   */
  async function advanceSlotGapless() {
    if (isAdvancing || isCustomerUsingDevice || selectedTvCategory) return;
    isAdvancing = true;

    try {
      const finishedSlot = currentSlot;

      await recordLocalProofOfPlay({
        playlist_id: finishedSlot.playlistId,
        media_asset_id: finishedSlot.id,
        duration_ms: finishedSlot.durationMs,
      });

      fetch(`${API_BASE}/api/v1/live/telemetry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'POP',
          brand: activeBrand,
          playlistName: activePlaylistName,
          priority: activePriority,
          schedulingMode: activeSchedulingMode,
          mediaId: finishedSlot.id,
          mediaTitle: finishedSlot.title,
          durationMs: finishedSlot.durationMs,
        }),
      }).catch(() => {});

      await refreshTelemetryCounters();

      // Passa sequencialmente ao próximo item da lista (ou reinicia o vídeo se só houver 1 item)
      currentIndex = (currentIndex + 1) % activeLoop.length;
      currentSlot = { ...activeLoop[currentIndex] };
      slotProgressPct = 0;
      slotElapsedMs = 0;

      playCurrentVideoIfAny();
      sendLiveHeartbeat();
    } finally {
      setTimeout(() => {
        isAdvancing = false;
      }, 150);
    }
  }

  async function sendLiveHeartbeat() {
    try {
      const res = await fetch(`${API_BASE}/api/v1/live/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hardwareUid,
          pairingCode,
          name: deviceName,
          isPaired,
          userAgent: navigator.userAgent,
          brand: activeBrand,
          interactionMode,
          invert180,
          currentMediaTitle: selectedTvCategory
            ? selectedTvCategory.title
            : `${currentSlot ? currentSlot.title : 'Slide'} (${currentIndex + 1}/${activeLoop.length})`,
          currentMediaUrl: currentSlot ? currentSlot.streamUrl : null,
          currentMediaType: currentSlot ? currentSlot.mediaType : 'SLIDE',
          activePriority,
          currentSlotIndex: currentIndex + 1,
          totalSlotsInLoop: activeLoop.length,
          freeRomGb: Number((storageHealth.freeBytes / 1073741824).toFixed(1)),
          ntpOffsetMs,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.device && data.device.name) {
          deviceName = data.device.name;
          localStorage.setItem('invision_device_name', deviceName);
        }
        if (data.device && data.device.invert180 !== undefined) {
          invert180 = Boolean(data.device.invert180);
          localStorage.setItem('invision_invert_180', String(invert180));
        }
        if (data.device && data.device.status === 'ONLINE' && !isPaired) {
          isPaired = true;
          localStorage.setItem('invision_is_paired', 'true');
        }
        if (data.effectivePlayback) {
          applyEffectivePlayback(data.effectivePlayback, false);
        }
      }
    } catch {
      // Continua autónomo se sem rede
    }
  }

  async function handleCustomerTouchWake() {
    if (interactionMode !== 'IDLE_SCREENSAVER') return;

    if (!isCustomerUsingDevice) {
      isCustomerUsingDevice = true;
      engagementStartMs = Date.now();
      idleCountdown = idleTimeoutSec;
      await recordLocalInteraction({
        interaction_type: 'TOUCH_WAKE',
        reference_key: 'EXPO_DEVICE_WAKE',
        engaged_seconds: 0,
      });
      fetch(`${API_BASE}/api/v1/live/telemetry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'INTERACTION',
          brand: activeBrand,
          deviceCategory: 'SMARTPHONE_EXPO',
          interactionType: 'TOUCH_WAKE',
          referenceKey: `${deviceName} (Wake)`,
          engagedSeconds: 5,
        }),
      }).catch(() => {});
      await refreshTelemetryCounters();
    } else {
      idleCountdown = idleTimeoutSec;
    }
  }

  async function resumeScreensaverFromIdle() {
    if (!isCustomerUsingDevice) return;
    const engagedSec = Math.max(1, Math.round((Date.now() - engagementStartMs) / 1000));
    isCustomerUsingDevice = false;
    await recordLocalInteraction({
      interaction_type: 'TOUCH_WAKE',
      reference_key: 'EXPO_SESSION_COMPLETE',
      engaged_seconds: engagedSec,
    });
    await refreshTelemetryCounters();
  }

  async function selectTvDemoCategory(cat) {
    selectedTvCategory = cat;
    await recordLocalInteraction({
      interaction_type: 'TV_CATEGORY_SELECT',
      reference_key: cat.code,
      engaged_seconds: 30,
    });
    fetch(`${API_BASE}/api/v1/live/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'INTERACTION',
        brand: activeBrand,
        deviceCategory: 'TV_DEMO',
        interactionType: 'TV_CATEGORY_SELECT',
        referenceKey: `${cat.code} (${deviceName})`,
        engagedSeconds: 30,
      }),
    }).catch(() => {});
    await refreshTelemetryCounters();
    sendLiveHeartbeat();
  }

  function handleSecretCornerTap() {
    secretCornerClicks++;
    clearTimeout(secretClickTimeout);
    if (secretCornerClicks >= 5) {
      showOsd = !showOsd;
      secretCornerClicks = 0;
      refreshTelemetryCounters();
      return;
    }
    secretClickTimeout = setTimeout(() => {
      secretCornerClicks = 0;
    }, 2000);
  }

  function isBrowserCurrentlyFullscreen() {
    return Boolean(
      document.fullscreenElement ||
        document.webkitFullscreenElement ||
        document.mozFullScreenElement ||
        document.msFullscreenElement
    );
  }

  function enterBrowserFullscreen() {
    try {
      const docEl = document.documentElement;
      const bodyEl = document.body;
      if (docEl.requestFullscreen) {
        docEl.requestFullscreen({ navigationUI: 'hide' }).catch(() => {
          docEl.requestFullscreen().catch(() => {});
        });
      } else if (docEl.webkitRequestFullscreen) {
        docEl.webkitRequestFullscreen();
      } else if (docEl.webkitRequestFullScreen) {
        docEl.webkitRequestFullScreen();
      } else if (bodyEl && bodyEl.webkitRequestFullscreen) {
        bodyEl.webkitRequestFullscreen();
      }
      setTimeout(() => {
        isFullscreen = isBrowserCurrentlyFullscreen();
      }, 150);
    } catch {
      // ignore
    }
  }

  function handleUserActivationGesture() {
    if (!isBrowserCurrentlyFullscreen()) {
      enterBrowserFullscreen();
    }
    if (interactionMode === 'IDLE_SCREENSAVER') {
      handleCustomerTouchWake();
    }
  }

  function handleKeyDown(e) {
    // Qualquer tecla na Box Android garante entrada em Fullscreen nativo (esconde barra de endereço do Chrome)
    if (!isBrowserCurrentlyFullscreen() && e.key !== 'Escape') {
      enterBrowserFullscreen();
    }
    if (e.key === 'F12' || e.key === 'i' || e.key === 'I') {
      e.preventDefault();
      showOsd = !showOsd;
      refreshTelemetryCounters();
      return;
    }

    if (interactionMode === 'IDLE_SCREENSAVER') {
      handleCustomerTouchWake();
      return;
    }

    if (interactionMode === 'INTERACTIVE_CATALOG') {
      if (e.key === 'ArrowRight') {
        tvFocusedIndex = (tvFocusedIndex + 1) % tvDemoCategories.length;
      } else if (e.key === 'ArrowLeft') {
        tvFocusedIndex = (tvFocusedIndex - 1 + tvDemoCategories.length) % tvDemoCategories.length;
      } else if (e.key === 'Enter') {
        selectTvDemoCategory(tvDemoCategories[tvFocusedIndex]);
      } else if (e.key === 'Escape' || e.key === 'Backspace') {
        selectedTvCategory = null;
      }
    }
  }

  async function refreshTelemetryCounters() {
    storageHealth = await ensurePersistentStorage();
    const { popBuckets, interactionBuckets } = await getAllLocalTelemetry();
    totalLocalPlays = popBuckets.reduce((acc, b) => acc + b.play_count, 0);
    totalLocalInteractions = interactionBuckets.reduce((acc, b) => acc + b.interaction_count, 0);
  }

  function switchMode(mode) {
    interactionMode = mode;
    localStorage.setItem('invision_mode', mode);
    isCustomerUsingDevice = false;
    selectedTvCategory = null;
    sendLiveHeartbeat();
  }

  function connectLiveManifestSocket() {
    try {
      liveSocket = new WebSocket(WS_URL);
      liveSocket.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'MANIFEST_UPDATED' && msg.state && msg.state.effectivePlayback) {
            applyEffectivePlayback(msg.state.effectivePlayback, false);
          } else if (msg.type === 'DEVICE_PAIRED') {
            if (
              msg.pairingCode === pairingCode ||
              msg.hardwareUid === hardwareUid
            ) {
              isPaired = true;
              localStorage.setItem('invision_is_paired', 'true');
              if (msg.device && msg.device.name) {
                deviceName = msg.device.name;
                localStorage.setItem('invision_device_name', deviceName);
              }
              if (msg.device && msg.device.interactionMode) {
                switchMode(msg.device.interactionMode);
              }
              if (msg.device && msg.device.invert180 !== undefined) {
                invert180 = Boolean(msg.device.invert180);
                localStorage.setItem('invision_invert_180', String(invert180));
              }
              sendLiveHeartbeat();
            }
          }
        } catch {
          // ignore
        }
      };
      liveSocket.onclose = () => {
        setTimeout(connectLiveManifestSocket, 4000);
      };
    } catch {
      // ignore
    }
  }

  onMount(async () => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }

    // Garante que qualquer clique, toque ADB ou tecla na Box esconde imediatamente a barra superior do Chrome
    const syncFsState = () => {
      isFullscreen = isBrowserCurrentlyFullscreen();
    };
    const triggerFsOnGesture = () => {
      if (!isBrowserCurrentlyFullscreen()) {
        enterBrowserFullscreen();
      }
    };
    document.addEventListener('fullscreenchange', syncFsState);
    document.addEventListener('webkitfullscreenchange', syncFsState);
    document.addEventListener('click', triggerFsOnGesture, true);
    document.addEventListener('touchend', triggerFsOnGesture, true);
    document.addEventListener('mouseup', triggerFsOnGesture, true);

    try {
      const res = await fetch(
        `${API_BASE}/api/v1/live/state?hw_uid=${encodeURIComponent(hardwareUid)}`
      );
      if (res.ok) {
        const st = await res.json();
        if (st.effectivePlayback) {
          applyEffectivePlayback(st.effectivePlayback, true);
        }
      }
    } catch {
      // Offline
    }

    connectLiveManifestSocket();
    syncEngine.start();
    await refreshTelemetryCounters();
    await sendLiveHeartbeat();
    heartbeatTimer = setInterval(sendLiveHeartbeat, 4000);

    // Relógio de Progresso e Self-Healing Watchdog para Imagens, Slides e Vídeos (impede ecrã preto!)
    playbackTimer = setInterval(() => {
      if (isCustomerUsingDevice || selectedTvCategory || !isPaired || !currentSlot) return;
      const diag = syncEngine.getDiagnostics();
      ntpOffsetMs = diag.offsetMs;

      slotElapsedMs += 100;
      const targetDuration = Math.max(3000, Number(currentSlot.durationMs || 8000));

      if (currentSlot.mediaType === 'VIDEO') {
        // Se o Chrome pausou o vídeo ao entrar em Fullscreen ou num toque ADB, retoma automaticamente
        if (videoElement && videoElement.paused && !videoElement.ended && slotElapsedMs > 400) {
          videoElement.play().catch(() => {});
        }
        // Se o vídeo encravar ou exceder a sua duração + 2.5s de tolerância, avança automaticamente (nunca fica preto!)
        if (slotElapsedMs >= targetDuration + 2500) {
          advanceSlotGapless();
        }
      } else {
        slotProgressPct = Math.min(100, (slotElapsedMs / targetDuration) * 100);
        if (slotElapsedMs >= targetDuration) {
          advanceSlotGapless();
        }
      }
    }, 100);

    idleInterval = setInterval(() => {
      if (interactionMode === 'IDLE_SCREENSAVER' && isCustomerUsingDevice) {
        idleCountdown--;
        if (idleCountdown <= 0) {
          resumeScreensaverFromIdle();
        }
      }
    }, 1000);
  });

  onDestroy(() => {
    clearInterval(playbackTimer);
    clearInterval(idleInterval);
    clearInterval(heartbeatTimer);
    syncEngine.stop();
    if (liveSocket) liveSocket.close();
  });
</script>

<svelte:window on:keydown={handleKeyDown} />

<main
  class="player-root"
  class:cursor-none={interactionMode === 'PASSIVE' && !showOsd}
  class:invert-180={invert180}
  on:click={handleUserActivationGesture}
  on:touchend={handleUserActivationGesture}
  on:mouseup={handleUserActivationGesture}
>
  <button
    type="button"
    aria-label="Diagnostic OSD Trigger"
    class="secret-corner-trigger"
    on:click|stopPropagation={() => {
      if (!isBrowserCurrentlyFullscreen()) enterBrowserFullscreen();
      handleSecretCornerTap();
    }}
  ></button>

  {#if !isPaired}
    <section class="pairing-screen">
      <div class="pairing-card">
        <span class="badge-brand">INVISION NEXUS • ZERO-TOUCH PROVISIONING</span>
        <h1>Terminal Aguarda Emparelhamento</h1>
        <p>
          No Dashboard Central (<code>http://IP:4321</code>), clique em <strong>"Emparelhar"</strong> neste equipamento ou introduza o código único abaixo:
        </p>
        <div class="pairing-code-box">{pairingCode}</div>
        <div class="meta-row">
          <span>Hardware UID: <strong>{hardwareUid}</strong></span>
          <span>ROM Livre: <strong>{(storageHealth.freeBytes / 1073741824).toFixed(1)} GB</strong></span>
        </div>
        <button
          type="button"
          class="btn-simulate-pair"
          on:click={() => {
            isPaired = true;
            localStorage.setItem('invision_is_paired', 'true');
            sendLiveHeartbeat();
          }}
        >
          Desbloquear Localmente (Demo)
        </button>
      </div>
    </section>
  {:else}
    <!-- STAGE DE REPRODUÇÃO SEQUENCIAL (REUTILIZA O MESMO ELEMENTO VIDEO PARA NÃO ESGOTAR O DECODER DA BOX) -->
    <div class="dual-deck-stage">
      {#if !selectedTvCategory}
        <div class="video-deck deck-visible" style="background: {currentSlot.bgGradient};">
          {#if currentSlot.mediaType === 'IMAGE' && currentSlot.streamUrl}
            <img
              src={currentSlot.streamUrl}
              alt={currentSlot.title}
              class="fullscreen-media"
              on:error={handleMediaError}
            />
          {:else if currentSlot.mediaType === 'VIDEO' && currentSlot.streamUrl}
            <video
              bind:this={videoElement}
              src={currentSlot.streamUrl}
              muted
              playsinline
              autoplay
              preload="auto"
              class="fullscreen-media"
              on:loadedmetadata={handleVideoMetadataLoaded}
              on:timeupdate={handleVideoTimeUpdate}
              on:ended={advanceSlotGapless}
              on:error={handleMediaError}
              on:stalled={() => {
                if (videoElement) videoElement.play().catch(() => {});
              }}
            ></video>
          {/if}

          <div class="slot-content">
            {#if showHudBadges || currentSlot.mediaType === 'SLIDE'}
              <div class="top-badges">
                <span class="brand-pill">{activeBrand}</span>
                <span class="priority-pill">PRIORIDADE: {activePriority}</span>
                <span class="cache-pill">{currentSlot.badge}</span>
                <span class="deck-pill">{deviceName} ({hardwareUid})</span>
              </div>
            {/if}

            {#if currentSlot.mediaType === 'SLIDE'}
              <div class="center-hero">
                <h2>{currentSlot.title}</h2>
                <p>{currentSlot.subtitle}</p>
              </div>
            {:else if showHudBadges}
              <div class="media-caption">
                <strong>{currentSlot.title}</strong>
                <span>{currentSlot.subtitle}</span>
              </div>
            {/if}

            {#if showHudBadges || currentSlot.mediaType === 'SLIDE'}
              <div class="progress-bar-track">
                <div
                  class="progress-bar-fill"
                  style="width: {slotProgressPct}%; background: {currentSlot.accentColor};"
                ></div>
              </div>
            {/if}
          </div>
        </div>
      {:else}
        <div class="video-deck deck-visible" style="background: {selectedTvCategory.bgGradient};">
          <div class="slot-content">
            <div class="top-badges">
              <span class="brand-pill">MODO TV DEMO INTERATIVO</span>
              <span class="cache-pill">{selectedTvCategory.specs}</span>
            </div>
            <div class="center-hero">
              <h2>{selectedTvCategory.title}</h2>
              <p>A testar qualidade nativa do painel • Pressione ESC ou clique abaixo para voltar ao Loop</p>
            </div>
          </div>
        </div>
      {/if}
    </div>

    {#if interactionMode === 'IDLE_SCREENSAVER'}
      {#if !isCustomerUsingDevice}
        <div class="expo-touch-prompt">
          <span>👆 Toque no ecrã ou teclado para experimentar este equipamento</span>
        </div>
      {:else}
        <div class="expo-active-session">
          <div class="expo-card">
            <span class="expo-badge">MODO EXPERIÊNCIA CLIENTE ATIVO (TOUCH_WAKE REGISTADO)</span>
            <h3>Equipamento Desbloqueado para Teste</h3>
            <p>
              O screensaver promocional foi minimizado e a sessão de interação está a ser contabilizada localmente no IndexedDB.
            </p>
            <div class="countdown-box">
              Retoma automática do Loop de Preço/Vídeo após inatividade: <strong>{idleCountdown}s</strong>
            </div>
            <button type="button" class="btn-resume" on:click|stopPropagation={resumeScreensaverFromIdle}>
              Terminar Sessão & Retomar Screensaver Agora
            </button>
          </div>
        </div>
      {/if}
    {/if}

    {#if interactionMode === 'INTERACTIVE_CATALOG'}
      <div class="tv-catalog-dock">
        <div class="tv-dock-header">
          <span>TESTE A QUALIDADE DE IMAGEM DESTA TV (Use as Setas ◀ ▶ + OK ou Toque):</span>
          {#if selectedTvCategory}
            <button type="button" class="btn-exit-demo" on:click={() => (selectedTvCategory = null)}>
              ✕ Voltar à Playlist Normal
            </button>
          {/if}
        </div>
        <div class="tv-categories-row">
          {#each tvDemoCategories as cat, idx}
            <button
              type="button"
              class="tv-cat-btn"
              class:tv-cat-active={(selectedTvCategory && selectedTvCategory.code === cat.code) || tvFocusedIndex === idx}
              on:click={() => selectTvDemoCategory(cat)}
            >
              <strong>{cat.name}</strong>
              <small>{cat.specs}</small>
            </button>
          {/each}
        </div>
      </div>
    {/if}
  {/if}

  {#if showOsd}
    <aside class="osd-overlay" on:pointerdown|stopPropagation>
      <div class="osd-header">
        <div>
          <span class="osd-tag">HIDDEN OSD DIAGNOSTIC MENU • CÓDIGO: {pairingCode}</span>
          <h3>{deviceName} — UID: {hardwareUid}</h3>
        </div>
        <button type="button" class="osd-close" on:click={() => (showOsd = false)}>✕ Fechar</button>
      </div>

      <div class="osd-grid">
        <div class="osd-box">
          <span>Armazenamento Persistente (64GB ROM)</span>
          <strong>
            {storageHealth.persisted ? 'PERSISTED' : 'STANDARD'} • {(storageHealth.freeBytes / 1073741824).toFixed(2)} GB Livres
          </strong>
        </div>
        <div class="osd-box">
          <span>Posição Atual na Playlist</span>
          <strong>Item {currentIndex + 1} de {activeLoop.length} ({currentSlot.title})</strong>
        </div>
        <div class="osd-box">
          <span>Fila Local Proof of Play (IndexedDB)</span>
          <strong>{totalLocalPlays} exibições concluídas</strong>
        </div>
        <div class="osd-box">
          <span>Fila Local Touch / TV Demo</span>
          <strong>{totalLocalInteractions} interações registadas</strong>
        </div>
        <div class="osd-box">
          <span>Sincronização Relógio NTP / WS</span>
          <strong>Offset: {ntpOffsetMs} ms (Sincronizado)</strong>
        </div>
        <div class="osd-box">
          <span>Playlist Atribuída a este Terminal</span>
          <strong>{lastSyncStatus}</strong>
        </div>
      </div>

      <div class="osd-controls">
        <span>Controlos Rápidos do Técnico em Loja:</span>
        <div class="osd-btn-group">
          <button
            type="button"
            class:active={interactionMode === 'PASSIVE'}
            on:click={() => switchMode('PASSIVE')}
          >
            1. PASSIVE (Box X98 Plus / LEDwall)
          </button>
          <button
            type="button"
            class:active={interactionMode === 'IDLE_SCREENSAVER'}
            on:click={() => switchMode('IDLE_SCREENSAVER')}
          >
            2. IDLE_SCREENSAVER (Portátil / Smartphone Expo)
          </button>
          <button
            type="button"
            class:active={interactionMode === 'INTERACTIVE_CATALOG'}
            on:click={() => switchMode('INTERACTIVE_CATALOG')}
          >
            3. INTERACTIVE_CATALOG (TV Demo)
          </button>
          <button
            type="button"
            on:click={enterBrowserFullscreen}
          >
            ⛶ Forçar Ecrã Inteiro (Esconder Barra Chrome)
          </button>
          <button
            type="button"
            class:active={showHudBadges}
            on:click={() => (showHudBadges = !showHudBadges)}
          >
            {showHudBadges ? 'Ocultar Etiquetas HUD sobre Vídeo' : 'Mostrar Etiquetas HUD sobre Vídeo'}
          </button>
          <button
            type="button"
            on:click={advanceSlotGapless}
          >
            ⏭ Saltar para Próximo Vídeo/Imagem Agora
          </button>
          <button
            type="button"
            class:active={invert180}
            on:click={() => {
              invert180 = !invert180;
              localStorage.setItem('invision_invert_180', String(invert180));
              sendLiveHeartbeat();
            }}
          >
            🔄 {invert180 ? 'Ecrã Invertido 180° (Ativo)' : 'Inverter Ecrã 180° (Pernas p/ o Ar)'}
          </button>
          <button
            type="button"
            on:click={() => {
              isPaired = !isPaired;
              localStorage.setItem('invision_is_paired', String(isPaired));
              sendLiveHeartbeat();
            }}
          >
            Alternar Ecrã Pairing ({pairingCode})
          </button>
        </div>
      </div>
    </aside>
  {/if}
</main>

<style>
  .player-root {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    padding: 0;
    overflow: hidden;
    background: #000;
    transition: transform 0.3s ease;
  }
  .invert-180 {
    transform: rotate(180deg);
    transform-origin: center center;
  }
  .cursor-none {
    cursor: none;
  }
  .secret-corner-trigger {
    position: fixed;
    top: 0;
    left: 0;
    width: 110px;
    height: 110px;
    background: transparent;
    border: none;
    z-index: 90;
    cursor: inherit;
  }
  .dual-deck-stage {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    padding: 0;
    background: #000;
  }
  .video-deck {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    padding: 0;
    opacity: 0;
    pointer-events: none;
    overflow: hidden;
  }
  .deck-visible {
    opacity: 1;
    pointer-events: auto;
    z-index: 10;
  }
  .fullscreen-media {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    min-width: 100%;
    min-height: 100%;
    margin: 0;
    padding: 0;
    border: none;
    display: block;
    object-fit: cover;
    background: #000;
    z-index: 1;
  }
  .slot-content {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    padding: 2.5rem;
    z-index: 5;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    pointer-events: none;
  }
  .top-badges {
    display: flex;
    gap: 0.6rem;
    flex-wrap: wrap;
  }
  .brand-pill {
    background: #e1a924;
    color: #000;
    font-weight: 900;
    padding: 0.3rem 0.75rem;
    border-radius: 6px;
    font-size: 0.75rem;
  }
  .priority-pill,
  .cache-pill,
  .deck-pill {
    background: rgba(2, 6, 23, 0.78);
    border: 1px solid rgba(148, 163, 184, 0.35);
    color: #e2e8f0;
    padding: 0.3rem 0.75rem;
    border-radius: 6px;
    font-size: 0.72rem;
    font-family: monospace;
    backdrop-filter: blur(6px);
  }
  .center-hero h2 {
    font-size: clamp(2rem, 4vw, 3.75rem);
    font-weight: 900;
    letter-spacing: -0.02em;
    line-height: 1.1;
    max-width: 28ch;
  }
  .center-hero p {
    margin-top: 1rem;
    font-size: 1.05rem;
    color: #cbd5e1;
    font-family: monospace;
  }
  .media-caption {
    margin-top: auto;
    margin-bottom: 1rem;
    align-self: flex-start;
    background: rgba(2, 6, 23, 0.78);
    border: 1px solid rgba(255, 255, 255, 0.15);
    backdrop-filter: blur(8px);
    padding: 0.65rem 1rem;
    border-radius: 10px;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .media-caption strong {
    font-size: 0.95rem;
    color: #fff;
  }
  .media-caption span {
    font-size: 0.72rem;
    font-family: monospace;
    color: #94a3b8;
  }
  .progress-bar-track {
    width: 100%;
    height: 6px;
    background: rgba(255, 255, 255, 0.18);
    border-radius: 999px;
    overflow: hidden;
  }
  .progress-bar-fill {
    height: 100%;
    transition: width 0.1s linear;
  }

  /* Ecrã de Emparelhamento Zero-Touch */
  .pairing-screen {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: radial-gradient(circle at center, #1e293b 0%, #020617 100%);
    padding: 2rem;
  }
  .pairing-card {
    max-width: 580px;
    background: rgba(15, 23, 42, 0.9);
    border: 1px solid #334155;
    border-radius: 20px;
    padding: 2.5rem;
    text-align: center;
  }
  .badge-brand {
    font-size: 0.75rem;
    font-family: monospace;
    color: #e1a924;
    letter-spacing: 0.08em;
  }
  .pairing-card h1 {
    font-size: 1.8rem;
    margin-top: 0.5rem;
  }
  .pairing-card p {
    font-size: 0.9rem;
    color: #94a3b8;
    margin-top: 0.75rem;
    line-height: 1.5;
  }
  .pairing-code-box {
    margin: 1.75rem 0;
    padding: 1.25rem;
    font-size: 3rem;
    font-weight: 900;
    font-family: monospace;
    letter-spacing: 0.12em;
    color: #e1a924;
    background: #020617;
    border: 2px dashed #e1a924;
    border-radius: 14px;
  }
  .meta-row {
    display: flex;
    justify-content: space-between;
    font-size: 0.8rem;
    color: #94a3b8;
    margin-bottom: 1.5rem;
  }
  .btn-simulate-pair {
    background: #e1a924;
    color: #000;
    border: none;
    padding: 0.75rem 1.5rem;
    border-radius: 10px;
    font-weight: 800;
    cursor: pointer;
  }

  /* Modo IDLE_SCREENSAVER */
  .expo-touch-prompt {
    position: fixed;
    bottom: 2rem;
    right: 2rem;
    z-index: 30;
    background: rgba(14, 165, 233, 0.9);
    color: #000;
    font-weight: 800;
    padding: 0.85rem 1.5rem;
    border-radius: 999px;
    font-size: 0.9rem;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
  }
  .expo-active-session {
    position: fixed;
    inset: 0;
    z-index: 40;
    background: rgba(2, 6, 23, 0.92);
    backdrop-filter: blur(10px);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2rem;
  }
  .expo-card {
    max-width: 540px;
    background: #0f172a;
    border: 1px solid #0ea5e9;
    border-radius: 18px;
    padding: 2rem;
    text-align: center;
  }
  .expo-badge {
    font-size: 0.7rem;
    font-family: monospace;
    color: #38bdf8;
  }
  .expo-card h3 {
    font-size: 1.5rem;
    margin-top: 0.5rem;
  }
  .expo-card p {
    font-size: 0.9rem;
    color: #94a3b8;
    margin: 0.75rem 0 1.25rem;
  }
  .countdown-box {
    padding: 0.85rem;
    background: #020617;
    border-radius: 10px;
    font-family: monospace;
    color: #e2e8f0;
    margin-bottom: 1.25rem;
  }
  .btn-resume {
    background: #38bdf8;
    color: #000;
    font-weight: 800;
    border: none;
    padding: 0.75rem 1.25rem;
    border-radius: 10px;
    cursor: pointer;
  }

  /* Modo INTERACTIVE_CATALOG */
  .tv-catalog-dock {
    position: fixed;
    bottom: 1.5rem;
    left: 2rem;
    right: 2rem;
    z-index: 35;
    background: rgba(15, 23, 42, 0.92);
    border: 1px solid rgba(168, 85, 247, 0.45);
    backdrop-filter: blur(12px);
    border-radius: 16px;
    padding: 1.25rem;
  }
  .tv-dock-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 0.78rem;
    font-family: monospace;
    color: #d8b4fe;
    margin-bottom: 0.85rem;
  }
  .btn-exit-demo {
    background: rgba(244, 63, 94, 0.2);
    color: #fda4af;
    border: 1px solid rgba(244, 63, 94, 0.4);
    padding: 0.35rem 0.75rem;
    border-radius: 8px;
    cursor: pointer;
    font-size: 0.75rem;
  }
  .tv-categories-row {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 0.75rem;
  }
  .tv-cat-btn {
    background: #020617;
    border: 1px solid #334155;
    color: #f8fafc;
    padding: 0.85rem;
    border-radius: 12px;
    text-align: left;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .tv-cat-active {
    border-color: #e1a924;
    background: rgba(225, 169, 36, 0.15);
  }
  .tv-cat-btn small {
    font-size: 0.68rem;
    color: #94a3b8;
    font-family: monospace;
  }

  /* Hidden OSD Diagnostic Overlay */
  .osd-overlay {
    position: fixed;
    top: 1rem;
    left: 1rem;
    right: 1rem;
    max-height: 90vh;
    overflow-y: auto;
    z-index: 100;
    background: rgba(2, 6, 23, 0.96);
    border: 1px solid #e1a924;
    border-radius: 16px;
    padding: 1.25rem;
    box-shadow: 0 25px 50px rgba(0, 0, 0, 0.85);
  }
  .osd-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid #1e293b;
    padding-bottom: 0.85rem;
    margin-bottom: 1rem;
  }
  .osd-tag {
    font-size: 0.7rem;
    font-family: monospace;
    color: #e1a924;
  }
  .osd-close {
    background: #1e293b;
    color: #fff;
    border: none;
    padding: 0.45rem 0.9rem;
    border-radius: 8px;
    cursor: pointer;
  }
  .osd-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
    gap: 0.75rem;
    margin-bottom: 1rem;
  }
  .osd-box {
    background: #0f172a;
    border: 1px solid #1e293b;
    padding: 0.75rem;
    border-radius: 10px;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .osd-box span {
    font-size: 0.7rem;
    color: #94a3b8;
  }
  .osd-box strong {
    font-size: 0.82rem;
    font-family: monospace;
    color: #34d399;
  }
  .osd-controls {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    font-size: 0.75rem;
    color: #cbd5e1;
  }
  .osd-btn-group {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .osd-btn-group button {
    background: #1e293b;
    color: #e2e8f0;
    border: 1px solid #334155;
    padding: 0.5rem 0.85rem;
    border-radius: 8px;
    font-size: 0.75rem;
    cursor: pointer;
  }
  .osd-btn-group button.active {
    background: #e1a924;
    color: #000;
    font-weight: 800;
  }
</style>
