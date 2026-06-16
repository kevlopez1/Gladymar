/**
 * Roles de administrador del panel de Gladymar.
 *
 * - Gerente General (UNO, nacional): todos los comandos, ámbito nacional.
 *   Su número se define con GERENTE_TELEFONO (Andres Tejada).
 * - Administradores regionales: uno por ciudad, ven SOLO su región y los
 *   comandos base. Sus números son los WhatsApp de las sucursales.
 */
import { ciudadesConSucursal } from "../knowledge/sucursales.js";

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

function normCiudad(s: string): string {
  return (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

/** Devuelve el admin asociado a un número, si existe (normaliza el remitente). */
export function getAdminByPhone(telefono: string): Admin | undefined {
  return ADMIN_POR_TELEFONO[toIntlBolivia(telefono)];
}

/** Teléfono (internacional) del administrador regional de una ciudad, si existe. */
export function adminTelefonoPorCiudad(ciudad: string): string | undefined {
  const c = normCiudad(ciudad);
  if (!c) return undefined;
  for (const [nombre, num] of Object.entries(ADMIN_REGIONAL_TELEFONO)) {
    const n = normCiudad(nombre);
    if (n === c || c.includes(n) || n.includes(c)) return toIntlBolivia(num);
  }
  return undefined;
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
