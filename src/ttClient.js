import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DUMPS_DIR = path.join(ROOT, 'dumps');
fs.mkdirSync(path.join(DUMPS_DIR, 'webhooks'), { recursive: true });

const BASE = 'https://api.tickettailor.com/v1';

export function hasApiKey() {
  return Boolean(process.env.TICKET_TAILOR_API_KEY);
}

// Último estado de rate limit visto, para el panel admin. Nunca guardamos el key.
export const rateLimitState = { remaining: null, retryAfter: null, lastRequestAt: null };

function authHeader() {
  const key = process.env.TICKET_TAILOR_API_KEY;
  if (!key) throw new Error('TICKET_TAILOR_API_KEY no está configurado en .env');
  return 'Basic ' + Buffer.from(`${key}:`).toString('base64');
}

/**
 * Request crudo al API. Devuelve { status, json, headers } y nunca lanza por
 * status HTTP != 2xx (el laboratorio necesita ver las respuestas de error).
 * Maneja 429 con backoff según Retry-After (hasta 3 reintentos).
 */
export async function ttRequest(pathname, { method = 'GET', query, form } = {}) {
  const url = new URL(BASE + pathname);
  if (query) for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  const headers = { Authorization: authHeader(), Accept: 'application/json' };
  let body;
  if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  }

  for (let attempt = 0; attempt <= 3; attempt++) {
    const res = await fetch(url, { method, headers, body });
    rateLimitState.remaining = res.headers.get('x-rate-limit-remaining');
    rateLimitState.retryAfter = res.headers.get('retry-after');
    rateLimitState.lastRequestAt = new Date().toISOString();

    if (res.status === 429 && attempt < 3) {
      const wait = Math.min(Number(res.headers.get('retry-after') || 5), 60);
      console.warn(`[tt] 429 rate limited, backoff ${wait}s (intento ${attempt + 1}/3)`);
      await new Promise(r => setTimeout(r, wait * 1000));
      continue;
    }

    let json = null;
    const text = await res.text();
    try { json = text ? JSON.parse(text) : null; } catch { json = { _raw_text: text }; }

    const headerObj = {};
    res.headers.forEach((v, k) => { headerObj[k] = v; });
    return { status: res.status, json, headers: headerObj };
  }
  throw new Error('Rate limit persistente tras 3 reintentos');
}

/**
 * Paginación por cursor: starting_after con el último id, limit 100, hasta agotar.
 */
export async function ttListAll(pathname, query = {}) {
  const all = [];
  let startingAfter;
  let lastResponse = null;
  for (let page = 0; page < 100; page++) {
    const q = { ...query, limit: 100 };
    if (startingAfter) q.starting_after = startingAfter;
    const res = await ttRequest(pathname, { query: q });
    lastResponse = res;
    if (res.status !== 200 || !res.json) break;
    const items = Array.isArray(res.json.data) ? res.json.data : [];
    all.push(...items);
    if (items.length < 100) break;
    const last = items[items.length - 1];
    if (!last?.id) break;
    startingAfter = last.id;
  }
  return { items: all, lastResponse };
}

/**
 * Vuelca JSON crudo a /dumps/{recurso}-{timestamp}.json.
 * Devuelve la ruta relativa (servida en /dumps/... por el server).
 */
export function dump(resource, data, subdir = '') {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const safe = resource.replace(/[^a-zA-Z0-9_-]/g, '_');
  const dir = subdir ? path.join(DUMPS_DIR, subdir) : DUMPS_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${safe}-${ts}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return '/dumps/' + path.relative(DUMPS_DIR, file).split(path.sep).join('/');
}

/**
 * Selección defensiva de campos: la doc renderiza esquemas client-side, así que
 * NO confiamos en nombres de memoria. pick() prueba candidatos contra el JSON
 * real y devuelve { field, value } del primer nombre que exista de verdad.
 */
export function pick(obj, candidates) {
  if (!obj || typeof obj !== 'object') return { field: null, value: undefined };
  for (const c of candidates) {
    // soporta rutas anidadas "a.b"
    const parts = c.split('.');
    let v = obj;
    let ok = true;
    for (const p of parts) {
      if (v && typeof v === 'object' && p in v) v = v[p];
      else { ok = false; break; }
    }
    if (ok && v !== undefined && v !== null) return { field: c, value: v };
  }
  return { field: null, value: undefined };
}
