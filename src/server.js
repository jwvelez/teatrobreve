import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, now } from './db.js';
import { hasApiKey, ttRequest, dump, rateLimitState, DUMPS_DIR } from './ttClient.js';
import { syncAll, syncStatus } from './sync.js';
import { handleWebhook } from './webhooks.js';
import { runVerification, runners } from './verifications.js';
import { mockCartelera } from './mock.js';
import { requestLogin, consumeToken, createSessionCookie, clearSessionCookie, requireSession, sessionEmail, rateLimited } from './auth.js';
import { getProfile, getTicket, updateLocalData, updatePreferences } from './profile.js';
import { processOrder } from './webhooks.js';
import { ttListAll } from './ttClient.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = express();
const PORT = Number(process.env.PORT || 3000);

// El webhook necesita el body CRUDO para verificar la firma HMAC
app.post('/webhooks/tickettailor', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
  try {
    const result = await handleWebhook(req.body ?? Buffer.from(''), req.headers);
    res.status(200).json({ ok: true, deduped: result.deduped });
  } catch (err) {
    console.error('[webhook] error:', err.message);
    // 200 igualmente: no queremos que TT reintente por bugs del laboratorio
    res.status(200).json({ ok: false, error: err.message });
  }
});

app.use(express.json());
app.use(express.static(path.join(ROOT, 'public')));
app.use('/dumps', express.static(DUMPS_DIR));

// ---------- Cartelera (siempre desde caché local, nunca directo del API) ----------
app.get('/api/cartelera', (req, res) => {
  const rows = db.prepare(`
    SELECT o.id, o.show_id, o.starts_at, o.status AS occ_status, o.sale_start_at, o.checkout_url,
           s.name AS show_name, s.slug AS show_slug, s.thumbnail_url
    FROM occurrences o LEFT JOIN shows s ON s.id = o.show_id
    ORDER BY o.starts_at
  `).all();

  if (!rows.length) {
    // Sin datos reales todavía: seed mock para poder probar la UI (se reemplaza solo al primer sync)
    return res.json({ source: 'mock', performances: mockCartelera() });
  }

  const cacheStmt = db.prepare(`SELECT * FROM availability_cache WHERE occurrence_id = ?`);
  const ttStmt = db.prepare(`SELECT * FROM ticket_types WHERE occurrence_id = ?`);
  const performances = rows.map(r => {
    const cache = cacheStmt.all(r.id);
    const tts = ttStmt.all(r.id);
    const prices = tts.map(t => t.price_cents).filter(p => p != null);
    let status = 'onsale';
    if (cache.length) {
      if (cache.every(c => c.status === 'soldout')) status = 'soldout';
      else if (cache.some(c => c.status === 'soon')) status = 'soon';
      else if (cache.some(c => c.status === 'low')) status = 'low';
    }
    if (r.sale_start_at && new Date(r.sale_start_at) > new Date()) status = 'soon';
    const dt = r.starts_at ? new Date(r.starts_at) : null;
    return {
      id: r.id,
      showTitle: r.show_name ?? 'Show',
      showSlug: r.show_slug ?? String(r.show_id ?? r.id),
      date: r.starts_at ? r.starts_at.slice(0, 10) : null,
      time: r.starts_at && r.starts_at.length > 10 ? r.starts_at.slice(11, 16) : null,
      priceLower: prices.length ? Math.min(...prices) : null,
      priceUpper: prices.length ? Math.max(...prices) : null,
      status,
      thumbnailUrl: r.thumbnail_url,
      checkoutUrl: r.checkout_url,
      remaining: cache.reduce((a, c) => a + (c.remaining ?? 0), 0),
      lastSyncedAt: cache[0]?.last_synced_at ?? null,
      _dt: dt,
    };
  });
  res.json({ source: 'cache', performances });
});

// ---------- /gracias: confirmación propia (V11) ----------
app.get('/gracias', (req, res) => {
  if (Object.keys(req.query).length) {
    db.prepare('INSERT INTO gracias_hits (query_params, order_fetch_ok, received_at) VALUES (?, 0, ?)')
      .run(JSON.stringify(req.query), now());
  }
  res.sendFile(path.join(ROOT, 'public', 'gracias.html'));
});

app.get('/api/order/:id', async (req, res) => {
  if (!hasApiKey()) return res.status(503).json({ error: 'Sin TICKET_TAILOR_API_KEY configurado' });
  try {
    // Hallazgo V11: el redirect manda tt_order_id SIN prefijo ("81118285"),
    // pero el API exige "or_81118285". Normalizar aquí.
    const orderId = /^\d+$/.test(req.params.id) ? `or_${req.params.id}` : req.params.id;
    const r = await ttRequest(`/orders/${encodeURIComponent(orderId)}`);
    const dumpPath = dump(`order-${req.params.id}`, r.json);
    if (r.status === 200) {
      db.prepare(`
        UPDATE gracias_hits SET order_fetch_ok = 1
        WHERE id = (SELECT id FROM gracias_hits WHERE query_params LIKE ? ORDER BY received_at DESC LIMIT 1)
      `).run(`%${req.params.id}%`);
    }
    res.status(r.status === 200 ? 200 : 502).json({ status: r.status, dump: dumpPath, order: r.json });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Admin ----------
app.get('/admin', (_req, res) => res.sendFile(path.join(ROOT, 'public', 'admin.html')));

app.get('/api/verifications', (_req, res) => {
  res.json(db.prepare('SELECT * FROM verifications ORDER BY CAST(substr(id, 2) AS INTEGER)').all());
});

app.post('/api/verifications/:id/run', async (req, res) => {
  const id = req.params.id.toUpperCase();
  if (!runners[id]) return res.status(400).json({ error: `${id} no tiene runner automático` });
  try {
    const row = await runVerification(id);
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/verifications/:id', (req, res) => {
  const { status, notes, fields_found, dump_path } = req.body ?? {};
  if (status === 'PASA' && !dump_path) {
    const current = db.prepare('SELECT dump_path FROM verifications WHERE id = ?').get(req.params.id.toUpperCase());
    if (!current?.dump_path) return res.status(400).json({ error: 'PASA exige un dump de evidencia (dump_path)' });
  }
  db.prepare(`
    UPDATE verifications SET
      status = COALESCE(?, status), notes = COALESCE(?, notes),
      fields_found = COALESCE(?, fields_found), dump_path = COALESCE(?, dump_path),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(status ?? null, notes ?? null, fields_found ?? null, dump_path ?? null, req.params.id.toUpperCase());
  res.json(db.prepare('SELECT * FROM verifications WHERE id = ?').get(req.params.id.toUpperCase()));
});

app.get('/api/status', (_req, res) => {
  res.json({
    apiKeyConfigured: hasApiKey(),
    webhookSecretConfigured: Boolean(process.env.TT_WEBHOOK_SECRET),
    rateLimit: rateLimitState,
    sync: syncStatus(),
    counts: {
      shows: db.prepare('SELECT COUNT(*) c FROM shows').get().c,
      occurrences: db.prepare('SELECT COUNT(*) c FROM occurrences').get().c,
      ticket_types: db.prepare('SELECT COUNT(*) c FROM ticket_types').get().c,
      customers: db.prepare('SELECT COUNT(*) c FROM customers').get().c,
      orders: db.prepare('SELECT COUNT(*) c FROM orders').get().c,
      issued_tickets: db.prepare('SELECT COUNT(*) c FROM issued_tickets').get().c,
      webhooks: db.prepare('SELECT COUNT(*) c FROM webhook_log').get().c,
    },
  });
});

app.get('/api/field-discovery', (_req, res) => {
  res.json(db.prepare('SELECT * FROM field_discovery ORDER BY resource, field').all());
});

app.get('/api/webhook-log', (_req, res) => {
  res.json(db.prepare(`
    SELECT id, tt_event_id, event_type, signature_header_name, signature_scheme,
           signature_valid, dump_path, processed, received_at
    FROM webhook_log ORDER BY received_at DESC LIMIT 100
  `).all());
});

app.post('/api/sync', async (_req, res) => {
  const result = await syncAll({ dumpRaw: true });
  res.json(result);
});

// ---------- Perfil del cliente (demo) ----------
app.get('/entrar', (_req, res) => res.sendFile(path.join(ROOT, 'public', 'entrar.html')));

app.post('/entrar', (req, res) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ?? req.socket.remoteAddress ?? 'ip';
  if (rateLimited(`ip:${ip}`, 10) || (email && rateLimited(`email:${email}`, 5))) {
    return res.status(429).json({ ok: true, message: 'Si el correo existe, enviamos un enlace.' });
  }
  const proto = req.headers['x-forwarded-proto'] ?? req.protocol;
  requestLogin(email, `${proto}://${req.get('host')}`);
  // Respuesta genérica exista o no el email
  res.json({ ok: true, message: 'Si el correo existe, enviamos un enlace.' });
});

app.get('/entrar/:token', (req, res) => {
  const email = consumeToken(req.params.token);
  if (!email) return res.status(400).send('<meta charset="utf-8"><body style="background:#0B1211;color:#F4F1EA;font-family:sans-serif;padding:40px">Enlace inválido o vencido. <a href="/entrar" style="color:#C6F24B">Pide uno nuevo</a>.</body>');
  res.setHeader('Set-Cookie', createSessionCookie(email));
  res.redirect('/mi-cuenta');
});

app.post('/salir', (_req, res) => {
  res.setHeader('Set-Cookie', clearSessionCookie());
  res.json({ ok: true });
});

app.get('/mi-cuenta', requireSession, (_req, res) => res.sendFile(path.join(ROOT, 'public', 'cuenta.html')));
app.get('/mi-cuenta/boleto/:id', requireSession, (_req, res) => res.sendFile(path.join(ROOT, 'public', 'boleto.html')));
app.get('/mi-cuenta/datos', requireSession, (_req, res) => res.redirect('/mi-cuenta#datos'));

app.patch('/api/perfil/prefs', requireSession, (req, res) => {
  res.json(updatePreferences(req.customerEmail, req.body ?? {}));
});

app.get('/api/perfil', requireSession, (req, res) => {
  const profile = getProfile(req.customerEmail);
  if (!profile) return res.status(404).json({ error: 'Cliente no encontrado' });
  res.json(profile);
});

app.get('/api/perfil/boleto/:id', requireSession, (req, res) => {
  const t = getTicket(req.customerEmail, req.params.id);
  if (!t) return res.status(404).json({ error: 'Boleto no encontrado' });
  res.json(t);
});

app.patch('/api/perfil/datos', requireSession, (req, res) => {
  const { name, phone } = req.body ?? {};
  res.json(updateLocalData(req.customerEmail, { name, phone }));
});

app.get('/api/session', (req, res) => {
  // Sesión ligera para la cartelera: pre-llenar el checkout de TT si hay login
  const email = sessionEmail(req);
  if (!email) return res.json(null);
  const c = db.prepare('SELECT name, email FROM customers WHERE email = ?').get(email);
  res.json(c ?? { email });
});

app.get('/api/login-link', (_req, res) => {
  // Solo para /admin en el demo: último enlace generado (no hay envío de correo)
  const row = db.prepare("SELECT value FROM meta WHERE key = 'last_login_link'").get();
  res.json(row ? JSON.parse(row.value) : null);
});

// ---------- Diagnóstico del modal: postMessages capturados por la cartelera ----------
app.post('/api/debug/messages', (req, res) => {
  try {
    db.prepare('INSERT INTO debug_messages (origin, data, received_at) VALUES (?, ?, ?)')
      .run(String(req.body?.origin ?? ''), JSON.stringify(req.body?.data ?? null).slice(0, 2000), now());
  } catch { /* debug best-effort */ }
  res.json({ ok: true });
});
app.get('/api/debug/messages', (_req, res) => {
  res.json(db.prepare('SELECT * FROM debug_messages ORDER BY id DESC LIMIT 200').all());
});

// ---------- Backfill: reconstruir clientes/boletos desde /v1/orders ----------
async function backfillOrders() {
  if (!hasApiKey()) return;
  try {
    const orders = await ttListAll('/orders');
    for (const o of orders.items) await processOrder(o, 'api');
    console.log(`[backfill] ${orders.items.length} órdenes ingeridas (clientes + boletos)`);
  } catch (err) {
    console.error('[backfill] error:', err.message);
  }
}

// ---------- Arranque ----------
app.listen(PORT, () => {
  console.log(`tb-ticketing-lab en http://localhost:${PORT}`);
  console.log(`  cartelera:  http://localhost:${PORT}/`);
  console.log(`  admin:      http://localhost:${PORT}/admin`);
  console.log(`  gracias:    http://localhost:${PORT}/gracias`);
  console.log(`  webhook:    POST http://localhost:${PORT}/webhooks/tickettailor`);
  if (!hasApiKey()) {
    console.log('\n⚠ Sin TICKET_TAILOR_API_KEY en .env — la cartelera usa datos mock y el sync está apagado.');
  } else {
    syncAll({ dumpRaw: true }).then(() => backfillOrders());
    setInterval(() => syncAll(), 60_000);
    console.log('\nSync job activo: cada 60s contra el API (respetando rate limit).');
    console.log('Perfil demo: http://localhost:' + PORT + '/entrar');
  }
});
