/**
 * Sucursales de Cerámica Gladymar.
 *
 * Datos recopilados de fuentes públicas (sitio web, Facebook, directorios).
 * ⚠️ VERIFICA con Gladymar: teléfonos, WhatsApp, direcciones y horarios exactos
 * antes de producción. Los números de WhatsApp aquí son referenciales.
 */

export interface Sucursal {
  ciudad: string;
  nombre: string;
  direccion: string;
  telefono?: string;
  whatsapp?: string;
  horario?: string;
}

export const SUCURSALES: Sucursal[] = [
  // ── Santa Cruz ──
  {
    ciudad: "Santa Cruz",
    nombre: "Parque Industrial",
    direccion: "Parque Industrial Mz. 12",
    telefono: "3466868",
    whatsapp: "71656258",
    horario: "Lun-Vie 08:30-16:30, Sáb 09:00-13:00",
  },
  {
    ciudad: "Santa Cruz",
    nombre: "Av. Santa Cruz",
    direccion: "Av. Santa Cruz #2015 esq. Guapay (Canal Cotoca)",
    telefono: "3468383",
    whatsapp: "72238416",
    horario: "Lun-Vie 08:30-18:30, Sáb 09:00-13:00",
  },
  {
    ciudad: "Santa Cruz",
    nombre: "Av. Circunvalación Este",
    direccion: "Av. Circunvalación Este, calle 19 de Agosto",
    whatsapp: "67895527",
    horario: "Lun-Vie 08:30-16:30, Sáb 09:00-13:00",
  },
  {
    ciudad: "Santa Cruz",
    nombre: "Montero",
    direccion: "Calle Warnes esq. Oruro, Montero",
  },
  // ── La Paz ──
  {
    ciudad: "La Paz",
    nombre: "Ingavi",
    direccion: "Av. La Paz esq. Ingavi",
    telefono: "6650517",
    whatsapp: "72987241",
    horario: "Lun-Vie 08:30-12:30 y 14:30-18:30, Sáb 08:30-12:30",
  },
  {
    ciudad: "La Paz",
    nombre: "Calacoto",
    direccion: "Av. Ballivián esq. calle 16, Calacoto",
    telefono: "2774454",
    whatsapp: "71557028",
    horario: "Lun-Vie 08:30-18:30, Sáb 08:30-12:30",
  },
  {
    ciudad: "La Paz",
    nombre: "Montes",
    direccion: "Av. Montes No. 560",
    telefono: "2111519",
    whatsapp: "67896857",
    horario: "Lun-Vie 08:30-18:30, Sáb 08:30-12:30",
  },
  {
    ciudad: "La Paz",
    nombre: "Juan Pablo II",
    direccion: "Av. Juan Pablo II Nro. 3184 (El Alto)",
    telefono: "2840141",
    whatsapp: "72001279",
    horario: "Lun-Vie 08:30-12:30 y 14:30-18:30, Sáb 08:30-12:30",
  },
  // ── Cochabamba ──
  {
    ciudad: "Cochabamba",
    nombre: "Blanco Galindo",
    direccion: "Av. Blanco Galindo O-1290",
    telefono: "4404036",
  },
  {
    ciudad: "Cochabamba",
    nombre: "Melchor Pérez de Olguín",
    direccion: "Av. Melchor Pérez de Olguín s/n",
    telefono: "4446695",
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
  const lineas = [`📍 *${s.ciudad} – ${s.nombre}*`, `   ${s.direccion}`];
  if (s.telefono) lineas.push(`   ☎️ Teléfono: ${s.telefono}`);
  if (s.whatsapp) lineas.push(`   💬 WhatsApp: ${s.whatsapp}`);
  if (s.horario) lineas.push(`   🕐 ${s.horario}`);
  return lineas.join("\n");
}

function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}
