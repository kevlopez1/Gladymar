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
  text: string; // contenido del mensaje (vacío si mandó solo una foto)
  messageId: string; // id del mensaje (para marcar como leído)
  name?: string; // nombre de perfil, si está disponible
  /** Id del media si el cliente mandó una FOTO (captura del catálogo, un ambiente, etc.). */
  imageId?: string;
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

      // CRÍTICO (anti-contaminación): un webhook puede traer mensajes de VARIOS
      // contactos. El nombre de perfil se debe emparejar por `wa_id` con CADA
      // remitente, nunca tomar `contacts[0]` para todos (mezclaría datos entre
      // conversaciones distintas). Construimos un mapa wa_id -> nombre.
      const nombrePorWaId = new Map<string, string>();
      for (const c of value.contacts ?? []) {
        if (c.wa_id && c.profile?.name) nombrePorWaId.set(c.wa_id, c.profile.name);
      }

      for (const msg of value.messages) {
        const name = nombrePorWaId.get(msg.from); // el nombre de ESTE remitente, no de otro
        if (msg.type === "text" && msg.text?.body) {
          result.push({
            from: msg.from,
            text: msg.text.body,
            messageId: msg.id,
            name,
          });
        } else if (msg.type === "interactive" && msg.interactive) {
          // El cliente tocó una opción de lista o un botón: usamos su id como texto.
          const reply = msg.interactive.list_reply ?? msg.interactive.button_reply;
          const text = reply?.id || reply?.title;
          if (text) {
            result.push({ from: msg.from, text, messageId: msg.id, name });
          }
        } else if (msg.type === "image" && msg.image?.id) {
          // FOTO: captura del catálogo, un ambiente, un producto en obra. Antes se
          // descartaba en silencio y el cliente se quedaba sin respuesta.
          result.push({
            from: msg.from,
            text: msg.image.caption?.trim() || "",
            messageId: msg.id,
            name,
            imageId: msg.image.id,
          });
        }
        // Otros tipos (audio, ubicación) podrían manejarse aquí.
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
        contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
        messages?: Array<{
          from: string;
          id: string;
          type: string;
          text?: { body?: string };
          interactive?: {
            type?: string;
            list_reply?: { id?: string; title?: string };
            button_reply?: { id?: string; title?: string };
          };
          image?: { id?: string; caption?: string; mime_type?: string };
        }>;
      };
    }>;
  }>;
}
