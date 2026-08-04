/**
 * Contenidos informativos para el menú (respuestas "enlatadas" y enlaces).
 *
 * ⚠️ Los temas con `confirmado: false` requieren recursos que Gladymar debe
 * proporcionar (enlace de Roomvo, PDF del manual de asentamiento, lista oficial
 * de soluciones frecuentes). Mientras tanto el agente será transparente y no
 * inventará enlaces ni datos. Completa el contenido y pon `confirmado: true`.
 */
import { resumenColecciones } from "./dimensionViva.js";
import { config } from "../config.js";

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
      "Estamos preparando *Roomvo*, nuestro simulador para que veas cómo lucen nuestros productos en tu propio espacio (subís una foto y probás pisos y revestimientos). ✨\n" +
      "Estará disponible muy pronto en https://gladymar.com.bo. Mientras tanto, con gusto te conecto con un asesor o te invito a visitar nuestro showroom.",
    confirmado: false,
  },

  catalogo: {
    id: "catalogo",
    titulo: "Catálogo de productos",
    contenido:
      resumenColecciones() +
      "\n\nCada línea tiene su propio carácter, contame qué ambiente estás armando y te recomiendo la ideal. ✨\n" +
      (config.assets.catalogoUrl
        ? `Catálogo completo en PDF: ${config.assets.catalogoUrl}\n`
        : "") +
      "También podés explorar el portafolio completo en https://gladymar.com.bo/portafolio/",
    confirmado: true,
  },

  diferencias_ceramica_porcelanato: {
    id: "diferencias_ceramica_porcelanato",
    titulo: "Diferencias entre cerámica y porcelanato",
    contenido:
      "*Porcelanato*\n" +
      "• Muy baja absorción de agua (el Porcelanato by Gladymar tiene apenas *0,3%*, clasificado grupo *BIa*) → más resistente a manchas y humedad.\n" +
      "• Altísima resistencia: el porcelanato Gladymar soporta hasta *310 Kgf* sin estar asentado.\n" +
      "• Antibacterial e inerte, estructura vítrea y cero porosidad; no se altera con agua ni fuego.\n" +
      "• Ideal para *alto tránsito* y exteriores. Formatos hasta 90x90 cm. Mayor costo.\n\n" +
      "*Cerámica*\n" +
      "• Mayor absorción y algo menos resistente.\n" +
      "• Ideal para *paredes* y ambientes de tránsito bajo/medio.\n" +
      "• Más liviana, fácil de cortar y más económica.\n\n" +
      "En resumen: para pisos de mucho uso o exteriores, *porcelanato*; para paredes o presupuestos ajustados, *cerámica*. Un asesor puede recomendarte el producto exacto para tu proyecto.",
    confirmado: true,
  },

  pegamento_recomendado: {
    id: "pegamento_recomendado",
    titulo: "Tipo de pegamento recomendado",
    contenido:
      "Recomendaciones de colocado de Gladymar:\n" +
      "• Usá un *pegamento/adhesivo impermeable* para evitar desprendimientos por mala adherencia.\n" +
      "• Aplicalo con *llana dentada de 8 mm*.\n" +
      "• El contrapiso/carpeta debe estar *bien nivelado, resistente e impermeabilizado* (hidrofugado), para evitar eflorescencias (salitre).\n" +
      "• Antes de colocar, abrí *4 o más cajas* y tomá una pieza de cada una, para uniformar el tono.\n" +
      "• Respetá las juntas (de colocación, dilatación y unión).\n\n" +
      "Gladymar cuenta con adhesivos y complementos. Para el producto y rendimiento exactos según tus m² y formato, confirmalo con un asesor.",
    confirmado: true,
  },

  manual_asentamiento: {
    id: "manual_asentamiento",
    titulo: "Manual de asentamiento (Tríptico de colocación)",
    contenido:
      "Puntos clave para una colocación correcta (según Gladymar):\n" +
      "• Pegamento *impermeable* + *llana dentada de 8 mm*.\n" +
      "• Contrapiso nivelado, resistente e *impermeabilizado* (evita salitre/eflorescencias).\n" +
      "• Abrí *4+ cajas* y mezclá piezas para uniformar el tono.\n" +
      "• Respetá las juntas (colocación, dilatación y unión).\n\n" +
      "Contamos con el *Tríptico de Colocación* completo. Si querés, te lo compartimos; un asesor también puede facilitártelo.",
    confirmado: true,
  },

  soluciones_frecuentes: {
    id: "soluciones_frecuentes",
    titulo: "Soluciones a problemas frecuentes",
    contenido:
      "Casos comunes y su causa habitual:\n" +
      "• *Piezas que se desprenden*: suele ser pegamento no impermeable o superficie mal preparada. Usá adhesivo impermeable sobre un contrapiso firme.\n" +
      "• *Manchas blancas / salitre (eflorescencia)*: falta de impermeabilización del contrapiso o carpeta.\n" +
      "• *Diferencia de tono entre piezas*: colocá mezclando piezas de varias cajas (4+) y verificá lote/calibre.\n" +
      "• *Suena hueco al pisar*: falta de pegamento o mala colocación.\n\n" +
      "Para un caso puntual, lo mejor es registrar el reclamo o agendar una *visita técnica*.",
    confirmado: true,
  },
};

/** IDs de temas disponibles (para el esquema de la herramienta). */
export function temasDisponibles(): string[] {
  return Object.keys(TEMAS);
}

/** Devuelve el contenido (apto para el cliente) de un tema. */
export function infoTema(id: string): string {
  const tema = TEMAS[id];
  if (!tema) {
    return `No reconozco el tema "${id}". Temas disponibles: ${temasDisponibles().join(", ")}.`;
  }
  return `${tema.titulo}\n${tema.contenido}`;
}
