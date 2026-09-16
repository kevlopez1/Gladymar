/**
 * Alta de clientes desde el panel: escribiendo, por foto o por planilla.
 *
 * El asesor está en el mostrador o en obra y anota el contacto en un papel, en
 * una tarjeta o en la libreta. Hasta ahora eso terminaba en un cuaderno y el
 * CRM nunca se enteraba; acá entra por WhatsApp y queda como lead con asesor y
 * departamento asignados, igual que si el cliente hubiera escrito él mismo.
 *
 * POR QUÉ SE CONFIRMA ANTES DE GUARDAR: la foto puede ser una letra manuscrita
 * y un dígito mal leído no es un dato feo, es el WhatsApp de un desconocido que
 * va a recibir el seguimiento de otra persona. El asesor ve lo que se entendió
 * y recién ahí se guarda.
 */
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import ExcelJS from "exceljs";
import { downloadMedia, downloadPlanilla } from "../whatsapp/client.js";
import { parseCSV } from "../util/csv.js";
import { recordSolicitud } from "./data.js";
import { CrmIngest } from "../integrations/crm.js";
import { adminNombrePorCiudad, toIntlBolivia, type Admin } from "./roles.js";
import { departamentoDeLugar } from "../knowledge/departamentos.js";

export interface LecturaClientes {
  clientes: ClienteNuevo[];
  error?: string;
  /** Cuántos contactos se leyeron de más y quedaron fuera del lote. */
  recortados?: number;
  /** Cuántas filas de la planilla se descartaron por no tener nombre. */
  filasVacias?: number;
}

export interface ClienteNuevo {
  nombre: string;
  telefono?: string;
  ciudad?: string;
  interes?: string;
  /** Qué no se pudo usar del dato original (ej. un teléfono que no cierra). */
  aviso?: string;
}

const crm = new CrmIngest(config.crm.ingestUrl, config.crm.ingestToken);
const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

/**
 * Tope de contactos por tanda.
 *
 * Una hoja de cuaderno entera entra sin problema, pero hay un tope igual: la
 * confirmación se lee en la pantalla del teléfono, y una lista de cincuenta
 * nadie la revisa de verdad — la aprueba de un toque, que es justo lo que la
 * confirmación viene a evitar. Lo que sobra se AVISA, nunca se descarta callado.
 */
const MAX_POR_LOTE = 25;

const INSTRUCCION = `Extraé los datos de contacto de clientes que aparezcan en lo que te mandan.

Devolvé SOLO un array JSON, sin texto alrededor, sin markdown, con esta forma:
[{"nombre":"...","telefono":"...","ciudad":"...","interes":"..."}]

Reglas:
- "nombre" es lo único obligatorio. Si un contacto no tiene nombre legible, poné "Cliente".
- "telefono": solo los dígitos, sin +591 ni espacios. Si no hay, omitilo.
- "ciudad": la ciudad o municipio de Bolivia que figure. Si no hay, omitilo.
- "interes": qué producto o metraje le interesa, en pocas palabras. Si no hay, omitilo.
- Puede haber UN contacto o VARIOS: devolvé uno por cada persona que distingas, sin fusionar dos en uno ni partir uno en dos.
- NO inventes ningún dato. Un campo que no está, no va.
- Si no se distingue ningún contacto, devolvé [].`;

function extraerJson(texto: string): unknown {
  const limpio = texto.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const desde = limpio.indexOf("[");
  const hasta = limpio.lastIndexOf("]");
  if (desde === -1 || hasta === -1) return null;
  try {
    return JSON.parse(limpio.slice(desde, hasta + 1));
  } catch {
    return null;
  }
}

/**
 * Normaliza un celular boliviano (8 dígitos, empieza con 6 o 7).
 *
 * Un número que no cierra se DESCARTA y se avisa, no se guarda "por las
 * dudas": un teléfono inventado en la ficha es peor que una ficha sin
 * teléfono, porque alguien lo va a marcar.
 */
function normalizarTelefono(t?: string): { tel?: string; aviso?: string } {
  const d = (t || "").replace(/\D/g, "");
  const local = d.startsWith("591") ? d.slice(3) : d;
  if (!local) return {};
  if (local.length !== 8 || !/^[67]/.test(local)) {
    return { aviso: `no pude usar el teléfono "${t}" (un celular boliviano son 8 dígitos y empieza con 6 o 7)` };
  }
  return { tel: local };
}

function limpiar(crudos: unknown): { clientes: ClienteNuevo[]; recortados: number } {
  if (!Array.isArray(crudos)) return { clientes: [], recortados: 0 };
  const recortados = Math.max(0, crudos.length - MAX_POR_LOTE);
  const out: ClienteNuevo[] = [];
  for (const c of crudos.slice(0, MAX_POR_LOTE)) {
    if (!c || typeof c !== "object") continue;
    const r = c as Record<string, unknown>;
    const nombre = String(r.nombre ?? "").trim() || "Cliente";
    const { tel, aviso } = normalizarTelefono(r.telefono ? String(r.telefono) : undefined);
    out.push({
      nombre: nombre.slice(0, 80),
      telefono: tel,
      ciudad: r.ciudad ? String(r.ciudad).trim().slice(0, 60) : undefined,
      interes: r.interes ? String(r.interes).trim().slice(0, 200) : undefined,
      aviso,
    });
  }
  return { clientes: out, recortados };
}

async function pedirleAClaude(contenido: Anthropic.MessageParam["content"]): Promise<LecturaClientes> {
  try {
    const res = await anthropic.messages.create({
      model: config.anthropic.model,
      max_tokens: 1500,
      system: INSTRUCCION,
      messages: [{ role: "user", content: contenido }],
    });
    const texto = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    return limpiar(extraerJson(texto));
  } catch (err) {
    console.error("No se pudieron leer los datos del cliente nuevo:", err);
    return { clientes: [], error: "No pude leer los datos en este momento. Probá de nuevo en un minuto." };
  }
}

/** Lee uno o varios clientes de un mensaje escrito por el asesor. */
export async function leerClientesDeTexto(texto: string): Promise<LecturaClientes> {
  if (!texto.trim()) return { clientes: [] };
  return pedirleAClaude(texto.trim().slice(0, 4000));
}

/** Lee uno o varios clientes de una foto (tarjeta, lista escrita a mano, captura). */
export async function leerClientesDeFoto(mediaId: string): Promise<LecturaClientes> {
  const media = await downloadMedia(mediaId);
  if (!media) {
    return { clientes: [], error: "No pude descargar la foto. ¿La mandás de nuevo?" };
  }
  return pedirleAClaude([
    {
      type: "image",
      source: {
        type: "base64",
        media_type: media.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
        data: media.base64,
      },
    },
    { type: "text", text: "Extraé los contactos que aparezcan en esta foto." },
  ]);
}

/** Texto de confirmación con lo que se entendió, antes de guardar nada. */
export function resumenParaConfirmar(clientes: ClienteNuevo[], recortados = 0): string {
  const lineas = clientes.map((c, i) => {
    const partes = [`*${i + 1}. ${c.nombre}*`];
    partes.push(`   📱 ${c.telefono ?? "_sin teléfono_"}`);
    if (c.ciudad) partes.push(`   📍 ${c.ciudad}`);
    if (c.interes) partes.push(`   🧱 ${c.interes}`);
    const asesor = adminNombrePorCiudad(c.ciudad);
    partes.push(`   ➡️ ${asesor ? `Queda con *${asesor}*` : "_Sin asesor: esa zona no tiene uno asignado_"}`);
    if (c.aviso) partes.push(`   ⚠️ ${c.aviso}`);
    return partes.join("\n");
  });
  const titulo = clientes.length === 1 ? "Esto entendí:" : `Entendí *${clientes.length}* contactos:`;
  const sobrante = recortados
    ? `\n\n⚠️ Había *${recortados}* contacto(s) más de los que puedo cargar de una vez (${MAX_POR_LOTE}). ` +
      "Guardá estos y mandame el resto en otra tanda."
    : "";
  const pregunta = clientes.length === 1 ? "¿Lo guardo?" : "¿Los guardo?";
  return `${titulo}\n\n${lineas.join("\n\n")}${sobrante}\n\n${pregunta}`;
}

/**
 * Guarda los clientes como leads y los manda al CRM.
 *
 * Nunca lanza: si el CRM está caído el lead igual queda registrado de este
 * lado, que es lo que hace que el asesor no pierda el contacto.
 */
export async function guardarClientes(clientes: ClienteNuevo[], quien: Admin): Promise<string> {
  let guardados = 0;
  for (const c of clientes) {
    const detalle = [c.interes, c.telefono ? `Tel. ${c.telefono}` : null]
      .filter(Boolean)
      .join(" · ") || "Alta manual desde el panel";
    try {
      recordSolicitud({
        tipo: "contactar_asesor",
        prioridad: "normal",
        nombre: c.nombre,
        ciudad: c.ciudad,
        telefono: c.telefono,
        detalle: `${detalle} (cargado por ${quien.nombre})`,
      });
      guardados++;
    } catch (err) {
      console.error(`No se pudo registrar el cliente "${c.nombre}" cargado por ${quien.nombre}:`, err);
      continue;
    }
    // Al CRM solo van los que tienen teléfono: el external_id del CRM ES el
    // WhatsApp del cliente, así que sin número no hay ficha que crear.
    if (c.telefono) {
      void crm.send({
        external_id: toIntlBolivia(c.telefono),
        name: c.nombre,
        city: c.ciudad,
        // Minúscula, igual que las que devuelve stageDeTipo(): el CRM compara
        // el valor literal, así que "Nuevo" y "nuevo" son dos columnas distintas.
        stage: "nuevo",
        tipo_solicitud: "contactar_asesor",
        interest: c.interes,
        asesor: adminNombrePorCiudad(c.ciudad),
        departamento: departamentoDeLugar(c.ciudad),
        message: `Cliente cargado desde el panel por ${quien.nombre}.`,
      });
    }
  }

  if (!guardados) return "⚠️ No pude guardar ninguno. Ya quedó registrado en los logs; probá de nuevo.";
  const sinTelefono = clientes.filter((c) => !c.telefono).length;
  let out =
    guardados === 1
      ? `✅ *${clientes[0].nombre}* quedó registrado.`
      : `✅ Quedaron registrados *${guardados}* clientes.`;
  if (sinTelefono) {
    out +=
      `\n\n⚠️ ${sinTelefono === 1 ? "Uno quedó" : `${sinTelefono} quedaron`} sin teléfono, así que ` +
      `${sinTelefono === 1 ? "no entra" : "no entran"} al CRM ni ${sinTelefono === 1 ? "recibe" : "reciben"} seguimiento automático. ` +
      `${sinTelefono === 1 ? "Agregalo" : "Agregalos"} de nuevo con el número cuando lo tengas.`;
  }
  return out;
}

// ── Planillas (Excel o CSV) ──────────────────────────────────────────────────
//
// Una lista larga NO pasa por Claude. Una planilla ya viene en columnas: leerla
// celda por celda es exacto, gratis y no se cansa a la fila doscientos. Claude
// queda para lo que de verdad no tiene estructura — un papel escrito a mano.

/** Tope de filas por planilla. Más alto que a mano: acá el trabajo lo hace el archivo. */
const MAX_POR_PLANILLA = 300;

/** Cómo se llama cada dato en la planilla. Se busca por nombre, nunca por posición. */
const COLUMNAS: Record<"nombre" | "telefono" | "ciudad" | "interes", RegExp> = {
  nombre: /NOMBRE|CLIENTE|RAZ[OÓ]N/,
  telefono: /TEL[EÉ]FONO|TELEFONO|CELULAR|WHATSAPP|M[OÓ]VIL|MOVIL|N[UÚ]MERO|NRO/,
  ciudad: /CIUDAD|LOCALIDAD|MUNICIPIO|DEPARTAMENTO|ZONA/,
  interes: /INTER[EÉ]S|INTERES|PRODUCTO|DETALLE|OBSERVAC|REQUERIM|NOTA/,
};

function normEnc(s: string): string {
  return (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().trim();
}

/**
 * Convierte las filas de una planilla en clientes.
 *
 * Busca el encabezado en las primeras filas en vez de asumir que es la primera:
 * casi toda planilla real arranca con un título o una fila en blanco, y leer el
 * título como encabezado deja todas las columnas sin identificar.
 */
/**
 * Cuántas de las columnas conocidas reconoce esta fila como encabezado.
 *
 * Se puntúa en vez de tomar la primera coincidencia porque casi toda planilla
 * real arranca con un título, y un título como "LISTA DE CLIENTES - EXPOCRUZ"
 * contiene la palabra CLIENTES: tomarlo como encabezado hacía que la columna
 * de nombre fuera la del número de fila, y se cargaban siete clientes llamados
 * "1", "2", "3". Un encabezado de verdad reconoce VARIAS columnas y sus celdas
 * son etiquetas cortas, no frases.
 */
function puntajeEncabezado(fila: string[]): number {
  const celdas = fila.map(normEnc).filter((c) => c !== "" && c.length <= 40);
  if (celdas.length < 2) return 0; // una sola celda es un título, no un encabezado
  let puntos = 0;
  for (const re of Object.values(COLUMNAS)) {
    if (celdas.some((c) => re.test(c))) puntos++;
  }
  return puntos;
}

function clientesDeFilas(filas: string[][]): LecturaClientes {
  // Se busca en las primeras filas nomás: un encabezado que aparezca en la 40
  // no es un encabezado, es un dato.
  let encIdx = -1;
  let mejor = 0;
  for (let r = 0; r < Math.min(filas.length, 20); r++) {
    const p = puntajeEncabezado(filas[r]);
    if (p > mejor) {
      mejor = p;
      encIdx = r;
    }
  }
  // Sin una columna de nombre no hay nada que cargar, por mucho que matcheen
  // las otras: el nombre es el único dato obligatorio de un cliente.
  if (encIdx >= 0 && !filas[encIdx].map(normEnc).some((c) => c.length <= 40 && COLUMNAS.nombre.test(c))) {
    encIdx = -1;
  }
  if (encIdx === -1) {
    return {
      clientes: [],
      error:
        "No encontré una columna de nombre en la planilla. " +
        "Necesito al menos una columna que diga *NOMBRE* o *CLIENTE*, y de preferencia otra con el teléfono.",
    };
  }
  const enc = filas[encIdx].map(normEnc);
  const col = (re: RegExp) => enc.findIndex((c) => c.length <= 40 && re.test(c));
  const iNombre = col(COLUMNAS.nombre);
  const iTel = col(COLUMNAS.telefono);
  const iCiudad = col(COLUMNAS.ciudad);
  const iInteres = col(COLUMNAS.interes);

  const out: ClienteNuevo[] = [];
  let filasVacias = 0;
  let leidas = 0;
  for (let r = encIdx + 1; r < filas.length; r++) {
    const f = filas[r];
    if (!f.some((c) => (c || "").trim() !== "")) continue; // fila en blanco, no cuenta
    leidas++;
    const nombre = (f[iNombre] ?? "").trim();
    if (!nombre) {
      filasVacias++;
      continue;
    }
    if (out.length >= MAX_POR_PLANILLA) continue;
    const { tel, aviso } = normalizarTelefono(iTel >= 0 ? (f[iTel] ?? "").trim() : undefined);
    out.push({
      nombre: nombre.slice(0, 80),
      telefono: tel,
      ciudad: iCiudad >= 0 ? (f[iCiudad] ?? "").trim().slice(0, 60) || undefined : undefined,
      interes: iInteres >= 0 ? (f[iInteres] ?? "").trim().slice(0, 200) || undefined : undefined,
      aviso,
    });
  }
  return {
    clientes: out,
    recortados: Math.max(0, leidas - filasVacias - out.length),
    filasVacias,
  };
}

/** Lee una planilla de Excel (.xlsx / .xls) desde su contenido. */
async function filasDeExcel(buf: Buffer): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const hoja = wb.worksheets[0];
  if (!hoja) return [];
  const filas: string[][] = [];
  hoja.eachRow({ includeEmpty: false }, (row) => {
    const celdas: string[] = [];
    // row.values viene con un hueco en el índice 0: ExcelJS numera desde 1.
    const vals = row.values as unknown[];
    for (let c = 1; c < vals.length; c++) {
      const v = vals[c];
      celdas.push(v == null ? "" : typeof v === "object" ? String((v as { text?: string }).text ?? v) : String(v));
    }
    filas.push(celdas);
  });
  return filas;
}

/**
 * Lee la lista de clientes de una planilla que mandó un asesor.
 *
 * Nunca lanza: un archivo raro devuelve un error legible, no una excepción que
 * deje al asesor mirando el panel sin respuesta.
 */
export async function leerClientesDePlanilla(mediaId: string, nombreArchivo?: string): Promise<LecturaClientes> {
  const media = await downloadPlanilla(mediaId);
  if (!media) {
    return {
      clientes: [],
      error: "No pude abrir ese archivo. Mandámelo como *Excel (.xlsx)* o *CSV*, y que pese menos de 5 MB.",
    };
  }
  return leerPlanilla(Buffer.from(media.base64, "base64"), nombreArchivo, media.mimeType);
}

/**
 * Parsea una planilla ya descargada. Separada de la descarga a propósito: es la
 * parte con reglas (dónde está el encabezado, qué columna es cuál) y así se
 * puede probar con un archivo de verdad sin tocar WhatsApp.
 */
export async function leerPlanilla(
  buf: Buffer,
  nombreArchivo?: string,
  mimeType = "",
): Promise<LecturaClientes> {
  try {
    const esCsv =
      /\.csv$/i.test(nombreArchivo || "") || mimeType.includes("csv") || mimeType === "text/plain";
    const filas = esCsv ? parseCSV(buf.toString("utf8")) : await filasDeExcel(buf);
    if (!filas.length) return { clientes: [], error: "La planilla llegó vacía: no tiene ninguna fila." };
    return clientesDeFilas(filas);
  } catch (err) {
    console.error("No se pudo leer la planilla de clientes:", err);
    return {
      clientes: [],
      error: "No pude leer esa planilla. Si es un .xls viejo, guardalo como *.xlsx* o como *CSV* y mandámelo de nuevo.",
    };
  }
}

/**
 * Resumen de una planilla larga, para confirmar sin hacer scroll infinito.
 *
 * Una lista de doscientos no se revisa fila por fila en un teléfono: se aprueba
 * de un toque, que es lo que la confirmación viene a evitar. Así que se
 * muestran los totales, lo que falta, y una muestra de las primeras.
 */
export function resumenPlanilla(lectura: LecturaClientes): string {
  const cs = lectura.clientes;
  const conTel = cs.filter((c) => c.telefono).length;
  const sinTel = cs.length - conTel;
  const conAviso = cs.filter((c) => c.aviso).length;

  const lineas = [`📄 Leí *${cs.length}* cliente(s) de la planilla.`, ""];
  lineas.push(`   📱 Con teléfono: *${conTel}*`);
  if (sinTel) lineas.push(`   ⚠️ Sin teléfono: *${sinTel}* (quedan registrados, pero sin seguimiento automático)`);
  if (conAviso) lineas.push(`   ⚠️ Con un teléfono que no pude usar: *${conAviso}*`);
  if (lectura.filasVacias) lineas.push(`   ↩️ Filas sin nombre que salté: *${lectura.filasVacias}*`);
  if (lectura.recortados) {
    lineas.push(`   ✂️ No entraron: *${lectura.recortados}* (el máximo por planilla es ${MAX_POR_PLANILLA})`);
  }

  lineas.push("", "*Las primeras, para que revises que se entendió bien:*");
  for (const c of cs.slice(0, 5)) {
    const partes = [`• *${c.nombre}*`, c.telefono ?? "sin teléfono", c.ciudad ?? "sin ciudad"];
    lineas.push(partes.join(" · "));
  }
  if (cs.length > 5) lineas.push(`_...y ${cs.length - 5} más._`);
  lineas.push("", "¿Los guardo?");
  return lineas.join("\n");
}
