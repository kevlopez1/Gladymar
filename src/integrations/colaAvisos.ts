/**
 * Consumidor de la cola de avisos del CRM de Prime.
 *
 * El CRM encola los avisos de estado de pedido; este módulo los reclama, manda
 * la plantilla de WhatsApp y le reporta el resultado. El contrato completo está
 * en docs/clientes/gladymar/cola-avisos.md del repo prime-agent-whatsapp.
 *
 * POR QUÉ COLA Y NO WEBHOOK: un webhook obliga al CRM a reintentar cuando el
 * bot está caído, y ese reintento es exactamente la receta del envío doble.
 * Con Meta cobrando por mensaje entregado, cada reintento mal hecho es plata de
 * Gladymar. Acá el bot reclama cuando puede y el arriendo devuelve la fila sola
 * si se muere a mitad de camino.
 *
 * LA GUARDA DE IDEMPOTENCIA ES DE ESTE LADO, no del CRM. El caso que la
 * justifica: el bot reclama, manda, Meta acepta, y el POST del resultado falla
 * por red. El arriendo vence, la fila vuelve, y sin guarda se manda de nuevo.
 * El wamid permite reconciliar DESPUÉS; reconciliar detecta, no previene.
 */
import { config, isWhatsAppConfigured } from "../config.js";
import { sendTemplate } from "../whatsapp/client.js";
import {
  reservarAviso,
  confirmarAviso,
  liberarAviso,
  colaIdPorWamid,
  dbHabilitada,
} from "../db/index.js";

interface AvisoEncolado {
  id: string;
  clave_idem: string;
  telefono: string;
  plantilla: string;
  parametros: string[];
  factura?: string;
  estado?: string;
  id_contacto?: string;
  intentos?: number;
}

/**
 * Cuántos parámetros espera cada plantilla.
 *
 * Se valida ANTES de llamar a Meta: un {{2}} faltante sale como un hueco en la
 * cara del cliente, y el intento igual se cobra. Una plantilla que no figure
 * acá se manda igual (no vamos a frenar un aviso por no conocerla), pero queda
 * el aviso en el log.
 */
const PARAMETROS_ESPERADOS: Record<string, number> = {
  [config.despacho.templatePreparado]: 2, // nombre, factura
  [config.despacho.templateDespachado]: 2, // nombre, factura
  [config.whatsapp.templateAvisos]: 1, // resumen
};

/** Idioma con el que está registrada cada plantilla en Meta. */
function idiomaDe(plantilla: string): string {
  const d = config.despacho;
  if (plantilla === d.templatePreparado) return d.templatePreparadoIdioma || d.templateIdioma;
  if (plantilla === d.templateDespachado) return d.templateDespachadoIdioma || d.templateIdioma;
  if (plantilla === config.whatsapp.templateAvisos) return config.whatsapp.templateAvisosIdioma;
  return d.templateIdioma;
}

function telefonoInternacional(numero: string): string {
  const d = (numero || "").replace(/\D/g, "");
  return d.startsWith("591") ? d : `591${d}`;
}

async function llamar(ruta: string, cuerpo: unknown): Promise<Record<string, unknown> | null> {
  const url = `${config.colaAvisos.url.replace(/\/$/, "")}${ruta}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.colaAvisos.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      // 409 arriendo_ajeno no es un error nuestro: otro proceso tiene la fila.
      // Se loguea distinto para que no parezca una falla que hay que arreglar.
      if (res.status === 409) console.warn(`📨 ${ruta}: el arriendo ya es de otro (409), se deja pasar.`);
      else console.error(`📨 ${ruta} respondió HTTP ${res.status}:`, json);
      return null;
    }
    return json;
  } catch (err) {
    console.error(`📨 No se pudo llamar a ${ruta}:`, err);
    return null;
  }
}

/** Le reporta al CRM cómo terminó un aviso. Nunca lanza. */
async function reportar(
  id: string,
  resultado: "entregado" | "fallido" | "descartado",
  extra: { wamid?: string | null; error_meta?: string } = {},
): Promise<void> {
  await llamar(`/api/avisos/${encodeURIComponent(id)}/resultado`, {
    tenant: config.colaAvisos.tenant,
    arrendatario: config.colaAvisos.arrendatario,
    resultado,
    ...(extra.wamid ? { wamid: extra.wamid } : {}),
    ...(extra.error_meta ? { error_meta: extra.error_meta } : {}),
  });
}

/**
 * Reclama un lote y lo manda.
 *
 * Nunca lanza: un fallo acá no debe tumbar el proceso, la cola se vuelve a
 * reclamar en el próximo ciclo.
 */
export async function procesarColaAvisos(): Promise<void> {
  if (!config.colaAvisos.url || !config.colaAvisos.token) return; // sin configurar: apagado
  if (!isWhatsAppConfigured()) {
    console.warn("📨 Cola de avisos en pausa: faltan credenciales de WhatsApp.");
    return;
  }
  // Sin Postgres no hay guarda de idempotencia, y sin guarda un reintento
  // duplica el envío. Se pausa antes que arriesgar mensajes repetidos.
  if (!dbHabilitada()) {
    console.warn("📨 Cola de avisos en pausa: sin DATABASE_URL no hay guarda contra el envío doble.");
    return;
  }

  const reclamo = await llamar("/api/avisos/reclamar", {
    tenant: config.colaAvisos.tenant,
    arrendatario: config.colaAvisos.arrendatario,
    lote: config.colaAvisos.lote,
    ttl_seg: config.colaAvisos.ttlSeg,
  });
  const avisos = (reclamo?.avisos as AvisoEncolado[] | undefined) ?? [];
  if (!avisos.length) return;

  console.log(`📨 ${avisos.length} aviso(s) reclamados de la cola.`);
  let enviados = 0;
  let repetidos = 0;
  let descartados = 0;
  let fallidos = 0;

  for (const a of avisos) {
    // 1) Validación de forma. Mandar una plantilla con la cantidad equivocada
    //    de parámetros es pagar por un mensaje roto.
    const esperados = PARAMETROS_ESPERADOS[a.plantilla];
    const recibidos = Array.isArray(a.parametros) ? a.parametros.length : -1;
    if (esperados != null && recibidos !== esperados) {
      console.error(
        `📨 Aviso ${a.id} descartado: la plantilla "${a.plantilla}" espera ${esperados} parámetro(s) y llegaron ${recibidos}.`,
      );
      await reportar(a.id, "descartado", {
        error_meta: `parametros_invalidos: esperados ${esperados}, recibidos ${recibidos}`,
      });
      descartados++;
      continue;
    }
    if (esperados == null) {
      console.warn(`📨 Plantilla "${a.plantilla}" desconocida: no puedo validar sus parámetros, se manda igual.`);
    }
    if (!a.telefono || !a.clave_idem) {
      await reportar(a.id, "descartado", { error_meta: "fila sin telefono o sin clave_idem" });
      descartados++;
      continue;
    }

    // 2) Guarda de idempotencia. Si la clave ya está tomada, este aviso salió
    //    antes: se cierra la fila sin volver a mandar ni volver a pagar.
    //
    //    Se reporta ENTREGADO, no descartado. El mensaje SÍ salió: lo único que
    //    no pasó es que saliera en este intento. "Descartado" en esta cola
    //    significa que el aviso no salió y no va a salir, y alguien que lee eso
    //    en la plataforma llama al cliente o se lo manda de nuevo a mano. El
    //    error_meta queda igual para que se distinga del envío de este ciclo.
    if (!(await reservarAviso(a.clave_idem))) {
      console.log(`📨 Aviso ${a.id} (${a.clave_idem}) ya se había enviado: no se repite.`);
      await reportar(a.id, "entregado", { error_meta: "ya_enviado: la clave de idempotencia ya estaba tomada" });
      repetidos++;
      continue;
    }

    // 3) Envío.
    try {
      const wamid = await sendTemplate(
        telefonoInternacional(a.telefono),
        a.plantilla,
        idiomaDe(a.plantilla),
        a.parametros,
      );
      void confirmarAviso(a.clave_idem, wamid, a.id);
      console.log(`📨 Aviso ${a.id} aceptado por Meta (${a.plantilla} -> ${a.telefono})${wamid ? ` id=${wamid}` : ""}`);
      await reportar(a.id, "entregado", { wamid });
      enviados++;
    } catch (err) {
      // Meta RECHAZÓ el envío: se libera la reserva para poder reintentar.
      // Solo acá. Si Meta aceptó y después no entregó, la reserva se queda: el
      // mensaje salió y reenviarlo se cobra igual.
      await liberarAviso(a.clave_idem);
      console.error(`📨 No se pudo enviar el aviso ${a.id}:`, err);
      await reportar(a.id, "fallido", { error_meta: String(err).slice(0, 500) });
      fallidos++;
    }
  }

  console.log(
    `📨 Lote terminado: ${enviados} enviado(s), ${repetidos} ya enviado(s) antes, ` +
      `${descartados} descartado(s), ${fallidos} con error.`,
  );
}

/**
 * Anota en la cola un fallo de entrega que llegó DESPUÉS de cerrar la fila.
 *
 * Meta responde 200 al aceptar el mensaje y recién minutos más tarde avisa que
 * no se entregó. Para entonces la fila ya se reportó como entregada, así que el
 * motivo real se perdía: en la plataforma el aviso figuraba bien y el cliente
 * nunca se había enterado de nada.
 *
 * El POST lleva solo el error_meta: la fila NO se reabre ni vuelve a la cola
 * (reenviar se cobra igual), únicamente queda escrito por qué no llegó. Del
 * lado del CRM va con COALESCE, así que solo escribe si la fila no tenía
 * motivo, y la respuesta trae anotado: true.
 *
 * Nunca lanza: esto corre dentro del webhook de Meta, que no puede fallar por
 * un apunte administrativo.
 */
export async function anotarFalloTardio(wamid: string, error?: string): Promise<void> {
  if (!config.colaAvisos.url || !config.colaAvisos.token || !dbHabilitada()) return;
  try {
    const colaId = await colaIdPorWamid(wamid);
    if (!colaId) return; // no salió por la cola: no hay fila que anotar
    const res = await llamar(`/api/avisos/${encodeURIComponent(colaId)}/resultado`, {
      tenant: config.colaAvisos.tenant,
      arrendatario: config.colaAvisos.arrendatario,
      error_meta: (error || "no entregado, sin detalle de Meta").slice(0, 500),
    });
    if (res?.anotado) console.log(`📨 Fallo tardío anotado en el aviso ${colaId}: ${error ?? "sin detalle"}`);
  } catch (err) {
    console.error("📨 No se pudo anotar el fallo tardío en la cola:", err);
  }
}
