/**
 * Lógica de cotizaciones (cálculo). El PDF se genera en cotizacionPdf.ts.
 *
 * ⚠️ Precios REFERENCIALES (ver precios.ts). Cada cotización lo aclara.
 */
import { precioReferencial } from "../knowledge/precios.js";

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
}
/** Horas que la cotización mantiene el precio. Lo fijó Gerencia en 24 h. */
export const VIGENCIA_HORAS = 24;

export interface Cotizacion {
  numero: string;
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
  const items: CotItem[] = entrada.map((it) => {
    const ref = precioReferencial(it.producto);
    const unidad = it.unidad || ref.unidad;
    const cantidad = Number(it.cantidad) || 1;
    const subtotal = Math.round(ref.precio * cantidad * 100) / 100;
    return { descripcion: it.producto, cantidad, unidad, precioUnit: ref.precio, subtotal };
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

  return { numero: `COT-2026-${++seq}`, fecha, vence, cliente: cliente || "Cliente", ciudad, items, total };
}
