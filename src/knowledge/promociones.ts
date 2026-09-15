/**
 * Promociones y descuentos vigentes.
 *
 * Lo promete la propuesta (pág. 6): los dos números "cotizan con la lista de
 * precios de Gladymar y ofrecen las promociones vigentes".
 *
 * DE DÓNDE SALEN. De una hoja de Google que administra Gladymar (PROMOS_SHEET_ID),
 * igual que la hoja de despachos: ellos la editan, el bot la lee. No se cargan
 * en el código porque una promoción cambia cada semana y nadie va a pedir un
 * despliegue por eso.
 *
 * SI NO HAY HOJA CONFIGURADA, o está vacía, o no se pudo leer, la lista queda
 * VACÍA y el agente no menciona ninguna promoción. Nunca se inventa una: una
 * promo inventada es una promesa que Gladymar tiene que honrar en el mostrador.
 *
 * Columnas esperadas (la fila de títulos es la que tiene TITULO):
 *   TITULO | DETALLE | CIUDAD | DESDE | HASTA | ACTIVA
 *   - CIUDAD vacía = vale para todo el país.
 *   - DESDE/HASTA vacías = sin límite por ese lado.
 *   - ACTIVA distinto de "NO" = activa.
 */
import { config } from "../config.js";
import { parseCSV } from "../util/csv.js";
import { departamentoDeLugar } from "./departamentos.js";

export interface Promocion {
  titulo: string;
  detalle: string;
  /** Departamento canónico al que aplica; undefined = todo el país. */
  departamento?: string;
  desde?: string;
  hasta?: string;
}

let cache: { promos: Promocion[]; vence: number } = { promos: [], vence: 0 };
/** 15 minutos: una promo no cambia cada minuto y la hoja la editan a mano. */
const TTL_MS = 15 * 60 * 1000;

function hoyISO(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/La_Paz" });
}

/** "15/09/2026", "2026-09-15" -> "2026-09-15". Vacío si no se entiende. */
function fechaISO(valor: string): string | undefined {
  const t = (valor || "").trim();
  if (!t) return undefined;
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = t.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  return undefined;
}

async function descargar(): Promise<Promocion[]> {
  if (!config.promociones.sheetId) return [];
  try {
    const url = `https://docs.google.com/spreadsheets/d/${config.promociones.sheetId}/export?format=csv`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      console.warn(`🎁 No se pudo leer la hoja de promociones: HTTP ${res.status}`);
      return [];
    }
    const csv = await res.text();
    if (csv.trimStart().startsWith("<")) {
      console.warn("🎁 La hoja de promociones devolvió HTML: hay que compartirla como 'Cualquiera con el enlace: Lector'.");
      return [];
    }

    const filas = parseCSV(csv);
    const encIdx = filas.findIndex((f) => f.some((c) => c.trim().toUpperCase() === "TITULO"));
    if (encIdx === -1) {
      console.warn("🎁 La hoja de promociones no tiene una columna TITULO; no se carga ninguna.");
      return [];
    }
    const enc = filas[encIdx].map((c) => c.trim().toUpperCase());
    const col = (n: string) => enc.indexOf(n);
    const iTitulo = col("TITULO"), iDetalle = col("DETALLE"), iCiudad = col("CIUDAD");
    const iDesde = col("DESDE"), iHasta = col("HASTA"), iActiva = col("ACTIVA");

    const hoy = hoyISO();
    const promos: Promocion[] = [];
    for (let r = encIdx + 1; r < filas.length; r++) {
      const f = filas[r];
      const titulo = (f[iTitulo] ?? "").trim();
      if (!titulo) continue;
      if (iActiva >= 0 && (f[iActiva] ?? "").trim().toUpperCase() === "NO") continue;

      const desde = iDesde >= 0 ? fechaISO(f[iDesde] ?? "") : undefined;
      const hasta = iHasta >= 0 ? fechaISO(f[iHasta] ?? "") : undefined;
      // Una promo vencida en la hoja no se ofrece aunque nadie la haya borrado.
      if (desde && hoy < desde) continue;
      if (hasta && hoy > hasta) continue;

      const ciudad = iCiudad >= 0 ? (f[iCiudad] ?? "").trim() : "";
      promos.push({
        titulo,
        detalle: iDetalle >= 0 ? (f[iDetalle] ?? "").trim() : "",
        departamento: ciudad ? departamentoDeLugar(ciudad) : undefined,
        desde,
        hasta,
      });
    }
    console.log(`🎁 ${promos.length} promoción(es) vigente(s) cargadas de la hoja.`);
    return promos;
  } catch (err) {
    console.warn("🎁 No se pudo descargar la hoja de promociones:", err);
    return [];
  }
}

/** Promociones vigentes, opcionalmente filtradas por la ciudad del cliente. */
export async function promocionesVigentes(ciudad?: string): Promise<Promocion[]> {
  if (Date.now() > cache.vence) {
    cache = { promos: await descargar(), vence: Date.now() + TTL_MS };
  }
  const depto = ciudad ? departamentoDeLugar(ciudad) : undefined;
  // Sin departamento del cliente solo se ofrecen las nacionales: mencionarle una
  // promo de otra ciudad es peor que no mencionar ninguna.
  return cache.promos.filter((p) => !p.departamento || (depto && p.departamento === depto));
}

/** Texto para el agente. Vacío si no hay ninguna vigente. */
export function formatearPromociones(promos: Promocion[]): string {
  if (!promos.length) return "";
  return promos
    .map((p) => {
      const partes = [`*${p.titulo}*`];
      if (p.detalle) partes.push(p.detalle);
      if (p.hasta) partes.push(`Vigente hasta el ${p.hasta.split("-").reverse().join("/")}.`);
      if (p.departamento) partes.push(`Solo en ${p.departamento}.`);
      return partes.join(" ");
    })
    .join("\n");
}
