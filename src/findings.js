import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';

/**
 * Genera FINDINGS.md desde el estado real de la DB:
 * tabla de las 12 verificaciones, campos literales descubiertos por recurso,
 * latencias webhook/sync → agotado, y riesgos (FALLA/PARCIAL).
 * Correr con: npm run findings
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const verifications = db.prepare('SELECT * FROM verifications ORDER BY CAST(substr(id, 2) AS INTEGER)').all();
const discovery = db.prepare('SELECT * FROM field_discovery ORDER BY resource, field').all();
const transitions = db.prepare('SELECT * FROM soldout_transitions ORDER BY detected_at').all();
const webhooks = db.prepare('SELECT event_type, COUNT(*) c FROM webhook_log GROUP BY event_type').all();

const lines = [];
lines.push('# FINDINGS · tb-ticketing-lab');
lines.push('');
lines.push(`Generado: ${new Date().toISOString()}`);
lines.push('');
lines.push('Este documento decide la arquitectura del proyecto real. Cada veredicto PASA está respaldado por un dump JSON crudo en /dumps.');
lines.push('');

lines.push('## Hechos clave para la arquitectura (verificados contra el API real)');
lines.push('');
lines.push('Cada hecho está respaldado por dumps en /dumps y por el código del laboratorio:');
lines.push('');
lines.push('1. **Autenticación y límites.** HTTP Basic (API key como usuario, password vacío). Rate limit real observado: **10,000 req** por ventana (header `x-rate-limit-limit`), con `x-rate-limit-remaining` y `x-rate-limit-reset` en cada respuesta.');
lines.push('2. **Modelo de catálogo.** Serie recurrente = `event_series`; cada función = `event` ligado por `event_series_id`. Fechas como objeto: `start.iso` / `end.iso` (con timezone), más `date`, `time`, `formatted` y `unix`.');
lines.push('3. **Aforo (semántica de contadores del ticket_type).** `quantity_total` = aforo, `quantity_issued` = vendidos, `quantity_held` = en hold, `quantity_in_baskets` = en carritos activos, y `quantity` = total − vendidos − carritos (NO descuenta holds). **No hay campo de "restantes"**: vendibles = `quantity_total − quantity_issued − quantity_held − quantity_in_baskets`. Los carritos expiran solos: un agotado "por baskets" puede revertir en minutos — el checkout de TT es la fuente de verdad final.');
lines.push('4. **No hay estado explícito de agotado.** Un ticket_type con todo vendido sigue reportando `status: "on_sale"`. El "Agotado" del sitio SIEMPRE será un cálculo propio sobre los contadores.');
lines.push('5. **Firma de webhooks (verificada con código).** Header `tickettailor-webhook-signature`, formato `t=<unix>,v1=<hex>`. Algoritmo: **HMAC-SHA256(secret, timestamp + body concatenados SIN separador)** — no es el formato estilo Stripe con punto. El signing secret solo se muestra al crear el webhook en el dashboard.');
lines.push('6. **Tipos de webhook disponibles** (selector del dashboard): ORDER.CREATED/UPDATED, ISSUED_TICKET.CREATED/UPDATED, ISSUED_MEMBERSHIP.CREATED/UPDATED, EVENT.CREATED/UPDATED/DELETED, WAITLIST_SIGNUP.CREATED. **No existe webhook propio de refund ni de check-in**: reembolsos deben llegar como ORDER.UPDATED (pendiente de confirmar) y check-ins se leen por polling.');
lines.push('7. **PII del comprador.** `buyer_details` en la orden trae `{email, first_name, last_name, name, phone, address{...}, custom_questions}`. La base de clientes por email se reconstruye sin problema desde `GET /v1/orders` (paginado con `starting_after`).');
lines.push('8. **Check-in por API.** Existe `GET /v1/check_ins` (HTTP 200) y cada issued_ticket trae `checked_in` (+ `voided_at`). El dato "asistió / no asistió" es alcanzable.');
lines.push('9. **Holds.** `POST /v1/holds` con body form-encoded `event_id` + `ticket_type_id[tt_xxx]=cantidad` (arreglo estilo PHP; el mensaje de error de validación documenta el formato). Efecto: sube `quantity_held` y `event.total_holds`. OJO: TT permite reducir aforo por debajo de lo ya comprometido (vimos remaining = −1).');
lines.push('10. **Redirect post-compra.** Se configura POR EVENTO (Edit event → Advanced settings → "Redirect order confirmation page"). Llegan `tt_order_id`, `tt_order_value`, `tt_currency`, `tt_event_id`. **Los IDs llegan SIN prefijo** (`81118285`, no `or_81118285`): hay que anteponer `or_`/`ev_` para consultar el API. `tt_order_value` llegó "0" en compra gratis; la doc oficial muestra decimales ("36.53"), no centavos — confirmar con compra pagada.');
lines.push('11. **Checkout embebido en modal — RESUELTO: requiere custom domain.** El widget oficial (`.tt-widget` con widget.js) corre la selección de boletos en el modal, pero el paso de checkout depende de cookies de sesión. Con el widget en un dominio ajeno (iframe third-party), los navegadores que bloquean cookies de terceros fuerzan el fallback documentado de TT: "Checkout has opened in a new tab" (preserva promo codes y ofrece botón de regreso). Verificado en el lab con captura de postMessages: el iframe NO emite ningún mensaje al padre — decide solo. **La solución oficial de TT es un custom domain en el box office (feature de pago): `tickets.teatrobreve.com` hace las cookies first-party y el checkout completo se queda en el modal.** Es exactamente la configuración del sitio de referencia que sí funciona (oztickets.studio38.club). Confirmar en Fase 0 con la cuenta del cliente.');
lines.push('12. **Limitación de la cuenta de prueba.** Solo permite eventos gratis (`price: 0`) — los montos 2400/1800 y `tt_order_value` con decimales se confirman en la cuenta pagada del cliente. El campo de precio por categoría (`price`, centavos) está verificado estructuralmente.');
lines.push('');

lines.push('## Veredictos');
lines.push('');
lines.push('| # | Verificación | Veredicto | Campos reales encontrados | Evidencia |');
lines.push('|---|---|---|---|---|');
for (const v of verifications) {
  const critical = v.critical ? ' **(CRÍTICA)**' : '';
  lines.push(`| ${v.id} | ${v.title}${critical} | **${v.status}** | ${v.fields_found ?? '—'} | ${v.dump_path ?? '—'} |`);
}
lines.push('');

lines.push('## Notas por verificación');
lines.push('');
for (const v of verifications) {
  if (!v.notes) continue;
  lines.push(`- **${v.id}**: ${v.notes}`);
}
lines.push('');

lines.push('## Latencia hasta botón gris (V4)');
lines.push('');
if (transitions.length) {
  lines.push('| Occurrence | Vía | Detectado |');
  lines.push('|---|---|---|');
  for (const t of transitions) lines.push(`| ${t.occurrence_id} | ${t.source} | ${t.detected_at} |`);
  const byOcc = {};
  for (const t of transitions) (byOcc[t.occurrence_id] ??= []).push(t);
  for (const [occ, ts] of Object.entries(byOcc)) {
    const wh = ts.find(t => t.source === 'webhook');
    const sy = ts.find(t => t.source === 'sync');
    if (wh && sy) {
      const delta = Math.abs(new Date(sy.detected_at) - new Date(wh.detected_at)) / 1000;
      lines.push('');
      lines.push(`- Occurrence ${occ}: diferencia webhook↔sync = **${delta.toFixed(1)}s** (el sync corre cada 60s; el webhook manda).`);
    }
  }
} else {
  lines.push('_Sin transiciones a agotado registradas todavía._');
}
lines.push('');

lines.push('## Webhooks recibidos por tipo');
lines.push('');
if (webhooks.length) {
  for (const w of webhooks) lines.push(`- \`${w.event_type}\`: ${w.c}`);
} else {
  lines.push('_Ninguno todavía._');
}
lines.push('');

lines.push('## Campos literales por recurso (field_discovery)');
lines.push('');
lines.push('Nombres observados en JSON real del API — no en la doc:');
lines.push('');
let currentResource = null;
for (const d of discovery) {
  if (d.resource !== currentResource) {
    currentResource = d.resource;
    lines.push(`### \`${d.resource}\``);
    lines.push('');
  }
  lines.push(`- \`${d.field}\` — ejemplo: \`${(d.sample ?? '').slice(0, 120)}\``);
}
if (!discovery.length) lines.push('_Sin descubrimientos todavía (corre el sync o las verificaciones)._');
lines.push('');

lines.push('## Riesgos encontrados');
lines.push('');
const risky = verifications.filter(v => v.status === 'FALLA' || v.status === 'PARCIAL');
if (risky.length) {
  for (const v of risky) {
    lines.push(`- **${v.id} · ${v.status}** — ${v.title}. ${v.notes ?? ''}`);
  }
} else {
  lines.push('_Ninguna verificación en FALLA o PARCIAL._');
}
const pending = verifications.filter(v => v.status === 'PENDIENTE');
if (pending.length) {
  lines.push('');
  lines.push(`Pendientes sin evidencia: ${pending.map(v => v.id).join(', ')} — no se puede decidir arquitectura sobre supuestos.`);
}
lines.push('');

const out = path.join(ROOT, 'FINDINGS.md');
fs.writeFileSync(out, lines.join('\n'));
console.log(`FINDINGS.md generado en ${out}`);
