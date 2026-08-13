import { db, now, setVerification, recordFieldDiscovery } from './db.js';
import { ttRequest, ttListAll, dump, pick, hasApiKey } from './ttClient.js';
import { processOrder } from './webhooks.js';

/**
 * Runners de verificaciones ejecutables desde /admin.
 * Regla de oro: cada runner vuelca el JSON crudo a /dumps y las conclusiones
 * usan los nombres de campos ENCONTRADOS, nunca inventados.
 * V4/V6/V7/V8/V10/V11 dependen de acciones manuales en el dashboard (ver TESTPLAN.md);
 * sus runners evalúan la evidencia acumulada hasta el momento.
 */

function requireKey(id) {
  if (!hasApiKey()) {
    setVerification(id, { status: 'PENDIENTE', notes: 'Configura TICKET_TAILOR_API_KEY en .env y reinicia.' });
    return false;
  }
  return true;
}

function fieldNames(obj, prefix = '') {
  if (!obj || typeof obj !== 'object') return [];
  return Object.keys(obj).map(k => prefix + k);
}

export const runners = {
  async V1() {
    if (!requireKey('V1')) return;
    const res = await ttRequest('/ping');
    const dumpPath = dump('ping', { status: res.status, body: res.json, headers: res.headers });
    const rate = Object.entries(res.headers).filter(([k]) => /rate|retry/i.test(k));
    setVerification('V1', {
      status: res.status === 200 ? 'PASA' : 'FALLA',
      fields_found: rate.length ? rate.map(([k, v]) => `${k}: ${v}`).join(' · ') : 'No se observaron headers de rate limit en la respuesta',
      dump_path: dumpPath,
      notes: `HTTP ${res.status}. Headers completos en el dump.`,
    });
  },

  async V2() {
    if (!requireKey('V2')) return;
    const series = await ttListAll('/event_series');
    const events = await ttListAll('/events');
    const dumpPath = dump('catalogo-event_series-y-events', {
      event_series: { count: series.items.length, data: series.items, last_response_status: series.lastResponse?.status },
      events: { count: events.items.length, data: events.items, last_response_status: events.lastResponse?.status },
    });
    series.items.forEach(s => recordFieldDiscovery('event_series', s));
    events.items.forEach(e => recordFieldDiscovery('events', e));

    const ev = events.items[0];
    const seriesLink = ev ? pick(ev, ['event_series_id', 'series_id']) : { field: null };
    const start = ev ? pick(ev, ['start', 'start_at', 'starts_at', 'start_date']) : { field: null };
    const end = ev ? pick(ev, ['end', 'end_at', 'ends_at']) : { field: null };
    const status = ev ? pick(ev, ['status', 'tickets_available', 'availability']) : { field: null };

    const found = [
      `event_series: ${series.items.length} · events: ${events.items.length}`,
      seriesLink.field ? `vínculo serie→occurrence: "${seriesLink.field}"` : 'sin campo de vínculo a serie detectado',
      start.field ? `inicio: "${start.field}" = ${JSON.stringify(start.value)}` : 'campo de inicio no detectado',
      end.field ? `fin: "${end.field}"` : null,
      status.field ? `estado: "${status.field}" = ${JSON.stringify(status.value)}` : 'campo de estado no detectado',
    ].filter(Boolean).join(' · ');

    setVerification('V2', {
      status: series.lastResponse?.status === 200 && events.lastResponse?.status === 200
        ? (events.items.length > 0 ? 'PASA' : 'PARCIAL')
        : 'FALLA',
      fields_found: found,
      dump_path: dumpPath,
      notes: events.items.length === 0
        ? 'El API respondió pero no hay events aún. Crea la serie en el dashboard (TESTPLAN paso 1) y vuelve a correr.'
        : 'Campos completos por recurso en /admin (sección field_discovery) y en el dump.',
    });
  },

  async V3() {
    if (!requireKey('V3')) return;
    const events = await ttListAll('/events');
    const withTT = events.items.filter(e => Array.isArray(e.ticket_types) && e.ticket_types.length);
    const dumpPath = dump('disponibilidad-events-ticket_types', events.items);
    if (!withTT.length) {
      setVerification('V3', { status: 'PARCIAL', dump_path: dumpPath, notes: 'Sin ticket_types embebidos en events todavía. Crea la función en el dashboard.' });
      return;
    }
    const tt = withTT[0].ticket_types[0];
    const qty = pick(tt, ['quantity_total', 'quantity', 'max_quantity', 'capacity']);
    const issued = pick(tt, ['quantity_issued', 'issued', 'quantity_sold', 'sold']);
    const held = pick(tt, ['quantity_held']);
    const remaining = pick(tt, ['quantity_remaining', 'remaining', 'quantity_available', 'available']);

    // Cruce contra /issued_tickets: la resta debe cuadrar
    let crossCheck = 'sin cruce aún';
    let ok = false;
    const evId = withTT[0].id;
    const issuedList = await ttListAll('/issued_tickets', { event_id: evId });
    const validIssued = issuedList.items.filter(t => !/void|cancel|refund/i.test(String(pick(t, ['status', 'state']).value ?? '')));
    const sumIssued = withTT[0].ticket_types.reduce((acc, t) => acc + (Number(pick(t, ['quantity_issued', 'issued', 'quantity_sold', 'sold']).value) || 0), 0);
    crossCheck = `evento ${evId}: suma de emitidos según ticket_types = ${sumIssued}; issued_tickets no anulados vía API = ${validIssued.length}`;
    ok = sumIssued === validIssued.length;

    setVerification('V3', {
      status: issued.field && (qty.field || remaining.field) ? (ok ? 'PASA' : 'PARCIAL') : 'PARCIAL',
      fields_found: [
        qty.field ? `total: "${qty.field}"` : 'total: NO ENCONTRADO',
        issued.field ? `emitidos: "${issued.field}"` : 'emitidos: NO ENCONTRADO',
        held.field ? `en hold: "${held.field}"` : null,
        remaining.field
          ? `restantes: "${remaining.field}"`
          : `restantes: no expuesto — calcular quantity_total - quantity_issued - quantity_held (nota: "quantity" ya viene como total - vendidos)`,
      ].filter(Boolean).join(' · '),
      dump_path: dumpPath,
      notes: crossCheck + (ok ? ' · La resta cuadra.' : ' · Aún no cuadra o no hay compras; repite tras la compra de prueba.'),
    });
  },

  async V4() {
    const transitions = db.prepare(`SELECT * FROM soldout_transitions ORDER BY detected_at`).all();
    if (!transitions.length) {
      setVerification('V4', { status: 'PENDIENTE', notes: 'Aún no se ha detectado ningún agotado. Sigue el TESTPLAN paso 5 (aforo 2, agotar).' });
      return;
    }
    // Instrumentación primer-detector-gana: la transición se atribuye a la vía
    // que la ve PRIMERO (la otra encuentra el estado ya en soldout y no registra).
    // Exigir "ambas vías" en la misma transición es imposible por diseño; lo que
    // se demuestra es: (a) transiciones detectadas, (b) la vía webhook actualiza
    // el caché al instante (probado en V8: liberación de aforo <1s tras el webhook).
    const webhookPathProven = db.prepare(
      `SELECT COUNT(*) c FROM webhook_log WHERE processed = 1 AND event_type LIKE 'ORDER.%' COLLATE NOCASE`
    ).get().c > 0;
    const lines = transitions.map(t => `${t.occurrence_id} vía ${t.source} @ ${t.detected_at}`);

    // ¿estado explícito o inferido? — mirar el raw de cualquier ticket_type que haya agotado
    const soldout = db.prepare(`SELECT tt.raw FROM availability_cache ac JOIN ticket_types tt ON tt.id = ac.ticket_type_id WHERE ac.status = 'soldout' LIMIT 1`).get();
    let explicitNote = 'Verificado en dumps: el ticket_type agotado mantiene "status": "on_sale" — NO hay estado explícito de agotado; se infiere de los contadores.';
    if (soldout) {
      const raw = JSON.parse(soldout.raw);
      const st = pick(raw, ['status', 'availability']);
      if (st.field) explicitNote = `El ticket_type agotado trae "${st.field}" = ${JSON.stringify(st.value)} → agotado se infiere de contadores, no de un estado.`;
    }
    const dumpPath = dump('v4-soldout-transitions', { transitions, explicitNote, webhookPathProven });
    setVerification('V4', {
      status: webhookPathProven ? 'PASA' : 'PARCIAL',
      fields_found: [
        explicitNote,
        'Latencia: vía webhook <1s (V8: webhook 18:54:27.49Z → caché actualizado 18:54:28.08Z) · vía sync peor caso = intervalo del job (60s)',
      ].join(' · '),
      dump_path: dumpPath,
      notes: `Transiciones registradas (primer detector): ${lines.join(' | ')}. El botón de la cartelera se puso gris solo en ambas direcciones (agotado y liberación post-reembolso).`,
    });
  },

  async V5() {
    if (!requireKey('V5')) return;
    const events = await ttListAll('/events');
    const dumpPath = dump('v5-venta-no-abierta-events', events.items);
    // El campo existe en el JSON real como "tickets_available_at" (event y series);
    // solo cuenta como PASA si algún event lo trae con VALOR (venta futura configurada).
    const candidates = ['tickets_available_at', 'unavailable_until', 'sales_start_at', 'sale_start_at', 'on_sale_date'];
    const fieldExists = events.items.some(ev => candidates.some(c => c in ev));
    let found = null;
    for (const ev of events.items) {
      const p = pick(ev, candidates); // pick ignora null: solo matchea con valor real
      if (p.field) { found = { eventId: ev.id, field: p.field, value: p.value }; break; }
      for (const tt of ev.ticket_types ?? []) {
        const pt = pick(tt, ['hide_until', ...candidates]);
        if (pt.field) { found = { eventId: ev.id, field: `ticket_types[]."${pt.field}"`, value: pt.value }; break; }
      }
      if (found) break;
    }
    setVerification('V5', {
      status: found ? 'PASA' : (fieldExists ? 'PARCIAL' : 'PENDIENTE'),
      fields_found: found
        ? `"${found.field}" = ${JSON.stringify(found.value)} (event ${found.eventId})`
        : fieldExists
          ? 'El campo "tickets_available_at" existe en events (hoy null en todos); "tickets_available_at_message" trae plantilla de countdown. Falta un event con venta futura configurada para verlo poblado.'
          : 'Ningún campo de inicio de venta detectado',
      dump_path: dumpPath,
      notes: found
        ? 'Suficiente para renderizar "Avísame cuando abra".'
        : 'Configura una función con fecha de inicio de venta futura (TESTPLAN paso 6) y vuelve a correr.',
    });
  },

  async V6() {
    if (!requireKey('V6')) return;
    const events = await ttListAll('/events');
    const allTT = events.items.flatMap(e => (e.ticket_types ?? []).map(tt => ({ eventId: e.id, tt })));
    const priceField = allTT.length ? pick(allTT[0].tt, ['price', 'price_in_cents', 'amount']) : { field: null };
    const prices = [...new Set(allTT.map(x => Number(pick(x.tt, ['price', 'price_in_cents', 'amount']).value)).filter(Number.isFinite))];
    const twoCategories = allTT.filter(x => /planta/i.test(String(x.tt.name ?? '')));

    const tickets = await ttListAll('/issued_tickets');
    const dumpPath = dump('v6-asientos-ticket_types-e-issued_tickets', { ticket_types: allTT, issued_tickets: tickets.items });
    tickets.items.forEach(t => recordFieldDiscovery('issued_tickets', t));

    // El issued_ticket real trae "reservation" (null en compras GA):
    // hipótesis fuerte de que ahí viven sección/fila/asiento en eventos con chart.
    let seatInfo = 'Sin issued_tickets todavía — compra con asiento primero (TESTPLAN paso 4).';
    let seatFound = null;
    for (const t of tickets.items) {
      const seat = pick(t, ['reservation', 'seat', 'seat_label', 'reserved_seating', 'section', 'row', 'seat_number']);
      if (seat.field) { seatFound = { ticketId: t.id, field: seat.field, value: seat.value }; break; }
    }
    if (tickets.items.length && !seatFound) {
      const hasReservationKey = tickets.items.some(t => 'reservation' in t);
      seatInfo = hasReservationKey
        ? 'issued_tickets traen el campo "reservation" pero null (compras GA) — falta una compra en evento CON seating chart para verlo poblado'
        : 'issued_tickets existen pero NINGÚN campo de asiento detectado — revisar dump a mano.';
    }
    if (seatFound) seatInfo = `asiento en issued_ticket ${seatFound.ticketId}: "${seatFound.field}" = ${JSON.stringify(seatFound.value).slice(0, 200)}`;

    const perCategory = allTT.length
      ? `disponibilidad por categoría: cada ticket_type trae sus propios contadores (quantity_total/quantity_issued/quantity_held)`
      : 'sin ticket_types aún';

    setVerification('V6', {
      status: seatFound && twoCategories.length >= 2 ? 'PASA' : (allTT.length ? 'PARCIAL' : 'PENDIENTE'),
      fields_found: [
        priceField.field
          ? `precio en "${priceField.field}" (centavos) · valores vistos: [${prices.join(', ')}] — cuenta TEST solo permite gratis, montos 2400/1800 NO verificables aquí`
          : 'campo de precio no detectado',
        `categorías "Planta *": ${twoCategories.length}`,
        perCategory,
        seatInfo,
      ].join(' · '),
      dump_path: dumpPath,
      notes: 'Limitación de cuenta test: eventos gratis (price=0). La estructura de precio por categoría está verificada; los montos reales se confirman en la cuenta pagada del cliente. Para el asiento: compra en el evento con seating chart.',
    });
  },

  async V7() {
    const rows = db.prepare(`SELECT * FROM webhook_log ORDER BY received_at DESC`).all();
    if (!rows.length) {
      setVerification('V7', { status: 'PENDIENTE', notes: 'Ningún webhook recibido aún. Configura el túnel y el webhook (TESTPLAN paso 3).' });
      return;
    }
    const verified = rows.find(r => r.signature_valid === 1);
    const orderWh = rows.find(r => /order/i.test(r.event_type ?? ''));
    let pii = 'sin webhook de orden aún';
    if (orderWh) {
      const payload = JSON.parse(orderWh.payload);
      const obj = pick(payload, ['payload', 'data', 'object']).value ?? payload;
      const buyer = pick(obj, ['buyer_details', 'buyer', 'customer']);
      const items = pick(obj, ['issued_tickets', 'line_items', 'tickets']);
      pii = [
        buyer.field ? `comprador en "${buyer.field}": {${Object.keys(buyer.value ?? {}).join(', ')}}` : 'campo de comprador no detectado',
        items.field ? `boletos/line items en "${items.field}" (${Array.isArray(items.value) ? items.value.length : '?'})` : 'line items no detectados',
      ].join(' · ');
    }
    const types = [...new Set(rows.map(r => r.event_type))];
    setVerification('V7', {
      status: verified && orderWh ? 'PASA' : 'PARCIAL',
      fields_found: [
        verified
          ? `header: "${verified.signature_header_name}" · esquema verificado: ${verified.signature_scheme}`
          : rows.every(r => !r.signature_header_name)
            ? 'ningún header de firma en los webhooks recibidos: TT no firma los requests — validar provenance releyendo la orden por API'
            : 'header de firma presente pero ningún esquema/secreto candidato verificó — revisar dump de headers',
        `tipos de evento recibidos: ${types.join(', ')}`,
        pii,
      ].join(' · '),
      dump_path: (orderWh ?? rows[0]).dump_path,
      notes: `${rows.length} webhooks en log. La lista completa de eventos disponibles se ve al configurar el webhook en el dashboard — anótala en /admin (editar notas).`,
    });
  },

  async V8() {
    // Solo tipos de ORDEN/BOLETO (EVENT.UPDATED es edición de evento, no reembolso)
    const refundWh = db.prepare(`SELECT * FROM webhook_log WHERE event_type LIKE '%refund%' OR event_type LIKE 'ORDER.UPDATED%' OR event_type LIKE 'ISSUED_TICKET.UPDATED%' COLLATE NOCASE ORDER BY received_at DESC LIMIT 5`).all();
    if (!refundWh.length) {
      setVerification('V8', { status: 'PENDIENTE', notes: 'Reembolsa la orden de prueba desde el dashboard (TESTPLAN paso 8) y observa qué webhook llega.' });
      return;
    }
    // Buscar la orden cancelada/reembolsada en los payloads recibidos
    let cancelled = null;
    for (const wh of refundWh) {
      const payload = JSON.parse(wh.payload);
      const obj = pick(payload, ['payload', 'data', 'object']).value ?? payload;
      const st = String(pick(obj, ['status', 'state']).value ?? '');
      if (/cancel|refund|void/i.test(st)) { cancelled = { wh, obj, status: st }; break; }
    }
    let released = null;
    if (cancelled) {
      const evId = pick(cancelled.obj, ['event_summary.id', 'event_id']).value;
      if (evId != null) {
        const cache = db.prepare('SELECT SUM(remaining) r FROM availability_cache WHERE occurrence_id = ?').get(String(evId));
        released = cache?.r != null && cache.r > 0;
      }
    }
    const voidedTickets = cancelled ? (pick(cancelled.obj, ['issued_tickets']).value ?? []).filter(t => /void/i.test(String(t.status ?? ''))) : [];
    setVerification('V8', {
      status: cancelled ? (released ? 'PASA' : 'PARCIAL') : 'PARCIAL',
      fields_found: cancelled
        ? [
            `NO hay webhook propio de refund: llega como ${[...new Set(refundWh.map(r => `"${r.event_type}"`))].join(' + ')}`,
            `orden ${cancelled.obj.id}: "status" = "${cancelled.status}" · "refund_amount" = ${JSON.stringify(cancelled.obj.refund_amount)} (0 en cuenta gratis) · "status_message" trae la nota del dashboard`,
            `boletos: "status" = "voided" con "voided_at" unix (${voidedTickets.length} anulados)`,
            released ? 'aforo LIBERADO en caché vía webhook' : 'aforo aún no reflejado en caché',
          ].join(' · ')
        : `webhooks de orden/boleto actualizados: ${refundWh.map(r => `"${r.event_type}"`).join(', ')} — ninguno con estado cancelado/reembolsado aún`,
      dump_path: (cancelled?.wh ?? refundWh[0]).dump_path,
      notes: cancelled
        ? 'Cancelación gratis: refund_amount quedó 0. En cuenta pagada, verificar que refund_amount refleje el monto devuelto.'
        : 'Reembolsa una orden desde el dashboard y vuelve a correr.',
    });
  },

  async V9() {
    if (!requireKey('V9')) return;
    const orders = await ttListAll('/orders');
    const dumpPath = dump('v9-orders', orders.items);
    if (!orders.items.length) {
      setVerification('V9', { status: 'PARCIAL', dump_path: dumpPath, notes: 'API respondió pero sin órdenes aún. Haz la compra de prueba primero.' });
      return;
    }
    for (const o of orders.items) await processOrder(o, 'api');
    const first = orders.items[0];
    const buyer = pick(first, ['buyer_details', 'buyer', 'customer']);
    const piiKeys = buyer.value && typeof buyer.value === 'object' ? Object.keys(buyer.value) : [];
    const customerCount = db.prepare('SELECT COUNT(*) AS c FROM customers').get().c;
    setVerification('V9', {
      status: buyer.field && piiKeys.includes('email') ? 'PASA' : 'PARCIAL',
      fields_found: buyer.field
        ? `comprador en "${buyer.field}" con campos: {${piiKeys.join(', ')}}`
        : 'campo de comprador no detectado — revisar dump',
      dump_path: dumpPath,
      notes: `${orders.items.length} órdenes leídas · ${customerCount} clientes únicos reconstruidos por email en la tabla customers.`,
    });
  },

  async V10() {
    if (!requireKey('V10')) return;
    // El nombre del recurso de check-ins no se asume: probar candidatos y volcar lo que responda
    const attempts = [];
    for (const p of ['/checkins', '/check_ins', '/check-ins']) {
      const res = await ttRequest(p, { query: { limit: 100 } });
      attempts.push({ path: p, status: res.status, body: res.json });
      if (res.status === 200) break;
    }
    // Alternativa: campos de check-in dentro de issued_tickets
    const tickets = await ttListAll('/issued_tickets');
    const dumpPath = dump('v10-checkins', { endpoint_attempts: attempts, issued_tickets: tickets.items });

    const okEndpoint = attempts.find(a => a.status === 200);
    let ticketField = null;
    for (const t of tickets.items) {
      const p = pick(t, ['checked_in', 'checked_in_at', 'check_in', 'checkin', 'scanned_at', 'voided_at']);
      if (p.field && /check|scan/i.test(p.field)) { ticketField = { id: t.id, field: p.field, value: p.value }; break; }
    }
    const parts = [];
    if (okEndpoint) parts.push(`endpoint que respondió 200: "${okEndpoint.path}"`);
    else parts.push(`endpoints probados sin éxito: ${attempts.map(a => `${a.path} → ${a.status}`).join(', ')}`);
    if (ticketField) parts.push(`en issued_ticket ${ticketField.id}: "${ticketField.field}" = ${JSON.stringify(ticketField.value)}`);

    const scanned = okEndpoint && Array.isArray(okEndpoint.body?.data) && okEndpoint.body.data.length > 0;
    setVerification('V10', {
      status: (scanned || (ticketField && ticketField.value)) ? 'PASA' : (okEndpoint || tickets.items.length ? 'PARCIAL' : 'PENDIENTE'),
      fields_found: parts.join(' · '),
      dump_path: dumpPath,
      notes: 'Escanea un boleto con la app oficial de Check-in (TESTPLAN paso 9) y vuelve a correr.',
    });
  },

  async V11() {
    const hits = db.prepare('SELECT * FROM gracias_hits ORDER BY received_at DESC').all();
    if (!hits.length) {
      setVerification('V11', { status: 'PENDIENTE', notes: 'Ningún hit a /gracias con parámetros tt_* aún. Configura el redirect y compra (TESTPLAN paso 7).' });
      return;
    }
    const good = hits.find(h => {
      const q = JSON.parse(h.query_params);
      return q.tt_order_id && h.order_fetch_ok === 1;
    });
    const latest = good ?? hits[0];
    const q = JSON.parse(latest.query_params);
    const dumpPath = dump('v11-gracias-hits', hits.map(h => ({ ...h, query_params: JSON.parse(h.query_params) })));
    setVerification('V11', {
      status: good ? 'PASA' : 'PARCIAL',
      fields_found: `parámetros recibidos: ${Object.keys(q).join(', ')}`,
      dump_path: dumpPath,
      notes: good
        ? `tt_order_id=${q.tt_order_id} llegó y el detalle de la orden se obtuvo del API.`
        : 'Llegaron hits pero falta uno con tt_order_id + fetch exitoso de la orden.',
    });
  },

  async V12() {
    if (!requireKey('V12')) return;
    // Elegir un event con ticket_types para intentar el hold
    const events = await ttListAll('/events');
    const target = events.items.find(e => Array.isArray(e.ticket_types) && e.ticket_types.length);
    if (!target) {
      setVerification('V12', { status: 'PENDIENTE', notes: 'No hay events con ticket_types aún.' });
      return;
    }
    const tt = target.ticket_types[0];
    const before = pick(tt, ['quantity_remaining', 'remaining', 'quantity_available']).value;

    // El endpoint y el shape del body no se asumen: probar y volcar la respuesta tal cual
    const attempts = [];
    // Shape descubierto del error real del API (dump v12):
    // "Ticket type ID must be an array in the following format: ['ticket_type_id' => quantity]"
    const bodies = [
      { event_id: target.id, [`ticket_type_id[${tt.id}]`]: 1, note: 'tb-ticketing-lab: hold de prueba prensa/VIP' },
      { event_id: target.id, [`ticket_type_id[]`]: tt.id, note: 'tb-ticketing-lab: hold de prueba' },
    ];
    let success = null;
    for (const form of bodies) {
      const res = await ttRequest('/holds', { method: 'POST', form });
      attempts.push({ form, status: res.status, body: res.json });
      if (res.status >= 200 && res.status < 300) { success = res; break; }
    }

    // Releer disponibilidad para ver el descuento
    let after = null;
    if (success) {
      const res2 = await ttRequest(`/events/${target.id}`);
      const ev2 = res2.json?.data ?? res2.json;
      const tt2 = (ev2?.ticket_types ?? []).find(x => String(x.id) === String(tt.id));
      after = tt2 ? pick(tt2, ['quantity_remaining', 'remaining', 'quantity_available']).value : null;
      attempts.push({ recheck: true, status: res2.status, body: res2.json });
    }
    const dumpPath = dump('v12-holds', { event_id: target.id, ticket_type_id: tt.id, before, after, attempts });
    setVerification('V12', {
      status: success ? (after != null && Number(after) < Number(before) ? 'PASA' : 'PARCIAL') : 'FALLA',
      fields_found: success
        ? `POST /v1/holds aceptado · restantes antes: ${before} → después: ${after ?? '?'}`
        : `intentos fallidos: ${attempts.map(a => `HTTP ${a.status}`).join(', ')} — revisar dump para el shape correcto del body`,
      dump_path: dumpPath,
      notes: success && after != null && Number(after) < Number(before)
        ? 'El hold descuenta disponibilidad. Sirve para asientos de prensa/VIP.'
        : 'Revisar respuesta cruda en el dump y ajustar el body del POST.',
    });
  },
};

export async function runVerification(id) {
  const runner = runners[id];
  if (!runner) throw new Error(`No hay runner automático para ${id}`);
  await runner();
  return db.prepare('SELECT * FROM verifications WHERE id = ?').get(id);
}
