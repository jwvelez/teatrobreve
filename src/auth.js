import crypto from 'node:crypto';
import { db, now } from './db.js';

/**
 * Entrada sin contraseña, modo demo:
 * - token de un solo uso (32 bytes random), solo se guarda el HASH
 * - expira en 15 min
 * - respuesta genérica exista o no el email (no revelar quién es cliente)
 * - rate limit en memoria por IP y por email
 * - NO se envía correo: el enlace se imprime en consola y se muestra en /admin
 */

const TOKEN_TTL_MIN = 15;
const SESSION_TTL_HOURS = 24 * 7;

// ---------- secret de sesión (persistido en meta) ----------
function sessionSecret() {
  let row = db.prepare("SELECT value FROM meta WHERE key = 'session_secret'").get();
  if (!row) {
    const secret = crypto.randomBytes(32).toString('hex');
    db.prepare("INSERT INTO meta (key, value) VALUES ('session_secret', ?)").run(secret);
    row = { value: secret };
  }
  return row.value;
}

// ---------- rate limit en memoria ----------
const buckets = new Map(); // key → [timestamps]
export function rateLimited(key, max = 5, windowMs = 15 * 60 * 1000) {
  const nowMs = Date.now();
  const hits = (buckets.get(key) ?? []).filter(t => nowMs - t < windowMs);
  if (hits.length >= max) { buckets.set(key, hits); return true; }
  hits.push(nowMs);
  buckets.set(key, hits);
  return false;
}

// ---------- interfaz limpia para producción ----------
// TODO producción: integrar proveedor de email transaccional (Resend/Postmark/SES).
// El demo imprime el enlace en consola y lo expone en /admin.
export function sendLoginEmail(email, url) {
  console.log(`\n[entrar] Enlace de acceso para ${email}:\n  ${url}\n`);
  db.prepare(`
    INSERT INTO meta (key, value) VALUES ('last_login_link', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(JSON.stringify({ email, url, at: now() }));
}

// ---------- tokens ----------
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function requestLogin(email, baseUrl) {
  const normalized = String(email ?? '').trim().toLowerCase();
  if (!normalized) return;
  const customer = db.prepare('SELECT email FROM customers WHERE email = ?').get(normalized);
  if (!customer) return; // respuesta genérica: no revelar

  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + TOKEN_TTL_MIN * 60 * 1000).toISOString();
  db.prepare('INSERT INTO login_tokens (email, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(normalized, hashToken(token), expires, now());
  sendLoginEmail(normalized, `${baseUrl}/entrar/${token}`);
}

export function consumeToken(token) {
  const row = db.prepare('SELECT * FROM login_tokens WHERE token_hash = ?').get(hashToken(String(token ?? '')));
  if (!row) return null;
  if (row.used_at) return null;
  if (new Date(row.expires_at) < new Date()) return null;
  db.prepare('UPDATE login_tokens SET used_at = ? WHERE id = ?').run(now(), row.id);
  return row.email;
}

// ---------- sesión con cookie firmada (httpOnly) ----------
function sign(payload) {
  const mac = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  return `${Buffer.from(payload).toString('base64url')}.${mac}`;
}

function verify(cookieValue) {
  const [b64, mac] = String(cookieValue ?? '').split('.');
  if (!b64 || !mac) return null;
  const payload = Buffer.from(b64, 'base64url').toString('utf8');
  const expected = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  const a = Buffer.from(mac), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const { email, exp } = JSON.parse(payload);
    if (!email || !exp || new Date(exp) < new Date()) return null;
    return email;
  } catch { return null; }
}

export function createSessionCookie(email) {
  const exp = new Date(Date.now() + SESSION_TTL_HOURS * 3600 * 1000).toISOString();
  const value = sign(JSON.stringify({ email, exp }));
  return `tb_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_HOURS * 3600}`;
}

export function clearSessionCookie() {
  return 'tb_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
}

export function sessionEmail(req) {
  const cookies = Object.fromEntries(
    String(req.headers.cookie ?? '').split(';').map(c => {
      const i = c.indexOf('=');
      return i === -1 ? [c.trim(), ''] : [c.slice(0, i).trim(), c.slice(i + 1).trim()];
    })
  );
  return verify(cookies.tb_session);
}

export function requireSession(req, res, next) {
  const email = sessionEmail(req);
  if (!email) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Sesión requerida' });
    return res.redirect('/entrar');
  }
  req.customerEmail = email;
  next();
}
