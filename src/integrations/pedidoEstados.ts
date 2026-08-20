/**
 * Notificaciones automáticas de estado de pedido (plantillas de WhatsApp).
 *
 * Revisa periódicamente la pestaña "DESPACHOS" del Excel de control de
 * despacho y, cuando una factura cambia a "Preparado" o "Despachado", le manda
 * al cliente la plantilla de Meta correspondiente con su nombre y N° de
 * factura, sin que el cliente tenga que preguntar.
 *
 * Se lee vía export CSV (~3 KB) en vez del .xlsx completo (~280 KB): el export
 * CSV de Google Sheets devuelve la PRIMERA pestaña, que es justamente
 * "DESPACHOS" (los pedidos en curso). No hace falta el libro entero.
 *
 * Una factura puede tener MÁS DE UN número de contacto cargado (a pedido de
 * Gerencia): se le avisa a todos, y se lleva el control por (factura, teléfono)
 * para que el aviso a uno no marque como notificado al otro.
 *
 * PROTECCIONES (cada envío cuesta dinero en Meta y le llega a un cliente real):
 *  1. Sin Postgres NO se manda nada: sin memoria de lo ya avisado, cada chequeo
 *     reenviaría todo. Una caída de la BD pausa los avisos en vez de duplicarlos.
 *  2. Primer arranque: se registra el estado actual SIN avisar, para no
 *     bombardear a clientes con pedidos viejos que ya estaban en la hoja.
 *  3. Un teléfono que figura con VARIOS nombres de cliente distintos se omite:
 *     mandaría el pedido de una persona al WhatsApp de otra. Se exceptúan los
 *     números internos de Gladymar (administradores del panel y los cargados en
 *     DESPACHO_TELEFONOS_PRUEBA), que se repiten a propósito para hacer pruebas.
 */
import { config, isWhatsAppConfigured } from "../config.js";
import { parseCSV } from "../util/csv.js";
import { sendTemplate } from "../whatsapp/client.js";
import { obtenerEstadosPedidos, guardarEstadoPedido, dbHabilitada, claveEstadoPedido } from "../db/index.js";
import { esAdmin } from "../admin/roles.js";

/**
 * Estados que disparan aviso -> plantilla de Meta a usar (nombre + idioma).
 * El idioma es parte de la identidad de la plantilla en Meta, por eso cada una
 * puede tener el suyo (si una quedó registrada como "English", hay que pedirla
 * como "en" aunque su texto esté en español).
 */
function templateDeEstado(estado: string): { nombre: string; idioma: string } | null {
  const d = config.despacho;
  if (estado === "preparado") {
    return { nombre: d.templatePreparado, idioma: d.templatePreparadoIdioma || d.templateIdioma };
  }
  if (estado === "despachado") {
    return { nombre: d.templateDespachado, idioma: d.templateDespachadoIdioma || d.templateIdioma };
  }
  return null; // "Entregado" u otros: no se avisa (el cliente ya lo recibió).
}

/**
 * Dígitos de un valor numérico del CSV.
 *
 * OJO: Google Sheets puede exportar una celda numérica como "71091625.0". Un
 * `replace(/\D/g,"")` directo daría "710916250" (un dígito de más) y el aviso
 * se mandaría a un número que no es el del cliente. Por eso se descarta primero
 * la parte decimal.
 */
function digitos(valor: string): string {
  return valor.trim().replace(/\.\d*$/, "").replace(/\D/g, "");
}

function telefonoInternacional(numero: string): string {
  return numero.startsWith("591") ? numero : `591${numero}`;
}

/**
 * Reenvíos ya forzados en este proceso. DESPACHO_REENVIAR_FACTURAS repite un
 * aviso que salió pero no llegó; sin esta memoria se repetiría en cada chequeo
 * (cada 5 min) hasta que alguien se acuerde de borrar la variable.
 */
const reenviosForzados = new Set<string>();

function forzarReenvio(factura: string, clave: string): boolean {
  if (!config.despacho.reenviarFacturas.includes(factura)) return false;
  if (reenviosForzados.has(clave)) return false;
  reenviosForzados.add(clave);
  console.log(`📦 Reenvío forzado de la factura ${factura} (DESPACHO_REENVIAR_FACTURAS).`);
  return true;
}

/** ¿Es un número interno de Gladymar (panel de admins o cargado para pruebas)? */
function esTelefonoInterno(telefono: string): boolean {
  return esAdmin(telefono) || config.despacho.telefonosPrueba.includes(telefono);
}

interface PedidoActual {
  factura: string;
  nombre: string;
  estado: string;
  /** Todos los números de contacto cargados para esa factura (sin repetir). */
  telefonos: string[];
}

/**
 * Descarga la pestaña de pedidos en curso como CSV. Null si no se pudo.
 * Cada fallo se loguea con su motivo: si esto queda mudo, los avisos dejan de
 * salir sin ninguna pista de por qué.
 */
async function descargarDespachos(): Promise<string[][] | null> {
  if (!config.despacho.sheetId) {
    console.warn("📦 Avisos de pedido desactivados: falta DESPACHO_SHEET_ID.");
    return null;
  }
  try {
    const url = `https://docs.google.com/spreadsheets/d/${config.despacho.sheetId}/export?format=csv`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) {
      console.error(`📦 No se pudo leer la hoja de despacho: HTTP ${res.status} ${res.statusText}`);
      return null;
    }
    const csv = await res.text();
    if (csv.trimStart().startsWith("<")) {
      console.error(
        "📦 La hoja de despacho devolvió HTML en vez de CSV: hay que compartirla como 'Cualquiera con el enlace: Lector'.",
      );
      return null;
    }
    return parseCSV(csv);
  } catch (err) {
    console.error("📦 No se pudo descargar la hoja de despacho (CSV):", err);
    return null;
  }
}

export interface LecturaDespachos {
  pedidos: PedidoActual[];
  /**
   * Teléfonos de clientes que figuran con más de un nombre distinto. Se calcula
   * sobre TODAS las filas (no sobre los pedidos ya agrupados): si se calculara
   * después de agrupar por factura, un teléfono compartido que quedó descartado
   * al elegir el de la factura pasaría desapercibido.
   */
  telefonosAmbiguos: Set<string>;
  /**
   * Por qué no se reconoció ningún pedido. Sin esto, "la hoja se leyó pero no
   * hay pedidos" tapa tres causas muy distintas (no está el encabezado, falta
   * una columna, o no hay filas) y no se puede arreglar sin abrir la hoja.
   */
  motivo?: string;
}

/** Arma un pedido por factura (una factura tiene varias filas, una por producto). */
export function leerPedidos(filas: string[][]): LecturaDespachos {
  const vacio: LecturaDespachos = { pedidos: [], telefonosAmbiguos: new Set() };
  const encIdx = filas.findIndex((f) => f.some((c) => c.trim().toUpperCase() === "FACTURA"));
  if (encIdx === -1) {
    const primeras = filas.slice(0, 3).map((f) => f.join(" | ")).join("  //  ");
    return { ...vacio, motivo: `no se encontró ninguna fila con la columna FACTURA. Primeras filas: ${primeras}` };
  }
  const enc = filas[encIdx].map((c) => c.trim().toUpperCase());
  const col = (nombre: string) => enc.indexOf(nombre);
  const iFactura = col("FACTURA");
  const iTelefono = col("TELEFONO DEL CLIENTE");
  const iNombre = col("NOMBRE DEL CLIENTE");
  const iEstado = col("ESTADO");
  if (iFactura === -1 || iTelefono === -1 || iEstado === -1) {
    const faltan = [
      iFactura === -1 ? "FACTURA" : null,
      iTelefono === -1 ? "TELEFONO DEL CLIENTE" : null,
      iEstado === -1 ? "ESTADO" : null,
    ].filter(Boolean);
    return {
      ...vacio,
      motivo: `falta(n) la(s) columna(s) ${faltan.join(", ")}. Encabezado encontrado: ${enc.join(" | ")}`,
    };
  }

  interface Acum { nombre: string; estado: string; telefonos: Set<string> }
  const porFactura = new Map<string, Acum>();
  const nombresPorTelefono = new Map<string, Set<string>>();
  // Para poder distinguir "la hoja está vacía porque no hay pedidos pendientes"
  // (todo bien) de "hay filas pero la columna FACTURA no se entiende" (roto).
  let filasDebajo = 0;
  let sinFactura = 0;
  let sinTelefono = 0;
  let sinEstado = 0;

  for (let r = encIdx + 1; r < filas.length; r++) {
    const f = filas[r];
    if (f.some((c) => c.trim() !== "")) filasDebajo++;
    const factura = digitos(f[iFactura] ?? "");
    if (!factura) {
      if (f.some((c) => c.trim() !== "")) sinFactura++;
      continue;
    }
    const telefono = digitos(f[iTelefono] ?? "");
    const estado = (f[iEstado] ?? "").trim().toLowerCase();
    if (!telefono || !estado) {
      // Estas dos columnas las llena logística a mano y son la causa más
      // frecuente de que un pedido no dispare su aviso.
      if (!telefono) sinTelefono++;
      if (!estado) sinEstado++;
      continue;
    }
    const nombre = (iNombre >= 0 ? f[iNombre] ?? "" : "").trim();

    const acum = porFactura.get(factura) ?? { nombre, estado, telefonos: new Set<string>() };
    acum.telefonos.add(telefono);
    porFactura.set(factura, acum);

    if (!nombresPorTelefono.has(telefono)) nombresPorTelefono.set(telefono, new Set());
    nombresPorTelefono.get(telefono)!.add(nombre.toUpperCase());
  }

  // Los números internos se repiten a propósito entre facturas de prueba: no
  // son un error de carga y no deben bloquearse.
  const telefonosAmbiguos = new Set<string>();
  for (const [tel, nombres] of nombresPorTelefono) {
    if (nombres.size > 1 && !esTelefonoInterno(tel)) telefonosAmbiguos.add(tel);
  }

  const pedidos = [...porFactura.entries()].map(([factura, a]) => ({
    factura,
    nombre: a.nombre,
    estado: a.estado,
    telefonos: [...a.telefonos],
  }));

  const motivo = pedidos.length
    ? undefined
    : filasDebajo === 0
      ? "el encabezado está bien y no hay ninguna fila debajo: la hoja quedó vacía (¿se limpió la pestaña DESPACHOS?)."
      : `hay ${filasDebajo} fila(s) con datos debajo del encabezado. Descartadas: ` +
        `${sinFactura} sin factura legible, ${sinTelefono} sin TELEFONO DEL CLIENTE, ${sinEstado} sin ESTADO. ` +
        "Las dos últimas columnas las llena logística a mano: si están vacías, el aviso no puede salir.";

  return { pedidos, telefonosAmbiguos, motivo };
}

/**
 * Revisa la hoja y manda las notificaciones de los pedidos que cambiaron de
 * estado desde el último chequeo. Nunca lanza.
 */
export async function chequearNotificacionesPedidos(): Promise<void> {
  if (!isWhatsAppConfigured()) {
    console.warn("📦 Avisos de pedido en pausa: faltan credenciales de WhatsApp.");
    return;
  }

  // Protección 1: sin persistencia no hay forma de saber qué ya se avisó.
  if (!dbHabilitada()) {
    console.warn("📦 Avisos de pedido en pausa: falta DATABASE_URL (sin ella se reenviarían en cada chequeo).");
    return;
  }

  try {
    console.log("📦 Chequeando cambios de estado de pedidos...");
    const filas = await descargarDespachos();
    if (!filas) return;
    const { pedidos, telefonosAmbiguos: ambiguos, motivo } = leerPedidos(filas);
    if (!pedidos.length) {
      console.warn(
        `📦 La hoja se leyó (${filas.length} filas) pero no se reconoció ningún pedido: ` +
          (motivo ?? "el encabezado está bien pero no hay filas de pedidos debajo."),
      );
      return;
    }

    console.log(`📦 ${pedidos.length} pedido(s) leídos de la hoja; consultando avisos ya enviados...`);

    if (config.despacho.logDetalle) {
      for (const p of pedidos.slice(0, 50)) {
        console.log(
          `📦 [hoja] factura ${p.factura} | ${p.estado} | ${p.nombre || "(sin nombre)"} | ` +
            `tel: ${p.telefonos.join(" , ") || "(sin teléfono)"}`,
        );
      }
    }
    const yaAvisado = await obtenerEstadosPedidos();
    if (yaAvisado === null) {
      console.warn("📦 Avisos de pedido en pausa: Postgres no respondió (se reintenta en el próximo chequeo).");
      return;
    }

    // Protección 2: primer arranque => registrar sin avisar.
    if (yaAvisado.size === 0) {
      let n = 0;
      for (const p of pedidos) {
        for (const tel of p.telefonos) {
          await guardarEstadoPedido(p.factura, tel, p.estado);
          n++;
        }
      }
      console.log(`📦 Primer arranque: se registraron ${n} contacto(s) SIN avisar (evita avisos de pedidos viejos).`);
      return;
    }

    if (ambiguos.size) {
      // El mensaje tiene que ser accionable: la causa casi siempre es que
      // logística está probando con un número propio repetido en varias
      // facturas, y entonces basta con declararlo como interno.
      console.warn(
        `📦 ${ambiguos.size} teléfono(s) figuran con varios clientes distintos, esos avisos NO se envían: ` +
          `${[...ambiguos].join(", ")}. ` +
          "Si son números INTERNOS de Gladymar (pruebas), agregalos a DESPACHO_TELEFONOS_PRUEBA. " +
          "Si son de clientes reales, hay que corregir la columna TELEFONO DEL CLIENTE en la hoja.",
      );
    }

    let enviados = 0;
    let sinCambios = 0;
    let omitidos = 0;
    let fallidos = 0;

    for (const pedido of pedidos) {
      const template = templateDeEstado(pedido.estado);

      for (const tel of pedido.telefonos) {
        const clave = claveEstadoPedido(pedido.factura, tel);
        if (yaAvisado.get(clave) === pedido.estado && !forzarReenvio(pedido.factura, clave)) {
          sinCambios++;
          continue;
        }

        // Estado que no avisamos (ej. "Entregado"): se registra para no
        // re-evaluarlo, pero no se manda nada.
        if (!template) {
          await guardarEstadoPedido(pedido.factura, tel, pedido.estado);
          sinCambios++;
          continue;
        }

        // Protección 3: no mandarle el pedido de un cliente al WhatsApp de otro.
        if (ambiguos.has(tel)) {
          console.warn(`📦 Factura ${pedido.factura} omitida para ${tel}: ese número figura con varios clientes.`);
          omitidos++;
          continue;
        }

        try {
          const wamid = await sendTemplate(telefonoInternacional(tel), template.nombre, template.idioma, [
            pedido.nombre || "Cliente",
            pedido.factura,
          ]);
          // El wamid es lo que después permite cruzar este envío con el acuse
          // de entrega que manda Meta al webhook ("delivered" / "failed"): sin
          // él, "enviado" solo quiere decir que Meta lo aceptó.
          console.log(
            `📦 Aviso "${pedido.estado}" aceptado por Meta (factura ${pedido.factura} -> ${tel})` +
              `${wamid ? ` id=${wamid}` : ""}`,
          );
          enviados++;
        } catch (err) {
          console.error(`📦 No se pudo enviar el aviso (factura ${pedido.factura} -> ${tel}):`, err);
          fallidos++;
          continue; // no se registra: se reintenta en el próximo chequeo
        }
        await guardarEstadoPedido(pedido.factura, tel, pedido.estado);
      }
    }

    // Cierre SIEMPRE presente: sin esto, un chequeo correcto en el que no hubo
    // nada que avisar se ve igual que uno que se colgó a mitad de camino.
    console.log(
      `📦 Chequeo terminado: ${enviados} aviso(s) enviado(s), ${sinCambios} sin cambios, ` +
        `${omitidos} omitido(s), ${fallidos} con error.`,
    );
  } catch (err) {
    console.error("📦 No se pudo chequear las notificaciones de pedidos:", err);
  }
}
