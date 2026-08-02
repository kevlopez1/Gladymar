/**
 * Estadísticas reales de conversaciones, leídas directamente del Google Sheet
 * (exportado como CSV). A diferencia del contador en memoria, estos números
 * sobreviven a un redeploy porque viven en la hoja, no en el proceso.
 */
import { config } from "../config.js";
import { ciudadesConSucursal } from "../knowledge/sucursales.js";
import { obtenerConversaciones } from "../db/index.js";

/** Parser CSV robusto (soporta comillas, comas y saltos de línea dentro de un campo). */
function parseCSV(text: string): string[][] {
  const filas: string[][] = [];
  let fila: string[] = [];
  let campo = "";
  let comillas = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (comillas) {
      if (c === '"') {
        if (text[i + 1] === '"') { campo += '"'; i++; } else comillas = false;
      } else campo += c;
    } else if (c === '"') {
      comillas = true;
    } else if (c === ",") {
      fila.push(campo); campo = "";
    } else if (c === "\r") {
      /* ignora */
    } else if (c === "\n") {
      fila.push(campo); filas.push(fila); fila = []; campo = "";
    } else {
      campo += c;
    }
  }
  if (campo !== "" || fila.length) { fila.push(campo); filas.push(fila); }
  return filas;
}

/** Detecta la ciudad mencionada en un texto (contra las ciudades con sucursal). */
function detectarCiudad(text: string): string | undefined {
  const t = (text || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  for (const c of ciudadesConSucursal()) {
    const cn = c.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    if (new RegExp(`\\b${cn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t)) return c;
  }
  if (/\bsanta\s*cruz\b|\bsta\.?\s*cruz\b/.test(t)) return "Santa Cruz";
  return undefined;
}

/** Fecha de hoy (parte de día) en Bolivia, ej. "9/7/2026". */
function hoyStr(): string {
  return new Date().toLocaleString("es-BO", { timeZone: "America/La_Paz", hour12: false }).split(",")[0].trim();
}

export interface StatsHoy {
  conversacionesHoy: number;
  contactosUnicosHoy: number;
  /** Clientes distintos de hoy, por ciudad detectada. */
  porCiudadHoy: Record<string, number>;
}

/**
 * Estadísticas de hoy calculadas desde Postgres (nuestro propio registro).
 * Es la fuente confiable: el Google Sheet depende de un Apps Script externo
 * que ya se cayó antes y dejó de recibir conversaciones.
 */
async function statsDesdePostgres(): Promise<StatsHoy | null> {
  const filas = await obtenerConversaciones(5000);
  if (filas === null) return null;
  const hoy = hoyStr();

  const contactos = new Set<string>();
  const ciudadDe = new Map<string, string>();
  let conversacionesHoy = 0;

  for (const f of filas) {
    if (f.fecha.split(",")[0].trim() !== hoy) continue;
    conversacionesHoy++;
    const tel = f.telefono.replace(/\D/g, "");
    if (!tel) continue;
    contactos.add(tel);
    if (!ciudadDe.has(tel)) {
      const cd = f.ciudad?.trim() || detectarCiudad(`${f.mensaje} ${f.detalle || ""}`);
      if (cd) ciudadDe.set(tel, cd);
    }
  }

  const porCiudadHoy: Record<string, number> = {};
  for (const c of ciudadDe.values()) porCiudadHoy[c] = (porCiudadHoy[c] || 0) + 1;
  return { conversacionesHoy, contactosUnicosHoy: contactos.size, porCiudadHoy };
}

/**
 * Estadísticas REALES de hoy. Primero Postgres (nuestro registro, siempre al
 * día); si no está disponible, se cae al Google Sheet. Nunca lanza: si ambos
 * fallan devuelve null para que el caller use su propio respaldo.
 */
export async function obtenerStatsHoy(): Promise<StatsHoy | null> {
  const desdeDb = await statsDesdePostgres();
  if (desdeDb && desdeDb.conversacionesHoy > 0) return desdeDb;

  if (!config.crm.backfillSheetId) return desdeDb;
  try {
    const url = `https://docs.google.com/spreadsheets/d/${config.crm.backfillSheetId}/export?format=csv`;
    const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    const csv = await res.text();
    if (!res.ok || csv.trimStart().startsWith("<")) return desdeDb;

    const filas = parseCSV(csv);
    if (filas.length < 2) return { conversacionesHoy: 0, contactosUnicosHoy: 0, porCiudadHoy: {} };

    const enc = filas[0].map((h) => h.toLowerCase());
    const idx = (n: string) => enc.findIndex((h) => h.includes(n));
    const iFecha = idx("fecha"), iTel = idx("tel"), iMsg = idx("mensaje"), iDet = idx("detalle"), iCiudad = idx("ciudad");
    const hoy = hoyStr();

    const contactos = new Set<string>();
    const ciudadDe = new Map<string, string>();
    let conversacionesHoy = 0;

    for (let k = 1; k < filas.length; k++) {
      const f = filas[k];
      const fecha = (iFecha >= 0 ? f[iFecha] || "" : "").split(",")[0].trim();
      if (fecha !== hoy) continue;
      conversacionesHoy++;

      const tel = (iTel >= 0 ? f[iTel] || "" : "").replace(/\D/g, "");
      if (!tel) continue;
      contactos.add(tel);
      if (!ciudadDe.has(tel)) {
        const ciudadCol = iCiudad >= 0 ? (f[iCiudad] || "").trim() : "";
        const cd = ciudadCol || detectarCiudad(`${iMsg >= 0 ? f[iMsg] || "" : ""} ${iDet >= 0 ? f[iDet] || "" : ""}`);
        if (cd) ciudadDe.set(tel, cd);
      }
    }

    const porCiudadHoy: Record<string, number> = {};
    for (const c of ciudadDe.values()) porCiudadHoy[c] = (porCiudadHoy[c] || 0) + 1;

    return { conversacionesHoy, contactosUnicosHoy: contactos.size, porCiudadHoy };
  } catch (err) {
    // Solo el mensaje: este respaldo falla de forma rutinaria (la hoja es
    // grande y a veces tarda) y volcar el stack completo cada 15 minutos
    // llenaba los logs sin aportar nada. El dato de Postgres ya cubre el caso.
    console.warn(`Respaldo de stats por Sheet no disponible (${(err as Error)?.message ?? err}); se usa Postgres.`);
    return desdeDb;
  }
}
