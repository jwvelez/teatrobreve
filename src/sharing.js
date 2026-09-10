import crypto from 'node:crypto';
import { db, now } from './db.js';
import { pick } from './ttClient.js';
import { seatOf, seatLabel, plantaOf } from './seat.js';

/**
 * COMPARTIR BOLETOS CON EL CORILLO.
 *
 * Compro 4 boletos, le mando a cada quien el suyo por correo, y cada persona lo
 * reclama en su propia cuenta. El punto se gana al ESCANEAR en la puerta, no al
 * reclamar — y solo lo gana quien tenga el boleto reclamado a su nombre.
 *
 * Reglas de puntos (estrictas):
 *  - se otorga al escanear el QR, no al reclamar
 *  - solo gana quien tenga el boleto RECLAMADO al momento de evaluar
 *  - quien nunca reclama no acumula punto, aunque su boleto se escanee
 *  - el comprador solo gana por el boleto que se quedó, no por los que envió
 *  - UN punto por persona por FUNCIÓN (no por boleto): el ledger es
 *    UNIQUE(customer_id, occurrence_id)
 *  - el reclamo puede ocurrir DESPUÉS del escaneo, así que evaluamos en los dos
 *    eventos (al reclamar y al ingerir un check-in), de forma idempotente
 *
 * LIMITACIÓN CONOCIDA DEL MVP, dicha explícitamente:
 * el enlace de reclamo es un portador (bearer token). Quien REENVÍE el correo le
 * está regalando el boleto a quien lo abra primero: el primero que llegue reclama
 * y se queda con el punto. Es aceptable para el MVP porque el boleto sigue siendo
 * el QR (que el comprador ya podía reenviar igual), pero en producción convendría
 * atar el reclamo a una verificación del correo destinatario.
 */

const CLAIM_GRACE_DAYS = 7;

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Crea la fila de reparto de un boleto con el comprador como dueño.
 * Idempotente: si ya existe no la pisa (no queremos borrar un envío o un reclamo
 * cuando el backfill relee la misma orden).
 */
export function ensureAssignment({ ticketId, occurrenceId, buyerEmail }) {
  if (!ticketId) return;
  db.prepare(`
    INSERT INTO ticket_assignments
      (issued_ticket_id, occurrence_id, holder_email, holder_customer_id, status, created_at, updated_at)
    VALUES (@tid, @occ, @email, (SELECT id FROM customers WHERE email = @email), 'owner', @ts, @ts)
    ON CONFLICT(issued_ticket_id) DO UPDATE SET
      occurrence_id = COALESCE(excluded.occurrence_id, occurrence_id),
      holder_customer_id = COALESCE(holder_customer_id, excluded.holder_customer_id),
      updated_at = @ts
  `).run({
    tid: String(ticketId),
    occ: occurrenceId != null ? String(occurrenceId) : null,
    email: buyerEmail ? String(buyerEmail).toLowerCase() : null,
    ts: now(),
  });
}

/** El comprador de la orden a la que pertenece el boleto (para autorizar). */
export function orderBuyerEmail(orderId) {
  return db.prepare('SELECT customer_email FROM orders WHERE id = ?').get(String(orderId))?.customer_email ?? null;
}

/**
 * Boletos de una orden con su estado de reparto, para la pantalla de reparto.
 * El asiento viene de "reservation" (null en compras GA): degrada con gracia.
 */
export function ticketsOfOrder(orderId) {
  return db.prepare(`
    SELECT it.id, it.description, it.qr_code_url, it.barcode_url, it.status AS ticket_status,
           it.seat_section, it.seat_row, it.seat_number, it.occurrence_id,
           o.starts_at, s.name AS show_name,
           a.status AS share_status, a.holder_email, a.sent_at, a.claimed_at
    FROM issued_tickets it
    LEFT JOIN occurrences o ON o.id = it.occurrence_id
    LEFT JOIN shows s ON s.id = COALESCE(it.event_series_id, o.show_id)
    LEFT JOIN ticket_assignments a ON a.issued_ticket_id = it.id
    WHERE it.order_id = ?
    ORDER BY it.id
  `).all(String(orderId)).map(t => ({
    id: t.id,
    show: t.show_name ?? t.description ?? 'Show',
    startsAt: t.starts_at,
    date: t.starts_at ? t.starts_at.slice(0, 10) : null,
    time: t.starts_at && t.starts_at.length > 15 ? t.starts_at.slice(11, 16) : null,
    planta: plantaOf(t.description),
    seat: seatOf(t) ? seatOf(t)
      : null,
    qr: t.qr_code_url,
    voided: t.ticket_status === 'voided',
    shareStatus: t.share_status ?? 'owner',
    holderEmail: t.holder_email,
    sentAt: t.sent_at,
    claimedAt: t.claimed_at,
  }));
}

/**
 * Envía un boleto a un correo: genera el token de reclamo y marca 'sent'.
 * El token expira al cierre del día de la función + 7 días de gracia.
 */
export async function sendTicket({ ticketId, email, baseUrl }) {
  const normalized = String(email ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) {
    return { ok: false, error: 'Correo inválido' };
  }

  const assignment = db.prepare('SELECT * FROM ticket_assignments WHERE issued_ticket_id = ?').get(String(ticketId));
  if (!assignment) return { ok: false, error: 'Boleto no encontrado' };
  if (assignment.status === 'claimed') {
    return { ok: false, error: 'Ese boleto ya fue reclamado. Revócalo primero si quieres reasignarlo.' };
  }

  const ticket = loadTicketForEmail(ticketId);
  if (!ticket) return { ok: false, error: 'Boleto no encontrado' };
  if (ticket.status === 'voided') return { ok: false, error: 'Ese boleto está anulado' };

  const token = crypto.randomBytes(32).toString('hex');
  // Vence al cierre del día de la función + gracia, para permitir el reclamo tardío
  // (el escaneo puede ocurrir antes del reclamo y el punto se otorga igual).
  // Piso: nunca menos de la gracia desde el envío — si no, un boleto de una función
  // que ya pasó nacería vencido y no se podría reclamar nunca.
  const graceMs = CLAIM_GRACE_DAYS * 24 * 3600 * 1000;
  const fin = ticket.starts_at ? new Date(ticket.starts_at) : new Date();
  fin.setHours(23, 59, 59, 999);
  const expires = new Date(Math.max(fin.getTime(), Date.now()) + graceMs).toISOString();

  db.prepare(`
    UPDATE ticket_assignments SET
      holder_email = ?, holder_customer_id = (SELECT id FROM customers WHERE email = ?),
      status = 'sent', sent_at = ?, claimed_at = NULL, revoked_at = NULL,
      claim_token_hash = ?, claim_expires_at = ?, updated_at = ?
    WHERE issued_ticket_id = ?
  `).run(normalized, normalized, now(), hashToken(token), expires, now(), String(ticketId));

  const data = await ticketEmailData(ticket);
  sendTicketEmail(normalized, { ...data, url: `${baseUrl}/reclamar/${token}` });
  return { ok: true, email: normalized, expiresAt: expires };
}

/** El boleto con todo lo que necesita un correo (misma consulta para enviar y reenviarse). */
function loadTicketForEmail(ticketId) {
  return db.prepare(`
    SELECT it.*, o.starts_at, o.raw AS occurrence_raw, s.name AS show_name
    FROM issued_tickets it
    LEFT JOIN occurrences o ON o.id = it.occurrence_id
    LEFT JOIN shows s ON s.id = COALESCE(it.event_series_id, o.show_id)
    WHERE it.id = ?
  `).get(String(ticketId));
}

/**
 * Lo que va en el correo del boleto: show, cuándo, lugar, planta + mesa/asiento,
 * código legible y el QR (descargado para adjuntarlo inline). Compartido por
 * "enviar a otra persona" y "enviármelo a mí".
 */
async function ticketEmailData(ticket) {
  // El lugar sale del JSON crudo del event; el nombre del campo no se asume.
  let lugar = null;
  if (ticket.occurrence_raw) {
    try {
      const venue = pick(JSON.parse(ticket.occurrence_raw), ['venue']).value;
      if (venue && typeof venue === 'object') {
        lugar = [
          pick(venue, ['name']).value,
          pick(venue, ['address_1', 'address', 'street']).value,
          pick(venue, ['city', 'town']).value,
          pick(venue, ['postal_code', 'postcode', 'zip']).value,
        ].filter(Boolean).join(', ') || null;
      } else if (typeof venue === 'string') {
        lugar = venue;
      }
    } catch (err) {
      // Ruidoso a propósito: un catch mudo aquí ya escondió una vez que faltaba
      // un import, y el correo salió sin lugar sin que nadie se enterara.
      console.error('[boleto] no se pudo leer el venue del event:', err.message);
    }
  }
  // El QR es el que se escanea en la puerta ("qr_code_url", .../barcode/qr/...).
  // "barcode_url" es el código de barras (.../barcode/st/...) y queda de respaldo.
  const qrUrl = ticket.qr_code_url ?? ticket.barcode_url;
  const qrAttachment = await fetchQrAttachment(qrUrl);
  return {
    show: ticket.show_name ?? ticket.description ?? 'Show',
    startsAt: ticket.starts_at,
    planta: plantaOf(ticket.description),
    seat: seatLabel({ section: ticket.seat_section, row: ticket.seat_row, number: ticket.seat_number }),
    lugar,
    // El código legible del boleto: respaldo si el escáner de la puerta falla.
    codigo: ticket.barcode,
    qrUrl,
    qrAttachment,
  };
}

/**
 * "Enviármelo a mí": el dueño del boleto se lo manda a su propio correo para tener
 * el QR fresco en el inbox sin entrar al sitio desde el celular. No hay token de
 * reclamo (ya es suyo) ni cambio de estado: es solo una copia.
 * Dueño = quien lo reclamó, o el comprador si nadie más lo reclamó.
 */
export async function emailTicketToSelf({ ticketId, email }) {
  const normalized = String(email ?? '').toLowerCase();
  const a = db.prepare('SELECT * FROM ticket_assignments WHERE issued_ticket_id = ?').get(String(ticketId));
  if (!a) return { ok: false, error: 'Boleto no encontrado' };
  const buyer = db.prepare(`
    SELECT o.customer_email FROM issued_tickets it JOIN orders o ON o.id = it.order_id WHERE it.id = ?
  `).get(String(ticketId))?.customer_email?.toLowerCase() ?? null;
  const esDueno = a.status === 'claimed'
    ? String(a.holder_email ?? '').toLowerCase() === normalized
    : buyer === normalized;
  if (!esDueno) return { ok: false, error: 'Ese boleto no está en tu cuenta' };

  const ticket = loadTicketForEmail(ticketId);
  if (!ticket) return { ok: false, error: 'Boleto no encontrado' };
  if (ticket.status === 'voided') return { ok: false, error: 'Ese boleto está anulado' };

  const data = await ticketEmailData(ticket);
  sendTicketEmail(normalized, { ...data, selfService: true });
  return { ok: true, email: normalized };
}

/** Devuelve el boleto al comprador. Solo si no está reclamado. */
export function revokeTicket({ ticketId, buyerEmail }) {
  const a = db.prepare('SELECT * FROM ticket_assignments WHERE issued_ticket_id = ?').get(String(ticketId));
  if (!a) return { ok: false, error: 'Boleto no encontrado' };
  if (a.status === 'claimed') {
    return { ok: false, error: 'Ese boleto ya fue reclamado y no se puede revocar.' };
  }
  const email = String(buyerEmail).toLowerCase();
  db.prepare(`
    UPDATE ticket_assignments SET
      holder_email = ?, holder_customer_id = (SELECT id FROM customers WHERE email = ?),
      status = 'owner', sent_at = NULL, revoked_at = ?,
      claim_token_hash = NULL, claim_expires_at = NULL, updated_at = ?
    WHERE issued_ticket_id = ?
  `).run(email, email, now(), now(), String(ticketId));
  return { ok: true };
}

/**
 * Consume el token de reclamo: crea o busca el customer, marca 'claimed' y evalúa
 * puntos (por si el check-in ya había ocurrido). Un solo uso: el hash se limpia.
 */
export function claimTicket(token) {
  const a = db.prepare('SELECT * FROM ticket_assignments WHERE claim_token_hash = ?')
    .get(hashToken(String(token ?? '')));
  if (!a) return { ok: false, error: 'Enlace inválido o ya usado' };
  if (a.status === 'claimed') return { ok: false, error: 'Ese boleto ya fue reclamado' };
  if (a.claim_expires_at && new Date(a.claim_expires_at) < new Date()) {
    return { ok: false, error: 'El enlace venció' };
  }

  const email = String(a.holder_email).toLowerCase();
  db.prepare(`
    INSERT INTO customers (email, created_at, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(email) DO NOTHING
  `).run(email, now(), now());
  const customer = db.prepare('SELECT id FROM customers WHERE email = ?').get(email);

  db.prepare(`
    UPDATE ticket_assignments SET
      status = 'claimed', holder_customer_id = ?, claimed_at = ?,
      claim_token_hash = NULL, updated_at = ?
    WHERE id = ?
  `).run(customer.id, now(), now(), a.id);

  // El escaneo pudo haber ocurrido ANTES del reclamo: evaluar ahora.
  const awarded = evaluatePointsForTicket(a.issued_ticket_id);
  return { ok: true, email, ticketId: a.issued_ticket_id, awarded };
}

/**
 * Otorga el punto si y solo si: el boleto está RECLAMADO y además ESCANEADO.
 * Idempotente por partida doble: el UNIQUE(customer_id, occurrence_id) del ledger
 * y el INSERT OR IGNORE. Correrlo dos veces no otorga dos puntos.
 */
export function evaluatePointsForTicket(ticketId) {
  const row = db.prepare(`
    SELECT a.holder_customer_id, a.status, a.issued_ticket_id,
           COALESCE(a.occurrence_id, it.occurrence_id) AS occurrence_id,
           it.checked_in, it.status AS ticket_status
    FROM ticket_assignments a
    JOIN issued_tickets it ON it.id = a.issued_ticket_id
    WHERE a.issued_ticket_id = ?
  `).get(String(ticketId));

  if (!row) return false;
  if (row.status !== 'claimed') return false;      // enviado y no reclamado: no gana
  if (!row.holder_customer_id) return false;
  if (!row.checked_in) return false;               // el punto se gana al ESCANEAR
  if (row.ticket_status === 'voided') return false;
  if (!row.occurrence_id) return false;

  const res = db.prepare(`
    INSERT OR IGNORE INTO loyalty_points
      (customer_id, occurrence_id, issued_ticket_id, points, awarded_at)
    VALUES (?, ?, ?, 1, ?)
  `).run(row.holder_customer_id, String(row.occurrence_id), String(row.issued_ticket_id), now());

  if (res.changes) {
    // Espejo en customers.points (la columna ya existía, reservada para esto)
    db.prepare(`
      UPDATE customers SET
        points = (SELECT COALESCE(SUM(points), 0) FROM loyalty_points WHERE customer_id = ?),
        updated_at = ?
      WHERE id = ?
    `).run(row.holder_customer_id, now(), row.holder_customer_id);
  }
  return res.changes > 0;
}

/** Resumen de puntos para el perfil. */
export function getPoints(email) {
  const customer = db.prepare('SELECT id, points, tier FROM customers WHERE email = ?').get(String(email).toLowerCase());
  if (!customer) return { total: 0, tier: null, history: [] };
  const history = db.prepare(`
    SELECT lp.occurrence_id, lp.points, lp.awarded_at, o.starts_at, s.name AS show_name
    FROM loyalty_points lp
    LEFT JOIN occurrences o ON o.id = lp.occurrence_id
    LEFT JOIN shows s ON s.id = o.show_id
    WHERE lp.customer_id = ? ORDER BY lp.awarded_at DESC
  `).all(customer.id);
  return {
    total: history.reduce((a, h) => a + h.points, 0),
    tier: customer.tier,
    history: history.map(h => ({
      show: h.show_name ?? 'Show',
      startsAt: h.starts_at,
      points: h.points,
      awardedAt: h.awarded_at,
    })),
  };
}

/**
 * Interfaz limpia para enchufar Resend/Postmark/SES, igual que sendLoginEmail().
 * El demo escribe el correo a consola y lo guarda en meta para /admin.
 */
/**
 * Descarga el QR del CDN de TT para adjuntarlo INLINE al correo.
 *
 * Por qué no basta con enlazar la imagen: Gmail, Outlook y Apple Mail bloquean
 * imágenes remotas por defecto, así que un <img src="https://cdn.tickettailor…">
 * le sale al destinatario como un hueco vacío justo donde va su boleto. Adjuntarla
 * (CID) es la única forma de que el QR se vea SIEMPRE, sin que nadie tenga que
 * pulsar "mostrar imágenes".
 *
 * Devuelve { cid, contentType, base64 } o null si el CDN no respondió — en ese caso
 * el HTML cae de vuelta a la URL remota, que es mejor que quedarse sin QR.
 */
export async function fetchQrAttachment(qrUrl) {
  if (!qrUrl) return null;
  try {
    const res = await fetch(qrUrl);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return null;
    return {
      cid: 'qr-boleto',
      filename: 'boleto-qr.png',
      contentType: res.headers.get('content-type') ?? 'image/png',
      base64: buf.toString('base64'),
    };
  } catch (err) {
    console.error('[boleto] no se pudo bajar el QR para adjuntarlo:', err.message);
    return null;
  }
}

export function sendTicketEmail(email, { url, show, startsAt, planta, seat, lugar, codigo, qrUrl, qrAttachment, selfService = false }) {
  const cuando = startsAt
    ? new Date(startsAt).toLocaleString('es-PR', { dateStyle: 'full', timeStyle: 'short' })
    : 'Fecha por confirmar';
  // "Planta Baja - Mesa 23, Asiento 3" (o solo la planta en GA)
  const detalle = [planta, seat].filter(Boolean).join(' - ') || 'Entrada general';
  // Con adjunto se referencia por CID (se ve siempre, sin depender de que el cliente
  // de correo permita imágenes remotas). Sin adjunto, se cae a la URL del CDN.
  const qrSrc = qrAttachment ? `cid:${qrAttachment.cid}` : qrUrl;

  const html = `
<div style="background:#0B1211;color:#F4F1EA;font-family:Archivo,Helvetica,Arial,sans-serif;padding:32px">
  <div style="max-width:520px;margin:0 auto;background:#111A18;border:1px solid #1E2A27;border-radius:14px;padding:28px">
    <p style="font-family:'Martian Mono',monospace;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#8A9A95;margin:0 0 14px">
      ${selfService ? 'Tu boleto' : 'Te enviaron un boleto'}
    </p>
    <h1 style="font-size:26px;margin:0 0 14px">${escapeHtml(show)}</h1>
    <table cellpadding="0" cellspacing="0" border="0" style="margin:0 0 22px;font-size:14px;line-height:1.5">
      <tr>
        <td style="color:#8A9A95;padding:0 14px 6px 0;white-space:nowrap">Cuándo</td>
        <td style="color:#F4F1EA;padding:0 0 6px">${escapeHtml(cuando)}</td>
      </tr>
      ${lugar ? `<tr>
        <td style="color:#8A9A95;padding:0 14px 6px 0;white-space:nowrap">Dónde</td>
        <td style="color:#F4F1EA;padding:0 0 6px">${escapeHtml(lugar)}</td>
      </tr>` : ''}
      <tr>
        <td style="color:#8A9A95;padding:0 14px 0 0;white-space:nowrap">Boleto</td>
        <td style="color:#F4F1EA;padding:0">${escapeHtml(detalle)}</td>
      </tr>
    </table>
    ${qrSrc ? `<div style="background:#fff;border-radius:10px;padding:18px 18px 14px;text-align:center;margin:0 0 8px">
      <img src="${escapeHtml(qrSrc)}" alt="Código QR de tu boleto" width="200" height="200"
           style="width:200px;height:200px;max-width:100%;display:block;margin:0 auto">
      ${codigo ? `<p style="font-family:'Martian Mono',Menlo,Consolas,monospace;font-size:11px;
                             letter-spacing:.14em;text-transform:uppercase;color:#5C6B66;margin:12px 0 2px">
          Código del boleto
        </p>
        <p style="font-family:'Martian Mono',Menlo,Consolas,monospace;font-size:22px;font-weight:700;
                  letter-spacing:.08em;color:#0B1211;margin:0">${escapeHtml(codigo)}</p>` : ''}
    </div>
    <p style="color:#8A9A95;font-size:12px;text-align:center;margin:0 0 22px">
      Este es tu boleto. Enséñalo en la puerta.
    </p>` : ''}

    ${selfService ? `
    <p style="color:#8A9A95;font-size:12px;margin:0;line-height:1.5;text-align:center">
      Este boleto ya está en tu cuenta de Teatro Breve. Te lo mandamos para que lo tengas a mano.
    </p>` : `
    <div style="border-top:1px solid #1E2A27;padding-top:20px">
      <p style="color:#F4F1EA;font-size:14px;margin:0 0 12px;line-height:1.5">
        <strong>¿Quieres ganar puntos por este show?</strong><br>
        <span style="color:#8A9A95">Guárdalo en tu cuenta de Teatro Breve y acumula un punto
        cuando escaneen tu código en la puerta.</span>
      </p>
      <a href="${escapeHtml(url)}"
         style="display:block;text-align:center;background:#C6F24B;color:#0B1211;text-decoration:none;
                font-weight:700;padding:15px;border-radius:10px">
        Guardar en mi cuenta
      </a>
      <p style="color:#8A9A95;font-size:12px;margin:14px 0 0;line-height:1.5">
        Es opcional: tu boleto de arriba funciona igual sin hacer nada.
      </p>
    </div>`}
  </div>
</div>`;

  // TODO producción: enviar con Resend/Postmark/SES pasando `attachments` tal cual:
  // el QR va como imagen inline referenciada por CID desde el HTML (content_id = cid),
  // que es lo que hace que se vea SIEMPRE aunque el cliente bloquee imágenes remotas.
  // El demo lo imprime y lo expone en /api/ticket-email.
  const attachments = qrAttachment
    ? [{ filename: qrAttachment.filename, content_id: qrAttachment.cid,
         content_type: qrAttachment.contentType, content_base64: qrAttachment.base64 }]
    : [];

  console.log(selfService
    ? `\n[boleto] Copia del boleto enviada a su dueño ${email} (${show})`
    : `\n[boleto] Enlace de reclamo para ${email} (${show}):\n  ${url}`);
  console.log(`  QR: ${qrAttachment ? 'adjunto inline (cid:' + qrAttachment.cid + ')' : 'sin adjunto — se enlaza al CDN'}\n`);
  db.prepare(`
    INSERT INTO meta (key, value) VALUES ('last_ticket_email', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(JSON.stringify({ email, url: url ?? null, selfService, show, cuando, lugar, detalle, html, attachments, at: now() }));
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
