function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: required('JWT_SECRET'),
  // Staff stay logged in on their device until they explicitly log out: for an internal tool
  // where the phone itself is the access control, re-asking for a password every 12 hours was
  // pure friction with no real security benefit. 180 days is long enough that in practice it
  // never expires during normal use, while a lost/stolen device can still be handled by rotating
  // JWT_SECRET (which invalidates every issued token at once) or deactivating the staff account.
  tokenTtl: process.env.TOKEN_TTL ?? '180d',
  photoDir: process.env.PHOTO_DIR ?? '/data/photos',
  maxPhotoBytes: Number(process.env.MAX_PHOTO_BYTES ?? 12 * 1024 * 1024),
  orphanPhotoTtlHours: Number(process.env.ORPHAN_PHOTO_TTL_HOURS ?? 24),
  logLevel: process.env.LOG_LEVEL ?? 'info',
};
