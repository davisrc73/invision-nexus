import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_PLAYER_PORT = Number(process.env.PUBLIC_PLAYER_PORT || 5174);
const STORAGE_DIR = path.resolve(process.env.MEDIA_STORAGE_PATH || './data/storage/media');
const STATE_FILE = path.resolve(process.env.STATE_FILE_PATH || './data/storage/live_state.json');

fs.mkdirSync(STORAGE_DIR, { recursive: true });
fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });

const PRIORITY_RANK = {
  EXCLUSIVA: 4,
  PRIORITARIA: 3,
  NORMAL: 2,
  FALLBACK: 1,
};

function createDefaultState() {
  return {
    brand: 'FNAC',
    mediaCatalog: [],
    playlists: [
      {
        id: 'pl-normal-default',
        name: 'Programação Regular Loja (Normal)',
        brand: 'FNAC',
        priority: 'NORMAL',
        schedulingMode: 'FIXED_SLOTS',
        screenProfile: '16:9',
        targetDeviceIds: [], // Vazio = Toca em TODOS os equipamentos emparelhados
        daypartStart: '00:00',
        daypartEnd: '23:59',
        isActive: true,
        items: [],
      },
      {
        id: 'pl-prioritaria-default',
        name: 'Campanha Prioritária Fornecedor',
        brand: 'FNAC',
        priority: 'PRIORITARIA',
        schedulingMode: 'DYNAMIC_SOV',
        screenProfile: '16:9',
        targetDeviceIds: [],
        daypartStart: '00:00',
        daypartEnd: '23:59',
        isActive: false,
        items: [],
      },
      {
        id: 'pl-exclusiva-default',
        name: 'Flash Sale / Takeover (Exclusiva)',
        brand: 'FNAC',
        priority: 'EXCLUSIVA',
        schedulingMode: 'FIXED_SLOTS',
        screenProfile: '16:9',
        targetDeviceIds: [],
        daypartStart: '00:00',
        daypartEnd: '23:59',
        isActive: false,
        items: [],
      },
      {
        id: 'pl-fallback-default',
        name: 'Fallback Institucional Segurança',
        brand: 'FNAC',
        priority: 'FALLBACK',
        schedulingMode: 'FIXED_SLOTS',
        screenProfile: '16:9',
        targetDeviceIds: [],
        daypartStart: '00:00',
        daypartEnd: '23:59',
        isActive: true,
        items: [],
      },
    ],
    devices: [],
    adbBoxes: [],
    incidents: [],
    popRecords: [],
    interactionRecords: [],
    updatedAt: new Date().toISOString(),
  };
}

let state = createDefaultState();

if (fs.existsSync(STATE_FILE)) {
  try {
    const loaded = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    state = {
      ...createDefaultState(),
      ...loaded,
    };
    if (!Array.isArray(state.adbBoxes)) {
      state.adbBoxes = [];
    }
    for (const pl of state.playlists) {
      if (!Array.isArray(pl.targetDeviceIds)) {
        pl.targetDeviceIds = [];
      }
    }
  } catch {
    state = createDefaultState();
  }
}

/**
 * Gera sequência intercalada para Playlists em modo DYNAMIC_SOV (Weighted Round-Robin)
 */
function buildDynamicSovSequence(items, totalLoopSlots = 10) {
  if (!Array.isArray(items) || items.length === 0) return [];
  if (items.length === 1) return [{ ...items[0], sequenceSlot: 1 }];

  const totalWeight = items.reduce((acc, it) => acc + Math.max(1, Number(it.sovPct || 25)), 0);
  const buckets = items.map((it) => ({
    item: it,
    step: Math.max(1, Number(it.sovPct || 25)) / totalWeight,
    current: 0,
  }));

  const seq = [];
  for (let i = 0; i < totalLoopSlots; i++) {
    let best = buckets[0];
    for (const b of buckets) {
      b.current += b.step;
      if (b.current > best.current) {
        best = b;
      }
    }
    best.current -= 1.0;
    seq.push({
      ...best.item,
      sequenceSlot: i + 1,
    });
  }
  return seq;
}

/**
 * Calcula a Playlist Dominante para um equipamento específico (`hardwareUid` ou global se omitido):
 * - Respeita `targetDeviceIds`: se uma playlist tiver `targetDeviceIds` preenchido, só se aplica a esses equipamentos;
 *   se estiver vazio `[]`, aplica-se a todos os equipamentos.
 * - Ordena por prioridade estrita: EXCLUSIVA > PRIORITARIA > NORMAL > FALLBACK.
 * - Gera um `manifestSignature` determinístico para que o Player NUNCA reinicie o Loop se os itens não mudaram!
 */
function computeEffectivePlaybackForDevice(hardwareUid = null) {
  const nowHm = new Date().toTimeString().slice(0, 5);

  const candidates = (state.playlists || []).filter((pl) => {
    if (!pl.isActive) return false;
    if (!Array.isArray(pl.items) || pl.items.length === 0) return false;
    const start = pl.daypartStart || '00:00';
    const end = pl.daypartEnd || '23:59';
    if (nowHm < start || nowHm > end) return false;

    if (
      hardwareUid &&
      Array.isArray(pl.targetDeviceIds) &&
      pl.targetDeviceIds.length > 0 &&
      !pl.targetDeviceIds.includes(hardwareUid)
    ) {
      return false;
    }
    return true;
  });

  candidates.sort(
    (a, b) => (PRIORITY_RANK[b.priority] || 1) - (PRIORITY_RANK[a.priority] || 1)
  );

  const winningPlaylist = candidates[0] || null;
  if (!winningPlaylist) {
    return {
      manifestSignature: 'FALLBACK_DEFAULT',
      activePlaylistId: null,
      activePlaylistName: 'Fallback Demo Integrado',
      activePriority: 'FALLBACK',
      activeSchedulingMode: 'FIXED_SLOTS',
      activeBrand: state.brand || 'FNAC',
      resolvedSequence: [],
    };
  }

  const resolvedSequence =
    winningPlaylist.schedulingMode === 'DYNAMIC_SOV'
      ? buildDynamicSovSequence(winningPlaylist.items, 10)
      : winningPlaylist.items.map((it, idx) => ({
          ...it,
          sequenceSlot: idx + 1,
        }));

  const signaturePayload = JSON.stringify({
    plId: winningPlaylist.id,
    prio: winningPlaylist.priority,
    mode: winningPlaylist.schedulingMode,
    items: resolvedSequence.map((i) => `${i.id}:${i.durationMs}:${i.sovPct || 50}`),
  });
  const manifestSignature = crypto
    .createHash('md5')
    .update(signaturePayload)
    .digest('hex');

  return {
    manifestSignature,
    activePlaylistId: winningPlaylist.id,
    activePlaylistName: winningPlaylist.name,
    activePriority: winningPlaylist.priority,
    activeSchedulingMode: winningPlaylist.schedulingMode,
    activeBrand: winningPlaylist.brand || state.brand || 'FNAC',
    resolvedSequence,
  };
}

function getEnrichedState(hardwareUid = null) {
  const now = Date.now();
  for (const d of state.devices) {
    const lastMs = new Date(d.lastSeenAt || 0).getTime();
    if (d.status !== 'PENDING_APPROVAL') {
      d.status = now - lastMs > 90_000 ? 'OFFLINE' : 'ONLINE';
    }
  }
  const effective = computeEffectivePlaybackForDevice(hardwareUid);
  return {
    ...state,
    publicPlayerPort: PUBLIC_PLAYER_PORT,
    effectivePlayback: effective,
    playlistItems: effective.resolvedSequence,
  };
}

function saveState() {
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ============================================================================
// MOTOR DE PROVISIONAMENTO KIOSK ADB & WATCHDOG PÓS-REBOOT INTEGRADO NO BACKEND
// ============================================================================
function findAdbBinary() {
  const candidates = [
    '/usr/bin/adb',
    '/opt/homebrew/bin/adb',
    '/usr/local/bin/adb',
    path.resolve('./tools/linux/platform-tools/adb'),
    path.resolve('./tools/darwin/platform-tools/adb'),
    path.resolve('./tools/platform-tools/adb'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return 'adb';
}

function runAdb(args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const adbBin = findAdbBinary();
    execFile(
      adbBin,
      args,
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: String(stdout || '').trim(),
          stderr: String(stderr || '').trim(),
          error: err ? err.message : null,
        });
      }
    );
  });
}

async function launchChromeSingleTabOnBox(target, cleanUrl) {
  await runAdb(['-s', target, 'shell', 'am', 'clear-debug-app']);
  await runAdb(['-s', target, 'shell', 'rm', '-f', '/data/local/tmp/chrome-command-line']);
  await runAdb([
    '-s',
    target,
    'shell',
    'settings',
    'put',
    'global',
    'policy_control',
    'immersive.full=*',
  ]);

  // Usa application_id fixo e create_new_tab=false para reutilizar sempre a mesma Tab sem abrir novas tabs!
  const launchRes = await runAdb([
    '-s',
    target,
    'shell',
    'am',
    'start',
    '-a',
    'android.intent.action.VIEW',
    '-c',
    'android.intent.category.BROWSABLE',
    '-f',
    '0x14000000',
    '--es',
    'com.android.browser.application_id',
    'com.invision.nexus.kiosk',
    '--ez',
    'create_new_tab',
    'false',
    '-d',
    cleanUrl,
    'com.android.chrome',
  ]);
  if (!launchRes.ok) {
    await runAdb([
      '-s',
      target,
      'shell',
      'am',
      'start',
      '-a',
      'android.intent.action.VIEW',
      '-d',
      cleanUrl,
    ]);
  }

  setTimeout(async () => {
    await runAdb(['-s', target, 'shell', 'input', 'tap', '960', '540']);
    setTimeout(async () => {
      await runAdb(['-s', target, 'shell', 'input', 'tap', '960', '540']);
    }, 2000);
  }, 3500);
}

async function provisionAdbBox(boxIp, rawPlayerUrl, autoWatchdog = true) {
  const logs = [];
  const cleanIp = String(boxIp || '').trim();
  const cleanUrl = String(rawPlayerUrl || '').trim().replace(/\/+$/, '');

  if (!cleanIp) {
    return { ok: false, error: 'IP da Box Android em falta.', logs };
  }
  if (!cleanUrl || cleanUrl.includes('://:') || !/^https?:\/\/[^/:]+/.test(cleanUrl)) {
    return {
      ok: false,
      error: `URL do Player inválido (${cleanUrl}). Indique ex: http://192.168.68.117:5174`,
      logs,
    };
  }

  logs.push(`==> [1/6] A ligar à Box Android X98 Plus em ${cleanIp}:5555...`);
  const conn = await runAdb(['connect', `${cleanIp}:5555`]);
  logs.push(`    ${conn.stdout || conn.stderr || 'Comando connect enviado'}`);

  const devs = await runAdb(['devices']);
  const isAuthorized = devs.stdout
    .split('\n')
    .some((line) => line.includes(`${cleanIp}:5555`) && /\bdevice\b/.test(line));

  if (!isAuthorized) {
    logs.push(
      `⚠️  A Box ${cleanIp}:5555 ainda não aceitou a ligação ou mostra popup 'Permitir depuração USB?' na TV.`
    );
    return {
      ok: false,
      error: `Não foi possível autenticar em ${cleanIp}:5555. Verifique na TV se apareceu a janela 'Permitir depuração USB?' e clique em OK!`,
      logs,
    };
  }

  const target = `${cleanIp}:5555`;
  logs.push(`==> [2/6] A ativar ADB persistente no arranque (porta 5555) e desativar Sleep / Standby CEC...`);
  await runAdb(['-s', target, 'shell', 'setprop', 'persist.adb.tcp.port', '5555']);
  await runAdb(['-s', target, 'shell', 'setprop', 'service.adb.tcp.port', '5555']);
  await runAdb(['-s', target, 'shell', 'settings', 'put', 'global', 'stay_on_while_plugged_in', '7']);
  await runAdb(['-s', target, 'shell', 'settings', 'put', 'system', 'screen_off_timeout', '2147483647']);
  await runAdb(['-s', target, 'shell', 'settings', 'put', 'secure', 'sleep_timeout', '-1']);
  await runAdb(['-s', target, 'shell', 'settings', 'put', 'secure', 'screensaver_enabled', '0']);
  await runAdb(['-s', target, 'shell', 'settings', 'put', 'global', 'hdmi_control_auto_device_off_enabled', '0']);
  await runAdb(['-s', target, 'shell', 'settings', 'put', 'global', 'wifi_sleep_policy', '2']);

  logs.push(`==> [3/6] A ativar Immersive Mode (Full Kiosk) e silenciar notificações...`);
  await runAdb(['-s', target, 'shell', 'settings', 'put', 'global', 'heads_up_notifications_enabled', '0']);
  await runAdb(['-s', target, 'shell', 'settings', 'put', 'global', 'policy_control', 'immersive.full=*']);

  logs.push(`==> [4/6] A abrir o Player PWA (${cleanUrl}) numa única Tab limpa e ativar Fullscreen...`);
  await launchChromeSingleTabOnBox(target, cleanUrl);

  const nowIso = new Date().toISOString();
  const existing = state.adbBoxes.find((b) => b.boxIp === cleanIp);
  if (existing) {
    existing.playerUrl = cleanUrl;
    existing.autoWatchdog = Boolean(autoWatchdog);
    existing.status = 'ONLINE (Chrome Kiosk)';
    existing.lastProvisionedAt = nowIso;
    existing.lastCheckedAt = nowIso;
    existing.lastLaunchMs = Date.now();
    existing.lastLog = logs.join('\n');
  } else {
    state.adbBoxes.push({
      boxIp: cleanIp,
      playerUrl: cleanUrl,
      autoWatchdog: Boolean(autoWatchdog),
      status: 'ONLINE (Chrome Kiosk)',
      lastProvisionedAt: nowIso,
      lastCheckedAt: nowIso,
      lastLaunchMs: Date.now(),
      lastLog: logs.join('\n'),
    });
  }

  saveState();
  broadcastUpdate();
  logs.push(`✅ Box ${cleanIp} provisionada com sucesso em ${cleanUrl}!`);
  return { ok: true, logs, state: getEnrichedState() };
}

let isWatchdogRunning = false;
async function runKioskWatchdogCycle() {
  if (isWatchdogRunning || !Array.isArray(state.adbBoxes) || state.adbBoxes.length === 0) return;
  isWatchdogRunning = true;
  try {
    let changed = false;
    for (const box of state.adbBoxes) {
      if (!box.boxIp || box.autoWatchdog === false) continue;
      const target = `${box.boxIp}:5555`;
      await runAdb(['connect', target], 4000);
      const devs = await runAdb(['devices'], 4000);
      const isOnline = devs.stdout
        .split('\n')
        .some((line) => line.includes(target) && /\bdevice\b/.test(line));

      box.lastCheckedAt = new Date().toISOString();

      if (!isOnline) {
        if (box.status !== 'OFFLINE / REBOOTING') {
          box.status = 'OFFLINE / REBOOTING';
          changed = true;
        }
        continue;
      }

      // Verifica se o Android já terminou o arranque (sys.boot_completed == 1)
      const bootRes = await runAdb(['-s', target, 'shell', 'getprop', 'sys.boot_completed'], 4000);
      if (bootRes.stdout.trim() !== '1') {
        continue;
      }

      // Verifica de forma ultra-rápida qual a Activity em primeiro plano na TV e se o processo Chrome existe
      const actRes = await runAdb(
        [
          '-s',
          target,
          'shell',
          'dumpsys activity activities | grep -iE "ResumedActivity|mFocusedApp" | head -n 4; echo "CHROME_PID:$(pidof com.android.chrome)"',
        ],
        5000
      );

      const out = actRes.stdout || '';
      const hasChromePid = !out.includes('CHROME_PID:') || /CHROME_PID:\s*[0-9]+/.test(out);
      const resumedLines = out
        .split('\n')
        .filter((l) => /ResumedActivity|mFocusedApp/i.test(l))
        .join(' ');
      const isChromeInForeground =
        hasChromePid &&
        resumedLines.length > 0 &&
        resumedLines.includes('com.android.chrome');

      const sinceLastLaunchMs = Date.now() - Number(box.lastLaunchMs || 0);

      if (!isChromeInForeground && !resumedLines.includes('com.android.systemui') && sinceLastLaunchMs > 18000) {
        // A Box reiniciou para o Desktop do Android (Launcher) ou o Chrome fechou!
        // Abre automaticamente o Chrome no URL do Player!
        box.lastLaunchMs = Date.now();
        await launchChromeSingleTabOnBox(target, box.playerUrl);
        box.status = 'AUTO-RECOVERED (Pós-Boot)';
        changed = true;
      } else if (isChromeInForeground && box.status !== 'ONLINE (Chrome Kiosk)') {
        box.status = 'ONLINE (Chrome Kiosk)';
        changed = true;
      }
    }
    if (changed) {
      saveState();
      broadcastUpdate();
    }
  } catch {
    // ignore watchdog errors
  } finally {
    isWatchdogRunning = false;
  }
}

setInterval(runKioskWatchdogCycle, 12000);

// Clientes WebSocket ativos
const wsClients = new Set();

function encodeWsFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function decodeWsFrame(buf) {
  if (buf.length < 2) return null;
  const isMasked = (buf[1] & 0x80) !== 0;
  let payloadLen = buf[1] & 0x7f;
  let offset = 2;
  if (payloadLen === 126) {
    payloadLen = buf.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    payloadLen = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  let maskKey = null;
  if (isMasked) {
    maskKey = buf.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buf.length < offset + payloadLen) return null;
  const data = Buffer.from(buf.subarray(offset, offset + payloadLen));
  if (isMasked && maskKey) {
    for (let i = 0; i < data.length; i++) {
      data[i] ^= maskKey[i % 4];
    }
  }
  return data.toString('utf8');
}

function broadcastUpdate(customEvent) {
  for (const sock of wsClients) {
    try {
      const hwUid = sock.hardwareUid || null;
      const payload = customEvent || {
        type: 'MANIFEST_UPDATED',
        state: getEnrichedState(hwUid),
      };
      sock.write(encodeWsFrame(JSON.stringify(payload)));
    } catch {
      wsClients.delete(sock);
    }
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range, X-Device-Token');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, ETag');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  // 1. GET /api/v1/live/state?hw_uid=...
  if (req.method === 'GET' && url.pathname === '/api/v1/live/state') {
    const hwUid = url.searchParams.get('hw_uid') || null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getEnrichedState(hwUid)));
    return;
  }

  // 2. POST /api/v1/live/upload
  if (req.method === 'POST' && url.pathname === '/api/v1/live/upload') {
    const fileName = decodeURIComponent(url.searchParams.get('filename') || 'media.mp4');
    const title = decodeURIComponent(url.searchParams.get('title') || fileName);
    const brand = url.searchParams.get('brand') || 'FNAC';
    const mimeType = url.searchParams.get('mime') || 'video/mp4';
    const widthPx = Number(url.searchParams.get('width') || 1920);
    const heightPx = Number(url.searchParams.get('height') || 1080);
    const durationMs = Number(url.searchParams.get('duration_ms') || 10000);
    const aspectRatio = url.searchParams.get('ratio') || '16:9';

    const ext = path.extname(fileName) || (mimeType.startsWith('image/') ? '.jpg' : '.mp4');
    const id = crypto.randomUUID();
    const diskFileName = `${id}${ext}`;
    const fullPath = path.join(STORAGE_DIR, diskFileName);

    const hash = crypto.createHash('sha256');
    let fileSize = 0;
    const writeStream = fs.createWriteStream(fullPath);

    req.on('data', (chunk) => {
      fileSize += chunk.length;
      hash.update(chunk);
      writeStream.write(chunk);
    });

    req.on('end', () => {
      writeStream.end();
      const sha256 = hash.digest('hex');
      const newAsset = {
        id,
        brand,
        title,
        fileName,
        diskFileName,
        mimeType,
        mediaType: mimeType.startsWith('image/') ? 'IMAGE' : 'VIDEO',
        widthPx,
        heightPx,
        aspectRatio,
        durationMs: mimeType.startsWith('image/') ? durationMs : Math.max(2000, durationMs),
        fileSizeBytes: fileSize,
        sha256,
        streamUrl: `/api/v1/media/${id}/stream`,
        createdAt: new Date().toISOString(),
      };

      state.mediaCatalog.unshift(newAsset);
      saveState();
      broadcastUpdate();

      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(newAsset));
    });
    return;
  }

  // 3. POST /api/v1/live/playlists
  if (req.method === 'POST' && url.pathname === '/api/v1/live/playlists') {
    try {
      const payload = await readJsonBody(req);
      if (payload.brand) state.brand = payload.brand;
      if (Array.isArray(payload.playlists)) {
        state.playlists = payload.playlists;
      }
      saveState();
      broadcastUpdate();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getEnrichedState()));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'INVALID_JSON' }));
    }
    return;
  }

  // 4. POST /api/v1/live/heartbeat -> Regista múltiplas Boxes Android / Telemóvel / Mac
  if (req.method === 'POST' && url.pathname === '/api/v1/live/heartbeat') {
    try {
      const payload = await readJsonBody(req);
      const hwUid = payload.hardwareUid || 'UNKNOWN-DEVICE';
      let dev = state.devices.find((d) => d.hardwareUid === hwUid);

      if (!dev) {
        const ua = payload.userAgent || '';
        const isAndroid = /Android/i.test(ua);
        const isMobile = /iPhone|iPad|Mobile/i.test(ua) && !isAndroid;
        const devNumber = state.devices.length + 1;

        dev = {
          id: crypto.randomUUID(),
          hardwareUid: hwUid,
          pairingCode: payload.pairingCode || `NX-${100000 + devNumber}`,
          name:
            payload.name ||
            (isAndroid
              ? `Box Android #${devNumber} (${hwUid})`
              : isMobile
              ? `Telemóvel / Tablet #${devNumber} (${hwUid})`
              : `Player Mac #${devNumber} (${hwUid})`),
          brand: payload.brand || state.brand || 'FNAC',
          storeName: payload.storeName || 'FNAC Colombo (Lisboa)',
          zone: payload.zone || (isMobile ? 'TELECOM_MOBILES' : 'ENTRANCE_LEDWALL'),
          category:
            payload.category ||
            (isAndroid ? 'ANDROID_BOX' : isMobile ? 'SMARTPHONE_EXPO' : 'LEDWALL'),
          interactionMode: payload.interactionMode || 'PASSIVE',
          screenProfile: payload.screenProfile || '1920x1080 (16:9)',
          status: payload.isPaired === false ? 'PENDING_APPROVAL' : 'ONLINE',
          currentMediaTitle: payload.currentMediaTitle || 'Em Reprodução',
          currentMediaUrl: payload.currentMediaUrl || null,
          currentMediaType: payload.currentMediaType || 'SLIDE',
          activePriority: payload.activePriority || 'NORMAL',
          currentSlotIndex: payload.currentSlotIndex ?? 1,
          totalSlotsInLoop: payload.totalSlotsInLoop ?? 1,
          freeRomGb: payload.freeRomGb || 58.4,
          ntpOffsetMs: payload.ntpOffsetMs || 1.2,
          lastSeenAt: new Date().toISOString(),
        };
        state.devices.push(dev);
      } else {
        dev.pairingCode = payload.pairingCode || dev.pairingCode;
        dev.status = payload.isPaired === false ? 'PENDING_APPROVAL' : 'ONLINE';
        dev.interactionMode = payload.interactionMode || dev.interactionMode;
        dev.currentMediaTitle = payload.currentMediaTitle || dev.currentMediaTitle;
        dev.currentMediaUrl =
          payload.currentMediaUrl !== undefined ? payload.currentMediaUrl : dev.currentMediaUrl;
        dev.currentMediaType = payload.currentMediaType || dev.currentMediaType;
        dev.activePriority = payload.activePriority || dev.activePriority;
        dev.currentSlotIndex = payload.currentSlotIndex ?? dev.currentSlotIndex;
        dev.totalSlotsInLoop = payload.totalSlotsInLoop ?? dev.totalSlotsInLoop;
        dev.freeRomGb = payload.freeRomGb ?? dev.freeRomGb;
        dev.ntpOffsetMs = payload.ntpOffsetMs ?? dev.ntpOffsetMs;
        dev.lastSeenAt = new Date().toISOString();
      }

      saveState();
      const effectiveForThisDevice = computeEffectivePlaybackForDevice(hwUid);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'OK',
          device: dev,
          effectivePlayback: effectiveForThisDevice,
        })
      );
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'INVALID_HEARTBEAT' }));
    }
    return;
  }

  // 5. POST /api/v1/live/pairing/approve -> Emparelha ou configura qualquer uma das Boxes Android
  if (req.method === 'POST' && url.pathname === '/api/v1/live/pairing/approve') {
    try {
      const payload = await readJsonBody(req);
      const code = (payload.pairingCode || '').trim().toUpperCase();
      let dev = state.devices.find(
        (d) =>
          (d.pairingCode || '').toUpperCase() === code ||
          (d.hardwareUid || '').toUpperCase() === code
      );

      const resolvedMode =
        payload.interactionMode ||
        (payload.category === 'TV_DEMO'
          ? 'INTERACTIVE_CATALOG'
          : ['LAPTOP_EXPO', 'TABLET_EXPO', 'SMARTPHONE_EXPO'].includes(payload.category)
          ? 'IDLE_SCREENSAVER'
          : 'PASSIVE');

      if (!dev) {
        dev = {
          id: crypto.randomUUID(),
          hardwareUid: code || `BOX-${Math.floor(1000 + Math.random() * 9000)}`,
          pairingCode: code,
          name: payload.name || 'Box Android X98 Plus',
          brand: payload.brand || 'FNAC',
          storeName: payload.storeName || 'FNAC Colombo',
          zone: payload.zone || 'ENTRANCE_LEDWALL',
          category: payload.category || 'ANDROID_BOX',
          interactionMode: resolvedMode,
          screenProfile: payload.screenProfile || '1920x1080 (16:9)',
          status: 'ONLINE',
          currentMediaTitle: 'Emparelhado — A iniciar Loop',
          currentMediaUrl: null,
          currentMediaType: 'SLIDE',
          activePriority: 'NORMAL',
          freeRomGb: 58.4,
          ntpOffsetMs: 1.0,
          lastSeenAt: new Date().toISOString(),
        };
        state.devices.push(dev);
      } else {
        dev.name = payload.name || dev.name;
        dev.storeName = payload.storeName || dev.storeName;
        dev.zone = payload.zone || dev.zone;
        dev.category = payload.category || dev.category;
        dev.interactionMode = resolvedMode;
        dev.screenProfile = payload.screenProfile || dev.screenProfile;
        dev.status = 'ONLINE';
        dev.lastSeenAt = new Date().toISOString();
      }

      saveState();
      broadcastUpdate({
        type: 'DEVICE_PAIRED',
        hardwareUid: dev.hardwareUid,
        pairingCode: dev.pairingCode,
        device: dev,
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          device: dev,
          deviceToken: `dvt_${crypto.randomBytes(16).toString('hex')}`,
        })
      );
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'PAIRING_ERROR' }));
    }
    return;
  }

  // 6. DELETE /api/v1/live/devices/:hwUid -> Remove equipamento de teste antigo
  if (req.method === 'DELETE' && url.pathname.startsWith('/api/v1/live/devices/')) {
    const hwUid = decodeURIComponent(url.pathname.split('/').pop() || '');
    state.devices = state.devices.filter((d) => d.hardwareUid !== hwUid);
    saveState();
    broadcastUpdate();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getEnrichedState()));
    return;
  }

  // 7. POST /api/v1/live/telemetry
  if (req.method === 'POST' && url.pathname === '/api/v1/live/telemetry') {
    try {
      const payload = await readJsonBody(req);
      if (payload.type === 'POP') {
        const existing = state.popRecords.find(
          (r) =>
            r.mediaId === payload.mediaId &&
            r.playlistName === payload.playlistName &&
            r.brand === (payload.brand || 'FNAC')
        );
        if (existing) {
          existing.playCount += 1;
          existing.totalDurationMs += Number(payload.durationMs || 8000);
          existing.lastPlayedAt = new Date().toISOString();
        } else {
          state.popRecords.unshift({
            id: crypto.randomUUID(),
            brand: payload.brand || 'FNAC',
            playlistName: payload.playlistName || 'Programação Regular',
            priority: payload.priority || 'NORMAL',
            schedulingMode: payload.schedulingMode || 'FIXED_SLOTS',
            mediaId: payload.mediaId,
            mediaTitle: payload.mediaTitle || 'Conteúdo',
            playCount: 1,
            totalDurationMs: Number(payload.durationMs || 8000),
            lastPlayedAt: new Date().toISOString(),
          });
        }
      } else if (payload.type === 'INTERACTION') {
        const key = `${payload.deviceCategory || 'EXPO'}|${payload.interactionType}|${payload.referenceKey || 'GLOBAL'}`;
        const existing = state.interactionRecords.find((r) => r.key === key);
        if (existing) {
          existing.count += 1;
          existing.totalSeconds += Number(payload.engagedSeconds || 5);
          existing.lastAt = new Date().toISOString();
        } else {
          state.interactionRecords.unshift({
            key,
            brand: payload.brand || 'FNAC',
            deviceCategory: payload.deviceCategory || 'SMARTPHONE_EXPO',
            interactionType: payload.interactionType || 'TOUCH_WAKE',
            referenceKey: payload.referenceKey || 'GLOBAL',
            count: 1,
            totalSeconds: Number(payload.engagedSeconds || 5),
            lastAt: new Date().toISOString(),
          });
        }
      }

      saveState();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'RECORDED' }));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'TELEMETRY_ERROR' }));
    }
    return;
  }

  // 8. POST /api/v1/live/incidents
  if (req.method === 'POST' && url.pathname === '/api/v1/live/incidents') {
    try {
      const payload = await readJsonBody(req);
      if (payload.action === 'RESOLVE' && payload.id) {
        const inc = state.incidents.find((i) => i.id === payload.id);
        if (inc) inc.status = 'RESOLVED';
      } else {
        state.incidents.unshift({
          id: `INC-${Math.floor(1000 + Math.random() * 9000)}`,
          deviceName: payload.deviceName || 'Terminal Loja',
          brand: payload.brand || 'FNAC',
          incidentType: payload.incidentType || 'SCREEN_OFF',
          description: payload.description || 'Anomalia reportada pela loja',
          reportedByRole: payload.reportedByRole || 'STORE_MANAGER',
          status: 'OPEN',
          createdAt: new Date().toISOString(),
        });
      }
      saveState();
      broadcastUpdate();
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getEnrichedState()));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'INCIDENT_ERROR' }));
    }
    return;
  }

  // 9. DELETE /api/v1/live/media/:id
  if (req.method === 'DELETE' && url.pathname.startsWith('/api/v1/live/media/')) {
    const id = url.pathname.split('/').pop();
    const asset = state.mediaCatalog.find((a) => a.id === id);
    if (asset) {
      const p = path.join(STORAGE_DIR, asset.diskFileName);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    state.mediaCatalog = state.mediaCatalog.filter((a) => a.id !== id);
    for (const pl of state.playlists) {
      pl.items = (pl.items || []).filter((i) => i.id !== id);
    }
    saveState();
    broadcastUpdate();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getEnrichedState()));
    return;
  }

  // 9B. POST /api/v1/live/adb/provision (Provisionamento Kiosk via Backoffice)
  if (req.method === 'POST' && url.pathname === '/api/v1/live/adb/provision') {
    try {
      const payload = await readJsonBody(req);
      const result = await provisionAdbBox(
        payload.boxIp,
        payload.playerUrl,
        payload.autoWatchdog !== false
      );
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message || 'ADB_PROVISION_ERROR' }));
    }
    return;
  }

  // 9C. POST /api/v1/live/adb/action (Controlo Remoto da Box via Backoffice)
  if (req.method === 'POST' && url.pathname === '/api/v1/live/adb/action') {
    try {
      const payload = await readJsonBody(req);
      const cleanIp = String(payload.boxIp || '').trim();
      const action = payload.action;
      const box = state.adbBoxes.find((b) => b.boxIp === cleanIp);
      const target = `${cleanIp}:5555`;

      if (action === 'REMOVE_BOX') {
        state.adbBoxes = state.adbBoxes.filter((b) => b.boxIp !== cleanIp);
        saveState();
        broadcastUpdate();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, state: getEnrichedState() }));
        return;
      }

      if (action === 'TOGGLE_WATCHDOG' && box) {
        box.autoWatchdog = !box.autoWatchdog;
        saveState();
        broadcastUpdate();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, state: getEnrichedState() }));
        return;
      }

      await runAdb(['connect', target]);

      if (action === 'TAP_FULLSCREEN') {
        await runAdb(['-s', target, 'shell', 'settings', 'put', 'global', 'policy_control', 'immersive.full=*']);
        await runAdb(['-s', target, 'shell', 'input', 'tap', '960', '540']);
      } else if (action === 'RELAUNCH_URL') {
        const targetUrl = (box && box.playerUrl) || payload.playerUrl;
        if (box) box.lastLaunchMs = Date.now();
        await launchChromeSingleTabOnBox(target, targetUrl);
      } else if (action === 'REBOOT_BOX') {
        if (box) {
          box.status = 'REBOOTING (A reiniciar Box...)';
          box.lastLaunchMs = 0;
        }
        runAdb(['-s', target, 'reboot']);
      }

      saveState();
      broadcastUpdate();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, state: getEnrichedState() }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message || 'ADB_ACTION_ERROR' }));
    }
    return;
  }

  // 10. GET /api/v1/media/:id/stream
  if (
    req.method === 'GET' &&
    url.pathname.startsWith('/api/v1/media/') &&
    url.pathname.endsWith('/stream')
  ) {
    const parts = url.pathname.split('/');
    const id = parts[parts.length - 2];
    const asset = state.mediaCatalog.find((a) => a.id === id);

    if (!asset) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    const filePath = path.join(STORAGE_DIR, asset.diskFileName);
    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end('File missing on disk');
      return;
    }

    const stat = fs.statSync(filePath);
    const totalSize = stat.size;
    const range = req.headers.range;

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', asset.mimeType || 'video/mp4');
    res.setHeader('ETag', `"${asset.sha256}"`);

    if (range) {
      const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
      const start = parseInt(startStr, 10);
      const end = endStr ? parseInt(endStr, 10) : totalSize - 1;
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${totalSize}`,
        'Content-Length': chunkSize,
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
      return;
    }

    res.writeHead(200, { 'Content-Length': totalSize });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'HEALTHY', service: 'invision-live-media-bridge-v3' }));
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  socket.hardwareUid = url.searchParams.get('hw_uid') || null;

  const accept = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n')
  );

  wsClients.add(socket);
  socket.write(
    encodeWsFrame(
      JSON.stringify({
        type: 'MANIFEST_UPDATED',
        state: getEnrichedState(socket.hardwareUid),
      })
    )
  );

  socket.on('data', (buf) => {
    try {
      const str = decodeWsFrame(buf);
      if (!str) return;
      const msg = JSON.parse(str);
      if (msg.type === 'NTP_PING') {
        socket.write(
          encodeWsFrame(
            JSON.stringify({
              type: 'NTP_PONG',
              client_t0: msg.client_t0,
              server_t1: Date.now(),
              server_t2: Date.now(),
            })
          )
        );
      }
    } catch {
      // ignore
    }
  });

  socket.on('close', () => wsClients.delete(socket));
  socket.on('error', () => wsClients.delete(socket));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Invision Live Media & Sync Bridge v3 listening on http://0.0.0.0:${PORT}`);
});
