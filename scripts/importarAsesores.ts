/**
 * Convierte el padrón de asesores de Gladymar (Excel) en el JSON que usa el bot
 * para derivar leads.
 *
 *   npm run asesores
 *
 * OJO con el archivo de origen: NO tiene fila de encabezado, arranca directo en
 * datos. Las columnas son, en orden:
 *   id | nombre | usuario | email | region | sucursal | tipo | telefono | rol
 *
 * REGIONES: el archivo usa códigos propios (SCZ, CBB, TAR, SRE, LP, TJA) que NO
 * coinciden con los de la lista de precios (SCZ, CBBA, TRJ, SRE, LPZ). Ninguno
 * de los dos se guarda como clave: los dos se traducen al DEPARTAMENTO canónico
 * de departamentos.ts, que es la única fuente común. Si se cruzaran entre sí,
 * La Paz, Cochabamba y Tarija cotizarían bien y no derivarían a nadie, sin
 * ningún error visible.
 *
 * TAR y TJA son la MISMA sucursal (Tarija): el archivo la carga con dos códigos
 * distintos para la misma gente.
 */
import ExcelJS from "exceljs";
import fs from "node:fs";
import path from "node:path";

/** Código de región del archivo de asesores -> departamento canónico. */
const DEPARTAMENTO_POR_CODIGO: Record<string, string> = {
  SCZ: "Santa Cruz",
  LP: "La Paz",
  CBB: "Cochabamba",
  SRE: "Chuquisaca",
  TAR: "Tarija",
  TJA: "Tarija", // mismo showroom que TAR
};

/**
 * Sucursal del padrón -> nombre con el que figura en knowledge/sucursales.ts.
 * Casi todas se confirmaron cruzando el celular del supervisor contra el
 * WhatsApp que ya teníamos cargado para esa sucursal.
 */
const SUCURSAL_CANONICA: Record<string, string> = {
  Plus: "Gladymar Plus",
  Serrana: "Fábrica (Parque Industrial)", // confirmado por Gerencia 15/09/2026
  CCO: "Canal Cotoca",
  Montero: "Montero",
  "Ballivián": "Calacoto (Ballivián)",
  Montes: "Montes",
  BG2: "Blanco Galindo",
  JDR: "Juan de la Rosa",
  Sucre: "Sucre",
  Tarija: "Tarija",
};

interface Asesor {
  nombre: string;
  telefono: string;
  email: string;
  sucursal: string;
  sucursalCanonica: string;
  departamento: string;
  rol: string;
  esSupervisor: boolean;
}

function texto(v: ExcelJS.CellValue): string {
  if (v == null) return "";
  if (typeof v === "object" && "text" in v) return String((v as { text: string }).text).trim();
  if (typeof v === "object" && "result" in v) return String((v as { result: unknown }).result ?? "").trim();
  return String(v).trim();
}

async function main(): Promise<void> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.join(process.cwd(), "docs/clientes/gladymar/asesores-crm.xlsx"));
  const ws = wb.worksheets[0];

  const asesores: Asesor[] = [];
  const problemas: string[] = [];

  ws.eachRow((fila) => {
    const nombre = texto(fila.getCell(2).value);
    if (!nombre) return;
    const codigo = texto(fila.getCell(5).value).toUpperCase();
    const sucursal = texto(fila.getCell(6).value);
    const departamento = DEPARTAMENTO_POR_CODIGO[codigo];
    const sucursalCanonica = SUCURSAL_CANONICA[sucursal];

    if (!departamento) problemas.push(`${nombre}: código de región desconocido "${codigo}"`);
    if (!sucursalCanonica) problemas.push(`${nombre}: sucursal desconocida "${sucursal}"`);
    if (!departamento || !sucursalCanonica) return;

    const rol = texto(fila.getCell(9).value);
    asesores.push({
      nombre: nombre.replace(/\s+/g, " ").trim(),
      telefono: texto(fila.getCell(8).value).replace(/\D/g, ""),
      email: texto(fila.getCell(4).value),
      sucursal,
      sucursalCanonica,
      departamento,
      rol,
      esSupervisor: /supervisor/i.test(rol),
    });
  });

  // Un lead se manda a UNA persona: la del showroom. Sin supervisor no hay a
  // quién mandarlo y el lead se perdería en silencio, así que se avisa.
  const sinSupervisor = [...new Set(asesores.map((a) => a.sucursal))].filter(
    (s) => !asesores.some((a) => a.sucursal === s && a.esSupervisor),
  );
  for (const s of sinSupervisor) problemas.push(`sucursal "${s}" no tiene supervisor en el padrón`);

  const salida = path.join(process.cwd(), "src/admin/asesores.json");
  fs.writeFileSync(
    salida,
    JSON.stringify({ generado: new Date().toISOString(), origen: "asesores-crm.xlsx", asesores }, null, 0),
  );

  const porDepto: Record<string, number> = {};
  for (const a of asesores) porDepto[a.departamento] = (porDepto[a.departamento] ?? 0) + 1;
  console.log(`${asesores.length} asesores en ${new Set(asesores.map((a) => a.sucursal)).size} sucursales`);
  for (const [d, n] of Object.entries(porDepto).sort()) console.log(`  ${d.padEnd(12)} ${n}`);
  if (problemas.length) {
    console.log("\n⚠ Revisar:");
    for (const p of problemas) console.log(`  - ${p}`);
  }
  console.log(`\n✅ ${path.relative(process.cwd(), salida)}`);
}

main().catch((err) => {
  console.error("No se pudo importar el padrón de asesores:", err);
  process.exit(1);
});
