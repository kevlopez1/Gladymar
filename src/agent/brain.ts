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

export class GladymarAgent {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly system: Anthropic.TextBlockParam[];

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
  }

  private readonly store: SessionStore;

  /**
   * Procesa un mensaje entrante de un usuario y devuelve la respuesta del agente.
   */
  async handleMessage(userId: string, userText: string): Promise<AgentReply> {
    const messages: ChatMessage[] = [...this.store.get(userId)];
    messages.push({ role: "user", content: userText });

    let escalated = false;
    let attachManual = false;
    let solicitud: AgentReply["solicitud"];
    let rounds = 0;

    let response = await this.create(messages);

    while (response.stop_reason === "tool_use" && rounds < MAX_TOOL_ROUNDS) {
      rounds++;
      // El turno del asistente (incluye los bloques tool_use) debe conservarse.
      messages.push({ role: "assistant", content: response.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type === "tool_use") {
          const result = executeTool(block.name, block.input as Record<string, unknown>);
          if (result.escalated) escalated = true;
          if (result.attachManual) attachManual = true;
          if (result.solicitud) solicitud = result.solicitud;
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: result.content,
          });
        }
      }

      messages.push({ role: "user", content: toolResults });
      response = await this.create(messages);
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

    return {
      text: parsed.text,
      options: parsed.options,
      optionsButton: parsed.optionsButton,
      optionsTitle: parsed.optionsTitle,
      document: withDoc.document,
      escalated,
      attachManual,
      solicitud,
    };
  }

  /** Reinicia la conversación de un usuario. */
  reset(userId: string): void {
    this.store.reset(userId);
  }

  private create(messages: ChatMessage[]): Promise<Anthropic.Message> {
    return this.client.messages.create({
      model: this.model,
      max_tokens: MAX_TOKENS,
      system: this.system,
      tools: TOOLS,
      messages,
    });
  }
}
