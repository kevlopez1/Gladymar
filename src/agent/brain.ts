/**
 * Cerebro del agente: orquesta la conversación con Claude.
 *
 * - Usa la Messages API del SDK oficial de Anthropic (Claude API + tool use).
 * - Prompt del sistema cacheado (prompt caching) para reducir costo/latencia.
 * - Loop de herramientas manual: ejecuta tools y reenvía resultados hasta que
 *   Claude da una respuesta final.
 * - Historial por usuario a través de un SessionStore.
 */
import Anthropic from "@anthropic-ai/sdk";
import { buildSystemPrompt } from "./systemPrompt.js";
import { TOOLS, executeTool } from "./tools.js";
import type { Cotizacion } from "./cotizacion.js";
import type { SessionStore, ChatMessage } from "../session/store.js";

const MAX_TOKENS = 1024; // respuestas de chat: cortas
const MAX_TOOL_ROUNDS = 5; // tope de seguridad para el loop de herramientas

export interface AgentReply {
  text: string;
  escalated: boolean;
  /** Opciones tipo lista para mostrar al cliente (experiencia interactiva de WhatsApp). */
  options: string[];
  /** Texto del botón que abre la lista (ej. "Ver opciones", "Ver catálogo"). */
  optionsButton?: string;
  /** Título de la lista de opciones (encabezado de la hoja). */
  optionsTitle?: string;
  /** El cliente pidió el Manual de Asentamiento (adjuntar PDF si hay enlace configurado). */
  attachManual: boolean;
  /** Documento (PDF) a "enviar" en el chat, ej. el catálogo (muestra en el demo). */
  document?: { name: string; info?: string };
  /** Solicitud registrada en este turno (para el log en Google Sheets), si hubo. */
  solicitud?: { tipo: string; prioridad: string; detalle: string; nombre?: string; ciudad?: string; telefono?: string };
  /** Cotización generada en este turno: la capa de WhatsApp genera el PDF y lo envía. */
  cotizacion?: Cotizacion;
  /** Bloque EXACTO de sucursales (datos oficiales) para enviar verbatim. */
  sucursales?: string;
}

/**
 * Extrae el marcador [[DOCUMENTO: nombre.pdf | info]] del texto del agente.
 */
function extractDocument(text: string): { text: string; document?: { name: string; info?: string } } {
  const m = text.match(/\[\[\s*DOCUMENTO\s*:\s*([^\]]+)\]\]/i);
  if (!m) return { text };
  const parts = m[1].split("|").map((s) => s.trim());
  const cleaned = text.replace(m[0], "").replace(/\n{3,}/g, "\n\n").trim();
  return { text: cleaned, document: { name: parts[0] || "Documento.pdf", info: parts[1] || undefined } };
}

/**
 * Quita los guiones usados como separadores/incisos/viñetas (al cliente no le
 * gustan). No toca guiones internos de palabras ni formatos tipo "60x60".
 */
function quitarGuiones(text: string): string {
  return text
    .replace(/^[ \t]*[-–—]+[ \t]+/gm, "") // viñeta al inicio de línea
    .replace(/[ \t]*[—–][ \t]*/g, ", ") // guión largo/medio como separador -> coma
    .replace(/[ \t]+-[ \t]+/g, ", ") // guión simple con espacios a ambos lados -> coma
    .replace(/\s*,\s*,\s*/g, ", ") // comas duplicadas
    .replace(/\s+,/g, ",")
    .replace(/,\s*([.!?:;)])/g, "$1") // coma pegada a puntuación
    .replace(/\(\s*,\s*/g, "(")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+$/gm, "");
}

/**
 * Blindaje ANTI-ALUCINACIÓN: elimina del texto del modelo cualquier dato de
 * contacto (teléfono, WhatsApp, fijo "(3)…", "+591…", enlaces wa.me, corridas
 * largas de dígitos). El agente NUNCA debe emitir contactos de memoria: los
 * datos oficiales de sucursales se envían aparte, verbatim. Se conserva el sitio
 * web (gladymar.com.bo), que sí es un dato público válido.
 */
function scrubContactos(text: string): string {
  const lineas = text.split("\n").filter((l) => {
    const low = l.toLowerCase();
    if (/\bwa\.me\b|\+\s*591\s*\d|\(\s*\d\s*\)\s*\d/.test(low)) return false; // línea con contacto
    if (/(tel[eé]fono|whats\s*app|whatsapp|celular|cel\.)\s*:?\s*\+?\d/.test(low)) return false;
    if (/\b\d[\d\s.\-]{5,}\d\b/.test(low) && !/gladymar\.com\.bo/.test(low)) return false; // corrida de dígitos
    if (/📍|🏢|☎️|🕐/.test(l)) return false; // línea con pin/dirección/horario
    if (/(^|\s)(av\.|avenida|c\/|calle\s)|\bkm\s?\d|\besq\.|3er anillo|parque industrial|mz\./.test(low)) return false; // dirección
    return true;
  });
  return lineas.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

interface ParsedOptions {
  text: string;
  options: string[];
  optionsButton?: string;
  optionsTitle?: string;
}

/**
 * Extrae el marcador de opciones del texto del agente y devuelve el texto limpio.
 * Formatos soportados:
 *   [[OPCIONES: a | b | c]]
 *   [[OPCIONES boton="Ver catálogo" titulo="Catálogo": a | b | c]]
 */
function extractOptions(text: string): ParsedOptions {
  const m = text.match(/\[\[\s*OPCIONES\b([^:\]]*):\s*([^\]]+)\]\]/i);
  if (!m) return { text: text.trim(), options: [] };
  const header = m[1] ?? "";
  const botonM = header.match(/boton\s*=\s*"([^"]*)"/i);
  const tituloM = header.match(/titulo\s*=\s*"([^"]*)"/i);
  const options = m[2]
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 10);
  const cleaned = text.replace(m[0], "").replace(/\n{3,}/g, "\n\n").trim();
  return {
    text: cleaned,
    options,
    optionsButton: botonM?.[1]?.trim() || undefined,
    optionsTitle: tituloM?.[1]?.trim() || undefined,
  };
}

/**
 * Instrucción extra para conversaciones de CLIENTE real: NO se generan
 * cotizaciones en PDF (esa función queda reservada a admins en modo prueba).
 */
const OVERRIDE_SIN_PDF =
  "# MODO CLIENTE (sin cotización en PDF)\n" +
  "En esta conversación NO generás cotizaciones en PDF: esa función está reservada y la herramienta no está disponible. " +
  "Ignorá cualquier instrucción anterior que diga 'generá el PDF de la cotización'. " +
  "Si el cliente pide precios o una cotización, ayudalo a definir producto y cantidades y derivá a un asesor con `registrar_solicitud` (tipo 'cotizacion'), " +
  "diciéndole con calidez que un asesor de su ciudad le pasará la cotización con los precios y la disponibilidad final. " +
  "NUNCA prometas ni menciones un documento/PDF.";

export class GladymarAgent {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly system: Anthropic.TextBlockParam[];
  private readonly systemSinPDF: Anthropic.TextBlockParam[];

  constructor(opts: { apiKey: string; model: string; store: SessionStore }) {
    this.client = new Anthropic({ apiKey: opts.apiKey });
    this.model = opts.model;
    this.store = opts.store;
    // System prompt estable + cache_control => se cachea el prefijo (tools + system).
    this.system = [
      {
        type: "text",
        text: buildSystemPrompt(),
        cache_control: { type: "ephemeral" },
      },
    ];
    // Variante para cliente real: mismo prefijo cacheado + override sin PDF.
    this.systemSinPDF = [this.system[0], { type: "text", text: OVERRIDE_SIN_PDF }];
  }

  private readonly store: SessionStore;

  /**
   * Procesa un mensaje entrante de un usuario y devuelve la respuesta del agente.
   */
  async handleMessage(
    userId: string,
    userText: string,
    opts?: { cotizacionPDF?: boolean },
  ): Promise<AgentReply> {
    // La cotización en PDF solo está habilitada para admins (modo prueba).
    const permitirPDF = opts?.cotizacionPDF === true;
    const messages: ChatMessage[] = [...this.store.get(userId)];
    messages.push({ role: "user", content: userText });

    let escalated = false;
    let attachManual = false;
    let solicitud: AgentReply["solicitud"];
    let cotizacion: AgentReply["cotizacion"];
    let sucursales: AgentReply["sucursales"];
    let rounds = 0;

    // Teléfono real del cliente = su WhatsApp (userId), solo si son dígitos (no demo).
    const telefonoCliente = /^\d{6,}$/.test(userId) ? userId : undefined;

    let response = await this.create(messages, permitirPDF);

    while (response.stop_reason === "tool_use" && rounds < MAX_TOOL_ROUNDS) {
      rounds++;
      // El turno del asistente (incluye los bloques tool_use) debe conservarse.
      messages.push({ role: "assistant", content: response.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type === "tool_use") {
          const result = executeTool(block.name, block.input as Record<string, unknown>, telefonoCliente);
          if (result.escalated) escalated = true;
          if (result.attachManual) attachManual = true;
          if (result.solicitud) solicitud = result.solicitud;
          if (result.cotizacion) cotizacion = result.cotizacion;
          if (result.sucursales) sucursales = result.sucursales;
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: result.content,
          });
        }
      }

      messages.push({ role: "user", content: toolResults });
      response = await this.create(messages, permitirPDF);
    }

    // Texto final: concatenamos los bloques de texto de la respuesta.
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    // Persistimos el turno final del asistente para mantener el contexto.
    messages.push({ role: "assistant", content: response.content });
    this.store.set(userId, messages);

    const withDoc = extractDocument(
      text || "Disculpe, no pude generar una respuesta. ¿Podría reformular su consulta?",
    );
    const parsed = extractOptions(withDoc.text);

    // Blindaje: nunca dejar marcadores (bien o mal formados) en el texto al cliente.
    let safeText = quitarGuiones(
      parsed.text
        .replace(/\[\[\s*(OPCIONES|DOCUMENTO)[\s\S]*$/i, "") // marcador sin cerrar al final
        .replace(/\[\[[^\]]*\]\]/g, "") // cualquier marcador residual
        .replace(/\n{3,}/g, "\n\n"),
    ).trim();

    // Blindaje ANTI-ALUCINACIÓN de ubicaciones/contactos: SIEMPRE quitamos del
    // texto del modelo cualquier teléfono/WhatsApp/fijo que haya podido inventar.
    // Los datos oficiales de sucursales van aparte en el bloque `sucursales`.
    safeText = scrubContactos(safeText);
    if (sucursales && !safeText) {
      safeText = "¡Claro! 😊 Acá te paso los datos de nuestras sucursales:";
    }

    return {
      text: safeText,
      options: parsed.options,
      optionsButton: parsed.optionsButton,
      optionsTitle: parsed.optionsTitle,
      document: withDoc.document,
      escalated,
      attachManual,
      solicitud,
      cotizacion,
      sucursales,
    };
  }

  /** Reinicia la conversación de un usuario. */
  reset(userId: string): void {
    this.store.reset(userId);
  }

  private create(messages: ChatMessage[], permitirPDF = false): Promise<Anthropic.Message> {
    // Cliente real: quitamos la herramienta de cotización en PDF y usamos el
    // system con override. Admin en modo prueba: herramientas completas.
    const tools = permitirPDF ? TOOLS : TOOLS.filter((t) => t.name !== "generar_cotizacion");
    return this.client.messages.create({
      model: this.model,
      max_tokens: MAX_TOKENS,
      system: permitirPDF ? this.system : this.systemSinPDF,
      tools,
      messages,
    });
  }
}
