import crypto from 'node:crypto';
import { db, now, recordFieldDiscovery, setVerification } from './db.js';
import { dump, pick, ttRequest, hasApiKey } from './ttClient.js';
import { updateAvailability } from './sync.js';
import { ensureAssignment, evaluatePointsForTicket } from './sharing.js';
import { passProductInOrder, registerPassPurchase, recordPassRedemption, ingestMembershipWebhook } from './pase.js';

/**
 * Verificación de firma por DESCUBRIMIENTO (V7).
 *
 * La doc de Ticket Tailor renderiza client-side, así que no asumimos el nombre
 * del header ni el algoritmo: probamos candidatos contra el payload real y
 * documentamos cuál verificó. Los candidatos cubren los esquemas habituales:
 *  - header tipo "tickettailor-webhook-signature" con formato "t=<ts>,v1=<hex>"
 *    y HMAC-SHA256 de `${ts}.${rawBody}` (estilo Stripe)
 *  - HMAC-SHA256 directo del rawBody en hex o base64
 */
const HEADER_CANDIDATES = [
  'tickettailor-webhook-signature',
  'x-tickettailor-signature',
  'ticket-tailor-webhook-signature',
  'x-webhook-signature',
  'x-signature',
];

export function verifySignature(rawBody, headers) {
  let headerName = null;
  let headerValue = null;
  for (const h of HEADER_CANDIDATES) {
    if (headers[h]) { headerName = h; headerValue = headers[h]; break; }
  }
  // fallback: cualquier header que mencione "signature"
  if (!headerName) {
    for (const [k, v] of Object.entries(headers)) {
      if (/signature/i.test(k)) { headerName = k; headerValue = v; break; }
    }
  }
  if (!headerName) {
    return {
      headerName: null, scheme: null, valid: null,
      detail: 'No llegó ningún header de firma. Hallazgo V7: el dashboard no expone signing secret y el request no viene firmado — la provenance se valida releyendo la orden por API (GET /v1/orders/{id}), nunca confiando en el payload.',
    };
  }

  // El dashboard de TT no muestra un signing secret, así que probamos candidatos:
  // el TT_WEBHOOK_SECRET si el usuario consiguió uno, y el propio API key
  // (hay proveedores que firman con el API key). Documentamos cuál verificó.
  const secretCandidates = [
    { source: 'TT_WEBHOOK_SECRET', secret: process.env.TT_WEBHOOK_SECRET?.trim() },
    { source: 'TICKET_TAILOR_API_KEY', secret: process.env.TICKET_TAILOR_API_KEY?.trim() },
  ].filter(c => c.secret);
  if (!secretCandidates.length) {
    return { headerName, scheme: null, valid: null, detail: 'Header de firma presente pero sin secretos candidatos configurados en .env' };
  }

  const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const attempts = [];

  for (const { source, secret } of secretCandidates) {
    // Formato "t=...,v1=..."
    const tMatch = /(?:^|,)\s*t=([^,]+)/.exec(headerValue);
    const v1Match = /(?:^|,)\s*v1=([^,]+)/.exec(headerValue);
    if (v1Match) {
      const sig = v1Match[1].trim();
      if (tMatch) {
        const ts = tMatch[1].trim();
        // ESQUEMA REAL DE TICKET TAILOR (verificado contra payload real el 2026-08-13):
        // HMAC-SHA256(secret, timestamp + body concatenados SIN separador), hex en v1=
        attempts.push({ scheme: `HMAC-SHA256(${source}, t + body concatenados) hex, header formato t=,v1=`, mac: hmac('sha256', secret, `${ts}${body}`, 'hex'), sig });
        attempts.push({ scheme: `HMAC-SHA256(${source}, "${'${t}'}.${'${body}'}") hex, header formato t=,v1=`, mac: hmac('sha256', secret, `${ts}.${body}`, 'hex'), sig });
      }
      attempts.push({ scheme: `HMAC-SHA256(${source}, body) hex, header formato v1=`, mac: hmac('sha256', secret, body, 'hex'), sig });
    }
    const bare = headerValue.trim();
    attempts.push({ scheme: `HMAC-SHA256(${source}, body) hex`, mac: hmac('sha256', secret, body, 'hex'), sig: bare });
    attempts.push({ scheme: `HMAC-SHA256(${source}, body) base64`, mac: hmac('sha256', secret, body, 'base64'), sig: bare });
    attempts.push({ scheme: `HMAC-SHA1(${source}, body) hex`, mac: hmac('sha1', secret, body, 'hex'), sig: bare });
  }

  for (const a of attempts) {
    if (a.mac && a.sig && timingSafeEqual(a.mac, a.sig)) {
      return { headerName, scheme: a.scheme, valid: 1, detail: `Firma verificada con ${a.scheme}` };
    }
  }
  return {
    headerName, scheme: null, valid: 0,
    detail: `Header "${headerName}" presente pero ningún esquema/secreto candidato verificó (probados: ${secretCandidates.map(c => c.source).join(', ')}). Valor (recortado): ${headerValue.slice(0, 60)}…`,
  };
}

function hmac(algo, secret, data, enc) {
  try { return crypto.createHmac(algo, secret).update(data).digest(enc); } catch { return null; }
}
function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Procesa un webhook entrante: log crudo + dump, dedupe por id de evento,
 * y si es una orden: upsert de customer, insert de order/issued_tickets,
 * refresh de availability y attendance.
 */
export async function handleWebhook(rawBody, headers) {
  const receivedAt = now();
  const body = rawBody.toString('utf8');
  let payload;
  try { payload = JSON.parse(body); } catch { payload = { _raw_text: body }; }

  const sig = verifySignature(body, headers);

  const eventId = pick(payload, ['id', 'event_id', 'webhook_id']).value ?? crypto.createHash('sha256').update(body).digest('hex');
  const eventType = pick(payload, ['event', 'type', 'event_type', 'action']).value ?? 'desconocido';

  const dumpPath = dump(`webhook-${String(eventType).replace(/[^a-z0-9]+/gi, '_')}`, { headers, payload }, 'webhooks');

  const inserted = db.prepare(`
    INSERT OR IGNORE INTO webhook_log
      (tt_event_id, event_type, signature_header_name, signature_scheme, signature_valid, headers, payload, dump_path, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(String(eventId), String(eventType), sig.headerName, sig.scheme, sig.valid, JSON.stringify(headers), body, dumpPath, receivedAt);

  if (inserted.changes === 0) {
    console.log(`[webhook] duplicado ignorado (idempotencia): ${eventId}`);
    return { deduped: true, eventId, eventType, signature: sig };
  }

  recordFieldDiscovery('webhook_envelope', payload);

  // El objeto de negocio suele venir anidado; descubrir dónde
  const obj = pick(payload, ['payload', 'data', 'object', 'body']).value ?? payload;
  if (obj && typeof obj === 'object') recordFieldDiscovery(`webhook_${eventType}`, obj);

  try {
    if (/order/i.test(String(eventType)) || looksLikeOrder(obj)) {
      await processOrder(obj, 'webhook');
    }
    if (/issued_ticket/i.test(String(eventType))) {
      // ISSUED_TICKET.CREATED / UPDATED: el payload ES el boleto
      upsertTicket(obj, {});
    }
    if (/check.?in|scan/i.test(String(eventType))) {
      processCheckin(obj);
    }
    if (/membership/i.test(String(eventType))) {
      // ISSUED_MEMBERSHIP.CREATED / UPDATED: el payload ES la membresía
      await ingestMembershipWebhook(obj);
    }
    db.prepare('UPDATE webhook_log SET processed = 1 WHERE tt_event_id = ?').run(String(eventId));
  } catch (err) {
    console.error('[webhook] error procesando:', err.message);
  }

  // Evidencia V7: acumular datos SIN pisar el veredicto (eso lo decide el runner)
  if (sig.valid === 1) {
    setVerification('V7', {
      fields_found: `header de firma: "${sig.headerName}" · esquema: ${sig.scheme} · último evento verificado: "${eventType}"`,
      dump_path: dumpPath,
    });
  } else {
    setVerification('V7', { dump_path: dumpPath, notes: sig.detail });
  }

  return { deduped: false, eventId, eventType, signature: sig, dumpPath };
}

function looksLikeOrder(obj) {
  return obj && typeof obj === 'object' && ('buyer_details' in obj || 'issued_tickets' in obj || 'total' in obj);
}

export async function processOrder(order, source) {
  if (!order || typeof order !== 'object') return;
  recordFieldDiscovery('orders', order);

  const buyer = pick(order, ['buyer_details', 'buyer', 'customer']).value ?? {};
  if (buyer && typeof buyer === 'object') recordFieldDiscovery('buyer_details', buyer);

  const email = pick(buyer, ['email', 'email_address']).value ?? pick(order, ['email', 'buyer_email']).value;
  const name = [pick(buyer, ['first_name']).value, pick(buyer, ['last_name']).value].filter(Boolean).join(' ')
    || pick(buyer, ['name', 'full_name']).value;
  const phone = pick(buyer, ['phone', 'phone_number', 'telephone']).value;

  if (email) {
    db.prepare(`
      INSERT INTO customers (email, name, phone, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(email) DO UPDATE SET
        name = COALESCE(excluded.name, name),
        phone = COALESCE(excluded.phone, phone),
        updated_at = excluded.updated_at
    `).run(String(email).toLowerCase(), name ?? null, phone ?? null, now(), now());
  }

  const occurrenceId = pick(order, ['event_id', 'event.id', 'event_summary.event_id']).value;
  db.prepare(`
    INSERT INTO orders (id, customer_email, occurrence_id, total_cents, currency, status, source, raw, created_at, updated_at)
    VALUES (@id, @email, @occ, @total, @currency, @status, @source, @raw, @created, @updated)
    ON CONFLICT(id) DO UPDATE SET status=@status, raw=@raw, updated_at=@updated,
      total_cents=COALESCE(@total, total_cents), currency=COALESCE(@currency, currency),
      occurrence_id=COALESCE(@occ, occurrence_id), customer_email=COALESCE(@email, customer_email)
  `).run({
    id: String(order.id ?? crypto.randomUUID()),
    email: email ? String(email).toLowerCase() : null,
    occ: occurrenceId != null ? String(occurrenceId) : null,
    // 0 es un total válido (redenciones del pase, eventos gratis): no convertirlo en null
    total: Number.isFinite(Number(pick(order, ['total', 'total_paid', 'amount', 'order_value']).value))
      ? Number(pick(order, ['total', 'total_paid', 'amount', 'order_value']).value) : null,
    // "currency" en el JSON real es un objeto {base_multiplier, code}: preferir .code
    currency: stringifyVal(pick(order, ['currency.code', 'currency']).value),
    status: stringifyVal(pick(order, ['status', 'state']).value),
    source,
    raw: JSON.stringify(order),
    created: now(),
    updated: now(),
  });

  const tickets = pick(order, ['issued_tickets', 'tickets', 'line_items']).value;
  if (Array.isArray(tickets)) {
    for (const t of tickets) {
      upsertTicket(t, { orderId: order.id, occurrenceId, buyerEmail: email });
    }
  }

  // ---------- El Pase ----------
  // 1) ¿Esta orden COMPRA el producto del pase? → registrar y localizar la membresía.
  // 2) ¿Esta orden REDIME (boleto $0 "members only")? → espejo + releer contador de TT.
  try {
    const product = passProductInOrder(order);
    if (product && email) await registerPassPurchase({ order, product, email: String(email).toLowerCase() });
    await recordPassRedemption(order);
  } catch (err) {
    console.error('[pase] error procesando la orden:', err.message);
  }

  // Refresh inmediato de disponibilidad del evento afectado (vía webhook, para medir V4)
  if (occurrenceId != null && hasApiKey()) {
    try {
      const res = await ttRequest(`/events/${occurrenceId}`);
      if (res.status === 200 && res.json) {
        const ev = res.json.data ?? res.json;
        const tts = Array.isArray(ev.ticket_types) ? ev.ticket_types : [];
        for (const tt of tts) updateAvailability(String(occurrenceId), tt, 'webhook');
      }
    } catch (err) {
      console.error('[webhook] no se pudo refrescar disponibilidad:', err.message);
    }
  }
}

/**
 * Upsert completo de un issued_ticket (FINDINGS: campos reales del payload).
 * OJO: checked_in llega como STRING "true"/"false" — normalizar aquí, nunca
 * comparar el string crudo ("false" es truthy en JS).
 */
export function upsertTicket(t, { orderId, occurrenceId, buyerEmail } = {}) {
  if (!t || typeof t !== 'object') return;
  recordFieldDiscovery('issued_tickets', t);

  const checkedIn = t.checked_in === true || t.checked_in === 'true' ? 1 : 0;
  const ticketEmail = stringifyVal(pick(t, ['email']).value)?.toLowerCase() ?? null;
  const occ = stringifyVal(pick(t, ['event_id']).value) ?? (occurrenceId != null ? String(occurrenceId) : null);
  // Asiento: "reservation" llega null en compras GA. En compras SEATED llega como
  // STRING con la etiqueta de la butaca (primera vez observado: "23-3" en
  // it_135898047, ticket type Seated "Planta Baja - El Pase"), no como objeto.
  // Se guarda la etiqueta entera en seat_number; si algún día viene objeto, se
  // descompone. La sección es el ticket type (Planta Baja / Alta).
  const reservation = pick(t, ['reservation']).value;
  let seatSection = null, seatRow = null, seatNumber = null;
  if (typeof reservation === 'string' && reservation.trim()) {
    seatNumber = reservation.trim();
    seatSection = pick(t, ['description']).value ? String(pick(t, ['description']).value).replace(/\s*-\s*El Pase$/i, '') : null;
  } else if (reservation && typeof reservation === 'object') {
    seatSection = pick(reservation, ['section', 'section_name']).value ?? null;
    seatRow = pick(reservation, ['row', 'row_name']).value ?? null;
    seatNumber = pick(reservation, ['seat', 'seat_number', 'number', 'label']).value ?? null;
  }

  db.prepare(`
    INSERT INTO issued_tickets (
      id, order_id, occurrence_id, ticket_type_id, barcode, status,
      seat_section, seat_row, seat_number, checked_in, checked_in_at,
      qr_code_url, barcode_url, description, listed_price, email, event_series_id, voided_at,
      raw, updated_at
    ) VALUES (
      @id, @order_id, @occ, @tt, @barcode, @status,
      @s1, @s2, @s3, @checked_in, @checked_in_at,
      @qr, @bar, @descr, @price, @email, @series, @voided,
      @raw, @updated
    )
    ON CONFLICT(id) DO UPDATE SET
      status=@status, seat_section=@s1, seat_row=@s2, seat_number=@s3,
      checked_in=@checked_in, checked_in_at=COALESCE(@checked_in_at, checked_in_at),
      qr_code_url=COALESCE(@qr, qr_code_url), barcode_url=COALESCE(@bar, barcode_url),
      description=COALESCE(@descr, description), listed_price=COALESCE(@price, listed_price),
      email=COALESCE(@email, email), event_series_id=COALESCE(@series, event_series_id),
      voided_at=@voided, raw=@raw, updated_at=@updated
  `).run({
    id: String(t.id ?? crypto.randomUUID()),
    order_id: stringifyVal(pick(t, ['order_id']).value) ?? (orderId != null ? String(orderId) : null),
    occ,
    tt: stringifyVal(pick(t, ['ticket_type_id', 'ticket_type.id']).value),
    barcode: stringifyVal(pick(t, ['barcode', 'reference']).value),
    status: stringifyVal(pick(t, ['status', 'state']).value),
    s1: stringifyVal(seatSection), s2: stringifyVal(seatRow), s3: stringifyVal(seatNumber),
    checked_in: checkedIn,
    checked_in_at: checkedIn ? now() : null,
    qr: stringifyVal(pick(t, ['qr_code_url']).value),
    bar: stringifyVal(pick(t, ['barcode_url']).value),
    descr: stringifyVal(pick(t, ['description']).value),
    price: Number.isFinite(Number(pick(t, ['listed_price']).value)) ? Number(pick(t, ['listed_price']).value) : null,
    email: ticketEmail,
    series: stringifyVal(pick(t, ['event_series_id']).value),
    voided: pick(t, ['voided_at']).value != null ? String(pick(t, ['voided_at']).value) : null,
    raw: JSON.stringify(t),
    updated: now(),
  });

  // Reparto del corillo: el comprador arranca como dueño de cada boleto.
  // ensureAssignment es idempotente: no pisa un envío ni un reclamo ya hechos.
  ensureAssignment({
    ticketId: t.id,
    occurrenceId: occ,
    buyerEmail: buyerEmail ?? ticketEmail,
  });
  // El check-in puede llegar ANTES del reclamo: reevaluar en cada ingesta.
  evaluatePointsForTicket(t.id);

  const attendanceEmail = ticketEmail ?? (buyerEmail ? String(buyerEmail).toLowerCase() : null);
  if (attendanceEmail && occ) {
    db.prepare(`
      INSERT INTO attendance (customer_email, occurrence_id, ticket_id, attended, checked_in_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(customer_email, occurrence_id, ticket_id) DO UPDATE SET
        attended=excluded.attended,
        checked_in_at=COALESCE(excluded.checked_in_at, checked_in_at)
    `).run(attendanceEmail, occ, String(t.id ?? ''), checkedIn, checkedIn ? now() : null);
  }
}

function processCheckin(obj) {
  if (!obj || typeof obj !== 'object') return;
  recordFieldDiscovery('checkins', obj);
  const ticketId = pick(obj, ['issued_ticket_id', 'ticket_id', 'issued_ticket.id']).value;
  const at = pick(obj, ['checked_in_at', 'created_at', 'scanned_at']).value;
  if (ticketId != null) {
    db.prepare('UPDATE issued_tickets SET checked_in = 1, checked_in_at = ? WHERE id = ?')
      .run(stringifyVal(at) ?? now(), String(ticketId));
    db.prepare('UPDATE attendance SET attended = 1, checked_in_at = ? WHERE ticket_id = ?')
      .run(stringifyVal(at) ?? now(), String(ticketId));
    // El escaneo es el evento que otorga el punto (si el boleto ya está reclamado).
    evaluatePointsForTicket(ticketId);
  }
}

function stringifyVal(v) {
  if (v == null) return null;
  return typeof v === 'string' ? v : JSON.stringify(v);
}
