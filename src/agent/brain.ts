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
  /** El cliente pidió el Manual de Asentamiento (adjuntar PDF si hay enlace configurado). */
  attachManual: boolean;
  /** Solicitud registrada en este turno (para el log en Google Sheets), si hubo. */
  solicitud?: { tipo: string; detalle: string; nombre?: string; ciudad?: string; telefono?: string };
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

    return {
      text: text || "Disculpe, no pude generar una respuesta. ¿Podría reformular su consulta?",
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
