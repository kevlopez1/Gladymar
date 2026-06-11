/**
 * Información institucional de Cerámica Gladymar S.A.
 *
 * Fuentes públicas: gladymar.com.bo, prensa boliviana y redes oficiales.
 * IMPORTANTE: revisa y actualiza estos datos con el equipo de Gladymar antes
 * de poner el agente en producción (precios, horarios y direcciones cambian).
 */

export const COMPANY_INFO = {
  nombre: "Cerámica Gladymar S.A.",
  rubro: "Fabricación y comercialización de cerámica, porcelanato y acabados para la construcción.",
  grupo: "Parte del Grupo Industrial Roda.",
  fundacion: "Fundada en Bolivia hacia 1984 (más de 38 años en el mercado).",
  sede: "Santa Cruz de la Sierra, Bolivia. Presencia a nivel nacional.",
  web: "https://gladymar.com.bo",
  hitos: [
    "Primera empresa en Bolivia en fabricar porcelanato sin uso de agua (proceso 'en seco'), ahorrando más del 90% del agua que usa la industria tradicional.",
    "Pionera en lograr formatos grandes de hasta 90x90 cm, únicos en Bolivia.",
    "Gladymar Plus: la tienda de acabados finos más grande de Latinoamérica, ubicada en Santa Cruz.",
  ],
  marcasPropias: ["Porcelanato by Gladymar", "Eleganza", "Capri", "Platinum", "Terraforte"],
  marcasRepresentadas: [
    "Eliane",
    "Portinari",
    "Ceusa",
    "Embramaco",
    "Castelatto",
    "Deca (griferías y sanitarios)",
    "Fani",
    "Artema",
    "Atrim (perfiles)",
    "La Calera (adhesivos)",
  ],
  garantias: "Productos con garantía; consultá las condiciones con un asesor.",
};

/**
 * Texto institucional listo para incluir en el prompt del sistema.
 */
export function companyInfoText(): string {
  return [
    `Empresa: ${COMPANY_INFO.nombre}`,
    `Rubro: ${COMPANY_INFO.rubro}`,
    `Grupo: ${COMPANY_INFO.grupo}`,
    `Historia: ${COMPANY_INFO.fundacion} ${COMPANY_INFO.sede}`,
    `Sitio web: ${COMPANY_INFO.web}`,
    "",
    "Hitos y diferenciadores:",
    ...COMPANY_INFO.hitos.map((h) => `- ${h}`),
    "",
    `Marcas propias: ${COMPANY_INFO.marcasPropias.join(", ")}.`,
    `Marcas representadas/importadas: ${COMPANY_INFO.marcasRepresentadas.join(", ")}.`,
    `Garantías: ${COMPANY_INFO.garantias}`,
  ].join("\n");
}
