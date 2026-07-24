/**
 * Consulta de estado de pedidos (trazabilidad de despacho).
 *
 * Lee en tiempo real la hoja de control de despacho de Gladymar (Google
 * Sheets, NO es una hoja nuestra: la administra logística de la empresa,
 * solo la leemos vía export público). Tiene varias pestañas; buscamos la
 * factura en las que traen movimientos de despacho reales.
 *
 * Se descarga el libro completo en formato .xlsx (una sola descarga trae
 * TODAS las pestañas) y se procesa con `exceljs`. Nunca lanza: si falla
 * (sin red, hoja no compartida, formato inesperado), devuelve null para
 * que el agente derive a un asesor en vez de inventar un estado.
 */
import ExcelJS from "exceljs";
import { config } from "../config.js";

/** Pestañas donde puede aparecer una factura, en orden de prioridad (más reciente primero). */
const PESTAÑAS = ["DESPACHOS", "BASE DE DATOS"];

export interface LineaPedido {
  producto: string;
  cantidad: string;
  unidad: string;
  estado: string;
}

export interface ResultadoPedido {
  factura: string;
  cliente: string;
  fechaProgramacion: string;
  transportista: string;
  horaLlegada: string;
  lineas: LineaPedido[];
}

/** Encuentra la fila de encabezado (la que tiene "FACTURA" como valor de celda) y arma un índice columna->nombre. */
function detectarEncabezado(ws: ExcelJS.Worksheet): { fila: number; indice: Record<string, number> } | null {
  for (let r = 1; r <= Math.min(ws.rowCount, 10); r++) {
    const row = ws.getRow(r);
    const valores = (row.values as unknown[]).map((v) => String(v ?? "").trim().toUpperCase());
    if (valores.includes("FACTURA")) {
      const indice: Record<string, number> = {};
      valores.forEach((v, i) => {
        if (v) indice[v] = i;
      });
      return { fila: r, indice };
    }
  }
  return null;
}

/** ¿Es una celda de solo-hora? Excel las guarda como fecha en su época base (30/12/1899). */
function esSoloHora(d: Date): boolean {
  return d.getFullYear() === 1899 || d.getFullYear() === 1900;
}

function celda(row: ExcelJS.Row, col: number | undefined): string {
  if (col === undefined) return "";
  const v: unknown = row.getCell(col).value;
  if (v == null) return "";
  if (v instanceof Date) {
    return esSoloHora(v)
      ? v.toLocaleTimeString("es-BO", { hour: "2-digit", minute: "2-digit" })
      : v.toLocaleDateString("es-BO", { timeZone: "America/La_Paz" });
  }
  if (typeof v === "object" && "text" in v) return String((v as { text: unknown }).text ?? "");
  return String(v).trim();
}

/**
 * Busca todas las líneas de una factura en la hoja de despacho.
 * Nunca lanza: devuelve null si no se pudo consultar o no se encontró.
 */
export async function buscarPedidoPorFactura(facturaInput: string): Promise<ResultadoPedido | null> {
  if (!config.despacho.sheetId) return null;
  const facturaBuscada = facturaInput.replace(/\D/g, "");
  if (!facturaBuscada) return null;

  try {
    const url = `https://docs.google.com/spreadsheets/d/${config.despacho.sheetId}/export?format=xlsx`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const buffer = await res.arrayBuffer();

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);

    for (const nombre of PESTAÑAS) {
      const ws = wb.getWorksheet(nombre);
      if (!ws) continue;
      const enc = detectarEncabezado(ws);
      if (!enc) continue;

      const lineas: LineaPedido[] = [];
      let facturaReal = "";
      let cliente = "";
      let fechaProgramacion = "";
      let transportista = "";
      let horaLlegada = "";

      for (let r = enc.fila + 1; r <= ws.rowCount; r++) {
        const row = ws.getRow(r);
        const factCeldaTexto = celda(row, enc.indice["FACTURA"]);
        if (factCeldaTexto.replace(/\D/g, "") !== facturaBuscada) continue;

        facturaReal = factCeldaTexto;
        cliente = celda(row, enc.indice["NOMBRE DEL CLIENTE"]) || cliente;
        fechaProgramacion = celda(row, enc.indice["FECHA DE PROGRAMACIÓN"]) || fechaProgramacion;
        transportista = celda(row, enc.indice["TRANSPORTISTA"]) || transportista;
        horaLlegada = celda(row, enc.indice["HORA DE LLEGADA"]) || horaLlegada;
        lineas.push({
          producto: celda(row, enc.indice["DESC. PROD."]),
          cantidad: celda(row, enc.indice["CANTIDAD"]),
          unidad: celda(row, enc.indice["UNIDAD"]),
          estado: celda(row, enc.indice["ESTADO"]) || "Sin estado registrado",
        });
      }

      if (lineas.length) {
        return { factura: facturaReal, cliente, fechaProgramacion, transportista, horaLlegada, lineas };
      }
    }
    return null; // no se encontró en ninguna pestaña
  } catch (err) {
    console.error("No se pudo consultar el estado del pedido en la hoja de despacho:", err);
    return null;
  }
}

/** Texto formateado para responder al cliente con el estado de su pedido. */
export function formatearEstadoPedido(r: ResultadoPedido): string {
  const estados = new Set(r.lineas.map((l) => l.estado));
  const estadoGeneral = estados.size === 1 ? [...estados][0] : "Parcial (algunos productos en distinto estado)";
  const detalle = r.lineas.map((l) => `• ${l.producto} (${l.cantidad} ${l.unidad}) — *${l.estado}*`).join("\n");
  const extra = [
    r.fechaProgramacion ? `Fecha de programación: ${r.fechaProgramacion}` : "",
    r.transportista ? `Transportista: ${r.transportista}` : "",
    r.horaLlegada ? `Hora de llegada: ${r.horaLlegada}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return (
    `📦 Factura *${r.factura}*${r.cliente ? ` · ${r.cliente}` : ""}\n` +
    `Estado: *${estadoGeneral}*\n` +
    (extra ? `${extra}\n` : "") +
    `\n${detalle}`
  );
}
