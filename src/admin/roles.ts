/**
 * Roles de administrador del panel de Gladymar.
 *
 * - Gerente General (UNO, nacional): todos los comandos, ámbito nacional.
 *   Su número se define con GERENTE_TELEFONO (Andres Tejada).
 * - Administradores regionales: uno por ciudad, ven SOLO su región y los
 *   comandos base. Sus números son los WhatsApp de las sucursales.
 */
import { ciudadesConSucursal } from "../knowledge/sucursales.js";
import { departamentoDeLugar, REGION_ASESOR } from "../knowledge/departamentos.js";

export interface Admin {
  id: string;
  nombre: string;
  role: "gerente" | "regional";
  region?: string; // ciudad, solo para regionales
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
for (const [ciudad, num] of Object.entries(ADMIN_REGIONAL_TELEFONO)) {
  const tel = toIntlBolivia(num);
  ADMIN_POR_TELEFONO[tel] = {
    id: tel,
    nombre: ADMIN_REGIONAL_NOMBRE[ciudad] || `Administrador ${ciudad}`,
    role: "regional",
    region: ciudad,
  };
}
// El Gerente General tiene prioridad (acceso nacional).
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

/** Nombre del asesor que atiende ese lugar, tal cual va al CRM (con tildes). */
export function adminNombrePorCiudad(ciudad?: string): string | undefined {
  const region = regionAdminDeCiudad(ciudad);
  return region ? ADMIN_REGIONAL_NOMBRE[region] : undefined;
}

/** Teléfono (internacional) del administrador regional de una ciudad, si existe. */
export function adminTelefonoPorCiudad(ciudad: string): string | undefined {
  const region = regionAdminDeCiudad(ciudad);
  return region ? toIntlBolivia(ADMIN_REGIONAL_TELEFONO[region]) : undefined;
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
