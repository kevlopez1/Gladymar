/**
 * Categorías de productos de Gladymar (según el catálogo oficial en Excel).
 *
 * Es el resumen para orientar; el detalle (productos específicos) vive en
 * catalogo.ts y se consulta con buscarCatalogo. Los precios se confirman
 * siempre con un asesor (el catálogo no incluye precios).
 */

export interface CategoriaProducto {
  id: string;
  nombre: string;
  descripcion: string;
  formatos?: string[];
  marcas?: string[];
  palabrasClave: string[];
}

export const CATEGORIAS: CategoriaProducto[] = [
  {
    id: "porcelanato-gladymar",
    nombre: "Porcelanato y pisos Gladymar",
    descripcion:
      "Porcelanato y cerámica de fabricación nacional Gladymar para pisos y revestimientos.",
    formatos: ["41x41", "60x60", "80x80", "90x90"],
    marcas: ["Porcelanato by Gladymar", "Eleganza", "Capri", "Terraforte", "Platinum"],
    palabrasClave: ["porcelanato", "piso", "pisos", "ceramica", "cerámica", "revestimiento", "nacional", "gladymar"],
  },
  {
    id: "pisos-importados",
    nombre: "Pisos importados",
    descripcion:
      "Porcelanatos importados de alta gama (efecto mármol, piedra, madera y cemento), gran formato.",
    formatos: ["60x120", "120x120", "20x120", "100x100"],
    marcas: ["Eliane", "Portinari", "Ceusa", "Embramaco", "Castelatto"],
    palabrasClave: ["importado", "importados", "gran formato", "marmol", "mármol", "madera", "piedra", "120x120", "60x120", "eliane", "portinari"],
  },
  {
    id: "griferia",
    nombre: "Griferías",
    descripcion: "Griferías para cocina, baño y ducha de primeras marcas.",
    marcas: ["Deca", "Fani"],
    palabrasClave: ["griferia", "grifería", "grifo", "mezclador", "ducha", "lavaplatos", "cocina", "monocomando"],
  },
  {
    id: "sanitarios",
    nombre: "Sanitarios",
    descripcion: "Inodoros, lavamanos y piezas sanitarias.",
    marcas: ["Deca", "Fani"],
    palabrasClave: ["sanitario", "sanitarios", "inodoro", "lavamanos", "lavabo", "baño", "bano", "tanque"],
  },
  {
    id: "perfiles",
    nombre: "Perfiles",
    descripcion: "Perfiles y juntas para pisos y paredes (terminaciones).",
    marcas: ["Atrim"],
    palabrasClave: ["perfil", "perfiles", "junta", "juntas", "terminacion", "terminación", "atrim"],
  },
  {
    id: "adhesivos",
    nombre: "Adhesivos y cemento",
    descripcion: "Adhesivos/pegamentos cementicios y complementos para la colocación.",
    marcas: ["La Calera"],
    palabrasClave: ["pegamento", "adhesivo", "cemento", "fragüe", "fragua", "colocacion", "colocación", "calera"],
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
  return lineas.join("\n");
}

function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}
