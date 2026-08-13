# DEMO · Perfil del cliente · guión de 3 minutos

Qué se enseña: el área de cuenta que el sitio del teatro puede construir sobre Ticket Tailor —
entrada sin contraseña, boletos con QR real, historial con asistencia, y actualización en vivo.
Todo corre desde el caché local (SQLite): **cero llamadas al API de TT por visita**.

## Antes de empezar (checklist de 2 minutos)

- [ ] Server corriendo: `npm start` (el arranque hace backfill de órdenes → clientes y boletos).
- [ ] Túnel activo si se demuestra compra + webhook: `cloudflared tunnel --url http://localhost:3000`.
- [ ] Webhook y redirect del dashboard apuntando a la URL del túnel vigente.
- [ ] `/admin` abierto en una pestaña aparte (ahí aparece el enlace de entrada).
- [ ] Teléfono con la app **Ticket Tailor Check-in** si se demuestra el escaneo (paso 4).

## El guión

### 1. Entrar sin contraseña (30 s)

1. Abre `/entrar`. Escribe el email de las compras de prueba (`jwvelez@proton.me`).
2. "El sistema no revela si el correo existe — misma respuesta siempre." (seguridad)
3. El enlace de un solo uso aparece en la **consola del server** y en `/admin` → "Último enlace de entrada". Ábrelo.
4. Aterrizas en `/mi-cuenta` con sesión.

> Si el enlace expira (15 min) o ya se usó, pide otro — es de un solo uso a propósito.

### 2. El perfil ya sabe todo (40 s)

- Cabecera con nombre y "desde {mes}": reconstruido del historial de órdenes (backfill).
- Stats: shows asistidos (escaneos reales), boletos próximos, show favorito.
- Mis boletos: tarjeta por boleto con **QR real del CDN de Ticket Tailor** — el mismo QR que
  valida la app de puerta.
- Historial: cada función pasada con **Asistió / No asistió** (dato del escaneo en puerta).
  Los reembolsados aparecen tachados con "Cancelado" — no desaparecen.

Punto de venta: *nada de esto tocó el API en vivo — es la base de datos propia del teatro,
alimentada por webhooks. El teatro es dueño de su relación con el público.*

### 3. Compra en vivo → aparece sola (45 s)

1. En **otra pestaña**, abre la cartelera (`/`) y compra un boleto de una función futura
   (email del mismo cliente).
2. Vuelve a la pestaña del perfil. **No recargues.** En ≤30 s el boleto nuevo aparece en
   "Próximos boletos" y el contador de stats sube.
3. Qué pasó por debajo: webhook ORDER.CREATED firmado → SQLite → el perfil hace polling
   ligero a su propio servidor cada 30 s.

### 4. Boleto en la puerta (30 s)

1. Clic en **Ver boleto** → pantalla de puerta: QR grande sobre panel claro, show, fecha,
   planta y estado. Diseñada para brillo alto y escaneo rápido.
2. 📱 *[Lo hace Javier]* Escanear el QR de la pantalla con la app oficial de Check-in.
3. El estado del boleto pasa a **"Ya escaneado"** y en el historial esa función quedará
   como **Asistió**. (El escaneo llega vía webhook ISSUED_TICKET.UPDATED o el próximo sync.)

### 5. Reembolso → Cancelado (30 s)

1. En el dashboard de TT, reembolsa/cancela la orden del boleto recién comprado.
2. En el perfil (sin recargar): el boleto sale de "Próximos", y en el historial aparece
   tachado con la etiqueta **Cancelado**.
3. Por debajo: ORDER.UPDATED (`status: "cancelled"`) + ISSUED_TICKET.UPDATED (`voided`) —
   verificados con firma HMAC. La disponibilidad de la función se libera sola en la cartelera.

## Si algo se cae

| Síntoma | Causa probable | Arreglo en vivo |
|---|---|---|
| El boleto no aparece en ≤30 s | túnel caído o URL vieja en el dashboard | `/admin` → "Webhooks recibidos"; si no llegó, revisa el túnel. El sync de 60 s lo trae igual: espera un tick |
| Enlace de entrada no funciona | expiró (15 min) o ya usado | pide otro en `/entrar` |
| QR no carga | es imagen del CDN de TT (requiere internet) | abrir el boleto de nuevo con red |
| "No encontramos esa cuenta" | el email no tiene órdenes | usa el email exacto de las compras de prueba |

## Nota interna (no se dice al cliente)

- `status_message` de las órdenes trae notas internas del staff — **nunca se renderiza** en el perfil.
- La edición de "Mis datos" y las preferencias de correo son locales; no escriben a TT.
- "Recompensas · fase 2" está deshabilitado a propósito: es el gancho de la siguiente fase
  (las columnas `points` y `tier` ya existen en la DB).
