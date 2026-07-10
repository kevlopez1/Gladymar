/**
 * Almacén de solicitudes para el panel de administradores.
 *
 * Guarda los leads/cotizaciones, reclamos y seguimientos que el agente
 * registra (vía registrar_solicitud), para que los administradores los
 * consulten. La fuente de verdad es Postgres (ver ../db/index.ts), que
 * sobrevive a los redeploys; el arreglo en memoria queda solo como respaldo
 * si la base de datos no está configurada o no responde.
 */
import { nowBolivia } from "../integrations/sheets.js";
import { insertarSolicitud, obtenerSolicitudes } from "../db/index.js";

export interface SolicitudReg {
  tipo: string;
  prioridad: string;
  nombre?: string;
  ciudad?: string;
  telefono?: string;
  detalle: string;
  fecha: string;
  /** Timestamp real (epoch ms) para filtrar y ordenar con precisión. */
  creadoEn: number;
}

// Contador en memoria (se resetea con cada redeploy). Se usa solo como
// respaldo cuando no se puede leer el conteo real desde Google Sheets
// (ver integrations/sheetsStats.ts).
let conversaciones = 0;
export function bumpConversacion(): void {
  conversaciones += 1;
}
export function totalConversaciones(): number {
  return conversaciones;
}

// Respaldo en memoria: solo se usa si Postgres no está configurada o falla.
const registros: SolicitudReg[] = [];

function norm(s?: string): string {
  return (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}
function scope(list: SolicitudReg[], ciudad?: string): SolicitudReg[] {
  if (!ciudad) return list;
  const q = norm(ciudad);
  return list.filter((r) => norm(r.ciudad).includes(q));
}

/** Fecha de hoy (parte de día) en formato de nowBolivia, ej. "2/7/2026". */
function hoyStr(): string {
  return new Date().toLocaleString("es-BO", { timeZone: "America/La_Paz", hour12: false }).split(",")[0].trim();
}
/** ¿La fecha del registro corresponde a HOY, en zona horaria Bolivia? */
export function esDeHoy(fecha: string): boolean {
  return fecha.split(",")[0].trim() === hoyStr();
}

/** Ordena del más reciente al más antiguo (created_at DESC). */
function porRecencia(list: SolicitudReg[]): SolicitudReg[] {
  return [...list].sort((a, b) => b.creadoEn - a.creadoEn);
}

/**
 * Registra una nueva solicitud (la llama el agente al derivar). Nunca lanza:
 * un fallo acá no debe interrumpir la atención al cliente, solo se loguea.
 * Se guarda en memoria de inmediato (respaldo) y en Postgres en segundo
 * plano (persistente, no bloquea la respuesta al cliente).
 */
export function recordSolicitud(r: {
  tipo: string;
  prioridad?: string;
  nombre?: string;
  ciudad?: string;
  telefono?: string;
  detalle: string;
}): void {
  const nuevo: SolicitudReg = {
    tipo: r.tipo,
    prioridad: r.prioridad || "normal",
    nombre: r.nombre,
    ciudad: r.ciudad,
    telefono: r.telefono,
    detalle: r.detalle,
    fecha: nowBolivia(),
    creadoEn: Date.now(),
  };
  try {
    registros.unshift(nuevo);
  } catch (err) {
    console.error("No se pudo registrar la solicitud en el respaldo en memoria:", err);
  }
  void insertarSolicitud(nuevo);
  cache = null; // invalida la caché de lectura para reflejar esta solicitud enseguida
}

// Caché corta de lectura: evita pegarle a Postgres varias veces por comando
// (ej. "Reportes globales" consulta cada ciudad por separado).
let cache: { data: SolicitudReg[]; expiraEn: number } | null = null;
const CACHE_MS = 3000;

async function todasLasSolicitudes(): Promise<SolicitudReg[]> {
  if (cache && cache.expiraEn > Date.now()) return cache.data;
  const desdeDb = await obtenerSolicitudes();
  const data = desdeDb ?? registros;
  cache = { data, expiraEn: Date.now() + CACHE_MS };
  return data;
}

export async function getLeads(ciudad?: string): Promise<SolicitudReg[]> {
  const todas = await todasLasSolicitudes();
  return porRecencia(scope(todas.filter((r) => r.tipo === "cotizacion" || r.tipo === "contactar_asesor"), ciudad));
}
export async function getReclamos(ciudad?: string): Promise<SolicitudReg[]> {
  const todas = await todasLasSolicitudes();
  return porRecencia(scope(todas.filter((r) => r.tipo === "reclamo"), ciudad));
}
export async function getSeguimientos(ciudad?: string): Promise<SolicitudReg[]> {
  const todas = await todasLasSolicitudes();
  return porRecencia(scope(todas.filter((r) => r.tipo === "seguimiento_pedido"), ciudad));
}

export interface Kpis {
  leads: number;
  reclamos: number;
  reclamosPrioritarios: number;
  seguimientos: number;
}
export async function getKpis(ciudad?: string): Promise<Kpis> {
  const r = await getReclamos(ciudad);
  return {
    leads: (await getLeads(ciudad)).length,
    reclamos: r.length,
    reclamosPrioritarios: r.filter((x) => x.prioridad !== "normal").length,
    seguimientos: (await getSeguimientos(ciudad)).length,
  };
}
