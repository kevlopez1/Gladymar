/**
 * Roles de administrador del panel de Gladymar.
 *
 * Hay UN solo administrador para toda Bolivia, con acceso NACIONAL y todos los
 * comandos. Su número se define con la variable de entorno GERENTE_TELEFONO
 * (por defecto, el número proporcionado por Gladymar).
 */
import { ciudadesConSucursal } from "../knowledge/sucursales.js";

export interface Admin {
  id: string;
  nombre: string;
  role: "gerente" | "regional";
  region?: string; // ciudad, solo para regionales (no usado: hay un único admin nacional)
}

/** Número del administrador (formato internacional sin "+", como llega de WhatsApp). */
export const ADMIN_TELEFONO = (process.env.GERENTE_TELEFONO || "59167401827").trim();

const ADMIN: Admin = { id: ADMIN_TELEFONO, nombre: "Gerente General", role: "gerente" };

/** Mapa teléfono -> Admin (para enrutar en WhatsApp real). */
export const ADMIN_POR_TELEFONO: Record<string, Admin> = { [ADMIN_TELEFONO]: ADMIN };

/** Devuelve el admin asociado a un número, si existe. */
export function getAdminByPhone(telefono: string): Admin | undefined {
  return ADMIN_POR_TELEFONO[telefono];
}

/** Construye un Admin para el demo (siempre el admin nacional). */
export function adminFromRole(_role?: string): Admin {
  return ADMIN;
}

/** Ciudades disponibles (para "ver una región"). */
export function ciudadesAdmin(): string[] {
  return ciudadesConSucursal();
}

