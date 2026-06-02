/**
 * Catálogo de categorías de productos de Gladymar.
 *
 * Es un resumen de orientación para el agente, NO una lista de SKUs ni precios
 * vigentes. Los precios son SOLO referenciales; el agente debe dejar claro que
 * el precio final y la disponibilidad se confirman en sucursal o con un asesor.
 *
 * ⚠️ Actualiza este catálogo con el equipo comercial de Gladymar.
 */

export interface CategoriaProducto {
  id: string;
  nombre: string;
  descripcion: string;
  formatos?: string[];
  marcas?: string[];
  precioReferencial?: string;
  palabrasClave: string[];
}

export const CATEGORIAS: CategoriaProducto[] = [
  {
    id: "porcelanato",
    nombre: "Porcelanato",
    descripcion:
      "Porcelanato nacional e importado de alta resistencia para pisos y revestimientos. Incluye la línea 'Insignia', inspirada 100% en la cultura y colores de Bolivia.",
    formatos: ["40x40", "60x60", "80x80", "90x90"],
    marcas: ["Kaiser", "Eleganza", "Capri", "Portobello", "Aparici"],
    precioReferencial:
      "Referencial: desde ~Bs. 49/m² (formatos chicos) y ~Bs. 99/m² (60x60). Confirmar precio vigente en sucursal.",
    palabrasClave: [
      "porcelanato",
      "porcelana",
      "piso de porcelanato",
      "insignia",
      "90x90",
      "60x60",
      "gran formato",
    ],
  },
  {
    id: "pisos-revestimientos",
    nombre: "Pisos y Revestimientos (cerámica)",
    descripcion:
      "Cerámica para pisos y paredes, nacional e importada, en distintos formatos, colores y acabados (imitación piedra, madera, cemento).",
    formatos: ["20x20", "30x30", "33x33", "45x45", "60x60"],
    marcas: ["Kaiser", "Eleganza", "Capri"],
    precioReferencial: "Referencial: varía según formato y diseño. Confirmar en sucursal.",
    palabrasClave: [
      "ceramica",
      "cerámica",
      "piso",
      "pisos",
      "revestimiento",
      "pared",
      "azulejo",
      "baldosa",
      "ceramico",
    ],
  },
  {
    id: "sanitarios-griferia",
    nombre: "Griferías y Sanitarios",
    descripcion:
      "Inodoros, lavamanos, grifería para baño y cocina, accesorios y herrajes de primeras marcas.",
    marcas: ["Briggs", "Edesa"],
    precioReferencial:
      "Referencial: según modelo. Griferías Briggs/Edesa con hasta 5 años de garantía. Confirmar en sucursal.",
    palabrasClave: [
      "sanitario",
      "sanitarios",
      "inodoro",
      "baño",
      "bano",
      "lavamanos",
      "griferia",
      "grifería",
      "grifo",
      "ducha",
      "lavaplatos",
      "cocina",
    ],
  },
  {
    id: "complementos",
    nombre: "Complementos para la obra",
    descripcion:
      "Pegamentos/adhesivos cementicios, fragüe, perfiles metálicos, impermeabilizantes, pinturas Coral y herramientas para la colocación.",
    marcas: ["Pinturas Coral"],
    precioReferencial: "Referencial: según producto. Confirmar en sucursal.",
    palabrasClave: [
      "pegamento",
      "adhesivo",
      "fragüe",
      "fragua",
      "perfil",
      "perfiles",
      "impermeabilizante",
      "pintura",
      "coral",
      "herramienta",
      "complemento",
    ],
  },
];

/** Busca categorías por palabra clave o nombre (flexible, sin tildes). */
export function buscarCategorias(consulta?: string): CategoriaProducto[] {
  if (!consulta) return CATEGORIAS;
  const q = normalizar(consulta);
  const encontradas = CATEGORIAS.filter((c) => {
    if (normalizar(c.nombre).includes(q)) return true;
    return c.palabrasClave.some((k) => q.includes(normalizar(k)) || normalizar(k).includes(q));
  });
  return encontradas.length > 0 ? encontradas : CATEGORIAS;
}

/** Formatea una categoría para mostrarla al cliente. */
export function formatearCategoria(c: CategoriaProducto): string {
  const lineas = [`🧱 *${c.nombre}*`, `   ${c.descripcion}`];
  if (c.formatos?.length) lineas.push(`   📐 Formatos: ${c.formatos.join(", ")} cm`);
  if (c.marcas?.length) lineas.push(`   🏷️ Marcas: ${c.marcas.join(", ")}`);
  if (c.precioReferencial) lineas.push(`   💲 ${c.precioReferencial}`);
  return lineas.join("\n");
}

function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}
