/**
 * Convierte la lista de precios oficial de Gladymar (Excel) en el JSON que el
 * bot consulta para cotizar.
 *
 *   npm run precios
 *
 * Se hace en un script y no al arrancar el bot a propósito: el Excel son 1,4 MB
 * y 5.267 filas, parsearlo en cada despliegue es lento y frágil. Acá se convierte
 * UNA vez, el JSON queda commiteado, y el diff muestra exactamente qué productos
 * entraron y a qué precio. Si mañana Gladymar manda una lista nueva, se
 * reemplaza el .xlsx y se corre el script otra vez.
 *
 * DECISIONES DE FILTRADO (medidas sobre el archivo, no supuestas):
 *
 * 1. La hoja PINT (612 pinturas CORAL) NO se carga. Sus 612 filas están TODAS
 *    en DESCONTINUADO: son rezagados de hace años sin validez comercial
 *    (confirmado por Gladymar el 15/09/2026). Se excluye por familia y no por
 *    estado, para que el día que manden pinturas vigentes alcance con sacar la
 *    exclusión sin tocar la lógica.
 *
 * 2. STATUS tiene DIEZ valores distintos, no dos. Se excluye una lista negra
 *    explícita; todo lo demás se cotiza. Se eligió lista negra y no lista
 *    blanca porque con `STATUS = PORTAFOLIO` el bot podría cotizar solo 445
 *    productos de 4.655, y quedarían afuera los 68 NUEVO, que son justamente
 *    los recién lanzados.
 */
import ExcelJS from "exceljs";
import fs from "node:fs";
import path from "node:path";

/** Regiones tal como vienen en las columnas del Excel. */
const REGIONES = ["SCZ", "TRJ", "CBBA", "SRE", "LPZ"] as const;
type RegionPrecio = (typeof REGIONES)[number];

/** Hojas que NO se cargan, con el motivo (que es lo que importa dentro de un año). */
const HOJAS_EXCLUIDAS: Record<string, string> = {
  PINT: "612 pinturas CORAL, todas DESCONTINUADO: rezagados sin validez comercial.",
};

/**
 * Estados que NO se cotizan. Cotizar cualquiera de estos es prometer algo que
 * no se entrega, o venderlo a un precio que no corresponde.
 */
const ESTADOS_EXCLUIDOS = new Set([
  "DESCONTINUADO",
  "NEW DESC.", // descontinuado reciente
  "CASCOTE", // material de descarte
  "MUESTRA", // pieza de exhibición, no es stock
  "#N/A", // error de fórmula en el origen
]);

interface Producto {
  /** Hoja de origen: junto con `cod` forma la clave única (hay 7 COD repetidos). */
  familia: string;
  cod: string;
  marca: string;
  descripcion: string;
  formato?: string;
  acabado?: string;
  status: string;
  /** Precio por región, en Bs. */
  precios: Record<RegionPrecio, number>;
}

function texto(v: ExcelJS.CellValue): string {
  if (v == null) return "";
  if (typeof v === "object" && "richText" in v) {
    return (v.richText as { text: string }[]).map((t) => t.text).join("");
  }
  if (typeof v === "object" && "result" in v) return String(v.result ?? "");
  return String(v).trim();
}

function numero(v: ExcelJS.CellValue): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "object" && v && "result" in v && typeof v.result === "number") return v.result;
  const n = Number(texto(v).replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function main(): Promise<void> {
  const xlsx = path.join(process.cwd(), "docs/clientes/gladymar/lista-precios-2026-09.xlsx");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsx);

  const productos: Producto[] = [];
  const descartes: Record<string, number> = {};
  let leidas = 0;

  for (const ws of wb.worksheets) {
    const familia = ws.name.trim().toUpperCase();
    if (HOJAS_EXCLUIDAS[familia]) {
      console.log(`  ${familia.padEnd(6)} EXCLUIDA — ${HOJAS_EXCLUIDAS[familia]}`);
      continue;
    }

    // El encabezado NO está en la fila 1: arriba hay totales sueltos, y la fila
    // de títulos varía por hoja (NAC en la 3, el resto en la 2). Además CEM no
    // tiene columna STOCK, así que leer por posición fija corre las columnas de
    // precio y se cotiza con el número de otra región. Se busca la fila que
    // empieza con MARCA y se mapea por NOMBRE de columna.
    let encIdx = 0;
    let col: Record<string, number> = {};
    for (let r = 1; r <= Math.min(8, ws.rowCount); r++) {
      const fila = ws.getRow(r);
      if (texto(fila.getCell(1).value).toUpperCase() === "MARCA") {
        encIdx = r;
        fila.eachCell((cell, i) => {
          const h = texto(cell.value).toUpperCase().replace(/\s+/g, " ").trim();
          if (h) col[h] = i;
        });
        break;
      }
    }
    if (!encIdx) {
      console.warn(`  ${familia.padEnd(6)} ⚠ sin fila de encabezado (ninguna empieza con MARCA), se omite`);
      continue;
    }
    const faltan = REGIONES.filter((r) => !(r in col));
    if (faltan.length) {
      console.warn(`  ${familia.padEnd(6)} ⚠ faltan columnas de precio ${faltan.join(", ")}, se omite la hoja`);
      continue;
    }

    let cargadas = 0;
    for (let r = encIdx + 1; r <= ws.rowCount; r++) {
      const fila = ws.getRow(r);
      const marca = texto(fila.getCell(col.MARCA).value);
      if (!marca) continue;
      leidas++;

      const status = texto(fila.getCell(col.STATUS).value).toUpperCase();
      if (ESTADOS_EXCLUIDOS.has(status)) {
        descartes[status] = (descartes[status] ?? 0) + 1;
        continue;
      }

      const precios = {} as Record<RegionPrecio, number>;
      let completo = true;
      for (const reg of REGIONES) {
        const p = numero(fila.getCell(col[reg]).value);
        if (p == null) { completo = false; break; }
        precios[reg] = p;
      }
      if (!completo) {
        descartes["SIN PRECIO"] = (descartes["SIN PRECIO"] ?? 0) + 1;
        continue;
      }

      const descCol = col["DESCRIPCIÓN"] ?? col.DESCRIPCION;
      productos.push({
        familia,
        cod: texto(fila.getCell(col.COD).value),
        marca,
        descripcion: texto(fila.getCell(descCol).value).replace(/\s+/g, " ").trim(),
        formato: col.FORMATO ? texto(fila.getCell(col.FORMATO).value) || undefined : undefined,
        acabado: col.ACABADO ? texto(fila.getCell(col.ACABADO).value) || undefined : undefined,
        status,
        precios,
      });
      cargadas++;
    }
    console.log(`  ${familia.padEnd(6)} encabezado f${encIdx}  ->  ${cargadas} producto(s) cotizables`);
  }

  const salida = path.join(process.cwd(), "src/knowledge/listaPrecios.json");
  fs.writeFileSync(
    salida,
    JSON.stringify(
      { generado: new Date().toISOString(), origen: "lista-precios-2026-09.xlsx", regiones: REGIONES, productos },
      null,
      0,
    ),
  );

  console.log(`\nFilas leídas          : ${leidas}`);
  console.log("Descartadas:");
  for (const [k, v] of Object.entries(descartes).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(14)} ${v}`);
  }
  console.log(`\n✅ ${productos.length} productos cotizables -> ${path.relative(process.cwd(), salida)}`);
}

main().catch((err) => {
  console.error("No se pudo importar la lista de precios:", err);
  process.exit(1);
});
