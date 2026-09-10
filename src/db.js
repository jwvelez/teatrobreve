import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, 'lab.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS shows (
  id TEXT PRIMARY KEY,            -- event_series id de TT
  name TEXT,
  slug TEXT,
  thumbnail_url TEXT,
  raw TEXT,                       -- JSON crudo, la fuente de verdad de nombres de campos
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS occurrences (
  id TEXT PRIMARY KEY,            -- event id de TT (una función)
  show_id TEXT,
  starts_at TEXT,                 -- ISO local
  ends_at TEXT,
  status TEXT,                    -- valor literal que reporte el API
  sale_start_at TEXT,             -- si el API lo expone (V5)
  checkout_url TEXT,
  raw TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS ticket_types (
  id TEXT PRIMARY KEY,
  occurrence_id TEXT,
  name TEXT,
  price_cents INTEGER,
  quantity_total INTEGER,
  raw TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS availability_cache (
  occurrence_id TEXT NOT NULL,
  ticket_type_id TEXT NOT NULL,
  quantity INTEGER,
  issued INTEGER,
  remaining INTEGER,
  status TEXT,                    -- onsale | low | soldout | soon
  last_synced_at TEXT,
  PRIMARY KEY (occurrence_id, ticket_type_id)
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  phone TEXT,
  points INTEGER DEFAULT 0,       -- fase futura, sin uso
  tier TEXT,                      -- fase futura, sin uso
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,            -- order id de TT
  customer_email TEXT,
  occurrence_id TEXT,
  total_cents INTEGER,
  currency TEXT,
  status TEXT,
  source TEXT,                    -- 'webhook' | 'api'
  raw TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS issued_tickets (
  id TEXT PRIMARY KEY,
  order_id TEXT,
  occurrence_id TEXT,
  ticket_type_id TEXT,
  barcode TEXT,
  status TEXT,
  seat_section TEXT,              -- si el API los expone (V6)
  seat_row TEXT,
  seat_number TEXT,
  checked_in INTEGER DEFAULT 0,   -- V10
  checked_in_at TEXT,
  raw TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_email TEXT NOT NULL,
  occurrence_id TEXT NOT NULL,
  ticket_id TEXT,
  attended INTEGER DEFAULT 0,
  checked_in_at TEXT,
  UNIQUE (customer_email, occurrence_id, ticket_id)
);

CREATE TABLE IF NOT EXISTS webhook_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tt_event_id TEXT UNIQUE,        -- id del evento de webhook (dedupe/idempotencia)
  event_type TEXT,
  signature_header_name TEXT,
  signature_scheme TEXT,          -- descripción del esquema HMAC que verificó
  signature_valid INTEGER,        -- 1 válido, 0 inválido, NULL sin secret configurado
  headers TEXT,
  payload TEXT,
  dump_path TEXT,
  processed INTEGER DEFAULT 0,
  received_at TEXT
);

CREATE TABLE IF NOT EXISTS verifications (
  id TEXT PRIMARY KEY,            -- V1..V12
  title TEXT,
  critical INTEGER DEFAULT 0,
  status TEXT DEFAULT 'PENDIENTE',-- PENDIENTE | PASA | FALLA | PARCIAL
  fields_found TEXT,              -- nombres literales de campos descubiertos
  dump_path TEXT,
  notes TEXT,
  updated_at TEXT
);

-- Evidencia de V4: cada transición a agotado, por qué vía y cuándo
CREATE TABLE IF NOT EXISTS soldout_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurrence_id TEXT,
  source TEXT,                    -- 'webhook' | 'sync'
  detected_at TEXT,
  details TEXT
);

-- Descubrimiento de campos: qué nombres literales existen en cada recurso
CREATE TABLE IF NOT EXISTS field_discovery (
  resource TEXT NOT NULL,
  field TEXT NOT NULL,
  sample TEXT,
  discovered_at TEXT,
  PRIMARY KEY (resource, field)
);

-- Evidencia de V11: hits reales a /gracias con parámetros tt_*
CREATE TABLE IF NOT EXISTS gracias_hits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query_params TEXT,
  order_fetch_ok INTEGER,
  received_at TEXT
);

-- Demo de perfil: entrada sin contraseña por enlace de un solo uso
CREATE TABLE IF NOT EXISTS login_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,  -- solo el hash; el token vive en el enlace
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT
);

-- Config interna (secret de sesión, último enlace de entrada para /admin)
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Preferencias de correo del cliente (solo locales, no existen en TT)
CREATE TABLE IF NOT EXISTS customer_prefs (
  email TEXT PRIMARY KEY,
  newsletter INTEGER DEFAULT 1,
  show_reminders INTEGER DEFAULT 1,
  offers INTEGER DEFAULT 0,
  updated_at TEXT
);

-- Diagnóstico del modal: postMessages capturados por la cartelera
CREATE TABLE IF NOT EXISTS debug_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  origin TEXT,
  data TEXT,
  received_at TEXT
);

-- ---------- Compartir boletos con el corillo ----------
-- Quién tiene cada boleto. Una fila por issued_ticket (el comprador arranca como 'owner').
CREATE TABLE IF NOT EXISTS ticket_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issued_ticket_id TEXT UNIQUE NOT NULL,
  occurrence_id TEXT,
  holder_email TEXT,                -- a quién le toca este boleto
  holder_customer_id INTEGER,       -- null hasta que lo reclama
  status TEXT DEFAULT 'owner',      -- owner | sent | claimed | revoked
  sent_at TEXT,
  claimed_at TEXT,
  revoked_at TEXT,
  claim_token_hash TEXT,            -- solo el hash; el token vive en el enlace del correo
  claim_expires_at TEXT,
  created_at TEXT,
  updated_at TEXT
);

-- Ledger de puntos. UNIQUE(customer, occurrence) = un punto por persona por FUNCIÓN,
-- no por boleto: si alguien se queda con 2 boletos de la misma función, gana 1.
CREATE TABLE IF NOT EXISTS loyalty_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  occurrence_id TEXT NOT NULL,
  issued_ticket_id TEXT,            -- el boleto que lo originó (informativo)
  points INTEGER NOT NULL DEFAULT 1,
  awarded_at TEXT,
  UNIQUE (customer_id, occurrence_id)
);

-- ---------- El Pase (pase de temporada sobre MEMBRESÍAS nativas de TT) ----------
-- Un pase = un membership type + un producto + un ticket type "members only" por planta.
-- TT hace cumplir el acceso y LLEVA EL CONTADOR (issued_membership.redemptions).
-- Estas tablas son ESPEJO para el perfil y para detectar anomalías, no guardia.
CREATE TABLE IF NOT EXISTS pass_products (
  id TEXT PRIMARY KEY,              -- slug propio, ej. 'pase-2026-baja'
  name TEXT NOT NULL,
  planta TEXT,                      -- 'baja' | 'alta'
  tt_product_id TEXT NOT NULL,      -- pr_xxx: lo que compra el abonado
  membership_type_id TEXT NOT NULL, -- mt_xxx: lo que TT le emite al comprar
  ticket_type_id TEXT NOT NULL,     -- tt_xxx: el boleto $0 "members only" que ve el abonado
  show_id TEXT,                     -- serie donde vive ese ticket type
  price_cents INTEGER,              -- lo que paga (sin fees)
  max_redemptions INTEGER,          -- espejo del membership type
  season_end TEXT,                  -- ISO: espejo de valid_to del membership type
  store_url TEXT,                   -- enlace de compra del producto (se abre en el modal)
  active INTEGER DEFAULT 1,
  raw TEXT,                         -- JSON de product + membership_type + ticket_type
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS season_passes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER,
  pass_product_id TEXT NOT NULL,
  order_id TEXT,                    -- la orden con que compró el producto
  issued_membership_id TEXT UNIQUE, -- im_xxx (null mientras TT no la haya emitido)
  membership_code TEXT,             -- el "code" de la membresía
  -- pending: compra vista pero membresía aún no localizada en TT (se reintenta)
  status TEXT DEFAULT 'pending',    -- pending | active | exhausted | expired | voided
  redemptions INTEGER DEFAULT 0,    -- espejo de TT
  max_redemptions INTEGER,
  valid_from TEXT,
  valid_to TEXT,
  last_synced_at TEXT,
  raw TEXT,                         -- último JSON del issued_membership
  created_at TEXT,
  updated_at TEXT
);

-- Espejo de cada redención: la orden a $0 con el ticket type del pase.
CREATE TABLE IF NOT EXISTS pass_redemptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season_pass_id INTEGER NOT NULL,
  order_id TEXT NOT NULL,
  occurrence_id TEXT,
  issued_ticket_id TEXT,
  tickets_count INTEGER NOT NULL DEFAULT 1,
  redeemed_at TEXT,
  UNIQUE (season_pass_id, order_id)
);

-- Lo que NO debería pasar. Ruidoso en /admin, nunca se arregla en silencio.
CREATE TABLE IF NOT EXISTS pass_anomalies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season_pass_id INTEGER,
  kind TEXT NOT NULL,
  detail TEXT,                      -- JSON
  detected_at TEXT,
  resolved_at TEXT
);
`);

// Columnas ricas del boleto (FINDINGS: qr_code_url, description, listed_price, etc.)
// ALTER idempotente: ignora si la columna ya existe.
for (const col of [
  "qr_code_url TEXT", "barcode_url TEXT", "description TEXT",
  "listed_price INTEGER", "email TEXT", "event_series_id TEXT", "voided_at TEXT",
]) {
  try { db.exec(`ALTER TABLE issued_tickets ADD COLUMN ${col}`); } catch { /* ya existe */ }
}

const SEED_VERIFICATIONS = [
  ['V1',  'Conexión · GET /v1/ping y headers de rate limit', 0],
  ['V2',  'Catálogo · event_series, events y campos de fecha/hora/estado', 0],
  ['V3',  'CRÍTICA · Disponibilidad: total, emitidos, restantes', 1],
  ['V4',  'CRÍTICA · Agotado: estado explícito vs remaining=0, latencia webhook/sync', 1],
  ['V5',  'Venta no abierta: fecha de inicio de venta expuesta', 0],
  ['V6',  'CRÍTICA · Asientos: categorías, precios, sección/fila/asiento', 1],
  ['V7',  'CRÍTICA · Webhooks: header de firma, HMAC, payload de orden', 1],
  ['V8',  'Reembolso: webhook recibido, estado de orden, liberación de aforo', 0],
  ['V9',  'Datos de cliente: reconstruir base por email desde /v1/orders', 0],
  ['V10', 'Check-in: boletos escaneados visibles por API', 0],
  ['V11', 'Redirección post-compra: parámetros tt_* llegan a /gracias', 0],
  ['V12', 'Holds: crear hold por API y verificar descuento de aforo', 0],
  ['V13', 'CRÍTICA · Puntos: boleto reclamado + check-in = exactamente 1 punto (idempotente)', 1],
  ['V14', 'CRÍTICA · Boleto enviado y NO reclamado no otorga punto aunque se escanee', 1],
  ['V15', 'Dos boletos de la misma función en la misma persona = 1 punto', 0],
  ['V18', 'El Pase · ¿"Members only" convive con seating chart?', 1],
  ['V21', 'El Pase · ¿Se puede preaplicar el código de membresía por parámetro en la URL del checkout?', 0],
  ['V22', 'El Pase · ¿Una orden de $0 (redención) dispara el webhook igual que una pagada?', 1],
  ['V23', 'BLOQUEANTE · El Pase: ¿asignar ticket types al crear el discount por API?', 1],
  ['V24', 'BLOQUEANTE · El Pase: monto fijo, ¿descuenta por ORDEN o por BOLETO?', 1],
  ['V25', 'El Pase · Al agotar max_redemptions de la membresía, ¿el boleto deja de aparecer?', 0],
];

const insertVerification = db.prepare(
  `INSERT OR IGNORE INTO verifications (id, title, critical, updated_at) VALUES (?, ?, ?, datetime('now'))`
);
for (const [id, title, critical] of SEED_VERIFICATIONS) insertVerification.run(id, title, critical);

export function now() {
  return new Date().toISOString();
}

export function recordFieldDiscovery(resource, obj) {
  if (!obj || typeof obj !== 'object') return;
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO field_discovery (resource, field, sample, discovered_at) VALUES (?, ?, ?, ?)`
  );
  const tx = db.transaction(() => {
    for (const [k, v] of Object.entries(obj)) {
      let sample;
      try {
        sample = JSON.stringify(v);
        if (sample && sample.length > 300) sample = sample.slice(0, 300) + '…';
      } catch { sample = String(v); }
      stmt.run(resource, k, sample, now());
    }
  });
  tx();
}

export function setVerification(id, { status, fields_found, dump_path, notes } = {}) {
  // Regla de oro: PASA exige dump como evidencia.
  if (status === 'PASA') {
    const current = db.prepare('SELECT dump_path FROM verifications WHERE id = ?').get(id);
    const effectiveDump = dump_path ?? current?.dump_path;
    if (!effectiveDump) {
      status = 'PARCIAL';
      notes = (notes ? notes + ' · ' : '') + 'Degradado a PARCIAL: falta dump de evidencia.';
    }
  }
  db.prepare(`
    UPDATE verifications SET
      status = COALESCE(?, status),
      fields_found = COALESCE(?, fields_found),
      dump_path = COALESCE(?, dump_path),
      notes = COALESCE(?, notes),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(status ?? null, fields_found ?? null, dump_path ?? null, notes ?? null, id);
}
