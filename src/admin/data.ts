/**
 * Almacén de solicitudes para el panel de administradores.
 *
 * Guarda en memoria los leads/cotizaciones, reclamos y seguimientos que el
 * agente registra (vía registrar_solicitud), para que los administradores los
 * consulten. Incluye datos de muestra para la demo.
 *
 * En producción multi-instancia esto se reemplazaría por una base de datos.
 */
import { nowBolivia } from "../integrations/sheets.js";

export interface SolicitudReg {
  tipo: string;
  prioridad: string;
  nombre?: string;
  ciudad?: string;
  detalle: string;
  fecha: string;
}

let conversaciones = 38; // base de demostración; sube con cada cliente atendido
export function bumpConversacion(): void {
  conversaciones += 1;
}
export function totalConversaciones(): number {
  return conversaciones;
}

const registros: SolicitudReg[] = [
  { tipo: "reclamo", prioridad: "critica", nombre: "Luis Rojas", ciudad: "Santa Cruz", detalle: "Diferencia de tono entre piezas de porcelanato", fecha: "hoy 08:55" },
  { tipo: "cotizacion", prioridad: "alta", nombre: "María Áñez", ciudad: "Santa Cruz", detalle: "Porcelanato 60x60, ~120 m², construcción nueva", fecha: "hoy 10:15" },
  { tipo: "reclamo", prioridad: "alta", nombre: "Patricia Vaca", ciudad: "Santa Cruz", detalle: "Piso suena hueco tras la colocación", fecha: "ayer 17:20" },
  { tipo: "cotizacion", prioridad: "normal", nombre: "Jorge Téllez", ciudad: "La Paz", detalle: "Cerámica para baño, remodelación", fecha: "hoy 11:02" },
  { tipo: "seguimiento_pedido", prioridad: "normal", nombre: "Carlos Méndez", ciudad: "La Paz", detalle: "Estado de entrega pedido #4821", fecha: "hoy 12:10" },
  { tipo: "cotizacion", prioridad: "normal", nombre: "Andrea Soliz", ciudad: "Cochabamba", detalle: "Griferías Briggs para cocina", fecha: "hoy 09:40" },
  { tipo: "cotizacion", prioridad: "alta", nombre: "Estudio Arq. Vargas", ciudad: "Cochabamba", detalle: "Proyecto >1000 m², porcelanato importado", fecha: "hoy 13:05" },
];

function norm(s?: string): string {
  return (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}
function scope(list: SolicitudReg[], ciudad?: string): SolicitudReg[] {
  if (!ciudad) return list;
  const q = norm(ciudad);
  return list.filter((r) => norm(r.ciudad).includes(q));
}

/** Registra una nueva solicitud (la llama el agente al derivar). */
export function recordSolicitud(r: {
  tipo: string;
  prioridad?: string;
  nombre?: string;
  ciudad?: string;
  detalle: string;
}): void {
  registros.unshift({
    tipo: r.tipo,
    prioridad: r.prioridad || "normal",
    nombre: r.nombre,
    ciudad: r.ciudad,
    detalle: r.detalle,
    fecha: nowBolivia(),
  });
}

export function getLeads(ciudad?: string): SolicitudReg[] {
  return scope(registros.filter((r) => r.tipo === "cotizacion" || r.tipo === "contactar_asesor"), ciudad);
}
export function getReclamos(ciudad?: string): SolicitudReg[] {
  return scope(registros.filter((r) => r.tipo === "reclamo"), ciudad);
}
export function getSeguimientos(ciudad?: string): SolicitudReg[] {
  return scope(registros.filter((r) => r.tipo === "seguimiento_pedido"), ciudad);
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
