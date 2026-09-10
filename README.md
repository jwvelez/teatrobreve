# tb-ticketing-lab

Laboratorio de descubrimiento y demo contra el **API real de Ticket Tailor** para el proyecto
del teatro (Teatro Breve). No es código de producción: es la prueba de que la integración
vendida se puede construir, con **evidencia en dumps JSON crudos**, más un **demo presentable
del perfil del cliente**.

**Estado al 10 de septiembre de 2026: 16 de 21 verificaciones PASA · 3 PARCIAL · 2 FALLA.**
Las FALLA son **V21** (no se puede preaplicar el código de membresía por URL: fricción aceptada)
y **V24**, que se queda así a propósito: es la prueba real de que un código de descuento
de monto fijo se aplica **por boleto** — el hallazgo que descartó el primer diseño de El Pase y
lo movió a **membresías nativas de TT** (ver "El Pase"). Construidos y probados contra el API real:
el perfil del cliente, compartir boletos con el corillo, y el MVP de El Pase.

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
| `/mi-cuenta/orden/:orderId` | Reparto del corillo: los boletos de esa compra, a quién se le mandó cada uno |
| `/reclamar/:token` | Reclamo de un boleto recibido: crea o busca la cuenta, emite sesión y lo guarda |
| `POST /api/boletos/:id/enviarme` | "Enviármelo por email": copia del boleto (QR inline, mesa y asiento) al correo de la sesión, sin token |
| `/mi-cuenta` → **El Pase** | Comprar el pase (modal), ver saldo de funciones leído de TT, reservar función por función, historial |
| `/admin` → **El Pase** | Alta y validación de pass_products, pases emitidos con saldo, panel de anomalías |

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
  verifications.js Runners V1–V15 + V18, V22–V25 (se corren desde /admin o por POST /api/verifications/:id/run)
  auth.js          Enlace mágico: tokens hasheados 15 min, cookie firmada HMAC 7 días, rate limit en memoria
  profile.js       Perfil: stats, próximos, historial, boleto, datos locales, preferencias
  sharing.js       Corillo: reparto de boletos, tokens de reclamo, ledger de puntos, correo
  pase.js          El Pase: catálogo validado contra TT, compra→membresía, espejo de redenciones, anomalías
  findings.js      Genera FINDINGS.md desde la DB (npm run findings)
  mock.js          Cartelera mock cuando no hay API key
public/
  index.html       Cartelera (Lista/Mes, filtros, modal con widget oficial de TT, pre-llenado con sesión)
  gracias.html     Confirmación (normaliza tt_order_id sin prefijo → or_, frame-buster si cae en iframe)
  admin.html       Panel de hallazgos
  entrar.html, cuenta.html, boleto.html   Perfil del cliente
  orden.html       Pantalla de reparto: un correo por boleto, enviar / reenviar / recuperar
  styles.css       Tokens del sitio real (#0B1211, #C6F24B, Archivo + Martian Mono)
```

### Tablas SQLite

`shows` (event_series) · `occurrences` (events) · `ticket_types` · `availability_cache`
(occurrence+ticket_type → quantity/issued/remaining/status) · `customers` (email único; `points`
y `tier` listos para fase 2, sin uso) · `customer_prefs` · `orders` · `issued_tickets` (con QR,
precio, asiento, checked_in normalizado, voided_at) · `attendance` · `webhook_log` (dedupe por
id de evento) · `verifications` · `soldout_transitions` (evidencia de latencia V4) ·
`field_discovery` · `gracias_hits` · `login_tokens` · `meta` · `debug_messages`
(postMessages capturados del modal, ver `/api/debug/messages`) · `ticket_assignments` y
`loyalty_points` (ver "Compartir boletos con el corillo") · `pass_products` · `season_passes` ·
`pass_redemptions` · `pass_anomalies` (ver "El Pase").

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
- Asiento: campo `reservation` en el boleto. `null` en compras GA; en compras **Seated** llega
  como **STRING con la etiqueta de la butaca** (`"23-3"` = mesa 23, asiento 3 — el chart de
  Teatro Breve es de mesas), no como objeto. `src/seat.js` lo convierte en "Mesa 23, Asiento 3" y
  todas las pantallas y el correo muestran "Planta Baja - Mesa 23, Asiento 3".
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

## Compartir boletos con el corillo (MVP construido)

Compro 4 boletos, le mando a cada quien el suyo por correo, y cada persona lo reclama en su
propia cuenta. **El punto se gana al ESCANEAR el QR en la puerta, no al reclamar.**

### Las reglas de puntos (son estrictas y están verificadas)

| Regla | Verificación |
|---|---|
| Reclamado + escaneado = 1 punto, y reevaluar no duplica | **V13 PASA** |
| Enviado pero NUNCA reclamado no otorga punto, aunque se escanee | **V14 PASA** |
| Dos boletos de la misma función en la misma persona = 1 punto | **V15 PASA** |

- El comprador solo gana por el boleto **que se quedó**, no por los que envió.
- Un punto **por persona por FUNCIÓN**, no por boleto: el ledger es
  `UNIQUE(customer_id, occurrence_id)`.
- **El reclamo puede ocurrir DESPUÉS del escaneo.** Por eso los puntos se evalúan en los dos
  eventos (al reclamar y al ingerir un check-in) y `evaluatePointsForTicket()` es idempotente.

### El ciclo

1. **Ingesta** — al guardar cada boleto se crea su fila en `ticket_assignments` con el
   comprador como `owner`. Es idempotente: el backfill no pisa un envío ni un reclamo.
2. **Envío** — `POST /api/boletos/:id/enviar` genera un token de reclamo (32 bytes, guardado
   **hasheado** como `login_tokens`), marca `sent` y dispara el correo. Se hace desde
   `/mi-cuenta/orden/:id` o en línea desde cada boleto próximo (**Enviar a otra persona**).
   Aparte, **Enviármelo por email** (`POST /api/boletos/:id/enviarme`) manda al dueño una copia
   de su propio boleto — QR inline, show, fecha, lugar, planta, mesa y asiento — sin token ni
   cambio de estado: es para tener el QR en el inbox sin entrar al sitio desde el celular.
   Autoriza contra la sesión (dueño = quien lo reclamó, o el comprador) y tiene su propio
   rate limit (10/hora por correo).
3. **Reclamo** — `GET /reclamar/:token` valida, **crea la cuenta si no existe**, emite la
   cookie firmada de `auth.js`, marca `claimed` y evalúa puntos (por si ya lo escanearon).
4. **Escaneo** — al ingerir el check-in se reevalúan los puntos del boleto.

### Tablas

| Tabla | Qué guarda |
|---|---|
| `ticket_assignments` | quién tiene cada boleto: `holder_email`, `status` (owner/sent/claimed/revoked), token de reclamo hasheado |
| `loyalty_points` | el ledger. `UNIQUE(customer_id, occurrence_id)` = un punto por función |

### Seguridad

- **Token de reclamo:** 32 bytes aleatorios, solo se guarda el hash, de un solo uso, atado a
  (boleto, correo destinatario), y vence al cierre del día de la función + 7 días — con piso
  de 7 días desde el envío, para que un boleto de una función pasada no nazca vencido.
- **Rate limit obligatorio:** 10 envíos por orden por hora. Este endpoint manda correo a una
  dirección arbitraria, así que es un vector de spam. Verificado: el 11.º da 429.
- **Autorización contra la sesión, nunca contra un parámetro:** solo el comprador de la orden
  puede enviar o revocar. Verificado: 403 en orden ajena y boleto ajeno, 401 sin sesión.
- Un boleto ya reclamado **no se puede revocar ni reasignar**.

### Huecos conocidos del corillo

1. **El enlace de reclamo es un portador (bearer token).** Quien REENVÍE el correo le regala el
   boleto a quien lo abra primero. Es aceptable para el MVP — el QR ya era reenviable igual —
   pero en producción conviene atar el reclamo a una verificación del correo destinatario.
   Está dicho explícitamente en el encabezado de `src/sharing.js`.
2. **No hay envío real de correo** (igual que el enlace mágico): `sendTicketEmail()` imprime en
   consola y guarda el HTML en `meta`, visible en `/api/ticket-email`. Es la interfaz limpia
   para enchufar Resend/Postmark/SES.
3. **Los puntos no tienen `tier` todavía.** La columna existe en `customers` y queda sin uso.

## El Pase — pase de temporada (MVP construido)

> **Decisión de diseño, verificada con pruebas reales el 10 de septiembre de 2026:** El Pase se
> construye sobre las **membresías nativas de Ticket Tailor**, no sobre códigos de descuento.
> El primer diseño (un código de monto fijo por show) **se descartó por V24** — ver abajo.

### Por qué no códigos de descuento (V24, la FALLA que se queda)

Con la cuenta de eventos pagados: un código `fixed_amount` de **$10** con `max_redemptions=1`,
aplicado a una canasta de **2 × $10**, dejó el total en **$0.00**. TT aplica el monto **por cada
boleto** del ticket type en la canasta, y `max_redemptions` cuenta **órdenes** (`times_redeemed`
subió solo a 1). **Un solo uso regala N boletos.** El porcentaje tiene el mismo problema, y bajar
`max_per_order` en el ticket type regular rompería las compras normales de 6 boletos. Evidencia:
`/dumps/v24-*`.

### El modelo

**Una planta = un membership type + un producto + un ticket type "Members only".** Todo se crea a
mano en el dashboard de TT (el API no crea ni productos ni ticket types); el lab lo enlaza y lo
valida antes de guardarlo.

| Pieza en TT | Ejemplo real | Para qué |
|---|---|---|
| **Membership type** | `mt_9760` "Abonados 2026" · `max_redemptions` 8 · vence en fecha fija | La llave. **TT lleva el contador** (`issued_membership.redemptions`) |
| **Producto** | `pr_80783` "El Pase" $256 · fulfilment **Issue a membership** → 9760 | Lo que se cobra. **TT emite la membresía sola al comprarlo** |
| **Ticket type** | `tt_6795478` "Planta Baja - El Pase" · $0 · `members_only` · `Seated` · `max_per_order` 1 · aforo 50 | El boleto que **solo ve** quien tiene la membresía. Butaca real del chart |

Con esto **el acceso lo hace cumplir Ticket Tailor**: sin membresía el boleto no existe en el
checkout; cada compra a $0 gasta una redención; al llegar al límite deja de aparecer. Y como
`max_per_order=1` vive **solo** en ese ticket type, la familia que quiere 6 boletos regulares
no se ve afectada.

**Nuestra base es espejo, no guardia.** Cuenta para mostrar el saldo en el perfil y para detectar
lo que no debería pasar (`pass_anomalies`, ruidoso en `/admin`). Nunca arregla nada en silencio.

### El ciclo

1. **Catálogo** (`/admin` → El Pase): se registra el `pass_product` con los tres ids. Se valida
   contra TT — que el producto exista, que su fulfilment emita **ese** membership type, que el
   ticket type esté en caché, sea `members_only` y cueste $0 — y falla ruidoso si no.
2. **Compra**: el abonado da **Comprar El Pase** en su perfil → modal con el checkout de TT →
   llega `ORDER.CREATED` con el producto en `line_items[].item_id` → se crea el `season_pass`
   en `pending` y se **localiza la membresía** que TT emitió (listando `/issued_memberships` y
   cruzando por correo + tipo: **el endpoint ignora los filtros**). Si aún no existe, se reintenta
   en cada ciclo del sync; si pasan 10 min, anomalía `membership_not_found`.
3. **Redención**: en **El Pase** del perfil, cada función futura tiene **Reservar** → modal con
   el checkout de esa función. **TT no reconoce al abonado por su correo**: el checkout tiene un
   botón **"Use membership code"**, y solo al pegar el `code` de la membresía (ej. `MM3K5QLHZ`)
   aparece "Planta Baja - El Pase" a $0. Por eso el perfil muestra el código grande, con botón
   de copiar y los tres pasos. Escoge su butaca, confirma → llega `ORDER.CREATED` a $0 con ese
   ticket type → espejo en `pass_redemptions` y **relectura del contador de TT**.
4. **Contadores**: cada tick del sync relee `redemptions` de cada membresía (1 llamada por
   pase) y deriva el estado: `active` · `exhausted` · `expired` · `voided`. Además TT lista cada
   redención en `redemption_collection[]` con **`linked_order_id`** (descubierto en la primera
   redención real): el espejo se cruza **orden por orden**; si TT tiene una que no vimos (webhook
   perdido), se importa y se avisa (`redemption_missing_locally`).
5. **Anomalías** (visibles en `/admin` con borde rojo): `over_redemption` (TT dejó pasar más del
   límite), `multi_ticket_redemption` (más de 1 boleto en una orden del pase), `redemption_not_free`
   (la redención no salió en $0), `redemption_without_pass` (alguien usó el boleto members-only y
   no tenemos su pase), `counter_mismatch` (vimos más redenciones que TT), `membership_not_found`.

### Tablas

| Tabla | Qué guarda |
|---|---|
| `pass_products` | el catálogo: `tt_product_id`, `membership_type_id`, `ticket_type_id`, `show_id`, precio, `max_redemptions`, `season_end`, `store_url` |
| `season_passes` | el pase de cada persona: `issued_membership_id`, `membership_code`, `status`, `redemptions` (espejo), `valid_to`, `raw` |
| `pass_redemptions` | una fila por orden de redención. `UNIQUE(season_pass_id, order_id)` |
| `pass_anomalies` | lo que no debería pasar, con `resolved_at` para cerrarlas a mano |

### Verificaciones

| # | Qué decide | Veredicto |
|---|---|---|
| **V24** | Monto fijo: ¿por orden o por boleto? | **FALLA** — por boleto. Mató el modelo de códigos |
| **V23** | ¿Alcance del discount a ticket types por API? | PASA (`ticket_type_id[tt_xxx]=1`) — ya no se usa, queda como hallazgo |
| **V18** | ¿`members_only` convive con seating chart? | **PASA** — `tt_6795478` es `members_only` **y** `Seated` a la vez |
| **V21** | ¿Preaplicar el código de membresía por URL? | **FALLA** — solo el botón "Use membership code" (copiar y pegar) |
| **V22** | ¿Una orden de $0 dispara el webhook? | **PASA** — redención real `or_82725048`: `ORDER.CREATED` con `total` = 0 y el ticket type del pase |
| **V25** | Al agotar `max_redemptions`, ¿deja de aparecer el boleto? | PARCIAL — va 1/8 en el pase de demo; que el checkout ya no lo muestre se confirma a mano |

### Huecos conocidos de El Pase

1. **La garantía de butaca es de BLOQUE, no de asiento.** El ticket type del pase tiene su propio
   aforo (50) sobre categorías del chart: esas butacas quedan reservadas para abonados como
   conjunto, pero el abonado escoge la suya **al reservar cada función** — si tarda, las mejores
   se van. No hay asiento fijo de temporada en este MVP.
2. **Precios ya no condicionan el pase.** Con membresías, el boleto del abonado cuesta $0 sin
   importar el precio del boleto regular; lo que está congelado durante la temporada es el
   **precio del producto** y `max_redemptions`. (El requisito de congelar precios por show era
   del modelo de códigos y desapareció con él.)
3. **El código de membresía se escribe a mano en el checkout.** TT no reconoce al abonado por
   correo, y la preaplicación por URL **no funciona** (V21 FALLA: `?membership_code=`, `?code=` y
   `?membership=` probados en el navegador; `widget.js` no maneja membresías). Es fricción real:
   copiar el código del perfil y pegarlo en "Use membership code". Si TT documenta un parámetro,
   se añade al botón Reservar sin tocar el modelo.
4. **`store_url` se pega a mano.** TT bloquea el scraping de la tienda, así que el enlace de compra
   del producto se copia del dashboard al formulario de `/admin`. Sin él, el botón "Comprar El
   Pase" del perfil sale deshabilitado (y lo dice).
5. **El checkout ocurre en TT** (no hay `POST /orders`). Va embebido en el modal del sitio; el paso
   de pago salta a pestaña nueva hasta que se active el **custom domain** (hueco #1 del README) —
   entonces todo se queda en el modal sin cambiar código.
6. **`GET /issued_memberships` ignora los filtros** (`?email=`, `?membership_type_id=`): se lista
   todo y se cruza localmente. Con cientos de abonados conviene cachear la lista por tick.
7. **Una membresía emitida no se borra por API** (`DELETE` → 404). Queda una de prueba en la
   cuenta: `im_159964` (jwvelez+probe@gmail.com), útil para el demo del perfil.
8. **Los créditos de TT no se leen por API**: si una orden de $0 consume crédito se confirma en
   Billing del dashboard.
9. **Planta Alta no está montada todavía**: requiere su propio membership type + producto +
   ticket type (si compartiera el membership type, el abonado de Alta vería el boleto de Baja).

## Fase 2 ya preparada (sin construir)

- Columna `tier` en `customers` (niveles de recompensa; `points` ya se usa por el corillo).
- `waitlist_signup.created` ya se recibe por webhook → base del "Avísame cuando abra" real.
