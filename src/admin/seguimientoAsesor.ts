/**
 * El bot le pregunta al asesor cómo le fue con el lead que se le derivó.
 *
 * Hasta acá la derivación era de ida: el bot entregaba el cliente y no se
 * enteraba de nada más. Nadie podía contestar "de los 40 leads de la semana,
 * ¿cuántos se cerraron?", que es la pregunta que hace Gerencia, y el embudo del
 * CRM se quedaba clavado en "cotizado" porque nadie lo movía a mano.
 *
 * Acá el bot pregunta y la respuesta viaja al CRM como etapa. El asesor toca un
 * botón; no se le pide que escriba nada.
 *
 * LÍMITE CONOCIDO: si el asesor no le escribió al bot en las últimas 24 h, la
 * pregunta necesita una plantilla de Meta, y hoy las plantillas fallan por
 * falta de medio de pago en la cuenta de WhatsApp Business (error 131042). En
 * ese caso el intento no se quema: se vuelve a intentar en el próximo ciclo.
 */
import { config } from "../config.js";
import {
  seguimientosPendientes,
  marcarPreguntado,
  seguimientoAbiertoDe,
  registrarResultado,
  type SeguimientoRow,
} from "../db/index.js";

/** Lo que puede contestar el asesor, y a qué etapa del embudo equivale. */
export const RESPUESTAS: { titulo: string; resultado: string; etapa?: string; cierra: boolean }[] = [
  { titulo: "✅ Le vendí", resultado: "ganado", etapa: "ganado", cierra: true },
  { titulo: "💬 Sigue en trato", resultado: "negociacion", etapa: "negociacion", cierra: true },
  { titulo: "❌ No compró", resultado: "perdido", etapa: "perdido", cierra: true },
  // No cierra: el lead sigue abierto y se vuelve a preguntar en el próximo
  // ciclo. Es la respuesta honesta de quien todavía no llamó, y contarla como
  // un resultado sería perder el seguimiento justo cuando más falta hace.
  { titulo: "🕗 Todavía no lo contacté", resultado: "sin_contactar", cierra: false },
];

export function seguimientoAsesorHabilitado(): boolean {
  return config.seguimientoAsesor.activo;
}

/** El texto de la pregunta. Corto: el asesor la lee entre dos clientes. */
export function textoPregunta(s: SeguimientoRow): string {
  const cliente = s.clienteNombre || "el cliente";
  const dias = Math.max(1, Math.round((Date.now() - s.derivadoEn) / 86_400_000));
  const cuando = dias === 1 ? "ayer" : `hace ${dias} días`;
  return [
    `👋 ${s.asesorNombre ? s.asesorNombre.split(" ")[0] + ", una" : "Una"} consulta rápida.`,
    "",
    `Te derivamos a *${cliente}*${s.ciudad ? ` (${s.ciudad})` : ""} ${cuando}:`,
    `📱 wa.me/${s.clienteTelefono}`,
    s.detalle ? `🗒️ ${s.detalle}` : "",
    "",
    "¿Cómo te fue?",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Los que ya toca preguntar, según la cadencia configurada. */
export function pendientes(limite = 20): Promise<SeguimientoRow[]> {
  return seguimientosPendientes(config.seguimientoAsesor.horas, config.seguimientoAsesor.maxPreguntas, limite);
}

export { marcarPreguntado };

/**
 * ¿Este texto del asesor es una respuesta al seguimiento?
 *
 * Solo se acepta el título exacto de un botón. Nada de adivinar por palabras
 * sueltas: el asesor también usa el panel, y confundir "no" con "No compró"
 * cerraría un lead que sigue vivo.
 */
export function respuestaDe(texto: string): (typeof RESPUESTAS)[number] | undefined {
  const t = (texto || "").trim().toLowerCase();
  return RESPUESTAS.find((r) => r.titulo.toLowerCase() === t);
}

export interface ResultadoRegistrado {
  seguimiento: SeguimientoRow;
  respuesta: (typeof RESPUESTAS)[number];
}

/**
 * Guarda la respuesta del asesor contra su seguimiento abierto.
 *
 * Devuelve null si no había ninguno: alguien puede tocar un botón viejo días
 * después, y entonces no hay nada que actualizar.
 */
export async function registrarRespuesta(
  asesorTelefono: string,
  texto: string,
): Promise<ResultadoRegistrado | null> {
  const respuesta = respuestaDe(texto);
  if (!respuesta) return null;
  const seguimiento = await seguimientoAbiertoDe(asesorTelefono);
  if (!seguimiento) return null;
  if (respuesta.cierra) await registrarResultado(seguimiento.id, respuesta.resultado);
  return { seguimiento, respuesta };
}

/** Lo que el bot le contesta al asesor después de su respuesta. */
export function acuse(r: ResultadoRegistrado): string {
  const cliente = r.seguimiento.clienteNombre || "el cliente";
  switch (r.respuesta.resultado) {
    case "ganado":
      return `🎉 ¡Grande! Anoté a *${cliente}* como *ganado* y ya quedó actualizado en el CRM.`;
    case "negociacion":
      return `👍 Anotado: *${cliente}* sigue en negociación. Queda así en el CRM.`;
    case "perdido":
      return `Gracias por avisar. Marqué a *${cliente}* como *perdido* en el CRM.`;
    default:
      return `Sin problema. Te lo vuelvo a recordar más adelante para no perderle el rastro a *${cliente}*.`;
  }
}
