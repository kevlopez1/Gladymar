/**
 * Lógica de cotizaciones (cálculo). El PDF se genera en cotizacionPdf.ts.
 *
 * ⚠️ Precios REFERENCIALES (ver precios.ts). Cada cotización lo aclara.
 */
import { precioReferencial } from "../knowledge/precios.js";
import { esFormatoDescontinuado } from "../knowledge/descontinuados.js";
import {
  buscarProductoPrecio,
  pideSegunda,
  precioEnRegion,
  unidadDe,
  origenDe,
  departamentoDeCiudad,
} from "../knowledge/listaPrecios.js";

export interface ItemInput {
  producto: string;
  cantidad: number;
  unidad?: string;
}
export interface CotItem {
  descripcion: string;
  cantidad: number;
  unidad: string;
  precioUnit: number;
  subtotal: number;
  /** Código del producto en la lista oficial, si se encontró. */
  cod?: string;
  /** Columna de precio aplicada ("SCZ", "LPZ", ..., o "NACIONAL"). */
  region?: string;
  /** false cuando el precio salió del estimador por no estar en la lista. */
  oficial?: boolean;
  /** STATUS de la lista: PORTAFOLIO, NUEVO, SEGUNDA, GRANEL, LIQUIDACIÓN... */
  status?: string;
  /**
   * El cliente pidió un formato descontinuado y esto NO es lo que pidió.
   *
   * Sin esta marca el ítem sale igual y el cliente cree que le cotizaron su
   * 41x41. Quien arma la respuesta tiene que decirlo.
   */
  reemplaza?: string;
  /**
   * "Nacional" | "Importado" según la hoja de origen del Excel (NAC / IMP).
   *
   * undefined cuando la lista no lo dice (sanitarios, grifería, cemento,
   * perfiles) o cuando el precio salió del estimador. En esos casos la
   * cotización no lo imprime: afirmar "nacional" por descarte fue justamente
   * el error que reportó Gerencia el 17/09/2026.
   */
  origen?: string;
}
/** Horas que la cotización mantiene el precio. Lo fijó Gerencia en 24 h. */
export const VIGENCIA_HORAS = 24;

export interface Cotizacion {
  numero: string;
  /**
   * Lo que el cliente pidió y NO se cotizó por ser de segunda selección.
   *
   * Va aparte de `items` a propósito: no entra al PDF ni al total. Gerencia
   * pidió que la segunda se derive al asesor, y una línea sin precio dentro de
   * la cotización no es derivar, es dejar un hueco que el cliente interpreta
   * solo. Quien arma la respuesta tiene que decirlo y derivarlo.
   */
  derivar: { pedido: string; producto: string }[];
  /** Departamento con cuyo precio se cotizó (undefined = no se pudo determinar). */
  departamento?: string;
  /** Emisión, con hora: con 24 h de vigencia la fecha sola no alcanza. */
  fecha: string;
  /** Fecha y hora exactas en que vence (emisión + VIGENCIA_HORAS). */
  vence: string;
  cliente: string;
  ciudad?: string;
  items: CotItem[];
  total: number;
}

let seq = 1000;

export function bs(n: number): string {
  return "Bs " + n.toLocaleString("es-BO", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Arma la cotización (calcula precios y total) a partir de los ítems pedidos. */
export function construirCotizacion(cliente: string, ciudad: string | undefined, entrada: ItemInput[]): Cotizacion {
  // El precio depende de la región: la misma pieza cuesta distinto en Santa
  // Cruz que en La Paz (hasta 66% de diferencia en la lista de septiembre).
  const departamento = departamentoDeCiudad(ciudad);

  const derivar: { pedido: string; producto: string }[] = [];

  const items: CotItem[] = entrada.flatMap((it): CotItem[] => {
    const cantidad = Number(it.cantidad) || 1;

    // Primero: ¿está pidiendo SEGUNDA? Si sí, no se cotiza ni se le ofrece un
    // reemplazo de primera por las nuestras — se deriva, que es lo que pidió
    // Gerencia. Va ANTES de buscar el cotizable a propósito: preguntar después
    // dejaría cotizada la primera calidad de nombre parecido.
    const segunda = pideSegunda(it.producto);
    if (segunda) {
      derivar.push({ pedido: it.producto, producto: segunda });
      return [];
    }

    const oficial = buscarProductoPrecio(it.producto);
    // El 41x41 ya no está en la lista, así que el buscador devuelve el
    // producto que MÁS se le parece — un 60x60, otro granel — y lo cotiza como
    // si fuera lo pedido. Eso es peor que no encontrarlo: el cliente recibe un
    // precio por algo que no pidió. Se cotiza igual (le sirve de alternativa)
    // pero queda marcado.
    const pidioDescontinuado = esFormatoDescontinuado(it.producto);

    if (oficial) {
      const { precio, region } = precioEnRegion(oficial, departamento);
      const unidad = it.unidad || unidadDe(oficial);
      return [{
        descripcion: oficial.descripcion,
        cantidad,
        unidad,
        precioUnit: precio,
        subtotal: Math.round(precio * cantidad * 100) / 100,
        cod: oficial.cod,
        region,
        oficial: true,
        status: oficial.status,
        origen: origenDe(oficial),
        ...(pidioDescontinuado ? { reemplaza: it.producto } : {}),
      }];
    }

    // No está en la lista oficial (un accesorio suelto, algo mal escrito). Se
    // cotiza con el estimador y se marca, para que el PDF lo distinga: mezclar
    // precios reales con estimados sin avisar es lo peor de los dos mundos.
    const ref = precioReferencial(it.producto);
    return [{
      descripcion: it.producto,
      cantidad,
      unidad: it.unidad || ref.unidad,
      precioUnit: ref.precio,
      subtotal: Math.round(ref.precio * cantidad * 100) / 100,
      oficial: false,
      ...(pidioDescontinuado ? { reemplaza: it.producto } : {}),
    }];
  });
  const total = items.reduce((s, i) => s + i.subtotal, 0);

  // Con vigencia de 24 h hay que imprimir la HORA, no solo el día: una
  // cotización emitida a las 23:50 que solo dice la fecha no permite saber
  // cuándo vence, ni al cliente ni al asesor que la recibe.
  const ahora = new Date();
  const fmt = (d: Date) =>
    d.toLocaleString("es-BO", {
      timeZone: "America/La_Paz",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  const fecha = fmt(ahora);
  const vence = fmt(new Date(ahora.getTime() + VIGENCIA_HORAS * 60 * 60 * 1000));

  return {
    numero: `COT-2026-${++seq}`,
    departamento,
    fecha,
    vence,
    cliente: cliente || "Cliente",
    ciudad,
    items,
    total,
    derivar,
  };
}
