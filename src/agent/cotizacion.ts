/**
 * Lógica de cotizaciones (cálculo). El PDF se genera en cotizacionPdf.ts.
 *
 * ⚠️ Precios REFERENCIALES (ver precios.ts). Cada cotización lo aclara.
 */
import { precioReferencial } from "../knowledge/precios.js";
import {
  buscarProductoPrecio,
  precioEnRegion,
  unidadDe,
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
}
/** Horas que la cotización mantiene el precio. Lo fijó Gerencia en 24 h. */
export const VIGENCIA_HORAS = 24;

export interface Cotizacion {
  numero: string;
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

  const items: CotItem[] = entrada.map((it) => {
    const cantidad = Number(it.cantidad) || 1;
    const oficial = buscarProductoPrecio(it.producto);

    if (oficial) {
      const { precio, region } = precioEnRegion(oficial, departamento);
      const unidad = it.unidad || unidadDe(oficial);
      return {
        descripcion: oficial.descripcion,
        cantidad,
        unidad,
        precioUnit: precio,
        subtotal: Math.round(precio * cantidad * 100) / 100,
        cod: oficial.cod,
        region,
        oficial: true,
      };
    }

    // No está en la lista oficial (un accesorio suelto, algo mal escrito). Se
    // cotiza con el estimador y se marca, para que el PDF lo distinga: mezclar
    // precios reales con estimados sin avisar es lo peor de los dos mundos.
    const ref = precioReferencial(it.producto);
    return {
      descripcion: it.producto,
      cantidad,
      unidad: it.unidad || ref.unidad,
      precioUnit: ref.precio,
      subtotal: Math.round(ref.precio * cantidad * 100) / 100,
      oficial: false,
    };
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

  return { numero: `COT-2026-${++seq}`, departamento, fecha, vence, cliente: cliente || "Cliente", ciudad, items, total };
}
