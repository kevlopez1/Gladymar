/**
 * Sucursales de Cerámica Gladymar — listado OFICIAL completo.
 *
 * Fuente: listado oficial proporcionado por Gladymar (Andrés Tejada).
 * Cubre Santa Cruz, La Paz, Cochabamba, Sucre, Tarija, Oruro y Potosí.
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
  /** Si true, el WhatsApp de esta sucursal es el del administrador regional del departamento. */
  admin?: boolean;
}

export const SUCURSALES: Sucursal[] = [
  // ── Santa Cruz ──
  {
    ciudad: "Santa Cruz",
    nombre: "Gladymar Plus",
    direccion: "Av. Banzer, 3er anillo interno",
    telefono: "3441616",
    whatsapp: "67703821",
    horario: "Lun-Vie 09:00-18:30, Sáb 09:00-13:00",
    admin: true,
  },
  {
    ciudad: "Santa Cruz",
    nombre: "Canal Cotoca",
    direccion: "Av. Santa Cruz #2015 esq. Guapay",
    telefono: "3468383",
    whatsapp: "72238416",
    horario: "Lun-Vie 08:30-18:30, Sáb 09:00-13:00",
  },
  {
    ciudad: "Santa Cruz",
    nombre: "Fábrica (Parque Industrial)",
    direccion: "Parque Industrial Mz. 11",
    telefono: "3466868",
    whatsapp: "71656258",
    horario: "Lun-Vie 08:30-16:30, Sáb 09:00-13:00",
  },
  {
    ciudad: "Santa Cruz",
    nombre: "Montero",
    direccion: "Av. Circunvalación Este, C/ 19 de Agosto",
    whatsapp: "67895527",
    horario: "Lun-Vie 08:30-16:30, Sáb 09:00-13:00",
  },
  // ── La Paz ──
  {
    ciudad: "La Paz",
    nombre: "Calacoto (Ballivián)",
    direccion: "Calacoto, Av. Ballivián esq. calle 16",
    telefono: "2774454",
    whatsapp: "71557028",
    horario: "Lun-Vie 08:30-18:30, Sáb 08:30-12:30",
    admin: true,
  },
  {
    ciudad: "La Paz",
    nombre: "Montes",
    direccion: "Av. Montes No. 560",
    telefono: "2111519",
    whatsapp: "67896857",
    horario: "Lun-Vie 08:30-18:30, Sáb 08:30-12:30",
  },
  // La agencia de El Alto (Av. Juan Pablo II) se cerró: la quitó Gerencia el
  // 3/8/2026. No volver a agregarla sin confirmación de Gladymar.
  // ── Cochabamba ──
  {
    ciudad: "Cochabamba",
    nombre: "Blanco Galindo",
    direccion: "Av. Blanco Galindo No. 1532, Km 1½",
    telefono: "4361466",
    whatsapp: "67408846",
    horario: "Lun-Vie 08:30-18:30, Sáb 09:00-13:00",
    admin: true,
  },
  {
    ciudad: "Cochabamba",
    nombre: "Juan de la Rosa",
    direccion: "Av. Juan de la Rosa 311 y Av. América",
    telefono: "4361466",
    whatsapp: "67408846",
    horario: "Lun-Vie 08:30-18:30, Sáb 09:00-13:00",
  },
  // ── Sucre ──
  {
    ciudad: "Sucre",
    nombre: "Sucre",
    direccion: "Av. Ostria Gutiérrez N° 191, Zona Bancario",
    telefono: "6422828",
    whatsapp: "67900508",
    horario: "Lun-Vie 08:30-12:30 y 14:30-18:30, Sáb 08:30-12:30",
    admin: true,
  },
  // ── Tarija ──
  {
    ciudad: "Tarija",
    nombre: "Tarija",
    direccion: "Av. La Paz esq. Ingavi",
    telefono: "6650517",
    whatsapp: "72987241",
    horario: "Lun-Vie 08:30-12:30 y 14:30-18:30, Sáb 08:30-12:30",
    admin: true,
  },
  // ── Oruro ──
  {
    ciudad: "Oruro",
    nombre: "Oruro",
    direccion: "C/ Pagador No. 5599 esq. C/ Caro",
    whatsapp: "72303568",
    horario: "Lun-Vie 08:00-18:00, Sáb 09:00-13:00",
    admin: true,
  },
  // ── Potosí ──
  {
    ciudad: "Potosí",
    nombre: "Potosí Central",
    direccion: "C/ La Paz esq. Lucas Laime",
    whatsapp: "69612800",
    horario: "Lun-Vie 08:00-18:00, Sáb 09:00-13:00",
    admin: true,
  },
];

/** Lista de ciudades con sucursales. */
export function ciudadesConSucursal(): string[] {
  return [...new Set(SUCURSALES.map((s) => s.ciudad))];
}

/** Filtra sucursales por ciudad o nombre de sucursal (flexible, sin tildes/mayúsculas). */
export function sucursalesPorCiudad(ciudad?: string): Sucursal[] {
  if (!ciudad) return SUCURSALES;
  const q = normalizar(ciudad);
  const filtradas = SUCURSALES.filter(
    (s) => normalizar(s.ciudad).includes(q) || normalizar(s.nombre).includes(q),
  );
  return filtradas.length > 0 ? filtradas : SUCURSALES;
}

/** Formatea una sucursal para mostrarla al cliente (WhatsApp como link, sin fijos). */
export function formatearSucursal(s: Sucursal): string {
  const lineas = [`◆ *${s.ciudad} · ${s.nombre}*`, `   ${s.direccion}`];
  if (s.whatsapp) {
    const d = s.whatsapp.replace(/\D/g, "");
    const intl = d.startsWith("591") ? d : `591${d}`;
    lineas.push(`   WhatsApp: https://wa.me/${intl}`);
  }
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
