/**
 * Roles de administrador del panel de Gladymar.
 *
 * - Gerente General (UNO, nacional): todos los comandos, ámbito nacional.
 *   Su número se define con GERENTE_TELEFONO (Andres Tejada).
 * - Administradores regionales: uno por ciudad, ven SOLO su región y los
 *   comandos base. Sus números son los WhatsApp de las sucursales.
 */
import { SUCURSALES, ciudadesConSucursal } from "../knowledge/sucursales.js";

export interface Admin {
  id: string;
  nombre: string;
  role: "gerente" | "regional";
  region?: string; // ciudad, solo para regionales
}

/** Número del Gerente General (formato internacional sin "+", como llega de WhatsApp). */
export const ADMIN_TELEFONO = (process.env.GERENTE_TELEFONO || "59167401827").trim();

/** Mapa teléfono -> Admin (para enrutar en WhatsApp real). */
export const ADMIN_POR_TELEFONO: Record<string, Admin> = {};
for (const s of SUCURSALES) {
  if (s.whatsapp) {
    ADMIN_POR_TELEFONO[s.whatsapp] = {
      id: s.whatsapp,
      nombre: `Administrador ${s.ciudad}`,
      role: "regional",
      region: s.ciudad,
    };
  }
}
// El Gerente General tiene prioridad (acceso nacional).
ADMIN_POR_TELEFONO[ADMIN_TELEFONO] = { id: ADMIN_TELEFONO, nombre: "Gerente General", role: "gerente" };

/** Devuelve el admin asociado a un número, si existe. */
export function getAdminByPhone(telefono: string): Admin | undefined {
  return ADMIN_POR_TELEFONO[telefono];
}

/** Construye un Admin para el demo: "gerente" = Gerente General; una ciudad = administrador regional. */
export function adminFromRole(role: string): Admin {
  if (role === "gerente") return { id: "gerente", nombre: "Gerente General", role: "gerente" };
  return { id: `reg-${role}`, nombre: `Administrador ${role}`, role: "regional", region: role };
}

/** Ciudades disponibles (para "ver una región" y el selector del demo). */
export function ciudadesAdmin(): string[] {
  return ciudadesConSucursal();
}
