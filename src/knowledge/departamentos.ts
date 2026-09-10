/**
 * Municipio -> región del asesor que lo atiende.
 *
 * POR QUÉ EXISTE: los asesores de Gladymar son uno por departamento, pero el
 * cliente nunca dice el departamento: dice "soy de Montero", "estoy en El Alto",
 * "vivo en Quillacollo". Comparar ese texto contra "Santa Cruz" o "La Paz" no
 * matchea nunca, así que el lead terminaba sin asesor y caía al Gerente General.
 *
 * Las claves de salida son las MISMAS que usa el padrón de asesores en
 * admin/roles.ts ("Santa Cruz", "La Paz", "Cochabamba", "Sucre", "Tarija",
 * "Potosí", "Oruro"). Ojo con Chuquisaca: el padrón la llama "Sucre" (por la
 * ciudad), así que los municipios chuquisaqueños devuelven "Sucre".
 *
 * Beni y Pando están mapeados a propósito aunque HOY no tengan asesor: así el
 * CRM recibe la región correcta y el día que Gladymar nombre a alguien, alcanza
 * con agregarlo al padrón. Mientras tanto esos leads siguen yendo al Gerente.
 *
 * NO se incluyen municipios cuyo nombre se repite en dos departamentos
 * (Totora existe en Cochabamba y en Oruro; San Lorenzo en Tarija y en Beni;
 * Concepción en Santa Cruz y en Beni). Adivinar mal manda el lead al asesor
 * equivocado, que es peor que no asignarlo: se prefiere dejarlos sin match.
 */

function normalizar(s: string): string {
  return (s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Región del asesor (clave del padrón) -> municipios y sinónimos que le corresponden. */
const MUNICIPIOS_POR_REGION: Record<string, string[]> = {
  "Santa Cruz": [
    "santa cruz",
    "santa cruz de la sierra",
    "scz",
    "montero",
    "warnes",
    "la guardia",
    "cotoca",
    "el torno",
    "portachuelo",
    "mineros",
    "minero",
    "yapacani",
    "san julian",
    "camiri",
    "puerto suarez",
    "puerto quijarro",
    "robore",
    "okinawa",
    "pailon",
    "cabezas",
    "vallegrande",
    "san ignacio de velasco",
    "san jose de chiquitos",
    "ascension de guarayos",
    "buena vista",
    "samaipata",
    "comarapa",
    "mairana",
    "san matias",
    "charagua",
    "gutierrez",
    "san carlos",
    "santa rosa del sara",
  ],
  "La Paz": [
    "la paz",
    "lpz",
    "el alto",
    "viacha",
    "achocalla",
    "palca",
    "mecapaca",
    "laja",
    "pucarani",
    "coroico",
    "caranavi",
    "copacabana",
    "achacachi",
    "sorata",
    "patacamaya",
    "guaqui",
    "tiwanaku",
    "tiahuanaco",
    "desaguadero",
    "apolo",
    "chulumani",
    "coripata",
    "sapahaqui",
    "luribay",
    "sica sica",
    "ixiamas",
    "san buenaventura",
    "rurrenabaque",
    "yanacachi",
    "batallas",
  ],
  Cochabamba: [
    "cochabamba",
    "cbba",
    "quillacollo",
    "sacaba",
    "tiquipaya",
    "colcapirhua",
    "vinto",
    "sipe sipe",
    "punata",
    "cliza",
    "tarata",
    "villa tunari",
    "shinahota",
    "chimore",
    "ivirgarzama",
    "puerto villarroel",
    "aiquile",
    "mizque",
    "capinota",
    "independencia",
    "tapacari",
    "arani",
    "sacabamba",
    "entre rios cochabamba",
    "colomi",
  ],
  Sucre: [
    "sucre",
    "chuquisaca",
    "yotala",
    "monteagudo",
    "camargo",
    "padilla",
    "villa serrano",
    "zudanez",
    "tarabuco",
    "villa abecia",
    "huacareta",
    "muyupampa",
    "villa vaca guzman",
    "azurduy",
    "tomina",
    "presto",
    "icla",
    "culpina",
    "las carreras",
    "san lucas",
    "incahuasi",
  ],
  Tarija: [
    "tarija",
    "yacuiba",
    "bermejo",
    "villamontes",
    "villa montes",
    "entre rios tarija",
    "padcaya",
    "uriondo",
    "carapari",
    "el puente tarija",
    "yunchara",
  ],
  Potosí: [
    "potosi",
    "uyuni",
    "villazon",
    "tupiza",
    "llallagua",
    "uncia",
    "betanzos",
    "colquechaca",
    "atocha",
    "cotagaita",
    "pulacayo",
    "porco",
    "caiza",
    "ravelo",
    "ocuri",
    "sacaca",
    "chayanta",
    "tinguipaya",
    "puna",
  ],
  Oruro: [
    "oruro",
    "challapata",
    "huanuni",
    "caracollo",
    "poopo",
    "machacamarca",
    "eucaliptus",
    "curahuara de carangas",
    "sabaya",
    "huachacalla",
    "corque",
    "salinas de garci mendoza",
    "pazna",
    "antequera",
    "toledo",
  ],
  // Sin asesor asignado todavía: se mapean para que el CRM reciba la región,
  // pero el padrón no tiene a nadie, así que el handoff sigue yendo al Gerente.
  Beni: [
    "beni",
    "trinidad",
    "riberalta",
    "guayaramerin",
    "santa ana del yacuma",
    "san borja",
    "san ignacio de moxos",
    "reyes",
    "magdalena",
    "rurrenabaque beni",
  ],
  Pando: ["pando", "cobija", "porvenir", "puerto rico", "gonzalo moreno", "filadelfia"],
};

/** Índice invertido: municipio normalizado -> región. Se arma una sola vez. */
const REGION_POR_MUNICIPIO = new Map<string, string>();
for (const [region, municipios] of Object.entries(MUNICIPIOS_POR_REGION)) {
  for (const m of municipios) REGION_POR_MUNICIPIO.set(normalizar(m), region);
}

/**
 * Región del asesor que corresponde a un lugar escrito por el cliente.
 *
 * Primero busca coincidencia exacta del texto completo, y recién después
 * palabra por palabra dentro de la frase ("estoy en Montero, Santa Cruz").
 * El orden importa: buscar por partes primero haría que "Santa Cruz de la
 * Sierra" y "Montero" compitan, y la frase entera es siempre más específica.
 *
 * Devuelve undefined si no reconoce el lugar: es preferible dejar el lead sin
 * asesor a mandárselo al asesor equivocado.
 */
export function regionDeLugar(lugar?: string): string | undefined {
  const t = normalizar(lugar || "");
  if (!t) return undefined;

  const exacta = REGION_POR_MUNICIPIO.get(t);
  if (exacta) return exacta;

  // Coincidencia por frase contenida, de la clave más larga a la más corta,
  // para que "santa cruz de la sierra" gane sobre "santa cruz".
  const claves = [...REGION_POR_MUNICIPIO.keys()].sort((a, b) => b.length - a.length);
  for (const clave of claves) {
    if (new RegExp(`(^|\\s)${clave.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|\\s)`).test(t)) {
      return REGION_POR_MUNICIPIO.get(clave);
    }
  }
  return undefined;
}

/** Municipios reconocidos (para diagnóstico y pruebas). */
export function municipiosReconocidos(): number {
  return REGION_POR_MUNICIPIO.size;
}
