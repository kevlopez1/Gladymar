/**
 * Manejo de comandos del panel de administradores (determinista, sin IA).
 *
 * Comandos base (regionales, solo su ciudad): leads, reclamos, resumen.
 * Asesores comerciales: leads de su región y alta de clientes, nada más.
 * Exclusivos del Gerente General (nacional): reportes globales, comunicado,
 * ver cualquier región.
 *
 * "Agregar cliente" lo tienen los tres roles: es el que más lo usa el asesor de
 * mostrador, que hoy anota el contacto en un papel y ahí se queda.
 */
import type { Admin } from "./roles.js";
import { ciudadesAdmin, adminNombrePorCiudad } from "./roles.js";
import {
  getLeads,
  getReclamos,
  getKpis,
  totalConversaciones,
  esDeHoy,
  type SolicitudReg,
} from "./data.js";
import { obtenerStatsHoy } from "../integrations/sheetsStats.js";
import type { SeccionLista } from "../whatsapp/client.js";
import {
  leerClientesDeTexto,
  leerClientesDeFoto,
  leerClientesDePlanilla,
  resumenParaConfirmar,
  resumenPlanilla,
  guardarClientes,
  type ClienteNuevo,
  type LecturaClientes,
} from "./altaCliente.js";

export interface AdminReply {
  text: string;
  options?: string[];
  optionsButton?: string;
  optionsTitle?: string;
  /**
   * El menú agrupado, cuando conviene mostrarlo por secciones.
   *
   * `options` sigue yendo con la lista plana: es lo que usa el atajo numérico y
   * el respaldo cuando la lista interactiva falla. Las dos tienen que decir lo
   * mismo, así que las secciones se arman primero y la plana sale de ellas.
   */
  secciones?: SeccionLista[];
}

// Estado para flujos de varios pasos (comunicado, ver región, alta de
// cliente), por sesión. `clientes` solo lo usa la confirmación del alta.
const pendiente = new Map<string, { accion: string; clientes?: ClienteNuevo[] }>();

const AGREGAR = "➕ Agregar cliente";
const LEADS = "🧾 Leads del día";
const RECLAMOS = "🚨 Reclamos prioritarios";
const RESUMEN = "📊 Resumen del día";
const REPORTES = "📈 Reportes globales";
const SEMANAL = "📅 Reporte semanal";
const COMUNICADO = "📢 Enviar comunicado";
const REGION = "🌎 Ver una región";
const PRUEBA = "🧪 Probar como cliente";
const ALTA_ESCRIBIR = "✍️ Escribiendo los datos";
const ALTA_FOTO = "📷 Con una foto";
const ALTA_EXCEL = "📄 Con un Excel";
const GUARDAR = "✅ Guardar";
const CANCELAR = "✖️ Cancelar";

const VOLVER: Pick<AdminReply, "options" | "optionsButton" | "optionsTitle"> = {
  options: ["Volver al menú"],
  optionsButton: "Menú",
  optionsTitle: "Panel",
};

function norm(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

/**
 * Menú según el rol, agrupado por secciones.
 *
 * Nueve opciones en una lista plana no se leen: hay que recorrerlas todas para
 * encontrar la que uno busca, y el nombre solo no dice qué hace cada una. Por
 * eso van en grupos y cada una lleva una línea que la explica.
 *
 * OJO con el largo: Meta admite 10 filas EN TOTAL sumando las secciones, y lo
 * que sobra se cae sin avisar. El menú del Gerente General tiene 9.
 */
function menu(admin: Admin): AdminReply {
  const secciones: SeccionLista[] = [];

  const delDia: SeccionLista = {
    titulo: "Tu día",
    filas: [{ id: LEADS, titulo: LEADS, descripcion: "Los clientes nuevos de hoy" }],
  };
  if (admin.role !== "asesor") {
    delDia.filas.push(
      { id: RECLAMOS, titulo: RECLAMOS, descripcion: "Casos que hay que atender primero" },
      { id: RESUMEN, titulo: RESUMEN, descripcion: "Leads, reclamos y seguimientos de hoy" },
    );
  }
  secciones.push(delDia);

  secciones.push({
    titulo: "Cargar clientes",
    filas: [{ id: AGREGAR, titulo: AGREGAR, descripcion: "Escribiendo, con una foto o con un Excel" }],
  });

  if (admin.role === "gerente") {
    secciones.push({
      titulo: "Gerencia",
      filas: [
        { id: REPORTES, titulo: REPORTES, descripcion: "Conversaciones y leads por ciudad" },
        { id: SEMANAL, titulo: SEMANAL, descripcion: "Todos los leads de los últimos 7 días" },
        { id: COMUNICADO, titulo: COMUNICADO, descripcion: "Un mensaje para todos los asesores" },
        { id: REGION, titulo: REGION, descripcion: "Leads y reclamos de otra ciudad" },
      ],
    });
  }

  if (admin.role !== "asesor") {
    secciones.push({
      titulo: "Pruebas",
      filas: [{ id: PRUEBA, titulo: PRUEBA, descripcion: "Ver el bot como lo ve un cliente" }],
    });
  }

  const ambito =
    admin.role === "gerente"
      ? "Nacional 🇧🇴"
      : admin.sucursal && admin.role === "asesor"
        ? `${admin.sucursal} · ${admin.region}`
        : admin.region;

  return {
    text: `*Panel Gladymar*\n${admin.nombre} · ${ambito}\n\n¿Qué necesitás?`,
    // La plana sale de las secciones para que no puedan decir cosas distintas.
    options: secciones.flatMap((s) => s.filas.map((f) => f.id)),
    secciones,
    optionsButton: "Ver comandos",
    optionsTitle: "Comandos disponibles",
  };
}

const MENU_ALTA: AdminReply = {
  text: "➕ *Agregar cliente*\n\nPodés cargar *uno o varios* de una vez.\n¿Cómo lo querés hacer?",
  options: [ALTA_ESCRIBIR, ALTA_FOTO, ALTA_EXCEL, "Volver al menú"],
  secciones: [
    {
      titulo: "Uno o pocos",
      filas: [
        { id: ALTA_ESCRIBIR, titulo: ALTA_ESCRIBIR, descripcion: "Nombre, teléfono, ciudad y qué le interesa" },
        { id: ALTA_FOTO, titulo: ALTA_FOTO, descripcion: "Una tarjeta o la hoja donde los anotaste" },
      ],
    },
    {
      titulo: "Una lista larga",
      filas: [{ id: ALTA_EXCEL, titulo: ALTA_EXCEL, descripcion: "Un archivo .xlsx o .csv con tus contactos" }],
    },
    { titulo: "Salir", filas: [{ id: "Volver al menú", titulo: "Volver al menú" }] },
  ],
  optionsButton: "Elegir",
  optionsTitle: "Agregar cliente",
};

const CONFIRMAR: Pick<AdminReply, "options" | "optionsButton" | "optionsTitle"> = {
  options: [GUARDAR, CANCELAR],
  optionsButton: "Confirmar",
  optionsTitle: "Agregar cliente",
};

/**
 * Asesor al que se deriva automáticamente un lead según su ciudad.
 *
 * Usa el mismo padrón que hace la derivación de verdad (25 asesores, con la
 * sucursal resuelta). Antes miraba el mapa viejo de 7 nombres, así que el panel
 * podía decir "Derivado a Thalía Vera" mientras el aviso le había salido al
 * supervisor de Montero: el asesor leía un nombre y pasaba otra cosa.
 */
function asesorDe(ciudad?: string): string {
  if (!ciudad) return "Gerencia (sin ciudad)";
  return adminNombrePorCiudad(ciudad) ?? "Gerencia (ciudad sin asesor)";
}

function fmtItem(r: SolicitudReg): string {
  const p = r.prioridad === "critica" ? " 🔴" : r.prioridad === "alta" ? " 🟠" : "";
  const dig = (r.telefono || "").replace(/\D/g, "");
  const tel = dig ? `\n   📱 wa.me/${dig}` : "";
  return `• *${r.nombre || "Cliente"}* · ${r.ciudad || "?"}${p}${tel}\n   ${r.detalle}  _(${r.fecha})_\n   ➡️ Derivado a: *${asesorDe(r.ciudad)}*`;
}

async function listLeads(ciudad?: string): Promise<string> {
  const t = ciudad ? `en *${ciudad}*` : "a nivel *nacional*";
  try {
    const l = (await getLeads(ciudad)).filter((r) => esDeHoy(r.fecha));
    if (!l.length) return `📭 Sin leads nuevos hoy ${t}.`;
    return `🧾 *Leads del día* (${t}) — *${l.length}*\n\n` + l.map(fmtItem).join("\n\n");
  } catch (err) {
    console.error("Error obteniendo leads del día:", err);
    return `⚠️ No pude cargar los leads del día ${t} por un error interno. Ya quedó registrado en los logs.`;
  }
}
async function listReclamos(ciudad?: string): Promise<string> {
  const l = await getReclamos(ciudad);
  const t = ciudad ? `en *${ciudad}*` : "a nivel *nacional*";
  if (!l.length) return `No hay reclamos ${t}. 👌`;
  return `🚨 *Reclamos prioritarios* (${t}) — *${l.length}*\n\n` + l.map(fmtItem).join("\n\n");
}
/** Línea de "Conversaciones hoy": datos reales del Sheet; si no se puede leer, el contador en memoria como respaldo. */
async function lineaConversacionesHoy(): Promise<string> {
  const stats = await obtenerStatsHoy();
  if (stats) return `Conversaciones hoy: *${stats.conversacionesHoy}* (${stats.contactosUnicosHoy} clientes distintos)\n`;
  return `Conversaciones hoy: *${totalConversaciones()}*\n`;
}

async function resumen(ciudad?: string): Promise<string> {
  const k = await getKpis(ciudad);
  const t = ciudad ? `*${ciudad}*` : "*Nacional*";
  const conv = ciudad ? "" : await lineaConversacionesHoy();
  return (
    `📊 *Resumen de hoy* · ${t}\n\n${conv}` +
    `Leads/cotizaciones: *${k.leads}*\n` +
    `Reclamos: *${k.reclamos}* (prioritarios: ${k.reclamosPrioritarios})\n` +
    `Seguimientos: *${k.seguimientos}*`
  );
}
/** ¿El registro se creó dentro de los últimos 7 días (usa el timestamp real, no el texto de fecha)? */
function haceMenosDeUnaSemana(creadoEn: number): boolean {
  return Date.now() - creadoEn <= 7 * 24 * 60 * 60 * 1000;
}

async function reporteSemanalLeads(): Promise<string> {
  try {
    const leads = (await getLeads()).filter((r) => haceMenosDeUnaSemana(r.creadoEn));
    if (!leads.length) return "📅 *Reporte semanal de leads* (últimos 7 días)\n\nSin leads registrados en la última semana.";

    const porCiudad: Record<string, number> = {};
    for (const l of leads) {
      const c = l.ciudad || "Sin ciudad";
      porCiudad[c] = (porCiudad[c] || 0) + 1;
    }
    const resumenCiudades = Object.entries(porCiudad)
      .sort((a, b) => b[1] - a[1])
      .map(([c, n]) => `${c}: ${n}`)
      .join(" · ");

    return (
      `📅 *Reporte semanal de leads* (últimos 7 días) — *${leads.length}*\n${resumenCiudades}\n\n` +
      leads.map(fmtItem).join("\n\n")
    );
  } catch (err) {
    console.error("Error generando el reporte semanal de leads:", err);
    return "⚠️ No pude generar el reporte semanal de leads por un error interno. Ya quedó registrado en los logs.";
  }
}

/** Exportada para el reporte diario automático (index.ts), además del comando "Reportes globales". */
export async function reportes(): Promise<string> {
  const stats = await obtenerStatsHoy();
  let out = `📈 *Reporte global* · Bolivia\n\n${await lineaConversacionesHoy()}`;

  if (stats && Object.keys(stats.porCiudadHoy).length) {
    out += `\n*Clientes distintos hoy por ciudad:*\n`;
    out += Object.entries(stats.porCiudadHoy)
      .sort((a, b) => b[1] - a[1])
      .map(([ciudad, n]) => `${ciudad}: ${n}`)
      .join("\n");
    out += "\n";
  }

  let porCiudadKpis = "";
  for (const c of ciudadesAdmin()) {
    const k = await getKpis(c);
    if (k.leads || k.reclamos || k.seguimientos) {
      porCiudadKpis += `\n*${c}*: ${k.leads} leads · ${k.reclamos} reclamos · ${k.seguimientos} seguim.`;
    }
  }
  if (porCiudadKpis) out += `\n*Leads/reclamos registrados en esta sesión:*${porCiudadKpis}`;

  return out;
}

/** Arranca el paso de "esperando los datos" o "esperando la foto". */
function pedirDatos(sessionId: string, modo: "texto" | "foto" | "excel"): AdminReply {
  pendiente.set(sessionId, { accion: `alta_${modo}` });
  if (modo === "excel") {
    return {
      text:
        "📄 Mandame el archivo como *documento* (Excel .xlsx o CSV), no como foto.\n\n" +
        "Necesito una columna de *NOMBRE* o *CLIENTE*. Si además tiene *TELÉFONO*, *CIUDAD* o *INTERÉS*, las uso.\n" +
        "No importa el orden de las columnas ni que haya otras de más.\n\n" +
        "Te muestro el resumen antes de guardar nada. Escribí *cancelar* para salir.",
    };
  }
  if (modo === "texto") {
    return {
      text:
        "✍️ Mandame los datos en *un solo mensaje*. Puede ser *uno o varios* clientes.\n\n" +
        "Uno:\n_Juan Pérez, 71234567, Montero, porcelanato 60x60 para 80 m²_\n\n" +
        "Varios: uno por línea.\n_Juan Pérez, 71234567, Montero, porcelanato 60x60_\n" +
        "_Rosa Limachi, 69874521, El Alto, cerámica para baño_\n\n" +
        "Te muestro lo que entendí antes de guardar nada. Escribí *cancelar* para salir.",
    };
  }
  return {
    text:
      "📷 Mandame la *foto* con los datos: una tarjeta, la hoja donde los anotaste o una captura.\n\n" +
      "Puede tener *uno o varios* clientes: si es una lista, los leo todos.\n\n" +
      "Te muestro lo que entendí antes de guardar nada. Escribí *cancelar* para salir.",
  };
}

/** Muestra lo leído y deja la sesión esperando el Guardar/Cancelar. */
function pasarAConfirmar(sessionId: string, leido: LecturaClientes): AdminReply {
  pendiente.set(sessionId, { accion: "alta_confirmar", clientes: leido.clientes });
  return { text: resumenParaConfirmar(leido.clientes, leido.recortados), ...CONFIRMAR };
}

export async function handleAdminCommand(
  sessionId: string,
  admin: Admin,
  raw: string,
  extra?: { imageId?: string; documentId?: string; documentName?: string },
): Promise<AdminReply> {
  const text = norm(raw);
  const region = admin.role === "gerente" ? undefined : admin.region;

  // Flujos pendientes de varios pasos.
  const pend = pendiente.get(sessionId);
  if (pend) {
    const cancelado = /^(cancelar|salir|volver|volver al menu|menu|menú)$/.test(text) || text === norm(CANCELAR);
    if (cancelado) {
      pendiente.delete(sessionId);
      return { ...menu(admin), text: "Listo, no guardé nada.\n\n" + menu(admin).text };
    }

    if (pend.accion === "alta_excel") {
      pendiente.delete(sessionId);
      if (!extra?.documentId) {
        pendiente.set(sessionId, { accion: "alta_excel" });
        return {
          text:
            "Necesito el *archivo* para leerlo. Mandámelo como documento (Excel o CSV), o escribí *cancelar*.\n\n" +
            "_Si lo mandás como foto no lo puedo leer celda por celda._",
        };
      }
      const leido = await leerClientesDePlanilla(extra.documentId, extra.documentName);
      if (leido.error) {
        pendiente.set(sessionId, { accion: "alta_excel" });
        return { text: `⚠️ ${leido.error}` };
      }
      if (!leido.clientes.length) {
        pendiente.set(sessionId, { accion: "alta_excel" });
        return { text: "No encontré ninguna fila con nombre en esa planilla. ¿Revisás que tenga datos debajo del encabezado?" };
      }
      pendiente.set(sessionId, { accion: "alta_confirmar", clientes: leido.clientes });
      return { text: resumenPlanilla(leido), ...CONFIRMAR };
    }

    if (pend.accion === "alta_texto" || pend.accion === "alta_foto") {
      pendiente.delete(sessionId);
      const esperaFoto = pend.accion === "alta_foto";
      if (esperaFoto && !extra?.imageId) {
        // Se queda esperando: perder el paso obligaría a empezar de cero.
        pendiente.set(sessionId, { accion: "alta_foto" });
        return { text: "Necesito la *foto* para leer los datos. Mandámela, o escribí *cancelar*." };
      }
      // Si mandó foto cuando dijo "escribiendo", se lee la foto igual: lo que
      // quiere es cargar el cliente, no cumplir el formulario.
      const leido =
        esperaFoto || extra?.imageId
          ? await leerClientesDeFoto(extra!.imageId as string)
          : await leerClientesDeTexto(raw);

      if (leido.error) {
        pendiente.set(sessionId, { accion: pend.accion });
        return { text: `⚠️ ${leido.error}` };
      }
      if (!leido.clientes.length) {
        pendiente.set(sessionId, { accion: pend.accion });
        return {
          text:
            "No distinguí ningún contacto ahí. " +
            (esperaFoto
              ? "¿Probás con una foto más nítida, o me lo escribís?"
              : "Mandámelo así: *nombre, teléfono, ciudad, qué le interesa*."),
        };
      }
      return pasarAConfirmar(sessionId, leido);
    }

    if (pend.accion === "alta_confirmar") {
      pendiente.delete(sessionId);
      if (/(guardar|si|s[ií]|ok|dale|confirmar)/.test(text) || text === norm(GUARDAR)) {
        const res = await guardarClientes(pend.clientes ?? [], admin);
        return { text: res, ...VOLVER };
      }
      // Cualquier otra cosa se toma como una corrección: se relee el texto.
      const releido = await leerClientesDeTexto(raw);
      if (releido.clientes.length) return pasarAConfirmar(sessionId, releido);
      return { ...menu(admin), text: "No guardé nada.\n\n" + menu(admin).text };
    }

    pendiente.delete(sessionId);
    if (pend.accion === "comunicado") {
      return { text: `✅ Comunicado enviado a los asesores (simulado):\n\n"${raw.trim()}"`, ...VOLVER };
    }
    if (pend.accion === "region") {
      const ciudad = ciudadesAdmin().find((c) => norm(c).includes(text)) || raw.trim();
      return { text: `${await listLeads(ciudad)}\n\n${await listReclamos(ciudad)}`, ...VOLVER };
    }
  }

  // Una foto suelta, sin haber pedido nada: se asume que es un cliente para
  // cargar. Es lo único que un admin manda por foto, y pedirle que primero
  // entre al menú sería hacerlo repetir el envío. Vale con o sin epígrafe: el
  // epígrafe de una foto de contacto es una nota, no un comando.
  // Una planilla suelta: se asume que es una lista de clientes, igual que la foto.
  if (extra?.documentId && /\.(xlsx|xls|csv)$/i.test(extra.documentName || "")) {
    const leido = await leerClientesDePlanilla(extra.documentId, extra.documentName);
    if (leido.error) return { text: `⚠️ ${leido.error}`, ...VOLVER };
    if (leido.clientes.length) {
      pendiente.set(sessionId, { accion: "alta_confirmar", clientes: leido.clientes });
      return { text: resumenPlanilla(leido), ...CONFIRMAR };
    }
    return { text: "No encontré ninguna fila con nombre en esa planilla.", ...VOLVER };
  }

  if (extra?.imageId) {
    const leido = await leerClientesDeFoto(extra.imageId);
    if (leido.error) return { text: `⚠️ ${leido.error}`, ...VOLVER };
    if (leido.clientes.length) return pasarAConfirmar(sessionId, leido);
    return { text: "No distinguí ningún contacto en esa foto. ¿Probás con una más nítida?", ...VOLVER };
  }

  // Atajo numérico: si responde con un número, lo mapeamos a la opción del menú.
  if (/^\d+$/.test(text)) {
    const opciones = menu(admin).options || [];
    const sel = opciones[parseInt(text, 10) - 1];
    if (sel) return handleAdminCommand(sessionId, admin, sel, extra);
  }

  if (!text || /(menu|menú|ayuda|hola|inicio|volver|comandos)/.test(text)) return menu(admin);

  // Alta de clientes: la tienen los tres roles.
  if (text === norm(ALTA_ESCRIBIR) || /^(escribiendo|escribir|escrito|texto)/.test(text)) {
    return pedirDatos(sessionId, "texto");
  }
  if (text === norm(ALTA_FOTO) || /^(con una foto|foto|imagen|captura)/.test(text)) {
    return pedirDatos(sessionId, "foto");
  }
  if (text === norm(ALTA_EXCEL) || /^(con un excel|excel|planilla|archivo|csv|hoja)/.test(text)) {
    return pedirDatos(sessionId, "excel");
  }
  if (/(agregar|a[nñ]adir|cargar|nuevo|alta).*(cliente|contacto)|^agregar cliente/.test(text)) {
    return MENU_ALTA;
  }

  // "Probar como cliente" lo atiende index.ts ANTES de llegar acá, porque
  // necesita prender el modo demo en el estado de la sesión de WhatsApp. Esta
  // rama es solo para el simulador web, donde ese modo no existe: sin ella, una
  // opción que figura en el menú contestaba "No reconocí ese comando".
  if (/probar/.test(text) && /(cliente|crm|agente|sistema|demo)/.test(text)) {
    return {
      text:
        "🧪 *Probar como cliente* funciona desde WhatsApp: ahí te atiendo como si fueras un cliente " +
        "y volvés al panel escribiendo *salir*.",
      ...VOLVER,
    };
  }

  if (/semanal/.test(text)) {
    if (admin.role === "gerente") return { text: await reporteSemanalLeads(), ...VOLVER };
    return { text: "Ese comando es exclusivo del Gerente General. Tu panel cubre solo tu región.", ...VOLVER };
  }
  if (/(lead|cotiz)/.test(text)) return { text: await listLeads(region), ...VOLVER };

  // Reclamos y resumen son de supervisión: el asesor comercial no los ve.
  if (/(reclamo)/.test(text) || /(resumen|kpi|del dia)/.test(text)) {
    if (admin.role === "asesor") {
      return { text: "Ese comando es de los supervisores. Tu panel cubre tus leads y el alta de clientes.", ...VOLVER };
    }
    if (/reclamo/.test(text)) return { text: await listReclamos(region), ...VOLVER };
    return { text: await resumen(region), ...VOLVER };
  }

  if (admin.role === "gerente") {
    if (/(reporte|global)/.test(text)) return { text: await reportes(), ...VOLVER };
    if (/(comunicado|broadcast|aviso)/.test(text)) {
      pendiente.set(sessionId, { accion: "comunicado" });
      return { text: "✍️ Escribe el *comunicado* que deseas enviar a los asesores:" };
    }
    if (/(regi[oó]n|ciudad)/.test(text)) {
      pendiente.set(sessionId, { accion: "region" });
      return { text: "¿Qué región deseas consultar?", options: ciudadesAdmin(), optionsButton: "Elegir región", optionsTitle: "Regiones" };
    }
  } else if (/(reporte|global|comunicado|broadcast|regi[oó]n)/.test(text)) {
    return { text: "Ese comando es exclusivo del Gerente General. Tu panel cubre solo tu región.", ...VOLVER };
  }

  const m = menu(admin);
  return { ...m, text: `No reconocí ese comando.\n\n${m.text}` };
}
