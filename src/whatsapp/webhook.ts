/**
 * Utilidades para el webhook de WhatsApp Cloud API:
 * - verificación del endpoint (handshake con Meta)
 * - extracción de los mensajes de texto entrantes del payload
 */
import { config } from "../config.js";

/**
 * Verificación del webhook (GET). Meta envía hub.mode, hub.verify_token y
 * hub.challenge. Devolvemos el challenge si el token coincide.
 */
export function verifyWebhook(query: Record<string, unknown>): string | null {
  const mode = query["hub.mode"];
  const token = query["hub.verify_token"];
  const challenge = query["hub.challenge"];

  if (mode === "subscribe" && token === config.whatsapp.verifyToken) {
    return typeof challenge === "string" ? challenge : null;
  }
  return null;
}

export interface IncomingMessage {
  from: string; // número del remitente (sin "+")
  text: string; // contenido del mensaje
  messageId: string; // id del mensaje (para marcar como leído)
  name?: string; // nombre de perfil, si está disponible
}

/**
 * Extrae los mensajes de texto entrantes de un payload del webhook.
 * Ignora estados de entrega, reacciones y tipos no soportados.
 */
export function parseIncomingMessages(body: unknown): IncomingMessage[] {
  const result: IncomingMessage[] = [];
  const payload = body as WebhookPayload;

  for (const entry of payload?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value?.messages) continue;

      const contactName = value.contacts?.[0]?.profile?.name;

      for (const msg of value.messages) {
        if (msg.type === "text" && msg.text?.body) {
          result.push({
            from: msg.from,
            text: msg.text.body,
            messageId: msg.id,
            name: contactName,
          });
        }
        // Otros tipos (imagen, audio, ubicación, botones) podrían manejarse aquí.
      }
    }
  }

  return result;
}

// ── Tipos del payload del webhook (parcial, solo lo que usamos) ──
interface WebhookPayload {
  object?: string;
  entry?: Array<{
    changes?: Array<{
      value?: {
        contacts?: Array<{ profile?: { name?: string } }>;
        messages?: Array<{
          from: string;
          id: string;
          type: string;
          text?: { body?: string };
        }>;
      };
    }>;
  }>;
}
