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
import { asesoresDeDepartamento, departamentosConAsesores } from "./asesores.js";
import { departamentoDeLugar } from "../knowledge/departamentos.js";
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
const pendiente = new Map<
  string,
  {
    accion: string;
    clientes?: ClienteNuevo[];
    transcripcion?: string;
    departamento?: string;
    /** Reparto: cuántos de la lista ya tienen asesor asignado. */
    indice?: number;
    /** Reparto: a quién le toca la tanda que se está midiendo. */
    asesorTanda?: string;
  }
>();

// Prefijos de los ids de la lista. El título de la fila es el nombre a secas,
// para que se lea; el prefijo viaja en el id, que es lo que vuelve al tocarla.
const P_ASESOR = "ASESOR::";
const P_SUCURSAL = "SUCURSAL::";
const P_DEPTO = "DEPTO::";
const AUTO = `${P_ASESOR}__sugerido__`;
const OTRO_DEPTO = `${P_DEPTO}__elegir__`;
const REPARTIR = `${P_ASESOR}__repartir__`;
const P_CUANTOS = "CUANTOS::";

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

/** Cuántas filas quedan libres en la lista de WhatsApp (máximo 10). */
const TOPE_FILAS = 10;

/**
 * Paso de asignación: muestra lo leído y deja elegir a quién se le asigna.
 *
 * Va DESPUÉS de leer y ANTES de guardar, porque quien carga el contacto sabe
 * con quién habló el cliente y la zona no: la regla por zona es un buen valor
 * por defecto, no una verdad. Un asesor casi siempre se lo asigna a sí mismo;
 * un gerente reparte.
 */
function pasarAElegirAsesor(
  sessionId: string,
  admin: Admin,
  clientes: ClienteNuevo[],
  transcripcion: string | undefined,
  cuerpo: string,
): AdminReply {
  const depto = departamentoDeLugar(clientes[0]?.ciudad);
  pendiente.set(sessionId, { accion: "alta_asesor", clientes, transcripcion, departamento: depto });
  return listaDeAsesores(admin, depto, cuerpo, clientes.length);
}

/**
 * Arma la lista de a quién asignar, respetando el tope de filas de WhatsApp.
 * Exportada para poder verificar el tope sin levantar WhatsApp: Santa Cruz
 * tiene doce asesores y la lista admite diez filas, así que es el caso que hay
 * que probar y el que nunca se ve hasta que Meta rechaza el mensaje.
 */
export function listaDeAsesores(
  admin: Admin,
  depto: string | undefined,
  cuerpo: string,
  cuantos: number,
  opciones: { repartir?: boolean } = { repartir: true },
): AdminReply {
  const secciones: SeccionLista[] = [];
  const ofreceRepartir = Boolean(opciones.repartir) && cuantos > 1;
  const sugerido = adminNombrePorCiudad(cuerpoCiudad(depto));

  if (sugerido) {
    secciones.push({
      titulo: "Sugerido por la zona",
      filas: [{ id: AUTO, titulo: sugerido, descripcion: cuantos > 1 ? "El que corresponde a cada uno" : "El que corresponde por zona" }],
    });
  }
  // "Yo mismo" solo si quien carga figura en el padrón: el Gerente General y
  // Soporte Prime no atienden clientes, asignárselos sería inventar una cartera.
  const yo = admin.role !== "gerente" ? admin.nombre : undefined;
  if (yo && yo !== sugerido) {
    secciones.push({
      titulo: "Yo",
      filas: [{ id: `${P_ASESOR}${yo}`, titulo: `👤 ${yo}`, descripcion: admin.sucursal ?? "Me lo asigno a mí" }],
    });
  }

  if (ofreceRepartir) {
    secciones.push({
      titulo: "Varios asesores",
      filas: [
        {
          id: REPARTIR,
          titulo: "✂️ Repartir entre varios",
          descripcion: `Dividir los ${cuantos} entre distintos asesores`,
        },
      ],
    });
  }

  const usadas = secciones.reduce((n, s) => n + s.filas.length, 0);
  const libres = TOPE_FILAS - usadas - 1; // -1 para "otro departamento"
  const delDepto = asesoresDeDepartamento(depto).filter((a) => a.nombre !== sugerido && a.nombre !== yo);

  if (depto && delDepto.length && delDepto.length <= libres) {
    secciones.push({
      titulo: depto,
      filas: delDepto.map((a) => ({
        id: `${P_ASESOR}${a.nombre}`,
        titulo: a.nombre,
        descripcion: a.sucursalCanonica || a.sucursal,
      })),
    });
  } else if (depto && delDepto.length) {
    // No entran: se elige primero la sucursal. Santa Cruz tiene doce asesores
    // y la lista de WhatsApp admite diez filas en total.
    const sucursales = [...new Set(delDepto.map((a) => a.sucursalCanonica || a.sucursal))];
    secciones.push({
      titulo: `${depto} · elegí el showroom`,
      filas: sucursales.slice(0, libres).map((suc) => ({
        id: `${P_SUCURSAL}${suc}`,
        titulo: suc,
        descripcion: (() => {
          const n = delDepto.filter((a) => (a.sucursalCanonica || a.sucursal) === suc).length;
          return n === 1 ? "1 asesor" : `${n} asesores`;
        })(),
      })),
    });
  }

  secciones.push({
    titulo: "Otro",
    filas: [{ id: OTRO_DEPTO, titulo: "🌎 Otro departamento", descripcion: "Buscar el asesor en otra región" }],
  });

  return {
    text: cuerpo,
    options: secciones.flatMap((s) => s.filas.map((f) => f.id)),
    secciones,
    optionsButton: "Asignar a",
    optionsTitle: "¿A quién se lo asigno?",
  };
}

/**
 * Cómo quedó repartida la lista, por asesor y en el orden en que se asignó.
 *
 * Treinta filas no se revisan en un teléfono; los totales por asesor sí, y son
 * lo que de verdad hay que mirar antes de guardar: si alguien se llevó
 * veinticinco y otro cinco, eso se ve acá y no contando renglones.
 */
function resumenReparto(clientes: ClienteNuevo[]): string {
  const porAsesor = new Map<string, number>();
  for (const c of clientes) {
    const quien = c.asesor || adminNombrePorCiudad(c.ciudad) || "Sin asesor";
    porAsesor.set(quien, (porAsesor.get(quien) ?? 0) + 1);
  }
  return [...porAsesor].map(([quien, n]) => `   • *${quien}*: ${n} cliente${n === 1 ? "" : "s"}`).join("\n");
}

/**
 * Le pone `asesor` a una tanda de la lista, empezando en `desde`.
 *
 * Nunca asigna más de los que quedan: pedir 10 cuando quedan 3 asigna 3 y
 * termina. Exportada porque es la aritmética del reparto, que es justo lo que
 * no se puede verificar mirando la pantalla — un índice corrido deja clientes
 * con el asesor equivocado sin que nada falle.
 */
export function repartirTanda(
  clientes: ClienteNuevo[],
  desde: number,
  cuantos: number,
  asesor: string,
): { clientes: ClienteNuevo[]; hasta: number } {
  const n = Math.max(0, Math.min(cuantos, clientes.length - desde));
  const hasta = desde + n;
  return {
    clientes: clientes.map((c, i) => (i >= desde && i < hasta ? { ...c, asesor } : c)),
    hasta,
  };
}

/** Pregunta cuántos de los que quedan van para el asesor ya elegido. */
function preguntarCuantos(sessionId: string, pend: NonNullable<ReturnType<typeof pendiente.get>>): AdminReply {
  const total = pend.clientes?.length ?? 0;
  const hechos = pend.indice ?? 0;
  const quedan = total - hechos;
  // Tandas redondas, más "todos los que quedan". Nunca se ofrece un número
  // mayor al que queda: elegir 10 cuando quedan 3 es una trampa, no una opción.
  const tandas = [5, 10, 15, 20, 25].filter((n) => n < quedan);
  const filas = [
    ...tandas.map((n) => ({ id: `${P_CUANTOS}${n}`, titulo: `${n} clientes` })),
    {
      id: `${P_CUANTOS}${quedan}`,
      titulo: quedan === 1 ? "El que queda" : `Todos los que quedan (${quedan})`,
    },
  ];
  return {
    text:
      `✂️ *Reparto*\n\nQuedan *${quedan}* sin asignar de ${total}.\n\n` +
      `¿Cuántos le doy a *${pend.asesorTanda}*?\n_También podés escribir el número._`,
    options: filas.map((f) => f.id),
    secciones: [{ titulo: "Cuántos", filas }],
    optionsButton: "Elegir",
    optionsTitle: "Cuántos clientes",
  };
}

/** Un lugar cualquiera del departamento, para preguntarle al padrón por él. */
function cuerpoCiudad(depto?: string): string | undefined {
  return depto;
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

/**
 * Muestra lo leído y abre la elección de asesor.
 *
 * El texto con los datos va en el cuerpo del mismo mensaje que la lista: así el
 * asesor verifica y asigna en un solo paso, y recién después confirma.
 */
function pasarAConfirmar(sessionId: string, leido: LecturaClientes, admin: Admin): AdminReply {
  const cuerpo =
    leido.clientes.length > 5
      ? resumenPlanilla(leido)
          .replace(/\n\n¿Los guardo\?$/, "")
          .replace(/\n_Comparalo con el papel antes de confirmar\._$/, "")
      : resumenParaConfirmar(leido.clientes, leido.recortados, leido.transcripcion)
          .replace(/\n\n¿Lo guardo\?[\s\S]*$/, "")
          .replace(/\n\n¿Los guardo\?[\s\S]*$/, "");
  return pasarAElegirAsesor(sessionId, admin, leido.clientes, leido.transcripcion, `${cuerpo}\n\n*¿A quién se lo asigno?*`);
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
      return pasarAConfirmar(sessionId, leido, admin);
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
        // Se muestra lo poco que se leyó: "no pude" a secas no dice si el
        // problema es la foto, la letra o que apuntó a otra cosa.
        const pista = leido.transcripcion?.trim()
          ? `\n\n_Alcancé a leer:_ "${leido.transcripcion.trim().slice(0, 200)}"`
          : "";
        return {
          text:
            "No pude leer los datos con seguridad, así que no guardo nada." +
            (esperaFoto
              ? " Probá con la foto *derecha* (sin girar) y más cerca del papel, o escribime los datos."
              : " Mandámelo así: *nombre, teléfono, ciudad, qué le interesa*.") +
            pista,
        };
      }
      return pasarAConfirmar(sessionId, leido, admin);
    }

    if (pend.accion === "alta_asesor") {
      const clientes = pend.clientes ?? [];
      const crudo = raw.trim();

      // Elegir otro departamento: se lista y se vuelve a preguntar.
      if (crudo === OTRO_DEPTO) {
        pendiente.set(sessionId, { ...pend, accion: "alta_depto" });
        return {
          text: "¿De qué departamento es el asesor?",
          options: departamentosConAsesores().map((d) => `${P_DEPTO}${d}`),
          secciones: [
            {
              titulo: "Departamentos",
              filas: departamentosConAsesores().map((d) => ({ id: `${P_DEPTO}${d}`, titulo: d })),
            },
          ],
          optionsButton: "Elegir",
          optionsTitle: "Departamento",
        };
      }

      // Elegir primero el showroom, cuando el departamento tiene muchos.
      if (crudo.startsWith(P_SUCURSAL)) {
        const suc = crudo.slice(P_SUCURSAL.length);
        const deLaSucursal = asesoresDeDepartamento(pend.departamento).filter(
          (a) => (a.sucursalCanonica || a.sucursal) === suc,
        );
        pendiente.set(sessionId, { ...pend, accion: "alta_asesor" });
        return {
          text: `*${suc}*\n\n¿A quién se lo asigno?`,
          options: deLaSucursal.map((a) => `${P_ASESOR}${a.nombre}`),
          secciones: [
            {
              titulo: suc,
              filas: deLaSucursal.map((a) => ({
                id: `${P_ASESOR}${a.nombre}`,
                titulo: a.nombre,
                descripcion: a.esSupervisor ? "Supervisor" : undefined,
              })),
            },
          ],
          optionsButton: "Asignar a",
          optionsTitle: suc,
        };
      }

      // Repartir la lista entre varios: arranca el ciclo por tandas.
      if (crudo === REPARTIR) {
        pendiente.set(sessionId, { ...pend, accion: "alta_reparto_quien", indice: 0 });
        return listaDeAsesores(
          admin,
          pend.departamento,
          `✂️ *Reparto*\n\nQuedan *${clientes.length}* sin asignar.\n\n¿A quién le doy los primeros?`,
          clientes.length,
          { repartir: false },
        );
      }

      // Elección hecha (o "dejar el sugerido").
      if (crudo === AUTO || crudo.startsWith(P_ASESOR)) {
        const elegido = crudo === AUTO ? undefined : crudo.slice(P_ASESOR.length);
        const conAsesor = clientes.map((c) => ({ ...c, asesor: elegido }));
        pendiente.set(sessionId, { accion: "alta_confirmar", clientes: conAsesor });
        return {
          text: resumenParaConfirmar(conAsesor, 0, pend.transcripcion),
          ...CONFIRMAR,
        };
      }

      // Cualquier otra cosa: se vuelve a preguntar en vez de asumir.
      pendiente.set(sessionId, pend);
      return listaDeAsesores(admin, pend.departamento, "No entendí a quién asignárselo.\n\n*¿A quién se lo asigno?*", clientes.length);
    }

    if (pend.accion === "alta_depto") {
      const crudo = raw.trim();
      if (!crudo.startsWith(P_DEPTO)) {
        pendiente.set(sessionId, pend);
        return { text: "Elegí un departamento de la lista, o escribí *cancelar*." };
      }
      const depto = crudo.slice(P_DEPTO.length);
      pendiente.set(sessionId, { ...pend, accion: "alta_asesor", departamento: depto });
      return listaDeAsesores(admin, depto, `*${depto}*\n\n¿A quién se lo asigno?`, pend.clientes?.length ?? 1);
    }

    // ── Reparto por tandas ────────────────────────────────────────────────
    // Se asignan en ORDEN: los primeros N al primero elegido, los siguientes al
    // que sigue. Repartir por orden es lo que hace alguien con una lista en la
    // mano, y además deja ver de una cuántos le tocaron a cada uno.
    if (pend.accion === "alta_reparto_quien") {
      const clientes = pend.clientes ?? [];
      const crudo = raw.trim();
      if (crudo === OTRO_DEPTO) {
        pendiente.set(sessionId, { ...pend, accion: "alta_reparto_depto" });
        return {
          text: "¿De qué departamento es el asesor?",
          options: departamentosConAsesores().map((d) => `${P_DEPTO}${d}`),
          secciones: [
            { titulo: "Departamentos", filas: departamentosConAsesores().map((d) => ({ id: `${P_DEPTO}${d}`, titulo: d })) },
          ],
          optionsButton: "Elegir",
          optionsTitle: "Departamento",
        };
      }
      if (crudo.startsWith(P_SUCURSAL)) {
        const suc = crudo.slice(P_SUCURSAL.length);
        const deLaSucursal = asesoresDeDepartamento(pend.departamento).filter(
          (a) => (a.sucursalCanonica || a.sucursal) === suc,
        );
        pendiente.set(sessionId, pend);
        return {
          text: `*${suc}*\n\n¿A quién le doy la próxima tanda?`,
          options: deLaSucursal.map((a) => `${P_ASESOR}${a.nombre}`),
          secciones: [
            {
              titulo: suc,
              filas: deLaSucursal.map((a) => ({
                id: `${P_ASESOR}${a.nombre}`,
                titulo: a.nombre,
                descripcion: a.esSupervisor ? "Supervisor" : undefined,
              })),
            },
          ],
          optionsButton: "Asignar a",
          optionsTitle: suc,
        };
      }
      if (crudo === AUTO || crudo.startsWith(P_ASESOR)) {
        const quien =
          crudo === AUTO ? adminNombrePorCiudad(pend.departamento) : crudo.slice(P_ASESOR.length);
        if (!quien) {
          pendiente.set(sessionId, pend);
          return { text: "Esa zona no tiene asesor asignado. Elegí uno de la lista." };
        }
        const conQuien = { ...pend, accion: "alta_reparto_cuantos", asesorTanda: quien };
        pendiente.set(sessionId, conQuien);
        return preguntarCuantos(sessionId, conQuien);
      }
      pendiente.set(sessionId, pend);
      return listaDeAsesores(admin, pend.departamento, "Elegí un asesor de la lista.", clientes.length, {
        repartir: false,
      });
    }

    if (pend.accion === "alta_reparto_depto") {
      const clientes = pend.clientes ?? [];
      const crudo = raw.trim();
      if (!crudo.startsWith(P_DEPTO)) {
        pendiente.set(sessionId, pend);
        return { text: "Elegí un departamento de la lista, o escribí *cancelar*." };
      }
      const depto = crudo.slice(P_DEPTO.length);
      pendiente.set(sessionId, { ...pend, accion: "alta_reparto_quien", departamento: depto });
      return listaDeAsesores(admin, depto, `*${depto}*\n\n¿A quién le doy la próxima tanda?`, clientes.length, {
        repartir: false,
      });
    }

    if (pend.accion === "alta_reparto_cuantos") {
      const clientes = pend.clientes ?? [];
      const crudo = raw.trim();
      const total = clientes.length;
      const hechos = pend.indice ?? 0;
      const quedan = total - hechos;
      const pedido = crudo.startsWith(P_CUANTOS)
        ? Number(crudo.slice(P_CUANTOS.length))
        : /^\d+$/.test(crudo)
          ? Number(crudo)
          : NaN;
      if (!Number.isFinite(pedido) || pedido < 1) {
        pendiente.set(sessionId, pend);
        return preguntarCuantos(sessionId, pend);
      }
      const { clientes: asignados, hasta: nuevoIndice } = repartirTanda(
        clientes,
        hechos,
        pedido,
        pend.asesorTanda ?? "",
      );

      if (nuevoIndice >= total) {
        pendiente.set(sessionId, { accion: "alta_confirmar", clientes: asignados });
        return {
          text:
            `✂️ *Reparto terminado* — ${total} cliente(s)\n\n${resumenReparto(asignados)}\n\n¿Los guardo?`,
          ...CONFIRMAR,
        };
      }
      const sigue = { ...pend, accion: "alta_reparto_quien", clientes: asignados, indice: nuevoIndice };
      pendiente.set(sessionId, sigue);
      return listaDeAsesores(
        admin,
        pend.departamento,
        `✂️ *Reparto*\n\n${resumenReparto(asignados.slice(0, nuevoIndice))}\n\n` +
          `Quedan *${total - nuevoIndice}* sin asignar.\n¿A quién le doy los siguientes?`,
        total,
        { repartir: false },
      );
    }

    if (pend.accion === "alta_confirmar") {
      pendiente.delete(sessionId);
      if (/(guardar|si|s[ií]|ok|dale|confirmar)/.test(text) || text === norm(GUARDAR)) {
        const res = await guardarClientes(pend.clientes ?? [], admin);
        return { text: res, ...VOLVER };
      }
      // Cualquier otra cosa se toma como una corrección: se relee el texto.
      const releido = await leerClientesDeTexto(raw);
      if (releido.clientes.length) return pasarAConfirmar(sessionId, releido, admin);
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
      return pasarAConfirmar(sessionId, leido, admin);
    }
    return { text: "No encontré ninguna fila con nombre en esa planilla.", ...VOLVER };
  }

  if (extra?.imageId) {
    const leido = await leerClientesDeFoto(extra.imageId);
    if (leido.error) return { text: `⚠️ ${leido.error}`, ...VOLVER };
    if (leido.clientes.length) return pasarAConfirmar(sessionId, leido, admin);
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
