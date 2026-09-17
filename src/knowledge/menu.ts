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

/**
 * Estructura pedida por Gerencia el 17/09/2026.
 *
 * Reemplaza al árbol anterior ("Diseñar mi espacio / Cotizar productos /
 * Seguimiento / Soporte"), que nombraba las cosas como las piensa Gladymar y no
 * como las pide un cliente. Nadie escribe "quiero diseñar mi espacio"; escribe
 * "cuánto cuesta" o "dónde quedan". Las cinco de abajo son las cinco cosas que
 * la gente viene a hacer, con sus palabras.
 */
export const MENU: SeccionMenu[] = [
  {
    id: "1",
    titulo: "Ver productos",
    opciones: [
      { id: "1.1", titulo: "Catálogo" },
      { id: "1.2", titulo: "Diferencias entre cerámica y porcelanato" },
      { id: "1.3", titulo: "Tipo de pegamento recomendado" },
    ],
  },
  {
    id: "2",
    titulo: "Consultar precios",
    opciones: [{ id: "2.1", titulo: "Precio por producto y ciudad" }],
  },
  {
    id: "3",
    titulo: "Buscar una tienda",
    opciones: [
      { id: "3.1", titulo: "Ubicaciones" },
      { id: "3.2", titulo: "Teléfonos" },
      { id: "3.3", titulo: "Horarios" },
    ],
  },
  {
    id: "4",
    titulo: "Cotizar un proyecto",
    opciones: [
      { id: "4.1", titulo: "Cotización con precios del día" },
      { id: "4.2", titulo: "Cuánto material necesito" },
      { id: "4.3", titulo: "Seguimiento de un pedido" },
    ],
  },
  {
    id: "5",
    titulo: "Hablar con un asesor",
    opciones: [
      { id: "5.1", titulo: "Asesor de mi ciudad" },
      { id: "5.2", titulo: "Registrar un reclamo" },
      { id: "5.3", titulo: "Agendar visita técnica" },
      { id: "5.4", titulo: "Manual de asentamiento" },
      { id: "5.5", titulo: "Soluciones a problemas frecuentes" },
    ],
  },
];

/** Menú principal: texto breve + marcador de opciones (lista con botón y título). */
export function menuPrincipal(): string {
  const opciones = MENU.map((s) => s.titulo).join(" | ");
  return [
    "Contanos, ¿en qué te ayudamos hoy?",
    `[[OPCIONES boton="Ver opciones" titulo="¿En qué te ayudamos?": ${opciones}]]`,
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
    `*${s.titulo}*`,
    `[[OPCIONES boton="Ver opciones" titulo="${s.titulo}": ${opciones} | Volver al menú]]`,
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
