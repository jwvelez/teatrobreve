# tb-ticketing-lab

Laboratorio de descubrimiento y demo contra el **API real de Ticket Tailor** para el proyecto
del teatro (Teatro Breve). No es código de producción: es la prueba de que la integración
vendida se puede construir, con **evidencia en dumps JSON crudos**, más un **demo presentable
del perfil del cliente**.

**Estado al 13 de agosto de 2026: 10 de 12 verificaciones PASA · 2 PARCIAL (solo requieren
la cuenta pagada del cliente). El demo del perfil funciona de punta a punta.**

Documentos hermanos:
- **[FINDINGS.md](FINDINGS.md)** — el entregable técnico: 12 hechos de arquitectura verificados, veredictos con dumps, riesgos. Se regenera con `npm run findings`.
- **[TESTPLAN.md](TESTPLAN.md)** — el plan paso a paso que se siguió (qué hace el humano en el dashboard vs qué verifica el app).
- **[DEMO.md](DEMO.md)** — guión de 3 minutos para enseñar el perfil del cliente.

---

## Cómo arrancar (retomar en frío)

```bash
cd tbtest
npm install
cp .env.example .env          # pegar TICKET_TAILOR_API_KEY (dashboard → Settings → API)
                              # y TT_WEBHOOK_SECRET (se muestra al crear el webhook)
npm start                     # http://localhost:3000
```

Al arrancar: sync inmediato del catálogo + **backfill de todas las órdenes** (reconstruye
clientes y boletos), luego sync cada 60 s. Sin API key, la cartelera sirve datos mock.

**Para webhooks y redirect** (necesitan URL pública):

```bash
cloudflared tunnel --url http://localhost:3000
```

La URL de trycloudflare **cambia en cada arranque**. Al retomar hay que actualizar en el
dashboard de TT:
1. Settings → API → Webhooks → URL: `https://<túnel>/webhooks/tickettailor`
2. Cada evento → Advanced settings → "Redirect order confirmation page": `https://<túnel>/gracias`

Rutas principales:

| Ruta | Qué es |
|---|---|
| `/` | Cartelera (Lista/Mes, filtros, modal de checkout) — sirve SIEMPRE del caché local |
| `/gracias` | Confirmación post-compra propia (lee params `tt_*`, trae la orden por API) |
| `/admin` | Panel de hallazgos: 12 verificaciones, webhooks recibidos, campos descubiertos, último enlace de entrada |
| `/entrar` | Login sin contraseña del perfil (enlace mágico; sale en consola y en /admin, no se envía correo) |
| `/mi-cuenta` | Perfil del cliente (demo): stats, boletos con QR, historial, datos, preferencias |
| `/mi-cuenta/boleto/:id` | Pantalla de puerta: QR grande + estado (Válido / Ya escaneado / Cancelado) |

---

## Arquitectura (cómo funciona todo)

**Regla de oro que gobierna el código:** la doc de TT renderiza esquemas client-side, así que
ningún nombre de campo se asume — se descubre del JSON real (`pick()` con candidatos +
tabla `field_discovery`), se vuelca a `/dumps/{recurso}-{timestamp}.json`, y **nada se marca
PASA sin dump** (`setVerification` lo degrada a PARCIAL si falta).

**Regla de tráfico:** el navegador **nunca** llama al API de TT. Todo pasa por SQLite
(`data/lab.db`), refrescado por dos vías:
- **Sync job** cada 60 s: `GET /event_series` + `GET /events` (ticket_types vienen embebidos).
  2 llamadas por tick sin importar cuántas funciones haya (paginación de a 100).
- **Webhooks** (instantáneo): orden nueva/actualizada → upsert de cliente/orden/boletos +
  releer el event afectado → caché al día en <1 s (medido).

Presupuesto de API: ~2,880 llamadas/día de sync + 1 por compra, contra un límite real
observado de 10,000 por ventana. Cliente HTTP con backoff en 429 y lectura de
`X-Rate-Limit-Remaining` en cada respuesta.

### Archivos

```
src/
  server.js        Express: rutas, sync interval, backfill al boot
  db.js            Esquema SQLite completo + setVerification (regla del dump) + field_discovery
  ttClient.js      Cliente TT: Basic auth, 429/backoff, paginación starting_after, dump(), pick()
  sync.js          Sync del catálogo + updateAvailability (semántica real de contadores) + soldout_transitions
  webhooks.js      Verificación de firma HMAC (esquema real descubierto), idempotencia, processOrder, upsertTicket
  verifications.js Runners V1–V12 (se corren desde /admin o por POST /api/verifications/:id/run)
  auth.js          Enlace mágico: tokens hasheados 15 min, cookie firmada HMAC 7 días, rate limit en memoria
  profile.js       Perfil: stats, próximos, historial, boleto, datos locales, preferencias
  findings.js      Genera FINDINGS.md desde la DB (npm run findings)
  mock.js          Cartelera mock cuando no hay API key
public/
  index.html       Cartelera (Lista/Mes, filtros, modal con widget oficial de TT, pre-llenado con sesión)
  gracias.html     Confirmación (normaliza tt_order_id sin prefijo → or_, frame-buster si cae en iframe)
  admin.html       Panel de hallazgos
  entrar.html, cuenta.html, boleto.html   Perfil del cliente
  styles.css       Tokens del sitio real (#0B1211, #C6F24B, Archivo + Martian Mono)
```

### Tablas SQLite

`shows` (event_series) · `occurrences` (events) · `ticket_types` · `availability_cache`
(occurrence+ticket_type → quantity/issued/remaining/status) · `customers` (email único; `points`
y `tier` listos para fase 2, sin uso) · `customer_prefs` · `orders` · `issued_tickets` (con QR,
precio, asiento, checked_in normalizado, voided_at) · `attendance` · `webhook_log` (dedupe por
id de evento) · `verifications` · `soldout_transitions` (evidencia de latencia V4) ·
`field_discovery` · `gracias_hits` · `login_tokens` · `meta` · `debug_messages`
(postMessages capturados del modal, ver `/api/debug/messages`).

Todo el JSON crudo se conserva en columnas `raw` + `/dumps/`.

### Los 5 flujos

1. **Cartelera:** `/api/cartelera` lee occurrences + availability_cache → botones Comprar /
   Últimos boletos (≤15 %) / Agotado / Avísame. La UI se refresca del caché cada 15 s.
2. **Compra:** botón → modal con el **widget oficial** de TT (`.tt-widget` + widget.js). Si hay
   sesión del perfil, la URL lleva pre-llenado oficial (`preset_data=1#p[first_name]=…&p[email]=…`).
   El pago puede saltar a pestaña nueva (ver "Huecos" abajo — es cookies, no bug).
3. **Post-compra:** TT redirige a `/gracias?tt_order_id=…` (IDs SIN prefijo: se normaliza a
   `or_`). La página muestra los params y trae el detalle por API con dump.
4. **Webhook:** firma verificada (HMAC-SHA256 del secret sobre `timestamp + body` concatenados,
   header `tickettailor-webhook-signature`), dedupe, ingesta, refresh del event. Reembolsos
   llegan como ORDER.UPDATED (`cancelled`) + ISSUED_TICKET.UPDATED (`voided`) — no hay evento
   propio de refund.
5. **Perfil:** `/entrar` → enlace de un solo uso → cookie firmada → `/mi-cuenta` lee TODO de
   SQLite y hace polling a su propio server cada 30 s (compra en otra pestaña aparece sola).

### Hechos clave del API

La lista completa y defendible está en **FINDINGS.md** (sección "Hechos clave"). Los que más
condicionan el código:

- Aforo: `quantity_total` − `quantity_issued` − `quantity_held` − `quantity_in_baskets` =
  vendibles. **No hay estado explícito de agotado** (status se queda `on_sale`): siempre es
  cálculo nuestro. Los carritos expiran solos → un agotado "por baskets" revierte en minutos.
- `quantity_issued` es **eventualmente consistente** tras un void (oscila ~10 min). Estado de
  boleto individual SIEMPRE de `issued_tickets.status`.
- `checked_in` llega como STRING `"true"`/`"false"` → normalizado a 0/1 al ingerir.
- `status_message` de la orden trae notas internas del staff → **jamás se renderiza**.
- Asiento: campo `reservation` en el boleto, `null` en compras GA (la UI degrada con gracia).
- Check-in: existe `GET /v1/check_ins` + campo `checked_in` → alimenta Asistió/No asistió.
- Holds: `POST /v1/holds` con `ticket_type_id[tt_xxx]=n` (estilo PHP) → sube `quantity_held`.

---

## Huecos conocidos (con su explicación)

1. **El paso de pago del modal abre pestaña nueva.** NO es bug nuestro: el checkout necesita
   cookies de sesión y en un iframe cross-domain los navegadores las bloquean; TT activa su
   fallback documentado. **Solución real: custom domain** (`tickets.teatrobreve.com`, feature
   del plan pagado) → cookies first-party → todo queda en el modal (así funciona el sitio de
   referencia oztickets.studio38.club). Verificable hoy activando cookies de terceros en el
   navegador. Evidencia: `/api/debug/messages` (el iframe no emite ningún mensaje al padre).
2. **Aforo negativo posible:** TT permite reducir capacidad por debajo de lo ya
   vendido+en hold (vimos remaining = −1). En producción: mostrar `max(0, …)`.
3. **Enlace de entrada no se envía por correo** (a propósito en el demo): sale en consola y
   `/admin`. `sendLoginEmail()` en `src/auth.js` es la interfaz limpia para enchufar
   Resend/Postmark/SES.
4. **Edición de datos y preferencias son locales** — no escriben de vuelta a TT (TT no tiene
   cuentas de comprador; nuestro sitio es el dueño de esa relación).
5. **Pre-llenado del checkout implementado pero sin verificar en compra real** (formato
   oficial de la doc; probar: sesión activa → Comprar → formulario debe venir lleno).
6. **Rate limit del login en memoria** — se reinicia con el server. Suficiente para demo.
7. **El túnel trycloudflare rota de URL** en cada arranque (webhook + redirect quedan viejos).
   En producción no existe este problema (dominio fijo).

## Lo que falta (todo requiere la cuenta pagada del cliente — "Fase 0", una tarde)

| # | Pendiente | Qué se confirma |
|---|---|---|
| 1 | **Custom domain** en el box office | El checkout completo se queda en el modal (hueco #1) |
| 2 | **Seating chart** real (Planta Baja $24 / Planta Alta $18) + compra con asiento | V6: `reservation` poblado con sección/fila/asiento; precios 2400/1800 en centavos |
| 3 | Compra **pagada** de verdad | Formato real de `tt_order_value` en el redirect (la doc sugiere decimales, no centavos) |
| 4 | **Reembolso parcial** de una orden pagada | Cómo queda `refund_amount` y si vienen webhooks distintos al reembolso total |
| 5 | Función con **venta futura** (esto también se puede en la cuenta test) | V5: ver `tickets_available_at` poblado → "Avísame cuando abra" |
| 6 | **Escanear el QR del perfil** con la app oficial de Check-in | El QR que renderizamos valida en puerta; `checked_in` cambia y el historial marca Asistió |
| 7 | Pre-llenado del checkout en compra real | Hueco #5 de arriba |

Con eso, las 12 verificaciones quedan PASA y la arquitectura del sitio real está 100 % validada.

## Fase 2 ya preparada (sin construir)

- Columnas `points` y `tier` en `customers` (recompensas).
- Menú "Recompensas · fase 2" deshabilitado en el perfil (gancho visual para la venta).
- `waitlist_signup.created` ya se recibe por webhook → base del "Avísame cuando abra" real.
