/**
 * Precios REFERENCIALES (estimados) para el generador de cotizaciones.
 *
 * ⚠️ Gladymar todavía no entregó su lista de precios oficial. Estos valores son
 * aproximados y coherentes con el mercado boliviano, SOLO para que la cotización
 * funcione en el demo. Toda cotización se marca como "referencial, sujeta a
 * confirmación del asesor". Cuando llegue la lista oficial, se reemplaza acá.
 */

export interface PrecioRef {
  precio: number; // Bs por unidad de medida
  unidad: string; // "m²" | "unidad" | "bolsa"
}

/** Variación determinista por producto (-12%..+12%) para que no salgan todos iguales. */
function variacion(desc: string): number {
  let h = 0;
  for (const c of desc) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return ((h % 25) - 12) / 100;
}

function formatoDe(texto: string): string {
  const m = texto.toUpperCase().match(/(\d{2,3})\s*[X×]\s*(\d{2,3})/);
  return m ? `${m[1]}X${m[2]}` : "";
}

function categoriaDe(texto: string, hint?: string): string {
  const t = (hint ? hint + " " : "") + texto.toLowerCase();
  if (/(griferia|grifer[ií]a|grifo|mezclador|ducha|monocomando|lavaplatos)/.test(t)) return "GRIFERIA";
  if (/(inodoro|lavamanos|lavabo|sanitario|tanque)/.test(t)) return "SANITARIOS";
  if (/(perfil|junta)/.test(t)) return "PERFILES";
  if (/(adhesivo|pegamento|cemento|fragu|fragüe)/.test(t)) return "CEMENTO";
  if (/(importad|eliane|ceusa|castelatto|portinari|embramaco)/.test(t)) return "PISOS IMPORTADOS";
  return "GLADYMAR"; // porcelanato/cerámica nacional por defecto
}

const BASE_M2: Record<string, Record<string, number>> = {
  GLADYMAR: { "41X41": 62, "60X60": 89, "80X80": 118, "90X90": 139, DEF: 95 },
  "PISOS IMPORTADOS": { "10X10": 245, "45X15": 210, "20X120": 179, "60X120": 199, "90X90": 189, "100X100": 229, "120X120": 259, DEF: 199 },
};

/** Devuelve un precio referencial para una descripción de producto. */
export function precioReferencial(descripcion: string, categoriaHint?: string, formatoHint?: string): PrecioRef {
  const cat = categoriaDe(descripcion, categoriaHint);
  const fmt = formatoHint && formatoDe(formatoHint) ? formatoDe(formatoHint) : formatoDe(descripcion);
  const v = 1 + variacion(descripcion);

  if (cat === "GRIFERIA") return { precio: Math.round(320 * (1 + variacion(descripcion) * 2)), unidad: "unidad" };
  if (cat === "SANITARIOS") {
    const base = /inodoro/i.test(descripcion) ? 980 : /lava/i.test(descripcion) ? 470 : 780;
    return { precio: Math.round(base * v), unidad: "unidad" };
  }
  if (cat === "PERFILES") return { precio: Math.round(48 * (1 + variacion(descripcion) * 1.5)), unidad: "unidad" };
  if (cat === "CEMENTO") return { precio: Math.round(92 * v), unidad: "bolsa" };

  // Pisos / porcelanato (por m²)
  const tabla = BASE_M2[cat] || BASE_M2.GLADYMAR;
  const base = tabla[fmt] ?? tabla.DEF;
  return { precio: Math.round(base * v), unidad: "m²" };
}
