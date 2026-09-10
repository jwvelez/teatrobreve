import { db } from './db.js';
import { seatOf, plantaOf } from './seat.js';

/**
 * Perfil del cliente, calculado 100% desde SQLite (nunca del API de TT por request).
 * Reglas del FINDINGS:
 * - estado de boleto individual = issued_tickets.status (nunca contadores)
 * - función pasada = start.iso < ahora (starts_at ya viene con timezone)
 * - checked_in ya está normalizado a 0/1 al ingerir
 * - boletos anulados: fuera de "próximos", tachados en historial
 */

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function ticketsOf(email) {
  // Boletos por email del boleto, por comprador de la orden, o por reparto del corillo
  // (un boleto reclamado aparece en la cuenta de quien lo reclamó).
  return db.prepare(`
    SELECT it.*,
           o2.starts_at, s.name AS show_name, s.id AS series_id, s.thumbnail_url,
           ord.created_at AS order_created_at, ord.customer_email AS buyer_email,
           a.status AS share_status, a.holder_email
    FROM issued_tickets it
    LEFT JOIN occurrences o2 ON o2.id = it.occurrence_id
    LEFT JOIN shows s ON s.id = COALESCE(it.event_series_id, o2.show_id)
    LEFT JOIN orders ord ON ord.id = it.order_id
    LEFT JOIN ticket_assignments a ON a.issued_ticket_id = it.id
    WHERE (a.status = 'claimed' AND a.holder_email = @email)
       OR ((a.status IS NULL OR a.status != 'claimed')
            AND (it.email = @email OR ord.customer_email = @email))
    ORDER BY o2.starts_at
  `).all({ email });
}

function isPast(startsAt) {
  if (!startsAt) return false;
  return new Date(startsAt) < new Date();
}

function shape(t, viewerEmail) {
  const dt = t.starts_at ? new Date(t.starts_at) : null;
  const soyComprador = t.buyer_email && viewerEmail && t.buyer_email.toLowerCase() === viewerEmail;
  return {
    id: t.id,
    orderId: t.order_id,
    // Estado de reparto visto desde quien mira: "Mío" / "Enviado a x" / "Reclamado por x"
    share: {
      status: t.share_status ?? 'owner',
      holderEmail: t.holder_email,
      soyComprador: Boolean(soyComprador),
      // Un boleto reclamado por otro ya no es del comprador; uno reclamado por mí es mío.
      mio: (t.share_status ?? 'owner') !== 'claimed'
        ? Boolean(soyComprador) && (t.share_status ?? 'owner') === 'owner'
        : t.holder_email?.toLowerCase() === viewerEmail,
    },
    show: t.show_name ?? t.description ?? 'Show',
    date: t.starts_at ? t.starts_at.slice(0, 10) : null,
    time: t.starts_at && t.starts_at.length > 15 ? t.starts_at.slice(11, 16) : null,
    startsAt: t.starts_at,
    planta: plantaOf(t.description),          // nombre del ticket type ("Planta Baja")
    seat: seatOf(t) ? seatOf(t)
      : null,                                // reservation null en GA: degradar con gracia
    qr: t.qr_code_url,
    thumbnail: t.thumbnail_url ?? null,      // imagen del show (la tarjeta no muestra el QR)
    status: t.status,                        // valid | voided
    checkedIn: Boolean(t.checked_in),
    voided: t.status === 'voided' || t.voided_at != null,
    _dt: dt,
  };
}

export function getProfile(email) {
  const customer = db.prepare('SELECT * FROM customers WHERE email = ?').get(email);
  if (!customer) return null;

  const all = ticketsOf(email).map(t => shape(t, email));
  const upcoming = all.filter(t => !t.voided && t.startsAt && !isPast(t.startsAt));
  const pastTickets = all.filter(t => t.voided || (t.startsAt && isPast(t.startsAt)));

  // Stats
  // El escaneo en puerta es la evidencia de asistencia, así que NO se exige que la
  // función ya haya pasado: un boleto escaneado cuenta como asistido aunque la fecha
  // sea futura (pasa al escanear temprano, y contarlo como "no asistió" es mentir).
  // Es la misma regla que otorga el punto en loyalty_points.
  const asistidos = all.filter(t => !t.voided && t.checkedIn).length;
  const proximos = upcoming.length;

  // Show favorito: serie con más boletos (no anulados); empate → función más reciente
  const bySeries = new Map();
  for (const t of ticketsOf(email)) {
    if (t.status === 'voided') continue;
    const key = t.series_id ?? t.show_name ?? '—';
    const entry = bySeries.get(key) ?? { name: t.show_name ?? '—', count: 0, latest: '' };
    entry.count++;
    if ((t.starts_at ?? '') > entry.latest) entry.latest = t.starts_at ?? '';
    bySeries.set(key, entry);
  }
  let favorito = null;
  for (const e of bySeries.values()) {
    if (!favorito || e.count > favorito.count || (e.count === favorito.count && e.latest > favorito.latest)) favorito = e;
  }

  // "desde {mes año}": primera orden
  const first = db.prepare(`
    SELECT MIN(created_at) m FROM orders WHERE customer_email = ?
  `).get(email)?.m;
  let desde = null;
  if (first) {
    const d = new Date(first);
    desde = `${MESES[d.getMonth()]} ${d.getFullYear()}`;
  }

  const prefs = db.prepare('SELECT newsletter, show_reminders, offers FROM customer_prefs WHERE email = ?').get(email)
    ?? { newsletter: 1, show_reminders: 1, offers: 0 };

  const puntos = db.prepare(
    'SELECT COALESCE(SUM(points), 0) p FROM loyalty_points WHERE customer_id = ?'
  ).get(customer.id).p;

  return {
    customer: { name: customer.name, email: customer.email, phone: customer.phone, desde },
    preferences: { newsletter: !!prefs.newsletter, showReminders: !!prefs.show_reminders, offers: !!prefs.offers },
    stats: { asistidos, proximos, favorito: favorito?.name ?? null, puntos },
    upcoming: upcoming.map(({ _dt, ...t }) => t),
    history: pastTickets
      .sort((a, b) => (b.startsAt ?? '').localeCompare(a.startsAt ?? ''))
      .map(({ _dt, ...t }) => ({ ...t, attended: !t.voided && t.checkedIn })),
  };
}

export function getTicket(email, ticketId) {
  const t = ticketsOf(email).find(x => x.id === ticketId);
  if (!t) return null;
  const s = shape(t, email);
  let estado = 'Válido';
  if (s.voided) estado = 'Cancelado';
  else if (s.checkedIn) estado = 'Ya escaneado';
  return { ...s, estado };
}

export function updatePreferences(email, { newsletter, showReminders, offers }) {
  db.prepare(`
    INSERT INTO customer_prefs (email, newsletter, show_reminders, offers, updated_at)
    VALUES (@email, @n, @r, @o, datetime('now'))
    ON CONFLICT(email) DO UPDATE SET
      newsletter = COALESCE(@n, newsletter),
      show_reminders = COALESCE(@r, show_reminders),
      offers = COALESCE(@o, offers),
      updated_at = datetime('now')
  `).run({
    email,
    n: newsletter === undefined ? null : (newsletter ? 1 : 0),
    r: showReminders === undefined ? null : (showReminders ? 1 : 0),
    o: offers === undefined ? null : (offers ? 1 : 0),
  });
  const p = db.prepare('SELECT newsletter, show_reminders, offers FROM customer_prefs WHERE email = ?').get(email);
  return { newsletter: !!p.newsletter, showReminders: !!p.show_reminders, offers: !!p.offers };
}

export function updateLocalData(email, { name, phone }) {
  // Edición solo local: NO escribe de vuelta a Ticket Tailor
  db.prepare(`
    UPDATE customers SET
      name = COALESCE(?, name), phone = COALESCE(?, phone), updated_at = datetime('now')
    WHERE email = ?
  `).run(name ?? null, phone ?? null, email);
  return db.prepare('SELECT name, email, phone FROM customers WHERE email = ?').get(email);
}
