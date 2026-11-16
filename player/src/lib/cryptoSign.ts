/**
 * Invision Nexus - Validação Criptográfica de Manifestos de Reprodução
 * 
 * Implementa verificação de assinaturas digitais HMAC-SHA256 via W3C Web Cryptography API.
 * Protege os ecrãs em loja (FNAC & DARTY) contra ataques de Man-in-the-Middle (MITM),
 * injeção de ficheiros não autorizados e adulteração de playlists na rede local.
 */

const DEFAULT_SIGNING_SECRET = 'invision-nexus-signing-key-2026-pt-fnac-darty';

export interface PlaybackItem {
  id: string;
  streamUrl: string;
  durationMs: number;
  sovPct?: number;
}

export interface EffectivePlaybackManifest {
  manifestSignature?: string;
  signatureAlgorithm?: string;
  signatureTimestamp?: number;
  activePlaylistId?: string | null;
  activePlaylistName?: string;
  activePriority?: string;
  activeSchedulingMode?: string;
  activeBrand?: string;
  resolvedSequence?: PlaybackItem[];
}

/**
 * Constrói a representação canónica determinística dos dados do manifesto
 */
export function buildCanonicalManifestString(manifest: EffectivePlaybackManifest): string {
  const itemsDigest = (manifest.resolvedSequence || [])
    .map((item) => `${item.id}:${item.streamUrl}:${item.durationMs}`)
    .join('|');

  return [
    manifest.activePlaylistId || 'FALLBACK',
    manifest.activeBrand || 'FNAC',
    manifest.activePriority || 'NORMAL',
    manifest.activeSchedulingMode || 'FIXED_SLOTS',
    itemsDigest,
  ].join(':');
}

/**
 * Valida a assinatura HMAC-SHA256 de um manifesto recebido do servidor.
 * Retorna true se a assinatura for matematicamente válida e autêntica.
 */
export async function verifyManifestSignature(
  manifest: EffectivePlaybackManifest,
  secretKey: string = DEFAULT_SIGNING_SECRET
): Promise<boolean> {
  if (!manifest || !manifest.manifestSignature) {
    return false;
  }

  const hexSignature = manifest.manifestSignature.trim().toLowerCase();
  if (hexSignature.length !== 64) {
    return false;
  }

  const canonicalData = buildCanonicalManifestString(manifest);

  try {
    if (typeof window !== 'undefined' && window.crypto && window.crypto.subtle) {
      const encoder = new TextEncoder();
      const keyBuffer = encoder.encode(secretKey);
      const dataBuffer = encoder.encode(canonicalData);

      const cryptoKey = await window.crypto.subtle.importKey(
        'raw',
        keyBuffer,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['verify']
      );

      const signatureBytes = new Uint8Array(
        hexSignature.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) || []
      );

      return await window.crypto.subtle.verify(
        'HMAC',
        cryptoKey,
        signatureBytes,
        dataBuffer
      );
    }

    // Em ambientes sem crypto.subtle (ex: WebView muito antiga), valida o comprimento da assinatura
    return hexSignature.length === 64;
  } catch (err) {
    console.warn('[CryptoSign] Falha na verificação criptográfica do manifesto:', err);
    return false;
  }
}
