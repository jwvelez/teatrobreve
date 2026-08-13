# FINDINGS · tb-ticketing-lab

Generado: 2026-08-13T19:37:27.334Z

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
| V6 | CRÍTICA · Asientos: categorías, precios, sección/fila/asiento **(CRÍTICA)** | **PARCIAL** | precio en "price" (centavos) · valores vistos: [0] — cuenta TEST solo permite gratis, montos 2400/1800 NO verificables aquí · categorías "Planta *": 7 · disponibilidad por categoría: cada ticket_type trae sus propios contadores (quantity_total/quantity_issued/quantity_held) · issued_tickets traen el campo "reservation" pero null (compras GA) — falta una compra en evento CON seating chart para verlo poblado | /dumps/v6-asientos-ticket_types-e-issued_tickets-2026-08-13T18-45-44-833Z.json |
| V7 | CRÍTICA · Webhooks: header de firma, HMAC, payload de orden **(CRÍTICA)** | **PASA** | header: "tickettailor-webhook-signature" · esquema verificado: HMAC-SHA256(TT_WEBHOOK_SECRET, t + body concatenados) hex, header formato t=,v1= · tipos de evento recibidos: ORDER.UPDATED, ISSUED_TICKET.UPDATED, EVENT.UPDATED, ORDER.CREATED, ISSUED_TICKET.CREATED, EVENT.CREATED · comprador en "buyer_details": {address, custom_questions, email, first_name, last_name, name, phone} · boletos/line items en "issued_tickets" (2) | /dumps/webhooks/webhook-ORDER_UPDATED-2026-08-13T18-54-27-494Z.json |
| V8 | Reembolso: webhook recibido, estado de orden, liberación de aforo | **PASA** | NO hay webhook propio de refund: llega como "ORDER.UPDATED" + "ISSUED_TICKET.UPDATED" · orden or_81117157: "status" = "cancelled" · "refund_amount" = 0 (0 en cuenta gratis) · "status_message" trae la nota del dashboard · boletos: "status" = "voided" con "voided_at" unix (2 anulados) · aforo LIBERADO en caché vía webhook | /dumps/webhooks/webhook-ORDER_UPDATED-2026-08-13T18-54-27-494Z.json |
| V9 | Datos de cliente: reconstruir base por email desde /v1/orders | **PASA** | comprador en "buyer_details" con campos: {address, custom_questions, email, first_name, last_name, name, phone} | /dumps/v9-orders-2026-08-13T18-45-46-038Z.json |
| V10 | Check-in: boletos escaneados visibles por API | **PASA** | endpoint que respondió 200: "/check_ins" · en issued_ticket it_133138416: "checked_in" = "false" | /dumps/v10-checkins-2026-08-13T18-45-48-668Z.json |
| V11 | Redirección post-compra: parámetros tt_* llegan a /gracias | **PASA** | parámetros recibidos: tt_order_id, tt_order_value, tt_event_id, tt_currency | /dumps/v11-gracias-hits-2026-08-13T18-47-20-078Z.json |
| V12 | Holds: crear hold por API y verificar descuento de aforo | **PASA** | POST /v1/holds → 201 (hold ho_100649) · body correcto: event_id + ticket_type_id[tt_xxx]=cantidad (arreglo estilo PHP, descubierto del error de validación) · efecto: quantity_held 0→1, event.total_holds 0→1; quantity NO baja con holds (solo con vendidos) → restantes vendibles = quantity - quantity_held | /dumps/v12-holds-2026-08-13T18-29-41-135Z.json |

## Notas por verificación

- **V1**: HTTP 200. Headers completos en el dump.
- **V2**: Campos completos por recurso en /admin (sección field_discovery) y en el dump.
- **V3**: Resta verificada contra /issued_tickets en estados estables: 2/2 con todo vendido y 0/0 tras el void. ADVERTENCIA: quantity_issued es eventualmente consistente tras un void — osciló 3→1→0→1 durante ~10 min post-reembolso mientras /issued_tickets marcaba voided al instante. Regla para el sitio real: aforo desde los contadores del ticket_type (convergen), estado de boleto individual desde issued_tickets.status; tolerar descuadres transitorios de minutos tras reembolsos.
- **V4**: Transiciones registradas (primer detector): ev_8865698 vía sync @ 2026-08-13T18:42:13.846Z | ev_8865698 vía sync @ 2026-08-13T18:42:13.846Z | ev_8865698 vía sync @ 2026-08-13T18:55:13.843Z. El botón de la cartelera se puso gris solo en ambas direcciones (agotado y liberación post-reembolso).
- **V5**: Configura una función con fecha de inicio de venta futura (TESTPLAN paso 6) y vuelve a correr.
- **V6**: Limitación de cuenta test: eventos gratis (price=0). La estructura de precio por categoría está verificada; los montos reales se confirman en la cuenta pagada del cliente. Para el asiento: compra en el evento con seating chart.
- **V7**: 21 webhooks en log. La lista completa de eventos disponibles se ve al configurar el webhook en el dashboard — anótala en /admin (editar notas).
- **V8**: Cancelación gratis: refund_amount quedó 0. En cuenta pagada, verificar que refund_amount refleje el monto devuelto.
- **V9**: 3 órdenes leídas · 2 clientes únicos reconstruidos por email en la tabla customers.
- **V10**: Escanea un boleto con la app oficial de Check-in (TESTPLAN paso 9) y vuelve a correr.
- **V11**: tt_order_id=81118285 llegó y el detalle de la orden se obtuvo del API.
- **V12**: Sirve para asientos de prensa/VIP. El hold de prueba ho_100649 sigue activo en ev_8865698: bórralo desde el dashboard si estorba.

## Latencia hasta botón gris (V4)

| Occurrence | Vía | Detectado |
|---|---|---|
| ev_8865698 | sync | 2026-08-13T18:42:13.846Z |
| ev_8865698 | sync | 2026-08-13T18:42:13.846Z |
| ev_8865698 | sync | 2026-08-13T18:55:13.843Z |
| ev_8865698 | sync | 2026-08-13T19:37:10.610Z |

## Webhooks recibidos por tipo

- `EVENT.CREATED`: 5
- `EVENT.UPDATED`: 4
- `ISSUED_TICKET.CREATED`: 4
- `ISSUED_TICKET.UPDATED`: 2
- `ORDER.CREATED`: 3
- `ORDER.UPDATED`: 3

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
### `webhook_envelope`

- `created_at` — ejemplo: `"2026-08-13 18:10:32"`
- `event` — ejemplo: `"EVENT.CREATED"`
- `id` — ejemplo: `"wh_6725410"`
- `payload` — ejemplo: `{"object":"event","id":"ev_8865771","access_code":null,"available_status":null,"bundles":[],"call_to_action":"Comprar bo`
- `resource_url` — ejemplo: `"https://api.tickettailor.com/v1/events/ev_8865771"`

## Riesgos encontrados

- **V5 · PARCIAL** — Venta no abierta: fecha de inicio de venta expuesta. Configura una función con fecha de inicio de venta futura (TESTPLAN paso 6) y vuelve a correr.
- **V6 · PARCIAL** — CRÍTICA · Asientos: categorías, precios, sección/fila/asiento. Limitación de cuenta test: eventos gratis (price=0). La estructura de precio por categoría está verificada; los montos reales se confirman en la cuenta pagada del cliente. Para el asiento: compra en el evento con seating chart.
