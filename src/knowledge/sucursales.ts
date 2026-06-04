/**
 * Sucursales de Cerámica Gladymar.
 *
 * Las marcadas `confirmado: true` provienen del listado OFICIAL enviado por
 * Gladymar (Andrés Tejada). Las marcadas `confirmado: false` provienen de
 * fuentes públicas y están PENDIENTES de confirmación oficial (el mensaje
 * oficial se cortó tras "La Paz – Montes"; faltan datos de Montes, Ingavi,
 * Juan Pablo II y Cochabamba).
 *
 * Nota: los enlaces de ubicación (GPS) de cada sucursal están en gladymar.com.bo.
 */

export interface Sucursal {
  ciudad: string;
  nombre: string;
  direccion: string;
  telefono?: string;
  whatsapp?: string;
  horario?: string;
  /** true = dato oficial confirmado por Gladymar; false = fuente pública por confirmar. */
  confirmado: boolean;
}

export const SUCURSALES: Sucursal[] = [
  // ── Santa Cruz (oficial) ──
  {
    ciudad: "Santa Cruz",
    nombre: "Gladymar Plus",
    direccion: "Av. Banzer, 3er anillo interno",
    telefono: "3441616",
    whatsapp: "67703821",
    horario: "Lun-Vie 09:00-18:30, Sáb 09:00-13:00",
    confirmado: true,
  },
  {
    ciudad: "Santa Cruz",
    nombre: "Canal Cotoca",
    direccion: "Av. Santa Cruz #2015 esq. Guapay",
    telefono: "3468383",
    whatsapp: "72238416",
    horario: "Lun-Vie 08:30-18:30, Sáb 09:00-13:00",
    confirmado: true,
  },
  {
    ciudad: "Santa Cruz",
    nombre: "Fábrica (Parque Industrial)",
    direccion: "Parque Industrial Mz. 11",
    telefono: "3466868",
    whatsapp: "71656258",
    horario: "Lun-Vie 08:30-16:30, Sáb 09:00-13:00",
    confirmado: true,
  },
  {
    ciudad: "Santa Cruz",
    nombre: "Montero",
    direccion: "Av. Circunvalación Este, C/ 19 de Agosto",
    whatsapp: "67895527",
    horario: "Lun-Vie 08:30-16:30, Sáb 09:00-13:00",
    confirmado: true,
  },
  // ── La Paz ──
  {
    ciudad: "La Paz",
    nombre: "Calacoto (Ballivián)",
    direccion: "Calacoto, Av. Ballivián esq. calle 16",
    telefono: "2774454",
    whatsapp: "71557028",
    horario: "Lun-Vie 08:30-18:30, Sáb 08:30-12:30",
    confirmado: true,
  },
  {
    ciudad: "La Paz",
    nombre: "Montes",
    direccion: "Av. Montes No. 560",
    telefono: "2111519",
    // WhatsApp y horario pendientes (el mensaje oficial se cortó aquí).
    confirmado: false,
  },
  {
    ciudad: "La Paz",
    nombre: "Ingavi",
    direccion: "Av. La Paz esq. Ingavi",
    telefono: "6650517",
    whatsapp: "72987241",
    horario: "Lun-Vie 08:30-12:30 y 14:30-18:30, Sáb 08:30-12:30",
    confirmado: false,
  },
  {
    ciudad: "La Paz",
    nombre: "Juan Pablo II",
    direccion: "Av. Juan Pablo II Nro. 3184 (El Alto)",
    telefono: "2840141",
    whatsapp: "72001279",
    horario: "Lun-Vie 08:30-12:30 y 14:30-18:30, Sáb 08:30-12:30",
    confirmado: false,
  },
  // ── Cochabamba (por confirmar) ──
  {
    ciudad: "Cochabamba",
    nombre: "Blanco Galindo",
    direccion: "Av. Blanco Galindo O-1290",
    telefono: "4404036",
    confirmado: false,
  },
  {
    ciudad: "Cochabamba",
    nombre: "Melchor Pérez de Olguín",
    direccion: "Av. Melchor Pérez de Olguín s/n",
    telefono: "4446695",
    confirmado: false,
  },
];

/** Lista de ciudades con sucursales. */
export function ciudadesConSucursal(): string[] {
  return [...new Set(SUCURSALES.map((s) => s.ciudad))];
}

/** Filtra sucursales por ciudad (búsqueda flexible, sin tildes/mayúsculas). */
export function sucursalesPorCiudad(ciudad?: string): Sucursal[] {
  if (!ciudad) return SUCURSALES;
  const q = normalizar(ciudad);
  const filtradas = SUCURSALES.filter((s) => normalizar(s.ciudad).includes(q));
  return filtradas.length > 0 ? filtradas : SUCURSALES;
}

/** Formatea una sucursal para mostrarla al cliente. */
export function formatearSucursal(s: Sucursal): string {
  const lineas = [`◆ *${s.ciudad} – ${s.nombre}*`, `   ${s.direccion}`];
  if (s.telefono) lineas.push(`   Teléfono: ${s.telefono}`);
  if (s.whatsapp) lineas.push(`   WhatsApp: ${s.whatsapp}`);
  if (s.horario) lineas.push(`   ${s.horario}`);
  return lineas.join("\n");
}

function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}
