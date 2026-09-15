/**
 * Roles de administrador del panel de Gladymar.
 *
 * - Gerente General (UNO, nacional): todos los comandos, ámbito nacional.
 *   Su número se define con GERENTE_TELEFONO (Andres Tejada).
 * - Administradores regionales: uno por ciudad, ven SOLO su región y los
 *   comandos base. Sus números son los WhatsApp de las sucursales, más los
 *   supervisores de sucursal del padrón de asesores.
 * - Asesores comerciales: los 17 restantes del padrón. Panel reducido (ven los
 *   leads de su departamento y pueden dar de alta clientes), sin reclamos ni
 *   reportes. Se los agrega acá y no en asesores.ts porque ese módulo decide a
 *   quién se DERIVA un lead, que es otra cosa: un asesor puede recibir leads
 *   sin tener panel, y el panel no lo convierte en el dueño de la sucursal.
 */
import { config } from "../config.js";
import { ciudadesConSucursal } from "../knowledge/sucursales.js";
import { departamentoDeLugar, REGION_ASESOR } from "../knowledge/departamentos.js";
import { asesorParaLugar, ASESORES } from "./asesores.js";

export interface Admin {
  id: string;
  nombre: string;
  role: "gerente" | "regional" | "asesor";
  region?: string; // ciudad/región, para regionales y asesores
  /** Sucursal del padrón (solo asesores y supervisores). */
  sucursal?: string;
}

/** Número del Gerente General (formato internacional sin "+", como llega de WhatsApp). */
export const ADMIN_TELEFONO = (process.env.GERENTE_TELEFONO || "59167401827").trim();

/** Administrador regional (persona) por departamento. */
export const ADMIN_REGIONAL_NOMBRE: Record<string, string> = {
  "Santa Cruz": "Thalía Vera",
  "La Paz": "José Ramos",
  "Cochabamba": "María René Áviles",
  "Sucre": "Jorge Montecinos",
  "Tarija": "Rosana Patana",
  "Potosí": "Gabriel Flores",
  "Oruro": "Gustavo Villegas",
};

/** Número de WhatsApp del administrador regional por departamento (8 dígitos locales). */
export const ADMIN_REGIONAL_TELEFONO: Record<string, string> = {
  "Santa Cruz": "67703821", // Gladymar Plus (Thalía Vera)
  "La Paz": "68225572", // Gladymar La Paz (José Ramos)
  "Cochabamba": "67408846",
  "Sucre": "67900508",
  "Tarija": "72987241",
  "Oruro": "72303568",
  "Potosí": "69612800",
};

/**
 * Normaliza un número al formato internacional de Bolivia (591 + número), tal
 * como llega de WhatsApp. Los teléfonos de sucursal están cargados con 8 dígitos
 * locales; acá les anteponemos "591" para que coincidan con el remitente real.
 */
export function toIntlBolivia(num: string): string {
  const d = (num || "").replace(/\D/g, "");
  return d.startsWith("591") ? d : `591${d}`;
}

/** Mapa teléfono (internacional) -> Admin (para enrutar en WhatsApp real). */
export const ADMIN_POR_TELEFONO: Record<string, Admin> = {};

// 1) Padrón de asesores. Va PRIMERO a propósito: varios de estos números son
//    también el WhatsApp de la sucursal (Thalía Vera, Ma. René Aviles), y en
//    ese caso tiene que ganar la entrada regional que se carga después, que es
//    la que trae el nombre con tildes y la región ya resuelta.
for (const a of ASESORES) {
  if (!a.telefono) continue;
  const tel = toIntlBolivia(a.telefono);
  ADMIN_POR_TELEFONO[tel] = {
    id: tel,
    nombre: a.nombre,
    role: a.esSupervisor ? "regional" : "asesor",
    region: REGION_ASESOR[a.departamento] ?? a.departamento,
    sucursal: a.sucursalCanonica || a.sucursal,
  };
}

// 2) Líneas de WhatsApp de las sucursales (el padrón viejo de 7).
for (const [ciudad, num] of Object.entries(ADMIN_REGIONAL_TELEFONO)) {
  const tel = toIntlBolivia(num);
  ADMIN_POR_TELEFONO[tel] = {
    id: tel,
    nombre: ADMIN_REGIONAL_NOMBRE[ciudad] || `Administrador ${ciudad}`,
    role: "regional",
    region: ciudad,
  };
}
// 3) El Gerente General tiene prioridad (acceso nacional).
const gerenteTel = toIntlBolivia(ADMIN_TELEFONO);
ADMIN_POR_TELEFONO[gerenteTel] = { id: gerenteTel, nombre: "Gerente General", role: "gerente" };

// Administradores adicionales con acceso nacional (desarrollo / soporte Prime).
const ADMINS_EXTRA: { telefono: string; nombre: string }[] = [
  { telefono: "74234380", nombre: "Soporte Prime" },
];
for (const a of ADMINS_EXTRA) {
  const t = toIntlBolivia(a.telefono);
  ADMIN_POR_TELEFONO[t] = { id: t, nombre: a.nombre, role: "gerente" };
}

function normCiudad(s: string): string {
  return (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

/** Devuelve el admin asociado a un número, si existe (normaliza el remitente). */
export function getAdminByPhone(telefono: string): Admin | undefined {
  return ADMIN_POR_TELEFONO[toIntlBolivia(telefono)];
}

/**
 * Región del asesor que corresponde a un lugar dicho por el cliente.
 *
 * El cliente dice el municipio ("Montero", "El Alto", "Quillacollo"), no el
 * departamento. Antes esto comparaba el texto contra "Santa Cruz" / "La Paz" y
 * no matcheaba nunca, así que esos leads quedaban sin asesor: el mapa de
 * municipios resuelve eso primero, y la comparación literal queda de respaldo.
 */
export function regionAdminDeCiudad(ciudad?: string): string | undefined {
  const depto = departamentoDeLugar(ciudad);
  const region = depto ? REGION_ASESOR[depto] : undefined;
  if (region && ADMIN_REGIONAL_TELEFONO[region]) return region;

  const c = normCiudad(ciudad || "");
  if (!c) return undefined;
  for (const nombre of Object.keys(ADMIN_REGIONAL_TELEFONO)) {
    const n = normCiudad(nombre);
    if (n === c || c.includes(n) || n.includes(c)) return nombre;
  }
  return undefined;
}

/**
 * Nombre del asesor que atiende ese lugar, tal cual va al CRM (con tildes).
 *
 * Primero el padrón oficial de 25 asesores, que además resuelve la sucursal
 * (Montero no se atiende desde la capital). El padrón viejo de 7 queda como
 * respaldo: es el único que cubre Potosí y Oruro, que no figuran en el archivo
 * que mandó Gladymar.
 */
export function adminNombrePorCiudad(ciudad?: string): string | undefined {
  const asesor = asesorParaLugar(ciudad);
  if (asesor) return asesor.nombre;
  const region = regionAdminDeCiudad(ciudad);
  return region ? ADMIN_REGIONAL_NOMBRE[region] : undefined;
}

/** Teléfono (internacional) del asesor que atiende esa ciudad, si existe. */
export function adminTelefonoPorCiudad(ciudad: string): string | undefined {
  const asesor = asesorParaLugar(ciudad);
  if (asesor?.telefono) return toIntlBolivia(asesor.telefono);
  const region = regionAdminDeCiudad(ciudad);
  return region ? toIntlBolivia(ADMIN_REGIONAL_TELEFONO[region]) : undefined;
}

/** True SOLO si el número es el del Gerente General (Andrés Tejada). */
export function esGerente(telefono: string): boolean {
  return toIntlBolivia(telefono) === toIntlBolivia(ADMIN_TELEFONO);
}

/**
 * Quién puede emitir la cotización en PDF.
 *
 * Gladymar la restringió el 15/09/2026: no la genera el cliente final ni los
 * admins regionales. Queda el Gerente General, más los números que se carguen
 * en COTIZACION_PDF_TELEFONOS (por defecto, Soporte Prime para poder probarla).
 *
 * Se lee de configuración y no del código para que sumar o sacar a alguien no
 * requiera un despliegue.
 */
export function puedeCotizarPDF(telefono: string): boolean {
  if (esGerente(telefono)) return true;
  const intl = toIntlBolivia(telefono);
  return config.cotizacion.telefonosPDF.some((t) => toIntlBolivia(t) === intl);
}

/** True si el número (en cualquier formato) pertenece a un administrador. */
export function esAdmin(telefono: string): boolean {
  return Boolean(ADMIN_POR_TELEFONO[toIntlBolivia(telefono)]);
}

/**
 * Padrón canónico de administradores (para que el CRM los reconozca y los
 * marque como "Administrador" en vez de tratarlos como un cliente más).
 * external_id va en formato internacional, igual que llega de WhatsApp.
 */
export function adminRoster(): { external_id: string; nombre: string; role: string; ciudad?: string }[] {
  return Object.values(ADMIN_POR_TELEFONO).map((a) => ({
    external_id: a.id,
    nombre: a.nombre,
    role: a.role,
    ciudad: a.region,
  }));
}

/** Construye un Admin para el demo: "gerente" = Gerente General; una ciudad = su administrador regional. */
export function adminFromRole(role: string): Admin {
  if (role === "gerente") return { id: "gerente", nombre: "Gerente General", role: "gerente" };
  const nombre = ADMIN_REGIONAL_NOMBRE[role] || `Administrador ${role}`;
  return { id: `reg-${role}`, nombre, role: "regional", region: role };
}

/** Ciudades disponibles (para "ver una región" y el selector del demo). */
export function ciudadesAdmin(): string[] {
  return ciudadesConSucursal();
}
