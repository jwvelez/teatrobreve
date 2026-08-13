/**
 * Seed mock para la cartelera cuando aún no hay datos reales del API.
 * 5 shows: semanal lunes, semanal martes, semanal miércoles, temporada jue–dom,
 * y uno marcado 'soon'. Solo se sirve si la DB está vacía; el primer sync real
 * lo reemplaza automáticamente.
 */
export function mockCartelera() {
  const shows = [
    { title: 'Lunes de Micrófono Abierto', slug: 'micro-abierto', dow: [1], time: '20:30', lower: 1800, upper: 1800 },
    { title: 'Martes de Impro', slug: 'martes-impro', dow: [2], time: '20:30', lower: 1800, upper: 2400 },
    { title: 'Miércoles de Stand-Up', slug: 'miercoles-standup', dow: [3], time: '21:00', lower: 1800, upper: 2400 },
    { title: 'La Función Estelar', slug: 'funcion-estelar', dow: [4, 5, 6, 0], time: '21:30', lower: 1800, upper: 2400 },
    { title: 'Especial Sorpresa (próximamente)', slug: 'especial-sorpresa', dow: [6], time: '23:00', lower: 2400, upper: 2400, soon: true },
  ];

  const out = [];
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), 1);
  const end = new Date(today.getFullYear(), today.getMonth() + 2, 0); // este mes + el siguiente

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    for (const s of shows) {
      if (!s.dow.includes(d.getDay())) continue;
      const date = d.toISOString().slice(0, 10);
      const idx = out.length;
      // variedad de estados para probar la UI: algún agotado y algún "últimos boletos"
      let status = s.soon ? 'soon' : 'onsale';
      if (!s.soon && idx % 11 === 3) status = 'soldout';
      else if (!s.soon && idx % 7 === 2) status = 'low';
      out.push({
        id: `mock-${s.slug}-${date}`,
        showTitle: s.title,
        showSlug: s.slug,
        date,
        time: s.time,
        priceLower: s.lower,
        priceUpper: s.upper,
        status,
        thumbnailUrl: null,
        checkoutUrl: 'https://prticket.com/demo',
        remaining: status === 'soldout' ? 0 : status === 'low' ? 8 : 60,
        lastSyncedAt: null,
      });
    }
  }
  return out;
}
