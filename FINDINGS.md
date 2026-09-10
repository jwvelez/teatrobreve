# FINDINGS · tb-ticketing-lab

Generado: 2026-09-10T23:50:07.973Z

Este documento decide la arquitectura del proyecto real. Cada veredicto PASA está respaldado por un dump JSON crudo en /dumps.

## Hechos clave para la arquitectura (verificados contra el API real)

Cada hecho está respaldado por dumps en /dumps y por el código del laboratorio:

1. **Autenticación y límites.** HTTP Basic (API key como usuario, password vacío). Rate limit real observado: **10,000 req** por ventana (header `x-rate-limit-limit`), con `x-rate-limit-remaining` y `x-rate-limit-reset` en cada respuesta.
2. **Modelo de catálogo.** Serie recurrente = `event_series`; cada función = `event` ligado por `event_series_id`. Fechas como objeto: `start.iso` / `end.iso` (con timezone), más `date`, `time`, `formatted` y `unix`.
3. **Aforo (semántica de contadores del ticket_type).** `quantity_total` = aforo, `quantity_issued` = vendidos, `quantity_held` = en hold, `quantity_in_baskets` = en carritos activos, y `quantity` = total − vendidos − carritos (NO descuenta holds). **No hay campo de "restantes"**: vendibles = `quantity_total − quantity_issued − quantity_held − quantity_in_baskets`. Los carritos expiran solos: un agotado "por baskets" puede revertir en minutos — el checkout de TT es la fuente de verdad final.
4. **No hay estado explícito de agotado.** Un ticket_type con todo vendido sigue reportando `status: "on_sale"`. El "Agotado" del sitio SIEMPRE será un cálculo propio sobre los contadores.
5. **Firma de webhooks (verificada con código).** Header `tickettailor-webhook-signature`, formato `t=<unix>,v1=<hex>`. Algoritmo: **HMAC-SHA256(secret, timestamp + body concatenados SIN separador)** — no es el formato estilo Stripe con punto. El signing secret solo se muestra al crear el webhook en el dashboard.
6. **Tipos de webhook disponibles** (selector del dashboard): ORDER.CREATED/UPDATED, ISSUED_TICKET.CREATED/UPDATED, ISSUED_MEMBERSHIP.CREATED/UPDATED, EVENT.CREATED/UPDATED/DELETED, WAITLIST_SIGNUP.CREATED. **No existe webhook propio de refund ni de check-in**: reembolsos deben llegar como ORDER.UPDATED (pendiente de confirmar) y check-ins se leen por polling.
7. **PII del comprador.** `buyer_details` en la orden trae `{email, first_name, last_name, name, phone, address{...}, custom_questions}`. La base de clientes por email se reconstruye sin problema desde `GET /v1/orders` (paginado con `starting_after`).
8. **Check-in por API.** Existe `GET /v1/check_ins` (HTTP 200) y cada issued_ticket trae `checked_in` (+ `voided_at`). El dato "asistió / no asistió" es alcanzable.
9. **Holds.** `POST /v1/holds` con body form-encoded `event_id` + `ticket_type_id[tt_xxx]=cantidad` (arreglo estilo PHP; el mensaje de error de validación documenta el formato). Efecto: sube `quantity_held` y `event.total_holds`. OJO: TT permite reducir aforo por debajo de lo ya comprometido (vimos remaining = −1).
10. **Redirect post-compra.** Se configura POR EVENTO (Edit event → Advanced settings → "Redirect order confirmation page"). Llegan `tt_order_id`, `tt_order_value`, `tt_currency`, `tt_event_id`. **Los IDs llegan SIN prefijo** (`81118285`, no `or_81118285`): hay que anteponer `or_`/`ev_` para consultar el API. `tt_order_value` llegó "0" en compra gratis; la doc oficial muestra decimales ("36.53"), no centavos — confirmar con compra pagada.
11. **Checkout embebido en modal — RESUELTO: requiere custom domain.** El widget oficial (`.tt-widget` con widget.js) corre la selección de boletos en el modal, pero el paso de checkout depende de cookies de sesión. Con el widget en un dominio ajeno (iframe third-party), los navegadores que bloquean cookies de terceros fuerzan el fallback documentado de TT: "Checkout has opened in a new tab" (preserva promo codes y ofrece botón de regreso). Verificado en el lab con captura de postMessages: el iframe NO emite ningún mensaje al padre — decide solo. **La solución oficial de TT es un custom domain en el box office (feature de pago): `tickets.teatrobreve.com` hace las cookies first-party y el checkout completo se queda en el modal.** Es exactamente la configuración del sitio de referencia que sí funciona (oztickets.studio38.club). Confirmar en Fase 0 con la cuenta del cliente.
12. **Limitación de la cuenta de prueba.** Solo permite eventos gratis (`price: 0`) — los montos 2400/1800 y `tt_order_value` con decimales se confirman en la cuenta pagada del cliente. El campo de precio por categoría (`price`, centavos) está verificado estructuralmente.

## Veredictos

| # | Verificación | Veredicto | Campos reales encontrados | Evidencia |
|---|---|---|---|---|
| V1 | Conexión · GET /v1/ping y headers de rate limit | **PASA** | x-rate-limit-limit: 10000 · x-rate-limit-remaining: 9960 · x-rate-limit-reset: 877 | /dumps/ping-2026-08-13T18-45-41-853Z.json |
| V2 | Catálogo · event_series, events y campos de fecha/hora/estado | **PASA** | event_series: 2 · events: 6 · vínculo serie→occurrence: "event_series_id" · inicio: "start" = {"date":"2026-08-27","formatted":"Thu Aug 27, 2026 8:00 PM","iso":"2026-08-27T20:00:00-03:00","time":"20:00","timezone":"-03:00","unix":1787871600} · fin: "end" · estado: "status" = "published" | /dumps/catalogo-event_series-y-events-2026-08-13T18-45-42-790Z.json |
| V3 | CRÍTICA · Disponibilidad: total, emitidos, restantes **(CRÍTICA)** | **PASA** | total: "quantity_total" · emitidos: "quantity_issued" · en hold: "quantity_held" · en carritos: "quantity_in_baskets" · restantes: NO expuesto — calcular quantity_total − quantity_issued − quantity_held ("quantity" ya viene como total − vendidos) | /dumps/v3-cruce-ev_8865698-post-refund-2026-08-13T19-02-52-808Z.json |
| V4 | CRÍTICA · Agotado: estado explícito vs remaining=0, latencia webhook/sync **(CRÍTICA)** | **PASA** | El ticket_type agotado trae "status" = "on_sale" → agotado se infiere de contadores, no de un estado. · Latencia: vía webhook <1s (V8: webhook 18:54:27.49Z → caché actualizado 18:54:28.08Z) · vía sync peor caso = intervalo del job (60s) | /dumps/v4-soldout-transitions-2026-08-13T19-04-01-302Z.json |
| V5 | Venta no abierta: fecha de inicio de venta expuesta | **PARCIAL** | El campo "tickets_available_at" existe en events (hoy null en todos); "tickets_available_at_message" trae plantilla de countdown. Falta un event con venta futura configurada para verlo poblado. | /dumps/v5-venta-no-abierta-events-2026-08-13T18-45-44-032Z.json |
| V6 | CRÍTICA · Asientos: categorías, precios, sección/fila/asiento **(CRÍTICA)** | **PASA** | precio en "price" (centavos) · valores vistos: [0, 1000, 3000, 2000] — cuenta TEST solo permite gratis, montos 2400/1800 NO verificables aquí · categorías "Planta *": 46 · disponibilidad por categoría: cada ticket_type trae sus propios contadores (quantity_total/quantity_issued/quantity_held) · asiento en issued_ticket it_135898047: "reservation" = "23-3" | /dumps/v6-asientos-ticket_types-e-issued_tickets-2026-09-10T23-43-28-636Z.json |
| V7 | CRÍTICA · Webhooks: header de firma, HMAC, payload de orden **(CRÍTICA)** | **PASA** | header de firma: "tickettailor-webhook-signature" · esquema: HMAC-SHA256(TT_WEBHOOK_SECRET, t + body concatenados) hex, header formato t=,v1= · último evento verificado: "ORDER.CREATED" | /dumps/webhooks/webhook-ORDER_CREATED-2026-09-10T23-37-04-735Z.json |
| V8 | Reembolso: webhook recibido, estado de orden, liberación de aforo | **PASA** | NO hay webhook propio de refund: llega como "ORDER.UPDATED" + "ISSUED_TICKET.UPDATED" · orden or_81117157: "status" = "cancelled" · "refund_amount" = 0 (0 en cuenta gratis) · "status_message" trae la nota del dashboard · boletos: "status" = "voided" con "voided_at" unix (2 anulados) · aforo LIBERADO en caché vía webhook | /dumps/webhooks/webhook-ORDER_UPDATED-2026-08-13T18-54-27-494Z.json |
| V9 | Datos de cliente: reconstruir base por email desde /v1/orders | **PASA** | comprador en "buyer_details" con campos: {address, custom_questions, email, first_name, last_name, name, phone} | /dumps/v9-orders-2026-08-13T18-45-46-038Z.json |
| V10 | Check-in: boletos escaneados visibles por API | **PASA** | endpoint que respondió 200: "/check_ins" · en issued_ticket it_133138416: "checked_in" = "false" | /dumps/v10-checkins-2026-08-13T18-45-48-668Z.json |
| V11 | Redirección post-compra: parámetros tt_* llegan a /gracias | **PASA** | parámetros recibidos: tt_order_id, tt_order_value, tt_event_id, tt_currency | /dumps/v11-gracias-hits-2026-08-13T18-47-20-078Z.json |
| V12 | Holds: crear hold por API y verificar descuento de aforo | **PASA** | POST /v1/holds → 201 (hold ho_100649) · body correcto: event_id + ticket_type_id[tt_xxx]=cantidad (arreglo estilo PHP, descubierto del error de validación) · efecto: quantity_held 0→1, event.total_holds 0→1; quantity NO baja con holds (solo con vendidos) → restantes vendibles = quantity - quantity_held | /dumps/v12-holds-2026-08-13T18-29-41-135Z.json |
| V13 | CRÍTICA · Puntos: boleto reclamado + check-in = exactamente 1 punto (idempotente) **(CRÍTICA)** | **PASA** | reclamado + escaneado → otorga: true · total = 1 punto · segunda evaluación → otorga: false · total sigue = 1 · idempotencia por UNIQUE(customer_id, occurrence_id) + INSERT OR IGNORE | /dumps/v13-punto-reclamado-mas-checkin-2026-09-10T17-04-31-755Z.json |
| V14 | CRÍTICA · Boleto enviado y NO reclamado no otorga punto aunque se escanee **(CRÍTICA)** | **PASA** | enviado + escaneado pero SIN reclamar → otorga: false · total = 0 · reclamo TARDÍO (después del escaneo) → otorga: true · total = 1 | /dumps/v14-enviado-sin-reclamar-no-otorga-2026-09-10T17-04-31-792Z.json |
| V15 | Dos boletos de la misma función en la misma persona = 1 punto | **PASA** | primer boleto otorga: true · segundo boleto otorga: false · total = 1 punto · filas en loyalty_points = 1 · el ledger es UNIQUE(customer_id, occurrence_id): un punto por persona por FUNCIÓN, no por boleto | /dumps/v15-dos-boletos-misma-funcion-un-punto-2026-09-10T17-04-31-822Z.json |
| V18 | Fase 2 · ¿"Members only" se combina con seating chart? | **PASA** | ticket type "Planta Baja - El Pase" (tt_6795478): "status" = "members_only" Y "type" = "Seated" a la vez · precio 0 · max_per_order 1 · aforo 50 · cubre 11 ocurrencias de es_2359730 (los ticket types son compartidos por la serie) · valores de "status" vistos en la cuenta: [on_sale, members_only] · de "type": [GA, Seated] | /dumps/v18-members-only-con-seating-chart-2026-09-10T21-38-19-261Z.json |
| V21 | El Pase · ¿Se puede preaplicar el código de membresía por parámetro en la URL del checkout? | **FALLA** | Parámetros probados en la URL del checkout: ?membership_code=, ?code=, ?membership= → ninguno preaplica el código. Solo funciona el botón "Use membership code" del checkout (copiar y pegar). | /dumps/v21-preaplicar-codigo-por-url-2026-09-10T23-42-04-113Z.json |
| V22 | El Pase · ¿Una orden de $0 (redención) dispara el webhook igual que una pagada? **(CRÍTICA)** | **PASA** | ORDER.CREATED llegó para la orden or_82725048 con "total" = 0 · "total_paid" = 0 · "subtotal" = 0 · 1 boleto(s) · uno de ellos es el ticket type del pase | /dumps/v22-orden-cero-dispara-webhook-2026-09-10T23-41-14-719Z.json |
| V23 | BLOQUEANTE · El Pase: ¿asignar ticket types al crear el discount por API? **(CRÍTICA)** | **PASA** | POST /v1/discounts type=fixed_amount → HTTP 201 · monto fijo se manda en "price" (centavos) y vuelve como "face_value_amount" · alcance: "ticket_type_id[tt_xxx]=1" (arreglo estilo PHP, igual que /holds) · OJO: "ticket_type_ids", csv y "ticket_types[]" devuelven 201 con ticket_types:[] — falso positivo que dejaría el código aplicable a TODO el catálogo. Verificar SIEMPRE el eco. · alcance releído: ["tt_6684722"] · fuga a otros shows: 0 | /dumps/v23-discount-alcance-por-ticket-type-2026-09-10T17-08-24-601Z.json |
| V24 | BLOQUEANTE · El Pase: monto fijo, ¿descuenta por ORDEN o por BOLETO? **(CRÍTICA)** | **FALLA** | PRUEBA REAL: canasta de 2 × $10 ($20) + código fixed_amount de $10 con max_redemptions=1 → TOTAL $0.00 · El descuento se aplicó POR BOLETO (2 × $10), no una vez por orden · "times_redeemed" pasó a 1: el límite cuenta ÓRDENES, así que un solo uso regaló DOS boletos · Confirma también V17 (el límite nativo cuenta órdenes) y agrava su consecuencia · El campo de monto fijo es "price" (centavos) y vuelve como "face_value_amount" | /dumps/v24-monto-fijo-por-orden-o-por-boleto-2026-09-10T19-59-58-852Z.json |
| V25 | El Pase · Al agotar max_redemptions de la membresía, ¿el boleto deja de aparecer? | **PARCIAL** | membresía im_159964: "redemptions" = 1 · "max_redemptions" = 8 · "is_valid" = "true" (STRING, normalizar) · "redemption_collection" trae 1 entradas · campos: {object, id, created_at, description, issued_membership_id, linked_event_id, linked_order_id} · el límite lo cuenta TT por MEMBRESÍA (no por orden ni por código): cada compra del boleto members-only gasta 1 · sin over_redemption: TT no dejó pasar más de max_redemptions | /dumps/v25-agotar-membresia-2026-09-10T23-41-15-468Z.json |

## Notas por verificación

- **V1**: HTTP 200. Headers completos en el dump.
- **V2**: Campos completos por recurso en /admin (sección field_discovery) y en el dump.
- **V3**: Resta verificada contra /issued_tickets en estados estables: 2/2 con todo vendido y 0/0 tras el void. ADVERTENCIA: quantity_issued es eventualmente consistente tras un void — osciló 3→1→0→1 durante ~10 min post-reembolso mientras /issued_tickets marcaba voided al instante. Regla para el sitio real: aforo desde los contadores del ticket_type (convergen), estado de boleto individual desde issued_tickets.status; tolerar descuadres transitorios de minutos tras reembolsos.
- **V4**: Transiciones registradas (primer detector): ev_8865698 vía sync @ 2026-08-13T18:42:13.846Z | ev_8865698 vía sync @ 2026-08-13T18:42:13.846Z | ev_8865698 vía sync @ 2026-08-13T18:55:13.843Z. El botón de la cartelera se puso gris solo en ambas direcciones (agotado y liberación post-reembolso).
- **V5**: Configura una función con fecha de inicio de venta futura (TESTPLAN paso 6) y vuelve a correr.
- **V6**: Limitación de cuenta test: eventos gratis (price=0). La estructura de precio por categoría está verificada; los montos reales se confirman en la cuenta pagada del cliente. Para el asiento: compra en el evento con seating chart.
- **V7**: No llegó ningún header de firma. Hallazgo V7: el dashboard no expone signing secret y el request no viene firmado — la provenance se valida releyendo la orden por API (GET /v1/orders/{id}), nunca confiando en el payload.
- **V8**: Cancelación gratis: refund_amount quedó 0. En cuenta pagada, verificar que refund_amount refleje el monto devuelto.
- **V9**: 3 órdenes leídas · 2 clientes únicos reconstruidos por email en la tabla customers.
- **V10**: Escanea un boleto con la app oficial de Check-in (TESTPLAN paso 9) y vuelve a correr.
- **V11**: tt_order_id=81118285 llegó y el detalle de la orden se obtuvo del API.
- **V12**: Sirve para asientos de prensa/VIP. El hold de prueba ho_100649 sigue activo en ev_8865698: bórralo desde el dashboard si estorba.
- **V13**: El punto se otorga al escanear (no al reclamar) y reevaluar no duplica.
- **V14**: Quien no reclama no acumula. Y el reclamo posterior al escaneo sí otorga: por eso se evalúa en los dos eventos.
- **V15**: Quedarse con 2 boletos de la misma función da 1 punto.
- **V18**: A FAVOR: el "Abono Butaca" es viable. Un ticket type Members only CON butacas del seating chart permite que el abonado escoja asiento real sin usar códigos de descuento — lo que esquiva por completo el fallo de V24 (el monto fijo se aplicaba por boleto). Además "max_per_order" se fija SOLO en este ticket type, así que no afecta las compras regulares. El ticket type se crea a mano en el dashboard: el API no los crea (404), solo los refleja.
- **V21**: Fricción real del flujo de reserva, aceptada para el MVP: el perfil muestra el código grande con botón Copiar y los tres pasos. Si TT documenta un parámetro para esto, se añade al botón Reservar sin tocar el modelo.
- **V22**: Las órdenes a $0 disparan ORDER.CREATED igual que las pagadas: la redención del pase se ingiere por el mismo camino. Los créditos de TT no se pueden leer por API — confirmar en el dashboard (Billing) si una orden gratis consume crédito.
- **V23**: A FAVOR: el modelo de un código por show SÍ se puede automatizar por API. El alcance persiste al releer y no se filtra a otros shows.
- **V24**: BLOQUEANTE EN CONTRA. Un código de monto fijo de $X descuenta $X por CADA boleto del ticket type en la canasta, y max_redemptions solo cuenta órdenes: con un uso, un abonado mete N butacas y se las lleva todas gratis. El modelo de "un código de monto fijo por show" NO se sostiene: hay que replantear antes de construir El Pase. Alternativas a evaluar: (a) max_per_order=1 en el ticket type del abonado, si TT lo permite por ticket type; (b) un ticket type "Members only" exclusivo del pase con su propio aforo; (c) emitir un código distinto por función en vez de uno por show.
- **V25**: Aún no se agota: 1/8. Reserva funciones hasta llegar al límite y vuelve a correr.

## Latencia hasta botón gris (V4)

| Occurrence | Vía | Detectado |
|---|---|---|
| ev_8865698 | sync | 2026-08-13T18:42:13.846Z |
| ev_8865698 | sync | 2026-08-13T18:42:13.846Z |
| ev_8865698 | sync | 2026-08-13T18:55:13.843Z |
| ev_8865698 | sync | 2026-08-13T19:37:10.610Z |
| ev_8865698 | sync | 2026-09-03T15:12:17.809Z |
| ev_8865698 | sync | 2026-09-09T20:09:57.161Z |
| ev_8865698 | sync | 2026-09-10T15:00:40.856Z |
| ev_8865698 | sync | 2026-09-10T15:01:40.614Z |
| ev_8865698 | sync | 2026-09-10T15:02:11.029Z |
| ev_8865698 | sync | 2026-09-10T15:02:17.375Z |
| ev_8865698 | sync | 2026-09-10T15:03:16.987Z |
| ev_8865698 | sync | 2026-09-10T15:03:23.595Z |
| ev_8865698 | sync | 2026-09-10T15:03:33.343Z |
| ev_8865698 | sync | 2026-09-10T15:03:38.140Z |
| ev_8865698 | sync | 2026-09-10T15:04:38.086Z |
| ev_8865698 | sync | 2026-09-10T15:05:38.111Z |
| ev_8865698 | sync | 2026-09-10T15:06:10.522Z |
| ev_8865698 | sync | 2026-09-10T15:06:32.263Z |
| ev_8865698 | sync | 2026-09-10T15:06:41.556Z |
| ev_8865698 | sync | 2026-09-10T15:06:46.534Z |
| ev_8865698 | sync | 2026-09-10T15:07:00.111Z |
| ev_8865698 | sync | 2026-09-10T15:07:30.608Z |
| ev_8865698 | sync | 2026-09-10T15:07:39.121Z |
| ev_8865698 | sync | 2026-09-10T15:07:58.100Z |
| ev_8865698 | sync | 2026-09-10T15:08:57.769Z |
| ev_8865698 | sync | 2026-09-10T16:40:35.484Z |
| ev_8865698 | sync | 2026-09-10T16:41:35.523Z |
| ev_8865698 | sync | 2026-09-10T16:46:10.062Z |
| ev_8865698 | sync | 2026-09-10T16:46:15.225Z |
| ev_8865698 | sync | 2026-09-10T16:47:15.752Z |
| ev_8865698 | sync | 2026-09-10T16:47:34.595Z |
| ev_8865698 | sync | 2026-09-10T16:47:41.287Z |
| ev_8865698 | sync | 2026-09-10T16:47:46.223Z |
| ev_8865698 | sync | 2026-09-10T16:48:03.232Z |
| ev_8865698 | sync | 2026-09-10T16:48:12.212Z |
| ev_8865698 | sync | 2026-09-10T16:48:16.340Z |
| ev_8865698 | sync | 2026-09-10T16:48:21.271Z |
| ev_8865698 | sync | 2026-09-10T16:48:57.964Z |
| ev_8865698 | sync | 2026-09-10T16:49:02.701Z |
| ev_8865698 | sync | 2026-09-10T16:49:52.807Z |
| ev_8865698 | sync | 2026-09-10T16:50:00.673Z |
| ev_8865698 | sync | 2026-09-10T16:50:08.560Z |
| ev_8865698 | sync | 2026-09-10T16:50:11.996Z |
| ev_8865698 | sync | 2026-09-10T16:50:18.495Z |
| ev_8865698 | sync | 2026-09-10T16:51:18.512Z |
| ev_8865698 | sync | 2026-09-10T17:03:39.724Z |
| ev_8865698 | sync | 2026-09-10T17:03:42.068Z |
| ev_8865698 | sync | 2026-09-10T17:04:55.876Z |
| ev_8865698 | sync | 2026-09-10T17:07:25.616Z |
| ev_8865698 | sync | 2026-09-10T17:07:41.361Z |
| ev_8865698 | sync | 2026-09-10T17:08:12.633Z |
| ev_8865698 | sync | 2026-09-10T18:16:59.645Z |
| ev_8865698 | sync | 2026-09-10T18:17:59.749Z |
| ev_8865698 | sync | 2026-09-10T18:37:08.591Z |
| ev_8865698 | sync | 2026-09-10T19:06:56.089Z |
| ev_8865698 | sync | 2026-09-10T19:14:12.213Z |
| ev_8865698 | sync | 2026-09-10T19:20:15.292Z |
| ev_8865698 | sync | 2026-09-10T19:21:18.964Z |
| ev_8865698 | sync | 2026-09-10T19:26:57.197Z |
| ev_8865698 | sync | 2026-09-10T20:00:48.338Z |
| ev_8865698 | sync | 2026-09-10T21:39:07.968Z |
| ev_8865698 | sync | 2026-09-10T21:51:07.879Z |
| ev_8865698 | sync | 2026-09-10T21:55:07.871Z |
| ev_8865698 | sync | 2026-09-10T21:58:25.302Z |
| ev_8865698 | sync | 2026-09-10T23:44:14.088Z |
| ev_8865698 | sync | 2026-09-10T23:49:24.982Z |

## Webhooks recibidos por tipo

- `EVENT.CREATED`: 11
- `EVENT.UPDATED`: 10
- `ISSUED_TICKET.CREATED`: 4
- `ISSUED_TICKET.UPDATED`: 3
- `ORDER.CREATED`: 6
- `ORDER.UPDATED`: 3
- `PING.PRECHECK`: 1
- `PING.TEST`: 1
- `PING.TUNEL.USUARIO`: 1

## Campos literales por recurso (field_discovery)

Nombres observados en JSON real del API — no en la doc:

### `buyer_details`

- `address` — ejemplo: `{"address_1":null,"address_2":null,"address_3":null,"postal_code":null}`
- `custom_questions` — ejemplo: `[]`
- `email` — ejemplo: `"jwvelez@proton.me"`
- `first_name` — ejemplo: `"JAVIER"`
- `last_name` — ejemplo: `"TEST"`
- `name` — ejemplo: `"JAVIER TEST"`
- `phone` — ejemplo: `null`
### `discounts`

- `booking_fee_amount` — ejemplo: `0`
- `booking_fee_percentage` — ejemplo: `null`
- `code` — ejemplo: `"PASE-V239013"`
- `expires` — ejemplo: `null`
- `face_value_amount` — ejemplo: `2400`
- `face_value_percentage` — ejemplo: `null`
- `id` — ejemplo: `"di_598923"`
- `max_redemptions` — ejemplo: `1`
- `name` — ejemplo: `"V23 · alcance por ticket type"`
- `object` — ejemplo: `"discount"`
- `products` — ejemplo: `[]`
- `ticket_types` — ejemplo: `["tt_6684722"]`
- `times_redeemed` — ejemplo: `0`
- `type` — ejemplo: `"fixed_amount"`
### `event_series`

- `access_code` — ejemplo: `null`
- `bundles` — ejemplo: `[]`
- `call_to_action` — ejemplo: `"Comprar boletos"`
- `created_at` — ejemplo: `1786640971`
- `currency` — ejemplo: `"usd"`
- `default_max_tickets_sold_per_occurrence` — ejemplo: `null`
- `default_ticket_groups` — ejemplo: `[]`
- `default_ticket_types` — ejemplo: `[{"object":"ticket_type","id":"tt_6684722","access_code":null,"booking_fee":0,"description":null,"discounts":[],"group_i`
- `description` — ejemplo: `"<p>Noche de Jevas info</p>"`
- `id` — ejemplo: `"es_2359660"`
- `images` — ejemplo: `{"header":"https://uploads.tickettailorassets.com/c_fill,g_center,h_373,q_85,w_1172/v1/production/userfiles/global/abstr`
- `name` — ejemplo: `"Noche de Jevas 2026"`
- `next_occurrence_date` — ejemplo: `{"date":"2026-08-27","formatted":"Thu Aug 27, 2026 8:00 PM","iso":"2026-08-27T20:00:00-03:00","time":"20:00","timezone":`
- `object` — ejemplo: `"event_series"`
- `online_event` — ejemplo: `"false"`
- `payment_methods` — ejemplo: `[]`
- `private` — ejemplo: `"false"`
- `revenue` — ejemplo: `0`
- `sales_tax_label` — ejemplo: `"VAT"`
- `sales_tax_percentage` — ejemplo: `null`
- `sales_tax_treatment` — ejemplo: `"exclusive"`
- `show_map` — ejemplo: `"true"`
- `status` — ejemplo: `"published"`
- `tickets_available_at` — ejemplo: `null`
- `tickets_available_at_message` — ejemplo: `"Tickets are available in {countdown}"`
- `tickets_unavailable_at` — ejemplo: `null`
- `tickets_unavailable_at_message` — ejemplo: `"Tickets are no longer available"`
- `timezone` — ejemplo: `"America/Halifax"`
- `total_issued_tickets` — ejemplo: `0`
- `total_occurrences` — ejemplo: `1`
- `transaction_fee_fixed_amount` — ejemplo: `null`
- `transaction_fee_percentage` — ejemplo: `null`
- `upcoming_occurrences` — ejemplo: `1`
- `url` — ejemplo: `"https://buytickets.at/teatrobrevetest/2359660"`
- `venue` — ejemplo: `{"country":"PR","name":"Teatro El Shorty","postal_code":"00907"}`
- `voucher_ids` — ejemplo: `[]`
- `waitlist_active` — ejemplo: `"false"`
- `waitlist_call_to_action` — ejemplo: `"Join waiting list"`
- `waitlist_confirmation_message` — ejemplo: `"Done! You are on the waiting list."`
- `waitlist_event_page_text` — ejemplo: `"Join our waiting list to be notified when tickets become available."`
### `events`

- `access_code` — ejemplo: `null`
- `available_status` — ejemplo: `null`
- `bundles` — ejemplo: `[]`
- `call_to_action` — ejemplo: `"Comprar boletos"`
- `checkout_url` — ejemplo: `"https://www.tickettailor.com/checkout/view-event/id/8865698/chk/ffd7fa190822df420f7e29ee9b593eea/"`
- `chk` — ejemplo: `"ffd7fa190822df420f7e29ee9b593eea"`
- `created_at` — ejemplo: `1786641465`
- `currency` — ejemplo: `"usd"`
- `description` — ejemplo: `"<p>Noche de Jevas info</p>"`
- `end` — ejemplo: `{"date":"2026-08-27","formatted":"Thu Aug 27, 2026 10:30 PM","iso":"2026-08-27T22:30:00-03:00","time":"22:30","timezone"`
- `event_series_id` — ejemplo: `"es_2359660"`
- `hidden` — ejemplo: `"false"`
- `id` — ejemplo: `"ev_8865698"`
- `images` — ejemplo: `{"header":"https://uploads.tickettailorassets.com/c_fill,g_center,h_373,q_85,w_1172/v1/production/userfiles/global/abstr`
- `max_tickets_sold_per_occurrence` — ejemplo: `null`
- `name` — ejemplo: `"Noche de Jevas 2026"`
- `object` — ejemplo: `"event"`
- `online_event` — ejemplo: `"false"`
- `online_link` — ejemplo: `null`
- `override_id` — ejemplo: `null`
- `payment_methods` — ejemplo: `[]`
- `private` — ejemplo: `"false"`
- `revenue` — ejemplo: `0`
- `sales_tax_label` — ejemplo: `"VAT"`
- `sales_tax_percentage` — ejemplo: `null`
- `sales_tax_treatment` — ejemplo: `"exclusive"`
- `show_map` — ejemplo: `"true"`
- `start` — ejemplo: `{"date":"2026-08-27","formatted":"Thu Aug 27, 2026 8:00 PM","iso":"2026-08-27T20:00:00-03:00","time":"20:00","timezone":`
- `status` — ejemplo: `"published"`
- `ticket_groups` — ejemplo: `[]`
- `ticket_types` — ejemplo: `[{"object":"ticket_type","id":"tt_6684722","access_code":null,"booking_fee":0,"description":null,"discounts":[],"group_i`
- `tickets_available` — ejemplo: `"true"`
- `tickets_available_at` — ejemplo: `null`
- `tickets_available_at_message` — ejemplo: `"Tickets are available in {countdown}"`
- `tickets_unavailable_at` — ejemplo: `null`
- `tickets_unavailable_at_message` — ejemplo: `"Tickets are no longer available"`
- `timezone` — ejemplo: `"America/Halifax"`
- `total_holds` — ejemplo: `0`
- `total_issued_tickets` — ejemplo: `0`
- `total_orders` — ejemplo: `0`
- `transaction_fee_fixed_amount` — ejemplo: `null`
- `transaction_fee_percentage` — ejemplo: `null`
- `unavailable` — ejemplo: `"false"`
- `unavailable_status` — ejemplo: `null`
- `url` — ejemplo: `"https://www.tickettailor.com/events/teatrobrevetest/2359660"`
- `venue` — ejemplo: `{"country":"PR","name":"Teatro El Shorty","postal_code":"00907"}`
- `voucher_ids` — ejemplo: `[]`
- `waitlist_active` — ejemplo: `"false"`
- `waitlist_call_to_action` — ejemplo: `"Join waiting list"`
- `waitlist_confirmation_message` — ejemplo: `"Done! You are on the waiting list."`
- `waitlist_event_page_text` — ejemplo: `"Join our waiting list to be notified when tickets become available."`
### `issued_memberships`

- `benefits` — ejemplo: `[]`
- `code` — ejemplo: `"MM3K5QLHZ"`
- `email` — ejemplo: `"jwvelez+probe@gmail.com"`
- `first_name` — ejemplo: `"Probe"`
- `full_name` — ejemplo: `"Probe Test"`
- `id` — ejemplo: `"im_159964"`
- `is_valid` — ejemplo: `"true"`
- `issue_date` — ejemplo: `{"date":"2026-09-10","formatted":"Thu 10 Sep 2026 9:40 PM","iso":"2026-09-10T21:40:46+00:00","time":"21:40","timezone":"`
- `last_name` — ejemplo: `"Test"`
- `max_redemptions` — ejemplo: `null`
- `membership_type_id` — ejemplo: `"mt_9760"`
- `membership_type_name` — ejemplo: `"Abonados 2026"`
- `object` — ejemplo: `"issued_membership"`
- `redemption_collection` — ejemplo: `[]`
- `redemptions` — ejemplo: `0`
- `valid_from` — ejemplo: `{"date":"2026-09-10","formatted":"Thu 10 Sep 2026 5:40 PM","iso":"2026-09-10T17:40:46-04:00","time":"17:40","timezone":"`
- `valid_to` — ejemplo: `{"date":"2026-11-04","formatted":"Wed 4 Nov 2026 12:00 AM","iso":"2026-11-04T00:00:00-05:00","time":"00:00","timezone":"`
- `voided_at` — ejemplo: `null`
### `issued_tickets`

- `add_on_id` — ejemplo: `null`
- `barcode` — ejemplo: `"G61xcNB"`
- `barcode_url` — ejemplo: `"https://cdn.tickettailor.com/userfiles/cache/barcode/st/attendee/133138416/ef24d3c872f1158ad0aa.jpg"`
- `checked_in` — ejemplo: `"false"`
- `created_at` — ejemplo: `1786644705`
- `custom_questions` — ejemplo: `[]`
- `description` — ejemplo: `"Planta Baja"`
- `email` — ejemplo: `"jwvelez@proton.me"`
- `event_id` — ejemplo: `"ev_8865770"`
- `event_series_id` — ejemplo: `"es_2359730"`
- `first_name` — ejemplo: `"JAVIER"`
- `full_name` — ejemplo: `"JAVIER TEST"`
- `group_ticket_barcode` — ejemplo: `null`
- `id` — ejemplo: `"it_133138416"`
- `last_name` — ejemplo: `"TEST"`
- `listed_currency` — ejemplo: `{"base_multiplier":100,"code":"usd"}`
- `listed_price` — ejemplo: `0`
- `object` — ejemplo: `"issued_ticket"`
- `order_id` — ejemplo: `"or_81116640"`
- `qr_code_url` — ejemplo: `"https://cdn.tickettailor.com/userfiles/cache/barcode/qr/attendee/133138416/ef24d3c872f1158ad0aa.png"`
- `reference` — ejemplo: `null`
- `reservation` — ejemplo: `null`
- `source` — ejemplo: `"checkout"`
- `status` — ejemplo: `"valid"`
- `ticket_type_id` — ejemplo: `"tt_6684870"`
- `updated_at` — ejemplo: `1786644705`
- `voided_at` — ejemplo: `null`
### `line_items`

- `booking_fee` — ejemplo: `0`
- `description` — ejemplo: `"El Pase"`
- `id` — ejemplo: `"li_sim1"`
- `item_id` — ejemplo: `"pr_80783"`
- `object` — ejemplo: `"line_item"`
- `quantity` — ejemplo: `1`
- `store_id` — ejemplo: `null`
- `total` — ejemplo: `0`
- `type` — ejemplo: `"ticket"`
- `value` — ejemplo: `0`
### `membership_redemptions`

- `created_at` — ejemplo: `"2026-09-10T23:37:04+00:00"`
- `description` — ejemplo: `""`
- `id` — ejemplo: `"ir_214919"`
- `issued_membership_id` — ejemplo: `"im_159964"`
- `linked_event_id` — ejemplo: `null`
- `linked_order_id` — ejemplo: `"or_82725048"`
- `object` — ejemplo: `"issued_membership_redemption"`
### `membership_types`

- `conditions_and_benefits` — ejemplo: `[]`
- `id` — ejemplo: `"mt_9760"`
- `max_redemptions` — ejemplo: `8`
- `name` — ejemplo: `"Abonados 2026"`
- `object` — ejemplo: `"membership_type"`
- `photo_required` — ejemplo: `"false"`
- `valid_from_date` — ejemplo: `null`
- `valid_from_type` — ejemplo: `"relative"`
- `valid_to_date` — ejemplo: `{"date":"2026-11-04","formatted":"Wed 4 Nov 2026 12:00 AM","iso":"2026-11-04T00:00:00-05:00","time":"00:00","timezone":"`
- `valid_to_relative_days` — ejemplo: `null`
- `valid_to_type` — ejemplo: `"fixed"`
### `orders`

- `buyer_details` — ejemplo: `{"address":{"address_1":null,"address_2":null,"address_3":null,"postal_code":null},"custom_questions":[],"email":"jwvele`
- `created_at` — ejemplo: `1786644699`
- `credited_out_amount` — ejemplo: `0`
- `currency` — ejemplo: `{"base_multiplier":100,"code":"usd"}`
- `event_summary` — ejemplo: `{"id":"ev_8865770","end_date":{"date":"2026-08-24","formatted":"Mon Aug 24, 2026 10:30 PM","iso":"2026-08-24T22:30:00-04`
- `id` — ejemplo: `"or_81116640"`
- `issued_tickets` — ejemplo: `[{"object":"issued_ticket","id":"it_133138416","add_on_id":null,"barcode":"G61xcNB","barcode_url":"https://cdn.tickettai`
- `line_items` — ejemplo: `[{"object":"line_item","id":"li_167659628","booking_fee":0,"description":"Planta Baja","item_id":"tt_6684870","quantity"`
- `marketing_opt_in` — ejemplo: `null`
- `meta_data` — ejemplo: `[]`
- `notes` — ejemplo: `null`
- `object` — ejemplo: `"order"`
- `payment_method` — ejemplo: `{"additional_stripe_payment_methods":[],"external_id":null,"id":null,"instructions":null,"lead_time_before_event":null,"`
- `referral_tag` — ejemplo: `null`
- `refund_amount` — ejemplo: `0`
- `refunded_voucher_id` — ejemplo: `null`
- `sold_products` — ejemplo: `null`
- `status` — ejemplo: `"completed"`
- `status_message` — ejemplo: `null`
- `subtotal` — ejemplo: `0`
- `tax` — ejemplo: `0`
- `tax_treatment` — ejemplo: `"exclusive"`
- `total` — ejemplo: `0`
- `total_paid` — ejemplo: `0`
- `txn_id` — ejemplo: `"--"`
### `products`

- `booking_fee` — ejemplo: `0`
- `created_at` — ejemplo: `{"date":"2026-09-10","formatted":"Thu Sep 10, 2026 9:33 PM","iso":"2026-09-10T21:33:15-04:00","time":"21:33","timezone":`
- `currency` — ejemplo: `"USD"`
- `description` — ejemplo: `"Date El Pase"`
- `event_series_ids` — ejemplo: `null`
- `fulfilment_reference_id` — ejemplo: `9760`
- `fulfilment_type` — ejemplo: `"ISSUED_MEMBERSHIP"`
- `id` — ejemplo: `"pr_80783"`
- `image` — ejemplo: `null`
- `instructions` — ejemplo: `null`
- `issued_count` — ejemplo: `0`
- `linked_to_all_event_series` — ejemplo: `"false"`
- `name` — ejemplo: `"El Pase"`
- `object` — ejemplo: `"product"`
- `price` — ejemplo: `25600`
- `quantity` — ejemplo: `20`
- `quantity_per_event_occurrence` — ejemplo: `null`
- `sell_in_store` — ejemplo: `"true"`
- `status` — ejemplo: `"ON_SALE"`
- `updated_at` — ejemplo: `{"date":"2026-09-10","formatted":"Thu Sep 10, 2026 9:33 PM","iso":"2026-09-10T21:33:15-04:00","time":"21:33","timezone":`
- `variant` — ejemplo: `null`
### `ticket_types`

- `access_code` — ejemplo: `null`
- `booking_fee` — ejemplo: `0`
- `description` — ejemplo: `null`
- `discounts` — ejemplo: `[]`
- `group_id` — ejemplo: `null`
- `has_overrides` — ejemplo: `"false"`
- `hide_after` — ejemplo: `null`
- `hide_until` — ejemplo: `null`
- `hide_when_sold_out` — ejemplo: `"false"`
- `id` — ejemplo: `"tt_6684722"`
- `max_per_order` — ejemplo: `20`
- `min_per_order` — ejemplo: `1`
- `name` — ejemplo: `"Planta Baja"`
- `object` — ejemplo: `"ticket_type"`
- `override_id` — ejemplo: `null`
- `price` — ejemplo: `0`
- `quantity` — ejemplo: `100`
- `quantity_held` — ejemplo: `0`
- `quantity_in_baskets` — ejemplo: `0`
- `quantity_issued` — ejemplo: `0`
- `quantity_total` — ejemplo: `100`
- `show_quantity_remaining` — ejemplo: `"false"`
- `show_quantity_remaining_less_than` — ejemplo: `null`
- `sort_order` — ejemplo: `10000`
- `status` — ejemplo: `"on_sale"`
- `type` — ejemplo: `"GA"`
### `webhook_EVENT.CREATED`

- `access_code` — ejemplo: `null`
- `available_status` — ejemplo: `null`
- `bundles` — ejemplo: `[]`
- `call_to_action` — ejemplo: `"Comprar boletos"`
- `checkout_url` — ejemplo: `"https://www.tickettailor.com/checkout/view-event/id/8865771/chk/cd950e1101cc66eed8c8619e4beec239/"`
- `chk` — ejemplo: `"1cb3dc059757e3292031a0542ee4e857"`
- `created_at` — ejemplo: `1786644632`
- `currency` — ejemplo: `"usd"`
- `description` — ejemplo: `"<p>la improoo</p>"`
- `end` — ejemplo: `{"date":"2026-08-31","formatted":"Mon Aug 31, 2026 10:30 PM","iso":"2026-08-31T22:30:00-04:00","time":"22:30","timezone"`
- `event_series_id` — ejemplo: `"es_2359730"`
- `hidden` — ejemplo: `"false"`
- `id` — ejemplo: `"ev_8865771"`
- `images` — ejemplo: `{"header":"https://uploads.tickettailorassets.com/c_fill,g_center,h_373,q_85,w_1172/v1/production/userfiles/global/decor`
- `max_tickets_sold_per_occurrence` — ejemplo: `null`
- `name` — ejemplo: `"Noches de Impro"`
- `object` — ejemplo: `"event"`
- `online_event` — ejemplo: `"false"`
- `online_link` — ejemplo: `null`
- `override_id` — ejemplo: `null`
- `payment_methods` — ejemplo: `[]`
- `private` — ejemplo: `"false"`
- `revenue` — ejemplo: `0`
- `sales_tax_label` — ejemplo: `"VAT"`
- `sales_tax_percentage` — ejemplo: `null`
- `sales_tax_treatment` — ejemplo: `"exclusive"`
- `show_map` — ejemplo: `"true"`
- `start` — ejemplo: `{"date":"2026-08-31","formatted":"Mon Aug 31, 2026 8:00 PM","iso":"2026-08-31T20:00:00-04:00","time":"20:00","timezone":`
- `status` — ejemplo: `"draft"`
- `ticket_groups` — ejemplo: `[]`
- `ticket_types` — ejemplo: `[{"object":"ticket_type","id":"tt_6684870","access_code":null,"booking_fee":0,"description":null,"discounts":[],"group_i`
- `tickets_available` — ejemplo: `"false"`
- `tickets_available_at` — ejemplo: `null`
- `tickets_available_at_message` — ejemplo: `"Tickets are available in {countdown}"`
- `tickets_unavailable_at` — ejemplo: `null`
- `tickets_unavailable_at_message` — ejemplo: `"Tickets are no longer available"`
- `timezone` — ejemplo: `"America/New_York"`
- `total_holds` — ejemplo: `0`
- `total_issued_tickets` — ejemplo: `0`
- `total_orders` — ejemplo: `0`
- `transaction_fee_fixed_amount` — ejemplo: `null`
- `transaction_fee_percentage` — ejemplo: `null`
- `unavailable` — ejemplo: `"false"`
- `unavailable_status` — ejemplo: `null`
- `url` — ejemplo: `"https://www.tickettailor.com/events/teatrobrevetest/2359730"`
- `venue` — ejemplo: `{"country":"PR","name":"Teatro El Shorty","postal_code":"00907"}`
- `voucher_ids` — ejemplo: `[]`
- `waitlist_active` — ejemplo: `"false"`
- `waitlist_call_to_action` — ejemplo: `"Join waiting list"`
- `waitlist_confirmation_message` — ejemplo: `"Done! You are on the waiting list."`
- `waitlist_event_page_text` — ejemplo: `"Join our waiting list to be notified when tickets become available."`
### `webhook_EVENT.UPDATED`

- `access_code` — ejemplo: `null`
- `available_status` — ejemplo: `null`
- `bundles` — ejemplo: `[]`
- `call_to_action` — ejemplo: `"Comprar boletos"`
- `checkout_url` — ejemplo: `"https://www.tickettailor.com/checkout/view-event/id/8865769/chk/f662ea79029d4e2b2948fd19c1ac2e91/"`
- `chk` — ejemplo: `"f662ea79029d4e2b2948fd19c1ac2e91"`
- `created_at` — ejemplo: `1786644632`
- `currency` — ejemplo: `"usd"`
- `description` — ejemplo: `"<p>la improoo</p>"`
- `end` — ejemplo: `{"date":"2026-08-17","formatted":"Mon Aug 17, 2026 10:30 PM","iso":"2026-08-17T22:30:00-04:00","time":"22:30","timezone"`
- `event_series_id` — ejemplo: `"es_2359730"`
- `hidden` — ejemplo: `"false"`
- `id` — ejemplo: `"ev_8865769"`
- `images` — ejemplo: `{"header":"https://uploads.tickettailorassets.com/c_fill,g_center,h_373,q_85,w_1172/v1/production/userfiles/global/decor`
- `max_tickets_sold_per_occurrence` — ejemplo: `null`
- `name` — ejemplo: `"Noches de Impro"`
- `object` — ejemplo: `"event"`
- `online_event` — ejemplo: `"false"`
- `online_link` — ejemplo: `null`
- `override_id` — ejemplo: `null`
- `payment_methods` — ejemplo: `[]`
- `private` — ejemplo: `"false"`
- `revenue` — ejemplo: `0`
- `sales_tax_label` — ejemplo: `"VAT"`
- `sales_tax_percentage` — ejemplo: `null`
- `sales_tax_treatment` — ejemplo: `"exclusive"`
- `show_map` — ejemplo: `"true"`
- `start` — ejemplo: `{"date":"2026-08-17","formatted":"Mon Aug 17, 2026 8:00 PM","iso":"2026-08-17T20:00:00-04:00","time":"20:00","timezone":`
- `status` — ejemplo: `"published"`
- `ticket_groups` — ejemplo: `[]`
- `ticket_types` — ejemplo: `[{"object":"ticket_type","id":"tt_6684870","access_code":null,"booking_fee":0,"description":null,"discounts":[],"group_i`
- `tickets_available` — ejemplo: `"true"`
- `tickets_available_at` — ejemplo: `null`
- `tickets_available_at_message` — ejemplo: `"Tickets are available in {countdown}"`
- `tickets_unavailable_at` — ejemplo: `null`
- `tickets_unavailable_at_message` — ejemplo: `"Tickets are no longer available"`
- `timezone` — ejemplo: `"America/New_York"`
- `total_holds` — ejemplo: `0`
- `total_issued_tickets` — ejemplo: `0`
- `total_orders` — ejemplo: `0`
- `transaction_fee_fixed_amount` — ejemplo: `null`
- `transaction_fee_percentage` — ejemplo: `null`
- `unavailable` — ejemplo: `"false"`
- `unavailable_status` — ejemplo: `null`
- `url` — ejemplo: `"https://www.tickettailor.com/events/teatrobrevetest/2359730"`
- `venue` — ejemplo: `{"country":"PR","name":"Teatro El Shorty","postal_code":"00907"}`
- `voucher_ids` — ejemplo: `[]`
- `waitlist_active` — ejemplo: `"false"`
- `waitlist_call_to_action` — ejemplo: `"Join waiting list"`
- `waitlist_confirmation_message` — ejemplo: `"Done! You are on the waiting list."`
- `waitlist_event_page_text` — ejemplo: `"Join our waiting list to be notified when tickets become available."`
### `webhook_ISSUED_TICKET.CREATED`

- `add_on_id` — ejemplo: `null`
- `barcode` — ejemplo: `"G61xcNB"`
- `barcode_url` — ejemplo: `"https://cdn.tickettailor.com/userfiles/cache/barcode/st/attendee/133138416/ef24d3c872f1158ad0aa.jpg"`
- `checked_in` — ejemplo: `"false"`
- `created_at` — ejemplo: `1786644705`
- `custom_questions` — ejemplo: `[]`
- `description` — ejemplo: `"Planta Baja"`
- `email` — ejemplo: `"jwvelez@proton.me"`
- `event_id` — ejemplo: `"ev_8865770"`
- `event_series_id` — ejemplo: `"es_2359730"`
- `first_name` — ejemplo: `"JAVIER"`
- `full_name` — ejemplo: `"JAVIER TEST"`
- `group_ticket_barcode` — ejemplo: `null`
- `id` — ejemplo: `"it_133138416"`
- `last_name` — ejemplo: `"TEST"`
- `listed_currency` — ejemplo: `{"base_multiplier":100,"code":"usd"}`
- `listed_price` — ejemplo: `0`
- `object` — ejemplo: `"issued_ticket"`
- `order_id` — ejemplo: `"or_81116640"`
- `qr_code_url` — ejemplo: `"https://cdn.tickettailor.com/userfiles/cache/barcode/qr/attendee/133138416/ef24d3c872f1158ad0aa.png"`
- `reference` — ejemplo: `null`
- `reservation` — ejemplo: `null`
- `source` — ejemplo: `"checkout"`
- `status` — ejemplo: `"valid"`
- `ticket_type_id` — ejemplo: `"tt_6684870"`
- `updated_at` — ejemplo: `1786644705`
- `voided_at` — ejemplo: `null`
### `webhook_ISSUED_TICKET.UPDATED`

- `add_on_id` — ejemplo: `null`
- `barcode` — ejemplo: `"JU4hTUE"`
- `barcode_url` — ejemplo: `"https://cdn.tickettailor.com/userfiles/cache/barcode/st/attendee/133139351/a2206888c350ee6f6d56.jpg"`
- `checked_in` — ejemplo: `"false"`
- `created_at` — ejemplo: `1786645321`
- `custom_questions` — ejemplo: `[]`
- `description` — ejemplo: `"Planta Alta"`
- `email` — ejemplo: `"jwvelez+wepa@gmail.com"`
- `event_id` — ejemplo: `"ev_8865698"`
- `event_series_id` — ejemplo: `"es_2359660"`
- `first_name` — ejemplo: `null`
- `full_name` — ejemplo: `null`
- `group_ticket_barcode` — ejemplo: `null`
- `id` — ejemplo: `"it_133139351"`
- `last_name` — ejemplo: `null`
- `listed_currency` — ejemplo: `{"base_multiplier":100,"code":"usd"}`
- `listed_price` — ejemplo: `0`
- `object` — ejemplo: `"issued_ticket"`
- `order_id` — ejemplo: `"or_81117157"`
- `qr_code_url` — ejemplo: `"https://cdn.tickettailor.com/userfiles/cache/barcode/qr/attendee/133139351/a2206888c350ee6f6d56.png"`
- `reference` — ejemplo: `null`
- `reservation` — ejemplo: `null`
- `source` — ejemplo: `"checkout"`
- `status` — ejemplo: `"voided"`
- `ticket_type_id` — ejemplo: `"tt_6684724"`
- `updated_at` — ejemplo: `1786645321`
- `voided_at` — ejemplo: `1786647266`
### `webhook_ORDER.CREATED`

- `buyer_details` — ejemplo: `{"address":{"address_1":null,"address_2":null,"address_3":null,"postal_code":null},"custom_questions":[],"email":"jwvele`
- `created_at` — ejemplo: `1786644699`
- `credited_out_amount` — ejemplo: `0`
- `currency` — ejemplo: `{"base_multiplier":100,"code":"usd"}`
- `event_summary` — ejemplo: `{"id":"ev_8865770","end_date":{"date":"2026-08-24","formatted":"Mon Aug 24, 2026 10:30 PM","iso":"2026-08-24T22:30:00-04`
- `id` — ejemplo: `"or_81116640"`
- `issued_tickets` — ejemplo: `[{"object":"issued_ticket","id":"it_133138416","add_on_id":null,"barcode":"G61xcNB","barcode_url":"https://cdn.tickettai`
- `line_items` — ejemplo: `[{"object":"line_item","id":"li_167659628","booking_fee":0,"description":"Planta Baja","item_id":"tt_6684870","quantity"`
- `marketing_opt_in` — ejemplo: `null`
- `meta_data` — ejemplo: `[]`
- `notes` — ejemplo: `null`
- `object` — ejemplo: `"order"`
- `payment_method` — ejemplo: `{"additional_stripe_payment_methods":[],"external_id":null,"id":null,"instructions":null,"lead_time_before_event":null,"`
- `referral_tag` — ejemplo: `null`
- `refund_amount` — ejemplo: `0`
- `refunded_voucher_id` — ejemplo: `null`
- `sold_products` — ejemplo: `null`
- `status` — ejemplo: `"completed"`
- `status_message` — ejemplo: `null`
- `subtotal` — ejemplo: `0`
- `tax` — ejemplo: `0`
- `tax_treatment` — ejemplo: `"exclusive"`
- `total` — ejemplo: `0`
- `total_paid` — ejemplo: `0`
- `txn_id` — ejemplo: `"--"`
### `webhook_ORDER.UPDATED`

- `buyer_details` — ejemplo: `{"address":{"address_1":null,"address_2":null,"address_3":null,"postal_code":null},"custom_questions":[],"email":"jwvele`
- `created_at` — ejemplo: `1786645307`
- `credited_out_amount` — ejemplo: `0`
- `currency` — ejemplo: `{"base_multiplier":100,"code":"usd"}`
- `event_summary` — ejemplo: `{"id":"ev_8865698","end_date":{"date":"2026-08-27","formatted":"Thu Aug 27, 2026 10:30 PM","iso":"2026-08-27T22:30:00-03`
- `id` — ejemplo: `"or_81117157"`
- `issued_tickets` — ejemplo: `[{"object":"issued_ticket","id":"it_133139350","add_on_id":null,"barcode":"Fg873C8","barcode_url":"https://cdn.tickettai`
- `line_items` — ejemplo: `[{"object":"line_item","id":"li_167660735","booking_fee":0,"description":"Planta Baja","item_id":"tt_6684722","quantity"`
- `marketing_opt_in` — ejemplo: `null`
- `meta_data` — ejemplo: `[]`
- `notes` — ejemplo: `null`
- `object` — ejemplo: `"order"`
- `payment_method` — ejemplo: `{"additional_stripe_payment_methods":[],"external_id":null,"id":null,"instructions":null,"lead_time_before_event":null,"`
- `referral_tag` — ejemplo: `null`
- `refund_amount` — ejemplo: `0`
- `refunded_voucher_id` — ejemplo: `null`
- `sold_products` — ejemplo: `null`
- `status` — ejemplo: `"cancelled"`
- `status_message` — ejemplo: `"wepa (by Javier W. Vélez)"`
- `subtotal` — ejemplo: `0`
- `tax` — ejemplo: `0`
- `tax_treatment` — ejemplo: `"exclusive"`
- `total` — ejemplo: `0`
- `total_paid` — ejemplo: `0`
- `txn_id` — ejemplo: `"--"`
### `webhook_PING.PRECHECK`

- `event` — ejemplo: `"PING.PRECHECK"`
- `id` — ejemplo: `"wh_precheck_1"`
### `webhook_PING.TEST`

- `event` — ejemplo: `"PING.TEST"`
- `id` — ejemplo: `"wh_probe_tunnel"`
### `webhook_PING.TUNEL.USUARIO`

- `event` — ejemplo: `"PING.TUNEL.USUARIO"`
- `id` — ejemplo: `"wh_probe_user_tunnel"`
### `webhook_envelope`

- `created_at` — ejemplo: `"2026-08-13 18:10:32"`
- `event` — ejemplo: `"EVENT.CREATED"`
- `id` — ejemplo: `"wh_6725410"`
- `payload` — ejemplo: `{"object":"event","id":"ev_8865771","access_code":null,"available_status":null,"bundles":[],"call_to_action":"Comprar bo`
- `resource_url` — ejemplo: `"https://api.tickettailor.com/v1/events/ev_8865771"`

## Riesgos encontrados

- **V5 · PARCIAL** — Venta no abierta: fecha de inicio de venta expuesta. Configura una función con fecha de inicio de venta futura (TESTPLAN paso 6) y vuelve a correr.
- **V21 · FALLA** — El Pase · ¿Se puede preaplicar el código de membresía por parámetro en la URL del checkout?. Fricción real del flujo de reserva, aceptada para el MVP: el perfil muestra el código grande con botón Copiar y los tres pasos. Si TT documenta un parámetro para esto, se añade al botón Reservar sin tocar el modelo.
- **V24 · FALLA** — BLOQUEANTE · El Pase: monto fijo, ¿descuenta por ORDEN o por BOLETO?. BLOQUEANTE EN CONTRA. Un código de monto fijo de $X descuenta $X por CADA boleto del ticket type en la canasta, y max_redemptions solo cuenta órdenes: con un uso, un abonado mete N butacas y se las lleva todas gratis. El modelo de "un código de monto fijo por show" NO se sostiene: hay que replantear antes de construir El Pase. Alternativas a evaluar: (a) max_per_order=1 en el ticket type del abonado, si TT lo permite por ticket type; (b) un ticket type "Members only" exclusivo del pase con su propio aforo; (c) emitir un código distinto por función en vez de uno por show.
- **V25 · PARCIAL** — El Pase · Al agotar max_redemptions de la membresía, ¿el boleto deja de aparecer?. Aún no se agota: 1/8. Reserva funciones hasta llegar al límite y vuelve a correr.
