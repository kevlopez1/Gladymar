/**
 * Almacén de conversaciones por usuario (multi-turno).
 *
 * La Messages API de Claude no tiene estado: hay que reenviar todo el historial
 * en cada llamada. Aquí guardamos ese historial por número de teléfono.
 *
 * Implementación en memoria (suficiente para empezar / un solo proceso).
 * Para producción multi-instancia, reemplaza por Redis/DB respetando la interfaz
 * `SessionStore`.
 */
import type Anthropic from "@anthropic-ai/sdk";

export type ChatMessage = Anthropic.MessageParam;

export interface SessionStore {
  get(userId: string): ChatMessage[];
  set(userId: string, messages: ChatMessage[]): void;
  reset(userId: string): void;
}

interface SessionEntry {
  messages: ChatMessage[];
  updatedAt: number;
}

export class InMemorySessionStore implements SessionStore {
  private sessions = new Map<string, SessionEntry>();
  private readonly ttlMs: number;
  /** Máximo de mensajes (user+assistant) que conservamos por usuario. */
  private readonly maxMessages: number;

  constructor(ttlMinutes = 120, maxMessages = 40) {
    this.ttlMs = ttlMinutes * 60 * 1000;
    this.maxMessages = maxMessages;
  }

  get(userId: string): ChatMessage[] {
    const entry = this.sessions.get(userId);
    if (!entry) return [];
    if (Date.now() - entry.updatedAt > this.ttlMs) {
      // Sesión expirada: empezar de cero.
      this.sessions.delete(userId);
      return [];
    }
    return entry.messages;
  }

  set(userId: string, messages: ChatMessage[]): void {
    // Recortamos historial viejo para no crecer sin límite ni inflar tokens.
    const trimmed = this.trim(messages);
    this.sessions.set(userId, { messages: trimmed, updatedAt: Date.now() });
  }

  reset(userId: string): void {
    this.sessions.delete(userId);
  }

  /**
   * Conserva los últimos `maxMessages`, asegurando que el historial empiece
   * en un mensaje de rol "user" (requisito de la API).
   */
  private trim(messages: ChatMessage[]): ChatMessage[] {
    let result = messages;
    if (result.length > this.maxMessages) {
      result = result.slice(result.length - this.maxMessages);
    }
    const firstUser = result.findIndex((m) => m.role === "user");
    return firstUser > 0 ? result.slice(firstUser) : result;
  }
}
