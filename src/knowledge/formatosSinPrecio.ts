/**
 * Formatos que Gladymar fabrica pero de los que el bot NO da precio.
 *
 * Vive en su propio módulo porque la regla la tienen que aplicar lugares que
 * no se conocen entre sí: el armador de cotizaciones, el buscador y el
 * catálogo público de la app. Con la lista escrita en uno solo, los otros la
 * contradecían.
 *
 * 41X41: Gerencia General lo dio por descontinuado el 17/09/2026 y lo volvió a
 * incorporar al portafolio el 23/11/2026, con una instrucción explícita: "de
 * momento, que no dé precios de ese formato". Así que se ofrece y se muestra
 * como cualquier otro producto vigente, pero el precio lo confirma un asesor.
 *
 * El import de la lista de precios (scripts/importarPrecios.ts) sigue dejando
 * afuera las filas de 41X41: la lista que cargó Gladymar es la de septiembre y
 * sus precios de 41x41 no están vigentes. Cuando manden los nuevos se levanta
 * ese filtro y se saca este formato de acá.
 *
 * Si algún día Gladymar vuelve a descontinuar un formato, eso es otra cosa:
 * no va acá, porque acá el producto SÍ se fabrica.
 */
const FORMATOS_SIN_PRECIO = [/41\s*[x×]\s*41/i];

/** ¿Este texto (formato, descripción o consulta del cliente) nombra un formato del que no damos precio? */
export function esFormatoSinPrecio(texto: string): boolean {
  return FORMATOS_SIN_PRECIO.some((re) => re.test(texto || ""));
}
