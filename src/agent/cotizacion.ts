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
export interface Cotizacion {
  numero: string;
  fecha: string;
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
  const fecha = new Date().toLocaleDateString("es-BO", { timeZone: "America/La_Paz" });
  return { numero: `COT-2026-${++seq}`, fecha, cliente: cliente || "Cliente", ciudad, items, total };
}
