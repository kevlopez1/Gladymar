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
 * Envía un documento (PDF) por WhatsApp a partir de un enlace público.
 * Útil para el Manual de Asentamiento (Tríptico de Colocación) y catálogos.
 * @param link URL pública y directa al archivo (debe ser accesible por Meta).
 */
export async function sendDocument(
  to: string,
  link: string,
  filename: string,
  caption?: string,
): Promise<void> {
  const url = `${BASE}/${config.whatsapp.phoneNumberId}/messages`;
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
      type: "document",
      document: { link, filename, ...(caption ? { caption } : {}) },
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Error enviando documento WhatsApp (${res.status}): ${detail}`);
  }
}

/**
 * Marca un mensaje entrante como leído (doble check azul).
 */
export async function markAsRead(messageId: string): Promise<void> {
  await postStatus({ status: "read", message_id: messageId });
}

/**
 * Marca como leído Y muestra el indicador "escribiendo…" al cliente.
 * El indicador se mantiene hasta ~25s o hasta que enviemos un mensaje.
 */
export async function markReadAndTyping(messageId: string): Promise<void> {
  await postStatus({ status: "read", message_id: messageId, typing_indicator: { type: "text" } });
}

async function postStatus(body: Record<string, unknown>): Promise<void> {
  const url = `${BASE}/${config.whatsapp.phoneNumberId}/messages`;
  try {
    await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.whatsapp.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
    });
  } catch {
    // No es crítico; ignoramos errores de estado/typing.
  }
}
