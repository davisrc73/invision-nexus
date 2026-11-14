/**
 * Motor de Sincronização Multi-Ecrã ao Milissegundo (Fase 5):
 * 1. Calibração de Relógio tipo NTP sobre WebSockets (calcula RTT e Clock Offset com filtro de mediana).
 * 2. Fallback Resiliente em Corte de WAN: Persiste o último offset e o declive de deriva do cristal
 *    (clockDriftSlope) em localStorage + suporta beacon HTTP/NTP do gateway local da loja.
 * 3. Deterministic Epoch Timecode: Todos os ecrãs de um SyncGroup calculam a posição exata no Loop
 *    através de `getSyncedEpochMs() % totalLoopDurationMs`.
 * 4. Micro-Pacing Impercetível:
 *    - Drift < 15ms: Em fase (playbackRate = 1.00)
 *    - Drift entre 15ms e 150ms: Ajuste suave de pitch/frame (`playbackRate = 1.02` ou `0.98`)
 *    - Drift > 150ms: Hard Seek imediato (`video.currentTime = targetSec`)
 */

export interface SyncSample {
  rttMs: number;
  offsetMs: number;
  timestamp: number;
}

export interface FrameSyncEvaluation {
  syncedEpochMs: number;
  loopPositionMs: number;
  activeSlotIndex: number;
  slotOffsetMs: number;
  driftMs: number;
  action: 'IN_LOCK' | 'MICRO_PACE_FAST' | 'MICRO_PACE_SLOW' | 'HARD_SEEK';
  recommendedPlaybackRate: number;
}

const STORAGE_OFFSET_KEY = 'invision_ntp_offset_ms';
const STORAGE_SLOPE_KEY = 'invision_ntp_drift_slope';

function safeNowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    const origin = performance.timeOrigin || Date.now() - performance.now();
    return origin + performance.now();
  }
  return Date.now();
}

export class MillisecondSyncEngine {
  private ws: WebSocket | null = null;
  private samples: SyncSample[] = [];
  private clockOffsetMs: number = Number(localStorage.getItem(STORAGE_OFFSET_KEY) || 0);
  private driftSlopePpm: number = Number(localStorage.getItem(STORAGE_SLOPE_KEY) || 0);
  private lastSyncWallTime: number = Date.now();
  private pingTimer: any = null;
  private isConnected = false;

  constructor(
    private readonly wsUrl: string,
    private readonly localGatewayFallbackUrl?: string
  ) {}

  public start(): void {
    this.connectWebSocket();
    this.pingTimer = setInterval(() => {
      this.sendNtpPing();
    }, 10_000);
  }

  public stop(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.ws) this.ws.close();
  }

  private connectWebSocket(): void {
    try {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => {
        this.isConnected = true;
        // Dispara rajada inicial de 4 pacotes NTP para calibração rápida no boot
        for (let i = 0; i < 4; i++) {
          setTimeout(() => this.sendNtpPing(), i * 350);
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'NTP_PONG') {
            this.processNtpPong(msg.client_t0, msg.server_t1, msg.server_t2);
          }
        } catch {
          // Ignora pacotes inválidos
        }
      };

      this.ws.onclose = () => {
        this.isConnected = false;
        // Tenta reconectar após 5s; enquanto offline usa a calibração persistida + gateway local
        setTimeout(() => this.connectWebSocket(), 5000);
      };
    } catch {
      this.isConnected = false;
    }
  }

  private async sendNtpPing(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: 'NTP_PING',
          client_t0: safeNowMs(),
        })
      );
      return;
    }

    // Fallback LAN: Se a WAN/Sede estiver inacessível mas existir gateway local na loja, mede Date header
    if (this.localGatewayFallbackUrl) {
      try {
        const t0 = safeNowMs();
        const res = await fetch(this.localGatewayFallbackUrl, {
          method: 'HEAD',
          cache: 'no-store',
        });
        const t3 = safeNowMs();
        const serverDateStr = res.headers.get('Date');
        if (serverDateStr) {
          const serverTime = new Date(serverDateStr).getTime();
          this.processNtpPong(t0, serverTime, serverTime, t3);
        }
      } catch {
        // Permanece em modo autónomo usando o clockOffsetMs + driftSlopePpm guardados
      }
    }
  }

  private processNtpPong(
    t0: number,
    t1: number,
    t2: number,
    customT3?: number
  ): void {
    const t3 = customT3 !== undefined ? customT3 : safeNowMs();
    const rttMs = t3 - t0 - (t2 - t1);
    const offsetMs = (t1 - t0 + (t2 - t3)) / 2;

    this.samples.push({ rttMs, offsetMs, timestamp: Date.now() });
    if (this.samples.length > 12) {
      this.samples.shift();
    }

    // Filtra as amostras com menor RTT (menor jitter de rede) e calcula a mediana do offset
    const sortedByRtt = [...this.samples].sort((a, b) => a.rttMs - b.rttMs);
    const bestHalf = sortedByRtt.slice(0, Math.max(1, Math.ceil(sortedByRtt.length / 2)));
    const avgOffset =
      bestHalf.reduce((acc, s) => acc + s.offsetMs, 0) / bestHalf.length;

    const elapsedHours = (Date.now() - this.lastSyncWallTime) / 3600000;
    if (elapsedHours > 0.05) {
      this.driftSlopePpm = (avgOffset - this.clockOffsetMs) / elapsedHours;
      localStorage.setItem(STORAGE_SLOPE_KEY, String(this.driftSlopePpm));
    }

    this.clockOffsetMs = Number(avgOffset.toFixed(2));
    this.lastSyncWallTime = Date.now();
    localStorage.setItem(STORAGE_OFFSET_KEY, String(this.clockOffsetMs));
  }

  /**
   * Devolve o tempo universal sincronizado ao milissegundo, compensando inclusive
   * a deriva do cristal da Box Android caso a loja esteja sem internet há várias horas.
   */
  public getSyncedEpochMs(): number {
    const now = safeNowMs();
    const hoursSinceLastSync = (Date.now() - this.lastSyncWallTime) / 3600000;
    const autonomousDriftCompensation = this.driftSlopePpm * hoursSinceLastSync;
    return Math.round(now + this.clockOffsetMs + autonomousDriftCompensation);
  }

  public getDiagnostics() {
    const lastRtt =
      this.samples.length > 0 ? this.samples[this.samples.length - 1].rttMs : 0;
    return {
      isConnected: this.isConnected,
      offsetMs: this.clockOffsetMs,
      rttMs: Number(lastRtt.toFixed(2)),
      driftSlopePpm: Number(this.driftSlopePpm.toFixed(3)),
    };
  }

  /**
   * Avalia a posição exata no Loop e determina se a Box X98 Plus deve manter playbackRate = 1.0,
   * aplicar Micro-Pacing (0.98 / 1.02) ou fazer Hard Seek (> 150ms).
   */
  public evaluateFrameSync(
    slotDurationsMs: number[],
    currentSlotIndex: number,
    currentSlotElapsedMs: number
  ): FrameSyncEvaluation {
    const totalLoopMs = slotDurationsMs.reduce((acc, d) => acc + d, 0);
    const syncedEpochMs = this.getSyncedEpochMs();
    const loopPositionMs = totalLoopMs > 0 ? syncedEpochMs % totalLoopMs : 0;

    let accumulated = 0;
    let targetSlotIndex = 0;
    let targetSlotOffsetMs = 0;

    for (let i = 0; i < slotDurationsMs.length; i++) {
      const dur = slotDurationsMs[i];
      if (loopPositionMs < accumulated + dur) {
        targetSlotIndex = i;
        targetSlotOffsetMs = loopPositionMs - accumulated;
        break;
      }
      accumulated += dur;
    }

    // Calcula o desvio (drift) entre o tempo real do reprodutor local e o tempo alvo determinístico
    const actualGlobalPos =
      slotDurationsMs.slice(0, currentSlotIndex).reduce((a, b) => a + b, 0) +
      currentSlotElapsedMs;

    let driftMs = actualGlobalPos - loopPositionMs;
    if (driftMs > totalLoopMs / 2) driftMs -= totalLoopMs;
    if (driftMs < -totalLoopMs / 2) driftMs += totalLoopMs;

    const absDrift = Math.abs(driftMs);

    if (absDrift > 150 || targetSlotIndex !== currentSlotIndex) {
      return {
        syncedEpochMs,
        loopPositionMs,
        activeSlotIndex: targetSlotIndex,
        slotOffsetMs: targetSlotOffsetMs,
        driftMs,
        action: 'HARD_SEEK',
        recommendedPlaybackRate: 1.0,
      };
    }

    if (driftMs > 15) {
      // Player está adiantado face ao corredor -> abranda ligeiramente (0.98x)
      return {
        syncedEpochMs,
        loopPositionMs,
        activeSlotIndex: targetSlotIndex,
        slotOffsetMs: targetSlotOffsetMs,
        driftMs,
        action: 'MICRO_PACE_SLOW',
        recommendedPlaybackRate: 0.98,
      };
    }

    if (driftMs < -15) {
      // Player está atrasado face ao corredor -> acelera ligeiramente (1.02x)
      return {
        syncedEpochMs,
        loopPositionMs,
        activeSlotIndex: targetSlotIndex,
        slotOffsetMs: targetSlotOffsetMs,
        driftMs,
        action: 'MICRO_PACE_FAST',
        recommendedPlaybackRate: 1.02,
      };
    }

    return {
      syncedEpochMs,
      loopPositionMs,
      activeSlotIndex: targetSlotIndex,
      slotOffsetMs: targetSlotOffsetMs,
      driftMs,
      action: 'IN_LOCK',
      recommendedPlaybackRate: 1.0,
    };
  }
}

