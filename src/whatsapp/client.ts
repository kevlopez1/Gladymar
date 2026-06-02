/**
 * Cliente para enviar mensajes vía WhatsApp Cloud API (Meta Graph API).
 */
import { config } from "../config.js";

const BASE = `https://graph.facebook.com/${config.whatsapp.apiVersion}`;

/**
 * Envía un mensaje de texto a un número de WhatsApp.
 * @param to Número del destinatario en formato internacional sin "+" (ej. 59171234567).
 */
export async function sendText(to: string, body: string): Promise<void> {
  const url = `${BASE}/${config.whatsapp.phoneNumberId}/messages`;

  // WhatsApp limita el cuerpo de texto a ~4096 caracteres.
  const text = body.length > 4096 ? body.slice(0, 4093) + "..." : body;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.whatsapp.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { preview_url: false, body: text },
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Error enviando WhatsApp (${res.status}): ${detail}`);
  }
}

/**
 * Marca un mensaje entrante como leído (opcional, mejora la UX: doble check azul).
 */
export async function markAsRead(messageId: string): Promise<void> {
  const url = `${BASE}/${config.whatsapp.phoneNumberId}/messages`;
  try {
    await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.whatsapp.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
      }),
    });
  } catch {
    // No es crítico; ignoramos errores al marcar como leído.
  }
}
