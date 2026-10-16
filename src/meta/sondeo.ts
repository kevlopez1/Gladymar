/**
 * Leer los DM de Instagram y Messenger PREGUNTANDO, en vez de esperar el
 * webhook.
 *
 * El camino normal es que Meta avise: llega un POST al webhook y el bot
 * contesta. Cuando esa entrega no está configurada —o Meta simplemente no la
 * manda, que es lo que pasó con Gladymar— el bot nunca se entera de que alguien
 * escribió, por más que el token alcance de sobra para responder. Mandar y
 * enterarse son dos permisos distintos y solo el segundo depende del webhook.
 *
 * Acá se invierte: cada tanto el bot pide las conversaciones con el mismo token
 * que ya usa para responder. Es más lento y gasta más llamadas, pero no depende
 * de ninguna configuración de entrega.
 *
 * NO reemplaza al webhook: si el webhook funciona, el mismo mensaje puede
 * llegar por los dos caminos. Por eso se recuerda qué mensajes ya se
 * atendieron, y el sondeo ignora lo que ya pasó.
 */
import { config } from "../config.js";
import { credencialesDe, type Canal } from "./messenger.js";
import { olvidarTokenPagina } from "./tokenPagina.js";

export interface MensajeSondeado {
  canal: Canal;
  /** Id de quien escribió (PSID o IGSID). */
  from: string;
  text: string;
  messageId: string;
  name?: string;
}

interface ConversacionApi {
  id?: string;
  messages?: {
    data?: {
      id?: string;
      created_time?: string;
      from?: { id?: string; username?: string; name?: string };
      message?: string;
    }[];
  };
}

/**
 * Mensajes ya atendidos, para no contestar dos veces.
 *
 * En memoria a propósito: si el proceso se reinicia, lo peor que pasa es que
 * se vuelva a contestar un mensaje viejo UNA vez. Guardarlo en la base para
 * evitar eso costaría una tabla y una consulta por ciclo; el reinicio es raro
 * y el daño es una respuesta repetida, no un dato perdido.
 */
const atendidos = new Set<string>();
const MAX_RECORDADOS = 3000;

export function marcarAtendido(messageId: string): void {
  if (atendidos.size >= MAX_RECORDADOS) {
    const primero = atendidos.values().next().value;
    if (primero) atendidos.delete(primero);
  }
  atendidos.add(messageId);
}

export function yaAtendido(messageId: string): boolean {
  return atendidos.has(messageId);
}

export function sondeoHabilitado(): boolean {
  return config.meta.sondeoSegundos > 0;
}

/**
 * Pide a Meta las conversaciones del canal y devuelve lo que falta contestar.
 *
 * Solo mira el ÚLTIMO mensaje de cada conversación: si el cliente escribió
 * tres seguidos, contestar el último es lo correcto — los otros ya están en el
 * hilo y responder a cada uno sería hablarle encima.
 */
export async function sondearMensajes(canal: Canal): Promise<MensajeSondeado[]> {
  const cred = await credencialesDe(canal);
  if (!cred) return [];

  const plataforma = canal === "instagram" ? "instagram" : "messenger";
  // Se pide EL ÚLTIMO mensaje de las 10 conversaciones más recientes.
  //
  // Antes eran 3 mensajes de 25 conversaciones, y Meta empezó a contestar
  // {"code":1,"message":"Please reduce the amount of data you're asking for"}
  // y a agotar el timeout. Los otros dos mensajes nunca se usaron: el código
  // mira solo el primero de la lista. Y 10 conversaciones alcanzan de sobra
  // para un ciclo de 60 segundos — si entraran once en un minuto, el resto se
  // levanta en el ciclo siguiente.
  const url =
    `${cred.base}/${config.whatsapp.apiVersion}/${cred.id}/conversations` +
    `?platform=${plataforma}` +
    `&fields=${encodeURIComponent("messages.limit(1){id,created_time,from,message}")}` +
    `&limit=10`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${cred.token}` },
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json().catch(() => ({}))) as { data?: ConversacionApi[]; error?: unknown };
  if (!res.ok) {
    if ((json.error as { code?: number } | undefined)?.code === 190) olvidarTokenPagina();
    throw new Error(`No se pudieron leer las conversaciones de ${canal}: ${JSON.stringify(json.error ?? json)}`);
  }

  const out: MensajeSondeado[] = [];
  for (const conv of json.data ?? []) {
    const mensajes = conv.messages?.data ?? [];
    // Vienen del más nuevo al más viejo.
    const ultimo = mensajes[0];
    if (!ultimo?.id || !ultimo.from?.id) continue;
    // Lo que escribió la propia cuenta no se contesta: sería el bot leyéndose.
    // Se comparan todos nuestros ids: en Instagram los mensajes salientes
    // vienen firmados con el id de la cuenta de Instagram, no con el de la
    // página, así que mirar uno solo no alcanza.
    if (cred.propios.includes(ultimo.from.id)) continue;
    if (yaAtendido(ultimo.id)) continue;
    const texto = (ultimo.message ?? "").trim();
    if (!texto) {
      // Sin texto no hay nada que mandarle al agente (una foto, un sticker).
      // Se marca igual para no volver a mirarlo en cada ciclo.
      marcarAtendido(ultimo.id);
      continue;
    }
    out.push({
      canal,
      from: ultimo.from.id,
      text: texto,
      messageId: ultimo.id,
      name: ultimo.from.username || ultimo.from.name,
    });
  }
  return out;
}

/**
 * La primera corrida solo MARCA lo que hay, sin contestar.
 *
 * Si no, al encender esto el bot le escribiría de golpe a todo el que tenga una
 * conversación abierta, incluidas las de hace meses. Eso no es un bot que
 * atiende: es spam con el nombre de Gladymar.
 */
export async function marcarTodoComoVisto(canal: Canal): Promise<number> {
  const pendientes = await sondearMensajes(canal);
  for (const m of pendientes) marcarAtendido(m.messageId);
  return pendientes.length;
}
