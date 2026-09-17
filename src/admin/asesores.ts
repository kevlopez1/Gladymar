/**
 * Padrón de asesores de Gladymar y a quién se le deriva cada lead.
 *
 * El JSON lo genera `npm run asesores` desde el Excel que manda Gladymar.
 *
 * OJO, esto NO da acceso al panel de administración: eso sigue en roles.ts con
 * las 7 personas de siempre. Son dos cosas distintas y mezclarlas le daría
 * permisos de gerencia a 25 personas de golpe. Acá solo se decide a quién le
 * llega el aviso de un cliente nuevo.
 */
import { createRequire } from "node:module";
import { departamentoDeLugar } from "../knowledge/departamentos.js";

const require = createRequire(import.meta.url);
const DATOS = require("./asesores.json") as { origen: string; asesores: Asesor[] };

export interface Asesor {
  nombre: string;
  telefono: string;
  email: string;
  sucursal: string;
  sucursalCanonica: string;
  departamento: string;
  rol: string;
  esSupervisor: boolean;
}

export const ASESORES: Asesor[] = DATOS.asesores;

/**
 * Municipios que tienen showroom propio y NO se atienden desde la capital.
 *
 * Solo Montero por ahora: es la única sucursal fuera de una capital. El resto
 * del departamento va al showroom principal. Dentro de la ciudad de Santa Cruz
 * hay tres showrooms (Plus, Serrana, CCO) y repartir por barrio requiere que
 * Gladymar defina las zonas; hasta entonces todo lo urbano va al principal.
 */
/**
 * Zonas de la ciudad de Santa Cruz -> showroom que las atiende.
 *
 * PROPUESTA POR CERCANÍA, pendiente de que Gladymar la confirme. Sale de dónde
 * está cada showroom, no de cómo Gladymar reparte su cobertura, que es una
 * decisión comercial (dónde está el stock, quién tiene capacidad) y no
 * geográfica:
 *
 *   · Gladymar Plus          Av. Banzer, 3er anillo    -> NORTE
 *   · Canal Cotoca           Av. Santa Cruz y Guapay   -> ESTE, entre 2º y 3º
 *   · Fábrica (P. Industrial) Av. Paraguá y Canal Cotoca -> NORESTE, fuera del 4º
 *
 * Lo que esto deja a la vista: los tres están en la mitad norte/este. El SUR
 * (Plan 3000, Santos Dumont, Doble Vía La Guardia) no tiene showroom cerca, y
 * por eso no figura acá: cae en el principal hasta que Gladymar decida. No es
 * un olvido, es la pregunta.
 *
 * OJO con el orden: se prueba de la clave más larga a la más corta, porque
 * "canal cotoca" tiene que ganarle a "cotoca", que es otro municipio.
 */
const SUCURSAL_POR_ZONA: Record<string, string> = {
  // Noreste, fuera del 4º anillo.
  "parque industrial": "Serrana",
  paragua: "Serrana",
  // Este, entre el 2º y el 3er anillo.
  "canal cotoca": "CCO",
  guapay: "CCO",
  "pampa de la isla": "CCO",
  "villa primero de mayo": "CCO",
  "villa 1ro de mayo": "CCO",
  "los lotes": "CCO",
  "radial 26": "CCO",
  "radial 27": "CCO",
  // Norte y oeste, incluido el Urubó (se cruza por el norte).
  equipetrol: "Plus",
  banzer: "Plus",
  "cristo redentor": "Plus",
  "san martin": "Plus",
  "las palmas": "Plus",
  sirari: "Plus",
  polanco: "Plus",
  urubo: "Plus",
  porongo: "Plus",
};

const SUCURSAL_POR_MUNICIPIO: Record<string, string> = {
  montero: "Montero",
  warnes: "Montero",
  mineros: "Montero",
  minero: "Montero",
  portachuelo: "Montero",
  "santa rosa del sara": "Montero",
};

/**
 * Showroom principal de cada departamento: el que recibe cuando el municipio
 * no tiene uno propio. Es el que ya venía recibiendo los leads.
 */
const SUCURSAL_PRINCIPAL: Record<string, string> = {
  "Santa Cruz": "Plus",
  "La Paz": "Ballivián",
  Cochabamba: "BG2",
  Chuquisaca: "Sucre",
  Tarija: "Tarija",
};

function normalizar(s: string): string {
  return (s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Sucursal que corresponde a un lugar dicho por el cliente. */
export function sucursalParaLugar(ciudad?: string): string | undefined {
  const t = normalizar(ciudad || "");
  if (t) {
    // Las zonas de la ciudad PRIMERO, de la clave más larga a la más corta:
    // "canal cotoca" tiene que ganarle a "cotoca", que es otro municipio y otro
    // showroom. Con el orden al revés, todo el este de la ciudad se iría a Plus.
    for (const zona of Object.keys(SUCURSAL_POR_ZONA).sort((a, b) => b.length - a.length)) {
      if (t === zona || new RegExp(`(^|\\s)${zona}($|\\s)`).test(t)) return SUCURSAL_POR_ZONA[zona];
    }
    for (const [municipio, sucursal] of Object.entries(SUCURSAL_POR_MUNICIPIO)) {
      if (t === municipio || new RegExp(`(^|\\s)${municipio}($|\\s)`).test(t)) return sucursal;
    }
  }
  const depto = departamentoDeLugar(ciudad);
  return depto ? SUCURSAL_PRINCIPAL[depto] : undefined;
}

/**
 * A quién se le manda el lead.
 *
 * Al SUPERVISOR de la sucursal: un destinatario concreto y auditable. Si esa
 * sucursal no tiene supervisor cargado (pasa con Montes y JDR), sube al
 * supervisor del departamento en vez de dejar el lead sin dueño. Devuelve
 * undefined si el departamento no tiene a nadie: hoy Oruro y Potosí, que no
 * figuran en el padrón nuevo.
 */
export function asesorParaLugar(ciudad?: string): Asesor | undefined {
  const sucursal = sucursalParaLugar(ciudad);
  if (sucursal) {
    const dueño = ASESORES.find((a) => a.sucursal === sucursal && a.esSupervisor);
    if (dueño) return dueño;
  }
  const depto = departamentoDeLugar(ciudad);
  if (!depto) return undefined;
  return (
    ASESORES.find((a) => a.departamento === depto && a.esSupervisor) ??
    ASESORES.find((a) => a.departamento === depto)
  );
}

/** Todos los asesores de una sucursal (el supervisor primero). */
export function asesoresDeSucursal(sucursal: string): Asesor[] {
  return ASESORES.filter((a) => a.sucursal === sucursal).sort(
    (a, b) => Number(b.esSupervisor) - Number(a.esSupervisor),
  );
}

/**
 * Asesores de un departamento, para poder elegir a mano a quién se le asigna.
 *
 * Los supervisores van primero porque son los que reciben por defecto, y
 * después el resto ordenado por sucursal: la pregunta que se hace quien elige
 * es "de qué showroom", no "en qué orden estaban en el Excel".
 */
export function asesoresDeDepartamento(departamento?: string): Asesor[] {
  if (!departamento) return [];
  return ASESORES.filter((a) => a.departamento === departamento).sort(
    (a, b) =>
      Number(b.esSupervisor) - Number(a.esSupervisor) ||
      a.sucursalCanonica.localeCompare(b.sucursalCanonica) ||
      a.nombre.localeCompare(b.nombre),
  );
}

/** Todos los departamentos que tienen al menos un asesor cargado. */
export function departamentosConAsesores(): string[] {
  return [...new Set(ASESORES.map((a) => a.departamento))].sort();
}
