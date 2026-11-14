import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import fs from 'node:fs';

const execFileAsync = promisify(execFile);

export interface ProbedMediaMetadata {
  width_px: number;
  height_px: number;
  aspect_ratio: string;
  duration_ms: number;
  codec_info: string;
  sha256_hash: string;
  file_size_bytes: number;
}

export interface ScreenProfileSpec {
  name: string;
  width_px: number;
  height_px: number;
  aspect_ratio: string;
  aspect_tolerance_pct: number;
  allowed_codecs: string[];
}

export interface FormatValidationResult {
  valid: boolean;
  reason?: string;
  actualRatio: number;
  expectedRatio: number;
  deviationPct: number;
}

/**
 * Calcula o Máximo Divisor Comum para determinar a string de aspect ratio (ex: 16:9, 32:9, 9:16)
 */
function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

export function formatAspectRatio(width: number, height: number): string {
  const divisor = gcd(width, height);
  return `${Math.round(width / divisor)}:${Math.round(height / divisor)}`;
}

/**
 * Calcula SHA-256 em streaming sem carregar o vídeo inteiro na RAM do Synology DS220+
 */
export async function computeFileSha256(filePath: string): Promise<{ hash: string; size: number }> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    let size = 0;
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => {
      size += chunk.length;
      hash.update(chunk);
    });
    stream.on('end', () => resolve({ hash: hash.digest('hex'), size }));
    stream.on('error', reject);
  });
}

/**
 * Inspeciona o ficheiro via ffprobe (0% overhead de recodificação CPU)
 */
export async function probeMediaFile(filePath: string): Promise<ProbedMediaMetadata> {
  const { hash, size } = await computeFileSha256(filePath);

  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height,codec_name,duration:format=duration',
    '-of',
    'json',
    filePath,
  ]);

  const parsed = JSON.parse(stdout);
  const stream = parsed.streams?.[0];
  if (!stream || !stream.width || !stream.height) {
    throw new Error('FFPROBE_INVALID_STREAM: Não foi possível detetar stream visual válido no ficheiro.');
  }

  const width_px = Number(stream.width);
  const height_px = Number(stream.height);
  const durationSec = Number(stream.duration || parsed.format?.duration || 10);
  const duration_ms = Math.max(1000, Math.round(durationSec * 1000));
  const codec_info = String(stream.codec_name || 'unknown').toLowerCase();

  return {
    width_px,
    height_px,
    aspect_ratio: formatAspectRatio(width_px, height_px),
    duration_ms,
    codec_info,
    sha256_hash: hash,
    file_size_bytes: size,
  };
}

/**
 * Gera 1 thumbnail estático (.webp) leve a partir do segundo 1 do vídeo
 */
export async function generateThumbnail(videoPath: string, thumbOutputPath: string): Promise<void> {
  await execFileAsync('ffmpeg', [
    '-y',
    '-ss',
    '00:00:01',
    '-i',
    videoPath,
    '-frames:v',
    '1',
    '-vf',
    'scale=480:-1',
    '-q:v',
    '75',
    thumbOutputPath,
  ]);
}

/**
 * FORMAT GUARDRAIL: Verifica se um ficheiro de media respeita o perfil físico do terminal (ScreenProfile)
 */
export function validateMediaAgainstProfile(
  media: { width_px: number; height_px: number; codec_info: string },
  profile: ScreenProfileSpec
): FormatValidationResult {
  const actualRatio = media.width_px / media.height_px;
  const expectedRatio = profile.width_px / profile.height_px;
  const deviationPct = Math.abs((actualRatio - expectedRatio) / expectedRatio) * 100;

  if (!profile.allowed_codecs.includes(media.codec_info.toLowerCase())) {
    return {
      valid: false,
      reason: `Codec '${media.codec_info}' incompatível com o perfil '${profile.name}'. Codecs suportados: ${profile.allowed_codecs.join(', ')}.`,
      actualRatio,
      expectedRatio,
      deviationPct,
    };
  }

  if (deviationPct > Number(profile.aspect_tolerance_pct)) {
    return {
      valid: false,
      reason: `Incompatibilidade de Formato (Format Guardrail): O conteúdo é ${media.width_px}x${media.height_px}, mas o terminal '${profile.name}' exige ${profile.width_px}x${profile.height_px} (${profile.aspect_ratio}). Desvio de rácio: ${deviationPct.toFixed(2)}% (máx permitido: ${profile.aspect_tolerance_pct}%).`,
      actualRatio,
      expectedRatio,
      deviationPct,
    };
  }

  return {
    valid: true,
    actualRatio,
    expectedRatio,
    deviationPct,
  };
}

