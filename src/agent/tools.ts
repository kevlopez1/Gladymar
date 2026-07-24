/**
 * Herramientas (tools) que el agente puede invocar.
 *
 * Definimos el esquema JSON que ve Claude y la implementación que las ejecuta.
 * El orden y contenido de estas definiciones debe ser ESTABLE para no invalidar
 * el prompt cache (las tools se renderizan antes del system prompt).
 */
import type Anthropic from "@anthropic-ai/sdk";
import { buscarCategorias, formatearCategoria } from "../knowledge/productos.js";
import { buscarCatalogo, formatearProductoCat } from "../knowledge/catalogo.js";
import {
  sucursalesPorCiudad,
  formatearSucursal,
  ciudadesConSucursal,
} from "../knowledge/sucursales.js";
import { menuPrincipal, submenu } from "../knowledge/menu.js";
import { infoTema, temasDisponibles } from "../knowledge/temas.js";
import { AREAS } from "../knowledge/contactos.js";
import { recordSolicitud } from "../admin/data.js";
import { construirCotizacion, bs, type Cotizacion } from "./cotizacion.js";
import { buscarPedidoPorFactura, formatearEstadoPedido } from "../integrations/despacho.js";

const TIPOS_SOLICITUD = [
  "contactar_asesor",
  "cotizacion",
  "seguimiento_pedido",
  "reclamo",
  "visita_tecnica",
  "alerta",
  "compras_servicios",
  "distribuidor",
  "otro",
] as const;

const PRIORIDADES = ["normal", "alta", "critica"] as const;

export const TOOLS: Anthropic.Tool[] = [
  {
    name: "mostrar_menu",
    description:
      "Muestra el menú de atención de Gladymar. Sin argumentos muestra el menú principal (1. Diseñar mi espacio, 2. Cotizar productos, 3. Seguimiento de pedidos, 4. Soporte y reclamos). Con 'seccion' muestra el submenú de esa sección. Úsala cuando el cliente saluda, pide opciones, o no sabe qué necesita.",
    input_schema: {
      type: "object",
      properties: {
        seccion: {
          type: "string",
          description: "Número de sección a expandir: '1', '2', '3' o '4'. Vacío para el menú principal.",
        },
      },
      required: [],
    },
  },
  {
    name: "buscar_productos",
    description:
      "Busca y SUGIERE productos reales del catálogo de Gladymar según el contexto. Pasa términos concretos (ej. 'porcelanato 60x60 gris', 'piso exterior', 'efecto madera 20x120', 'grifería cocina', 'inodoro'). Devuelve productos específicos del catálogo para sugerir el ideal. Sin consulta, devuelve las categorías.",
    input_schema: {
      type: "object",
      properties: {
        consulta: {
          type: "string",
          description: "Lo que busca el cliente: producto, ambiente, uso (interior/exterior), formato, color o efecto. Vacío para listar categorías.",
        },
      },
      required: [],
    },
  },
  {
    name: "buscar_sucursales",
    description:
      "Devuelve las sucursales de Gladymar con dirección, teléfono, WhatsApp y horario. Úsala para ubicaciones, teléfonos y horarios (sección 4). Filtra por ciudad si se indica.",
    input_schema: {
      type: "object",
      properties: {
        ciudad: {
          type: "string",
          description: `Ciudad para filtrar. Disponibles: ${ciudadesConSucursal().join(", ")}. Vacío para todas.`,
        },
      },
      required: [],
    },
  },
  {
    name: "info_tema",
    description:
      "Devuelve contenido informativo o enlaces sobre un tema del menú: Roomvo (visualizador), catálogo, diferencias entre cerámica y porcelanato, tipo de pegamento recomendado, manual de asentamiento y soluciones a problemas frecuentes.",
    input_schema: {
      type: "object",
      properties: {
        tema: {
          type: "string",
          enum: temasDisponibles(),
          description:
            "Tema: roomvo, catalogo, diferencias_ceramica_porcelanato, pegamento_recomendado, manual_asentamiento, soluciones_frecuentes.",
        },
      },
      required: ["tema"],
    },
  },
  {
    name: "registrar_solicitud",
    description:
      "Registra y deriva una solicitud que requiere a una persona/área: contactar asesor, cotización, seguimiento de pedido, reclamo, agendar visita técnica, alerta (amenaza viral / cliente muy alterado / mystery shopper), compras y servicios, o ser distribuidor. Toma los datos del cliente y devuelve la guía de derivación. Úsala cuando el caso no se resuelve solo con información.",
    input_schema: {
      type: "object",
      properties: {
        tipo: {
          type: "string",
          enum: [...TIPOS_SOLICITUD],
          description: "Tipo de solicitud a registrar/derivar.",
        },
        prioridad: {
          type: "string",
          enum: [...PRIORIDADES],
          description:
            "Prioridad. 'alta' para leads premium (>1000 m², construcción nueva, arquitecto, proyecto grande, producto importado) o cliente alterado; 'critica' para reclamos graves o amenaza de difusión viral. Por defecto 'normal'.",
        },
        ciudad: { type: "string", description: "Ciudad del cliente (si se conoce), para derivar a la sucursal correcta." },
        nombre: { type: "string", description: "Nombre del cliente, si lo proporcionó." },
        telefono: { type: "string", description: "Teléfono SOLO si el cliente lo ofrece. NO lo pidas: el cliente ya escribe desde su WhatsApp." },
        detalle: {
          type: "string",
          description:
            "Resumen del caso con todos los datos reunidos (ej. para cotización: producto, formato, uso, m², presupuesto, zona, showroom; para reclamo: factura, producto, fecha, descripción).",
        },
      },
      required: ["tipo", "detalle"],
    },
  },
  {
    name: "consultar_pedido",
    description:
      "Consulta el estado REAL de un pedido ya realizado (si salió del almacén, fue despachado o entregado) buscando por número de FACTURA en el sistema de logística de Gladymar. Úsala SOLO cuando el cliente pregunte por el seguimiento/trazabilidad de un pedido que YA hizo (no para cotizaciones nuevas). Si todavía no dio el número de factura, PEDÍSELO primero: no llames esta herramienta sin ese dato.",
    input_schema: {
      type: "object",
      properties: {
        factura: {
          type: "string",
          description: "Número de factura que dio el cliente, tal como lo escribió.",
        },
      },
      required: ["factura"],
    },
  },
  {
    name: "generar_cotizacion",
    description:
      "Genera una COTIZACIÓN en documento PDF (con el logo de Gladymar) y se la envía al cliente. Úsala SOLO cuando el cliente ya definió qué productos quiere y las cantidades (m² o unidades). Los precios son REFERENCIALES/estimados: aclaráselo al cliente y que un asesor confirma el precio final. Pasá el nombre del cliente y la lista de ítems.",
    input_schema: {
      type: "object",
      properties: {
        nombre: { type: "string", description: "Nombre del cliente." },
        ciudad: { type: "string", description: "Ciudad del cliente, si se conoce." },
        items: {
          type: "array",
          description: "Productos a cotizar.",
          items: {
            type: "object",
            properties: {
              producto: { type: "string", description: "Descripción del producto (ej. 'Porcelanato Algarrobo 20x120')." },
              cantidad: { type: "number", description: "Cantidad (m² o unidades)." },
              unidad: { type: "string", description: "Unidad: 'm²' o 'unidad'. Opcional." },
            },
            required: ["producto", "cantidad"],
          },
        },
      },
      required: ["items"],
    },
  },
];

/** Resultado de ejecutar una herramienta: texto que vuelve a Claude. */
export interface ToolExecution {
  content: string;
  /** Marca para que la capa de WhatsApp/registro sepa que hubo una derivación. */
  escalated?: boolean;
  /** El cliente pidió el Manual de Asentamiento: la capa de WhatsApp adjuntará el PDF si hay enlace. */
  attachManual?: boolean;
  /** Datos de la solicitud registrada (para el log en Google Sheets). */
  solicitud?: {
    tipo: string;
    prioridad: string;
    detalle: string;
    nombre?: string;
    ciudad?: string;
    telefono?: string;
  };
  /** Cotización generada en este turno (la capa de WhatsApp genera el PDF y lo envía). */
  cotizacion?: Cotizacion;
  /** Bloque EXACTO de sucursales (datos oficiales). La capa de WhatsApp lo envía
   *  verbatim; el modelo NO debe reescribir direcciones/teléfonos de memoria. */
  sucursales?: string;
}

/**
 * Ejecuta una herramienta por nombre con los argumentos provistos por Claude.
 */
export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  telefonoCliente?: string,
  prueba?: boolean,
): Promise<ToolExecution> {
  switch (name) {
    case "mostrar_menu": {
      const seccion = typeof input.seccion === "string" ? input.seccion.trim() : "";
      return { content: seccion ? submenu(seccion) : menuPrincipal() };
    }

    case "buscar_productos": {
      const consulta = typeof input.consulta === "string" ? input.consulta.trim() : "";
      // Con una consulta concreta, sugiere productos REALES del catálogo.
      if (consulta) {
        const productos = buscarCatalogo(consulta, 6);
        if (productos.length) {
          return {
            content:
              "Algunas opciones de nuestro catálogo:\n\n" +
              productos.map(formatearProductoCat).join("\n") +
              "\n\n_El precio y la disponibilidad te los confirma un asesor._",
          };
        }
      }
      // Sin resultados o sin consulta: muestra las categorías.
      return { content: buscarCategorias(consulta || undefined).map(formatearCategoria).join("\n\n") };
    }

    case "buscar_sucursales": {
      const ciudad = typeof input.ciudad === "string" ? input.ciudad : undefined;
      const lista = sucursalesPorCiudad(ciudad).map(formatearSucursal).join("\n\n");
      const bloque = `${lista}\n\n_Los enlaces de ubicación (GPS) están disponibles en gladymar.com.bo_`;
      // El bloque `sucursales` se envía VERBATIM al cliente desde la capa de WhatsApp.
      // Al modelo le pedimos que NO reescriba ni un dato: los inventaría.
      return {
        content:
          "Estos son los datos OFICIALES de las sucursales y YA se le enviaron al cliente, tal cual. " +
          "NO los reescribas, NO los resumas y NO agregues ni cambies ninguna dirección, teléfono, WhatsApp u horario. " +
          "Solo respondé con UNA frase breve y cálida de introducción o cierre (sin datos de contacto). Datos enviados:\n\n" +
          bloque,
        sucursales: bloque,
      };
    }

    case "info_tema": {
      const tema = typeof input.tema === "string" ? input.tema : "";
      return { content: infoTema(tema), attachManual: tema === "manual_asentamiento" };
    }

    case "registrar_solicitud":
      return registrarSolicitud(input, telefonoCliente, prueba);

    case "consultar_pedido": {
      const factura = typeof input.factura === "string" ? input.factura.trim() : "";
      if (!factura) {
        return { content: "No se recibió un número de factura. Pedile al cliente su número de factura para poder consultar el estado del pedido." };
      }
      const pedido = await buscarPedidoPorFactura(factura);
      if (!pedido) {
        return {
          content:
            `No encontré la factura "${factura}" en el sistema de despacho (puede ser muy reciente, estar mal escrita, o el sistema puede no estar disponible ahora mismo). ` +
            "Pedile amablemente que confirme el número. Si insiste en que es correcto y no aparece, derivalo a un asesor con registrar_solicitud (tipo 'seguimiento_pedido').",
        };
      }
      return { content: formatearEstadoPedido(pedido) };
    }

    case "generar_cotizacion": {
      const nombre = typeof input.nombre === "string" && input.nombre.trim() ? input.nombre.trim() : "Cliente";
      const ciudad = typeof input.ciudad === "string" ? input.ciudad : undefined;
      const raw = Array.isArray(input.items) ? input.items : [];
      const items = raw
        .map((x) => {
          const o = (x ?? {}) as Record<string, unknown>;
          return {
            producto: String(o.producto ?? "").trim(),
            cantidad: Number(o.cantidad) || 1,
            unidad: typeof o.unidad === "string" ? o.unidad : undefined,
          };
        })
        .filter((i) => i.producto);
      if (!items.length) {
        return { content: "No hay ítems para cotizar. Pídele al cliente qué productos y cantidades desea." };
      }
      const cot = construirCotizacion(nombre, ciudad, items);
      const resumen = cot.items.map((i) => `• ${i.descripcion}: ${i.cantidad} ${i.unidad} × ${bs(i.precioUnit)} = ${bs(i.subtotal)}`).join("\n");
      console.log(`🧾 Cotización ${cot.numero} para ${nombre} — Total ${bs(cot.total)}`);
      return {
        content:
          `Cotización *${cot.numero}* generada. Se le está enviando el PDF al cliente.\n${resumen}\nTOTAL: ${bs(cot.total)}\n\n` +
          "Al responder, confirmá que le enviaste la cotización y aclarale que los precios son *referenciales* y que un asesor confirma el precio y la disponibilidad final.",
        cotizacion: cot,
      };
    }

    default:
      return { content: `Error: herramienta desconocida "${name}".` };
  }
}

function registrarSolicitud(input: Record<string, unknown>, telefonoCliente?: string, prueba?: boolean): ToolExecution {
  const tipo = typeof input.tipo === "string" ? input.tipo : "otro";
  const prioridad = typeof input.prioridad === "string" ? input.prioridad : "normal";
  const ciudad = typeof input.ciudad === "string" ? input.ciudad : undefined;
  const detalle = typeof input.detalle === "string" ? input.detalle : "consulta general";
  const nombre = typeof input.nombre === "string" ? input.nombre : undefined;
  // El teléfono del cliente es el del WhatsApp desde el que escribe (telefonoCliente);
  // si además lo mencionó en el chat, igual priorizamos el real del WhatsApp.
  const telefono = telefonoCliente || (typeof input.telefono === "string" ? input.telefono : undefined);

  const marca = prioridad === "critica" ? "🔴 CRÍTICA" : prioridad === "alta" ? "🟠 ALTA" : "";
  console.log(`📝 Solicitud [${tipo}] ${marca} ${ciudad ? `(${ciudad}) ` : ""}${nombre ? `de ${nombre} ` : ""}- ${detalle}`);

  // Guarda la solicitud para que el panel de administradores la vea.
  // En modo prueba ("Probar como cliente") NUNCA se guarda: es una demo, no
  // debe aparecer como lead real ni contaminar el panel de administradores.
  if (!prueba) {
    recordSolicitud({ tipo, prioridad, nombre, ciudad, telefono, detalle });
  }

  const contactoSucursal = (): string => {
    const conWa = sucursalesPorCiudad(ciudad).filter((s) => s.whatsapp);
    const s = conWa[0];
    if (!s) return "Sugiere acercarse a la sucursal más cercana o visitar gladymar.com.bo.";
    return (
      `Conecta al cliente con un asesor de la sucursal *${s.ciudad} – ${s.nombre}*` +
      (s.whatsapp ? ` (WhatsApp ${s.whatsapp}` : "") +
      (s.telefono ? `, tel. ${s.telefono})` : s.whatsapp ? ")" : "") +
      "."
    );
  };

  // Para áreas administrativas usamos los datos de contactos.ts (pueden estar "por confirmar").
  const areaAdmin = (id: string): string => {
    const area = AREAS[id];
    const base = area ? area.contacto : "No tengo el contacto de esta área.";
    return `Solicitud registrada (${detalle}). ${base}`;
  };

  let content: string;
  switch (tipo) {
    case "cotizacion":
      // La cotización se entrega con `generar_cotizacion` (PDF). Este registro es
      // SOLO seguimiento interno silencioso: no le digas al cliente "te conecto
      // con un asesor" en lugar de darle su cotización.
      content =
        `Lead de cotización registrado en segundo plano (${detalle}). ` +
        "El cliente ya recibe su cotización en PDF con precios referenciales. " +
        "Respondé sobre SU cotización (no lo derives): aclarале que los precios son referenciales y que un asesor confirma el precio y la disponibilidad final.";
      break;
    case "contactar_asesor":
    case "seguimiento_pedido":
      content = `Solicitud registrada (${detalle}). ` + contactoSucursal();
      break;
    case "reclamo": {
      const suc = sucursalesPorCiudad(ciudad).filter((s) => s.whatsapp)[0];
      const sucName = suc ? `${suc.ciudad} – ${suc.nombre}` : "la sucursal más cercana";
      content =
        `Reclamo PRIORITARIO registrado (${detalle}). Enrutado a *${sucName}*. ` +
        "Con empatía, dile al cliente que su caso es PRIORITARIO y que en las próximas horas un asesor de su ciudad lo contactará por este mismo WhatsApp para resolverlo. " +
        "NO le pidas su número (ya escribe desde aquí) ni le sugieras pasar por tienda o llamar él mismo.";
      break;
    }
    case "visita_tecnica":
      content =
        `Solicitud de visita técnica registrada (${detalle}). ` +
        "Confirma datos de contacto y dirección para coordinar la visita; un asesor/técnico se pondrá en contacto. " +
        contactoSucursal();
      break;
    case "alerta":
      content =
        `Alerta registrada (${detalle}). Mantén la calma, sé empática y resolutiva, y deriva de inmediato a un responsable. ` +
        contactoSucursal();
      break;
    case "compras_servicios":
      content = areaAdmin("compras_servicios");
      break;
    case "distribuidor":
      content = areaAdmin("distribuidores");
      break;
    default:
      content = `Solicitud registrada (${detalle}). ` + contactoSucursal();
  }

  return {
    content,
    escalated: true,
    solicitud: { tipo, prioridad, detalle, nombre, ciudad, telefono },
  };
}
