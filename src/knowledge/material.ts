/**
 * Cálculo de material: m² con desperdicio, cajas y pegamento.
 *
 * Lo pide la propuesta (pág. 8): "calcula los metros, el desperdicio y las cajas
 * con la medida real de la línea, y dice qué pegamento va".
 *
 * ⚠️ DE DÓNDE SALEN LOS M² POR CAJA. La lista de precios de Gladymar NO trae esa
 * columna: trae FORMATO ("60X60") pero no cuántas piezas vienen por caja. Así
 * que hay dos fuentes:
 *   1. Dimensión Viva: cada colección tiene su m² por caja cargado del catálogo
 *      oficial. Es el dato exacto.
 *   2. El resto: PIEZAS_POR_CAJA, una tabla por formato con los armados
 *      habituales de la industria. Es una APROXIMACIÓN y se marca como tal.
 *
 * La diferencia importa: con el dato exacto se dice "necesitás 92 cajas"; con
 * la aproximación se dice "unas 92 cajas, confirmalo con el asesor". Nunca se
 * presenta una estimación como si fuera el dato del catálogo.
 */
import { DIMENSION_VIVA, cajasNecesarias } from "./dimensionViva.js";

/** Desperdicio por cortes. 10% es lo que recomienda el manual de Gladymar. */
export const MERMA = 0.1;

/**
 * Piezas por caja según formato, para los productos que no son Dimensión Viva.
 * Son los armados habituales; Gladymar todavía no entregó la tabla oficial.
 */
const PIEZAS_POR_CAJA: Record<string, number> = {
  "20X20": 25,
  "30X30": 11,
  "33X33": 9,
  "41X41": 6,
  "45X45": 6,
  "50X50": 5,
  "60X60": 4,
  "60X120": 2,
  "80X80": 3,
  "90X90": 2,
  "100X100": 2,
  "120X120": 2,
};

export interface CalculoMaterial {
  m2Pedidos: number;
  m2ConMerma: number;
  cajas?: number;
  m2PorCaja?: number;
  /** true si los m² por caja salen del catálogo; false si es aproximación. */
  exacto: boolean;
  formato?: string;
  nota: string;
}

/** Normaliza "60 x 60", "60x60cm" -> "60X60". */
export function formatoNormalizado(texto: string): string | undefined {
  const m = (texto || "").toUpperCase().match(/(\d{2,3})\s*[X×]\s*(\d{2,3})/);
  return m ? `${m[1]}X${m[2]}` : undefined;
}

/** m² que cubre una caja de ese formato, si se conoce el armado. */
function m2PorCajaDeFormato(formato: string): number | undefined {
  const piezas = PIEZAS_POR_CAJA[formato];
  if (!piezas) return undefined;
  const [a, b] = formato.split("X").map(Number);
  if (!a || !b) return undefined;
  // Los formatos vienen en cm: cm² -> m².
  return Math.round(((a * b) / 10000) * piezas * 100) / 100;
}

/**
 * Calcula el material para una superficie.
 *
 * `producto` se usa para encontrar el formato y, si es una colección de
 * Dimensión Viva, su m² por caja exacto.
 */
export function calcularMaterial(metrosCuadrados: number, producto: string): CalculoMaterial {
  const m2Pedidos = Math.round(metrosCuadrados * 100) / 100;
  const m2ConMerma = Math.round(m2Pedidos * (1 + MERMA) * 100) / 100;

  // 1) ¿Es una colección de Dimensión Viva? Ahí el dato es del catálogo.
  const texto = (producto || "").toUpperCase();
  const coleccion = DIMENSION_VIVA.find((c) => texto.includes(c.nombre.toUpperCase()));
  if (coleccion?.m2PorCaja) {
    const r = cajasNecesarias(m2Pedidos, coleccion.m2PorCaja);
    return {
      m2Pedidos,
      m2ConMerma: r.m2ConMerma,
      cajas: r.cajas,
      m2PorCaja: coleccion.m2PorCaja,
      exacto: true,
      formato: coleccion.formato,
      nota: `${coleccion.nombre} rinde ${coleccion.m2PorCaja} m² por caja (dato del catálogo).`,
    };
  }

  // 2) Si no, se estima por formato.
  const formato = formatoNormalizado(producto);
  const m2Caja = formato ? m2PorCajaDeFormato(formato) : undefined;
  if (m2Caja) {
    return {
      m2Pedidos,
      m2ConMerma,
      cajas: Math.ceil(m2ConMerma / m2Caja),
      m2PorCaja: m2Caja,
      exacto: false,
      formato,
      nota: `Cálculo aproximado para formato ${formato} (≈${m2Caja} m² por caja). El asesor confirma el armado exacto de esa línea.`,
    };
  }

  // 3) Sin formato reconocible se entregan los m², que igual sirven.
  return {
    m2Pedidos,
    m2ConMerma,
    exacto: false,
    formato,
    nota: "No pude determinar cuántos m² rinde la caja de ese producto: el asesor confirma las cajas.",
  };
}

/**
 * Recomendación de pegamento. Sale del manual de colocación de Gladymar, no se
 * inventa. El formato manda: a partir de 60x60 el adhesivo tiene que ser el
 * reforzado, si no la pieza se desprende.
 */
export function pegamentoPara(producto: string): string {
  const formato = formatoNormalizado(producto);
  const [a, b] = formato ? formato.split("X").map(Number) : [0, 0];
  const grande = Math.max(a || 0, b || 0) >= 60;
  return grande
    ? "*Cemento cola Súper Forte* (formatos grandes), llana dentada de 8 mm, sobre contrapiso nivelado e impermeabilizado."
    : "*Cemento cola* impermeable, llana dentada de 8 mm, sobre contrapiso nivelado e impermeabilizado.";
}

/** Texto listo para el chat, con el cálculo y el pegamento. */
export function resumenMaterial(metrosCuadrados: number, producto: string): string {
  const c = calcularMaterial(metrosCuadrados, producto);
  const partes = [
    `*Para tus ${c.m2Pedidos} m²:*`,
    `Con el ${MERMA * 100}% de desperdicio por cortes son *${c.m2ConMerma} m²*.`,
  ];
  if (c.cajas) {
    partes.push(
      c.exacto
        ? `Necesitás *${c.cajas} cajas*. ${c.nota}`
        : `Serían *unas ${c.cajas} cajas*. ${c.nota}`,
    );
  } else {
    partes.push(c.nota);
  }
  partes.push("", "*Pegamento:*", pegamentoPara(producto));
  partes.push("", "Antes de colocar, abrí 4 o más cajas y tomá una pieza de cada una, para uniformar el tono.");
  return partes.join("\n");
}
