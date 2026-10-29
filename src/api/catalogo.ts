/**
 * Catálogo público de solo lectura, para la app de clientes de Gladymar.
 *
 * Existe para que la app y el bot cotizen con lo MISMO. Si la app armara su
 * propia copia de la lista, el día que Gladymar cambie un precio habría dos
 * verdades, y el cliente vería un número en la app y otro en WhatsApp.
 *
 * Por eso no se limita a volcar el JSON: devuelve los productos ya pasados
 * por las mismas reglas que usa el bot —los formatos descontinuados quedan
 * afuera— y con los m² por caja ya calculados, que es el dato con el que se
 * convierten cajas a metros.
 *
 * No toca la base ni los datos de clientes: solo lee la lista de precios, que
 * ya está en el repositorio.
 */
import {
  esCotizable,
  generadoEl,
  regionesDeLista,
  todosLosProductos,
  type ProductoPrecio,
} from "../knowledge/listaPrecios.js";
import { m2PorCajaDe } from "../knowledge/material.js";
import { esFormatoDescontinuado } from "../knowledge/descontinuados.js";

/** Un producto del catálogo público: el de la lista más lo calculado. */
export interface ProductoCatalogo extends ProductoPrecio {
  /** m² que cubre una caja, si se puede saber. */
  m2PorCaja?: number;
  /** true si el m² por caja sale del catálogo de Dimensión Viva; false si se estimó por formato. */
  exacto?: boolean;
  /**
   * Si el bot le pone precio o lo deriva a un asesor.
   *
   * Va aunque no se haya pedido, porque es la otra mitad de "que no haya dos
   * precios distintos". SEGUNDA, GRANEL y LIQUIDACIÓN tienen en `precios` un
   * número que NO es por m²: el 27/10 un granel a 750 se cotizó como si lo
   * fuera y salió un total diez veces inflado. El bot dejó de cotizarlos; si
   * la app los muestra como precio por metro, repite el mismo error.
   */
  cotizable: boolean;
}

export interface RespuestaCatalogo {
  generado: string;
  regiones: string[];
  productos: ProductoCatalogo[];
}

/** Una hora, como pidió la app. */
export const CACHE_SEGUNDOS = 3600;

let cache: { armado: RespuestaCatalogo; vence: number } | null = null;

function armar(): RespuestaCatalogo {
  const productos: ProductoCatalogo[] = [];
  for (const p of todosLosProductos()) {
    // Misma regla que el bot: un formato que Gladymar ya no fabrica no se
    // ofrece. Se mira la descripción y el formato, porque hay filas donde el
    // formato real está solo en el texto.
    if (esFormatoDescontinuado(`${p.descripcion} ${p.formato ?? ""}`)) continue;
    const caja = m2PorCajaDe(p.descripcion);
    productos.push({
      ...p,
      ...(caja ? { m2PorCaja: caja.m2, exacto: caja.exacto } : {}),
      cotizable: esCotizable(p),
    });
  }
  return { generado: generadoEl(), regiones: regionesDeLista(), productos };
}

/** El catálogo, recalculado como mucho una vez por hora. */
export function catalogoPublico(): RespuestaCatalogo {
  const ahora = Date.now();
  if (cache && cache.vence > ahora) return cache.armado;
  const armado = armar();
  cache = { armado, vence: ahora + CACHE_SEGUNDOS * 1000 };
  return armado;
}
