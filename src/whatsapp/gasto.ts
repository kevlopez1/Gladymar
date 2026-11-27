/**
 * Lo que Meta cobra por los mensajes de WhatsApp, sacado de Meta.
 *
 * Existe por un pedido de Gerencia (27/11/2026): a Gladymar le llegó un cargo
 * "FACEBK *..." en la tarjeta y Contabilidad necesita imputarlo a un centro de
 * costos, así que hace falta el detalle de qué lo generó. El extracto de la
 * tarjeta trae un total y nada más.
 *
 * El dato sale de `conversation_analytics` de la WABA, que es la misma fuente
 * que muestra WhatsApp Manager: cuántas conversaciones hubo por día y por
 * categoría (MARKETING, UTILITY, SERVICE, AUTHENTICATION) y cuánto costó cada
 * grupo. Con eso se separa lo que gastó el chatbot atendiendo clientes
 * (SERVICE/UTILITY) de lo que gastó una campaña (MARKETING), que era
 * justamente la duda.
 *
 * OJO: esto NO reemplaza la factura. El comprobante con el número de
 * referencia del cargo lo emite Meta en WhatsApp Manager → Facturación. Esto
 * es el detalle de QUÉ se consumió, para explicar ese total.
 */
import { config } from "../config.js";

export interface GastoPorCategoria {
  categoria: string;
  conversaciones: number;
  costoUsd: number;
}

export interface GastoMeta {
  waba: string;
  desde: string;
  hasta: string;
  moneda: "USD";
  totalUsd: number;
  totalConversaciones: number;
  porCategoria: GastoPorCategoria[];
  porDia: { fecha: string; conversaciones: number; costoUsd: number }[];
}

/** Un punto de la respuesta de Meta. Solo se declaran los campos que se usan. */
interface PuntoMeta {
  start?: number;
  conversation?: number;
  cost?: number;
  conversation_category?: string;
}

const DIA = 86_400;

/** Fecha YYYY-MM-DD en hora de Bolivia, que es como la lee quien pide el reporte. */
function fechaBolivia(epochSegundos: number): string {
  return new Date((epochSegundos - 4 * 3600) * 1000).toISOString().slice(0, 10);
}

/**
 * Pide a Meta el consumo de la WABA entre dos fechas.
 *
 * `dias` es hacia atrás desde hoy. Meta guarda estos datos unos 90 días.
 */
export async function gastoDeMeta(dias = 60): Promise<GastoMeta | { error: string }> {
  const { wabaId, accessToken, apiVersion } = config.whatsapp;
  if (!wabaId || !accessToken) return { error: "Falta WHATSAPP_WABA_ID o el token de WhatsApp." };

  const hasta = Math.floor(Date.now() / 1000);
  const desde = hasta - Math.max(1, Math.min(dias, 90)) * DIA;

  // phone_numbers([]) = todos los números de la cuenta. La dimensión de
  // categoría es la que permite separar campaña de atención.
  const campos =
    `conversation_analytics.start(${desde}).end(${hasta}).granularity(DAILY)` +
    `.phone_numbers([]).dimensions(["CONVERSATION_CATEGORY"])`;
  const url =
    `https://graph.facebook.com/${apiVersion}/${wabaId}` +
    `?fields=${encodeURIComponent(campos)}&access_token=${encodeURIComponent(accessToken)}`;

  const res = await fetch(url);
  const cuerpo = (await res.json().catch(() => null)) as {
    conversation_analytics?: { data?: { data_points?: PuntoMeta[] }[] };
    error?: { message?: string };
  } | null;

  if (!res.ok || !cuerpo || cuerpo.error) {
    return { error: cuerpo?.error?.message || `Meta respondió ${res.status}.` };
  }

  const puntos = (cuerpo.conversation_analytics?.data ?? []).flatMap((d) => d.data_points ?? []);

  const porCategoria = new Map<string, GastoPorCategoria>();
  const porDia = new Map<string, { fecha: string; conversaciones: number; costoUsd: number }>();
  let totalUsd = 0;
  let totalConversaciones = 0;

  for (const p of puntos) {
    const costo = Number(p.cost) || 0;
    const conversaciones = Number(p.conversation) || 0;
    totalUsd += costo;
    totalConversaciones += conversaciones;

    const cat = p.conversation_category || "SIN_CATEGORIA";
    const acumCat = porCategoria.get(cat) ?? { categoria: cat, conversaciones: 0, costoUsd: 0 };
    acumCat.conversaciones += conversaciones;
    acumCat.costoUsd += costo;
    porCategoria.set(cat, acumCat);

    if (p.start != null) {
      const fecha = fechaBolivia(p.start);
      const acumDia = porDia.get(fecha) ?? { fecha, conversaciones: 0, costoUsd: 0 };
      acumDia.conversaciones += conversaciones;
      acumDia.costoUsd += costo;
      porDia.set(fecha, acumDia);
    }
  }

  const redondear = (n: number) => Number(n.toFixed(4));
  return {
    waba: wabaId,
    desde: fechaBolivia(desde),
    hasta: fechaBolivia(hasta),
    moneda: "USD",
    totalUsd: redondear(totalUsd),
    totalConversaciones,
    porCategoria: [...porCategoria.values()]
      .map((c) => ({ ...c, costoUsd: redondear(c.costoUsd) }))
      .sort((a, b) => b.costoUsd - a.costoUsd),
    porDia: [...porDia.values()]
      .map((d) => ({ ...d, costoUsd: redondear(d.costoUsd) }))
      .sort((a, b) => a.fecha.localeCompare(b.fecha)),
  };
}
