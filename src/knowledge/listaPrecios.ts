/**
 * Lista de precios OFICIAL de Gladymar (septiembre 2026), por región.
 *
 * El JSON lo genera `npm run precios` desde el Excel que manda Gladymar; acá
 * solo se consulta. Ver scripts/importarPrecios.ts para qué se filtró y por qué.
 *
 * REEMPLAZA al estimador de precios.ts: antes los precios eran inventados
 * "coherentes con el mercado", ahora son los reales de la lista.
 */
import { createRequire } from "node:module";
import { departamentoDeLugar } from "./departamentos.js";

const require = createRequire(import.meta.url);
const DATOS = require("./listaPrecios.json") as {
  generado: string;
  origen: string;
  regiones: string[];
  productos: ProductoPrecio[];
};

export interface ProductoPrecio {
  familia: string;
  cod: string;
  marca: string;
  descripcion: string;
  formato?: string;
  acabado?: string;
  status: string;
  precios: Record<string, number>;
}

/**
 * Departamento (canónico, el que devuelve departamentoDeLugar) -> columna de
 * precio del Excel.
 *
 * Los códigos del Excel y los del padrón de asesores NO coinciden (el Excel
 * dice CBBA/LPZ/TRJ, el padrón CBB/LP/TAR-TJA). Por eso ninguno de los dos se
 * usa como clave: ambos se traducen desde el departamento canónico, que es la
 * única fuente común. Ver departamentos.ts.
 *
 * Oruro, Potosí, Beni y Pando NO tienen columna propia en la lista: Gladymar
 * no las sectorizó. Se resuelven con el precio más alto (ver precioEnRegion).
 */
const COLUMNA_POR_DEPARTAMENTO: Record<string, string> = {
  "Santa Cruz": "SCZ",
  Tarija: "TRJ",
  Cochabamba: "CBBA",
  Chuquisaca: "SRE",
  "La Paz": "LPZ",
};

/**
 * Origen según la familia (hoja) de la que salió el producto.
 *
 * Es el ÚNICO dato de la empresa que dice si algo es nacional o importado: el
 * Excel separa las cerámicas en dos hojas, NAC e IMP. Antes esto no salía de
 * acá para ningún lado, así que cuando el cliente preguntaba "¿es nacional?"
 * el modelo lo deducía del nombre — y se equivocaba (reportado por Gerencia
 * General el 17/09/2026: cotizó un importado como nacional).
 *
 * Las hojas que no son cerámica (sanitarios, grifería, cemento, perfiles) no
 * traen la distinción: ahí se devuelve undefined y no se afirma nada, que es
 * distinto de afirmar "nacional".
 */
const ORIGEN_POR_FAMILIA: Record<string, string> = {
  NAC: "Nacional",
  IMP: "Importado",
};

/** Unidad de medida según la familia (hoja) de la que salió el producto. */
const UNIDAD_POR_FAMILIA: Record<string, string> = {
  NAC: "m²",
  IMP: "m²",
  SANIT: "unidad",
  GRIF: "unidad",
  ATRIM: "unidad",
  CEM: "bolsa",
};

function normalizar(s: string): string {
  return (s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Palabras que aparecen en casi toda descripción y no sirven para distinguir. */
const VACIAS = new Set(["de", "la", "el", "para", "con", "y", "x", "piso", "cm", "mm"]);

interface Indexado extends ProductoPrecio {
  tokens: Set<string>;
  plano: string;
}

const INDICE: Indexado[] = DATOS.productos.map((p) => {
  const plano = normalizar(`${p.marca} ${p.descripcion} ${p.formato ?? ""} ${p.acabado ?? ""}`);
  return { ...p, plano, tokens: new Set(plano.split(" ").filter((t) => t && !VACIAS.has(t))) };
});

export function totalProductos(): number {
  return INDICE.length;
}

export function fechaLista(): string {
  return DATOS.origen;
}

/**
 * Precio de un producto en una región.
 *
 * SIN REGIÓN CONOCIDA se devuelve el precio MÁS ALTO de las cinco, no un
 * promedio ni la primera columna. Es deliberado: un asesor puede bajar un
 * precio cotizado de más, pero no puede subir uno cotizado de menos sin quedar
 * mal con el cliente. Errar hacia arriba es recuperable; hacia abajo, no.
 */
export function precioEnRegion(p: ProductoPrecio, departamento?: string): { precio: number; region: string } {
  const col = departamento ? COLUMNA_POR_DEPARTAMENTO[departamento] : undefined;
  if (col && p.precios[col] != null) return { precio: p.precios[col], region: col };
  const valores = Object.values(p.precios);
  return { precio: Math.max(...valores), region: "NACIONAL" };
}

/**
 * Busca el producto de la lista que mejor encaja con lo que pidió el cliente.
 *
 * Devuelve null si no hay nada razonable: es preferible que el agente pida una
 * aclaración a cotizar un producto que no es. Antes esto no podía pasar porque
 * el estimador le inventaba un precio a cualquier texto.
 */
export function buscarProductoPrecio(consulta: string): ProductoPrecio | null {
  const q = normalizar(consulta);
  if (!q) return null;
  const tokens = q.split(" ").filter((t) => t && !VACIAS.has(t));
  if (!tokens.length) return null;

  let mejor: Indexado | null = null;
  let mejorPuntos = 0;
  let mejorExactos = 0;
  for (const p of INDICE) {
    const { puntos, exactos } = puntuar(p, tokens, q);
    if (puntos > mejorPuntos) { mejorPuntos = puntos; mejorExactos = exactos; mejor = p; }
  }

  // Hace falta la mitad de lo que pidió el cliente, pero con piso de 3: una
  // consulta de una o dos palabras ("ducha", "cemento cola") es legítima y con
  // un mínimo de 6 no encontraba nada. La exigencia de al menos UN token exacto
  // es la que evita el falso positivo: "asdfgh" sigue sin devolver nada.
  const minimo = Math.max(3, Math.ceil(tokens.length / 2) * 3);
  return mejor && mejorExactos >= 1 && mejorPuntos >= minimo ? mejor : null;
}

/** Puntaje de un producto contra los términos de búsqueda. */
function puntuar(p: Indexado, tokens: string[], consultaPlana: string): { puntos: number; exactos: number } {
  let puntos = 0;
  let exactos = 0;
  for (const t of tokens) {
    if (p.tokens.has(t)) { puntos += 3; exactos++; }
    else if (t.length > 3 && p.plano.includes(t)) puntos += 1;
  }
  // La frase completa contenida vale mucho: "piso 60x60 eco carrara" debe
  // ganarle a un producto que solo comparte "piso".
  if (p.plano.includes(consultaPlana)) puntos += 6;
  return { puntos, exactos };
}

/** Varios candidatos, para que el agente pueda ofrecer opciones. */
export function buscarVarios(consulta: string, limite = 3): ProductoPrecio[] {
  const q = normalizar(consulta);
  const tokens = q.split(" ").filter((t) => t && !VACIAS.has(t));
  if (!tokens.length) return [];
  const puntuados = INDICE.map((p) => ({ p, ...puntuar(p, tokens, q) }))
    .filter((x) => x.exactos >= 1 && x.puntos >= 3)
    .sort((a, b) => b.puntos - a.puntos);
  return puntuados.slice(0, limite).map((x) => x.p);
}

export function unidadDe(p: ProductoPrecio): string {
  return UNIDAD_POR_FAMILIA[p.familia] ?? "unidad";
}

/**
 * "Nacional" | "Importado", o undefined si la lista no lo dice.
 *
 * undefined NO es "nacional". Quien lo muestre tiene que callarse el dato, no
 * rellenarlo con el valor más probable.
 */
export function origenDe(p: ProductoPrecio): string | undefined {
  return ORIGEN_POR_FAMILIA[p.familia];
}

/**
 * Origen por MARCA, para los catálogos que no salen de la lista de precios.
 *
 * Se arma recorriendo la lista oficial: es la empresa la que decide qué marca
 * es importada, no una lista escrita a mano acá. Una marca que apareciera en
 * las dos hojas queda sin origen a propósito: ante la duda no se afirma.
 */
const ORIGEN_POR_MARCA: Map<string, string | undefined> = (() => {
  const vistos = new Map<string, string | undefined>();
  for (const p of DATOS.productos) {
    const origen = ORIGEN_POR_FAMILIA[p.familia];
    if (!origen) continue;
    const marca = normalizar(p.marca);
    if (!marca) continue;
    if (vistos.has(marca) && vistos.get(marca) !== origen) vistos.set(marca, undefined);
    else if (!vistos.has(marca)) vistos.set(marca, origen);
  }
  return vistos;
})();

export function origenDeMarca(marca: string): string | undefined {
  return ORIGEN_POR_MARCA.get(normalizar(marca));
}

/** Departamento canónico a partir de la ciudad que dijo el cliente. */
export function departamentoDeCiudad(ciudad?: string): string | undefined {
  return departamentoDeLugar(ciudad);
}

/**
 * Marcadores de "acá no hay dato" que trae el Excel. Se muestran como lo que
 * son —nada—, en vez de mandarle al cliente "APARICI · 0 · MATE".
 */
const SIN_DATO = new Set(["0", "-", "S/F", "S/A", "N/A", "SIN FORMATO"]);

function util(v?: string): string | undefined {
  const t = (v || "").trim();
  return t && !SIN_DATO.has(t.toUpperCase()) ? t : undefined;
}

/**
 * Formatea un producto de la lista para mostrárselo al cliente.
 *
 * Mismo formato que formatearProductoCat, para que las dos fuentes se puedan
 * mezclar en una sola respuesta sin que se note la costura.
 */
export function formatearProductoLista(p: ProductoPrecio): string {
  const meta = [util(p.marca), util(p.formato), util(p.acabado), origenDe(p)]
    .filter(Boolean)
    .join(" \u00b7 ");
  return meta ? `\u2022 *${p.descripcion}*\n   _${meta}_` : `\u2022 *${p.descripcion}*`;
}
