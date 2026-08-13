import { db, now, recordFieldDiscovery } from './db.js';
import { ttListAll, dump, pick, hasApiKey } from './ttClient.js';

/**
 * Candidatos de nombres de campos. La regla de oro: estos son HIPÓTESIS.
 * pick() encuentra cuál existe en el JSON real y field_discovery guarda
 * todos los nombres literales observados. Las conclusiones (admin/FINDINGS)
 * se escriben con lo descubierto, no con esta lista.
 */
const C = {
  seriesName: ['name', 'title'],
  eventSeriesId: ['event_series_id', 'series_id'],
  eventName: ['name', 'title'],
  eventStart: ['start.iso', 'start.date', 'start_at', 'starts_at', 'start'],
  eventEnd: ['end.iso', 'end.date', 'end_at', 'ends_at', 'end'],
  eventStatus: ['status', 'tickets_available', 'availability', 'online_event'],
  saleStart: ['unavailable_until', 'sales_start_at', 'sale_start_at', 'on_sale_date', 'start_sales_at', 'tickets_available_at'],
  checkoutUrl: ['checkout_url', 'url', 'tickets_url', 'call_to_action.url'],
  thumbnail: ['images.thumbnail', 'images.header', 'image_url', 'thumbnail_url'],
  ttPrice: ['price', 'price_in_cents', 'amount'],
  // Semántica REAL observada (dumps v12 y cruce 19:17, 2026-08-13):
  // quantity_total = aforo, quantity_issued = vendidos, quantity_held = en hold,
  // quantity_in_baskets = en carritos activos, quantity = total − vendidos − carritos.
  ttQuantity: ['quantity_total', 'quantity', 'max_quantity', 'capacity'],
  ttIssued: ['quantity_issued', 'issued', 'quantity_sold', 'sold'],
  ttHeld: ['quantity_held'],
  ttBaskets: ['quantity_in_baskets'],
  ttRemaining: ['quantity_remaining', 'remaining', 'quantity_available', 'available'],
  ttStatus: ['status', 'availability'],
};

let lastSync = { at: null, ok: null, error: null, events: 0 };
export function syncStatus() { return lastSync; }

export async function syncAll({ dumpRaw = false } = {}) {
  if (!hasApiKey()) {
    lastSync = { at: now(), ok: false, error: 'Sin TICKET_TAILOR_API_KEY: sync deshabilitado', events: 0 };
    return lastSync;
  }
  try {
    const series = await ttListAll('/event_series');
    const events = await ttListAll('/events');

    if (dumpRaw) {
      if (series.items.length || series.lastResponse) dump('event_series', series.lastResponse?.json ?? series.items);
      if (events.items.length || events.lastResponse) dump('events', events.lastResponse?.json ?? events.items);
    }

    const upsertShow = db.prepare(`
      INSERT INTO shows (id, name, slug, thumbnail_url, raw, updated_at)
      VALUES (@id, @name, @slug, @thumb, @raw, @updated_at)
      ON CONFLICT(id) DO UPDATE SET name=@name, slug=@slug, thumbnail_url=@thumb, raw=@raw, updated_at=@updated_at
    `);
    const upsertOcc = db.prepare(`
      INSERT INTO occurrences (id, show_id, starts_at, ends_at, status, sale_start_at, checkout_url, raw, updated_at)
      VALUES (@id, @show_id, @starts_at, @ends_at, @status, @sale_start_at, @checkout_url, @raw, @updated_at)
      ON CONFLICT(id) DO UPDATE SET show_id=@show_id, starts_at=@starts_at, ends_at=@ends_at, status=@status,
        sale_start_at=@sale_start_at, checkout_url=@checkout_url, raw=@raw, updated_at=@updated_at
    `);
    const upsertTT = db.prepare(`
      INSERT INTO ticket_types (id, occurrence_id, name, price_cents, quantity_total, raw, updated_at)
      VALUES (@id, @occurrence_id, @name, @price_cents, @quantity_total, @raw, @updated_at)
      ON CONFLICT(id) DO UPDATE SET occurrence_id=@occurrence_id, name=@name, price_cents=@price_cents,
        quantity_total=@quantity_total, raw=@raw, updated_at=@updated_at
    `);

    for (const s of series.items) {
      recordFieldDiscovery('event_series', s);
      upsertShow.run({
        id: String(s.id),
        name: pick(s, C.seriesName).value ?? String(s.id),
        slug: String(pick(s, C.seriesName).value ?? s.id).toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        thumb: pick(s, C.thumbnail).value ?? null,
        raw: JSON.stringify(s),
        updated_at: now(),
      });
    }

    for (const ev of events.items) {
      recordFieldDiscovery('events', ev);
      const showId = pick(ev, C.eventSeriesId).value;
      upsertOcc.run({
        id: String(ev.id),
        show_id: showId != null ? String(showId) : null,
        starts_at: normalizeDate(pick(ev, C.eventStart).value),
        ends_at: normalizeDate(pick(ev, C.eventEnd).value),
        status: stringify(pick(ev, C.eventStatus).value),
        sale_start_at: normalizeDate(pick(ev, C.saleStart).value),
        checkout_url: pick(ev, C.checkoutUrl).value ?? null,
        raw: JSON.stringify(ev),
        updated_at: now(),
      });

      // ticket_types suelen venir embebidos en el event; verificar contra el JSON real
      const embedded = Array.isArray(ev.ticket_types) ? ev.ticket_types : [];
      for (const tt of embedded) {
        recordFieldDiscovery('ticket_types', tt);
        upsertTT.run({
          id: String(tt.id),
          occurrence_id: String(ev.id),
          name: pick(tt, C.seriesName).value ?? String(tt.id),
          price_cents: numberOrNull(pick(tt, C.ttPrice).value),
          quantity_total: numberOrNull(pick(tt, C.ttQuantity).value),
          raw: JSON.stringify(tt),
          updated_at: now(),
        });
        updateAvailability(String(ev.id), tt, 'sync');
      }
    }

    lastSync = { at: now(), ok: true, error: null, events: events.items.length };
  } catch (err) {
    lastSync = { at: now(), ok: false, error: err.message, events: 0 };
    console.error('[sync] error:', err.message);
  }
  return lastSync;
}

/**
 * Actualiza availability_cache desde un ticket_type crudo y registra
 * transiciones a agotado con su vía ('sync' | 'webhook') para medir latencia (V4).
 */
export function updateAvailability(occurrenceId, ttRaw, source) {
  const quantity = numberOrNull(pick(ttRaw, C.ttQuantity).value);
  const issued = numberOrNull(pick(ttRaw, C.ttIssued).value);
  const held = numberOrNull(pick(ttRaw, C.ttHeld).value) ?? 0;
  const baskets = numberOrNull(pick(ttRaw, C.ttBaskets).value) ?? 0;
  let remaining = numberOrNull(pick(ttRaw, C.ttRemaining).value);
  // restantes vendibles = aforo − vendidos − holds − carritos activos
  // (los carritos expiran solos: un remaining=0 por baskets puede revertir en minutos)
  if (remaining == null && quantity != null && issued != null) remaining = quantity - issued - held - baskets;

  const occ = db.prepare('SELECT sale_start_at FROM occurrences WHERE id = ?').get(occurrenceId);
  const ttStatus = stringify(pick(ttRaw, C.ttStatus).value);

  let status = 'onsale';
  if (occ?.sale_start_at && new Date(occ.sale_start_at) > new Date()) status = 'soon';
  if (ttStatus && /sold[_ ]?out|agotado/i.test(ttStatus)) status = 'soldout';
  if (remaining != null && remaining <= 0) status = 'soldout';
  else if (remaining != null && quantity > 0 && remaining / quantity <= 0.15 && status === 'onsale') status = 'low';

  const prev = db.prepare(
    'SELECT status FROM availability_cache WHERE occurrence_id = ? AND ticket_type_id = ?'
  ).get(occurrenceId, String(ttRaw.id));

  db.prepare(`
    INSERT INTO availability_cache (occurrence_id, ticket_type_id, quantity, issued, remaining, status, last_synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(occurrence_id, ticket_type_id) DO UPDATE SET
      quantity=excluded.quantity, issued=excluded.issued, remaining=excluded.remaining,
      status=excluded.status, last_synced_at=excluded.last_synced_at
  `).run(occurrenceId, String(ttRaw.id), quantity, issued, remaining, status, now());

  if (status === 'soldout' && prev?.status !== 'soldout') {
    db.prepare(
      'INSERT INTO soldout_transitions (occurrence_id, source, detected_at, details) VALUES (?, ?, ?, ?)'
    ).run(occurrenceId, source, now(), JSON.stringify({ ticket_type_id: ttRaw.id, quantity, issued, remaining }));
    console.log(`[availability] ${occurrenceId} → AGOTADO vía ${source}`);
  }
}

function normalizeDate(v) {
  if (v == null) return null;
  if (typeof v === 'object') {
    // TT suele anidar fechas como objetos { date, time, iso, unix, ... }: usar lo que exista
    if (v.iso) return v.iso;
    if (v.unix) return new Date(v.unix * 1000).toISOString();
    if (v.date && v.time) return `${v.date}T${v.time}`;
    if (v.date) return v.date;
    return JSON.stringify(v);
  }
  if (typeof v === 'number') return new Date(v * (v < 1e12 ? 1000 : 1)).toISOString();
  return String(v);
}

function numberOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function stringify(v) {
  if (v == null) return null;
  return typeof v === 'string' ? v : JSON.stringify(v);
}
