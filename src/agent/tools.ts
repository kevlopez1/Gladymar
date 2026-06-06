/**
 * Herramientas (tools) que el agente puede invocar.
 *
 * Definimos el esquema JSON que ve Claude y la implementación que las ejecuta.
 * El orden y contenido de estas definiciones debe ser ESTABLE para no invalidar
 * el prompt cache (las tools se renderizan antes del system prompt).
 */
import type Anthropic from "@anthropic-ai/sdk";
import { buscarCategorias, formatearCategoria } from "../knowledge/productos.js";
import {
  sucursalesPorCiudad,
  formatearSucursal,
  ciudadesConSucursal,
} from "../knowledge/sucursales.js";
import { menuPrincipal, submenu } from "../knowledge/menu.js";
import { infoTema, temasDisponibles } from "../knowledge/temas.js";
import { AREAS } from "../knowledge/contactos.js";

const TIPOS_SOLICITUD = [
  "contactar_asesor",
  "cotizacion",
  "seguimiento_pedido",
  "reclamo",
  "visita_tecnica",
  "compras_servicios",
  "distribuidor",
  "otro",
] as const;

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
      "Busca categorías de productos de Gladymar por palabra clave (ej. 'porcelanato', 'piso', 'baño', 'pegamento'). Devuelve descripción, formatos, marcas y precio referencial. Úsala para catálogo y asesoramiento de productos.",
    input_schema: {
      type: "object",
      properties: {
        consulta: {
          type: "string",
          description: "Palabra clave o tema del producto. Vacío para listar todas las categorías.",
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
      "Registra y deriva una solicitud que requiere a una persona/área: contactar asesor, cotización, seguimiento de pedidos, reclamo, agendar visita técnica, RR.HH./CV, compras y servicios, o ser distribuidor. Toma los datos del cliente y devuelve la guía de derivación. Úsala cuando el caso no se resuelve solo con información.",
    input_schema: {
      type: "object",
      properties: {
        tipo: {
          type: "string",
          enum: [...TIPOS_SOLICITUD],
          description: "Tipo de solicitud a registrar/derivar.",
        },
        ciudad: { type: "string", description: "Ciudad del cliente (si se conoce), para sugerir la sucursal más conveniente." },
        nombre: { type: "string", description: "Nombre del cliente, si lo proporcionó." },
        telefono: { type: "string", description: "Teléfono/WhatsApp de contacto, si lo proporcionó." },
        detalle: { type: "string", description: "Resumen del caso (ej. 'reclamo: piso suena hueco', 'cotización porcelanato 60x60', 'visita técnica en Equipetrol')." },
      },
      required: ["tipo", "detalle"],
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
  solicitud?: { tipo: string; detalle: string; nombre?: string; ciudad?: string; telefono?: string };
}

/**
 * Ejecuta una herramienta por nombre con los argumentos provistos por Claude.
 */
export function executeTool(name: string, input: Record<string, unknown>): ToolExecution {
  switch (name) {
    case "mostrar_menu": {
      const seccion = typeof input.seccion === "string" ? input.seccion.trim() : "";
      return { content: seccion ? submenu(seccion) : menuPrincipal() };
    }

    case "buscar_productos": {
      const consulta = typeof input.consulta === "string" ? input.consulta : undefined;
      return { content: buscarCategorias(consulta).map(formatearCategoria).join("\n\n") };
    }

    case "buscar_sucursales": {
      const ciudad = typeof input.ciudad === "string" ? input.ciudad : undefined;
      const lista = sucursalesPorCiudad(ciudad).map(formatearSucursal).join("\n\n");
      return {
        content: `${lista}\n\n_Los enlaces de ubicación (GPS) están disponibles en gladymar.com.bo_`,
      };
    }

    case "info_tema": {
      const tema = typeof input.tema === "string" ? input.tema : "";
      return { content: infoTema(tema), attachManual: tema === "manual_asentamiento" };
    }

    case "registrar_solicitud":
      return registrarSolicitud(input);

    default:
      return { content: `Error: herramienta desconocida "${name}".` };
  }
}

function registrarSolicitud(input: Record<string, unknown>): ToolExecution {
  const tipo = typeof input.tipo === "string" ? input.tipo : "otro";
  const ciudad = typeof input.ciudad === "string" ? input.ciudad : undefined;
  const detalle = typeof input.detalle === "string" ? input.detalle : "consulta general";
  const nombre = typeof input.nombre === "string" ? input.nombre : undefined;
  const telefono = typeof input.telefono === "string" ? input.telefono : undefined;

  console.log(`📝 Solicitud [${tipo}] ${ciudad ? `(${ciudad}) ` : ""}${nombre ? `de ${nombre} ` : ""}- ${detalle}`);

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
    case "contactar_asesor":
    case "cotizacion":
    case "seguimiento_pedido":
      content =
        `Solicitud registrada (${detalle}). ` +
        (tipo === "cotizacion" ? "Recuerda: la cotización la realiza un asesor, no este canal. " : "") +
        contactoSucursal();
      break;
    case "reclamo":
      content =
        `Reclamo registrado (${detalle}). Discúlpate por el inconveniente y confirma que un responsable dará seguimiento. ` +
        "Si aplica, ofrece agendar una visita técnica. " +
        contactoSucursal();
      break;
    case "visita_tecnica":
      content =
        `Solicitud de visita técnica registrada (${detalle}). ` +
        "Confirma datos de contacto y dirección para coordinar la visita; un asesor/técnico se pondrá en contacto. " +
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
    solicitud: { tipo, detalle, nombre, ciudad, telefono },
  };
}
