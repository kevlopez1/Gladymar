/**
 * Menú de atención del WhatsApp de Gladymar (estructura definida por el cliente).
 *
 * Es la fuente única del árbol de opciones. El agente lo usa para presentar y
 * navegar el menú, pero también entiende lenguaje natural (el cliente no está
 * obligado a escribir números).
 */

export interface OpcionMenu {
  id: string;
  titulo: string;
}

export interface SeccionMenu {
  id: string;
  titulo: string;
  opciones: OpcionMenu[];
}

export const MENU: SeccionMenu[] = [
  {
    id: "1",
    titulo: "Diseñar mi espacio",
    opciones: [
      { id: "1.1", titulo: "Acceso a Roomvo (visualizador)" },
      { id: "1.2", titulo: "Contactar asesor" },
    ],
  },
  {
    id: "2",
    titulo: "Cotizar productos",
    opciones: [
      { id: "2.1", titulo: "Catálogo" },
      { id: "2.2", titulo: "Asesoramiento" },
      { id: "2.3", titulo: "Diferencias entre cerámica y porcelanato" },
      { id: "2.4", titulo: "Tipo de pegamento recomendado" },
      { id: "2.5", titulo: "Contactar asesor" },
    ],
  },
  {
    id: "3",
    titulo: "Seguimiento de pedido",
    opciones: [{ id: "3.1", titulo: "Contactar asesor (por el momento)" }],
  },
  {
    id: "4",
    titulo: "Soporte y reclamos",
    opciones: [
      { id: "4.1", titulo: "Ubicaciones" },
      { id: "4.2", titulo: "Teléfonos" },
      { id: "4.3", titulo: "Horarios" },
      { id: "4.4", titulo: "Manual de asentamiento" },
      { id: "4.5", titulo: "Registro de reclamos" },
      { id: "4.6", titulo: "Soluciones a problemas frecuentes" },
      { id: "4.7", titulo: "Agendar visita técnica" },
    ],
  },
];

/** Menú principal: texto breve + marcador de opciones (se muestran como botones). */
export function menuPrincipal(): string {
  const opciones = MENU.map((s) => s.titulo).join(" | ");
  return [
    "Contanos, ¿cómo te ayudamos hoy? 😊",
    `[[OPCIONES: ${opciones}]]`,
  ].join("\n");
}

/** Submenú de una sección: texto breve + marcador de opciones. */
export function submenu(seccionId: string): string {
  const s =
    MENU.find((x) => x.id === seccionId) ??
    MENU.find((x) => normalizar(x.titulo).includes(normalizar(seccionId)));
  if (!s) {
    return menuPrincipal();
  }
  const opciones = s.opciones.map((o) => o.titulo).join(" | ");
  return [
    `*${s.titulo}* ¿Qué te gustaría ver?`,
    `[[OPCIONES: ${opciones} | Volver al menú]]`,
  ].join("\n");
}

/** Menú completo (todas las secciones y opciones), útil como referencia del agente. */
export function menuCompleto(): string {
  const lineas: string[] = [];
  for (const s of MENU) {
    lineas.push(`${s.id}. ${s.titulo}`);
    for (const o of s.opciones) lineas.push(`   ${o.id} ${o.titulo}`);
  }
  return lineas.join("\n");
}

function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}
