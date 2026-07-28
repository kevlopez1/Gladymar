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
 * PROTECCIONES (cada envío cuesta dinero en Meta y le llega a un cliente real):
 *  1. Sin Postgres NO se manda nada: sin memoria de lo ya avisado, cada chequeo
 *     reenviaría todo. Una caída de la BD pausa los avisos en vez de duplicarlos.
 *  2. Primer arranque: se registra el estado actual SIN avisar, para no
 *     bombardear a clientes con pedidos viejos que ya estaban en la hoja.
 *  3. Un teléfono que aparece con VARIOS nombres de cliente distintos se omite:
 *     mandaría el pedido de una persona al WhatsApp de otra.
 */
import { config, isWhatsAppConfigured } from "../config.js";
import { parseCSV } from "../util/csv.js";
import { sendTemplate } from "../whatsapp/client.js";
import { obtenerEstadosPedidos, guardarEstadoPedido, dbHabilitada } from "../db/index.js";

/** Estados que disparan aviso -> plantilla de Meta a usar. */
function templateDeEstado(estado: string): string | null {
  if (estado === "preparado") return config.despacho.templatePreparado;
  if (estado === "despachado") return config.despacho.templateDespachado;
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

interface PedidoActual {
  factura: string;
  nombre: string;
  telefono: string;
  estado: string;
  /** La factura trae más de un teléfono distinto entre sus filas: no se puede elegir uno. */
  telefonoInconsistente: boolean;
}

/** Descarga la pestaña de pedidos en curso como CSV. Null si no se pudo. */
async function descargarDespachos(): Promise<string[][] | null> {
  if (!config.despacho.sheetId) return null;
  try {
    const url = `https://docs.google.com/spreadsheets/d/${config.despacho.sheetId}/export?format=csv`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return null;
    const csv = await res.text();
    if (csv.trimStart().startsWith("<")) return null; // HTML => hoja no compartida
    return parseCSV(csv);
  } catch (err) {
    console.error("No se pudo descargar la hoja de despacho (CSV):", err);
    return null;
  }
}

/** Arma un pedido por factura (una factura tiene varias filas, una por producto). */
export function leerPedidos(filas: string[][]): PedidoActual[] {
  const encIdx = filas.findIndex((f) => f.some((c) => c.trim().toUpperCase() === "FACTURA"));
  if (encIdx === -1) return [];
  const enc = filas[encIdx].map((c) => c.trim().toUpperCase());
  const col = (nombre: string) => enc.indexOf(nombre);
  const iFactura = col("FACTURA");
  const iTelefono = col("TELEFONO DEL CLIENTE");
  const iNombre = col("NOMBRE DEL CLIENTE");
  const iEstado = col("ESTADO");
  if (iFactura === -1 || iTelefono === -1 || iEstado === -1) return [];

  // Una factura tiene varias filas (una por producto). Recolectamos TODOS sus
  // teléfonos: si no coinciden entre sí, no hay forma de elegir a cuál avisar.
  interface Acum { nombre: string; estado: string; telefonos: Set<string> }
  const porFactura = new Map<string, Acum>();
  for (let r = encIdx + 1; r < filas.length; r++) {
    const f = filas[r];
    const factura = digitos(f[iFactura] ?? "");
    if (!factura) continue;
    const telefono = digitos(f[iTelefono] ?? "");
    const estado = (f[iEstado] ?? "").trim().toLowerCase();
    if (!telefono || !estado) continue;
    const acum = porFactura.get(factura) ?? {
      nombre: (iNombre >= 0 ? f[iNombre] ?? "" : "").trim(),
      estado,
      telefonos: new Set<string>(),
    };
    acum.telefonos.add(telefono);
    porFactura.set(factura, acum);
  }

  return [...porFactura.entries()].map(([factura, a]) => ({
    factura,
    nombre: a.nombre,
    estado: a.estado,
    telefono: [...a.telefonos][0],
    telefonoInconsistente: a.telefonos.size > 1,
  }));
}

/**
 * Teléfonos que aparecen con más de un nombre de cliente distinto: no se puede
 * saber a quién pertenecen, así que no se les manda nada (mandaríamos el pedido
 * de un cliente al WhatsApp de otro).
 */
export function telefonosAmbiguos(pedidos: PedidoActual[]): Set<string> {
  const nombresPorTelefono = new Map<string, Set<string>>();
  for (const p of pedidos) {
    if (!nombresPorTelefono.has(p.telefono)) nombresPorTelefono.set(p.telefono, new Set());
    nombresPorTelefono.get(p.telefono)!.add(p.nombre.toUpperCase());
  }
  const ambiguos = new Set<string>();
  for (const [tel, nombres] of nombresPorTelefono) {
    if (nombres.size > 1) ambiguos.add(tel);
  }
  return ambiguos;
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
    const pedidos = leerPedidos(filas);
    if (!pedidos.length) return;

    const yaAvisado = await obtenerEstadosPedidos();
    if (yaAvisado === null) {
      console.warn("📦 Avisos de pedido en pausa: Postgres no respondió (se reintenta en el próximo chequeo).");
      return;
    }

    // Protección 2: primer arranque => registrar sin avisar.
    const primerArranque = yaAvisado.size === 0;
    if (primerArranque) {
      for (const p of pedidos) await guardarEstadoPedido(p.factura, p.estado);
      console.log(`📦 Primer arranque: se registraron ${pedidos.length} pedidos SIN avisar (evita avisos de pedidos viejos).`);
      return;
    }

    // Protección 3: teléfonos que no identifican a un solo cliente.
    const ambiguos = telefonosAmbiguos(pedidos);
    if (ambiguos.size) {
      console.warn(`📦 ${ambiguos.size} teléfono(s) aparecen con varios clientes distintos en la hoja; esos pedidos NO se avisan.`);
    }

    for (const pedido of pedidos) {
      if (yaAvisado.get(pedido.factura) === pedido.estado) continue; // sin cambios

      const template = templateDeEstado(pedido.estado);
      if (!template) {
        // Estado que no avisamos (ej. "Entregado"): igual lo registramos para
        // no re-evaluarlo, pero sin mandar nada.
        await guardarEstadoPedido(pedido.factura, pedido.estado);
        continue;
      }

      if (pedido.telefonoInconsistente) {
        console.warn(`📦 Factura ${pedido.factura} omitida: sus filas traen teléfonos distintos entre sí.`);
        continue;
      }
      if (ambiguos.has(pedido.telefono)) {
        console.warn(`📦 Factura ${pedido.factura} omitida: el teléfono ${pedido.telefono} figura con varios clientes.`);
        continue;
      }

      try {
        await sendTemplate(telefonoInternacional(pedido.telefono), template, config.despacho.templateIdioma, [
          pedido.nombre || "Cliente",
          pedido.factura,
        ]);
        console.log(`📦 Aviso "${pedido.estado}" enviado (factura ${pedido.factura})`);
      } catch (err) {
        console.error(`No se pudo enviar el aviso de pedido (factura ${pedido.factura}):`, err);
        continue; // no se registra: se reintenta en el próximo chequeo
      }
      await guardarEstadoPedido(pedido.factura, pedido.estado);
    }
  } catch (err) {
    console.error("No se pudo chequear las notificaciones de pedidos:", err);
  }
}
