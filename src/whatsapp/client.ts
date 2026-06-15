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
 * Envía un *mensaje interactivo de lista* de WhatsApp (botón "Ver opciones" que
 * abre una lista), replicando la experiencia del demo.
 * @param body Texto del mensaje (cuerpo).
 * @param buttonLabel Texto del botón (máx. 20 caracteres).
 * @param sectionTitle Título de la lista (máx. 24).
 * @param options Opciones (máx. 10). El `id` que vuelve es el texto de la opción.
 */
export async function sendInteractiveList(
  to: string,
  body: string,
  buttonLabel: string,
  sectionTitle: string,
  options: string[],
): Promise<void> {
  const rows = options.slice(0, 10).map((o) => {
    const row: { id: string; title: string; description?: string } = {
      id: o.slice(0, 200),
      title: o.length > 24 ? o.slice(0, 23) + "…" : o,
    };
    if (o.length > 24) row.description = o.slice(0, 72);
    return row;
  });

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
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: (body || "Selecciona una opción:").slice(0, 1024) },
        action: {
          button: (buttonLabel || "Ver opciones").slice(0, 20),
          sections: [{ title: (sectionTitle || "Opciones").slice(0, 24), rows }],
        },
      },
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Error enviando lista interactiva (${res.status}): ${detail}`);
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
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.whatsapp.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
    });
    // No es crítico, pero si Meta rechaza el estado/typing lo registramos para diagnóstico.
    if (!res.ok) {
      const detail = await res.text();
      console.warn(`⌨️  Estado/typing no aplicado (${res.status}): ${detail}`);
    }
  } catch (err) {
    console.warn("⌨️  Estado/typing falló (red):", err);
  }
}
