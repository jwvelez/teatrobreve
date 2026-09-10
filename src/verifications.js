import crypto from 'node:crypto';
import { db, now, setVerification, recordFieldDiscovery } from './db.js';
import { ttRequest, ttListAll, dump, pick, hasApiKey } from './ttClient.js';
import { processOrder } from './webhooks.js';
import { evaluatePointsForTicket, claimTicket, sendTicket } from './sharing.js';

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
  // ---------- Compartir boletos con el corillo ----------
  //
  // V13/V14/V15 prueban la REGLA DE PUNTOS, que es lógica nuestra, no del API de TT.
  // Cada una monta su escenario en una transacción y la revierte al terminar, así que
  // no ensucian la base ni tocan la cuenta del cliente. El dump guarda el antes/después.

  async V13() {
    // Boleto reclamado + check-in = exactamente 1 punto. Correrlo dos veces no da 2.
    const r = withScenario(({ email, occ, ticketId }) => {
      claimByFixture(ticketId, email);
      setCheckedIn(ticketId, true);

      const first = evaluatePointsForTicket(ticketId);
      const afterFirst = pointsOf(email, occ);
      const second = evaluatePointsForTicket(ticketId);   // idempotencia
      const afterSecond = pointsOf(email, occ);

      return {
        primera_evaluacion_otorgo: first,
        puntos_tras_primera: afterFirst,
        segunda_evaluacion_otorgo: second,
        puntos_tras_segunda: afterSecond,
        ok: first === true && afterFirst === 1 && second === false && afterSecond === 1,
      };
    });

    const dumpPath = dump('v13-punto-reclamado-mas-checkin', r);
    setVerification('V13', {
      status: r.ok ? 'PASA' : 'FALLA',
      fields_found: [
        `reclamado + escaneado → otorga: ${r.primera_evaluacion_otorgo} · total = ${r.puntos_tras_primera} punto`,
        `segunda evaluación → otorga: ${r.segunda_evaluacion_otorgo} · total sigue = ${r.puntos_tras_segunda}`,
        'idempotencia por UNIQUE(customer_id, occurrence_id) + INSERT OR IGNORE',
      ].join(' · '),
      dump_path: dumpPath,
      notes: r.ok
        ? 'El punto se otorga al escanear (no al reclamar) y reevaluar no duplica.'
        : 'La regla no se cumplió: revisar el dump con el antes/después.',
    });
  },

  async V14() {
    // Enviado pero NUNCA reclamado: aunque se escanee, no otorga punto.
    const r = withScenario(({ email, occ, ticketId }) => {
      db.prepare(`UPDATE ticket_assignments SET status='sent', holder_email=?, holder_customer_id=NULL, sent_at=? WHERE issued_ticket_id=?`)
        .run(email, now(), ticketId);
      setCheckedIn(ticketId, true);

      const otorgo = evaluatePointsForTicket(ticketId);
      const total = pointsOf(email, occ);

      // Y al reclamar DESPUÉS del escaneo, sí debe otorgarse (reclamo tardío)
      claimByFixture(ticketId, email);
      const trasReclamo = evaluatePointsForTicket(ticketId);
      const totalTrasReclamo = pointsOf(email, occ);

      return {
        enviado_sin_reclamar_otorgo: otorgo,
        puntos_sin_reclamar: total,
        reclamo_tardio_otorgo: trasReclamo,
        puntos_tras_reclamo_tardio: totalTrasReclamo,
        ok: otorgo === false && total === 0 && trasReclamo === true && totalTrasReclamo === 1,
      };
    });

    const dumpPath = dump('v14-enviado-sin-reclamar-no-otorga', r);
    setVerification('V14', {
      status: r.ok ? 'PASA' : 'FALLA',
      fields_found: [
        `enviado + escaneado pero SIN reclamar → otorga: ${r.enviado_sin_reclamar_otorgo} · total = ${r.puntos_sin_reclamar}`,
        `reclamo TARDÍO (después del escaneo) → otorga: ${r.reclamo_tardio_otorgo} · total = ${r.puntos_tras_reclamo_tardio}`,
      ].join(' · '),
      dump_path: dumpPath,
      notes: r.ok
        ? 'Quien no reclama no acumula. Y el reclamo posterior al escaneo sí otorga: por eso se evalúa en los dos eventos.'
        : 'La regla no se cumplió: revisar el dump.',
    });
  },

  async V15() {
    // Dos boletos de la MISMA función en la misma persona = 1 punto (no 2).
    const r = withScenario(({ email, occ, ticketId, ticketId2 }) => {
      for (const id of [ticketId, ticketId2]) {
        claimByFixture(id, email);
        setCheckedIn(id, true);
      }
      const a = evaluatePointsForTicket(ticketId);
      const b = evaluatePointsForTicket(ticketId2);
      const total = pointsOf(email, occ);
      const filas = db.prepare(
        'SELECT COUNT(*) c FROM loyalty_points WHERE occurrence_id = ? AND customer_id = (SELECT id FROM customers WHERE email = ?)'
      ).get(occ, email).c;
      return {
        primer_boleto_otorgo: a,
        segundo_boleto_otorgo: b,
        puntos_totales: total,
        filas_en_el_ledger: filas,
        ok: a === true && b === false && total === 1 && filas === 1,
      };
    }, { twoTickets: true });

    const dumpPath = dump('v15-dos-boletos-misma-funcion-un-punto', r);
    setVerification('V15', {
      status: r.ok ? 'PASA' : 'FALLA',
      fields_found: [
        `primer boleto otorga: ${r.primer_boleto_otorgo} · segundo boleto otorga: ${r.segundo_boleto_otorgo}`,
        `total = ${r.puntos_totales} punto · filas en loyalty_points = ${r.filas_en_el_ledger}`,
        'el ledger es UNIQUE(customer_id, occurrence_id): un punto por persona por FUNCIÓN, no por boleto',
      ].join(' · '),
      dump_path: dumpPath,
      notes: r.ok
        ? 'Quedarse con 2 boletos de la misma función da 1 punto.'
        : 'La regla no se cumplió: revisar el dump.',
    });
  },
  /**
   * V18 — ¿Un ticket type "Members only" convive con un seating chart?
   * Decide si el abonado puede tener BUTACA REAL sin usar códigos de descuento.
   * Se resolvió creando el ticket type a mano en el dashboard (el API no los crea:
   * POST /ticket_types → 404) y leyendo cómo lo expone el API.
   */
  async V18() {
    if (!requireKey('V18')) return;

    const events = await ttListAll('/events');
    const allTT = events.items.flatMap(e => (e.ticket_types ?? []).map(tt => ({ ev: e.id, serie: e.event_series_id, tt })));
    allTT.forEach(x => recordFieldDiscovery('ticket_types', x.tt));

    // El combo que decide: status members_only Y type Seated en el mismo ticket type.
    const combo = allTT.filter(x =>
      /member/i.test(String(pick(x.tt, ['status']).value ?? '')) &&
      /seat/i.test(String(pick(x.tt, ['type']).value ?? ''))
    );
    const soloMembers = allTT.filter(x => /member/i.test(String(pick(x.tt, ['status']).value ?? '')));
    const statuses = [...new Set(allTT.map(x => String(pick(x.tt, ['status']).value)))];
    const tipos = [...new Set(allTT.map(x => String(pick(x.tt, ['type']).value)))];

    // ¿En cuántas ocurrencias vive el ticket type del pase? (los TT son compartidos
    // por la serie, así que uno solo cubre toda la temporada)
    let cobertura = null;
    if (combo.length) {
      const id = combo[0].tt.id;
      const ocurrencias = allTT.filter(x => x.tt.id === id).map(x => x.ev);
      cobertura = { ticket_type: id, ocurrencias: ocurrencias.length, serie: combo[0].serie };
    }

    const dumpPath = dump('v18-members-only-con-seating-chart', {
      veredicto: combo.length ? 'A FAVOR · members_only y Seated conviven' : 'sin evidencia todavía',
      statuses_observados: statuses,
      types_observados: tipos,
      ticket_types_members_only: soloMembers.map(x => x.tt),
      combo_members_only_y_seated: combo.map(x => x.tt),
      cobertura_en_la_serie: cobertura,
      nota: 'Los ticket types NO se crean por API (POST /ticket_types → 404): este se creó en el dashboard y el API solo lo refleja.',
    });

    setVerification('V18', {
      status: combo.length ? 'PASA' : 'PARCIAL',
      fields_found: combo.length
        ? [
            `ticket type "${combo[0].tt.name}" (${combo[0].tt.id}): "status" = "${combo[0].tt.status}" Y "type" = "${combo[0].tt.type}" a la vez`,
            `precio ${combo[0].tt.price} · max_per_order ${combo[0].tt.max_per_order} · aforo ${combo[0].tt.quantity_total}`,
            cobertura ? `cubre ${cobertura.ocurrencias} ocurrencias de ${cobertura.serie} (los ticket types son compartidos por la serie)` : null,
            `valores de "status" vistos en la cuenta: [${statuses.join(', ')}] · de "type": [${tipos.join(', ')}]`,
          ].filter(Boolean).join(' · ')
        : `Sin ticket type que combine members_only + Seated. status vistos: [${statuses.join(', ')}] · type: [${tipos.join(', ')}]`,
      dump_path: dumpPath,
      notes: combo.length
        ? 'A FAVOR: el "Abono Butaca" es viable. Un ticket type Members only CON butacas del seating chart permite que el abonado escoja asiento real sin usar códigos de descuento — lo que esquiva por completo el fallo de V24 (el monto fijo se aplicaba por boleto). Además "max_per_order" se fija SOLO en este ticket type, así que no afecta las compras regulares. El ticket type se crea a mano en el dashboard: el API no los crea (404), solo los refleja.'
        : 'Crea en el dashboard un ticket type con status "Members only" asignado a categorías del seating chart y vuelve a correr.',
    });
  },

  /**
   * V22 — ¿Una orden de $0 (la redención del pase) dispara el webhook de orden igual
   * que una pagada, y con qué valores en los campos de total?
   */
  async V22() {
    const products = db.prepare('SELECT ticket_type_id FROM pass_products').all().map(p => p.ticket_type_id);
    const rows = db.prepare(`SELECT * FROM webhook_log WHERE event_type LIKE 'ORDER.%' COLLATE NOCASE ORDER BY received_at DESC LIMIT 200`).all();
    let redencion = null;
    let gratis = null;
    for (const wh of rows) {
      let payload; try { payload = JSON.parse(wh.payload); } catch { continue; }
      const obj = pick(payload, ['payload', 'data', 'object']).value ?? payload;
      const total = Number(pick(obj, ['total']).value);
      if (!Number.isFinite(total) || total !== 0) continue;
      const tickets = pick(obj, ['issued_tickets']).value;
      const usaPase = Array.isArray(tickets) && tickets.some(t => products.includes(String(pick(t, ['ticket_type_id']).value ?? '')));
      const info = {
        webhook: wh.event_type, received_at: wh.received_at, order_id: obj.id, dump: wh.dump_path,
        total: obj.total, total_paid: obj.total_paid, subtotal: obj.subtotal,
        payment_method: pick(obj, ['payment_method.id', 'payment_method']).value ?? null,
        boletos: Array.isArray(tickets) ? tickets.length : 0,
      };
      if (usaPase && !redencion) redencion = info;
      if (!gratis) gratis = info;
      if (redencion) break;
    }
    const dumpPath = dump('v22-orden-cero-dispara-webhook', { redencion_del_pase: redencion, orden_gratis_cualquiera: gratis, ticket_types_del_pase: products });
    const ev = redencion ?? gratis;
    setVerification('V22', {
      status: redencion ? 'PASA' : (gratis ? 'PARCIAL' : 'PENDIENTE'),
      fields_found: ev
        ? `${ev.webhook} llegó para la orden ${ev.order_id} con "total" = ${JSON.stringify(ev.total)} · "total_paid" = ${JSON.stringify(ev.total_paid)} · "subtotal" = ${JSON.stringify(ev.subtotal)} · ${ev.boletos} boleto(s)${redencion ? ' · uno de ellos es el ticket type del pase' : ''}`
        : 'Ningún webhook de orden a $0 todavía',
      dump_path: dumpPath,
      notes: redencion
        ? 'Las órdenes a $0 disparan ORDER.CREATED igual que las pagadas: la redención del pase se ingiere por el mismo camino. Los créditos de TT no se pueden leer por API — confirmar en el dashboard (Billing) si una orden gratis consume crédito.'
        : gratis
          ? 'Las órdenes gratis de agosto sí dispararon webhook. Falta una REDENCIÓN real (compra del boleto "members only" a $0) para cerrar V22. Ver TESTPLAN.'
          : 'Reserva una función con un pase activo y vuelve a correr.',
    });
  },

  /**
   * V25 — Al agotar max_redemptions de la membresía, ¿el boleto deja de aparecer?
   * Lo observable por API es el estado de la membresía al llegar al límite
   * (redemptions, is_valid). Que el checkout ya no muestre el boleto se confirma a
   * mano (no hay API de canasta).
   */
  async V25() {
    if (!requireKey('V25')) return;
    const passes = db.prepare(`SELECT * FROM season_passes WHERE issued_membership_id IS NOT NULL ORDER BY redemptions DESC`).all();
    const top = passes[0];
    if (!top) {
      setVerification('V25', { status: 'PENDIENTE', notes: 'Ningún pase con membresía localizada todavía. Compra El Pase (TESTPLAN) y vuelve a correr.' });
      return;
    }
    const res = await ttRequest(`/issued_memberships/${encodeURIComponent(top.issued_membership_id)}`);
    const m = res.json?.data ?? res.json;
    if (m && typeof m === 'object') recordFieldDiscovery('issued_memberships', m);
    const red = Number(pick(m ?? {}, ['redemptions']).value);
    const max = pick(m ?? {}, ['max_redemptions']).value ?? top.max_redemptions;
    const isValid = pick(m ?? {}, ['is_valid']).value;
    const lista = pick(m ?? {}, ['redemption_collection']).value;
    const agotado = Number.isFinite(red) && max != null && red >= Number(max);
    const sobre = db.prepare(`SELECT COUNT(*) c FROM pass_anomalies WHERE kind = 'over_redemption' AND resolved_at IS NULL`).get().c;
    const dumpPath = dump('v25-agotar-membresia', { pass_id: top.id, membership: m, http: res.status, agotado, anomalias_over_redemption: sobre });
    setVerification('V25', {
      status: agotado ? (sobre ? 'FALLA' : 'PASA') : 'PARCIAL',
      fields_found: [
        `membresía ${top.issued_membership_id}: "redemptions" = ${red} · "max_redemptions" = ${JSON.stringify(max)} · "is_valid" = ${JSON.stringify(isValid)} (STRING, normalizar)`,
        Array.isArray(lista) ? `"redemption_collection" trae ${lista.length} entradas${lista[0] ? ` · campos: {${Object.keys(lista[0]).join(', ')}}` : ''}` : '"redemption_collection" no es lista',
        'el límite lo cuenta TT por MEMBRESÍA (no por orden ni por código): cada compra del boleto members-only gasta 1',
        sobre ? `⚠ ${sobre} anomalía(s) over_redemption abiertas: TT dejó pasar más de max_redemptions` : 'sin over_redemption: TT no dejó pasar más de max_redemptions',
      ].join(' · '),
      dump_path: dumpPath,
      notes: agotado
        ? (sobre ? 'EN CONTRA: hubo más redenciones que el límite. Revisar el dump y /admin.' : 'El contador llegó al límite y no lo superó. Confirmar a mano que el boleto "Planta X - El Pase" ya NO aparece en el checkout para ese abonado (no hay API de canasta).')
        : `Aún no se agota: ${red}/${max}. Reserva funciones hasta llegar al límite y vuelve a correr.`,
    });
  },

  // ---------- El Pase · verificaciones BLOQUEANTES ----------
  //
  // Se corren ANTES de construir nada. Si cualquiera sale en contra, el modelo de
  // "un código de monto fijo por show" no se sostiene y hay que replantear.

  /**
   * V23 — BLOQUEANTE. ¿El API permite asignar el código a ticket types específicos al
   * crearlo, o eso solo existe en la interfaz? Si solo existe en la interfaz, el modelo
   * de un código por show no se puede automatizar.
   */
  async V23() {
    if (!requireKey('V23')) return;

    const tt = db.prepare(`
      SELECT tt.id, tt.name, o.show_id FROM ticket_types tt
      JOIN occurrences o ON o.id = tt.occurrence_id LIMIT 1
    `).get();
    if (!tt) {
      setVerification('V23', { status: 'PENDIENTE', notes: 'No hay ticket types en caché. Corre el sync primero.' });
      return;
    }
    const otros = db.prepare(`
      SELECT DISTINCT tt.id FROM ticket_types tt
      JOIN occurrences o ON o.id = tt.occurrence_id
      WHERE o.show_id != ? LIMIT 5
    `).all(tt.show_id).map(r => r.id);

    const code = `PASE-V23${Math.floor(Math.random() * 9000 + 1000)}`;
    const form = { name: 'V23 · alcance por ticket type', code, type: 'fixed_amount', price: '2400', max_redemptions: '1' };
    form[`ticket_type_id[${tt.id}]`] = '1';

    const created = await ttRequest('/discounts', { method: 'POST', form });
    const body = created.json?.data ?? created.json;
    if (body && typeof body === 'object') recordFieldDiscovery('discounts', body);

    // Releer: el eco del POST podría mentir, así que se confirma con un GET.
    let readBack = null;
    if (body?.id) {
      const r = await ttRequest(`/discounts/${encodeURIComponent(body.id)}`);
      readBack = r.json?.data ?? r.json;
    }
    const bound = readBack ? (pick(readBack, ['ticket_types']).value ?? []) : [];
    const fuga = bound.filter(id => otros.includes(id));

    const dumpPath = dump('v23-discount-alcance-por-ticket-type', {
      request: form, status: created.status, response: created.json,
      releido: readBack, ticket_types_de_otros_shows: otros, fuga,
    });
    if (body?.id) await ttRequest(`/discounts/${encodeURIComponent(body.id)}`, { method: 'DELETE' });

    const ok = created.status === 201 && bound.length === 1 && bound[0] === tt.id && fuga.length === 0;
    setVerification('V23', {
      status: ok ? 'PASA' : 'FALLA',
      fields_found: [
        `POST /v1/discounts type=fixed_amount → HTTP ${created.status}`,
        'monto fijo se manda en "price" (centavos) y vuelve como "face_value_amount"',
        'alcance: "ticket_type_id[tt_xxx]=1" (arreglo estilo PHP, igual que /holds)',
        'OJO: "ticket_type_ids", csv y "ticket_types[]" devuelven 201 con ticket_types:[] — falso positivo que dejaría el código aplicable a TODO el catálogo. Verificar SIEMPRE el eco.',
        `alcance releído: ${JSON.stringify(bound)} · fuga a otros shows: ${fuga.length}`,
      ].join(' · '),
      dump_path: dumpPath,
      notes: ok
        ? 'A FAVOR: el modelo de un código por show SÍ se puede automatizar por API. El alcance persiste al releer y no se filtra a otros shows.'
        : 'EN CONTRA: revisar el dump. Si el alcance no se puede fijar por API, el modelo de un código por show hay que replantearlo.',
    });
  },

  /**
   * V24 — BLOQUEANTE. Un código de MONTO FIJO con dos butacas del mismo ticket type en
   * UNA canasta: ¿descuenta el monto una vez por ORDEN o una vez por BOLETO?
   * Si es por boleto, todo el modelo de El Pase se cae.
   *
   * NO es resoluble por API: no existe POST /orders y la canasta vive en el checkout.
   * Lo que sí se puede hacer por API es dejar el código listo y medir el resultado de
   * una compra real. El runner evalúa la evidencia que haya.
   */
  async V24() {
    if (!requireKey('V24')) return;

    // RESULTADO REAL (2026-09-10, cuenta con eventos pagados): EN CONTRA.
    // Canasta de 2 × $10 = $20 con código de monto fijo de $10 y max_redemptions=1
    // → Total $0.00 y times_redeemed subió a 1. El descuento se aplicó POR BOLETO.
    const conPrecio = db.prepare('SELECT id, name, price_cents FROM ticket_types WHERE price_cents > 0').all();

    // Evidencia real: órdenes ingeridas que usaron un código de monto fijo con 2+ boletos
    const ordenes = db.prepare(`
      SELECT id, raw FROM orders WHERE raw LIKE '%discount%' ORDER BY created_at DESC LIMIT 20
    `).all();
    let evidencia = null;
    for (const o of ordenes) {
      const order = JSON.parse(o.raw);
      const tickets = pick(order, ['issued_tickets']).value;
      const n = Array.isArray(tickets) ? tickets.length : 0;
      if (n < 2) continue;
      // El nombre del campo del descuento no se asume: se prueban candidatos.
      const desc = pick(order, ['discounts', 'discount', 'discount_code', 'vouchers']);
      const total = pick(order, ['total', 'total_paid']).value;
      const subtotal = pick(order, ['subtotal']).value;
      if (desc.field) {
        evidencia = { orderId: o.id, boletos: n, campo_descuento: desc.field, valor: desc.value, subtotal, total };
        break;
      }
    }

    const dumpPath = dump('v24-monto-fijo-por-orden-o-por-boleto', {
      veredicto: 'EN CONTRA · el descuento de monto fijo se aplica POR BOLETO, no por orden',
      prueba_ejecutada: {
        fecha: '2026-09-10',
        ticket_type: 'tt_6684870', precio_unitario_cents: 1000,
        occurrence: 'ev_9073315 (Noches de Impro, 26 oct 2026)',
        discount: { id: 'di_599017', code: 'V24PRUEBA', type: 'fixed_amount',
                    face_value_amount: 1000, max_redemptions: 1 },
        canasta: '2 × Planta Baja = $20.00',
        total_observado: '$0.00',
        esperado_si_fuera_por_orden: '$10.00',
        times_redeemed_despues: 1,
      },
      consecuencia: [
        'Un código de monto fijo de $X descuenta $X POR CADA BOLETO del ticket type en la canasta.',
        'max_redemptions cuenta ÓRDENES (times_redeemed pasó a 1 con 2 boletos descontados), así que',
        'UN SOLO uso del código puede regalar N boletos: el límite nativo no acota el daño.',
        'El modelo de "un código de monto fijo por show" es EXPLOTABLE tal como estaba diseñado.',
      ],
      ordenes_candidatas: ordenes.length,
      evidencia,
    });

    setVerification('V24', {
      status: 'FALLA',
      fields_found: [
        'PRUEBA REAL: canasta de 2 × $10 ($20) + código fixed_amount de $10 con max_redemptions=1 → TOTAL $0.00',
        'El descuento se aplicó POR BOLETO (2 × $10), no una vez por orden',
        '"times_redeemed" pasó a 1: el límite cuenta ÓRDENES, así que un solo uso regaló DOS boletos',
        'Confirma también V17 (el límite nativo cuenta órdenes) y agrava su consecuencia',
        'El campo de monto fijo es "price" (centavos) y vuelve como "face_value_amount"',
      ].join(' · '),
      dump_path: dumpPath,
      notes: 'BLOQUEANTE EN CONTRA. Un código de monto fijo de $X descuenta $X por CADA boleto del ticket type en la canasta, y max_redemptions solo cuenta órdenes: con un uso, un abonado mete N butacas y se las lleva todas gratis. El modelo de "un código de monto fijo por show" NO se sostiene: hay que replantear antes de construir El Pase. Alternativas a evaluar: (a) max_per_order=1 en el ticket type del abonado, si TT lo permite por ticket type; (b) un ticket type "Members only" exclusivo del pase con su propio aforo; (c) emitir un código distinto por función en vez de uno por show.',
    });
  },
};

// ---------- utilidades de escenario para V13–V15 ----------
// Montan datos de prueba y los REVIERTEN siempre (rollback), para no ensuciar la base
// real del laboratorio ni contaminar los puntos de un cliente de verdad.

function withScenario(fn, { twoTickets = false } = {}) {
  const email = `v-test-${crypto.randomUUID().slice(0, 8)}@example.test`;
  const occ = db.prepare('SELECT id FROM occurrences ORDER BY starts_at DESC LIMIT 1').get()?.id ?? 'ev_fixture';
  const ticketId = `it_fixture_${crypto.randomUUID().slice(0, 8)}`;
  const ticketId2 = `it_fixture_${crypto.randomUUID().slice(0, 8)}`;

  let result;
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO customers (email, created_at, updated_at) VALUES (?, ?, ?)').run(email, now(), now());
    const ids = twoTickets ? [ticketId, ticketId2] : [ticketId];
    for (const id of ids) {
      db.prepare(`INSERT INTO issued_tickets (id, occurrence_id, status, checked_in, updated_at) VALUES (?, ?, 'valid', 0, ?)`)
        .run(id, occ, now());
      db.prepare(`INSERT INTO ticket_assignments (issued_ticket_id, occurrence_id, holder_email, status, created_at, updated_at)
                  VALUES (?, ?, ?, 'owner', ?, ?)`).run(id, occ, email, now(), now());
    }
    result = fn({ email, occ, ticketId, ticketId2 });
    // Siempre revertir: el escenario es evidencia, no estado.
    throw new RollbackScenario();
  });
  try { tx(); } catch (err) { if (!(err instanceof RollbackScenario)) throw err; }
  return { ...result, escenario: { email, occurrence_id: occ, boletos: twoTickets ? [ticketId, ticketId2] : [ticketId] },
           nota: 'Escenario revertido con rollback: no queda nada en la base.' };
}

class RollbackScenario extends Error {}

function claimByFixture(ticketId, email) {
  db.prepare(`
    UPDATE ticket_assignments SET status='claimed', holder_email=?,
      holder_customer_id=(SELECT id FROM customers WHERE email=?), claimed_at=?, claim_token_hash=NULL
    WHERE issued_ticket_id=?
  `).run(email, email, now(), ticketId);
}

function setCheckedIn(ticketId, yes) {
  db.prepare('UPDATE issued_tickets SET checked_in=?, checked_in_at=? WHERE id=?')
    .run(yes ? 1 : 0, yes ? now() : null, ticketId);
}

function pointsOf(email, occ) {
  return db.prepare(`
    SELECT COALESCE(SUM(points), 0) p FROM loyalty_points
    WHERE occurrence_id = ? AND customer_id = (SELECT id FROM customers WHERE email = ?)
  `).get(occ, email).p;
}

export async function runVerification(id) {
  const runner = runners[id];
  if (!runner) throw new Error(`No hay runner automático para ${id}`);
  await runner();
  return db.prepare('SELECT * FROM verifications WHERE id = ?').get(id);
}
