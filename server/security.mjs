import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
export const opaqueToken = () => randomBytes(32).toString('hex');
export const hashToken = (token) => createHash('sha256').update(token).digest('hex');

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt}$${key.toString('hex')}`;
}

export async function verifyPassword(password, storedHash) {
  const [algorithm, salt, encoded] = String(storedHash).split('$');
  if (algorithm !== 'scrypt' || !/^[a-f0-9]{32}$/.test(salt ?? '') || !/^[a-f0-9]{128}$/.test(encoded ?? '')) return false;
  const actual = await scrypt(password, salt, 64);
  const expected = Buffer.from(encoded, 'hex');
  return timingSafeEqual(actual, expected);
}

export function parseCookies(header = '') {
  const cookies = {};
  for (const segment of header.split(';')) {
    const separator = segment.indexOf('=');
    if (separator < 0) continue;
    const key = segment.slice(0, separator).trim();
    try { cookies[key] = decodeURIComponent(segment.slice(separator + 1).trim()); } catch { /* Ignore malformed cookies. */ }
  }
  return cookies;
}

export function cookieOptions(req, maxAge) {
  return { httpOnly: true, secure: req.secure, sameSite: 'lax', path: '/', maxAge };
}

export function checkOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const allowed = process.env.APP_ORIGIN;
  const currentOrigin = `${req.protocol}://${req.get('host')}`;
  const origin = req.get('origin');
  if (!origin || origin !== (allowed || currentOrigin)) {
    return res.status(403).json({ error: 'Запрос должен быть отправлен с сайта приложения.', code: 'INVALID_ORIGIN' });
  }
  const photoUpload = req.method === 'POST' && req.path === '/supplier/photos' && req.is('multipart/form-data');
  if (['POST', 'PUT', 'PATCH'].includes(req.method) && !req.is('application/json') && !photoUpload) {
    return res.status(415).json({ error: 'Ожидается JSON.', code: 'JSON_REQUIRED' });
  }
  next();
}
