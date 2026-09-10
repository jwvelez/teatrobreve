# TESTPLAN · tb-ticketing-lab

Guía paso a paso para producir la evidencia de las 12 verificaciones. Cada paso indica **quién actúa**:

- 🧑 **TÚ** — acciones en el dashboard de Ticket Tailor, compras, escaneos.
- 🤖 **APP** — lo que el laboratorio verifica solo (o con un clic en `/admin`).

Regla de oro en todo el plan: **ningún veredicto PASA sin dump JSON crudo en `/dumps/` que lo evidencie.** La doc de Ticket Tailor renderiza los esquemas client-side, así que los nombres de campos se descubren del JSON real, nunca de memoria.

---

## Paso 0 · Arranque local

```bash
cd ~/tbtest
npm install
cp .env.example .env        # pega tu TICKET_TAILOR_API_KEY (dashboard → Settings → API)
npm start
```

- Cartelera: http://localhost:3000/
- Panel de hallazgos: http://localhost:3000/admin ← **el entregable**
- Confirmación: http://localhost:3000/gracias

Sin API key, la cartelera muestra datos mock para validar la UI. Con API key, el sync corre cada 60 s y reemplaza el mock con datos reales.

> El app **nunca** llama al API desde el navegador ni por page view: todo pasa por el caché local (`availability_cache`), refrescado por el sync job y por webhooks. Los headers `X-Rate-Limit-Remaining` / `Retry-After` se leen en cada request y hay backoff en 429.

**🤖 V1 · Conexión.** En `/admin`, corre **V1**. Debe quedar PASA con el dump de `/v1/ping` y los headers de rate limit visibles.

---

## Paso 1 · 🧑 Crear el catálogo en el dashboard

En el dashboard de Ticket Tailor:

1. Crea el **seating chart** con dos categorías: **Planta Baja $24.00** y **Planta Alta $18.00** (el API debe reportar 2400 y 1800 centavos).
2. Crea una **serie recurrente** (event series) tipo "show diario" con varias fechas — al menos 4–5 occurrences en el mes, usando el seating chart.
3. Crea UNA función extra con **aforo mínimo: quantity 2** (para agotarla barato en el Paso 5). Puede ser sin asientos si el chart no permite aforo 2.
4. Crea UNA función con **fecha de inicio de venta futura** (para V5).

**🤖 V2 · Catálogo.** Corre **V2** en `/admin`. Confirma:
- ¿Las funciones aparecen como events ligados a la serie? (campo de vínculo literal en "Campos encontrados")
- ¿Qué campos de fecha/hora/estado trae cada una? → revisa el dump y la sección "Campos descubiertos".

**🤖 V3 · Disponibilidad (primera pasada).** Corre **V3**. Anota los nombres literales de total / emitidos / restantes. Quedará PARCIAL hasta que haya compras que cuadrar.

**🤖 V5 · Venta no abierta.** Corre **V5**. Si ningún candidato de campo aparece, abre el dump y busca a mano cómo se llama el campo de inicio de venta; edita la verificación con lo que encuentres.

---

## Paso 2 · 🧑 Túnel local para webhooks

Los webhooks necesitan una URL pública. Con cloudflared (sin cuenta):

```bash
cloudflared tunnel --url http://localhost:3000
```

Copia la URL `https://xxxx.trycloudflare.com` que imprime. (Alternativa: `ngrok http 3000`.)

> La URL de trycloudflare cambia en cada arranque: si reinicias el túnel, actualiza el webhook y el redirect en el dashboard.

---

## Paso 3 · 🧑 Configurar webhook en el dashboard

En el dashboard → **Settings → API → Webhooks** → crear webhook(s):

- URL (la misma para todos): `https://xxxx.trycloudflare.com/webhooks/tickettailor`
- Según la doc de configuración de TT, los tipos disponibles son: **order** (created, updated — incluye cancelaciones), **issued ticket** (created, updated — incluye boletos anulados), **event** (created, updated, deleted) y **waitlist signup** (created). Suscríbete a **todos**; si el selector solo permite un tipo por webhook, crea uno por tipo apuntando a la misma URL.
- **Anota la lista literal que ofrezca el selector** (es evidencia de V7 — solo se ve ahí). Pégala en las notas de V7 con el botón "Editar" en `/admin`.
- **Signing secret: no existe.** El dashboard de Ticket Tailor no expone ninguno — deja `TT_WEBHOOK_SECRET` vacío en `.env`. Parte del hallazgo de V7 es documentar si los requests llegan firmados o no.

**🤖 V7 (parcial).** Si el dashboard tiene botón de "test webhook", úsalo. El receptor:
- guarda el payload crudo en `webhook_log` y `/dumps/webhooks/` (headers incluidos),
- detecta si llega **algún header de firma**; si llega, prueba esquemas HMAC candidatos (formato `t=…,v1=…` estilo Stripe, HMAC-SHA256/SHA1 hex/base64) con dos secretos candidatos: `TT_WEBHOOK_SECRET` (si algún día existe) y el **API key**,
- si NO llega firma, lo registra como hallazgo: en producción la provenance se valida releyendo la orden por API (`GET /v1/orders/{id}`), nunca confiando en el payload del webhook,
- deduplica por id de evento (idempotencia: reintentos de TT no duplican filas).

En `/admin` → "Webhooks recibidos" verás el veredicto de firma por cada payload (✅ / ❌ / — sin firma).

---

## Paso 4 · 🧑 Compra de prueba con asientos

1. En la cartelera local (http://localhost:3000/), clic en **Comprar boletos** de una función con seating chart (o abre el checkout del box office directo).
2. Compra 1 boleto de **Planta Baja** y 1 de **Planta Alta**, eligiendo asientos, con un email real tuyo.

**🤖 Al llegar el webhook de la orden:**
- upsert en `customers` por email, insert en `orders` e `issued_tickets`, alta en `attendance`,
- refresh inmediato de `availability_cache` para ese event (vía "webhook", cronometrado para V4).

**🤖 V7 · Webhooks.** Corre **V7**. Debe quedar PASA si la firma verificó y llegó la orden. Revisa en el dump: ¿`buyer_details` trae nombre, email, teléfono? ¿Line items? ¿Asientos?

**🤖 V3 · Disponibilidad (cierre).** Corre **V3** otra vez: el cruce "emitidos según ticket_types vs issued_tickets del API" debe cuadrar → PASA.

**🤖 V6 · Asientos.** Corre **V6**. Confirma: precios 2400/1800 presentes, disponibilidad por categoría (cada ticket_type trae sus contadores), y que el issued_ticket trae sección/fila/asiento. El dump del issued_ticket completo es la evidencia. Si el runner no detecta el campo de asiento, ábrelo a mano: puede tener otro nombre.

**🤖 V9 · Datos de cliente.** Corre **V9**: recorre `GET /v1/orders` paginado, reconstruye `customers` por email y documenta la PII exacta de `buyer_details`.

---

## Paso 5 · 🧑 Agotar la función de aforo 2 (V4)

1. Compra (o emite gratis desde el dashboard) los 2 boletos de la función de aforo mínimo.
2. Deja la cartelera local abierta y **cronometra**: la fila debe ponerse **Agotado** (gris) sola.

**🤖 V4 · Agotado.** El app registra cada transición a agotado con su vía:
- **webhook**: al llegar la orden, releyendo el event al instante,
- **sync**: el job de 60 s.

Corre **V4** en `/admin`: reporta si el API expone estado explícito de agotado o solo se infiere de restantes = 0, y los timestamps por ambas vías (la diferencia es la latencia medida que pide FINDINGS). PASA cuando hay detección por las dos vías.

> La cartelera refresca su UI desde el caché cada 15 s; la latencia que importa es webhook→caché vs sync→caché, que queda en `soldout_transitions`.

---

## Paso 6 · 🧑 Verificar "venta no abierta" en la cartelera

Con la función del Paso 1.4 (venta futura), confirma en la cartelera local que aparece **Avísame / PRONTO** y corre **V5** de nuevo si quedó pendiente.

---

## Paso 7 · 🧑 Redirect post-compra (V11)

1. Dashboard → configuración del evento/box office → **URL de redirección post-compra** (completed order redirect): `https://xxxx.trycloudflare.com/gracias`
2. Haz otra compra de prueba y déjate redirigir.

**🤖 V11.** La página `/gracias` muestra `tt_order_id`, `tt_order_value`, `tt_currency`, `tt_event_id`, y consulta el detalle de la orden por API (con dump). Corre **V11** en `/admin`: PASA si llegó un hit con `tt_order_id` y el fetch de la orden funcionó.

---

## Paso 8 · 🧑 Reembolso (V8)

1. En el dashboard, **reembolsa/anula** una de las órdenes de prueba (idealmente una de la función agotada, para ver si libera aforo).
2. Observa `/admin` → "Webhooks recibidos": ¿llegó un evento propio de refund o un `order.updated`? El tipo literal queda registrado.

**🤖 V8.** Corre **V8**: documenta el webhook recibido, relee la orden por API (¿cómo queda `status`? ¿hay campo de refund?) y compara la disponibilidad en caché antes/después (¿se liberó el lugar?). Marca PASA/FALLA según lo observado con el botón Editar.

---

## Paso 9 · 🧑 Check-in (V10)

1. Instala la app oficial **Ticket Tailor Check-in** en el teléfono y escanea uno de los boletos de prueba.

**🤖 V10.** Corre **V10**: prueba los endpoints candidatos de check-ins y además busca campos de check-in dentro de `issued_tickets`. PASA si por API se puede saber qué boleto se escaneó y cuándo (eso alimenta "asistió / no asistió" en `attendance`).

---

## Paso 10 · 🤖 Holds (V12)

Corre **V12** en `/admin`: intenta `POST /v1/holds` (asientos de prensa/VIP), vuelca la respuesta cruda —éxito o error— y relee la disponibilidad para verificar el descuento. Si el shape del body no es el esperado, el dump del error dice qué pide el API; ajusta y repite.


---

# Compartir boletos con el corillo (pasos 12–14)

El punto se gana al **escanear** en la puerta, no al reclamar, y solo lo gana quien tenga
el boleto **reclamado** a su cuenta. Estos pasos prueban eso de punta a punta.

## Paso 12 · 🧑 Compra de varios boletos en una orden

1. Compra **4 boletos** de una misma función con tu correo de prueba.
2. Al llegar el webhook `ORDER.CREATED`, el lab crea una fila de `ticket_assignments` por
   boleto con el comprador como `owner`.
3. Entra a `/mi-cuenta` → cada boleto muestra la etiqueta **Mío** y un enlace **Repartir →**.

## Paso 13 · 🤖 Repartir y reclamar

1. En `/mi-cuenta/orden/<or_xxx>` escribe un correo distinto en 3 de los 4 boletos y dale
   **Enviar**. El cuarto se queda contigo.
2. **No hay envío real de correo.** El enlace de reclamo sale en la consola del server y en
   `GET /api/ticket-email` (el HTML completo del correo también).
3. Abre el enlace en una ventana privada: crea la cuenta de esa persona, la deja con sesión
   iniciada y el boleto aparece en **su** `/mi-cuenta` marcado *Reclamado por ti*.
4. En tu cuenta ese boleto ahora dice **Reclamado por x@y.com** y ya no se puede recuperar.

Cosas que vale la pena probar porque están cubiertas por código:
- **Recuperar** un boleto enviado pero no reclamado → vuelve a *Mío*.
- Intentar **revocar uno ya reclamado** → lo rechaza.
- Reusar un enlace de reclamo → *inválido o ya usado* (un solo uso).
- Mandar 11 veces desde la misma orden en una hora → el 11.º da **429** (rate limit).

## Paso 14 · 🧑 Escanear y ver el punto

1. Escanea con la app oficial de Check-in **el boleto de una persona que SÍ reclamó** y
   **el de una que NO reclamó**.
2. Corre el sync (o espera el ciclo de 60 s) para ingerir los check-ins.
3. En `/mi-cuenta` → **Mis puntos**:
   - quien reclamó y fue escaneado: **1 punto**
   - quien no reclamó: **0 puntos**, aunque su boleto se haya escaneado
4. Si esa persona reclama **después** del escaneo, el punto se le otorga igual (reclamo
   tardío). Esa es la razón de evaluar en los dos eventos.

Las tres reglas están cubiertas por runners automáticos que montan su escenario y lo
revierten (no ensucian la base): **V13**, **V14** y **V15** en `/admin`.


---

# El Pase · pase de temporada (pasos 18–23)

## Lo que decidió el modelo (ya ejecutado el 2026-09-10)

| Verificación | Resultado | Consecuencia |
|---|---|---|
| **V24** monto fijo, ¿por orden o por boleto? | **EN CONTRA**: 2 × $10 con código de $10 → total **$0.00**, `times_redeemed` = 1 | Los códigos de descuento **no sirven** para el pase (un uso regala N boletos) |
| **V23** ¿alcance del discount por API? | A favor (`ticket_type_id[tt_xxx]=1`) | Irrelevante tras V24; queda como hallazgo |
| **V18** ¿"Members only" + seating chart? | **A FAVOR**: `tt_6795478` es `members_only` y `Seated` | **El Pase se construye sobre membresías nativas de TT** |

> Si alguna vez hay que repetir V24: crea un discount `fixed_amount` de $10 en un ticket type de
> $10, mete **2** en una canasta y mira el total antes de pagar. $10 = por orden; $0 = por boleto.

## Paso 18 · 🧑 Montar las tres piezas en el dashboard (una planta)

Ya están creadas para Planta Baja. Para otra planta, repetir las tres:

1. **Settings → Memberships → Create membership type**: nombre (`Abonados 2026 · Alta`),
   *Valid from: the date of issue*, *Expires: a scheduled **date*** (el cierre real de la
   temporada — OJO: el actual vence el **4 nov 2026**), *Number of redemptions: set limit to* **8**.
2. **Products → Add product**: nombre, precio (lo que paga el abonado, TT suma IVU y fees),
   *Fulfilment: **Issue a membership*** → el membership type del paso 1, *Sell in Store* ✓.
   Anota el `pr_xxxxx`.
3. En la **serie** de la temporada, **Add ticket type**: `Planta Alta - El Pase`, precio **0**,
   status **Members only** → el membership type del paso 1, asígnale las categorías de esa planta
   del seating chart, **Max per order: 1**, aforo = butacas reservadas para abonados. Al ser
   serie recurrente, aparece solo en **todas** las funciones.
4. Copia el **enlace de compra del producto** (Products → el producto → ver en tienda). El API no
   lo expone y TT bloquea el scraping: hay que pegarlo a mano en el paso 20.

## Paso 19 · 🧑 Webhooks de membresía

En Settings → API → Webhooks añade (misma URL del túnel):

| Event | Para qué |
|---|---|
| **ISSUED_MEMBERSHIP.CREATED** | TT avisa cuando emite la membresía al comprar el pase → el pase pasa de `pending` a `active` al instante |
| **ISSUED_MEMBERSHIP.UPDATED** | cambios de estado (void, vencimiento) |

Sin ellos también funciona: el sync localiza la membresía en el siguiente ciclo (60 s).

## Paso 20 · 🤖 Registrar el pase en el lab

En `/admin` → **El Pase · productos**, llena el formulario (o por API):

```bash
curl -X PUT localhost:3000/api/pase/productos -H 'Content-Type: application/json' -d '{
  "id": "pase-2026-baja", "name": "El Pase · Planta Baja", "planta": "baja",
  "tt_product_id": "pr_80783", "membership_type_id": "mt_9760", "ticket_type_id": "tt_6795478",
  "store_url": "<enlace de compra del producto>"
}'
```

Valida contra TT antes de guardar y **falla ruidoso**: producto inexistente, fulfilment que no
emite ese membership type, ticket type que no es members-only o no cuesta $0. Avisa (sin
bloquear) si `max_per_order` ≠ 1 o falta `store_url`. El dump de la validación queda enlazado.

## Paso 21 · 🧑 Comprar El Pase desde el perfil

1. Entra a `/mi-cuenta` con un correo **sin** pase → menú **El Pase** → card de compra →
   **Comprar El Pase** (modal con el checkout de TT; el pago salta a pestaña hasta el custom domain).
2. Completa la compra con **ese mismo correo**.
3. Llega `ORDER.CREATED` con `line_items[].item_id = pr_80783` → `/admin` → pases emitidos muestra
   el pase en `pending`, y en segundos (webhook de membresía) o ≤60 s (sync) pasa a **`active`**
   con `im_xxxxx`, su `code`, y **8 / 8**.
4. En `/mi-cuenta` → El Pase: saldo, vigencia, funciones con botón **Reservar**.

## Paso 22 · 🧑 Redimir una función — cierra V22

1. En El Pase → copia tu **código de membresía** (botón Copiar) → **Reservar** en una función.
2. En el checkout pulsa **"Use membership code"**, pega el código → aparece **"Planta Baja - El
   Pase" a $0** (sin código solo salen los boletos regulares a $30: TT no reconoce al abonado por
   correo). Escógelo, elige butaca, confirma. `max_per_order=1`: una butaca por reserva.
3. **Preaplicación por URL: ya probada, NO funciona (V21 FALLA).** `?membership_code=`, `?code=`
   y `?membership=` no hacen nada; solo vale el botón "Use membership code". Si TT documenta un
   parámetro nuevo, pruébalo aquí y actualiza V21.
4. Llega `ORDER.CREATED` con `total = 0` y el ticket type del pase → `pass_redemptions` + relectura
   de TT → el perfil muestra **7 / 8** y la función como *Reservada*.
5. Corre **V22** en `/admin`: PASA si el webhook de la orden a $0 trae el ticket type del pase.

Cosas que vale la pena romper a propósito (deben acabar en `/admin` como anomalía, no en silencio):
- Intentar meter **2** boletos del pase en una canasta → `max_per_order` lo impide; si pasara,
  `multi_ticket_redemption`.
- Emitir una membresía **a mano** desde el dashboard a un correo nuevo y reservar con ella →
  `redemption_without_pass` primero, y el lab importa la membresía como pase sin orden.

## Paso 23 · 🧑 Agotar el pase — cierra V25

Reserva funciones hasta llegar a **8 / 8**. Luego: (a) corre **V25** — lee `redemptions` e
`is_valid` de la membresía y confirma que no hay `over_redemption`; (b) a mano, entra al checkout
de otra función con ese abonado y confirma que **"Planta Baja - El Pase" ya no aparece**.

Con la cuenta de prueba no hace falta pagar $256 ocho veces: el lab ya tiene un pase de demo
enlazado a una membresía **real** (`im_159964`, jwvelez+probe@gmail.com) emitida por API.

---

## Paso 11 · Generar FINDINGS.md

Cuando la tabla de `/admin` esté completa (nada relevante en PENDIENTE):

```bash
npm run findings
```

Genera `FINDINGS.md` con: veredictos de las 12 verificaciones, nombres literales de todos los campos descubiertos, latencia medida webhook/sync → botón gris, y riesgos encontrados (todo lo FALLA/PARCIAL). **Ese documento decide la arquitectura del proyecto real.**

---

## Mapa rápido de evidencia

| Verificación | Quién dispara | Evidencia |
|---|---|---|
| V1 conexión | 🤖 runner | dump de /ping + headers |
| V2 catálogo | 🧑 paso 1 → 🤖 runner | dump event_series + events |
| V3 disponibilidad ★ | 🧑 paso 4 → 🤖 runner | dump + cruce issued_tickets |
| V4 agotado ★ | 🧑 paso 5 → 🤖 automático | soldout_transitions + dump |
| V5 venta no abierta | 🧑 paso 1.4 → 🤖 runner | dump events |
| V6 asientos ★ | 🧑 pasos 1.1 y 4 → 🤖 runner | dump issued_ticket completo |
| V7 webhooks ★ | 🧑 paso 3–4 → 🤖 automático | webhook_log + dumps/webhooks |
| V8 reembolso | 🧑 paso 8 → 🤖 runner | dump webhook + orden releída |
| V9 clientes | 🧑 paso 4 → 🤖 runner | dump orders + tabla customers |
| V10 check-in | 🧑 paso 9 → 🤖 runner | dump checkins / issued_tickets |
| V11 redirect | 🧑 paso 7 → 🤖 automático | gracias_hits + dump de la orden |
| V12 holds | 🤖 runner | dump del POST + releído |
| V13 punto reclamado+escaneo ★ | 🤖 runner | dump del escenario antes/después |
| V14 sin reclamar no otorga ★ | 🤖 runner | dump con el reclamo tardío |
| V15 dos boletos, un punto | 🤖 runner | dump del ledger |
| V18 members only + seating ★ | 🧑 paso 18 → 🤖 runner | dump del ticket type members_only + Seated |
| V21 preaplicar código por URL | 🧑 paso 22.3 (solo navegador) | **FALLA** documentada con las URLs probadas |
| V22 orden $0 dispara webhook ★ | 🧑 paso 22 → 🤖 runner | **PASA**: redención real or_82725048 a $0 |
| V23 alcance por API ★ | 🤖 runner | dump del POST + discount releído |
| V24 monto fijo orden vs boleto ★ | 🧑 cuenta pagada → 🤖 runner | **FALLA** documentada: canasta 2×$10 → $0.00 |
| V25 agotar la membresía | 🧑 paso 23 → 🤖 runner | dump de la membresía al límite |
