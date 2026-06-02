/**
 * Herramientas (tools) que el agente puede invocar.
 *
 * Definimos el esquema JSON que ve Claude y la implementación que las ejecuta.
 * El orden y contenido de estas definiciones debe ser ESTABLE para no invalidar
 * el prompt cache (las tools se renderizan antes del system prompt).
 */
import type Anthropic from "@anthropic-ai/sdk";
import {
  buscarCategorias,
  formatearCategoria,
} from "../knowledge/productos.js";
import {
  sucursalesPorCiudad,
  formatearSucursal,
  ciudadesConSucursal,
} from "../knowledge/sucursales.js";

export const TOOLS: Anthropic.Tool[] = [
  {
    name: "buscar_productos",
    description:
      "Busca categorías de productos de Gladymar por palabra clave o tema (ej. 'porcelanato', 'piso', 'baño', 'grifería', 'pegamento'). Devuelve descripción, formatos, marcas y precio referencial. Usa esta herramienta antes de hablar de productos en concreto.",
    input_schema: {
      type: "object",
      properties: {
        consulta: {
          type: "string",
          description:
            "Palabra clave o tema del producto que busca el cliente. Déjalo vacío para listar todas las categorías.",
        },
      },
      required: [],
    },
  },
  {
    name: "buscar_sucursales",
    description:
      "Devuelve las sucursales de Gladymar con dirección, teléfono, WhatsApp y horario. Filtra por ciudad si se indica. Usa esta herramienta siempre que el cliente pida ubicaciones, horarios o números de contacto.",
    input_schema: {
      type: "object",
      properties: {
        ciudad: {
          type: "string",
          description: `Ciudad para filtrar. Ciudades disponibles: ${ciudadesConSucursal().join(", ")}. Déjalo vacío para listar todas.`,
        },
      },
      required: [],
    },
  },
  {
    name: "escalar_a_humano",
    description:
      "Deriva la conversación a un asesor humano de Gladymar. Úsala cuando el cliente quiere comprar/cotizar formalmente, hacer un reclamo, pide hablar con una persona, o cuando no puedes resolver su consulta. Si conoces la ciudad del cliente, pásala para sugerir la sucursal más cercana.",
    input_schema: {
      type: "object",
      properties: {
        ciudad: {
          type: "string",
          description: "Ciudad del cliente, si se conoce, para sugerir la sucursal más conveniente.",
        },
        motivo: {
          type: "string",
          description: "Resumen breve del motivo de la derivación (ej. 'cotización de porcelanato 60x60').",
        },
      },
      required: ["motivo"],
    },
  },
];

/** Resultado de ejecutar una herramienta: texto que vuelve a Claude. */
export interface ToolExecution {
  content: string;
  /** Marca para que la capa de WhatsApp sepa que hubo una derivación. */
  escalated?: boolean;
}

/**
 * Ejecuta una herramienta por nombre con los argumentos provistos por Claude.
 */
export function executeTool(name: string, input: Record<string, unknown>): ToolExecution {
  switch (name) {
    case "buscar_productos": {
      const consulta = typeof input.consulta === "string" ? input.consulta : undefined;
      const categorias = buscarCategorias(consulta);
      return { content: categorias.map(formatearCategoria).join("\n\n") };
    }

    case "buscar_sucursales": {
      const ciudad = typeof input.ciudad === "string" ? input.ciudad : undefined;
      const sucursales = sucursalesPorCiudad(ciudad);
      return { content: sucursales.map(formatearSucursal).join("\n\n") };
    }

    case "escalar_a_humano": {
      const ciudad = typeof input.ciudad === "string" ? input.ciudad : undefined;
      const motivo = typeof input.motivo === "string" ? input.motivo : "consulta general";
      const sucursales = sucursalesPorCiudad(ciudad).filter((s) => s.whatsapp);
      const contacto = sucursales[0];
      const lineas = [
        `Derivación registrada (motivo: ${motivo}).`,
        contacto
          ? `Sugiere al cliente escribir a un asesor de la sucursal *${contacto.ciudad} – ${contacto.nombre}*` +
            (contacto.whatsapp ? ` por WhatsApp al ${contacto.whatsapp}` : "") +
            (contacto.telefono ? ` o al teléfono ${contacto.telefono}` : "") +
            "."
          : "Sugiere al cliente acercarse a la sucursal más cercana o visitar gladymar.com.bo.",
        "Confirma al cliente que un asesor podrá darle precios vigentes, stock y cotización formal.",
      ];
      return { content: lineas.join(" "), escalated: true };
    }

    default:
      return { content: `Error: herramienta desconocida "${name}".` };
  }
}
