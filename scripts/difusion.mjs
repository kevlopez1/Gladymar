/**
 * Manda una plantilla de WhatsApp a una lista, sin pasar por el servidor.
 *
 * Existe porque el 22/10 Railway pausó los builds de los planes Hobby y la
 * campaña de arquitectos no podía esperar. Corre en GitHub Actions: el token
 * sale de los secretos del repositorio, nunca del código.
 *
 *   node scripts/difusion.mjs <lista.csv> [limite] [--enserio]
 *
 * Sin --enserio hace un SIMULACRO: arma cada mensaje y lo muestra, pero no
 * manda nada. Siempre probá así primero.
 */
import { readFileSync, appendFileSync } from "node:fs";

const [archivo, limiteCrudo] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const enSerio = process.argv.includes("--enserio");
const limite = Number(limiteCrudo) || Infinity;

const TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const PLANTILLA = process.env.PLANTILLA || "dexco_gladymarbolivia";
const IDIOMA = process.env.IDIOMA || "es";
const VIDEO = process.env.VIDEO_URL || "";
const BOTON_URL = process.env.BOTON_URL_VALOR || "";
const VERSION = process.env.GRAPH_VERSION || "v21.0";
// Meta acepta ráfagas, pero un envío parejo cuida la calificación del número.
const PAUSA_MS = Number(process.env.PAUSA_MS || 1200);

if (!TOKEN || !PHONE_ID) {
  console.error("Faltan WHATSAPP_ACCESS_TOKEN o WHATSAPP_PHONE_NUMBER_ID en los secretos.");
  process.exit(1);
}
if (!archivo) {
  console.error("Falta el CSV. Uso: node scripts/difusion.mjs lista.csv [limite] [--enserio]");
  process.exit(1);
}

/** Lee el CSV y se queda con los celulares bolivianos únicos. */
function destinos(ruta) {
  // NUMEROS gana sobre el archivo: es el modo de prueba, con dos o tres
  // números escritos a mano, para no cargar la lista entera solo para
  // mandarse un mensaje a uno mismo.
  const sueltos = (process.env.NUMEROS || "").trim();
  if (sueltos) {
    const vistos = new Set();
    const out = [];
    for (const n of sueltos.split(",")) {
      let t = n.replace(/\D/g, "");
      if (t.startsWith("591")) t = t.slice(3);
      if (!(t.length === 8 && "67".includes(t[0])) || vistos.has(t)) continue;
      vistos.add(t);
      out.push({ telefono: `591${t}`, nombre: "" });
    }
    return out;
  }
  const lineas = readFileSync(ruta, "utf8").split(/\r?\n/).filter(Boolean);
  const cab = lineas[0].toLowerCase().split(",").map((c) => c.trim());
  const iTel = cab.findIndex((c) => c.includes("tel"));
  const iNom = cab.findIndex((c) => c.includes("nombre"));
  const vistos = new Set();
  const out = [];
  for (const linea of lineas.slice(1)) {
    const cel = linea.split(",");
    let t = String(cel[iTel === -1 ? 0 : iTel] || "").replace(/\D/g, "");
    if (t.startsWith("591")) t = t.slice(3);
    if (!(t.length === 8 && "67".includes(t[0]))) continue;
    if (vistos.has(t)) continue;
    vistos.add(t);
    out.push({ telefono: `591${t}`, nombre: (cel[iNom] || "").trim() });
  }
  return out;
}

/** Los componentes de la plantilla: encabezado de video y botón de URL. */
function componentes() {
  const c = [];
  if (VIDEO) c.push({ type: "header", parameters: [{ type: "video", video: { link: VIDEO } }] });
  // El botón de URL dinámica EXIGE su parámetro: sin él Meta responde
  // "(#131008) Button at index 1 of type Url requires a parameter".
  if (BOTON_URL) {
    c.push({ type: "button", sub_type: "url", index: "1", parameters: [{ type: "text", text: BOTON_URL }] });
  }
  return c;
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

const lista = destinos(archivo).slice(0, limite === Infinity ? undefined : limite);
console.log(`${lista.length} destinatarios | plantilla "${PLANTILLA}" | ${enSerio ? "ENVÍO REAL" : "SIMULACRO (no manda nada)"}`);

let ok = 0;
const fallos = [];
for (const [i, d] of lista.entries()) {
  const cuerpo = {
    messaging_product: "whatsapp",
    to: d.telefono,
    type: "template",
    template: { name: PLANTILLA, language: { code: IDIOMA }, components: componentes() },
  };
  if (!enSerio) {
    if (i === 0) console.log("Mensaje de ejemplo:", JSON.stringify(cuerpo, null, 2));
    continue;
  }
  try {
    const res = await fetch(`https://graph.facebook.com/${VERSION}/${PHONE_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(cuerpo),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok && json.messages?.[0]?.id) {
      ok++;
      console.log(`[${i + 1}/${lista.length}] OK  ${d.telefono}  ${json.messages[0].id}`);
      appendFileSync("enviados.csv", `${d.telefono},${json.messages[0].id}\n`);
    } else {
      const err = json.error?.message || JSON.stringify(json);
      fallos.push({ telefono: d.telefono, error: err });
      console.log(`[${i + 1}/${lista.length}] FALLÓ ${d.telefono}  ${err}`);
      appendFileSync("fallidos.csv", `${d.telefono},"${err.replace(/"/g, "'")}"\n`);
      // Si se acabó el cupo diario, seguir solo gasta tiempo y ensucia el log.
      if (/limit/i.test(err) && /reach|exceed/i.test(err)) {
        console.error("Se alcanzó el límite de mensajes de Meta. Corto acá.");
        break;
      }
    }
  } catch (e) {
    fallos.push({ telefono: d.telefono, error: String(e) });
    console.log(`[${i + 1}/${lista.length}] ERROR ${d.telefono}  ${e}`);
  }
  await esperar(PAUSA_MS);
}

console.log(`\nResumen: ${ok} enviados, ${fallos.length} fallidos, de ${lista.length}.`);
if (enSerio && ok === 0) process.exit(1);
