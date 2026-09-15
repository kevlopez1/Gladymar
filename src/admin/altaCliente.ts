/**
 * Alta de clientes desde el panel: escribiendo los datos o mandando una foto.
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
import { downloadMedia } from "../whatsapp/client.js";
import { recordSolicitud } from "./data.js";
import { CrmIngest } from "../integrations/crm.js";
import { adminNombrePorCiudad, toIntlBolivia, type Admin } from "./roles.js";
import { departamentoDeLugar } from "../knowledge/departamentos.js";

export interface LecturaClientes {
  clientes: ClienteNuevo[];
  error?: string;
  /** Cuántos contactos se leyeron de más y quedaron fuera del lote. */
  recortados?: number;
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
        stage: "Nuevo",
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
