import { db, now, recordFieldDiscovery } from './db.js';
import { ttRequest, ttListAll, dump, pick, hasApiKey } from './ttClient.js';
import { seatLabel } from './seat.js';

/**
 * EL PASE — pase de temporada de Teatro Breve, sobre MEMBRESÍAS nativas de TT.
 *
 * Por qué membresías y no códigos de descuento (verificado 2026-09-10, cuenta con
 * eventos pagados): V24 demostró que un código de monto fijo se aplica POR BOLETO
 * (2 × $10 con código de $10 → total $0.00) y que max_redemptions cuenta ÓRDENES.
 * Un solo uso regalaba N boletos. V18 demostró que un ticket type con
 * status "members_only" y type "Seated" conviven: el abonado ve un boleto a $0,
 * escoge butaca real, y max_per_order=1 se fija SOLO en ese ticket type sin tocar
 * las compras regulares.
 *
 * Cómo se hace cumplir: lo hace TICKET TAILOR, no esta base.
 *   - El producto (pr_xxx) tiene fulfilment "Issue a membership": al comprarlo, TT
 *     emite la membresía sola.
 *   - El ticket type del pase solo aparece en el checkout si el comprador tiene esa
 *     membresía; cada compra a $0 gasta una redención; al llegar a max_redemptions
 *     el boleto deja de aparecer (V25 lo confirma).
 *   - TT lleva el contador: issued_membership.redemptions.
 *
 * ESTA BASE ES ESPEJO, NO GUARDIA. Cuenta para mostrar el saldo en el perfil y para
 * detectar lo que no debería pasar (pass_anomalies, ruidoso en /admin). Nunca
 * "arregla" nada en silencio.
 *
 * Restricción aceptada: el pago y la butaca ocurren en el checkout de TT (no hay
 * POST /orders). Se embebe en un modal del sitio; con el custom domain el checkout
 * entero se queda en el modal.
 *
 * Nombres de campos del API: NUNCA asumidos. pick() con candidatos + field_discovery
 * + dump. Ojo: is_valid llega como STRING "true"/"false" (igual que checked_in).
 */

const C = {
  // issued_membership
  imId: ['id'],
  imCode: ['code', 'membership_code', 'reference'],
  imEmail: ['email', 'buyer_email'],
  imTypeId: ['membership_type_id', 'membership_type.id'],
  imRedemptions: ['redemptions', 'times_redeemed', 'redemptions_count'],
  imMax: ['max_redemptions', 'redemption_limit'],
  imValidFrom: ['valid_from.iso', 'valid_from.date', 'valid_from', 'issue_date.iso'],
  imValidTo: ['valid_to.iso', 'valid_to.date', 'valid_to', 'expires.iso'],
  imVoided: ['voided_at', 'voided', 'cancelled_at'],
  imIsValid: ['is_valid', 'valid', 'status'],
  imRedemptionList: ['redemption_collection', 'redemptions_list', 'redemption_history'],
  // orden
  lineItems: ['line_items', 'items'],
  lineItemId: ['item_id', 'product_id', 'id'],
  lineQty: ['quantity', 'qty'],
  soldProducts: ['sold_products', 'products'],
  orderTotal: ['total', 'total_paid', 'subtotal'],
  buyerEmail: ['buyer_details.email', 'email'],
  tickets: ['issued_tickets', 'tickets'],
  ticketTypeId: ['ticket_type_id', 'ticket_type.id'],
  ticketEvent: ['event_id', 'event.id'],
  ticketStatus: ['status', 'state'],
};

function truthy(v) { return v === true || v === 'true' || v === 1 || v === '1'; }
function str(v) { return v == null ? null : (typeof v === 'string' ? v : JSON.stringify(v)); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

// ---------- catálogo: pass_products ----------

export function listPassProducts({ onlyActive = false } = {}) {
  return db.prepare(`SELECT * FROM pass_products ${onlyActive ? 'WHERE active = 1' : ''} ORDER BY created_at`).all();
}

export function getPassProduct(id) {
  return db.prepare('SELECT * FROM pass_products WHERE id = ?').get(String(id)) ?? null;
}

/**
 * Alta/edición de un pass_product. Valida contra TT y contra la caché ANTES de
 * guardar, y falla ruidoso: un pase mal apuntado no se puede vender.
 * Devuelve { ok, product, errors[], warnings[], dumpPath }.
 */
export async function upsertPassProduct(input) {
  const errors = [];
  const warnings = [];
  const id = String(input.id ?? '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  if (!id) errors.push('id (slug) requerido');
  if (!input.name) errors.push('name requerido');
  if (!['baja', 'alta'].includes(String(input.planta ?? '').toLowerCase())) errors.push('planta debe ser "baja" o "alta"');
  for (const k of ['tt_product_id', 'membership_type_id', 'ticket_type_id']) {
    if (!input[k]) errors.push(`${k} requerido`);
  }
  if (errors.length) return { ok: false, errors, warnings };

  if (!hasApiKey()) return { ok: false, errors: ['Sin TICKET_TAILOR_API_KEY'], warnings };

  // 1) Existen en TT (y se vuelcan tal cual)
  const [prod, mt] = await Promise.all([
    ttRequest(`/products/${encodeURIComponent(input.tt_product_id)}`),
    ttRequest(`/membership_types/${encodeURIComponent(input.membership_type_id)}`),
  ]);
  const product = prod.json?.data ?? prod.json;
  const mtype = mt.json?.data ?? mt.json;
  if (prod.status !== 200) errors.push(`producto ${input.tt_product_id}: HTTP ${prod.status} en TT`);
  if (mt.status !== 200) errors.push(`membership type ${input.membership_type_id}: HTTP ${mt.status} en TT`);
  if (product) recordFieldDiscovery('products', product);
  if (mtype) recordFieldDiscovery('membership_types', mtype);

  // 2) El producto de verdad emite ESA membresía al comprarse
  if (product) {
    const ful = String(pick(product, ['fulfilment_type', 'fulfillment_type']).value ?? '');
    const ref = String(pick(product, ['fulfilment_reference_id', 'fulfillment_reference_id']).value ?? '');
    if (!/membership/i.test(ful)) {
      errors.push(`el producto no emite membresía: fulfilment_type = "${ful}". Ponle "Issue a membership" en el dashboard.`);
    } else if (ref && !String(input.membership_type_id).endsWith(ref)) {
      errors.push(`el producto emite el membership type "${ref}", no "${input.membership_type_id}"`);
    }
  }

  // 3) El ticket type existe en caché, es members_only y sabemos su serie
  const ttRow = db.prepare(`
    SELECT tt.id, tt.raw, o.show_id FROM ticket_types tt
    JOIN occurrences o ON o.id = tt.occurrence_id WHERE tt.id = ? LIMIT 1
  `).get(String(input.ticket_type_id));
  let showId = null;
  if (!ttRow) {
    errors.push(`ticket type ${input.ticket_type_id} no está en caché (corre el sync)`);
  } else {
    showId = ttRow.show_id;
    const raw = JSON.parse(ttRow.raw);
    const status = String(pick(raw, ['status']).value ?? '');
    const price = num(pick(raw, ['price']).value);
    const mpo = num(pick(raw, ['max_per_order']).value);
    if (!/member/i.test(status)) errors.push(`el ticket type ${input.ticket_type_id} no es "Members only" (status = "${status}")`);
    if (price !== 0) errors.push(`el ticket type del pase debe costar $0 (tiene ${price})`);
    if (mpo !== 1) warnings.push(`max_per_order del ticket type es ${mpo}, no 1: un abonado podría meter varias butacas en una canasta (ver V24)`);
  }

  if (!input.store_url) warnings.push('store_url vacío: el botón "Comprar El Pase" del perfil no tendrá a dónde ir');

  const maxRed = num(pick(mtype ?? {}, ['max_redemptions']).value);
  const seasonEnd = pick(mtype ?? {}, ['valid_to_date.iso', 'valid_to_date', 'valid_to.iso']).value ?? input.season_end ?? null;
  if (maxRed == null) warnings.push('el membership type no tiene max_redemptions: el pase sería ilimitado');
  if (!seasonEnd) warnings.push('el membership type no tiene fecha fija de vencimiento (valid_to_type debería ser "fixed")');

  const dumpPath = dump(`pase-producto-${id}`, { input, product, membership_type: mtype, ticket_type: ttRow ? JSON.parse(ttRow.raw) : null, errors, warnings });
  if (errors.length) return { ok: false, errors, warnings, dumpPath };

  const priceCents = num(pick(product, ['price']).value);
  db.prepare(`
    INSERT INTO pass_products
      (id, name, planta, tt_product_id, membership_type_id, ticket_type_id, show_id, price_cents,
       max_redemptions, season_end, store_url, active, raw, created_at, updated_at)
    VALUES (@id, @name, @planta, @pr, @mt, @tt, @show, @price, @max, @end, @store, @active, @raw, @ts, @ts)
    ON CONFLICT(id) DO UPDATE SET
      name=@name, planta=@planta, tt_product_id=@pr, membership_type_id=@mt, ticket_type_id=@tt,
      show_id=@show, price_cents=@price, max_redemptions=@max, season_end=@end,
      store_url=COALESCE(@store, store_url), active=@active, raw=@raw, updated_at=@ts
  `).run({
    id, name: String(input.name), planta: String(input.planta).toLowerCase(),
    pr: String(input.tt_product_id), mt: String(input.membership_type_id), tt: String(input.ticket_type_id),
    show: showId, price: priceCents, max: maxRed, end: seasonEnd ? String(seasonEnd) : null,
    store: input.store_url ? String(input.store_url) : null,
    active: input.active === false || input.active === 0 ? 0 : 1,
    raw: JSON.stringify({ product, membership_type: mtype, ticket_type: ttRow ? JSON.parse(ttRow.raw) : null }),
    ts: now(),
  });
  return { ok: true, product: getPassProduct(id), errors, warnings, dumpPath };
}

// ---------- compra del pase (desde la orden) ----------

/** ¿La orden contiene el producto de algún pase? Devuelve el pass_product o null. */
export function passProductInOrder(order) {
  const products = listPassProducts({ onlyActive: false });
  if (!products.length) return null;
  const byTtId = new Map(products.map(p => [String(p.tt_product_id), p]));
  const byName = new Map(products.map(p => [p.name.toLowerCase(), p]));

  const items = pick(order, C.lineItems).value;
  if (Array.isArray(items)) {
    for (const li of items) {
      recordFieldDiscovery('line_items', li);
      const itemId = String(pick(li, C.lineItemId).value ?? '');
      if (byTtId.has(itemId)) return byTtId.get(itemId);
      const descr = String(pick(li, ['description', 'name']).value ?? '').toLowerCase();
      if (descr && byName.has(descr)) return byName.get(descr);
    }
  }
  const sold = pick(order, C.soldProducts).value;
  if (Array.isArray(sold)) {
    for (const sp of sold) {
      recordFieldDiscovery('sold_products', sp);
      const pid = String(pick(sp, ['product_id', 'id', 'item_id']).value ?? '');
      if (byTtId.has(pid)) return byTtId.get(pid);
    }
  }
  return null;
}

/**
 * Registra la compra de un pase y trata de localizar la membresía que TT emitió.
 * Idempotente por (customer, product, order). Si la membresía aún no existe queda
 * 'pending' y se reintenta en cada ciclo del sync — nunca se deja al abonado sin
 * pase en silencio.
 */
export async function registerPassPurchase({ order, product, email }) {
  const normalized = String(email ?? '').toLowerCase();
  if (!normalized) return { ok: false, error: 'orden sin correo de comprador' };
  db.prepare(`INSERT INTO customers (email, created_at, updated_at) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING`)
    .run(normalized, now(), now());
  const customer = db.prepare('SELECT id FROM customers WHERE email = ?').get(normalized);
  const orderId = order?.id != null ? String(order.id) : null;

  let pass = db.prepare(`
    SELECT * FROM season_passes WHERE pass_product_id = ? AND customer_id = ? AND (order_id = ? OR order_id IS NULL)
    ORDER BY created_at DESC LIMIT 1
  `).get(product.id, customer.id, orderId);

  if (!pass) {
    db.prepare(`
      INSERT INTO season_passes (customer_id, pass_product_id, order_id, status, max_redemptions, valid_to, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)
    `).run(customer.id, product.id, orderId, product.max_redemptions, product.season_end, now(), now());
    pass = db.prepare('SELECT * FROM season_passes WHERE id = last_insert_rowid()').get();
    console.log(`[pase] compra registrada: ${product.name} para ${normalized} (orden ${orderId ?? '—'})`);
  } else if (orderId && !pass.order_id) {
    db.prepare('UPDATE season_passes SET order_id = ?, updated_at = ? WHERE id = ?').run(orderId, now(), pass.id);
  }

  const located = await locateMembership(pass.id);
  return { ok: true, passId: pass.id, located: located.ok, pending: !located.ok };
}

/**
 * Busca en TT la membresía de este pase. GET /issued_memberships IGNORA los filtros
 * (verificado: ?email= y ?membership_type_id= devuelven la lista completa), así que
 * se lista todo y se cruza aquí por correo + tipo.
 */
export async function locateMembership(passId) {
  const pass = db.prepare(`
    SELECT sp.*, c.email, pp.membership_type_id FROM season_passes sp
    JOIN customers c ON c.id = sp.customer_id
    JOIN pass_products pp ON pp.id = sp.pass_product_id WHERE sp.id = ?
  `).get(passId);
  if (!pass) return { ok: false, error: 'pase no encontrado' };
  if (!hasApiKey()) return { ok: false, error: 'sin API key' };

  const all = await ttListAll('/issued_memberships');
  all.items.forEach(m => recordFieldDiscovery('issued_memberships', m));
  const matches = all.items.filter(m =>
    String(pick(m, C.imEmail).value ?? '').toLowerCase() === pass.email &&
    String(pick(m, C.imTypeId).value ?? '') === String(pass.membership_type_id) &&
    pick(m, C.imVoided).value == null
  );
  // La más reciente gana (si compró dos veces, la última es la vigente)
  matches.sort((a, b) => (num(pick(b, ['issue_date.unix']).value) ?? 0) - (num(pick(a, ['issue_date.unix']).value) ?? 0));
  const m = matches[0];

  if (!m) {
    // Pendiente: TT puede emitir la membresía segundos después de la orden. Si lleva
    // demasiado tiempo así, es anomalía (visible en /admin), no silencio.
    const ageMin = (Date.now() - new Date(pass.created_at).getTime()) / 60000;
    if (ageMin > 10) recordAnomaly(pass.id, 'membership_not_found', {
      email: pass.email, membership_type_id: pass.membership_type_id, order_id: pass.order_id,
      minutos_pendiente: Math.round(ageMin), memberships_en_tt: all.items.length,
    });
    return { ok: false, pending: true };
  }

  const dumpPath = dump(`pase-membresia-${pick(m, C.imId).value}`, { pass_id: pass.id, email: pass.email, membership: m });
  applyMembershipState(pass.id, m, { dumpPath });
  return { ok: true, membershipId: pick(m, C.imId).value };
}

/**
 * Vuelca el estado real de la membresía (TT es la fuente) sobre el pase y deriva
 * el status. Detecta anomalías sin bloquear nada.
 */
export function applyMembershipState(passId, m, { dumpPath } = {}) {
  const pass = db.prepare('SELECT * FROM season_passes WHERE id = ?').get(passId);
  if (!pass) return;
  recordFieldDiscovery('issued_memberships', m);
  const list = pick(m, C.imRedemptionList).value;
  if (Array.isArray(list)) list.forEach(r => r && typeof r === 'object' && recordFieldDiscovery('membership_redemptions', r));

  const redemptions = num(pick(m, C.imRedemptions).value) ?? 0;
  const maxRed = num(pick(m, C.imMax).value) ?? pass.max_redemptions ?? null;
  const validTo = str(pick(m, C.imValidTo).value) ?? pass.valid_to;
  const voided = pick(m, C.imVoided).value != null;
  const isValidRaw = pick(m, C.imIsValid).value;
  const isValid = isValidRaw == null ? true : truthy(isValidRaw);
  const expired = validTo ? new Date(validTo) < new Date() : false;

  let status = 'active';
  if (voided) status = 'voided';
  else if (expired) status = 'expired';
  else if (maxRed != null && redemptions >= maxRed) status = 'exhausted';
  else if (!isValid) status = 'expired';

  const prevRed = pass.redemptions ?? 0;
  db.prepare(`
    UPDATE season_passes SET
      issued_membership_id = COALESCE(?, issued_membership_id), membership_code = COALESCE(?, membership_code),
      status = ?, redemptions = ?, max_redemptions = ?, valid_from = COALESCE(?, valid_from), valid_to = ?,
      last_synced_at = ?, raw = ?, updated_at = ?
    WHERE id = ?
  `).run(
    str(pick(m, C.imId).value), str(pick(m, C.imCode).value), status, redemptions, maxRed,
    str(pick(m, C.imValidFrom).value), validTo, now(), JSON.stringify(m), now(), passId,
  );

  if (maxRed != null && redemptions > maxRed) {
    recordAnomaly(passId, 'over_redemption', { redemptions, max_redemptions: maxRed, dump: dumpPath });
  }
  // Nuestro espejo vs el contador de TT: si nosotros vimos MÁS órdenes de redención
  // que las que TT cuenta, algo se coló sin gastar membresía.
  const local = db.prepare('SELECT COALESCE(SUM(tickets_count), 0) n FROM pass_redemptions WHERE season_pass_id = ?').get(passId).n;
  if (local > redemptions) {
    recordAnomaly(passId, 'counter_mismatch', { redenciones_locales: local, redemptions_en_tt: redemptions, dump: dumpPath });
  }
  // Cruce ORDEN POR ORDEN: TT lista cada redención con "linked_order_id" (descubierto en
  // la primera redención real, or_82725048). Si TT tiene una orden que nosotros no vimos,
  // se nos perdió un webhook: se importa al espejo y se avisa. Nunca al revés en silencio.
  if (Array.isArray(list)) {
    const ttOrders = list.map(r => str(pick(r, ['linked_order_id', 'order_id']).value)).filter(Boolean);
    const localOrders = new Set(db.prepare('SELECT order_id FROM pass_redemptions WHERE season_pass_id = ?').all(passId).map(r => r.order_id));
    const missing = ttOrders.filter(o => !localOrders.has(o));
    for (const orderId of missing) {
      const occ = db.prepare('SELECT occurrence_id FROM orders WHERE id = ?').get(orderId)?.occurrence_id ?? null;
      db.prepare(`INSERT OR IGNORE INTO pass_redemptions (season_pass_id, order_id, occurrence_id, tickets_count, redeemed_at) VALUES (?, ?, ?, 1, ?)`)
        .run(passId, orderId, occ, now());
    }
    if (missing.length) recordAnomaly(passId, 'redemption_missing_locally', { ordenes_en_tt_sin_espejo: missing, importadas: true, dump: dumpPath });
  }
  if (redemptions !== prevRed || status !== pass.status) {
    console.log(`[pase] #${passId} → ${status} · ${redemptions}/${maxRed ?? '∞'} redenciones`);
  }
}

/** Relee una membresía por id (1 llamada). Dump solo si cambió algo. */
export async function refreshPass(passId) {
  const pass = db.prepare('SELECT * FROM season_passes WHERE id = ?').get(passId);
  if (!pass || !hasApiKey()) return { ok: false };
  if (!pass.issued_membership_id) return locateMembership(passId);
  const res = await ttRequest(`/issued_memberships/${encodeURIComponent(pass.issued_membership_id)}`);
  if (res.status !== 200) {
    recordAnomaly(passId, 'membership_unreadable', { issued_membership_id: pass.issued_membership_id, http: res.status });
    return { ok: false, status: res.status };
  }
  const m = res.json?.data ?? res.json;
  const changed = JSON.stringify(m) !== pass.raw;
  const dumpPath = changed ? dump(`pase-membresia-${pass.issued_membership_id}`, { pass_id: passId, membership: m }) : null;
  applyMembershipState(passId, m, { dumpPath });
  return { ok: true, changed };
}

/**
 * Ciclo del sync: pendientes → localizar; activos/agotados → releer contador;
 * vencidos por fecha → 'expired'. Una llamada por pase por tick (presupuesto ok).
 */
export async function refreshAllPasses() {
  if (!hasApiKey()) return { refreshed: 0 };
  const rows = db.prepare(`SELECT id, status, valid_to FROM season_passes WHERE status IN ('pending','active','exhausted')`).all();
  let n = 0;
  for (const r of rows) {
    try {
      if (r.valid_to && new Date(r.valid_to) < new Date() && r.status !== 'pending') {
        db.prepare(`UPDATE season_passes SET status='expired', updated_at=? WHERE id=?`).run(now(), r.id);
        continue;
      }
      await refreshPass(r.id);
      n++;
    } catch (err) {
      console.error(`[pase] refresh #${r.id}:`, err.message);
    }
  }
  return { refreshed: n };
}

/** Payload del webhook ISSUED_MEMBERSHIP.CREATED/UPDATED. */
export async function ingestMembershipWebhook(m) {
  if (!m || typeof m !== 'object') return;
  recordFieldDiscovery('webhook_issued_membership', m);
  const imId = str(pick(m, C.imId).value);
  const email = String(pick(m, C.imEmail).value ?? '').toLowerCase();
  const typeId = str(pick(m, C.imTypeId).value);
  const product = listPassProducts().find(p => String(p.membership_type_id) === typeId);
  if (!product) return; // membresía de otro tipo: no es un pase

  let pass = imId ? db.prepare('SELECT * FROM season_passes WHERE issued_membership_id = ?').get(imId) : null;
  if (!pass && email) {
    pass = db.prepare(`
      SELECT sp.* FROM season_passes sp JOIN customers c ON c.id = sp.customer_id
      WHERE sp.pass_product_id = ? AND c.email = ? AND sp.issued_membership_id IS NULL
      ORDER BY sp.created_at DESC LIMIT 1
    `).get(product.id, email);
  }
  if (!pass && email) {
    // Membresía emitida desde el dashboard (sin orden por medio): también es un pase.
    db.prepare(`INSERT INTO customers (email, created_at, updated_at) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING`).run(email, now(), now());
    const customer = db.prepare('SELECT id FROM customers WHERE email = ?').get(email);
    db.prepare(`
      INSERT INTO season_passes (customer_id, pass_product_id, status, max_redemptions, valid_to, created_at, updated_at)
      VALUES (?, ?, 'pending', ?, ?, ?, ?)
    `).run(customer.id, product.id, product.max_redemptions, product.season_end, now(), now());
    pass = db.prepare('SELECT * FROM season_passes WHERE id = last_insert_rowid()').get();
    console.log(`[pase] membresía emitida sin orden (dashboard) → pase #${pass.id} para ${email}`);
  }
  if (!pass) return;
  const dumpPath = dump(`pase-membresia-webhook-${imId ?? 'sin-id'}`, { pass_id: pass.id, membership: m });
  applyMembershipState(pass.id, m, { dumpPath });
}

// ---------- redención (orden a $0 con el ticket type del pase) ----------

export async function recordPassRedemption(order) {
  const products = listPassProducts();
  if (!products.length) return null;
  const byTT = new Map(products.map(p => [String(p.ticket_type_id), p]));
  const tickets = pick(order, C.tickets).value;
  if (!Array.isArray(tickets)) return null;

  const used = tickets.filter(t => byTT.has(String(pick(t, C.ticketTypeId).value ?? '')));
  if (!used.length) return null;

  const email = String(pick(order, C.buyerEmail).value ?? '').toLowerCase();
  const orderId = String(order.id ?? '');
  const cancelled = /cancel|refund|void/i.test(String(pick(order, C.ticketStatus).value ?? ''));
  const product = byTT.get(String(pick(used[0], C.ticketTypeId).value));
  const occurrenceId = str(pick(used[0], C.ticketEvent).value) ?? str(pick(order, ['event_summary.id', 'event_id']).value);

  let pass = db.prepare(`
    SELECT sp.* FROM season_passes sp JOIN customers c ON c.id = sp.customer_id
    WHERE sp.pass_product_id = ? AND c.email = ? ORDER BY sp.created_at DESC LIMIT 1
  `).get(product.id, email);

  if (!pass) {
    // Alguien compró el boleto "members only" y no tenemos su pase: puede ser una
    // membresía emitida a mano en el dashboard que aún no vimos. Se registra y se
    // intenta importar; si no aparece, queda como anomalía visible.
    recordAnomaly(null, 'redemption_without_pass', { order_id: orderId, email, ticket_type_id: product.ticket_type_id, product: product.id });
    await ingestMembershipWebhook({ email, membership_type_id: product.membership_type_id });
    pass = db.prepare(`
      SELECT sp.* FROM season_passes sp JOIN customers c ON c.id = sp.customer_id
      WHERE sp.pass_product_id = ? AND c.email = ? ORDER BY sp.created_at DESC LIMIT 1
    `).get(product.id, email);
    if (pass) await locateMembership(pass.id);
    if (!pass) return null;
  }

  const live = used.filter(t => !/void|cancel|refund/i.test(String(pick(t, C.ticketStatus).value ?? '')));
  if (cancelled || live.length === 0) {
    const del = db.prepare('DELETE FROM pass_redemptions WHERE season_pass_id = ? AND order_id = ?').run(pass.id, orderId);
    if (del.changes) console.log(`[pase] orden ${orderId} cancelada → redención retirada del espejo`);
  } else {
    db.prepare(`
      INSERT INTO pass_redemptions (season_pass_id, order_id, occurrence_id, issued_ticket_id, tickets_count, redeemed_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(season_pass_id, order_id) DO UPDATE SET tickets_count = excluded.tickets_count, occurrence_id = excluded.occurrence_id
    `).run(pass.id, orderId, occurrenceId, str(live[0].id), live.length, now());

    // Anomalías que NO deberían poder pasar (max_per_order=1, precio $0)
    if (live.length > 1) recordAnomaly(pass.id, 'multi_ticket_redemption', { order_id: orderId, boletos: live.length });
    const total = num(pick(order, C.orderTotal).value);
    if (total != null && total !== 0) recordAnomaly(pass.id, 'redemption_not_free', { order_id: orderId, total });
  }

  // TT es la fuente del contador: releer y comparar con nuestro espejo
  await refreshPass(pass.id);
  return { passId: pass.id, orderId, tickets: live.length };
}

// ---------- anomalías ----------

export function recordAnomaly(passId, kind, detail) {
  // Una anomalía abierta por (pase, tipo): no se duplica en cada tick
  const open = db.prepare('SELECT id FROM pass_anomalies WHERE season_pass_id IS ? AND kind = ? AND resolved_at IS NULL').get(passId, kind);
  if (open) {
    db.prepare('UPDATE pass_anomalies SET detail = ?, detected_at = ? WHERE id = ?').run(JSON.stringify(detail ?? {}), now(), open.id);
    return open.id;
  }
  const r = db.prepare('INSERT INTO pass_anomalies (season_pass_id, kind, detail, detected_at) VALUES (?, ?, ?, ?)')
    .run(passId, kind, JSON.stringify(detail ?? {}), now());
  console.warn(`[pase] ⚠ ANOMALÍA ${kind} (pase #${passId ?? '—'}): ${JSON.stringify(detail)}`);
  return r.lastInsertRowid;
}

export function listAnomalies({ includeResolved = false } = {}) {
  return db.prepare(`
    SELECT a.*, c.email FROM pass_anomalies a
    LEFT JOIN season_passes sp ON sp.id = a.season_pass_id
    LEFT JOIN customers c ON c.id = sp.customer_id
    ${includeResolved ? '' : 'WHERE a.resolved_at IS NULL'} ORDER BY a.detected_at DESC
  `).all().map(a => ({ ...a, detail: safeJson(a.detail) }));
}

export function resolveAnomaly(id) {
  db.prepare('UPDATE pass_anomalies SET resolved_at = ? WHERE id = ?').run(now(), Number(id));
}

// ---------- admin ----------

export function listPasses() {
  return db.prepare(`
    SELECT sp.*, c.email, c.name AS customer_name, pp.name AS product_name, pp.planta,
           (SELECT COUNT(*) FROM pass_anomalies a WHERE a.season_pass_id = sp.id AND a.resolved_at IS NULL) AS anomalias
    FROM season_passes sp
    LEFT JOIN customers c ON c.id = sp.customer_id
    LEFT JOIN pass_products pp ON pp.id = sp.pass_product_id
    ORDER BY sp.created_at DESC
  `).all().map(p => ({ ...p, raw: undefined, remaining: p.max_redemptions != null ? Math.max(0, p.max_redemptions - (p.redemptions ?? 0)) : null }));
}

// ---------- perfil: "Mi Pase" ----------

export function getPassForCustomer(email) {
  const normalized = String(email ?? '').toLowerCase();
  const customer = db.prepare('SELECT id FROM customers WHERE email = ?').get(normalized);
  const buyable = listPassProducts({ onlyActive: true }).map(p => ({
    id: p.id, name: p.name, planta: p.planta, priceCents: p.price_cents,
    maxRedemptions: p.max_redemptions, seasonEnd: p.season_end, storeUrl: p.store_url,
  }));
  if (!customer) return { pass: null, buyable };

  const pass = db.prepare(`
    SELECT sp.*, pp.name AS product_name, pp.planta, pp.show_id, pp.ticket_type_id, pp.season_end AS product_season_end
    FROM season_passes sp JOIN pass_products pp ON pp.id = sp.pass_product_id
    WHERE sp.customer_id = ? ORDER BY sp.created_at DESC LIMIT 1
  `).get(customer.id);
  if (!pass) return { pass: null, buyable };

  const maxRed = pass.max_redemptions;
  const remaining = maxRed != null ? Math.max(0, maxRed - (pass.redemptions ?? 0)) : null;
  const canRedeem = pass.status === 'active' && (remaining == null || remaining > 0);

  const redeemedOcc = new Set(db.prepare('SELECT occurrence_id FROM pass_redemptions WHERE season_pass_id = ?').all(pass.id).map(r => r.occurrence_id).filter(Boolean));

  const eligible = db.prepare(`
    SELECT o.id, o.starts_at, o.checkout_url, s.name AS show_name
    FROM occurrences o LEFT JOIN shows s ON s.id = o.show_id
    WHERE o.show_id = ? AND o.starts_at > ? ORDER BY o.starts_at
  `).all(pass.show_id, now()).map(o => ({
    id: o.id, show: o.show_name, startsAt: o.starts_at, checkoutUrl: o.checkout_url,
    alreadyRedeemed: redeemedOcc.has(o.id),
  }));

  const history = db.prepare(`
    SELECT r.*, o.starts_at, s.name AS show_name,
           it.seat_section, it.seat_row, it.seat_number, it.description AS ticket_description
    FROM pass_redemptions r
    LEFT JOIN occurrences o ON o.id = r.occurrence_id LEFT JOIN shows s ON s.id = o.show_id
    LEFT JOIN issued_tickets it ON it.id = r.issued_ticket_id
    WHERE r.season_pass_id = ? ORDER BY r.redeemed_at DESC
  `).all(pass.id).map(r => ({
    orderId: r.order_id, show: r.show_name, startsAt: r.starts_at, tickets: r.tickets_count, at: r.redeemed_at,
    ticketId: r.issued_ticket_id,
    seat: seatLabel({ section: r.seat_section, row: r.seat_row, number: r.seat_number }),
  }));

  return {
    buyable,
    pass: {
      id: pass.id,
      name: pass.product_name,
      planta: pass.planta,
      status: pass.status,
      pending: pass.status === 'pending',
      code: pass.membership_code,
      redemptions: pass.redemptions ?? 0,
      maxRedemptions: maxRed,
      remaining,
      canRedeem,
      validFrom: pass.valid_from,
      validTo: pass.valid_to ?? pass.product_season_end,
      lastSyncedAt: pass.last_synced_at,
      eligible,
      history,
    },
  };
}

function safeJson(s) { try { return JSON.parse(s); } catch { return s; } }
