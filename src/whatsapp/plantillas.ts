/**
 * Plantillas de WhatsApp para avisarle al EQUIPO fuera de la ventana de 24 h.
 *
 * Fuera de esa ventana WhatsApp solo deja mandar plantillas aprobadas. Sin una,
 * el handoff de un lead depende de que el asesor le haya escrito al bot ese día
 * — y los asesores no le escriben al bot, atienden clientes. Prime vivió esto el
 * 03/08/2026: 15 leads encolados porque ninguna asesora había escrito. Acá pasa
 * lo mismo con el reporte diario al Gerente, que falla con [131047] casi a
 * diario.
 *
 * El aviso va MÍNIMO y el detalle completo sale cuando la persona responde:
 * responder es lo único que abre la ventana; mandar una plantilla NO la abre.
 *
 * La creación es idempotente y best-effort: si la plantilla ya existe no hace
 * nada, y si Meta falla no impide que el bot arranque.
 */
import { config } from "../config.js";

/** Largo máximo de un parámetro de cuerpo que aceptamos mandar. */
const MAX_PARAM = 200;

/**
 * Crea la plantilla si no existe. `para` solo etiqueta los logs.
 *
 * Sin WABA_ID no se puede listar ni crear: se avisa una vez y se sigue. El
 * envío igual funciona si alguien ya creó la plantilla a mano en Meta.
 */
async function asegurarPlantilla(
  nombre: string,
  lang: string,
  para: string,
  components: unknown[],
): Promise<void> {
  const { wabaId, accessToken, apiVersion } = config.whatsapp;
  if (!wabaId || !accessToken) {
    console.warn(
      `📄 No puedo verificar la plantilla "${nombre}": falta WHATSAPP_WABA_ID o el token. ` +
        "Si ya está creada en Meta, el envío funciona igual.",
    );
    return;
  }

  try {
    const base = `https://graph.facebook.com/${apiVersion}/${wabaId}/message_templates`;
    const listRes = await fetch(
      `${base}?name=${encodeURIComponent(nombre)}&limit=50&access_token=${encodeURIComponent(accessToken)}`,
    );
    const listJson = (await listRes.json().catch(() => ({}))) as {
      data?: { name: string; status?: string }[];
    };
    if (listRes.ok && Array.isArray(listJson.data)) {
      const ya = listJson.data.find((t) => t.name === nombre);
      if (ya) {
        console.log(`📄 Plantilla "${nombre}" (${para}): ya existe, estado ${ya.status ?? "?"}.`);
        return;
      }
    }

    const createRes = await fetch(base, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: nombre, language: lang, category: "UTILITY", components }),
    });
    const createJson = (await createRes.json().catch(() => ({}))) as {
      id?: string;
      status?: string;
      error?: unknown;
    };
    if (createRes.ok) {
      console.log(
        `📄 Plantilla "${nombre}" (${para}): creada y enviada a aprobación (id ${createJson.id}, ${createJson.status}).`,
      );
    } else {
      console.warn(
        `📄 Plantilla "${nombre}" (${para}): no se pudo crear (HTTP ${createRes.status})`,
        createJson.error,
      );
    }
  } catch (err) {
    console.warn(`📄 Plantilla "${nombre}" (${para}): fallo no crítico:`, err);
  }
}

/**
 * Plantilla de aviso al equipo. UN solo parámetro: el resumen.
 *
 * Nada promocional: es un aviso operativo al propio personal. Si se le mete
 * cualquier gancho comercial, Meta la reclasifica a MARKETING y la rechaza.
 */
export async function asegurarPlantillaAvisos(): Promise<void> {
  await asegurarPlantilla(config.whatsapp.templateAvisos, config.whatsapp.templateAvisosIdioma, "avisos", [
    {
      type: "BODY",
      text: "\u{1F514} Tienes un aviso pendiente: {{1}}. Responde a este chat para recibir el detalle completo.",
      example: { body_text: [["Ana Rojas +59171234567 · cotizacion · Piso ceramico 120 m2"]] },
    },
  ]);
}

/** Deja el texto como lo acepta Meta: sin saltos, sin markdown, sin espacios repetidos. */
function aplanar(texto: string): string {
  return (texto ?? "")
    .replace(/[*_~`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function recortar(s: string, max = MAX_PARAM): string {
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

/**
 * El resumen que viaja como {{1}} del aviso de lead.
 *
 * Fuera de la ventana de 24 h esto es LO ÚNICO que ve el asesor, así que el
 * orden no es cosmético: primero el nombre, pegado el teléfono, y recién
 * después el detalle. Lo que se corte a los 200 caracteres tiene que ser
 * siempre el detalle y NUNCA el contacto — un lead al que no se puede llamar
 * no sirve de nada.
 *
 * A diferencia de la versión de Prime, esto NO parsea el mensaje ya renderizado:
 * acá tenemos los campos sueltos antes de armar el texto, así que se construye
 * directo desde ellos. Parsear el render sería reconstruir información que ya
 * está a mano, y se rompería en cuanto alguien cambie una etiqueta del aviso.
 */
export function resumenLead(sol: {
  nombre?: string;
  telefono?: string;
  tipo?: string;
  detalle?: string;
}): string {
  const digitos = (sol.telefono ?? "").replace(/\D/g, "");
  const tel = digitos ? `+${digitos}` : "";
  const nombre = aplanar(sol.nombre || "") || "Cliente";

  // El contacto es intocable: si por sí solo no entra, se recorta el NOMBRE y
  // el teléfono queda entero (un nombre a medias se entiende, un número no).
  const espacioNombre = MAX_PARAM - (tel ? tel.length + 1 : 0);
  const cabeza = [espacioNombre > 0 ? recortar(nombre, espacioNombre) : "", tel]
    .filter(Boolean)
    .join(" ");

  const cola = [aplanar(sol.tipo || ""), aplanar(sol.detalle || "")].filter(Boolean).join(" · ");
  if (!cola) return recortar(cabeza);

  const completo = `${cabeza} · ${cola}`;
  return recortar(completo);
}

/**
 * Códigos de Meta que significan "no se entregó porque la ventana de 24 h está
 * cerrada". Son los únicos que vale la pena reintentar con plantilla: para un
 * número inexistente o un bloqueo, la plantilla también fallaría y sería gastar
 * un envío pago al pedo.
 */
const CODIGOS_VENTANA_CERRADA = new Set([131047, 131026, 132000]);

export function esFalloDeVentana(error?: string): boolean {
  if (!error) return false;
  const m = /\[(\d+)\]/.exec(error);
  return m ? CODIGOS_VENTANA_CERRADA.has(Number(m[1])) : false;
}
