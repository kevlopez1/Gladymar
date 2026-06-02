/**
 * Contactos y respuestas para las CONSULTAS FRECUENTES del WhatsApp de Gladymar.
 *
 * ⚠️ IMPORTANTE: varios contactos están marcados como `confirmado: false` porque
 * son datos que Gladymar debe proporcionar (correos/números de RR.HH., compras,
 * reclamos, distribuidores). Mientras `confirmado` sea false, el agente NO debe
 * inventar un contacto: ofrecerá el canal general y tomará los datos del cliente
 * para que un asesor le devuelva el contacto. Completa estos campos y pon
 * `confirmado: true` cuando tengas el dato oficial.
 */

export interface AreaContacto {
  id: string;
  nombre: string;
  /** Qué resuelve esta área. */
  descripcion: string;
  /** Instrucción/contacto a comunicar al cliente. */
  contacto: string;
  /** false => `contacto` es provisional; el agente debe ser transparente y no afirmarlo como oficial. */
  confirmado: boolean;
}

export const AREAS: Record<string, AreaContacto> = {
  catalogo: {
    id: "catalogo",
    nombre: "Catálogo de productos",
    descripcion: "Catálogos y portafolio de productos (porcelanato, cerámica, sanitarios, etc.).",
    contacto:
      "Catálogos y descargas en: https://gladymar.com.bo/portafolio/ — Productos: https://gladymar.com.bo",
    confirmado: true,
  },

  asesor: {
    id: "asesor",
    nombre: "Contacto de un asesor de ventas",
    descripcion: "Hablar con un asesor de ventas para consultas comerciales, disponibilidad y compra.",
    contacto:
      "Usa la herramienta buscar_sucursales para entregar el WhatsApp/teléfono del asesor de la sucursal más conveniente para el cliente.",
    confirmado: true,
  },

  cotizacion: {
    id: "cotizacion",
    nombre: "Cotización",
    descripcion: "Solicitud de cotización de productos.",
    // El agente NO genera cotizaciones: las gestiona un asesor de ventas.
    contacto:
      "Las cotizaciones NO se generan por este canal automatizado: las realiza un asesor de ventas. " +
      "Explica esto con amabilidad y conecta al cliente con un asesor de la sucursal (usa buscar_sucursales) " +
      "o usa escalar_a_humano con motivo 'cotización'.",
    confirmado: true,
  },

  direcciones: {
    id: "direcciones",
    nombre: "Direcciones de sucursales",
    descripcion: "Ubicación, horarios y teléfonos de las sucursales.",
    contacto: "Usa la herramienta buscar_sucursales para dar direcciones, horarios y contactos.",
    confirmado: true,
  },

  recursos_humanos: {
    id: "recursos_humanos",
    nombre: "Recursos Humanos / Envío de CV",
    descripcion: "Postulaciones de empleo y envío de currículum (CV).",
    contacto:
      "⚠️ POR CONFIRMAR: aún no tengo el correo/canal oficial de RR.HH. para recibir CVs. " +
      "Sé transparente: indica que tomarás sus datos para que RR.HH. le indique cómo enviar su CV, " +
      "o invítalo a dejar su CV en la sucursal más cercana. No inventes un correo.",
    confirmado: false,
  },

  compras_servicios: {
    id: "compras_servicios",
    nombre: "Compras y Servicios (proveedores)",
    descripcion: "Contacto para proveedores, compras y servicios a la empresa.",
    contacto:
      "⚠️ POR CONFIRMAR: aún no tengo el contacto oficial del área de Compras y Servicios. " +
      "Toma los datos del cliente y su motivo para que el área correspondiente lo contacte. No inventes un contacto.",
    confirmado: false,
  },

  reclamos: {
    id: "reclamos",
    nombre: "Reclamos",
    descripcion: "Reclamos, garantías y posventa.",
    contacto:
      "⚠️ POR CONFIRMAR: aún no tengo el canal oficial de reclamos. " +
      "Discúlpate por el inconveniente, toma los datos del cliente y el detalle del reclamo, " +
      "y escala con escalar_a_humano (motivo 'reclamo') para que un responsable le dé seguimiento. No inventes un contacto.",
    confirmado: false,
  },

  distribuidores: {
    id: "distribuidores",
    nombre: "Cómo ser distribuidor",
    descripcion: "Requisitos e información para convertirse en distribuidor de Gladymar.",
    contacto:
      "⚠️ POR CONFIRMAR: aún no tengo el contacto/requisitos oficiales para ser distribuidor. " +
      "Toma los datos del interesado (nombre, ciudad, empresa) para que el área comercial lo contacte. No inventes requisitos ni contactos.",
    confirmado: false,
  },

  ofertas: {
    id: "ofertas",
    nombre: "Productos en descuento / Ofertas",
    descripcion: "Promociones y productos en descuento vigentes.",
    contacto:
      "⚠️ POR CONFIRMAR: las promociones cambian; no tengo una lista de ofertas vigentes cargada. " +
      "Invita al cliente a revisar https://gladymar.com.bo y sus redes oficiales, o conéctalo con un asesor " +
      "(buscar_sucursales) para conocer las promociones del momento. No inventes precios ni promociones.",
    confirmado: false,
  },
};

/** IDs de áreas disponibles (para el esquema de la herramienta). */
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
