/**
 * Roles de administrador del panel de Gladymar.
 *
 * - Gerente General: acceso NACIONAL + comandos exclusivos.
 * - Admins regionales: acceso solo a SU ciudad. Sus números son los WhatsApp
 *   de las sucursales (de src/knowledge/sucursales.ts).
 *
 * El número del Gerente General se define con la variable de entorno
 * GERENTE_TELEFONO (lo proporcionará Gladymar).
 */
import { SUCURSALES, ciudadesConSucursal } from "../knowledge/sucursales.js";

export interface Admin {
  id: string;
  nombre: string;
  role: "gerente" | "regional";
  region?: string; // ciudad, solo para regionales
}

/** Mapa teléfono -> Admin (para enrutar en WhatsApp real). */
export const ADMIN_POR_TELEFONO: Record<string, Admin> = {};
for (const s of SUCURSALES) {
  if (s.whatsapp) {
    ADMIN_POR_TELEFONO[s.whatsapp] = {
      id: s.whatsapp,
      nombre: `${s.ciudad} · ${s.nombre}`,
      role: "regional",
      region: s.ciudad,
    };
  }
}
const GERENTE_TEL = (process.env.GERENTE_TELEFONO || "").trim();
if (GERENTE_TEL) {
  ADMIN_POR_TELEFONO[GERENTE_TEL] = { id: GERENTE_TEL, nombre: "Gerente General", role: "gerente" };
}

/** Devuelve el admin asociado a un número, si existe. */
export function getAdminByPhone(telefono: string): Admin | undefined {
  return ADMIN_POR_TELEFONO[telefono];
}

/** Construye un Admin a partir de un rol del demo ("gerente" o una ciudad). */
export function adminFromRole(role: string): Admin {
  if (role === "gerente") return { id: "gerente", nombre: "Gerente General", role: "gerente" };
  return { id: `reg-${role}`, nombre: `Admin ${role}`, role: "regional", region: role };
}

/** Ciudades disponibles (para "ver una región" y el selector del demo). */
export function ciudadesAdmin(): string[] {
  return ciudadesConSucursal();
}
