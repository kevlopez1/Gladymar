/**
 * Mensajes de Facebook Messenger e Instagram Direct.
 *
 * Meta manda los tres canales al MISMO webhook y se distinguen por `object`:
 * "whatsapp_business_account", "page" (Messenger) e "instagram". Lo que cambia
 * no es solo la forma del payload: cambia QUIÉN es el remitente.
 *
 * En WhatsApp el remitente ES su teléfono, y de ahí sale todo — el wa.me que se
 * le pasa al asesor, la ficha del CRM, la derivación. En Messenger e Instagram
 * el remitente es un PSID/IGSID: un número largo que PARECE un teléfono y no lo
 * es. Mandarle un wa.me a un PSID le da al asesor un enlace a un número que no
 * existe, y guardarlo como teléfono ensucia el CRM con contactos imposibles de
 * llamar. Por eso el canal viaja con cada mensaje y nunca se asume WhatsApp.
 */
import { config } from "../config.js";

export type Canal = "whatsapp" | "messenger" | "instagram";

export interface MensajeMeta {
  canal: Canal;
  /** PSID (Messenger) o IGSID (Instagram). NO es un teléfono. */
  from: string;
  text: string;
  messageId: string;
  /** URL de la imagen que mandó. Meta las entrega por URL, no por id de media. */
  imageUrl?: string;
  /** Mandó audio, video o un archivo que todavía no sabemos leer. */
  adjuntoNoSoportado?: string;
}

/** ¿Este payload es de Messenger o de Instagram? */
export function canalDelPayload(body: unknown): Canal | null {
  const obj = (body as { object?: string } | null)?.object;
  if (obj === "page") return "messenger";
  if (obj === "instagram") return "instagram";
  return null;
}

interface EntradaMessaging {
  sender?: { id?: string };
  recipient?: { id?: string };
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
    attachments?: { type?: string; payload?: { url?: string } }[];
  };
}

/**
 * Saca los mensajes entrantes de un payload de Messenger o Instagram.
 *
 * Descarta los `is_echo`: son los mensajes que manda la propia página, y Meta
 * los reenvía al webhook. Sin ese filtro el bot se lee a sí mismo y entra en
 * loop contestándose.
 */
export function parseMensajesMeta(body: unknown): MensajeMeta[] {
  const canal = canalDelPayload(body);
  if (!canal) return [];
  const payload = body as { entry?: { messaging?: EntradaMessaging[] }[] };
  const out: MensajeMeta[] = [];

  for (const entry of payload?.entry ?? []) {
    for (const ev of entry.messaging ?? []) {
      const m = ev.message;
      if (!m || m.is_echo) continue;
      const from = ev.sender?.id;
      if (!from) continue;

      const adjuntos = m.attachments ?? [];
      const imagen = adjuntos.find((a) => a.type === "image")?.payload?.url;
      const otro = adjuntos.find((a) => a.type && a.type !== "image")?.type;
      const texto = (m.text ?? "").trim();
      // Un adjunto que no sabemos leer, aunque venga sin texto, igual entra:
      // hay que contestarle algo. Dejar al cliente en visto es peor.
      if (!texto && !imagen && !otro) continue;

      out.push({
        canal,
        from,
        text: texto,
        messageId: m.mid ?? `${from}-${Date.now()}`,
        imageUrl: imagen,
        adjuntoNoSoportado: imagen ? undefined : otro,
      });
    }
  }
  return out;
}

export interface Credenciales {
  id: string;
  token: string;
  /** Meta tiene DOS dominios y el token sirve en uno solo de los dos. */
  base: string;
}

/**
 * Con qué identidad y contra qué dominio se responde cada canal.
 *
 * Instagram admite dos configuraciones y no son intercambiables:
 *
 * - "API setup with Facebook login": la cuenta cuelga de la página, se responde
 *   con el token de página contra graph.facebook.com.
 * - "API setup with Instagram login": la cuenta se conecta sola a la app, tiene
 *   su propio token y responde contra graph.instagram.com.
 *
 * Mandar el token correcto al dominio equivocado da un 190 sin explicar por
 * qué, así que el dominio se elige junto con el token y nunca por separado.
 */
export function credencialesDe(canal: Canal): Credenciales | null {
  return credenciales(canal);
}

function credenciales(canal: Canal): Credenciales | null {
  if (canal === "instagram" && config.meta.instagramToken) {
    const id = config.meta.instagramId || config.meta.pageId;
    return id ? { id, token: config.meta.instagramToken, base: "https://graph.instagram.com" } : null;
  }
  const token = config.meta.pageToken || config.whatsapp.accessToken;
  const id = canal === "instagram" ? config.meta.instagramId || config.meta.pageId : config.meta.pageId;
  return id && token ? { id, token, base: "https://graph.facebook.com" } : null;
}

export function metaHabilitado(canal: Canal): boolean {
  return Boolean(credenciales(canal));
}

/**
 * Responde por Messenger o Instagram.
 *
 * `messaging_type: RESPONSE` es obligatorio: declara que esto contesta algo que
 * escribió el usuario. Sin eso Meta lo trata como mensaje no solicitado y lo
 * rechaza fuera de la ventana de 24 h, igual que en WhatsApp.
 */
export async function enviarMeta(canal: Canal, destinatario: string, texto: string): Promise<string | null> {
  const cred = credenciales(canal);
  if (!cred) throw new Error(`Falta META_PAGE_ID o el token para responder por ${canal}.`);

  const url = `${cred.base}/${config.whatsapp.apiVersion}/${cred.id}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${cred.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: destinatario },
      messaging_type: "RESPONSE",
      // Meta rechaza por encima de 2000 caracteres; se recorta acá y no allá.
      message: { text: texto.slice(0, 2000) },
    }),
  });
  const json = (await res.json().catch(() => ({}))) as { message_id?: string; error?: unknown };
  if (!res.ok) {
    throw new Error(`Error enviando por ${canal} (${res.status}): ${JSON.stringify(json.error ?? json)}`);
  }
  return json.message_id ?? null;
}

/** Cómo se llama el canal cuando se lo nombra en un aviso al asesor. */
export function nombreCanal(canal: Canal): string {
  return canal === "messenger" ? "Facebook Messenger" : canal === "instagram" ? "Instagram" : "WhatsApp";
}

/**
 * Cómo contactar al cliente, para el aviso al asesor.
 *
 * En WhatsApp es un wa.me y se puede escribir directo. En Messenger e
 * Instagram NO hay enlace al chat desde un PSID: el asesor tiene que entrar a
 * la Bandeja de entrada de la página. Decirlo es la diferencia entre un asesor
 * que sabe dónde ir y uno que hace clic en un enlace roto.
 */
export function comoContactar(canal: Canal, from: string): string {
  if (canal === "whatsapp") return `📱 ${from}  (wa.me/${from})`;
  return `💬 Escribió por *${nombreCanal(canal)}* · id ${from}\n   Respondele desde la Bandeja de entrada de la página.`;
}

/**
 * Identificador para el CRM.
 *
 * Se prefija con el canal para que una ficha de Messenger no se mezcle con la
 * de un teléfono que por casualidad tenga los mismos dígitos, y para que del
 * otro lado se vea de qué canal vino el cliente.
 */
export function idParaCrm(canal: Canal, from: string): string {
  return canal === "whatsapp" ? from : `${canal}:${from}`;
}
