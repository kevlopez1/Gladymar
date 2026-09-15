/**
 * Productor de la foto de pedidos para el módulo de logística del CRM.
 *
 * Cada ciclo el bot ya descarga y parsea la hoja de despacho entera para decidir
 * qué avisos mandar. Esa misma lectura se manda acá completa, no solo lo que
 * cambió: con solo las transiciones el módulo nacería vacío y un pedido que ya
 * estaba Despachado antes de encender esto no aparecería nunca, mostrando una
 * parte de la operación con cara de mostrarla entera.
 *
 * LO QUE ESTA FOTO NO ES: la pestaña que leemos son los pedidos EN CURSO. Si
 * logística saca una factura de la hoja al terminarla, esa factura deja de
 * venir. La foto es completa de lo que está en la hoja, no de la historia; el
 * CRM acumula y marca las que dejan de aparecer.
 */
import { config } from "../config.js";
import type { PedidoActual } from "./pedidoEstados.js";

/** Tope por llamada que admite el endpoint. */
const LOTE = 2000;

interface PedidoIngest {
  factura: string;
  cliente?: string;
  telefono?: string;
  estado: string;
  estados_mixtos: boolean;
  items?: { descripcion?: string; cantidad?: string; estado: string }[];
  extra?: Record<string, string>;
}

/** ¿Hay a quién mandarle la foto? Comparte credencial con la cola de avisos. */
export function pedidosCrmHabilitado(): boolean {
  return Boolean(config.colaAvisos.url && config.colaAvisos.token);
}

function telefonoInternacional(numero: string): string {
  const d = (numero || "").replace(/\D/g, "");
  if (!d) return "";
  return d.startsWith("591") ? d : `591${d}`;
}

function aIngest(p: PedidoActual): PedidoIngest {
  // Una factura puede tener varios contactos cargados. El contrato lleva uno
  // solo, así que va el primero y el resto queda en `extra`: perderlos en
  // silencio dejaría a la ficha con menos contactos de los que la hoja tiene.
  const telefonos = p.telefonos.map(telefonoInternacional).filter(Boolean);
  const extra = { ...p.extra };
  if (telefonos.length > 1) extra["TELEFONOS_ADICIONALES"] = telefonos.slice(1).join(", ");

  const item: PedidoIngest = {
    factura: p.factura,
    estado: p.estado,
    estados_mixtos: p.estadosMixtos,
  };
  if (p.nombre) item.cliente = p.nombre;
  if (telefonos[0]) item.telefono = telefonos[0];
  if (p.items.length) item.items = p.items;
  if (Object.keys(extra).length) item.extra = extra;
  return item;
}

/**
 * Manda la foto completa de la hoja al CRM. Nunca lanza.
 *
 * Un fallo acá NO puede frenar los avisos: que el panel de logística quede
 * desactualizado un ciclo es un problema; que el cliente no se entere de que su
 * pedido está listo es el problema que vinimos a resolver.
 */
export async function enviarFotoPedidos(pedidos: PedidoActual[]): Promise<void> {
  if (!pedidosCrmHabilitado()) return;
  // Una foto vacía no se manda. Del otro lado el barrido de ausentes solo corre
  // con al menos una fila, pero mandar cero igual sería afirmar que la hoja
  // está vacía cuando lo más probable es que la lectura haya fallado.
  if (!pedidos.length) {
    console.warn("📦 No mando la foto de pedidos al CRM: la lectura no devolvió ninguna factura.");
    return;
  }

  const url = `${config.colaAvisos.url.replace(/\/$/, "")}/api/pedidos/ingest`;
  for (let i = 0; i < pedidos.length; i += LOTE) {
    const tanda = pedidos.slice(i, i + LOTE);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.colaAvisos.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          tenant: config.colaAvisos.tenant,
          // Solo va true cuando la tanda es la hoja ENTERA. Si hubiera que
          // partirla, el barrido de ausentes del CRM borraría de vista todo lo
          // que quedó en las otras tandas.
          foto_completa: pedidos.length <= LOTE,
          pedidos: tanda.map(aIngest),
        }),
        signal: AbortSignal.timeout(30_000),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        console.error(`📦 /api/pedidos/ingest respondió HTTP ${res.status}:`, json);
        continue;
      }
      const rechazados = Array.isArray(json.rechazados) ? json.rechazados : [];
      console.log(
        `📦 Foto de pedidos enviada al CRM: ${json.recibidos ?? tanda.length} recibidos, ` +
          `${json.nuevos ?? "?"} nuevos, ${json.sin_ficha ?? "?"} sin ficha, ${json.ausentes ?? "?"} ausentes.`,
      );
      // Mismo criterio que con la cola: un lote puede volver 200 con rechazos
      // adentro. Sin mirarlos, esos pedidos no aparecen en el panel y no hay
      // ningún error que explique por qué.
      if (rechazados.length) {
        console.error(
          `📦 El CRM rechazó ${rechazados.length} pedido(s) de la foto: ` +
            `${JSON.stringify(rechazados.slice(0, 10))}`,
        );
      }
    } catch (err) {
      console.error("📦 No se pudo mandar la foto de pedidos al CRM:", err);
    }
  }
}
