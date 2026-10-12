/**
 * Conseguir el token de PÁGINA a partir del token de System User.
 *
 * Esto resuelve el error que tenía parado Messenger e Instagram:
 *
 *   (#190) This method must be called with a Page Access Token
 *
 * El token de System User de Gladymar tiene todos los permisos, pero Meta no
 * acepta CUALQUIER token con permisos sobre los endpoints de una página: exige
 * un token *de esa página*. Son dos cosas distintas y el mensaje de error no lo
 * explica, así que es fácil leerlo como "falta un permiso" y salir a pedir
 * permisos que ya están.
 *
 * El token de página no hay que generarlo a mano en ninguna pantalla: se le
 * pide a Meta con el token de System User, que es justamente para lo que ese
 * token existe. Y como viene de un System User, no caduca.
 *
 * Por eso acá no se guarda ningún secreto nuevo en Railway: el token de página
 * se deriva al arrancar y se recuerda en memoria.
 */
import { config } from "../config.js";

/** Lo que Meta cuenta de la página, además del token. Sirve de diagnóstico. */
export interface DatosPagina {
  id: string;
  nombre?: string;
  token: string;
  /** Id de la cuenta de Instagram colgada de la página, si hay alguna. */
  instagramId?: string;
}

let cache: { datos: DatosPagina; vence: number } | null = null;
/**
 * Seis horas. El token de System User no caduca, pero igual se re-pide cada
 * tanto: si alguien cambia los accesos de la página, el bot se entera hoy y no
 * en el próximo reinicio, que puede ser dentro de semanas.
 */
const VIGENCIA_MS = 6 * 60 * 60 * 1000;

/** Olvidar el token guardado. Se llama cuando Meta lo rechaza con un 190. */
export function olvidarTokenPagina(): void {
  cache = null;
}

/**
 * Pide a Meta el token de la página.
 *
 * Si `META_PAGE_TOKEN` está cargado se usa ese y no se pregunta nada: alguien
 * lo puso a propósito y pisar su decisión sería peor.
 */
export async function datosDePagina(): Promise<DatosPagina | null> {
  const pageId = config.meta.pageId;
  if (!pageId) return null;

  if (config.meta.pageToken) {
    return { id: pageId, token: config.meta.pageToken };
  }

  const ahora = Date.now();
  if (cache && cache.vence > ahora) return cache.datos;

  const sistema = config.whatsapp.accessToken;
  if (!sistema) return null;

  const url =
    `https://graph.facebook.com/${config.whatsapp.apiVersion}/${pageId}` +
    `?fields=${encodeURIComponent("name,access_token,instagram_business_account")}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${sistema}` },
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => ({}))) as {
    name?: string;
    access_token?: string;
    instagram_business_account?: { id?: string };
    error?: unknown;
  };
  if (!res.ok) {
    throw new Error(`Meta no dio el token de la página ${pageId}: ${JSON.stringify(json.error ?? json)}`);
  }
  if (!json.access_token) {
    // Pasa cuando el System User no está asignado a la página. El token es
    // válido y los permisos están; lo que falta es el vínculo con la página.
    throw new Error(
      `Meta no devolvió access_token para la página ${pageId}. ` +
        `Hay que asignar el System User a la página en Business Settings (acceso a Mensajes).`,
    );
  }

  const datos: DatosPagina = {
    id: pageId,
    nombre: json.name,
    token: json.access_token,
    instagramId: json.instagram_business_account?.id,
  };
  cache = { datos, vence: ahora + VIGENCIA_MS };
  return datos;
}

/** Solo el token, que es lo que piden casi todas las llamadas. */
export async function tokenDePagina(): Promise<string | null> {
  const datos = await datosDePagina();
  return datos?.token ?? null;
}

/**
 * Suscribir la app a los mensajes de la página.
 *
 * Esto es lo que hace que Meta ENTREGUE los webhooks, y es distinto de elegir
 * los campos en el panel de la app: ahí se dice qué eventos quiere escuchar la
 * app en general; acá se dice que los quiere de ESTA página. Sin este paso el
 * panel muestra todo suscrito y al webhook no llega nada, que es exactamente lo
 * que venía pasando.
 *
 * Requiere el token de página, así que antes no se podía hacer.
 */
export async function suscribirPagina(): Promise<{ ok: boolean; detalle: string }> {
  const datos = await datosDePagina();
  if (!datos) return { ok: false, detalle: "Falta META_PAGE_ID o el token de WhatsApp." };

  const campos = ["messages", "messaging_postbacks", "message_reactions", "messaging_referrals"];
  const url = `https://graph.facebook.com/${config.whatsapp.apiVersion}/${datos.id}/subscribed_apps`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${datos.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ subscribed_fields: campos.join(",") }),
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => ({}))) as { success?: boolean; error?: unknown };
  if (!res.ok || json.success === false) {
    return { ok: false, detalle: JSON.stringify(json.error ?? json) };
  }
  return { ok: true, detalle: campos.join(", ") };
}
