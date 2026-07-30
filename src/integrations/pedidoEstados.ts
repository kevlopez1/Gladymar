/**
 * Notificaciones automáticas de estado de pedido (plantillas de WhatsApp).
 *
 * Revisa periódicamente la pestaña "DESPACHOS" del Excel de control de
 * despacho y, cuando una factura cambia a "Preparado" o "Despachado", le manda
 * al cliente la plantilla de Meta correspondiente con su nombre y N° de
 * factura, sin que el cliente tenga que preguntar.
 *
 * Se lee vía export CSV (~3 KB) en vez del .xlsx completo (~280 KB): el export
 * CSV de Google Sheets devuelve la PRIMERA pestaña, que es justamente
 * "DESPACHOS" (los pedidos en curso). No hace falta el libro entero.
 *
 * Una factura puede tener MÁS DE UN número de contacto cargado (a pedido de
 * Gerencia): se le avisa a todos, y se lleva el control por (factura, teléfono)
 * para que el aviso a uno no marque como notificado al otro.
 *
 * PROTECCIONES (cada envío cuesta dinero en Meta y le llega a un cliente real):
 *  1. Sin Postgres NO se manda nada: sin memoria de lo ya avisado, cada chequeo
 *     reenviaría todo. Una caída de la BD pausa los avisos en vez de duplicarlos.
 *  2. Primer arranque: se registra el estado actual SIN avisar, para no
 *     bombardear a clientes con pedidos viejos que ya estaban en la hoja.
 *  3. Un teléfono que figura con VARIOS nombres de cliente distintos se omite:
 *     mandaría el pedido de una persona al WhatsApp de otra. Se exceptúan los
 *     números internos de Gladymar (administradores del panel y los cargados en
 *     DESPACHO_TELEFONOS_PRUEBA), que se repiten a propósito para hacer pruebas.
 */
import { config, isWhatsAppConfigured } from "../config.js";
import { parseCSV } from "../util/csv.js";
import { sendTemplate } from "../whatsapp/client.js";
import { obtenerEstadosPedidos, guardarEstadoPedido, dbHabilitada, claveEstadoPedido } from "../db/index.js";
import { esAdmin } from "../admin/roles.js";

/**
 * Estados que disparan aviso -> plantilla de Meta a usar (nombre + idioma).
 * El idioma es parte de la identidad de la plantilla en Meta, por eso cada una
 * puede tener el suyo (si una quedó registrada como "English", hay que pedirla
 * como "en" aunque su texto esté en español).
 */
function templateDeEstado(estado: string): { nombre: string; idioma: string } | null {
  const d = config.despacho;
  if (estado === "preparado") {
    return { nombre: d.templatePreparado, idioma: d.templatePreparadoIdioma || d.templateIdioma };
  }
  if (estado === "despachado") {
    return { nombre: d.templateDespachado, idioma: d.templateDespachadoIdioma || d.templateIdioma };
  }
  return null; // "Entregado" u otros: no se avisa (el cliente ya lo recibió).
}

/**
 * Dígitos de un valor numérico del CSV.
 *
 * OJO: Google Sheets puede exportar una celda numérica como "71091625.0". Un
 * `replace(/\D/g,"")` directo daría "710916250" (un dígito de más) y el aviso
 * se mandaría a un número que no es el del cliente. Por eso se descarta primero
 * la parte decimal.
 */
function digitos(valor: string): string {
  return valor.trim().replace(/\.\d*$/, "").replace(/\D/g, "");
}

function telefonoInternacional(numero: string): string {
  return numero.startsWith("591") ? numero : `591${numero}`;
}

/** ¿Es un número interno de Gladymar (panel de admins o cargado para pruebas)? */
function esTelefonoInterno(telefono: string): boolean {
  return esAdmin(telefono) || config.despacho.telefonosPrueba.includes(telefono);
}

interface PedidoActual {
  factura: string;
  nombre: string;
  estado: string;
  /** Todos los números de contacto cargados para esa factura (sin repetir). */
  telefonos: string[];
}

/**
 * Descarga la pestaña de pedidos en curso como CSV. Null si no se pudo.
 * Cada fallo se loguea con su motivo: si esto queda mudo, los avisos dejan de
 * salir sin ninguna pista de por qué.
 */
async function descargarDespachos(): Promise<string[][] | null> {
  if (!config.despacho.sheetId) {
    console.warn("📦 Avisos de pedido desactivados: falta DESPACHO_SHEET_ID.");
    return null;
  }
  try {
    const url = `https://docs.google.com/spreadsheets/d/${config.despacho.sheetId}/export?format=csv`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) {
      console.error(`📦 No se pudo leer la hoja de despacho: HTTP ${res.status} ${res.statusText}`);
      return null;
    }
    const csv = await res.text();
    if (csv.trimStart().startsWith("<")) {
      console.error(
        "📦 La hoja de despacho devolvió HTML en vez de CSV: hay que compartirla como 'Cualquiera con el enlace: Lector'.",
      );
      return null;
    }
    return parseCSV(csv);
  } catch (err) {
    console.error("📦 No se pudo descargar la hoja de despacho (CSV):", err);
    return null;
  }
}

export interface LecturaDespachos {
  pedidos: PedidoActual[];
  /**
   * Teléfonos de clientes que figuran con más de un nombre distinto. Se calcula
   * sobre TODAS las filas (no sobre los pedidos ya agrupados): si se calculara
   * después de agrupar por factura, un teléfono compartido que quedó descartado
   * al elegir el de la factura pasaría desapercibido.
   */
  telefonosAmbiguos: Set<string>;
}

/** Arma un pedido por factura (una factura tiene varias filas, una por producto). */
export function leerPedidos(filas: string[][]): LecturaDespachos {
  const vacio: LecturaDespachos = { pedidos: [], telefonosAmbiguos: new Set() };
  const encIdx = filas.findIndex((f) => f.some((c) => c.trim().toUpperCase() === "FACTURA"));
  if (encIdx === -1) return vacio;
  const enc = filas[encIdx].map((c) => c.trim().toUpperCase());
  const col = (nombre: string) => enc.indexOf(nombre);
  const iFactura = col("FACTURA");
  const iTelefono = col("TELEFONO DEL CLIENTE");
  const iNombre = col("NOMBRE DEL CLIENTE");
  const iEstado = col("ESTADO");
  if (iFactura === -1 || iTelefono === -1 || iEstado === -1) return vacio;

  interface Acum { nombre: string; estado: string; telefonos: Set<string> }
  const porFactura = new Map<string, Acum>();
  const nombresPorTelefono = new Map<string, Set<string>>();

  for (let r = encIdx + 1; r < filas.length; r++) {
    const f = filas[r];
    const factura = digitos(f[iFactura] ?? "");
    if (!factura) continue;
    const telefono = digitos(f[iTelefono] ?? "");
    const estado = (f[iEstado] ?? "").trim().toLowerCase();
    if (!telefono || !estado) continue;
    const nombre = (iNombre >= 0 ? f[iNombre] ?? "" : "").trim();

    const acum = porFactura.get(factura) ?? { nombre, estado, telefonos: new Set<string>() };
    acum.telefonos.add(telefono);
    porFactura.set(factura, acum);

    if (!nombresPorTelefono.has(telefono)) nombresPorTelefono.set(telefono, new Set());
    nombresPorTelefono.get(telefono)!.add(nombre.toUpperCase());
  }

  // Los números internos se repiten a propósito entre facturas de prueba: no
  // son un error de carga y no deben bloquearse.
  const telefonosAmbiguos = new Set<string>();
  for (const [tel, nombres] of nombresPorTelefono) {
    if (nombres.size > 1 && !esTelefonoInterno(tel)) telefonosAmbiguos.add(tel);
  }

  const pedidos = [...porFactura.entries()].map(([factura, a]) => ({
    factura,
    nombre: a.nombre,
    estado: a.estado,
    telefonos: [...a.telefonos],
  }));

  return { pedidos, telefonosAmbiguos };
}

/**
 * Revisa la hoja y manda las notificaciones de los pedidos que cambiaron de
 * estado desde el último chequeo. Nunca lanza.
 */
export async function chequearNotificacionesPedidos(): Promise<void> {
  if (!isWhatsAppConfigured()) return;

  // Protección 1: sin persistencia no hay forma de saber qué ya se avisó.
  if (!dbHabilitada()) {
    console.warn("📦 Avisos de pedido en pausa: falta DATABASE_URL (sin ella se reenviarían en cada chequeo).");
    return;
  }

  try {
    const filas = await descargarDespachos();
    if (!filas) return;
    const { pedidos, telefonosAmbiguos: ambiguos } = leerPedidos(filas);
    if (!pedidos.length) {
      console.warn(
        `📦 La hoja se leyó (${filas.length} filas) pero no se reconoció ningún pedido: ` +
          "revisar que estén las columnas FACTURA, TELEFONO DEL CLIENTE y ESTADO.",
      );
      return;
    }

    const yaAvisado = await obtenerEstadosPedidos();
    if (yaAvisado === null) {
      console.warn("📦 Avisos de pedido en pausa: Postgres no respondió (se reintenta en el próximo chequeo).");
      return;
    }

    // Protección 2: primer arranque => registrar sin avisar.
    if (yaAvisado.size === 0) {
      let n = 0;
      for (const p of pedidos) {
        for (const tel of p.telefonos) {
          await guardarEstadoPedido(p.factura, tel, p.estado);
          n++;
        }
      }
      console.log(`📦 Primer arranque: se registraron ${n} contacto(s) SIN avisar (evita avisos de pedidos viejos).`);
      return;
    }

    if (ambiguos.size) {
      console.warn(`📦 ${ambiguos.size} teléfono(s) figuran con varios clientes distintos; esos avisos NO se envían.`);
    }

    for (const pedido of pedidos) {
      const template = templateDeEstado(pedido.estado);

      for (const tel of pedido.telefonos) {
        if (yaAvisado.get(claveEstadoPedido(pedido.factura, tel)) === pedido.estado) continue; // sin cambios

        // Estado que no avisamos (ej. "Entregado"): se registra para no
        // re-evaluarlo, pero no se manda nada.
        if (!template) {
          await guardarEstadoPedido(pedido.factura, tel, pedido.estado);
          continue;
        }

        // Protección 3: no mandarle el pedido de un cliente al WhatsApp de otro.
        if (ambiguos.has(tel)) {
          console.warn(`📦 Factura ${pedido.factura} omitida para ${tel}: ese número figura con varios clientes.`);
          continue;
        }

        try {
          await sendTemplate(telefonoInternacional(tel), template.nombre, template.idioma, [
            pedido.nombre || "Cliente",
            pedido.factura,
          ]);
          console.log(`📦 Aviso "${pedido.estado}" enviado (factura ${pedido.factura} -> ${tel})`);
        } catch (err) {
          console.error(`No se pudo enviar el aviso (factura ${pedido.factura} -> ${tel}):`, err);
          continue; // no se registra: se reintenta en el próximo chequeo
        }
        await guardarEstadoPedido(pedido.factura, tel, pedido.estado);
      }
    }
  } catch (err) {
    console.error("No se pudo chequear las notificaciones de pedidos:", err);
  }
}
