/**
 * Notificaciones automáticas de estado de pedido (plantillas de WhatsApp).
 *
 * Revisa periódicamente la pestaña "DESPACHOS" del Excel de control de
 * despacho (pedidos activos, con teléfono cargado por logística) y, cuando
 * una factura cambia de estado a "Preparado" o "Despachado", le manda al
 * cliente la plantilla de Meta correspondiente con su nombre y N° de
 * factura — sin que el cliente tenga que preguntar.
 *
 * No mira la "BASE DE DATOS" histórica (pedidos ya cerrados de meses
 * anteriores, sin teléfono cargado): solo los pedidos en curso.
 */
import type ExcelJS from "exceljs";
import { config, isWhatsAppConfigured } from "../config.js";
import { cargarLibroDespacho, detectarEncabezado, celda } from "./despacho.js";
import { sendTemplate } from "../whatsapp/client.js";
import { obtenerEstadoPedido, guardarEstadoPedido } from "../db/index.js";

/** Estados que disparan un aviso; el valor es el nombre de la plantilla a usar. */
function templateDeEstado(estado: string): string | null {
  if (estado === "preparado") return config.despacho.templatePreparado;
  if (estado === "despachado") return config.despacho.templateDespachado;
  return null; // "Entregado" u otros: no se avisa (el cliente ya lo recibió).
}

function telefonoInternacional(numero: string): string {
  const limpio = numero.replace(/\D/g, "");
  return limpio.startsWith("591") ? limpio : `591${limpio}`;
}

interface PedidoActual {
  factura: string;
  nombre: string;
  telefono: string;
  estado: string;
}

function leerPedidosActuales(wb: ExcelJS.Workbook): PedidoActual[] {
  const ws = wb.getWorksheet("DESPACHOS");
  if (!ws) return [];
  const enc = detectarEncabezado(ws);
  if (!enc) return [];

  // Una factura puede tener varias líneas (una por producto); nos alcanza
  // con el estado/teléfono/nombre de la primera, son iguales en todas.
  const porFactura = new Map<string, PedidoActual>();
  for (let r = enc.fila + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const factura = celda(row, enc.indice["FACTURA"]);
    if (!factura || porFactura.has(factura)) continue;
    const telefono = celda(row, enc.indice["TELEFONO DEL CLIENTE"]).replace(/\D/g, "");
    const estado = celda(row, enc.indice["ESTADO"]).trim().toLowerCase();
    if (!telefono || !estado) continue;
    porFactura.set(factura, { factura, nombre: celda(row, enc.indice["NOMBRE DEL CLIENTE"]), telefono, estado });
  }
  return [...porFactura.values()];
}

/**
 * Revisa la hoja y manda las notificaciones de los pedidos que cambiaron de
 * estado desde el último chequeo. Nunca lanza.
 */
export async function chequearNotificacionesPedidos(): Promise<void> {
  if (!isWhatsAppConfigured()) return;
  try {
    const wb = await cargarLibroDespacho();
    if (!wb) return;

    for (const pedido of leerPedidosActuales(wb)) {
      const template = templateDeEstado(pedido.estado);
      if (!template) continue;

      const anterior = await obtenerEstadoPedido(pedido.factura);
      if (anterior === pedido.estado) continue; // ya se avisó este estado

      try {
        await sendTemplate(telefonoInternacional(pedido.telefono), template, config.despacho.templateIdioma, [
          pedido.nombre || "Cliente",
          pedido.factura,
        ]);
        console.log(`📦 Aviso "${pedido.estado}" enviado a ${pedido.telefono} (factura ${pedido.factura})`);
      } catch (err) {
        console.error(`No se pudo enviar el aviso de pedido (factura ${pedido.factura}):`, err);
        continue; // no guardamos el estado: se reintenta en el próximo chequeo
      }
      await guardarEstadoPedido(pedido.factura, pedido.estado);
    }
  } catch (err) {
    console.error("No se pudo chequear las notificaciones de pedidos:", err);
  }
}
