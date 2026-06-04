/**
 * Contenidos informativos para el menú (respuestas "enlatadas" y enlaces).
 *
 * ⚠️ Los temas con `confirmado: false` requieren recursos que Gladymar debe
 * proporcionar (enlace de Roomvo, PDF del manual de asentamiento, lista oficial
 * de soluciones frecuentes). Mientras tanto el agente será transparente y no
 * inventará enlaces ni datos. Completa el contenido y pon `confirmado: true`.
 */

export interface Tema {
  id: string;
  titulo: string;
  contenido: string;
  confirmado: boolean;
}

export const TEMAS: Record<string, Tema> = {
  roomvo: {
    id: "roomvo",
    titulo: "Roomvo – Simulador de ambientes",
    contenido:
      "Estamos preparando *Roomvo*, nuestro simulador para ver cómo lucen nuestros productos en su propio espacio (sube una foto y prueba pisos y revestimientos).\n" +
      "Aún está en implementación; muy pronto estará disponible en https://gladymar.com.bo.\n" +
      "⚠️ POR CONFIRMAR: enlace definitivo del simulador. Mientras tanto, ofrece acompañar al cliente con un asesor para visualizar opciones de su proyecto.",
    confirmado: false,
  },

  catalogo: {
    id: "catalogo",
    titulo: "Catálogo de productos",
    contenido:
      "Puede ver nuestros catálogos y portafolio aquí:\n" +
      "• Descargas/portafolio: https://gladymar.com.bo/portafolio/\n" +
      "• Productos: https://gladymar.com.bo",
    confirmado: true,
  },

  diferencias_ceramica_porcelanato: {
    id: "diferencias_ceramica_porcelanato",
    titulo: "Diferencias entre cerámica y porcelanato",
    contenido:
      "*Porcelanato*\n" +
      "• Muy baja absorción de agua (≈0,5% o menos) → más resistente a manchas y humedad.\n" +
      "• Más duro y resistente al desgaste: ideal para *alto tránsito* y exteriores.\n" +
      "• Disponible en formatos grandes (hasta 90x90 cm).\n" +
      "• Mayor costo.\n\n" +
      "*Cerámica*\n" +
      "• Mayor absorción y algo menos resistente.\n" +
      "• Ideal para *paredes* y ambientes de tránsito bajo/medio.\n" +
      "• Más liviana, fácil de cortar y más económica.\n\n" +
      "◆ En resumen: para pisos de mucho uso o exteriores, *porcelanato*; para paredes o presupuestos ajustados, *cerámica*. Un asesor puede recomendarle el producto exacto según su proyecto.",
    confirmado: true,
  },

  pegamento_recomendado: {
    id: "pegamento_recomendado",
    titulo: "Tipo de pegamento recomendado",
    contenido:
      "La elección del pegamento (adhesivo) depende del material y la superficie:\n" +
      "• *Porcelanato y gran formato*: adhesivo de *alto desempeño* (mayor adherencia).\n" +
      "• *Pisos exteriores o zonas húmedas*: adhesivo de alto desempeño / flexible.\n" +
      "• *Cerámica en paredes/interiores*: adhesivo estándar suele ser suficiente.\n\n" +
      "Recomendaciones generales: prepare bien la superficie (nivelada y limpia), use llana dentada del tamaño adecuado y respete los tiempos de fragüe.\n" +
      "◆ Gladymar cuenta con adhesivos y complementos. Para el producto y rendimiento exactos según su m² y formato, confírmelo con un asesor en sucursal.",
    confirmado: true,
  },

  manual_asentamiento: {
    id: "manual_asentamiento",
    titulo: "Manual de asentamiento (Tríptico de colocación)",
    contenido:
      "Contamos con el *Tríptico de Colocación* (manual de asentamiento) que explica cómo colocar correctamente pisos y revestimientos.\n" +
      "⚠️ POR CONFIRMAR: enlace/PDF para compartir por WhatsApp (archivo oficial: TRIPTICO COLOCADO.pdf). Mientras se carga, ofrece que un asesor se lo facilite.",
    confirmado: false,
  },

  soluciones_frecuentes: {
    id: "soluciones_frecuentes",
    titulo: "Soluciones a problemas frecuentes",
    contenido:
      "Algunos casos comunes (orientativo):\n" +
      "• *Suena hueco al pisar*: suele indicar falta de pegamento o mala colocación; puede requerir relevamiento.\n" +
      "• *Diferencia de tono entre piezas*: revise que sean del mismo lote/calibre.\n" +
      "• *Manchas en el fragüe (junta)*: limpieza con productos adecuados; evitar ácidos fuertes.\n" +
      "• *Piezas rayadas o fisuradas tras la obra*: revisar manipulación y proceso de colocación.\n\n" +
      "⚠️ POR CONFIRMAR: lista oficial de soluciones de Gladymar. Para un caso puntual, lo mejor es registrar el reclamo o agendar una *visita técnica*.",
    confirmado: false,
  },
};

/** IDs de temas disponibles (para el esquema de la herramienta). */
export function temasDisponibles(): string[] {
  return Object.keys(TEMAS);
}

/** Devuelve el contenido de un tema. */
export function infoTema(id: string): string {
  const tema = TEMAS[id];
  if (!tema) {
    return `No reconozco el tema "${id}". Temas disponibles: ${temasDisponibles().join(", ")}.`;
  }
  const aviso = tema.confirmado ? "" : "\n[Dato no confirmado: sé transparente, no inventes enlaces ni datos.]";
  return `${tema.titulo}\n${tema.contenido}${aviso}`;
}
