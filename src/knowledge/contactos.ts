/**
 * Áreas administrativas a las que el agente puede derivar.
 *
 * Por definición del cliente, SOLO se incluyen dos áreas además del menú
 * principal: "Compras y Servicios" y "Cómo ser distribuidor".
 *
 * ⚠️ `confirmado: false` => aún no tengo el contacto oficial del área. Mientras
 * tanto el agente NO debe inventar un contacto: toma los datos del cliente para
 * que el área correspondiente le dé seguimiento. Completa el contacto y pon
 * `confirmado: true` cuando tengas el dato oficial.
 */

export interface AreaContacto {
  id: string;
  nombre: string;
  descripcion: string;
  /** Instrucción/contacto a comunicar al cliente. */
  contacto: string;
  /** false => `contacto` es provisional; sé transparente, no lo afirmes como oficial. */
  confirmado: boolean;
}

export const AREAS: Record<string, AreaContacto> = {
  compras_servicios: {
    id: "compras_servicios",
    nombre: "Compras y Servicios (proveedores)",
    descripcion: "Contacto para proveedores, compras y servicios a la empresa.",
    contacto:
      "⚠️ POR CONFIRMAR: aún no tengo el contacto oficial del área de Compras y Servicios. " +
      "Toma los datos del proveedor (nombre, empresa, rubro, teléfono) y su motivo para que el área lo contacte. No inventes un contacto.",
    confirmado: false,
  },

  distribuidores: {
    id: "distribuidores",
    nombre: "Cómo ser distribuidor",
    descripcion: "Requisitos e información para convertirse en distribuidor de Gladymar.",
    contacto:
      "⚠️ POR CONFIRMAR: aún no tengo el contacto/requisitos oficiales para ser distribuidor. " +
      "Toma los datos del interesado (nombre, ciudad, empresa, teléfono) para que el área comercial lo contacte. No inventes requisitos ni contactos.",
    confirmado: false,
  },
};

/** IDs de áreas disponibles. */
export function areasDisponibles(): string[] {
  return Object.keys(AREAS);
}

/** Devuelve el texto de contacto para un área. */
export function infoArea(id: string): string {
  const area = AREAS[id];
  if (!area) {
    return `No reconozco el área "${id}". Áreas disponibles: ${areasDisponibles().join(", ")}.`;
  }
  const aviso = area.confirmado ? "" : " [Dato no confirmado: no lo afirmes como oficial; sé transparente.]";
  return `${area.nombre}: ${area.contacto}${aviso}`;
}
