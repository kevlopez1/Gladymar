/**
 * Colección "Dimensión Viva" — lanzamiento 2026 de Gladymar (CASACOR Bolivia 2026).
 *
 * Fuente: catálogo oficial en PDF entregado por Gladymar (66 páginas, 19 colecciones).
 *
 * Los SKU sueltos de estas colecciones ya viven en `catalogo.ts` (que sale del
 * Excel de la empresa). Lo que aporta este módulo es lo que ese Excel NO tiene y
 * el agente necesita para asesorar de verdad:
 *   - el CONCEPTO de cada colección (para recomendar por estilo, no por código),
 *   - el TIPO DE USO (resistencia al tráfico; los clientes de obra lo piden),
 *   - los M² POR CAJA (para poder decirle al cliente cuántas cajas necesita).
 */

export interface ColeccionDV {
  nombre: string;
  /** De qué se inspira: es lo que se le cuenta al cliente cuando busca un estilo. */
  concepto: string;
  /** Formato nominal como lo dice el cliente (ej. "60x120"). */
  formato: string;
  /** Formato exacto de ficha técnica. */
  formatoExacto: string;
  acabados: string[];
  /** Tipo de uso (resistencia al tráfico). Mayor = más resistente. */
  tipoUso: string;
  m2PorCaja: number;
  colores: string[];
  /** Palabras que suele usar el cliente y llevan a esta colección. */
  claves: string[];
}

export const COLECCION_NOMBRE = "Dimensión Viva";
export const COLECCION_ANIO = 2026;

export const DIMENSION_VIVA: ColeccionDV[] = [
  {
    nombre: "Lomas",
    concepto:
      "Inspirada en la suavidad del paisaje natural: superficies serenas, abiertas y ligeramente erosionadas por el tiempo. Transmite calma y equilibrio.",
    formato: "60x120",
    formatoExacto: "60x120.5 cm",
    acabados: ["Mate", "Granilla localizada (Decor)"],
    tipoUso: "4",
    m2PorCaja: 1.45,
    colores: ["Beige", "Gray", "Decor Beige", "Decor Gray"],
    claves: ["natural", "suave", "calma", "arena", "beige", "sereno"],
  },
  {
    nombre: "City",
    concepto:
      "Interpreta la energía de la arquitectura urbana desde una mirada sobria y contemporánea. Recoge marcas, sombras y texturas de la ciudad.",
    formato: "90x90",
    formatoExacto: "90x90 cm",
    acabados: ["Mate"],
    tipoUso: "4",
    m2PorCaja: 1.62,
    colores: ["Night", "Salt", "Sahara"],
    claves: ["urbano", "moderno", "ciudad", "contemporáneo", "sobrio"],
  },
  {
    nombre: "Metropoli",
    concepto:
      "Se inspira en los muros y pisos que cuentan historias dentro de la ciudad. Superficie cementicia, profunda y equilibrada.",
    formato: "90x90",
    formatoExacto: "90x90 cm",
    acabados: ["Mate"],
    tipoUso: "4",
    m2PorCaja: 1.62,
    colores: ["Light", "Brown", "Dark"],
    claves: ["cemento", "cementicio", "industrial", "urbano", "minimalista"],
  },
  {
    nombre: "Edén",
    concepto:
      "Nace de la calma de los espacios naturales. Textura suave y orgánica, un lienzo sereno para ambientes que transmiten bienestar y amplitud.",
    formato: "60x120",
    formatoExacto: "60x120.5 cm",
    acabados: ["Mate", "Brillo sectorizado (Decor)"],
    tipoUso: "4 (Decor: 3)",
    m2PorCaja: 1.45,
    colores: ["Beige", "Gray", "Decor Beige", "Decor Gray"],
    claves: ["natural", "orgánico", "bienestar", "sereno", "amplio"],
  },
  {
    nombre: "Forte",
    concepto:
      "Inspirado en la fuerza de los minerales naturales: recuerda pequeñas piedras incrustadas en la superficie. Estética resistente y urbana.",
    formato: "90x90",
    formatoExacto: "90x90 cm",
    acabados: ["Exterior"],
    tipoUso: "4",
    m2PorCaja: 1.62,
    colores: ["Brown", "Gray"],
    claves: ["exterior", "piedra", "mineral", "resistente", "antideslizante"],
  },
  {
    nombre: "Asfalto",
    concepto:
      "Nace de la textura cruda del entorno cotidiano. Marcas sutiles y vetas difusas que evocan superficies recorridas y transformadas por el uso.",
    formato: "90x90",
    formatoExacto: "90x90 cm",
    acabados: ["Exterior"],
    tipoUso: "4",
    m2PorCaja: 1.62,
    colores: ["Light"],
    claves: ["exterior", "industrial", "cemento", "urbano", "desgastado"],
  },
  {
    nombre: "Ferrum",
    concepto:
      "Interpreta la belleza del metal transformado por el tiempo. Combina profundidad, desgaste y expresión artística, evocando la fuerza del óxido.",
    formato: "60x120",
    formatoExacto: "60x120.5 cm",
    acabados: ["Lapado"],
    tipoUso: "4",
    m2PorCaja: 1.62,
    colores: ["Blue"],
    claves: ["metal", "óxido", "azul", "industrial", "lapado"],
  },
  {
    nombre: "Ox Terra",
    concepto:
      "Nace del encuentro entre la tierra y el metal. Refleja procesos naturales de oxidación y desgaste, con fuerza, carácter y memoria.",
    formato: "60x120",
    formatoExacto: "60x120.5 cm",
    acabados: ["Lapado"],
    tipoUso: "4",
    m2PorCaja: 1.45,
    colores: ["Rust", "Gray"],
    claves: ["óxido", "tierra", "metal", "rústico", "carácter"],
  },
  {
    nombre: "Arenza",
    concepto:
      "La calidez de la arena en una superficie suave y luminosa. Envuelve los ambientes con naturalidad y ligereza.",
    formato: "90x90",
    formatoExacto: "90x90 cm",
    acabados: ["Moldeado"],
    tipoUso: "4",
    m2PorCaja: 1.62,
    colores: ["Beige"],
    claves: ["arena", "cálido", "beige", "luminoso", "acogedor"],
  },
  {
    nombre: "Volcano",
    concepto:
      "Oscuro, intenso y magnético. Captura la energía de la roca volcánica, para arquitecturas audaces que buscan dejar una impresión contundente.",
    formato: "60x120",
    formatoExacto: "60x120.5 cm",
    acabados: ["Bajo relieve"],
    tipoUso: "4",
    m2PorCaja: 1.62,
    colores: ["Negro"],
    claves: ["negro", "oscuro", "volcánico", "intenso", "audaz"],
  },
  {
    nombre: "Ruina",
    concepto:
      "Capas, marcas y contrastes de apariencia desgastada y espontánea. Cada pieza es un fragmento visual único, con ritmo y movimiento, para superficies externas.",
    formato: "20x20",
    formatoExacto: "20x20 cm",
    acabados: ["Bajo relieve"],
    tipoUso: "4",
    m2PorCaja: 0.4,
    colores: ["Grafitto"],
    claves: ["exterior", "desgastado", "mosaico", "pequeño formato", "rústico"],
  },
  {
    nombre: "Ambar",
    concepto:
      "Se inspira en la calidez de la tierra, la arcilla y las dunas erosionadas por el viento. Superficie envolvente, suave y natural.",
    formato: "60x120",
    formatoExacto: "60x120.5 cm",
    acabados: ["Mate"],
    tipoUso: "4",
    m2PorCaja: 1.45,
    colores: ["Clay", "Dune"],
    claves: ["tierra", "arcilla", "cálido", "duna", "natural"],
  },
  {
    nombre: "Porto",
    concepto:
      "Evoca la calma de la piedra costera y la arena compacta. Acabado suave que transmite frescura y armonía.",
    formato: "90x90",
    formatoExacto: "90x90 cm",
    acabados: ["Exterior"],
    tipoUso: "4",
    m2PorCaja: 1.62,
    colores: ["Sabbia"],
    claves: ["exterior", "piedra", "costa", "arena", "fresco"],
  },
  {
    nombre: "Fragmento",
    concepto:
      "Nace de la piedra quebrada y recompuesta por la naturaleza. Piezas, vetas y detalles irregulares con profundidad y movimiento.",
    formato: "90x90",
    formatoExacto: "90x90 cm",
    acabados: ["Mate", "Mate / Exterior"],
    tipoUso: "4",
    m2PorCaja: 1.62,
    colores: ["Salt", "Night", "Sahara"],
    claves: ["piedra", "irregular", "veta", "profundidad", "exterior"],
  },
  {
    nombre: "Piedra de Sal",
    concepto:
      "Se inspira en la pureza mineral y en las vetas suaves de la piedra natural. Superficie luminosa, delicada y sensorial.",
    formato: "60x120",
    formatoExacto: "60x120.5 cm",
    acabados: ["Granilla localizada", "Mate"],
    tipoUso: "4",
    m2PorCaja: 1.45,
    colores: ["Piedra de Sal", "Piedra de Sal Decor"],
    claves: ["piedra", "claro", "luminoso", "mineral", "sofisticado"],
  },
  {
    nombre: "Emporio",
    concepto:
      "Nace de la elegancia clásica del travertino. Movimiento natural y vetas sutiles: una superficie sobria, refinada y atemporal.",
    formato: "60x120",
    formatoExacto: "60x120.5 cm",
    acabados: ["Granilla localizada"],
    tipoUso: "4",
    m2PorCaja: 1.45,
    colores: ["Griggio"],
    claves: ["travertino", "mármol", "clásico", "elegante", "atemporal"],
  },
  {
    nombre: "Antracite",
    concepto:
      "Interpreta la profundidad de la piedra oscura. Carácter mineral, elegante y silencioso, con fuerza visual y presencia arquitectónica.",
    formato: "60x120",
    formatoExacto: "60x120.5 cm",
    acabados: ["Bajo relieve"],
    tipoUso: "4",
    m2PorCaja: 1.45,
    colores: ["Night"],
    claves: ["oscuro", "negro", "piedra", "elegante", "sofisticado"],
  },
  {
    nombre: "Tempesta",
    concepto:
      "Se inspira en el cielo antes de la lluvia y el movimiento de las nubes sobre la piedra. Vetas y contrastes con energía y profundidad.",
    formato: "60x120",
    formatoExacto: "60x120.5 cm",
    acabados: ["Mate", "Pulido"],
    tipoUso: "3 / 4",
    m2PorCaja: 1.45,
    colores: ["Tempesta"],
    claves: ["mármol", "veta", "movimiento", "gris", "pulido"],
  },
  {
    nombre: "Palma",
    concepto:
      "Se inspira en la calidez de la madera y las fibras naturales. Transmite cercanía y confort, para espacios más acogedores.",
    formato: "20x120",
    formatoExacto: "20x120.5 cm",
    acabados: ["Bajo relieve"],
    tipoUso: "4",
    m2PorCaja: 1.45,
    colores: ["Beige", "Red"],
    claves: ["madera", "efecto madera", "cálido", "listón", "acogedor"],
  },
];

function normalizar(t: string): string {
  return (t || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * Palabras vacías del español. Sin esto, un "algo que se vea como mármol"
 * matcheaba por "que" contra el concepto de cualquier colección y devolvía la
 * primera del arreglo (Metropoli, que es cemento) en vez de las de mármol.
 */
const VACIAS = new Set([
  "algo", "que", "como", "para", "una", "uno", "con", "los", "las", "del", "por",
  "mas", "muy", "pero", "sea", "vea", "ver", "quiero", "busco", "necesito",
  "tiene", "tienen", "hay", "este", "esta", "esto", "eso", "mi", "me", "te",
  "producto", "productos", "gladymar", "catalogo", "catalogos", "porfavor",
]);

/**
 * Busca colecciones por nombre, color, estilo o formato.
 *
 * Puntúa por dónde aparece el término: el nombre y las palabras clave (el
 * estilo que declara la colección) mandan; una coincidencia suelta dentro del
 * texto del concepto vale poco, porque esos párrafos comparten mucho
 * vocabulario entre sí.
 */
export function buscarColecciones(consulta: string, limite = 3): ColeccionDV[] {
  const q = normalizar(consulta);
  if (!q) return [];
  const terminos = q.split(/\s+/).filter((t) => t.length > 2 && !VACIAS.has(t));
  if (!terminos.length) return [];

  const puntuadas = DIMENSION_VIVA.map((c) => {
    const nombre = normalizar(c.nombre);
    const claves = c.claves.map(normalizar);
    const colores = c.colores.map(normalizar);
    const tecnico = normalizar([c.formato, c.formatoExacto, c.acabados.join(" ")].join(" "));
    const concepto = normalizar(c.concepto);

    let puntos = 0;
    for (const t of terminos) {
      if (nombre === t || nombre.split(/\s+/).includes(t)) puntos += 10;
      else if (claves.some((k) => k === t || k.split(/\s+/).includes(t))) puntos += 5;
      else if (colores.some((k) => k.includes(t))) puntos += 3;
      else if (tecnico.includes(t)) puntos += 2;
      else if (concepto.includes(t)) puntos += 1;
    }
    return { c, puntos };
  })
    // Un solo acierto flojo (1 punto, dentro del concepto) no alcanza para
    // recomendar una colección: sería ruido, no una sugerencia.
    .filter((p) => p.puntos >= 2);

  puntuadas.sort((a, b) => b.puntos - a.puntos);
  return puntuadas.slice(0, limite).map((p) => p.c);
}

/** Ficha de una colección, lista para responderle al cliente. */
export function formatearColeccion(c: ColeccionDV): string {
  return (
    `*${c.nombre}* (colección ${COLECCION_NOMBRE} ${COLECCION_ANIO})\n` +
    `${c.concepto}\n` +
    `Formato: ${c.formato} · Acabado: ${c.acabados.join(" / ")}\n` +
    `Colores: ${c.colores.join(", ")}\n` +
    `Tipo de uso: ${c.tipoUso} · Rinde ${c.m2PorCaja} m² por caja`
  );
}

/**
 * Cajas necesarias para cubrir una superficie, con el desperdicio de corte que
 * se recomienda prever (10%). Es la pregunta que más repite el cliente cuando
 * ya eligió el modelo.
 */
export function cajasNecesarias(metrosCuadrados: number, m2PorCaja: number): { cajas: number; m2ConMerma: number } {
  const m2ConMerma = metrosCuadrados * 1.1;
  return { cajas: Math.ceil(m2ConMerma / m2PorCaja), m2ConMerma: Math.round(m2ConMerma * 100) / 100 };
}

/** Listado corto de todas las colecciones (para cuando piden "el catálogo"). */
export function resumenColecciones(): string {
  return (
    `*${COLECCION_NOMBRE} ${COLECCION_ANIO}*, nuestra colección más reciente (${DIMENSION_VIVA.length} líneas):\n` +
    DIMENSION_VIVA.map((c) => `• *${c.nombre}* ${c.formato}, ${c.colores.join(" / ")}`).join("\n")
  );
}
