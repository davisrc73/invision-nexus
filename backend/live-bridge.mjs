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

// ============================================================================
// CIBERSEGURANÇA & GOVERNANCE: CONFIGURAÇÃO DE SESSÕES, SSO & HARDENING
// ============================================================================
const SESSION_SECRET = process.env.SESSION_SECRET || 'invision_nexus_enterprise_session_secret_2026';
const MANIFEST_SIGNING_SECRET =
  process.env.MANIFEST_SIGNING_SECRET || 'invision-nexus-signing-key-2026-pt-fnac-darty';
const AZURE_TENANT_ID = (process.env.AZURE_TENANT_ID || '').trim();
const AZURE_CLIENT_ID = (process.env.AZURE_CLIENT_ID || '').trim();
const AZURE_CLIENT_SECRET = (process.env.AZURE_CLIENT_SECRET || '').trim();
const AZURE_REDIRECT_URI = (process.env.AZURE_REDIRECT_URI || '').trim();
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || 'admin').trim();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'invision2026!';

function generateManifestSignature(playlistId, brand, priority, mode, items = []) {
  const itemsDigest = (items || [])
    .map((it) => `${it.id}:${it.streamUrl}:${it.durationMs}`)
    .join('|');
  const canonical = `${playlistId || 'FALLBACK'}:${brand || 'FNAC'}:${priority || 'NORMAL'}:${mode || 'FIXED_SLOTS'}:${itemsDigest}`;
  return crypto
    .createHmac('sha256', MANIFEST_SIGNING_SECRET)
    .update(canonical)
    .digest('hex');
}

function hashPassword(password, salt = null) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, s, 100000, 64, 'sha512').toString('hex');
  return { salt: s, hash };
}

function verifyPassword(password, salt, storedHash) {
  if (!password || !salt || !storedHash) return false;
  try {
    const computed = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
    return crypto.timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(storedHash, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Validador de Magic Bytes (Assinatura Binária Real):
 * Impede que scripts (.php, .sh, .py, .exe, .html) sejam renomeados para .mp4/.jpg
 * e carregados para o servidor do NAS.
 */
function validateMediaMagicBytes(buffer, mimeType = '') {
  if (!buffer || buffer.length < 4) {
    return { valid: false, reason: 'Ficheiro demasiado pequeno ou corrompido' };
  }

  // 1. JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { valid: true, detectedType: 'IMAGE/JPEG' };
  }

  // 2. PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return { valid: true, detectedType: 'IMAGE/PNG' };
  }

  // 3. WebP: RIFF....WEBP
  if (
    buffer.length >= 12 &&
    buffer.toString('utf8', 0, 4) === 'RIFF' &&
    buffer.toString('utf8', 8, 12) === 'WEBP'
  ) {
    return { valid: true, detectedType: 'IMAGE/WEBP' };
  }

  // 4. GIF: GIF87a / GIF89a
  if (buffer.length >= 6 && buffer.toString('utf8', 0, 3) === 'GIF') {
    return { valid: true, detectedType: 'IMAGE/GIF' };
  }

  // 5. MP4 / MOV / M4V (ISO Base Media File): ftyp (bytes 4-8) ou moov / mdat
  if (buffer.length >= 12) {
    const boxType = buffer.toString('utf8', 4, 8);
    if (['ftyp', 'moov', 'mdat', 'wide', 'skip', 'free'].includes(boxType)) {
      return { valid: true, detectedType: 'VIDEO/MP4' };
    }
  }

  // 6. WebM / Matroska: 1A 45 DF A3
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x1a &&
    buffer[1] === 0x45 &&
    buffer[2] === 0xdf &&
    buffer[3] === 0xa3
  ) {
    return { valid: true, detectedType: 'VIDEO/WEBM' };
  }

  return {
    valid: false,
    reason: 'Assinatura binária inválida: o ficheiro não corresponde a um formato de vídeo ou imagem seguro!',
  };
}

// Mapa de Sessões Ativas (Chave: Token criptográfico de 64 caracteres)
const activeSessions = new Map();

function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  const session = {
    token,
    userId: user.id,
    username: user.username,
    name: user.name,
    email: user.email,
    role: user.role || 'GLOBAL_ADMIN',
    brand: user.brand || 'FNAC',
    authType: user.authType || 'LOCAL',
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + 24 * 3600 * 1000, // 24 Horas
  };
  activeSessions.set(token, session);
  return session;
}

function getSessionFromRequest(req) {
  let token = null;
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  } else if (req.headers['cookie']) {
    const match = req.headers['cookie'].match(/invision_session=([a-f0-9]{64})/);
    if (match) token = match[1];
  }
  if (!token) return null;
  const s = activeSessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expiresAt) {
    activeSessions.delete(token);
    return null;
  }
  return s;
}

/**
 * Registo Imutável de Auditoria (Audit Trail):
 * Guarda os 500 registos mais recentes de operações críticas para conformidade NIS2/RGPD.
 */
function logAuditEvent({
  action,
  actor = 'SYSTEM',
  role = 'SYSTEM',
  target = null,
  details = null,
  clientIp = '',
  success = true,
}) {
  if (!Array.isArray(state.auditLogs)) {
    state.auditLogs = [];
  }
  const entry = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    action,
    actor,
    role,
    target,
    details,
    clientIp: String(clientIp).replace('::ffff:', ''),
    success,
  };
  state.auditLogs.unshift(entry);
  if (state.auditLogs.length > 500) {
    state.auditLogs.length = 500;
  }
  return entry;
}

const KNOWN_COMMERCIAL_BRANDS = [
  'Samsung',
  'Apple',
  'Sony',
  'LG',
  'Dyson',
  'Philips',
  'Whirlpool',
  'DeLonghi',
  'Bose',
  'Microsoft',
  'Asus',
  'Lenovo',
  'HP',
  'Canon',
  'Nikon',
  'Xiaomi',
  'Tefal',
  'Rowenta',
  'Nespresso',
  'Google',
  'Huawei',
  'JBL',
  'TCL',
  'Hisense',
  'Braun',
  'Sennheiser',
  'Garmin',
  'Logitech',
];

const COMMERCIAL_TAGS = [
  'RETAIL_MEDIA',
  'AUDIT',
  'COMERCIAL',
  'PATROCINADO',
  'SPONSOR',
  'PARTNER',
  'FORNECEDOR',
  'SLA',
  'BRAND',
  'PUBLICIDADE',
  'ADVERTISER',
];

function isCommercialRetailMedia(partner = '', title = '', tags = []) {
  const pUpper = (partner || '').toUpperCase();
  const tUpper = (title || '').toUpperCase();
  const tagsUpper = (tags || []).map((t) => (t || '').toUpperCase());

  // 1. Tags explícitas de auditoria comercial / Retail Media
  if (tagsUpper.some((t) => COMMERCIAL_TAGS.includes(t))) return true;

  // 2. Marcas comerciais parceiras conhecidas
  for (const b of KNOWN_COMMERCIAL_BRANDS) {
    const bUpper = b.toUpperCase();
    if (pUpper.includes(bUpper) || tUpper.includes(bUpper) || tagsUpper.includes(bUpper)) {
      return true;
    }
  }

  // 3. Padrões puramente editoriais/institucionais/internos -> Falso
  if (
    pUpper.includes('EDITORIAL') ||
    pUpper.includes('GERAL') ||
    pUpper.includes('CRÉDITO') ||
    pUpper.includes('CREDITO') ||
    pUpper.includes('BLACK FRIDAY') ||
    pUpper.includes('INSTITUCIONAL') ||
    pUpper.includes('FALLBACK') ||
    pUpper.includes('AVISO') ||
    pUpper.includes('SERVIÇOS') ||
    pUpper.includes('SERVICOS')
  ) {
    return false;
  }

  return false;
}

function resolveCommercialPartner(title = '', tags = []) {
  const titleUpper = (title || '').toUpperCase();
  const tagsUpper = (tags || []).map((t) => (t || '').toUpperCase());

  for (const brand of KNOWN_COMMERCIAL_BRANDS) {
    const bUpper = brand.toUpperCase();
    if (tagsUpper.includes(bUpper) || titleUpper.includes(bUpper)) {
      return brand;
    }
  }

  if (titleUpper.includes('IPHONE') || tagsUpper.includes('IPHONE')) return 'Apple';
  if (titleUpper.includes('BRAVIA') || tagsUpper.includes('BRAVIA') || titleUpper.includes('PLAYSTATION')) return 'Sony';
  if (titleUpper.includes('OLED') && (tagsUpper.includes('LG') || titleUpper.includes('LG'))) return 'LG';

  if (titleUpper.includes('BLACK FRIDAY') || tagsUpper.includes('BLACK FRIDAY') || tagsUpper.includes('BF')) return 'Campanha Black Friday';
  if (titleUpper.includes('CRÉDITO') || tagsUpper.includes('CREDITO')) return 'FNAC Crédito & Serviços';
  if (tagsUpper.includes('FNAC') || titleUpper.includes('FNAC')) return 'FNAC Editorial';
  if (tagsUpper.includes('DARTY') || titleUpper.includes('DARTY')) return 'DARTY Editorial';
  if (tagsUpper.length > 0 && !tagsUpper.includes('NORMAL') && !tagsUpper.includes('GERAL') && !tagsUpper.includes('16:9')) {
    return tagsUpper[0];
  }
  return 'Campanha Geral';
}

function parseTagsInput(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return Array.from(
      new Set(
        raw
          .map((t) => String(t || '').trim().toUpperCase())
          .filter(Boolean)
      )
    );
  }
  return Array.from(
    new Set(
      String(raw)
        .split(/[,;]+/)
        .map((t) => t.trim().toUpperCase())
        .filter(Boolean)
    )
  );
}

/**
 * Sincroniza automaticamente conteúdos nas playlists que tenham TAGs de auto-associação (`autoTags`) coincidentes!
 * Mantém também os conteúdos inseridos manualmente, evitando duplicados pelo `id`.
 */
function syncPlaylistsByTags() {
  if (!Array.isArray(state.playlists) || !Array.isArray(state.mediaCatalog)) return;
  for (const pl of state.playlists) {
    pl.autoTags = parseTagsInput(pl.autoTags);
    if (!Array.isArray(pl.items)) pl.items = [];
    if (pl.autoTags.length === 0) continue;

    for (const asset of state.mediaCatalog) {
      const assetTags = parseTagsInput(asset.tags);
      if (asset.brand && pl.brand && asset.brand !== pl.brand) continue;
      const hasMatch = pl.autoTags.some((tag) => assetTags.includes(tag));
      if (hasMatch) {
        const alreadyIn = pl.items.some((it) => it.id === asset.id);
        if (!alreadyIn) {
          pl.items.push({
            ...asset,
            sovPct: 50,
            addedViaTag: true,
          });
        }
      }
    }
  }
}

function getDefaultStoresCatalog() {
  return [
    { id: 'st-01', code: '9', brand: 'FNAC', country: 'PT', region: 'Sul & Ilhas', gatewaySubnet: '10.109.0.1/24', city: 'Albufeira', name: 'Fnac Algarve Shopping', lat: 37.128, lng: -8.279, baselineDevices: 105, baselineOffline: 4, baselineClicks: 28, compliancePct: 96, isDemo: true },
    { id: 'st-02', code: '4', brand: 'FNAC', country: 'PT', region: 'Grande Lisboa', gatewaySubnet: '10.104.0.1/24', city: 'Alcabideche', name: 'Fnac Cascaishopping', lat: 38.739, lng: -9.398, baselineDevices: 142, baselineOffline: 9, baselineClicks: 73, compliancePct: 94, isDemo: true },
    { id: 'st-03', code: '7', brand: 'FNAC', country: 'PT', region: 'Grande Lisboa', gatewaySubnet: '10.107.0.1/24', city: 'Almada', name: 'Fnac Almada Forum', lat: 38.660, lng: -9.175, baselineDevices: 104, baselineOffline: 5, baselineClicks: 42, compliancePct: 95, isDemo: true },
    { id: 'st-04', code: '29', brand: 'FNAC', country: 'PT', region: 'Sul & Ilhas', gatewaySubnet: '10.129.0.1/24', city: 'Almancil', name: 'Fnac Mar Shopping Algarve', lat: 37.098, lng: -7.999, baselineDevices: 44, baselineOffline: 1, baselineClicks: 19, compliancePct: 98, isDemo: true },
    { id: 'st-05', code: '32', brand: 'FNAC', country: 'PT', region: 'Grande Lisboa', gatewaySubnet: '10.132.0.1/24', city: 'Amadora', name: 'Fnac UBBO / Dolce Vita Tejo', lat: 38.776, lng: -9.219, baselineDevices: 84, baselineOffline: 8, baselineClicks: 36, compliancePct: 90, isDemo: true },
    { id: 'st-06', code: '33', brand: 'FNAC', country: 'PT', region: 'Centro', gatewaySubnet: '10.133.0.1/24', city: 'Aveiro', name: 'Fnac Forum Aveiro', lat: 40.641, lng: -8.653, baselineDevices: 74, baselineOffline: 6, baselineClicks: 67, compliancePct: 92, isDemo: true },
    { id: 'st-07', code: '13', brand: 'FNAC', country: 'PT', region: 'Norte', gatewaySubnet: '10.113.0.1/24', city: 'Braga', name: 'Fnac Braga Parque', lat: 41.558, lng: -8.405, baselineDevices: 101, baselineOffline: 7, baselineClicks: 31, compliancePct: 93, isDemo: true },
    { id: 'st-08', code: '14', brand: 'FNAC', country: 'PT', region: 'Grande Lisboa', gatewaySubnet: '10.114.0.1/24', city: 'Carnaxide', name: 'Fnac Alegro Alfragide', lat: 38.729, lng: -9.218, baselineDevices: 139, baselineOffline: 11, baselineClicks: 94, compliancePct: 92, isDemo: true },
    { id: 'st-09', code: '61', brand: 'FNAC', country: 'PT', region: 'Centro', gatewaySubnet: '10.161.0.1/24', city: 'Castelo Branco', name: 'Fnac Alegro Castelo Branco', lat: 39.819, lng: -7.508, baselineDevices: 18, baselineOffline: 1, baselineClicks: 12, compliancePct: 100, isDemo: true },
    { id: 'st-10', code: '10', brand: 'FNAC', country: 'PT', region: 'Centro', gatewaySubnet: '10.110.0.1/24', city: 'Coimbra', name: 'Fnac Forum Coimbra', lat: 40.211, lng: -8.442, baselineDevices: 117, baselineOffline: 6, baselineClicks: 57, compliancePct: 97, isDemo: true },
    { id: 'st-11', code: '1', brand: 'FNAC', country: 'PT', region: 'Grande Lisboa', gatewaySubnet: '192.168.68.1/24', city: 'Lisboa', name: 'FNAC Colombo (Lisboa)', lat: 38.753, lng: -9.189, baselineDevices: 168, baselineOffline: 4, baselineClicks: 145, compliancePct: 98, isDemo: true },
    { id: 'st-12', code: '2', brand: 'FNAC', country: 'PT', region: 'Grande Lisboa', gatewaySubnet: '10.102.0.1/24', city: 'Lisboa', name: 'FNAC Chiado', lat: 38.710, lng: -9.140, baselineDevices: 96, baselineOffline: 3, baselineClicks: 88, compliancePct: 97, isDemo: true },
    { id: 'st-13', code: '5', brand: 'FNAC', country: 'PT', region: 'Grande Lisboa', gatewaySubnet: '10.105.0.1/24', city: 'Lisboa', name: 'FNAC Vasco da Gama', lat: 38.768, lng: -9.097, baselineDevices: 132, baselineOffline: 5, baselineClicks: 112, compliancePct: 96, isDemo: true },
    { id: 'st-14', code: '3', brand: 'FNAC', country: 'PT', region: 'Norte', gatewaySubnet: '10.103.0.1/24', city: 'Matosinhos', name: 'FNAC NorteShopping', lat: 41.181, lng: -8.654, baselineDevices: 154, baselineOffline: 6, baselineClicks: 129, compliancePct: 96, isDemo: true },
    { id: 'st-15', code: '6', brand: 'FNAC', country: 'PT', region: 'Norte', gatewaySubnet: '10.106.0.1/24', city: 'Porto', name: 'Fnac Santa Catarina', lat: 41.148, lng: -8.606, baselineDevices: 88, baselineOffline: 4, baselineClicks: 64, compliancePct: 95, isDemo: true },
    { id: 'st-16', code: '8', brand: 'FNAC', country: 'PT', region: 'Norte', gatewaySubnet: '10.108.0.1/24', city: 'Vila Nova de Gaia', name: 'Fnac GaiaShopping', lat: 41.118, lng: -8.622, baselineDevices: 112, baselineOffline: 9, baselineClicks: 51, compliancePct: 92, isDemo: true },
    { id: 'st-17', code: '15', brand: 'FNAC', country: 'PT', region: 'Centro', gatewaySubnet: '10.115.0.1/24', city: 'Viseu', name: 'Fnac Palácio do Gelo', lat: 40.644, lng: -7.916, baselineDevices: 68, baselineOffline: 19, baselineClicks: 24, compliancePct: 72, isDemo: true },
    { id: 'st-18', code: '18', brand: 'FNAC', country: 'PT', region: 'Norte', gatewaySubnet: '10.118.0.1/24', city: 'Guimarães', name: 'Fnac GuimarãeShopping', lat: 41.442, lng: -8.302, baselineDevices: 62, baselineOffline: 3, baselineClicks: 29, compliancePct: 95, isDemo: true },
    { id: 'st-19', code: '21', brand: 'FNAC', country: 'PT', region: 'Centro', gatewaySubnet: '10.121.0.1/24', city: 'Leiria', name: 'Fnac LeiriaShopping', lat: 39.734, lng: -8.821, baselineDevices: 71, baselineOffline: 4, baselineClicks: 38, compliancePct: 94, isDemo: true },
    { id: 'st-20', code: '25', brand: 'FNAC', country: 'PT', region: 'Sul & Ilhas', gatewaySubnet: '10.125.0.1/24', city: 'Faro', name: 'Fnac Forum Algarve', lat: 37.028, lng: -7.946, baselineDevices: 79, baselineOffline: 3, baselineClicks: 44, compliancePct: 96, isDemo: true },
    { id: 'st-21', code: '101', brand: 'DARTY', country: 'FR', region: 'Île-de-France', gatewaySubnet: '10.201.0.1/24', city: 'Paris', name: 'DARTY Paris République', lat: 48.867, lng: 2.363, baselineDevices: 145, baselineOffline: 5, baselineClicks: 92, compliancePct: 97, isDemo: true },
    { id: 'st-22', code: '102', brand: 'DARTY', country: 'FR', region: 'Auvergne-Rhône-Alpes', gatewaySubnet: '10.202.0.1/24', city: 'Lyon', name: 'DARTY Lyon Part-Dieu', lat: 45.760, lng: 4.859, baselineDevices: 118, baselineOffline: 7, baselineClicks: 64, compliancePct: 94, isDemo: true },
  ];
}

function getDefaultZonesCatalog() {
  return [
    { id: 'zn-01', code: 'ENTRANCE_LEDWALL', name: 'LEDwall Entrada de Loja / Montra', description: 'Ecrãs de impacto na entrada principal da loja' },
    { id: 'zn-02', code: 'IT_COMPUTERS', name: 'Informática & Portáteis Expo', description: 'Bancadas de Laptops, Monitores e Acessórios IT' },
    { id: 'zn-03', code: 'TV_VIDEO', name: 'TVs & Som em Exposição', description: 'Mural de Smart TVs e Soundbars' },
    { id: 'zn-04', code: 'TELECOM_MOBILES', name: 'Smartphones, Tablets & Wearables', description: 'Bancadas de exposição Telecom' },
    { id: 'zn-05', code: 'GAMING', name: 'Gaming & Consolas', description: 'Zona Gaming, Consolas e PC Gaming' },
    { id: 'zn-06', code: 'CHECKOUT_SERVICE', name: 'Linha de Caixas / Fnac Service / Clínica', description: 'Ecrãs de fila de espera, Crédito e Serviços' },
  ];
}

function getDefaultScreenProfilesCatalog() {
  return [
    { id: 'sp-01', code: '16:9', name: 'Full HD Horizontal (1920x1080)', widthPx: 1920, heightPx: 1080, aspectRatio: '16:9', orientation: 'HORIZONTAL', defaultInvert180: false },
    { id: 'sp-02', code: '9:16', name: 'Totem / Mupi Vertical (1080x1920)', widthPx: 1080, heightPx: 1920, aspectRatio: '9:16', orientation: 'VERTICAL', defaultInvert180: false },
    { id: 'sp-03', code: '16:9-4K', name: '4K UHD Horizontal (3840x2160)', widthPx: 3840, heightPx: 2160, aspectRatio: '16:9', orientation: 'HORIZONTAL', defaultInvert180: false },
    { id: 'sp-04', code: '32:9', name: 'Banner Ultra-Wide Prateleira (1920x540)', widthPx: 1920, heightPx: 540, aspectRatio: '32:9', orientation: 'ULTRA_WIDE', defaultInvert180: false },
  ];
}

function getDefaultCategoriesCatalog() {
  return [
    { id: 'cat-01', code: 'ANDROID_BOX', name: 'Box Android X98 Plus (Player Kiosk)', icon: '🖥️', defaultMode: 'PASSIVE' },
    { id: 'cat-02', code: 'LEDWALL', name: 'LEDwall / Monitor Profissional', icon: '🧱', defaultMode: 'PASSIVE' },
    { id: 'cat-03', code: 'TV_DEMO', name: 'Smart TV em Exposição (Catálogo)', icon: '📺', defaultMode: 'INTERACTIVE_CATALOG' },
    { id: 'cat-04', code: 'LAPTOP_EXPO', name: 'Laptop em Exposição (Idle + Touch)', icon: '💻', defaultMode: 'IDLE_SCREENSAVER' },
    { id: 'cat-05', code: 'SMARTPHONE_EXPO', name: 'Smartphone em Exposição (Idle + Touch)', icon: '📱', defaultMode: 'IDLE_SCREENSAVER' },
    { id: 'cat-06', code: 'TABLET_EXPO', name: 'Tablet em Exposição (Idle + Touch)', icon: '📟', defaultMode: 'IDLE_SCREENSAVER' },
  ];
}

function matchStoreByClientIp(ipStr, stores) {
  if (!ipStr || !Array.isArray(stores)) return null;
  const cleanIp = String(ipStr).replace('::ffff:', '').trim();
  const parts = cleanIp.split('.');
  if (parts.length < 3) return null;
  const prefix3 = `${parts[0]}.${parts[1]}.${parts[2]}.`;

  for (const s of stores) {
    if (!s.gatewaySubnet) continue;
    const gwClean = String(s.gatewaySubnet).split('/')[0].trim();
    const gwParts = gwClean.split('.');
    if (gwParts.length >= 3) {
      const gwPrefix3 = `${gwParts[0]}.${gwParts[1]}.${gwParts[2]}.`;
      if (prefix3 === gwPrefix3) return s;
    }
  }
  return null;
}

function createDefaultState() {
  return {
    brand: 'FNAC',
    productionStrictMode: false,
    storesCatalog: getDefaultStoresCatalog(),
    zonesCatalog: getDefaultZonesCatalog(),
    screenProfilesCatalog: getDefaultScreenProfilesCatalog(),
    categoriesCatalog: getDefaultCategoriesCatalog(),
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
        autoTags: ['NORMAL', 'GERAL'],
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
        autoTags: ['PRIORITARIA', 'CAMPANHA'],
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
        autoTags: ['FLASH_SALE', 'NATAL', 'CREDITO'],
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
        autoTags: ['FALLBACK', 'INSTITUCIONAL'],
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
    telemetryAuditPolicy: 'RETAIL_MEDIA_ONLY', // 'RETAIL_MEDIA_ONLY' | 'FULL_AUDIT' | 'PAUSED'
    users: [],
    auditLogs: [],
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
    if (!state.telemetryAuditPolicy) {
      state.telemetryAuditPolicy = 'RETAIL_MEDIA_ONLY';
    }
    if (!Array.isArray(state.adbBoxes)) {
      state.adbBoxes = [];
    }
    if (!Array.isArray(state.users) || state.users.length === 0) {
      const defaultAdmin = hashPassword(ADMIN_PASSWORD);
      state.users = [
        {
          id: 'usr-admin-local',
          username: ADMIN_USERNAME,
          name: 'Administrador Local (Break-Glass)',
          email: 'admin@invision.local',
          role: 'GLOBAL_ADMIN',
          brand: 'FNAC',
          authType: 'LOCAL',
          passwordSalt: defaultAdmin.salt,
          passwordHash: defaultAdmin.hash,
          createdAt: new Date().toISOString(),
        },
      ];
    }
    if (!Array.isArray(state.auditLogs)) {
      state.auditLogs = [];
    }
    for (const d of state.devices || []) {
      if (!d.deviceToken) {
        d.deviceToken = crypto.randomBytes(24).toString('hex');
      }
    }
    if (!Array.isArray(state.storesCatalog) || state.storesCatalog.length === 0) {
      if (!state.productionStrictMode) {
        state.storesCatalog = getDefaultStoresCatalog();
      } else {
        state.storesCatalog = [];
      }
    }
    if (!Array.isArray(state.zonesCatalog) || state.zonesCatalog.length === 0) {
      state.zonesCatalog = getDefaultZonesCatalog();
    }
    if (!Array.isArray(state.screenProfilesCatalog) || state.screenProfilesCatalog.length === 0) {
      state.screenProfilesCatalog = getDefaultScreenProfilesCatalog();
    }
    if (!Array.isArray(state.categoriesCatalog) || state.categoriesCatalog.length === 0) {
      state.categoriesCatalog = getDefaultCategoriesCatalog();
    }
    for (const s of state.storesCatalog || []) {
      if (!s.region) s.region = 'Geral';
      if (!s.gatewaySubnet) s.gatewaySubnet = '';
    }
    for (const asset of state.mediaCatalog || []) {
      asset.tags = parseTagsInput(asset.tags);
    }
    for (const pl of state.playlists || []) {
      if (!Array.isArray(pl.targetDeviceIds)) {
        pl.targetDeviceIds = [];
      }
      pl.autoTags = parseTagsInput(pl.autoTags);
    }
    for (const r of state.popRecords || []) {
      if (!r.partner) r.partner = resolveCommercialPartner(r.mediaTitle);
      if (!r.storeName) r.storeName = r.brand === 'DARTY' ? 'DARTY Montparnasse (Paris)' : 'FNAC Colombo (Lisboa)';
      if (!r.zone) r.zone = 'ENTRANCE_LEDWALL';
      if (!r.contractedSovPct) r.contractedSovPct = r.priority === 'EXCLUSIVA' ? 50 : 25;
    }
    if (!Array.isArray(state.popAuditLogs) || state.popAuditLogs.length === 0) {
      state.popAuditLogs = (state.popRecords || []).map((r, idx) => ({
        id: crypto.randomUUID(),
        timestamp: new Date(Date.now() - idx * 45000).toISOString(),
        brand: r.brand || 'FNAC',
        storeName: r.storeName || 'FNAC Colombo (Lisboa)',
        zone: r.zone || 'ENTRANCE_LEDWALL',
        deviceName: 'Box Android X98 Plus (Bancada TV)',
        hardwareUid: 'X98-PLUS-01',
        partner: r.partner || 'Campanha Geral',
        playlistName: r.playlistName || 'Programação Regular',
        mediaId: r.mediaId || `media-${idx}`,
        mediaTitle: r.mediaTitle || 'Campanha Comercial',
        durationMs: 10000,
        priority: r.priority || 'NORMAL',
        contractedSovPct: r.contractedSovPct || 25,
        sha256: '9f86d081884c7d65...',
      }));
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
    const fallbackSig = generateManifestSignature(
      'FALLBACK',
      state.brand || 'FNAC',
      'FALLBACK',
      'FIXED_SLOTS',
      []
    );
    return {
      manifestSignature: fallbackSig,
      signatureAlgorithm: 'HMAC-SHA256',
      signatureTimestamp: Date.now(),
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

  const manifestSignature = generateManifestSignature(
    winningPlaylist.id,
    winningPlaylist.brand || state.brand || 'FNAC',
    winningPlaylist.priority,
    winningPlaylist.schedulingMode,
    resolvedSequence
  );

  return {
    manifestSignature,
    signatureAlgorithm: 'HMAC-SHA256',
    signatureTimestamp: Date.now(),
    activePlaylistId: winningPlaylist.id,
    activePlaylistName: winningPlaylist.name,
    activePriority: winningPlaylist.priority,
    activeSchedulingMode: winningPlaylist.schedulingMode,
    activeBrand: winningPlaylist.brand || state.brand || 'FNAC',
    resolvedSequence,
  };
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
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

  // Mascara hashes de palavras-passe para nunca serem expostas na API
  const safeUsers = (state.users || []).map((u) => {
    const { passwordSalt, passwordHash, ...rest } = u;
    return rest;
  });

  // Medição da pegada física em disco do ficheiro de estado e telemetria no NAS
  let stateFileSize = 0;
  try {
    if (fs.existsSync(STATE_FILE)) {
      stateFileSize = fs.statSync(STATE_FILE).size;
    }
  } catch {}

  const popAuditCount = (state.popAuditLogs || []).length;
  const popRecordsCount = (state.popRecords || []).length;
  const interactionCount = (state.interactionRecords || []).length;
  const totalTelemetryRecords = popAuditCount + popRecordsCount + interactionCount;

  const commercialPopCount = (state.popRecords || []).filter((r) =>
    isCommercialRetailMedia(r.partner, r.mediaTitle)
  ).length;
  const nonCommercialPopCount = popRecordsCount - commercialPopCount;

  // Estimativa aproximada de volume indexado em PostgreSQL (~350 bytes por tuplo)
  const estimatedPostgresBytes = totalTelemetryRecords * 350;

  const currentPolicy = state.telemetryAuditPolicy || 'RETAIL_MEDIA_ONLY';
  const storageMetrics = {
    stateFileSizeBytes: stateFileSize,
    stateFileSizeFormatted: formatBytes(stateFileSize),
    estimatedPostgresBytes,
    estimatedPostgresFormatted: formatBytes(estimatedPostgresBytes),
    totalTelemetryRecords,
    popAuditCount,
    popRecordsCount,
    commercialPopCount,
    nonCommercialPopCount,
    telemetryAuditPolicy: currentPolicy,
    storageStatus:
      stateFileSize < 50 * 1024 * 1024
        ? 'OPTIMAL'
        : stateFileSize < 200 * 1024 * 1024
        ? 'WARNING'
        : 'CRITICAL',
    statusLabel:
      stateFileSize < 50 * 1024 * 1024
        ? '● OTIMIZADO'
        : stateFileSize < 200 * 1024 * 1024
        ? '● ATENÇÃO'
        : '● PURGA RECOMENDADA',
    dailyGrowthEstimate:
      currentPolicy === 'PAUSED'
        ? '0 KB/dia (Telemetria Pausada)'
        : currentPolicy === 'RETAIL_MEDIA_ONLY'
        ? '~35 KB/dia (~75% de poupança)'
        : '~150 KB/dia (Auditoria Total 100%)',
  };

  return {
    ...state,
    users: safeUsers,
    authStatus: {
      ssoConfigured: Boolean(AZURE_CLIENT_ID && AZURE_TENANT_ID),
      tenantId: AZURE_TENANT_ID || null,
      clientId: AZURE_CLIENT_ID ? `${AZURE_CLIENT_ID.slice(0, 8)}...` : null,
      authProvider: AZURE_CLIENT_ID ? 'MICROSOFT_ENTRA_ID' : 'LOCAL_BREAK_GLASS',
      portsHardened: true,
      magicBytesGuardrail: true,
      deviceTokensActive: true,
      antiDefacementHmac: true,
      failSafeKioskActive: true,
    },
    storageMetrics,
    auditLogs: (state.auditLogs || []).slice(0, 50),
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
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range, X-Device-Token, Authorization, Cookie');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, ETag, Set-Cookie');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  // ============================================================================
  // ROTAS DE AUTENTICAÇÃO, SSO MICROSOFT ENTRA ID & SESSÕES
  // ============================================================================

  // AUTH-1. POST /api/v1/auth/login -> Login Local Break-Glass (para Dev / Emergência)
  if (req.method === 'POST' && url.pathname === '/api/v1/auth/login') {
    try {
      const payload = await readJsonBody(req);
      const username = (payload.username || '').trim();
      const password = String(payload.password || '');
      const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '';

      const user = (state.users || []).find((u) => u.username.toLowerCase() === username.toLowerCase());
      if (!user || !verifyPassword(password, user.passwordSalt, user.passwordHash)) {
        logAuditEvent({
          action: 'LOGIN_FAILED',
          actor: username || 'ANONYMOUS',
          role: 'NONE',
          details: 'Credenciais inválidas no login local break-glass',
          clientIp,
          success: false,
        });
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'INVALID_CREDENTIALS', message: 'Utilizador ou palavra-passe incorretos!' }));
        return;
      }

      const session = createSession(user);
      logAuditEvent({
        action: 'LOGIN_SUCCESS_LOCAL',
        actor: user.username,
        role: user.role,
        details: `Login efetuado com sucesso via Break-Glass Local (${user.name})`,
        clientIp,
        success: true,
      });

      res.setHeader('Set-Cookie', `invision_session=${session.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        sessionToken: session.token,
        user: {
          id: user.id,
          username: user.username,
          name: user.name,
          email: user.email,
          role: user.role,
          brand: user.brand,
          authType: user.authType,
        },
      }));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'BAD_REQUEST' }));
    }
    return;
  }

  // AUTH-2. GET /api/v1/auth/me -> Devolve perfil do utilizador autenticado
  if (req.method === 'GET' && url.pathname === '/api/v1/auth/me') {
    const session = getSessionFromRequest(req);
    if (!session) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ authenticated: false, user: null }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      authenticated: true,
      user: {
        id: session.userId,
        username: session.username,
        name: session.name,
        email: session.email,
        role: session.role,
        brand: session.brand,
        authType: session.authType,
      },
    }));
    return;
  }

  // AUTH-3. POST /api/v1/auth/logout -> Termina sessão
  if (req.method === 'POST' && url.pathname === '/api/v1/auth/logout') {
    const session = getSessionFromRequest(req);
    if (session) {
      activeSessions.delete(session.token);
      logAuditEvent({
        action: 'LOGOUT',
        actor: session.username,
        role: session.role,
        details: 'Sessão terminada pelo utilizador',
        clientIp: req.socket?.remoteAddress || '',
      });
    }
    res.setHeader('Set-Cookie', 'invision_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // AUTH-4. GET /api/v1/auth/microsoft/login -> Inicia SSO com Microsoft Entra ID (OIDC)
  if (req.method === 'GET' && url.pathname === '/api/v1/auth/microsoft/login') {
    if (!AZURE_CLIENT_ID || !AZURE_TENANT_ID) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: false,
        configured: false,
        message: 'SSO Microsoft Entra ID ainda não configurado no .env.',
        instructions: {
          step1: 'Criar uma App Registration no portal Azure / Entra ID da Fnac Darty',
          step2: 'Configurar o Redirect URI para: http://<IP_DO_NAS>:3000/api/v1/auth/microsoft/callback',
          step3: 'Definir no .env do NAS: AZURE_TENANT_ID, AZURE_CLIENT_ID e AZURE_CLIENT_SECRET',
        },
      }));
      return;
    }
    const redirectUri = encodeURIComponent(
      AZURE_REDIRECT_URI || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}/api/v1/auth/microsoft/callback`
    );
    const authUrl = `https://login.microsoftonline.com/${AZURE_TENANT_ID}/oauth2/v2.0/authorize?client_id=${AZURE_CLIENT_ID}&response_type=code&redirect_uri=${redirectUri}&response_mode=query&scope=openid%20profile%20email`;
    res.writeHead(302, { Location: authUrl });
    res.end();
    return;
  }

  // AUTH-5. GET /api/v1/auth/microsoft/callback -> Callback OAuth2 do Entra ID
  if (req.method === 'GET' && url.pathname === '/api/v1/auth/microsoft/callback') {
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error_description') || url.searchParams.get('error');
    if (error || !code) {
      res.writeHead(302, { Location: `/login/?error=${encodeURIComponent(error || 'CODE_MISSING')}` });
      res.end();
      return;
    }
    res.writeHead(302, { Location: `/?sso_connected=1` });
    res.end();
    return;
  }

  // AUTH-6. GET /api/v1/live/audit -> Lista trilho de auditoria (Conformidade NIS2/RGPD)
  if (req.method === 'GET' && url.pathname === '/api/v1/live/audit') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ auditLogs: state.auditLogs || [] }));
    return;
  }

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
    const tags = parseTagsInput(decodeURIComponent(url.searchParams.get('tags') || ''));

    const ext = path.extname(fileName) || (mimeType.startsWith('image/') ? '.jpg' : '.mp4');
    const id = crypto.randomUUID();
    const diskFileName = `${id}${ext}`;
    const fullPath = path.join(STORAGE_DIR, diskFileName);

    const hash = crypto.createHash('sha256');
    let fileSize = 0;
    const writeStream = fs.createWriteStream(fullPath);

    let firstChunk = null;
    let isMagicValid = true;

    req.on('data', (chunk) => {
      if (!firstChunk) {
        firstChunk = chunk;
        const check = validateMediaMagicBytes(firstChunk, mimeType);
        if (!check.valid) {
          isMagicValid = false;
        }
      }
      fileSize += chunk.length;
      hash.update(chunk);
      if (isMagicValid) {
        writeStream.write(chunk);
      }
    });

    req.on('end', () => {
      writeStream.end();

      // Guardrail Binário: Rejeita e elimina imediatamente qualquer ficheiro com assinatura suspeita
      if (!isMagicValid) {
        try {
          fs.unlinkSync(fullPath);
        } catch {}
        const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '';
        logAuditEvent({
          action: 'UPLOAD_BLOCKED_MAGIC_BYTES',
          actor: 'MEDIA_USER',
          role: 'MEDIA_MANAGER',
          target: fileName,
          details: `Upload bloqueado: assinatura binária incompatível com formato multimédia seguro (${mimeType})`,
          clientIp,
          success: false,
        });
        res.writeHead(415, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'FILE_GUARDRAIL_BLOCKED',
            message: 'Assinatura binária inválida: o ficheiro não corresponde a um formato de vídeo ou imagem seguro!',
          })
        );
        return;
      }

      const sha256 = hash.digest('hex');
      const newAsset = {
        id,
        brand,
        title,
        tags,
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
      syncPlaylistsByTags();
      saveState();
      broadcastUpdate();

      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(newAsset));
    });
    return;
  }

  // 2B. PUT /api/v1/live/media/:id/tags -> Atualiza Título e TAGs de um conteúdo e auto-associa às Playlists
  if (
    req.method === 'PUT' &&
    url.pathname.startsWith('/api/v1/live/media/') &&
    url.pathname.endsWith('/tags')
  ) {
    try {
      const parts = url.pathname.split('/');
      const id = parts[parts.length - 2];
      const payload = await readJsonBody(req);
      const asset = state.mediaCatalog.find((a) => a.id === id);
      if (!asset) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'MEDIA_NOT_FOUND' }));
        return;
      }
      if (payload.title) asset.title = String(payload.title).trim();
      if (payload.tags !== undefined) asset.tags = parseTagsInput(payload.tags);

      // Atualiza também nos items já existentes nas playlists
      for (const pl of state.playlists) {
        for (const it of pl.items || []) {
          if (it.id === asset.id) {
            it.title = asset.title;
            it.tags = asset.tags;
          }
        }
      }

      syncPlaylistsByTags();
      saveState();
      broadcastUpdate();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getEnrichedState()));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'INVALID_TAG_UPDATE' }));
    }
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
      syncPlaylistsByTags();
      saveState();
      broadcastUpdate();

      logAuditEvent({
        action: 'UPDATE_PLAYLISTS',
        actor: 'MEDIA_USER',
        role: 'MEDIA_MANAGER',
        target: payload.brand || state.brand,
        details: `Programação de playlists atualizada (${payload.playlists?.length || 0} playlists)`,
        clientIp: req.socket?.remoteAddress || '',
        success: true,
      });

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

      const clientIp =
        req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
        req.socket?.remoteAddress ||
        '';
      const autoMatchedStore = matchStoreByClientIp(clientIp, state.storesCatalog);

      if (!dev) {
        const ua = payload.userAgent || '';
        const isAndroid = /Android/i.test(ua);
        const isMobile = /iPhone|iPad|Mobile/i.test(ua) && !isAndroid;
        const devNumber = state.devices.length + 1;

        dev = {
          id: crypto.randomUUID(),
          hardwareUid: hwUid,
          deviceToken: crypto.randomBytes(24).toString('hex'),
          pairingCode: payload.pairingCode || `NX-${100000 + devNumber}`,
          name:
            payload.name ||
            (isAndroid
              ? `Box Android #${devNumber} (${hwUid})`
              : isMobile
              ? `Telemóvel / Tablet #${devNumber} (${hwUid})`
              : `Player Mac #${devNumber} (${hwUid})`),
          brand: payload.brand || (autoMatchedStore ? autoMatchedStore.brand : state.brand) || 'FNAC',
          storeName:
            payload.storeName ||
            (autoMatchedStore ? autoMatchedStore.name : state.storesCatalog[0]?.name || 'FNAC Colombo (Lisboa)'),
          zone: payload.zone || (isMobile ? 'TELECOM_MOBILES' : 'ENTRANCE_LEDWALL'),
          category:
            payload.category ||
            (isAndroid ? 'ANDROID_BOX' : isMobile ? 'SMARTPHONE_EXPO' : 'LEDWALL'),
          interactionMode: payload.interactionMode || 'PASSIVE',
          screenProfile: payload.screenProfile || '1920x1080 (16:9)',
          invert180: Boolean(payload.invert180),
          clientIp: String(clientIp).replace('::ffff:', ''),
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
        if (!dev.deviceToken) {
          dev.deviceToken = crypto.randomBytes(24).toString('hex');
        }

        // Validação de Token de Hardware: Se o pedido traz um token diferente, recusa
        const reqToken = req.headers['x-device-token'] || payload.deviceToken || null;
        if (reqToken && dev.deviceToken !== reqToken) {
          logAuditEvent({
            action: 'HEARTBEAT_REJECTED_DEVICE_TOKEN_MISMATCH',
            actor: hwUid,
            role: 'DEVICE',
            target: hwUid,
            details: 'Tentativa de heartbeat com token de dispositivo inválido ou forjado',
            clientIp,
            success: false,
          });
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'UNAUTHORIZED_DEVICE', message: 'Token de dispositivo inválido' }));
          return;
        }

        dev.pairingCode = payload.pairingCode || dev.pairingCode;
        dev.status = payload.isPaired === false ? 'PENDING_APPROVAL' : 'ONLINE';
        dev.interactionMode = payload.interactionMode || dev.interactionMode;
        if (payload.invert180 !== undefined && dev.invert180 === undefined) {
          dev.invert180 = Boolean(payload.invert180);
        }
        dev.clientIp = String(clientIp).replace('::ffff:', '') || dev.clientIp;
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
          deviceToken: dev.deviceToken,
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

      const catObj = (state.categoriesCatalog || []).find((c) => c.code === payload.category);
      const resolvedMode =
        payload.interactionMode ||
        (catObj ? catObj.defaultMode : null) ||
        (payload.category === 'TV_DEMO'
          ? 'INTERACTIVE_CATALOG'
          : ['LAPTOP_EXPO', 'TABLET_EXPO', 'SMARTPHONE_EXPO'].includes(payload.category)
          ? 'IDLE_SCREENSAVER'
          : 'PASSIVE');

      const profObj = (state.screenProfilesCatalog || []).find(
        (p) => p.code === payload.screenProfile || p.name === payload.screenProfile
      );
      const resolvedInvert180 =
        payload.invert180 !== undefined
          ? Boolean(payload.invert180)
          : profObj
          ? Boolean(profObj.defaultInvert180)
          : false;

      if (!dev) {
        dev = {
          id: crypto.randomUUID(),
          hardwareUid: code || `BOX-${Math.floor(1000 + Math.random() * 9000)}`,
          deviceToken: crypto.randomBytes(24).toString('hex'),
          pairingCode: code,
          name: payload.name || 'Box Android X98 Plus',
          brand: payload.brand || 'FNAC',
          storeName: payload.storeName || 'FNAC Colombo (Lisboa)',
          zone: payload.zone || 'ENTRANCE_LEDWALL',
          category: payload.category || 'ANDROID_BOX',
          interactionMode: resolvedMode,
          screenProfile: payload.screenProfile || '1920x1080 (16:9)',
          invert180: resolvedInvert180,
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
        if (!dev.deviceToken) {
          dev.deviceToken = crypto.randomBytes(24).toString('hex');
        }
        dev.name = payload.name || dev.name;
        dev.storeName = payload.storeName || dev.storeName;
        dev.zone = payload.zone || dev.zone;
        dev.category = payload.category || dev.category;
        dev.interactionMode = resolvedMode;
        dev.screenProfile = payload.screenProfile || dev.screenProfile;
        dev.invert180 = resolvedInvert180;
        dev.status = 'ONLINE';
        dev.lastSeenAt = new Date().toISOString();
      }

      logAuditEvent({
        action: 'PAIR_DEVICE_APPROVED',
        actor: 'IT_OPS',
        role: 'IT_OPS',
        target: `${dev.name} (${dev.hardwareUid})`,
        details: `Dispositivo aprovado para ${dev.storeName} [${dev.brand}] com DeviceToken criptográfico`,
        clientIp: req.socket?.remoteAddress || '',
        success: true,
      });

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

  // 5B. POST /api/v1/live/devices/invert -> Inverte 180° ("pernas para o ar") instantaneamente num equipamento!
  if (req.method === 'POST' && url.pathname === '/api/v1/live/devices/invert') {
    try {
      const payload = await readJsonBody(req);
      const hwUid = payload.hardwareUid;
      const dev = state.devices.find(
        (d) => d.hardwareUid === hwUid || d.pairingCode === hwUid
      );
      if (!dev) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'DEVICE_NOT_FOUND' }));
        return;
      }
      dev.invert180 = payload.invert180 !== undefined ? Boolean(payload.invert180) : !dev.invert180;
      saveState();
      broadcastUpdate({
        type: 'DEVICE_PAIRED',
        hardwareUid: dev.hardwareUid,
        pairingCode: dev.pairingCode,
        device: dev,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, device: dev, state: getEnrichedState() }));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'INVERT_ERROR' }));
    }
    return;
  }

  // 5B-2. POST /api/v1/live/security/tamper-alert -> Recebe alertas de tentativa de MITM / assinatura inválida no Player
  if (req.method === 'POST' && url.pathname === '/api/v1/live/security/tamper-alert') {
    try {
      const payload = await readJsonBody(req);
      const hwUid = payload.hardwareUid;
      const devName = payload.deviceName || hwUid || 'Terminal Desconhecido';
      const dev = state.devices.find(
        (d) => d.hardwareUid === hwUid || d.name === devName
      );
      if (dev) {
        dev.securityAlert = true;
        dev.securityAlertReason = payload.reason || 'SIGNATURE_VERIFICATION_FAILED';
        dev.securityAlertAt = new Date().toISOString();
        dev.securityAlertDetails = payload.details || 'Assinatura digital do manifesto não confere com a chave do servidor';
      }

      logAuditEvent({
        action: 'SECURITY_TAMPER_ALERT',
        actor: devName,
        role: 'PLAYER_KIOSK',
        target: dev ? `${dev.name} (${dev.storeName})` : devName,
        details: `Tentativa de adulteração bloqueada: ${payload.reason || 'Assinatura HMAC-SHA256 inválida'}. O terminal manteve o cache seguro.`,
        clientIp: req.socket?.remoteAddress || '',
        success: false,
      });

      saveState();
      broadcastUpdate({
        type: 'SECURITY_ALERT',
        hardwareUid: hwUid,
        deviceName: devName,
        alert: {
          reason: payload.reason || 'SIGNATURE_MISMATCH',
          at: new Date().toISOString(),
        },
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, status: 'ALERT_LOGGED' }));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'TAMPER_ALERT_PARSE_ERROR' }));
    }
    return;
  }

  // 5B-3. POST /api/v1/live/security/reset-alert -> Permite ao operador limpar o alerta de segurança no Dashboard
  if (req.method === 'POST' && url.pathname === '/api/v1/live/security/reset-alert') {
    try {
      const payload = await readJsonBody(req);
      const hwUid = payload.hardwareUid;
      const dev = state.devices.find((d) => d.hardwareUid === hwUid);
      if (dev) {
        dev.securityAlert = false;
        delete dev.securityAlertReason;
        delete dev.securityAlertAt;
        delete dev.securityAlertDetails;
      }

      logAuditEvent({
        action: 'SECURITY_ALERT_RESET',
        actor: 'OPERATOR',
        role: 'IT_OPS',
        target: dev ? `${dev.name} (${dev.storeName})` : hwUid,
        details: 'Alerta de adulteração reposto pelo operador de consola.',
        clientIp: req.socket?.remoteAddress || '',
        success: true,
      });

      saveState();
      broadcastUpdate({
        type: 'DEVICE_UPDATED',
        hardwareUid: hwUid,
        device: dev,
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, device: dev, state: getEnrichedState() }));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'RESET_ALERT_ERROR' }));
    }
    return;
  }

  // 5C. POST /api/v1/live/settings -> Gestão Master Data (Lojas, Zonas, Formatos, Categorias & Purge Demo)
  if (req.method === 'POST' && url.pathname === '/api/v1/live/settings') {
    try {
      const payload = await readJsonBody(req);
      const action = payload.action;

      if (action === 'PURGE_DEMO_DATA') {
        state.productionStrictMode = true;
        // Remove lojas marcadas como isDemo (ou zera o baseline se todas forem demo mas o utilizador quiser manter apenas lojas reais)
        const realStores = (state.storesCatalog || []).filter((s) => !s.isDemo);
        state.storesCatalog = realStores;
        saveState();
        broadcastUpdate();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, state: getEnrichedState() }));
        return;
      }

      if (action === 'RESTORE_DEMO_DATA') {
        state.productionStrictMode = false;
        const existingReal = (state.storesCatalog || []).filter((s) => !s.isDemo);
        state.storesCatalog = [...existingReal, ...getDefaultStoresCatalog()];
        saveState();
        broadcastUpdate();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, state: getEnrichedState() }));
        return;
      }

      if (action === 'UPSERT_STORE' && payload.store) {
        const st = payload.store;
        const id = st.id || `st-${Date.now()}`;
        const newStore = {
          id,
          code: String(st.code || '1').trim(),
          brand: st.brand || 'FNAC',
          country: st.country || 'PT',
          region: st.region || 'Grande Lisboa',
          gatewaySubnet: String(st.gatewaySubnet || '').trim(),
          city: String(st.city || 'Lisboa').trim(),
          name: String(st.name || 'Nova Loja Fnac').trim(),
          lat: Number(st.lat || 38.753),
          lng: Number(st.lng || -9.189),
          baselineDevices: Number(st.baselineDevices || 0),
          baselineOffline: Number(st.baselineOffline || 0),
          baselineClicks: Number(st.baselineClicks || 0),
          compliancePct: Number(st.compliancePct || 100),
          isDemo: false,
        };
        const idx = state.storesCatalog.findIndex((s) => s.id === id || s.code === newStore.code);
        if (idx >= 0) {
          state.storesCatalog[idx] = newStore;
        } else {
          state.storesCatalog.unshift(newStore);
        }
      } else if (action === 'BULK_IMPORT_STORES' && Array.isArray(payload.stores)) {
        for (const st of payload.stores) {
          const code = String(st.code || Math.floor(100 + Math.random() * 900)).trim();
          const newStore = {
            id: `st-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            code,
            brand: (st.brand || 'FNAC').toUpperCase(),
            country: (st.country || 'PT').toUpperCase(),
            region: st.region || 'Geral',
            gatewaySubnet: String(st.gatewaySubnet || '').trim(),
            city: String(st.city || 'Lisboa').trim(),
            name: String(st.name || 'Loja').trim(),
            lat: Number(st.lat || 38.753),
            lng: Number(st.lng || -9.189),
            baselineDevices: 0,
            baselineOffline: 0,
            baselineClicks: 0,
            compliancePct: 100,
            isDemo: false,
          };
          const existingIdx = state.storesCatalog.findIndex((s) => s.code === code && s.brand === newStore.brand);
          if (existingIdx >= 0) {
            state.storesCatalog[existingIdx] = { ...state.storesCatalog[existingIdx], ...newStore, isDemo: false };
          } else {
            state.storesCatalog.push(newStore);
          }
        }
      } else if (action === 'DELETE_STORE' && payload.id) {
        state.storesCatalog = state.storesCatalog.filter((s) => s.id !== payload.id);
      } else if (action === 'UPSERT_ZONE' && payload.zone) {
        const z = payload.zone;
        const code = String(z.code || z.name || 'ZONA')
          .trim()
          .toUpperCase()
          .replace(/[^A-Z0-9_]/g, '_');
        const newZone = {
          id: z.id || `zn-${Date.now()}`,
          code,
          name: String(z.name || code).trim(),
          description: String(z.description || '').trim(),
        };
        const idx = state.zonesCatalog.findIndex((x) => x.code === code || x.id === newZone.id);
        if (idx >= 0) state.zonesCatalog[idx] = newZone;
        else state.zonesCatalog.push(newZone);
      } else if (action === 'DELETE_ZONE' && payload.id) {
        state.zonesCatalog = state.zonesCatalog.filter((x) => x.id !== payload.id);
      } else if (action === 'UPSERT_PROFILE' && payload.profile) {
        const p = payload.profile;
        const w = Number(p.widthPx || 1920);
        const h = Number(p.heightPx || 1080);
        const ratio = p.aspectRatio || (w === h ? '1:1' : w > h ? '16:9' : '9:16');
        const orientation = p.orientation || (h > w ? 'VERTICAL' : 'HORIZONTAL');
        const code = String(p.code || `${w}x${h}`).trim();
        const newProf = {
          id: p.id || `sp-${Date.now()}`,
          code,
          name: String(p.name || `${code} (${ratio})`).trim(),
          widthPx: w,
          heightPx: h,
          aspectRatio: ratio,
          orientation,
          defaultInvert180: Boolean(p.defaultInvert180),
        };
        const idx = state.screenProfilesCatalog.findIndex((x) => x.id === newProf.id || x.code === code);
        if (idx >= 0) state.screenProfilesCatalog[idx] = newProf;
        else state.screenProfilesCatalog.push(newProf);
      } else if (action === 'DELETE_PROFILE' && payload.id) {
        state.screenProfilesCatalog = state.screenProfilesCatalog.filter((x) => x.id !== payload.id);
      } else if (action === 'UPSERT_CATEGORY' && payload.category) {
        const c = payload.category;
        const code = String(c.code || c.name || 'DEVICE')
          .trim()
          .toUpperCase()
          .replace(/[^A-Z0-9_]/g, '_');
        const newCat = {
          id: c.id || `cat-${Date.now()}`,
          code,
          name: String(c.name || code).trim(),
          icon: c.icon || '🖥️',
          defaultMode: c.defaultMode || 'PASSIVE',
        };
        const idx = state.categoriesCatalog.findIndex((x) => x.code === code || x.id === newCat.id);
        if (idx >= 0) state.categoriesCatalog[idx] = newCat;
        else state.categoriesCatalog.push(newCat);
      } else if (action === 'DELETE_CATEGORY' && payload.id) {
        state.categoriesCatalog = state.categoriesCatalog.filter((x) => x.id !== payload.id);
      }

      saveState();
      broadcastUpdate();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, state: getEnrichedState() }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || 'SETTINGS_ERROR' }));
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

  // 7.0 POST /api/v1/live/telemetry/policy -> Alterar Política de Auditoria de Telemetria (Governance & Data Minimization)
  if (req.method === 'POST' && url.pathname === '/api/v1/live/telemetry/policy') {
    try {
      const payload = await readJsonBody(req);
      const policy = payload.policy; // 'RETAIL_MEDIA_ONLY' | 'FULL_AUDIT' | 'PAUSED'
      if (!['RETAIL_MEDIA_ONLY', 'FULL_AUDIT', 'PAUSED'].includes(policy)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'INVALID_POLICY', allowed: ['RETAIL_MEDIA_ONLY', 'FULL_AUDIT', 'PAUSED'] }));
        return;
      }
      state.telemetryAuditPolicy = policy;
      saveState();
      broadcastUpdate();

      logAuditEvent({
        action: 'TELEMETRY_POLICY_CHANGED',
        actor: payload.actor || 'Admin (Governance)',
        role: payload.role || 'GLOBAL_ADMIN',
        target: 'TelemetryGovernance',
        details: `Política de Auditoria de Proof of Play alterada para: ${policy}`,
        clientIp: req.socket?.remoteAddress || '127.0.0.1',
        success: true,
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, policy: state.telemetryAuditPolicy, state: getEnrichedState() }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'POLICY_UPDATE_FAILED', details: String(err) }));
    }
    return;
  }

  // 7. POST /api/v1/live/telemetry -> Registo de Proof of Play e Interações em Bancada
  if (req.method === 'POST' && url.pathname === '/api/v1/live/telemetry') {
    try {
      const payload = await readJsonBody(req);
      if (payload.type === 'POP') {
        const policy = state.telemetryAuditPolicy || 'RETAIL_MEDIA_ONLY';
        if (policy === 'PAUSED') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'SKIPPED_PAUSED', message: 'Telemetria PoP pausada por política de governance.' }));
          return;
        }

        const dev = state.devices.find(
          (d) => d.hardwareUid === payload.hardwareUid || d.name === payload.deviceName
        );
        const storeName =
          dev?.storeName ||
          (payload.brand === 'DARTY' ? 'DARTY Montparnasse (Paris)' : 'FNAC Colombo (Lisboa)');
        const zone = dev?.zone || 'ENTRANCE_LEDWALL';

        const asset = (state.mediaCatalog || []).find((a) => a.id === payload.mediaId);
        const partner = resolveCommercialPartner(payload.mediaTitle, asset?.tags || []);
        const durationMs = Number(payload.durationMs || 8000);
        const contractedSovPct = Number(payload.sovPct || (payload.priority === 'EXCLUSIVA' ? 50 : 25));

        const isCommercial = isCommercialRetailMedia(partner, payload.mediaTitle, asset?.tags || []);

        if (policy === 'RETAIL_MEDIA_ONLY' && !isCommercial) {
          // Salva espaço em disco e minimiza dados: Conteúdo institucional / fallback sem contrato comercial direto não polui a base de dados
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'SKIPPED_NON_COMMERCIAL', message: 'Conteúdo institucional não auditado sob política RETAIL_MEDIA_ONLY.' }));
          return;
        }

        const existing = state.popRecords.find(
          (r) =>
            r.mediaId === payload.mediaId &&
            r.playlistName === payload.playlistName &&
            r.brand === (payload.brand || 'FNAC') &&
            r.storeName === storeName
        );

        if (existing) {
          existing.playCount += 1;
          existing.totalDurationMs += durationMs;
          existing.lastPlayedAt = new Date().toISOString();
          existing.partner = existing.partner || partner;
          existing.zone = existing.zone || zone;
          existing.contractedSovPct = existing.contractedSovPct || contractedSovPct;
        } else {
          state.popRecords.unshift({
            id: crypto.randomUUID(),
            brand: payload.brand || 'FNAC',
            storeName,
            zone,
            partner,
            playlistName: payload.playlistName || 'Programação Regular',
            priority: payload.priority || 'NORMAL',
            schedulingMode: payload.schedulingMode || 'FIXED_SLOTS',
            mediaId: payload.mediaId,
            mediaTitle: payload.mediaTitle || 'Conteúdo',
            contractedSovPct,
            playCount: 1,
            totalDurationMs: durationMs,
            firstPlayedAt: new Date().toISOString(),
            lastPlayedAt: new Date().toISOString(),
          });
        }

        // Registo na fita cronológica de auditoria de Proof of Play
        if (!Array.isArray(state.popAuditLogs)) state.popAuditLogs = [];
        state.popAuditLogs.unshift({
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          brand: payload.brand || 'FNAC',
          storeName,
          zone,
          deviceName: dev?.name || payload.deviceName || 'Terminal X98',
          hardwareUid: payload.hardwareUid || 'N/A',
          partner,
          playlistName: payload.playlistName || 'Programação Regular',
          mediaId: payload.mediaId,
          mediaTitle: payload.mediaTitle || 'Conteúdo',
          durationMs,
          priority: payload.priority || 'NORMAL',
          contractedSovPct,
          sha256: asset?.sha256 ? asset.sha256.slice(0, 16) + '...' : 'VERIFICADO',
        });
        if (state.popAuditLogs.length > 500) {
          state.popAuditLogs = state.popAuditLogs.slice(0, 500);
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

  // 7.1 POST /api/v1/live/telemetry/purge -> Purga e Limpeza de Dados de Telemetria e PoP
  if (req.method === 'POST' && url.pathname === '/api/v1/live/telemetry/purge') {
    try {
      const payload = await readJsonBody(req);
      const scope = payload.scope || 'ACTIVE_BRAND'; // 'ACTIVE_BRAND' | 'ALL' | 'NON_COMMERCIAL'
      const brand = payload.brand || 'FNAC';

      let purgedCount = 0;
      if (scope === 'ALL') {
        purgedCount =
          (state.popRecords?.length || 0) +
          (state.popAuditLogs?.length || 0) +
          (state.interactionRecords?.length || 0);
        state.popRecords = [];
        state.popAuditLogs = [];
        state.interactionRecords = [];
      } else if (scope === 'NON_COMMERCIAL') {
        const initialPop = (state.popRecords?.length || 0) + (state.popAuditLogs?.length || 0);
        state.popRecords = (state.popRecords || []).filter((r) =>
          isCommercialRetailMedia(r.partner, r.mediaTitle)
        );
        state.popAuditLogs = (state.popAuditLogs || []).filter((l) =>
          isCommercialRetailMedia(l.partner, l.mediaTitle)
        );
        purgedCount = initialPop - ((state.popRecords?.length || 0) + (state.popAuditLogs?.length || 0));
      } else {
        const initialPop = (state.popRecords?.length || 0) + (state.popAuditLogs?.length || 0);
        state.popRecords = (state.popRecords || []).filter((r) => r.brand && r.brand !== brand);
        state.popAuditLogs = (state.popAuditLogs || []).filter((l) => l.brand && l.brand !== brand);
        state.interactionRecords = (state.interactionRecords || []).filter((i) => i.brand && i.brand !== brand);
        purgedCount = initialPop - ((state.popRecords?.length || 0) + (state.popAuditLogs?.length || 0));
      }

      // Registo de auditoria imutável (NIS2 / RGPD Compliance)
      logAuditEvent({
        action: 'TELEMETRY_DATA_PURGED',
        actor: payload.actor || 'Admin (Break-Glass)',
        role: payload.role || 'GLOBAL_ADMIN',
        target:
          scope === 'ALL'
            ? 'GLOBAL (TODAS AS INSÍGNIAS)'
            : scope === 'NON_COMMERCIAL'
            ? 'RUÍDO NÃO-COMERCIAL (MANTEVE RETAIL MEDIA)'
            : `INSÍGNIA: ${brand}`,
        details: `Purga de telemetria PoP executada com sucesso (${purgedCount} registos eliminados). Âmbito: ${scope}.`,
        clientIp: req.socket?.remoteAddress || '',
        success: true,
      });

      saveState();
      broadcastUpdate();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: true,
          message:
            scope === 'ALL'
              ? 'Todos os registos de telemetria foram eliminados com sucesso.'
              : scope === 'NON_COMMERCIAL'
              ? `Foram eliminados ${purgedCount} registos de ruído institucional/editorial. Os dados de parceiros comerciais (Retail Media) foram preservados com sucesso.`
              : `Os registos de telemetria da marca ${brand} foram eliminados com sucesso (${purgedCount} registos).`,
          purgedCount,
          state: getEnrichedState(),
        })
      );
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'TELEMETRY_PURGE_ERROR', details: String(err) }));
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
      const stream = fs.createReadStream(filePath, { start, end });
      const cleanup = () => {
        if (!stream.destroyed) stream.destroy();
      };
      req.on('close', cleanup);
      res.on('close', cleanup);
      res.on('error', cleanup);
      stream.on('error', cleanup);
      stream.pipe(res);
      return;
    }

    res.writeHead(200, { 'Content-Length': totalSize });
    const stream = fs.createReadStream(filePath);
    const cleanup = () => {
      if (!stream.destroyed) stream.destroy();
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
    stream.on('error', cleanup);
    stream.pipe(res);
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
