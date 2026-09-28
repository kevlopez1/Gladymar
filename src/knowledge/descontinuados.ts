/**
 * Formatos que Gladymar dejó de fabricar.
 *
 * Vive en su propio módulo porque la regla la tienen que aplicar tres lugares
 * que no se conocen entre sí: el catálogo (que es un Excel viejo con 89 filas
 * de 41X41 adentro), el buscador de la lista de precios y el armador de
 * cotizaciones. Con la lista escrita en uno solo, los otros dos la ofrecían.
 *
 * El import de la lista de precios (scripts/importarPrecios.ts) tiene su propia
 * copia a propósito: ese script corre fuera del bot y lo que saca no vuelve a
 * entrar. Acá se filtra lo que ya está cargado.
 *
 * 41X41: descontinuado, confirmado por Gerencia General el 17/09/2026.
 */
const FORMATOS_DESCONTINUADOS = [/41\s*[x×]\s*41/i];

/** ¿Este texto (formato, descripción o consulta del cliente) nombra un formato descontinuado? */
export function esFormatoDescontinuado(texto: string): boolean {
  return FORMATOS_DESCONTINUADOS.some((re) => re.test(texto || ""));
}
