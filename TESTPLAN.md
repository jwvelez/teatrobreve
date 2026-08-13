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
