/**
 * Etiqueta humana del asiento. Una sola fuente para todas las pantallas y el correo.
 *
 * Lo que llega de TT ("reservation" del issued_ticket, verificado 2026-09-10 con la
 * primera compra Seated real, it_135898047): un STRING con la etiqueta de la butaca,
 * "23-3". El chart de Teatro Breve es de MESAS: "23-3" = mesa 23, asiento 3.
 * En compras GA llega null → sin asiento.
 */
export function seatLabel({ section, row, number } = {}) {
  if (!section && !row && !number) return null;
  const parts = [];
  if (row) {
    parts.push(`Fila ${row}`);
    if (number) parts.push(`Asiento ${number}`);
  } else if (number) {
    const m = /^\s*([A-Za-z0-9]+)\s*-\s*([A-Za-z0-9]+)\s*$/.exec(String(number));
    if (m) parts.push(`Mesa ${m[1]}`, `Asiento ${m[2]}`);
    else parts.push(`Asiento ${String(number).trim()}`);
  }
  return parts.join(', ') || null;
}

/**
 * La planta que se muestra. El ticket type del pase se llama "Planta Baja - El Pase"
 * (nombre puesto en el dashboard): se quita el sufijo para que el boleto diga
 * "Planta Baja - Mesa 23, Asiento 3" y no "Planta Baja - El Pase - Mesa 23…".
 */
export function plantaOf(description) {
  if (!description) return null;
  return String(description).replace(/\s*-\s*El Pase\s*$/i, '').trim() || null;
}

/** "Planta Baja - Mesa 23, Asiento 3" (o solo la planta si es GA). */
export function seatWithSection(planta, label) {
  return [planta, label].filter(Boolean).join(' - ') || null;
}

export function seatOf(t) {
  if (!t || (!t.seat_section && !t.seat_row && !t.seat_number)) return null;
  return {
    section: t.seat_section ?? null,
    row: t.seat_row ?? null,
    number: t.seat_number ?? null,
    label: seatLabel({ section: t.seat_section, row: t.seat_row, number: t.seat_number }),
  };
}
