/**
 * Parser CSV robusto (soporta comillas, comas y saltos de línea dentro de un campo).
 * Compartido por los módulos que leen Google Sheets vía export CSV.
 */
export function parseCSV(text: string): string[][] {
  const filas: string[][] = [];
  let fila: string[] = [];
  let campo = "";
  let comillas = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (comillas) {
      if (c === '"') {
        if (text[i + 1] === '"') { campo += '"'; i++; } else comillas = false;
      } else campo += c;
    } else if (c === '"') {
      comillas = true;
    } else if (c === ",") {
      fila.push(campo); campo = "";
    } else if (c === "\r") {
      /* ignora */
    } else if (c === "\n") {
      fila.push(campo); filas.push(fila); fila = []; campo = "";
    } else {
      campo += c;
    }
  }
  if (campo !== "" || fila.length) { fila.push(campo); filas.push(fila); }
  return filas;
}
