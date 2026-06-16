/**
 * Manejo de comandos del panel de administradores (determinista, sin IA).
 *
 * Comandos base (regionales, solo su ciudad): leads, reclamos, resumen.
 * Exclusivos del Gerente General (nacional): reportes globales, comunicado,
 * ver cualquier región.
 */
import type { Admin } from "./roles.js";
import { ciudadesAdmin } from "./roles.js";
import {
  getLeads,
  getReclamos,
  getKpis,
  totalConversaciones,
  type SolicitudReg,
} from "./data.js";

export interface AdminReply {
  text: string;
  options?: string[];
  optionsButton?: string;
  optionsTitle?: string;
}

// Estado para flujos de varios pasos (comunicado, ver región), por sesión.
const pendiente = new Map<string, { accion: string }>();

const VOLVER: Pick<AdminReply, "options" | "optionsButton" | "optionsTitle"> = {
  options: ["Volver al menú"],
  optionsButton: "Menú",
  optionsTitle: "Panel",
};

function norm(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

function menu(admin: Admin): AdminReply {
  const base = ["Leads y cotizaciones", "Reclamos prioritarios", "Resumen del día"];
  const gm = ["Reportes globales", "Enviar comunicado", "Ver una región"];
  const opciones = admin.role === "gerente" ? [...base, ...gm] : base;
  const ambito = admin.role === "gerente" ? "Nacional 🇧🇴" : admin.region;
  return {
    text: `*Panel Gladymar* · ${admin.nombre}\nÁmbito: *${ambito}*\n\n¿Qué deseas ver?`,
    options: opciones,
    optionsButton: "Ver comandos",
    optionsTitle: "Comandos disponibles",
  };
}

function fmtItem(r: SolicitudReg): string {
  const p = r.prioridad === "critica" ? " 🔴" : r.prioridad === "alta" ? " 🟠" : "";
  return `• *${r.nombre || "Cliente"}* · ${r.ciudad || "?"}${p}\n   ${r.detalle}  _(${r.fecha})_`;
}

function listLeads(ciudad?: string): string {
  const l = getLeads(ciudad).slice(0, 8);
  const t = ciudad ? `en *${ciudad}*` : "a nivel *nacional*";
  if (!l.length) return `No hay leads ${t} por ahora.`;
  return `🧾 *Leads y cotizaciones* (${t})\n\n` + l.map(fmtItem).join("\n");
}
function listReclamos(ciudad?: string): string {
  const l = getReclamos(ciudad).slice(0, 8);
  const t = ciudad ? `en *${ciudad}*` : "a nivel *nacional*";
  if (!l.length) return `No hay reclamos ${t}. 👌`;
  return `🚨 *Reclamos prioritarios* (${t})\n\n` + l.map(fmtItem).join("\n");
}
function resumen(ciudad?: string): string {
  const k = getKpis(ciudad);
  const t = ciudad ? `*${ciudad}*` : "*Nacional*";
  const conv = ciudad ? "" : `Conversaciones hoy: *${totalConversaciones()}*\n`;
  return (
    `📊 *Resumen de hoy* · ${t}\n\n${conv}` +
    `Leads/cotizaciones: *${k.leads}*\n` +
    `Reclamos: *${k.reclamos}* (prioritarios: ${k.reclamosPrioritarios})\n` +
    `Seguimientos: *${k.seguimientos}*`
  );
}
function reportes(): string {
  let out = `📈 *Reporte global* · Bolivia\n\nConversaciones hoy: *${totalConversaciones()}*\n`;
  for (const c of ciudadesAdmin()) {
    const k = getKpis(c);
    if (k.leads || k.reclamos || k.seguimientos) {
      out += `\n*${c}*: ${k.leads} leads · ${k.reclamos} reclamos · ${k.seguimientos} seguim.`;
    }
  }
  return out;
}

export function handleAdminCommand(sessionId: string, admin: Admin, raw: string): AdminReply {
  const text = norm(raw);
  const region = admin.role === "gerente" ? undefined : admin.region;

  // Flujos pendientes (solo Gerente General)
  const pend = pendiente.get(sessionId);
  if (pend) {
    pendiente.delete(sessionId);
    if (pend.accion === "comunicado") {
      return { text: `✅ Comunicado enviado a los asesores (simulado):\n\n"${raw.trim()}"`, ...VOLVER };
    }
    if (pend.accion === "region") {
      const ciudad = ciudadesAdmin().find((c) => norm(c).includes(text)) || raw.trim();
      return { text: `${listLeads(ciudad)}\n\n${listReclamos(ciudad)}`, ...VOLVER };
    }
  }

  // Atajo numérico: si responde con un número, lo mapeamos a la opción del menú.
  if (/^\d+$/.test(text)) {
    const opciones = menu(admin).options || [];
    const sel = opciones[parseInt(text, 10) - 1];
    if (sel) return handleAdminCommand(sessionId, admin, sel);
  }

  if (!text || /(menu|menú|ayuda|hola|inicio|volver|comandos)/.test(text)) return menu(admin);
  if (/(lead|cotiz)/.test(text)) return { text: listLeads(region), ...VOLVER };
  if (/reclamo/.test(text)) return { text: listReclamos(region), ...VOLVER };
  if (/(resumen|kpi|del dia)/.test(text)) return { text: resumen(region), ...VOLVER };

  if (admin.role === "gerente") {
    if (/(reporte|global)/.test(text)) return { text: reportes(), ...VOLVER };
    if (/(comunicado|broadcast|aviso)/.test(text)) {
      pendiente.set(sessionId, { accion: "comunicado" });
      return { text: "✍️ Escribe el *comunicado* que deseas enviar a los asesores:" };
    }
    if (/(regi[oó]n|ciudad)/.test(text)) {
      pendiente.set(sessionId, { accion: "region" });
      return { text: "¿Qué región deseas consultar?", options: ciudadesAdmin(), optionsButton: "Elegir región", optionsTitle: "Regiones" };
    }
  } else if (/(reporte|global|comunicado|broadcast|regi[oó]n)/.test(text)) {
    return { text: "Ese comando es exclusivo del Gerente General. Tu panel cubre solo tu región.", ...VOLVER };
  }

  const m = menu(admin);
  return { ...m, text: `No reconocí ese comando.\n\n${m.text}` };
}
