/**
 * Almacén de solicitudes para el panel de administradores.
 *
 * Guarda en memoria los leads/cotizaciones, reclamos y seguimientos que el
 * agente registra (vía registrar_solicitud), para que los administradores los
 * consulten.
 *
 * Nota: es un único proceso (una instancia, sin réplicas) para Gladymar, así
 * que todo lo que hay acá es de Gladymar. Si el proceso se reinicia (redeploy)
 * la memoria se vacía; para persistir entre despliegues habría que pasar a una
 * base de datos real.
 */
import { nowBolivia } from "../integrations/sheets.js";

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

let conversaciones = 38; // base de demostración; sube con cada cliente atendido
export function bumpConversacion(): void {
  conversaciones += 1;
}
export function totalConversaciones(): number {
  return conversaciones;
}

// Sin datos de muestra: arranca vacío y se llena solo con solicitudes reales
// que el agente registra vía `recordSolicitud` (ver registrar_solicitud en
// agent/tools.ts).
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
 */
export function recordSolicitud(r: {
  tipo: string;
  prioridad?: string;
  nombre?: string;
  ciudad?: string;
  telefono?: string;
  detalle: string;
}): void {
  try {
    registros.unshift({
      tipo: r.tipo,
      prioridad: r.prioridad || "normal",
      nombre: r.nombre,
      ciudad: r.ciudad,
      telefono: r.telefono,
      detalle: r.detalle,
      fecha: nowBolivia(),
      creadoEn: Date.now(),
    });
  } catch (err) {
    console.error("No se pudo registrar la solicitud para el panel de administradores:", err);
  }
}

export function getLeads(ciudad?: string): SolicitudReg[] {
  return porRecencia(scope(registros.filter((r) => r.tipo === "cotizacion" || r.tipo === "contactar_asesor"), ciudad));
}
export function getReclamos(ciudad?: string): SolicitudReg[] {
  return porRecencia(scope(registros.filter((r) => r.tipo === "reclamo"), ciudad));
}
export function getSeguimientos(ciudad?: string): SolicitudReg[] {
  return porRecencia(scope(registros.filter((r) => r.tipo === "seguimiento_pedido"), ciudad));
}

export interface Kpis {
  leads: number;
  reclamos: number;
  reclamosPrioritarios: number;
  seguimientos: number;
}
export function getKpis(ciudad?: string): Kpis {
  const r = getReclamos(ciudad);
  return {
    leads: getLeads(ciudad).length,
    reclamos: r.length,
    reclamosPrioritarios: r.filter((x) => x.prioridad !== "normal").length,
    seguimientos: getSeguimientos(ciudad).length,
  };
}
