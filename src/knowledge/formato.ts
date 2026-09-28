/**
 * Medida comercial vs. medida real de una pieza.
 *
 * Gladymar usa las dos y no son la misma. La columna FORMATO trae la medida
 * COMERCIAL, que es como se pide y se vende ("60X60"); la descripción trae la
 * REAL, que es lo que mide la pieza ("61X61", "59X59", "31X41"). Difieren en
 * 389 de los 1.168 productos que llevan medida en el nombre, así que no es una
 * excepción: es la convención del archivo.
 *
 * Eso genera dos problemas al mostrárselo a un cliente, y los dos se resuelven
 * acá:
 *
 * 1. La línea se contradice: "PISO 61X61 MADERA MARFIL · 60X60". El cliente no
 *    sabe cuál de los dos números es el suyo.
 * 2. Salen duplicados que no son productos distintos. PISO 60X60 MADERA MARFIL
 *    y PISO 61X61 MADERA MARFIL son dos códigos, mismo formato comercial y
 *    mismo precio: ofrecerle los dos es darle a elegir entre lo mismo.
 */

const MEDIDA = /(\d{2,3})\s*[xX×]\s*(\d{2,3})/;

/** La medida que aparece en un texto, normalizada ("61X61"), si la hay. */
export function medidaEnTexto(texto: string): string | undefined {
  const m = (texto || "").match(MEDIDA);
  return m ? `${m[1]}X${m[2]}` : undefined;
}

function normalizarFormato(formato?: string): string | undefined {
  const f = (formato || "").toUpperCase().replace(/\s+/g, "").replace(/×/g, "X");
  return MEDIDA.test(f) ? f : undefined;
}

/**
 * El formato a MOSTRAR junto al producto, o undefined si no aporta nada.
 *
 * Si la descripción ya lleva una medida, no se repite ninguna: o dice lo mismo
 * (redundante) o dice otra cosa (contradictorio). El nombre del producto manda,
 * porque es el que el asesor busca en el sistema.
 */
export function formatoParaMostrar(descripcion: string, formato?: string): string | undefined {
  if (medidaEnTexto(descripcion)) return undefined;
  return formato?.trim() || undefined;
}

/**
 * Clave para no ofrecer dos veces el mismo producto.
 *
 * Junta marca + formato comercial + el nombre SIN su medida. Así las dos
 * variantes de Madera Marfil colapsan en una, pero un 60X60 y un 20X120 de la
 * misma línea siguen siendo dos opciones, que es correcto: son productos
 * distintos para el cliente.
 */
export function claveDeProducto(marca: string, descripcion: string, formato?: string): string {
  const comercial = normalizarFormato(formato) ?? medidaEnTexto(descripcion) ?? "";
  const sinMedida = (descripcion || "")
    .replace(MEDIDA, " ")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
  return `${(marca || "").toUpperCase().trim()}|${comercial}|${sinMedida}`;
}

/**
 * Entre dos variantes del mismo producto, cuál mostrar.
 *
 * Gana la que se llama igual que su formato comercial: si el cliente va a leer
 * un número, que sea el mismo con el que va a pedir la pieza.
 */
export function mejorVariante(descripcion: string, formato?: string): boolean {
  const comercial = normalizarFormato(formato);
  const real = medidaEnTexto(descripcion);
  return !comercial || !real || comercial === real;
}
