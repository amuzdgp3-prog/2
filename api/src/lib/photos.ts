import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { link, mkdir, open, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { Client } from '../db/pool.js';
import { config } from '../config.js';
import { badRequest } from './errors.js';

export function photoPath(directory: string, objectKey: string): string {
  const target = resolve(directory, objectKey);
  const remainder = relative(resolve(directory), target);
  if (!remainder || remainder === '..' || remainder.startsWith(`..${sep}`) || isAbsolute(remainder) || objectKey.includes('\0')) {
    throw badRequest('BAD_OBJECT_KEY', 'некорректный идентификатор файла');
  }
  return target;
}

function rasterType(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return 'image/jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
}

export async function normalizePhoto(input: Buffer) {
  const originalType = rasterType(input);
  if (!originalType) throw badRequest('INVALID_PHOTO', 'загрузите изображение JPEG, PNG или WebP');
  const png = originalType === 'image/png';
  const codec = png ? 'png' : originalType === 'image/jpeg' ? 'mjpeg' : 'webp';
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const process = execFile('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-xerror', '-filter_threads', '1',
      '-max_pixels', '32000000', '-threads', '1', '-protocol_whitelist', 'pipe',
      '-f', 'image2pipe', '-c:v', codec, '-i', 'pipe:0', '-frames:v', '1', '-map_metadata', '-1',
      '-threads:v', '1', '-c:v', png ? 'png' : 'mjpeg',
      ...(png ? [] : ['-q:v', '2']),
      '-f', 'image2pipe', 'pipe:1',
    ], { encoding: 'buffer', maxBuffer: config.maxPhotoBytes, timeout: 8000, windowsHide: true }, (error, output) => {
      if (error) reject(error);
      else resolve(output);
    });
    process.stdin?.on('error', reject);
    process.stdin?.end(input);
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') throw error;
    throw badRequest('INVALID_PHOTO', 'изображение повреждено или слишком велико');
  });
  if (rasterType(bytes) !== (png ? 'image/png' : 'image/jpeg')) {
    throw badRequest('INVALID_PHOTO', 'изображение повреждено или слишком велико');
  }
  return { bytes, extension: png ? 'png' : 'jpg', contentType: png ? 'image/png' : 'image/jpeg' };
}

export function immutablePhotoKey(localId: string, actorId: number | null, bytes: Buffer, extension: string): string {
  const digest = createHash('sha256').update(String(actorId)).update(':').update(bytes).digest('hex');
  return `services/${localId.toLowerCase()}-${digest}.${extension}`;
}

export async function lockPhoto(client: Client, objectKey: string) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('photo:' || $1, 0))", [objectKey]);
}

export async function storeImmutablePhoto(target: string, bytes: Buffer) {
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await link(temporary, target).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export async function openRasterPhoto(target: string) {
  const file = await open(target, 'r').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (!file) return null;
  try {
    const prefix = Buffer.alloc(12);
    const { bytesRead } = await file.read(prefix, 0, prefix.length, 0);
    const contentType = rasterType(prefix.subarray(0, bytesRead));
    if (contentType) return { contentType, stream: file.createReadStream({ start: 0 }) };
  } catch (error) {
    await file.close();
    throw error;
  }
  await file.close();
  return null;
}
