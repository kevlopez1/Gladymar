/**
 * Punto de entrada: servidor HTTP que conecta WhatsApp Cloud API con el agente.
 *
 *   GET  /webhook  -> verificación del webhook con Meta
 *   POST /webhook  -> recepción de mensajes entrantes
 *   GET  /health   -> healthcheck
 */
import express from "express";
import path from "node:path";
import { readFileSync } from "node:fs";
import { config, isWhatsAppConfigured } from "./config.js";
import { GladymarAgent, type AgentReply } from "./agent/brain.js";
import { generarCotizacionPDF } from "./agent/cotizacionPdf.js";
import { bs, type Cotizacion } from "./agent/cotizacion.js";
import { resumenUso, fechaBolivia, PRECIOS_USD_POR_MILLON } from "./agent/uso.js";
import { InMemorySessionStore } from "./session/store.js";
import { sendTemplateCrudo, registrarNumero } from "./whatsapp/client.js";
import { leerPlantilla, listarPlantillas } from "./whatsapp/plantillas.js";
import { sendText, sendBotonUrl, sendDocument, sendInteractiveList, sendInteractiveSections, sendTemplate, downloadMedia, downloadDocumento, markAsRead, markReadAndTyping } from "./whatsapp/client.js";
import { verifyWebhook, parseIncomingMessages, parseStatusUpdates } from "./whatsapp/webhook.js";
import { SurveyScheduler, buildSurveyMessage } from "./session/survey.js";
import { SheetsLogger, nowBolivia } from "./integrations/sheets.js";
import { CrmIngest, stageDeTipo, tipoSolicitudCrm } from "./integrations/crm.js";
import { getAdminByPhone, adminFromRole, adminTelefonoPorCiudad, adminNombrePorCiudad, ADMIN_TELEFONO, adminRoster } from "./admin/roles.js";
import { asesorDeCliente } from "./admin/reparto.js";
import { handleAdminCommand, reportes, type AdminReply } from "./admin/commands.js";
import { bumpConversacion } from "./admin/data.js";
import { ciudadesConSucursal } from "./knowledge/sucursales.js";
import { chequearNotificacionesPedidos } from "./integrations/pedidoEstados.js";
import { procesarColaAvisos, anotarFalloTardio } from "./integrations/colaAvisos.js";
import { parseCSV } from "./util/csv.js";
import {
  canalDelPayload,
  parseMensajesMeta,
  enviarMeta,
  metaHabilitado,
  comoContactar,
  idParaCrm,
  nombreCanal,
  type Canal,
  type MensajeMeta,
} from "./meta/messenger.js";
import {
  sondeoHabilitado,
  sondearMensajes,
  marcarAtendido,
  yaAtendido,
  marcarTodoComoVisto,
} from "./meta/sondeo.js";
import { datosDePagina, suscribirPagina } from "./meta/tokenPagina.js";
import { insertarConversacion, obtenerConversaciones, registrarDerivacion, resumenLeads, resultadosRegistrados, primeraVez, borrarMarca } from "./db/index.js";
import {
  seguimientoAsesorHabilitado,
  pendientes as seguimientosPorPreguntar,
  marcarPreguntado,
  textoPregunta,
  RESPUESTAS,
  registrarRespuesta,
  acuse,
} from "./admin/seguimientoAsesor.js";
import { pideDimensionViva } from "./knowledge/dimensionViva.js";
import { departamentoDeLugar, mapaMunicipios, municipiosReconocidos } from "./knowledge/departamentos.js";
import { asegurarPlantillaAvisos, asegurarPlantillaSeguimiento, resumenLead, esFalloDeVentana } from "./whatsapp/plantillas.js";

const sheets = new SheetsLogger(config.sheets.webhookUrl);
const crm = new CrmIngest(config.crm.ingestUrl, config.crm.ingestToken);

// Ciudad conocida por usuario (para mandarla SIEMPRE al CRM, aunque no haya
// solicitud). La agente pregunta la ciudad al inicio; acá la recordamos.
const ciudadPorUsuario = new Map<string, string>();
const CIUDADES = ciudadesConSucursal();

/** Detecta la ciudad mencionada en un texto (contra las ciudades con sucursal). */
function detectarCiudad(text: string): string | undefined {
  const t = (text || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  for (const c of CIUDADES) {
    const cn = c.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    if (new RegExp(`\\b${cn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t)) return c;
  }
  if (/\bsanta\s*cruz\b|\bsta\.?\s*cruz\b/.test(t)) return "Santa Cruz";
  return undefined;
}

const store = new InMemorySessionStore(config.session.ttlMinutes);
const agent = new GladymarAgent({
  apiKey: config.anthropic.apiKey,
  model: config.anthropic.model,
  store,
});

// Encuesta de satisfacción: se envía tras N minutos de inactividad (fin de conversación).
const survey = new SurveyScheduler({
  delayMs: config.survey.delayMinutes * 60 * 1000,
  onFire: async (userId) => {
    try {
      await sendText(userId, buildSurveyMessage(config.survey.url));
      console.log(`📨 Encuesta de satisfacción enviada a ${userId}`);
    } catch (err) {
      console.error(`No se pudo enviar la encuesta a ${userId}:`, err);
    }
  },
});

const app = express();
app.use(express.json());

// Demo web (réplica de WhatsApp) servida desde /public
app.use(express.static(path.join(process.cwd(), "public")));

// Healthcheck
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "gladymar-whatsapp-agent" });
});

// Migración única del histórico del Google Sheet al CRM de Prime.
// Se abre: /admin/backfill-crm?key=TU_CLAVE  (BACKFILL_KEY en el entorno).
// Arranca en segundo plano y responde al instante; refrescá la URL para ver el avance.
// Requiere que la hoja esté compartida como "cualquiera con el link: Lector".
const backfill = { running: false, total: 0, ok: 0, fail: 0, skip: 0, startedAt: "", finishedAt: "", error: "" };

app.get("/admin/backfill-crm", (req, res) => {
  const key = String(req.query.key || "");
  if (!config.crm.backfillKey || key !== config.crm.backfillKey) {
    res.status(403).json({ error: "Clave inválida o BACKFILL_KEY no configurada." });
    return;
  }
  if (!config.crm.ingestToken) {
    res.status(400).json({ error: "Falta CRM_INGEST_TOKEN (el CRM está desactivado)." });
    return;
  }
  if (backfill.running) {
    res.json({ estado: "EN CURSO", ...backfill });
    return;
  }
  // Si ya se ejecutó, mostramos el resultado y NO re-ejecutamos (para no duplicar).
  if (backfill.finishedAt && req.query.force !== "1") {
    res.json({ estado: "FINALIZADO (ya se ejecutó)", ...backfill, nota: "Para volver a ejecutar agregá &force=1 a la URL." });
    return;
  }
  // Arranca en segundo plano y responde de inmediato.
  Object.assign(backfill, { running: true, total: 0, ok: 0, fail: 0, skip: 0, startedAt: nowBolivia(), finishedAt: "", error: "" });
  void ejecutarBackfill();
  res.json({ estado: "INICIADO", mensaje: "Sincronización en marcha. Refrescá esta misma URL en ~30 seg para ver el avance y el resultado." });
});

// Total REAL de clientes: lee el Sheet, cuenta contactos ÚNICOS (por número) y
// los desglosa por ciudad. Se abre: /admin/stats?key=TU_CLAVE
app.get("/admin/stats", async (req, res) => {
  const key = String(req.query.key || "");
  if (!config.crm.backfillKey || key !== config.crm.backfillKey) {
    res.status(403).json({ error: "Clave inválida o BACKFILL_KEY no configurada." });
    return;
  }
  try {
    const url = `https://docs.google.com/spreadsheets/d/${config.crm.backfillSheetId}/export?format=csv`;
    const r = await fetch(url);
    const csv = await r.text();
    if (!r.ok || csv.trimStart().startsWith("<")) {
      res.status(400).json({ error: "No pude leer la hoja como CSV. Compartila como 'Cualquiera con el enlace: Lector'." });
      return;
    }
    const filas = parseCSV(csv);
    const enc = filas[0].map((h) => h.toLowerCase());
    const idx = (n: string) => enc.findIndex((h) => h.includes(n));
    const iTel = idx("tel"), iMsg = idx("mensaje"), iDet = idx("detalle");
    const ciudadDe = new Map<string, string>(); // telefono -> ciudad (primera detectada)
    const contactos = new Set<string>();
    for (let k = 1; k < filas.length; k++) {
      const f = filas[k];
      const tel = (iTel >= 0 ? f[iTel] || "" : "").replace(/\D/g, "");
      if (!tel) continue;
      contactos.add(tel);
      if (!ciudadDe.has(tel)) {
        const cd = detectarCiudad(`${iMsg >= 0 ? f[iMsg] || "" : ""} ${iDet >= 0 ? f[iDet] || "" : ""}`);
        if (cd) ciudadDe.set(tel, cd);
      }
    }
    const porCiudad: Record<string, number> = {};
    for (const c of ciudadDe.values()) porCiudad[c] = (porCiudad[c] || 0) + 1;
    const sinCiudad = contactos.size - ciudadDe.size;
    res.json({
      conversaciones: Math.max(0, filas.length - 1),
      contactosUnicos: contactos.size,
      conCiudad: ciudadDe.size,
      sinCiudad,
      porCiudad: Object.fromEntries(Object.entries(porCiudad).sort((a, b) => b[1] - a[1])),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Conversaciones guardadas en Postgres, en CSV (mismas columnas que la hoja).
// Sirve para recuperar lo que el Apps Script de Google no pudo registrar y
// pegarlo de vuelta en la planilla. Se abre: /admin/conversaciones.csv?key=TU_CLAVE
/**
 * Cuántos clientes distintos escribieron y de cuántos sabemos la ciudad.
 *
 * Lo pidió Prime para cuadrar su base con la nuestra: desde el CRM no pueden
 * consultar esta Postgres, y los logs solo dejan rastro de los envíos con
 * etapa, que son una fracción de los que escriben.
 *
 * Se abre: /admin/leads?key=TU_CLAVE&dias=7
 */
/**
 * Reenvía al CRM los resultados que los asesores ya respondieron.
 *
 * Existe por un error puntual: el guard de crm.send descartaba los envíos que
 * solo traían etapa, así que dos respuestas reales —Ma. René el 09/10 y Thalía
 * el 12/10— nunca llegaron. El bot las tenía guardadas: lo que falló fue el
 * envío. Sin esto, esas dos fichas quedan con la etapa equivocada para
 * siempre, y "dato conocido" es una forma elegante de decir "dato mal".
 *
 * Es idempotente: el CRM aplica la misma etapa, reenviar no hace daño.
 *
 * Se abre: /admin/reenviar-resultados?key=TU_CLAVE&dias=60
 */
app.get("/admin/reenviar-resultados", async (req, res) => {
  const key = String(req.query.key || "");
  if (!config.crm.backfillKey || key !== config.crm.backfillKey) {
    res.status(403).json({ error: "Clave inválida o BACKFILL_KEY no configurada." });
    return;
  }
  const dias = Math.min(365, Math.max(1, Number(req.query.dias) || 60));
  const filas = await resultadosRegistrados(dias);
  if (!filas) {
    res.status(503).json({ error: "No hay base de datos configurada o la consulta falló." });
    return;
  }

  const hechos: { cliente: string; etapa: string; envio: string }[] = [];
  for (const f of filas) {
    const etapa = RESPUESTAS.find((r) => r.resultado === f.resultado)?.etapa;
    if (!etapa) continue;
    const envio = await crm.send({
      external_id: f.clienteTelefono,
      name: f.clienteNombre,
      city: f.ciudad,
      stage: etapa,
      asesor: f.asesorNombre,
      departamento: departamentoDeLugar(f.ciudad),
    });
    hechos.push({ cliente: f.clienteTelefono, etapa, envio });
  }
  res.json({ revisados: filas.length, reenviados: hechos.length, detalle: hechos });
});

/**
 * Ver una plantilla de Meta y, si se pide, mandarla a UN número.
 *
 * Sin `to` solo MUESTRA cómo está aprobada la plantilla (estado, categoría,
 * idioma y componentes). Eso va primero a propósito: una plantilla de
 * marketing hecha a mano puede tener encabezado con video, botones o
 * variables, y mandarla a ciegas o falla con un error de componentes o le
 * llega mal a una persona real.
 *
 * Con `to` la manda a ESE número y a ninguno más. No hay envío masivo acá:
 * si alguna vez hace falta, que sea una función pensada para eso y no un
 * parámetro de más en una herramienta de diagnóstico.
 *
 *   Ver:     /admin/plantilla?key=CLAVE&nombre=dexco_gladymar
 *   Enviar:  /admin/plantilla?key=CLAVE&nombre=dexco_gladymar&to=59172155226
 *            (&video=URL  si el encabezado es de video y hay que pasarlo)
 */
/**
 * Las plantillas de la WABA de Gladymar, para que Difusión (CRM de Prime) las
 * liste sin guardar el token de este servicio en otra base.
 *
 *   /admin/plantillas?key=CLAVE              -> solo las APPROVED
 *   /admin/plantillas?key=CLAVE&todas=1      -> todas, con su estado
 */
app.get("/admin/plantillas", async (req, res) => {
  const key = String(req.query.key || "");
  if (!config.crm.backfillKey || key !== config.crm.backfillKey) {
    res.status(403).json({ error: "Clave inválida o BACKFILL_KEY no configurada." });
    return;
  }
  const todas = await listarPlantillas();
  if (!Array.isArray(todas)) {
    res.status(502).json(todas);
    return;
  }
  const lista = req.query.todas ? todas : todas.filter((p) => p.status === "APPROVED");
  res.json({
    waba: config.whatsapp.wabaId,
    total: lista.length,
    plantillas: lista.map((p) => ({
      nombre: p.name,
      estado: p.status,
      categoria: p.category,
      idioma: p.language,
      // Los componentes van completos: Difusión necesita saber si lleva
      // encabezado de media, cuántas variables tiene el cuerpo y qué botones,
      // para armar bien el envío.
      componentes: p.components ?? [],
    })),
  });
});

app.get("/admin/plantilla", async (req, res) => {
  const key = String(req.query.key || "");
  if (!config.crm.backfillKey || key !== config.crm.backfillKey) {
    res.status(403).json({ error: "Clave inválida o BACKFILL_KEY no configurada." });
    return;
  }
  const nombre = String(req.query.nombre || "").trim();
  if (!nombre) {
    res.status(400).json({ error: "Falta el parámetro nombre." });
    return;
  }

  const def = await leerPlantilla(nombre);
  if (!Array.isArray(def)) {
    res.status(502).json({ nombre, ...def });
    return;
  }
  if (!def.length) {
    res.status(404).json({ error: `Meta no tiene ninguna plantilla llamada "${nombre}".` });
    return;
  }

  const destino = String(req.query.to || "").replace(/\D/g, "");
  if (!destino) {
    res.json({ nombre, plantillas: def, nota: "Para enviarla, agregá &to=NUMERO (con 591)." });
    return;
  }

  const plantilla = def[0];
  const idioma = plantilla.language || "es";
  const components: unknown[] = [];

  // Encabezado de media: Meta EXIGE la media al enviar, aunque la plantilla
  // aprobada traiga un ejemplo. El ejemplo es solo para la revisión.
  const header = plantilla.components?.find((c) => c.type === "HEADER");
  const formato = String(header?.format || "").toUpperCase();
  const video = String(req.query.video || "").trim();
  if (formato === "VIDEO" || formato === "IMAGE" || formato === "DOCUMENT") {
    if (!video) {
      res.status(400).json({
        error: `La plantilla "${nombre}" tiene encabezado de ${formato}. Pasá la URL pública con &video=...`,
        plantillas: def,
      });
      return;
    }
    components.push({
      type: "header",
      parameters: [{ type: formato.toLowerCase(), [formato.toLowerCase()]: { link: video } }],
    });
  }

  const envio = await sendTemplateCrudo(destino, nombre, idioma, components);
  console.log(
    envio.ok
      ? `📣 Plantilla "${nombre}" enviada a ${destino} (id=${envio.wamid ?? "sin id"}).`
      : `📣 No se pudo enviar la plantilla "${nombre}" a ${destino}: ${JSON.stringify(envio.error)}`,
  );
  res.status(envio.ok ? 200 : 502).json({ nombre, idioma, destino, ...envio });
});

app.get("/admin/leads", async (req, res) => {
  const key = String(req.query.key || "");
  if (!config.crm.backfillKey || key !== config.crm.backfillKey) {
    res.status(403).json({ error: "Clave inválida o BACKFILL_KEY no configurada." });
    return;
  }
  const dias = Math.min(365, Math.max(1, Number(req.query.dias) || 7));
  const r = await resumenLeads(dias);
  if (!r) {
    res.status(503).json({ error: "No hay base de datos configurada o la consulta falló." });
    return;
  }
  res.json(r);
});

app.get("/admin/conversaciones.csv", async (req, res) => {
  const key = String(req.query.key || "");
  if (!config.crm.backfillKey || key !== config.crm.backfillKey) {
    res.status(403).json({ error: "Clave inválida o BACKFILL_KEY no configurada." });
    return;
  }
  const filas = await obtenerConversaciones(Number(req.query.limite) || 5000);
  if (filas === null) {
    res.status(503).json({ error: "Postgres no disponible." });
    return;
  }
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const cabecera = ["Fecha", "Teléfono", "Nombre", "Ciudad", "Mensaje", "Respuesta", "Tipo de solicitud", "Prioridad", "Detalle", "Derivado a asesor"];
  const cuerpo = filas
    .slice()
    .reverse() // cronológico, como la hoja
    .map((f) =>
      [f.fecha, f.telefono, f.nombre, f.ciudad, f.mensaje, f.respuesta, f.tipo_solicitud, f.prioridad, f.detalle, f.escalado ? "Sí" : "No"]
        .map(esc)
        .join(","),
    );
  res.set("Content-Type", "text/csv; charset=utf-8");
  res.set("Content-Disposition", 'attachment; filename="conversaciones.csv"');
  res.send("﻿" + [cabecera.map(esc).join(","), ...cuerpo].join("\n"));
});

// Prueba de punta a punta del aviso de pedido: manda UNA plantilla real al
// número indicado, para verificar que Meta la aceptó y que el texto sale bien.
// Se abre: /admin/probar-aviso?key=TU_CLAVE&telefono=67401827&estado=despachado
app.get("/admin/probar-aviso", async (req, res) => {
  const key = String(req.query.key || "");
  if (!config.crm.backfillKey || key !== config.crm.backfillKey) {
    res.status(403).json({ error: "Clave inválida o BACKFILL_KEY no configurada." });
    return;
  }
  const telefono = String(req.query.telefono || "").replace(/\D/g, "");
  if (!telefono) {
    res.status(400).json({ error: "Falta 'telefono' (8 dígitos, ej. 67401827)." });
    return;
  }
  const estado = String(req.query.estado || "preparado").toLowerCase();
  const esDespachado = estado.startsWith("desp");
  const plantilla = esDespachado ? config.despacho.templateDespachado : config.despacho.templatePreparado;
  const idioma =
    (esDespachado ? config.despacho.templateDespachadoIdioma : config.despacho.templatePreparadoIdioma) ||
    config.despacho.templateIdioma;
  const nombre = String(req.query.nombre || "Cliente de prueba");
  const factura = String(req.query.factura || "0000");
  try {
    await sendTemplate(telefono.startsWith("591") ? telefono : `591${telefono}`, plantilla, idioma, [nombre, factura]);
    res.json({ estado: "ENVIADO", plantilla, idioma, telefono, nombre, factura });
  } catch (err) {
    res.status(502).json({ estado: "FALLÓ", plantilla, idioma, error: String(err) });
  }
});

// Consumo real de tokens y su costo: /admin/uso?key=TU_CLAVE
app.get("/admin/uso", async (req, res) => {
  const key = String(req.query.key || "");
  if (!config.crm.backfillKey || key !== config.crm.backfillKey) {
    res.status(403).json({ error: "Clave inválida o BACKFILL_KEY no configurada." });
    return;
  }
  const resumen = await resumenUso(Number(req.query.dias) || 60);
  if (!resumen) {
    res.status(503).json({ error: "Postgres no respondió (o DATABASE_URL no está configurada)." });
    return;
  }
  res.json({
    modelo: config.anthropic.model,
    precios_usd_por_millon: PRECIOS_USD_POR_MILLON,
    totales: resumen.totales,
    costo_usd: Number(resumen.costoUsd.toFixed(4)),
    costo_sin_cache_usd: Number(resumen.costoSinCacheUsd.toFixed(4)),
    ahorro_por_cache_usd: Number((resumen.costoSinCacheUsd - resumen.costoUsd).toFixed(4)),
    por_dia: resumen.dias,
  });
});

// Mapa municipio -> departamento -> asesor. Lo consume el CRM de Prime para
// repartir de una sola vez la cartera ya cargada (backfill sobre su columna
// city), en vez de esperar a que cada cliente vuelva a escribir.
// Se abre: /admin/municipios?key=TU_CLAVE
app.get("/admin/municipios", (req, res) => {
  const key = String(req.query.key || "");
  if (!config.crm.backfillKey || key !== config.crm.backfillKey) {
    res.status(403).json({ error: "Clave inválida o BACKFILL_KEY no configurada." });
    return;
  }
  const asesorPorDepartamento: Record<string, string | null> = {};
  for (const depto of new Set(Object.values(mapaMunicipios()))) {
    asesorPorDepartamento[depto] = adminNombrePorCiudad(depto) ?? null;
  }
  res.json({
    nota:
      "Las claves de 'municipios' están normalizadas: minúsculas, sin tildes y sin puntuación. " +
      "Normalizá igual el valor de city antes de buscarlo. Un departamento con asesor null " +
      "(Beni, Pando) todavía no tiene asesor asignado: mandar la región, no el asesor.",
    total: municipiosReconocidos(),
    asesorPorDepartamento,
    municipios: mapaMunicipios(),
  });
});

// Padrón de administradores: lo consume el CRM para marcarlos como "Administrador"
// (y no contarlos como un lead/cliente más). Se abre: /admin/roster?key=TU_CLAVE
app.get("/admin/roster", (req, res) => {
  const key = String(req.query.key || "");
  if (!config.crm.backfillKey || key !== config.crm.backfillKey) {
    res.status(403).json({ error: "Clave inválida o BACKFILL_KEY no configurada." });
    return;
  }
  res.json({ admins: adminRoster() });
});

// Marca en el CRM a TODOS los administradores como is_admin (para los que ya
// están cargados del histórico). Se abre: /admin/tag-admins-crm?key=TU_CLAVE
app.get("/admin/tag-admins-crm", async (req, res) => {
  const key = String(req.query.key || "");
  if (!config.crm.backfillKey || key !== config.crm.backfillKey) {
    res.status(403).json({ error: "Clave inválida o BACKFILL_KEY no configurada." });
    return;
  }
  if (!config.crm.ingestToken) {
    res.status(400).json({ error: "Falta CRM_INGEST_TOKEN (el CRM está desactivado)." });
    return;
  }
  const roster = adminRoster();
  let ok = 0, fail = 0;
  for (const a of roster) {
    const r = await crm.send({
      external_id: a.external_id,
      name: a.nombre,
      segment: "Administrador",
      city: a.ciudad,
      is_admin: true,
      role: a.role,
    });
    if (r === "ok") ok++; else fail++;
  }
  res.json({ estado: "LISTO", total: roster.length, ok, fail });
});

async function ejecutarBackfill(): Promise<void> {
  try {
    const url = `https://docs.google.com/spreadsheets/d/${config.crm.backfillSheetId}/export?format=csv`;
    const r = await fetch(url);
    const csv = await r.text();
    if (!r.ok || csv.trimStart().startsWith("<")) {
      backfill.error = "No pude leer la hoja como CSV. Compartila como 'Cualquiera con el enlace: Lector'.";
      backfill.running = false;
      backfill.finishedAt = nowBolivia();
      return;
    }
    const filas = parseCSV(csv);
    backfill.total = Math.max(0, filas.length - 1);
    const enc = filas[0].map((h) => h.toLowerCase());
    const idx = (n: string) => enc.findIndex((h) => h.includes(n));
    const iTel = idx("tel"), iNom = idx("nombre"), iMsg = idx("mensaje"), iResp = idx("respuesta"), iTipo = idx("tipo"), iDet = idx("detalle");
    for (let k = 1; k < filas.length; k++) {
      const f = filas[k];
      const tel = (iTel >= 0 ? f[iTel] || "" : "").replace(/\D/g, "");
      const message = iMsg >= 0 ? f[iMsg] || "" : "";
      const response = iResp >= 0 ? f[iResp] || "" : "";
      if (!tel || (!message && !response)) { backfill.skip++; continue; }
      const detalle = iDet >= 0 ? f[iDet] : undefined;
      // Si el número es de un administrador/asesor del roster: se marca como
      // admin y NO como lead (sin stage/interest), para limpiar contaminaciones.
      const adminFila = getAdminByPhone(tel);
      // Recuperar la ciudad desde el TEXTO de la conversación (única fuente real).
      const ciudad = detectarCiudad(`${message} ${detalle || ""}`);
      const result = await crm.send({
        external_id: tel,
        name: adminFila?.nombre || (iNom >= 0 ? f[iNom] : undefined),
        city: adminFila?.region || ciudad,
        segment: adminFila ? "Administrador" : undefined,
        message,
        response,
        stage: adminFila ? undefined : (iTipo >= 0 ? stageDeTipo((f[iTipo] || "").trim()) : undefined),
        tipo_solicitud: adminFila ? undefined : (iTipo >= 0 ? tipoSolicitudCrm((f[iTipo] || "").trim()) : undefined),
        interest: adminFila ? undefined : detalle,
        is_admin: Boolean(adminFila),
        role: adminFila?.role,
      });
      if (result === "ok") backfill.ok++;
      else if (result === "fail") backfill.fail++;
      else backfill.skip++;
      await sleep(60);
    }
    console.log(`🔁 Backfill CRM: total=${backfill.total} ok=${backfill.ok} fail=${backfill.fail} skip=${backfill.skip}`);
  } catch (err) {
    backfill.error = String(err);
    console.error("Backfill CRM error:", err);
  } finally {
    backfill.running = false;
    backfill.finishedAt = nowBolivia();
  }
}

// Páginas legales (requeridas por Meta para publicar la app en modo Live).
app.get("/privacidad", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "privacidad.html"));
});
app.get("/terminos", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "terminos.html"));
});

// Página de conexión por coexistencia (Embedded Signup): inyecta App ID y Config ID desde el entorno.
app.get("/conectar", (_req, res) => {
  try {
    const html = readFileSync(path.join(process.cwd(), "public", "conectar.html"), "utf8")
      .replace(/__META_APP_ID__/g, process.env.META_APP_ID || "")
      .replace(/__COEXISTENCE_CONFIG_ID__/g, process.env.COEXISTENCE_CONFIG_ID || "");
    res.set("Content-Type", "text/html; charset=utf-8").send(html);
  } catch (err) {
    console.error("No se pudo servir /conectar:", err);
    res.sendStatus(500);
  }
});

// ── Límite de uso del demo web ───────────────────────────────────────────────
// /api/chat es público (la demo del sitio) y cada llamada consume tokens de la
// API de Claude. Sin tope, cualquiera podría dispararlo en bucle y generar
// gasto ilimitado. Límite por IP, en memoria (sin dependencias nuevas).
const DEMO_MAX_POR_HORA = (() => {
  const n = Number(process.env.DEMO_MAX_POR_HORA);
  return Number.isFinite(n) && n > 0 ? n : 60;
})();
const demoUso = new Map<string, { n: number; desde: number }>();

/** true si la IP superó el tope de la última hora. */
function demoExcedido(ip: string): boolean {
  const ahora = Date.now();
  const HORA = 60 * 60 * 1000;
  const uso = demoUso.get(ip);
  if (!uso || ahora - uso.desde > HORA) {
    demoUso.set(ip, { n: 1, desde: ahora });
    return false;
  }
  uso.n++;
  return uso.n > DEMO_MAX_POR_HORA;
}

// Limpieza periódica para que el mapa no crezca sin límite.
const limpiezaDemo = setInterval(() => {
  const limite = Date.now() - 60 * 60 * 1000;
  for (const [ip, uso] of demoUso) if (uso.desde < limite) demoUso.delete(ip);
}, 15 * 60 * 1000);
if (typeof limpiezaDemo.unref === "function") limpiezaDemo.unref();

// Endpoint del demo web: chatea con el mismo cerebro del agente (sin WhatsApp).
app.post("/api/chat", async (req, res) => {
  const { sessionId, message } = req.body ?? {};
  if (typeof sessionId !== "string" || typeof message !== "string" || message.trim() === "") {
    res.status(400).json({ error: "Se requieren 'sessionId' y 'message'." });
    return;
  }
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "desconocida").split(",")[0].trim();
  if (demoExcedido(ip)) {
    res.status(429).json({ error: "Demasiadas consultas. Intente nuevamente más tarde." });
    return;
  }
  try {
    bumpConversacion();
    const reply = await agent.handleMessage(`demo:${sessionId}`, message);
    res.json({
      reply: reply.text,
      options: reply.options,
      optionsButton: reply.optionsButton,
      optionsTitle: reply.optionsTitle,
      document: reply.document,
      escalated: reply.escalated,
    });
  } catch (err) {
    console.error("Error en /api/chat:", err);
    res.status(500).json({ error: "Error procesando el mensaje." });
  }
});

// Endpoint del panel de administradores (determinista, sin IA).
app.post("/api/admin", async (req, res) => {
  const { sessionId, role, message } = req.body ?? {};
  if (typeof sessionId !== "string" || typeof role !== "string" || typeof message !== "string") {
    res.status(400).json({ error: "Se requieren 'sessionId', 'role' y 'message'." });
    return;
  }
  const admin = adminFromRole(role);
  try {
    const reply = await handleAdminCommand(`adm:${sessionId}`, admin, message);
    res.json({
      reply: reply.text,
      options: reply.options ?? [],
      optionsButton: reply.optionsButton,
      optionsTitle: reply.optionsTitle,
    });
  } catch (err) {
    console.error("Error en /api/admin:", err);
    res.status(500).json({ error: "Error procesando el comando." });
  }
});

// Verificación del webhook (handshake con Meta)
/**
 * Diagnóstico: le pregunta a Meta por las conversaciones y devuelve lo que
 * contesta, en crudo.
 *
 * Existe porque cuando Meta no entrega webhooks no hay forma de saber desde
 * afuera si el token sirve, si la cuenta está conectada o si simplemente no
 * hay mensajes. Esto lo responde en una llamada, sin tocar nada.
 */
app.get("/admin/meta-dm", async (req, res) => {
  const key = String(req.query.key || "");
  if (!config.crm.backfillKey || key !== config.crm.backfillKey) {
    res.status(403).json({ error: "Clave inválida o BACKFILL_KEY no configurada." });
    return;
  }
  const canal = String(req.query.canal || "instagram") === "messenger" ? "messenger" : "instagram";
  if (!metaHabilitado(canal)) {
    res.status(400).json({ error: `Falta META_PAGE_ID/META_INSTAGRAM_ID para ${canal}.` });
    return;
  }
  // Se informa paso por paso: token, suscripción y conversaciones. Cuando algo
  // no anda, saber CUÁL de los tres falló es la mitad del arreglo.
  const diag: Record<string, unknown> = { canal };
  try {
    const datos = await datosDePagina();
    diag.pagina = datos ? { id: datos.id, nombre: datos.nombre, instagram: datos.instagramId ?? null } : null;
    diag.tokenDePagina = datos ? "ok" : "falta";
  } catch (err) {
    diag.tokenDePagina = String(err);
    res.status(502).json(diag);
    return;
  }
  if (String(req.query.suscribir || "") === "1") {
    diag.suscripcion = await suscribirPagina().catch((err) => String(err));
  }
  try {
    const mensajes = await sondearMensajes(canal);
    diag.pendientes = mensajes.length;
    diag.mensajes = mensajes.map((m) => ({ de: m.from, nombre: m.name, texto: m.text }));
    res.json(diag);
  } catch (err) {
    diag.error = String(err);
    res.status(502).json(diag);
  }
});

app.get("/webhook", (req, res) => {
  const challenge = verifyWebhook(req.query as Record<string, unknown>);
  if (challenge !== null) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Recepción de mensajes entrantes
app.post("/webhook", async (req, res) => {
  // Respondemos 200 de inmediato: Meta reintenta si tardamos demasiado.
  res.sendStatus(200);

  try {
    // Acuses de entrega: la única forma de saber si un aviso LLEGÓ de verdad.
    // Meta responde 200 al enviar aunque el número no exista en WhatsApp; el
    // fallo aparece recién acá, minutos después.
    for (const st of parseStatusUpdates(req.body)) {
      if (st.estado === "failed") {
        console.error(
          `📬 NO ENTREGADO a ${st.destinatario} (id=${st.messageId}): ${st.error ?? "sin detalle de Meta"}`,
        );
        void reintentarAvisoPorPlantilla(st.messageId, st.error);
        // Si ese mensaje salió por la cola del CRM, su fila ya se cerró como
        // entregada cuando Meta lo aceptó. Le mandamos el motivo para que en la
        // plataforma no quede como un aviso que llegó bien.
        void anotarFalloTardio(st.messageId, st.error);
      } else if (st.estado === "delivered" || st.estado === "read") {
        console.log(`📬 ${st.estado} -> ${st.destinatario} (id=${st.messageId})`);
      }
    }

    // Messenger e Instagram entran por el MISMO webhook, con otro `object` y
    // otra forma de payload. Se atienden antes de buscar mensajes de WhatsApp,
    // que no va a encontrar ninguno en ese cuerpo.
    const canalMeta = canalDelPayload(req.body);
    if (canalMeta) {
      for (const m of parseMensajesMeta(req.body)) {
        if (!metaHabilitado(canalMeta)) {
          console.warn(
            `💬 Llegó un mensaje de ${nombreCanal(canalMeta)} de ${m.from} y no se puede contestar: ` +
              "falta META_PAGE_ID (y META_PAGE_TOKEN si el token de WhatsApp no sirve para la página).",
          );
          continue;
        }
        console.log(`💬 ${nombreCanal(canalMeta)} ${m.from}: ${m.text || `(${m.adjuntoNoSoportado ?? "imagen"})`}`);
        // El sondeo mira las mismas conversaciones. Si el webhook llegó
        // primero, esto evita que el otro camino conteste de nuevo.
        if (yaAtendido(m.messageId)) continue;
        marcarAtendido(m.messageId);
        void atenderMeta(m).catch((err) =>
          console.error(`Error atendiendo ${nombreCanal(canalMeta)} a ${m.from}:`, err),
        );
      }
      return;
    }

    const messages = parseIncomingMessages(req.body);
    for (const msg of messages) {
      handleIncoming(msg).catch((err) => console.error(`Error atendiendo a ${msg.from}:`, err));
    }
  } catch (err) {
    console.error("Error procesando webhook:", err);
  }
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Divide la respuesta en máximo 2 bloques (para no saturar con "muchos mensajes"). */
function splitBlocks(text: string): string[] {
  const parts = text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  if (parts.length <= 1) return [text.trim()];
  if (parts.length === 2) return parts;
  // 3+ párrafos: los agrupamos en 2 globos como mucho.
  const corte = Math.ceil(parts.length / 2);
  return [parts.slice(0, corte).join("\n\n"), parts.slice(corte).join("\n\n")];
}

/** Tiempo del indicador "escribiendo…" simulando tipeo humano (según el largo, con tope). */
function typingMs(text: string): number {
  return Math.min(2600, 700 + text.length * 18);
}

/** Parte un texto largo en trozos de <= max caracteres, respetando saltos de línea. */
function splitLong(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const partes: string[] = [];
  let actual = "";
  for (const linea of text.split("\n")) {
    if (actual && (actual + "\n" + linea).length > max) {
      partes.push(actual);
      actual = linea;
    } else {
      actual = actual ? actual + "\n" + linea : linea;
    }
  }
  if (actual) partes.push(actual);
  return partes;
}

/**
 * Aviso automático (handoff) al asesor de la ciudad del cliente cuando se cierra
 * una solicitud (lead/cotización/reclamo/etc.). Le manda los datos para que el
 * asesor contacte al cliente directo. Si no hay asesor para esa ciudad, avisa al
 * Gerente General. Nota: WhatsApp solo permite el envío libre dentro de la
 * ventana de 24h del asesor; si está activo (consultando su panel), llega bien.
 */
/**
 * Atiende un mensaje de Messenger o Instagram.
 *
 * Reusa el MISMO agente y el mismo flujo que WhatsApp a propósito: el cliente
 * que escribe por Instagram tiene que recibir la misma atención, los mismos
 * precios y el mismo handoff. Lo único que cambia es por dónde entra y por
 * dónde sale.
 */
async function atenderMeta(m: MensajeMeta): Promise<void> {
  // Sin texto no hay nada que mandarle al agente. Las fotos de Messenger e
  // Instagram vienen por URL y el lector de imágenes todavía espera un media
  // id de WhatsApp, así que por ahora se avisa en vez de ignorar.
  if (!m.text) {
    await enviarMeta(
      m.canal,
      m.from,
      m.imageUrl
        ? "¡Gracias por la foto! 😊 Por este canal todavía no puedo verla. ¿Me contás con palabras qué estás buscando y seguimos?"
        : "¡Gracias por tu mensaje! 😊 Por acá todavía no puedo abrir ese tipo de archivo. ¿Me lo escribís y seguimos?",
    );
    return;
  }
  await procesarTurnoCliente(m.from, m.text, m.messageId, undefined, { canal: m.canal });
}

async function notificarAsesor(
  from: string,
  name: string | undefined,
  sol: NonNullable<AgentReply["solicitud"]>,
  canal: Canal = "whatsapp",
): Promise<void> {
  const ciudad = sol.ciudad || "";
  // Reparto por sucursal y por turnos (ver admin/reparto.ts). Si no se puede
  // resolver, cae al comportamiento de siempre.
  const asignado = await asesorDeCliente(idParaCrm(canal, from), ciudad);
  const destino = asignado?.telefono || adminTelefonoPorCiudad(ciudad) || ADMIN_TELEFONO;
  const prio = sol.prioridad === "critica" ? "  🔴 CRÍTICA" : sol.prioridad === "alta" ? "  🟠 ALTA" : "";
  const nombre = sol.nombre || name || "Cliente";
  const lineas = [
    `🔔 *Nuevo cliente${ciudad ? " · " + ciudad : ""}*${prio}`,
    `👤 ${nombre}`,
    // En Messenger e Instagram el remitente es un PSID, no un teléfono: un
    // wa.me armado con eso es un enlace roto. Ver meta/messenger.ts.
    comoContactar(canal, from),
    `🗂️ ${sol.tipo}`,
    sol.detalle ? `🗒️ ${sol.detalle}` : "",
    "",
    "Escribile para continuar la atención. 💬",
  ].filter(Boolean);
  try {
    const wamid = await sendText(destino, lineas.join("\n"));
    console.log(
      `📤 Handoff -> asesor ${asignado?.nombre ?? "?"} ${destino} ` +
        `(cliente ${from}, ${ciudad || "sin ciudad"}` +
        `${asignado ? `, ${asignado.sucursal} por ${asignado.via}` : ""})`,
    );
    // Meta responde 200 aunque la ventana de 24 h esté cerrada: el fallo llega
    // segundos después por el webhook. Guardamos con qué reintentar por si eso
    // pasa; el asesor casi nunca le escribe al bot, así que pasa seguido.
    if (wamid) {
      recordarAviso(wamid, destino, resumenLead({ nombre, telefono: from, tipo: sol.tipo, detalle: sol.detalle }));
    }
    // Queda anotado para preguntarle después cómo le fue. Va DESPUÉS del envío
    // y no antes: si el aviso no salió, no hay nada sobre lo que preguntar.
    void registrarDerivacion({
      clienteTelefono: idParaCrm(canal, from),
      clienteNombre: nombre,
      asesorTelefono: destino,
      asesorNombre: asignado?.nombre || adminNombrePorCiudad(ciudad),
      ciudad,
      tipo: sol.tipo,
      detalle: sol.detalle,
    });
  } catch (err) {
    console.error(`No se pudo avisar al asesor ${destino}:`, err);
  }
}

/**
 * Le pregunta a los asesores cómo les fue con los leads que se les derivó.
 *
 * Nunca lanza: esto corre en un timer y un fallo acá no puede tumbar el
 * proceso. Un asesor al que no se le pudo preguntar vuelve en el próximo ciclo.
 */
async function preguntarSeguimientos(): Promise<void> {
  if (!seguimientoAsesorHabilitado() || !isWhatsAppConfigured()) return;
  let pendientes: Awaited<ReturnType<typeof seguimientosPorPreguntar>>;
  try {
    pendientes = await seguimientosPorPreguntar();
  } catch (err) {
    console.error("No se pudieron leer los seguimientos pendientes:", err);
    return;
  }
  if (!pendientes.length) return;

  for (const s of pendientes) {
    try {
      const wamid = await sendInteractiveList(
        s.asesorTelefono,
        textoPregunta(s),
        "Responder",
        "¿Cómo te fue?",
        RESPUESTAS.map((r) => r.titulo),
      );
      // Meta responde 200 aunque la ventana esté cerrada: el rebote llega
      // después por el webhook. Se deja anotado con qué reintentar, igual que
      // el aviso de lead, pero con la plantilla del seguimiento.
      if (wamid) {
        const quien = `${s.clienteNombre || "tu cliente"}${s.ciudad ? ` (${s.ciudad})` : ""}`;
        recordarAviso(wamid, s.asesorTelefono, quien, config.whatsapp.templateSeguimiento);
      }
      await marcarPreguntado(s.id);
      console.log(
        `🔁 Seguimiento preguntado al asesor ${s.asesorTelefono} por el cliente ${s.clienteTelefono} ` +
          `(intento ${s.preguntas + 1}).`,
      );
    } catch (err) {
      // No se marca el intento: casi siempre es la ventana de 24 h cerrada, y
      // quemar el intento por algo que no fue culpa del asesor lo dejaría sin
      // preguntar nunca.
      console.error(`No se pudo preguntarle el seguimiento a ${s.asesorTelefono}:`, err);
    }
  }
}

/**
 * Le pasa al asesor la MISMA cotización que recibió el cliente.
 *
 * Sin esto el asesor llama a ciegas: el cliente le menciona un total que él no
 * tiene a mano y queda en offside. Va el detalle y el enlace al PDF, no un
 * aviso genérico.
 */
async function avisarCotizacionAlAsesor(
  from: string,
  nombreCliente: string | undefined,
  cot: Cotizacion,
  urlPdf: string,
): Promise<void> {
  const asignadoCot = await asesorDeCliente(from, cot.ciudad || "");
  const destino = asignadoCot?.telefono || adminTelefonoPorCiudad(cot.ciudad || "") || ADMIN_TELEFONO;
  const lineas = [
    `🧾 *Cotización ${cot.numero}*${cot.ciudad ? " · " + cot.ciudad : ""}`,
    `👤 ${cot.cliente || nombreCliente || "Cliente"}`,
    `📱 ${from}  (wa.me/${from})`,
    "",
    ...cot.items.map(
      (i) =>
        `• ${i.descripcion}${i.origen ? " (" + i.origen + ")" : ""}: ` +
        `${i.cantidad} ${i.unidad} × ${bs(i.precioUnit)} = ${bs(i.subtotal)}`,
    ),
    `*TOTAL: ${bs(cot.total)}*`,
    "",
    // Lo de segunda no se cotizó (Gerencia, 20/09/2026), pero el asesor tiene
    // que saber que el cliente lo pidió: es lo que tiene que ir a resolver él.
    ...(cot.derivar.length
      ? [
          `⚠️ *Pidió además material de SEGUNDA* (no se cotiza, lo ves vos): ` +
            cot.derivar.map((d) => (d.pedido === d.producto ? `"${d.pedido}"` : `"${d.pedido}" → ${d.producto}`)).join("; "),
          "",
        ]
      : []),
    cot.departamento ? `Precios de ${cot.departamento}.` : "Precios de lista nacional (no se pudo determinar la región).",
    `Vence: ${cot.vence}`,
    urlPdf,
  ];
  try {
    const wamid = await sendText(destino, lineas.join("\n"));
    console.log(`🧾 Cotización ${cot.numero} enviada al asesor ${destino}`);
    if (wamid) {
      recordarAviso(wamid, destino, resumenLead({
        nombre: cot.cliente || nombreCliente,
        telefono: from,
        tipo: `cotizacion ${cot.numero}`,
        detalle: `${cot.items.length} item(s), total ${bs(cot.total)}`,
      }));
    }
  } catch (err) {
    console.error(`No se pudo pasarle la cotización ${cot.numero} al asesor ${destino}:`, err);
  }
}

/**
 * Avisos al equipo que salieron como texto libre y podrían rebotar por la
 * ventana de 24 h, indexados por wamid para reintentarlos con plantilla.
 *
 * Vive en memoria a propósito: el acuse de Meta llega en segundos, así que no
 * hace falta persistirlo, y si el proceso se reinicia justo en el medio se
 * pierde un reintento, no un lead (el lead ya está en Postgres y en el CRM).
 */
const avisosPendientes = new Map<string, { destino: string; resumen: string; plantilla?: string }>();
const MAX_AVISOS_PENDIENTES = 500;

/**
 * @param plantilla Con cuál reintentar si rebota. Por defecto la de avisos de
 *   lead; el seguimiento usa la suya, que dice otra cosa.
 */
function recordarAviso(wamid: string, destino: string, resumen: string, plantilla?: string): void {
  // Tope duro: si algo dejara de limpiar, esto no puede crecer sin freno.
  if (avisosPendientes.size >= MAX_AVISOS_PENDIENTES) {
    const primero = avisosPendientes.keys().next().value;
    if (primero) avisosPendientes.delete(primero);
  }
  avisosPendientes.set(wamid, { destino, resumen, plantilla });
  // Si a los 10 minutos no rebotó, llegó bien: se suelta la memoria.
  setTimeout(() => avisosPendientes.delete(wamid), 10 * 60 * 1000).unref?.();
}

/**
 * Reintenta por plantilla un aviso al equipo que rebotó por ventana cerrada.
 *
 * El aviso va MÍNIMO a propósito: mandar la plantilla no abre la ventana, solo
 * responderla. Por eso el detalle completo no se manda acá — sale cuando la
 * persona contesta, que es lo único que habilita el texto libre.
 */
async function reintentarAvisoPorPlantilla(wamid: string, error?: string): Promise<void> {
  const pendiente = avisosPendientes.get(wamid);
  if (!pendiente) return;
  avisosPendientes.delete(wamid);
  if (!esFalloDeVentana(error)) return; // número inexistente o bloqueo: la plantilla también fallaría

  try {
    const plantilla = pendiente.plantilla || config.whatsapp.templateAvisos;
    await sendTemplate(
      pendiente.destino,
      plantilla,
      config.whatsapp.templateAvisosIdioma,
      [pendiente.resumen],
    );
    console.log(
      `📤 Reenviado por plantilla "${plantilla}" a ${pendiente.destino} (la ventana de 24 h estaba cerrada).`,
    );
  } catch (err) {
    console.error(`No se pudo reenviar el aviso por plantilla a ${pendiente.destino}:`, err);
  }
}

// ── Agrupado de mensajes (anti-spam) ────────────────────────────────────────
// Si un cliente manda varios mensajes seguidos, los juntamos y respondemos UNA
// sola vez (evita respuestas repetidas). Si llega un mensaje mientras estamos
// respondiendo, queda en cola y se procesa después.
// Ventana de espera para agrupar: damos tiempo a que el cliente termine de
// escribir varios mensajes seguidos antes de responder (evita "bombardear").
const DEBOUNCE_MS = 5000;
interface BufferCliente {
  textos: string[];
  timer: NodeJS.Timeout | null;
  messageId: string;
  name?: string;
  prueba?: boolean;
  /** El grupo arrancó con el clic de un botón de plantilla. */
  deBotonPlantilla?: boolean;
  /** Última foto del grupo de mensajes (si mandó varias, vale la más reciente). */
  imageId?: string;
  /** Último PDF del grupo de mensajes. */
  documentId?: string;
  documentName?: string;
}
const buffers = new Map<string, BufferCliente>();
const enCurso = new Set<string>();
// Admins que están "probando como cliente" (modo demo): sus mensajes van al agente.
const testCliente = new Set<string>();

/** Envía una respuesta del panel admin (menú corto como lista tappable; listas largas partidas). */
async function enviarPanel(to: string, r: AdminReply): Promise<void> {
  const corto = r.text.length < 900;
  if (r.options?.length && corto) {
    try {
      // Agrupado si el menú trae secciones; si no, la lista plana de siempre.
      if (r.secciones?.length) {
        await sendInteractiveSections(to, r.text, r.optionsButton || "Ver comandos", r.secciones);
      } else {
        await sendInteractiveList(to, r.text, r.optionsButton || "Ver comandos", r.optionsTitle || "Panel", r.options);
      }
    } catch (err) {
      console.error("Lista admin falló; envío como texto:", err);
      await sendText(to, `${r.text}\n\n${r.options.map((o, i) => `*${i + 1}.* ${o}`).join("\n")}`);
    }
  } else {
    for (const parte of splitLong(r.text, 3500)) {
      await sendText(to, parte);
      await sleep(300);
    }
    if (r.options?.length) {
      try {
        await sendInteractiveList(to, "¿Algo más?", r.optionsButton || "Menú", r.optionsTitle || "Panel", r.options);
      } catch {
        /* no crítico */
      }
    }
  }
}

function programarCliente(
  msg: {
    from: string;
    text: string;
    messageId: string;
    name?: string;
    deBotonPlantilla?: boolean;
    imageId?: string;
    documentId?: string;
    documentName?: string;
  },
  prueba = false,
): void {
  let buf = buffers.get(msg.from);
  if (!buf) {
    buf = { textos: [], timer: null, messageId: msg.messageId, name: msg.name, prueba };
    buffers.set(msg.from, buf);
  }
  // Marca leído + mantiene "escribiendo…" vivo con CADA mensaje (mientras el
  // cliente sigue tecleando), no solo con el primero.
  void markReadAndTyping(msg.messageId);
  if (msg.text) buf.textos.push(msg.text);
  buf.messageId = msg.messageId;
  buf.prueba = prueba;
  if (msg.deBotonPlantilla) buf.deBotonPlantilla = true;
  if (msg.imageId) buf.imageId = msg.imageId;
  if (msg.documentId) {
    buf.documentId = msg.documentId;
    buf.documentName = msg.documentName;
  }
  if (msg.name) buf.name = msg.name;
  // Encuesta de satisfacción desactivada por pedido de Gladymar.
  if (buf.timer) clearTimeout(buf.timer);
  buf.timer = setTimeout(() => void vaciarCliente(msg.from), DEBOUNCE_MS);
  if (typeof buf.timer.unref === "function") buf.timer.unref();
}

async function vaciarCliente(from: string): Promise<void> {
  // Si ya hay un turno en proceso para este usuario, reintentamos en un momento.
  if (enCurso.has(from)) {
    const buf = buffers.get(from);
    if (buf) {
      buf.timer = setTimeout(() => void vaciarCliente(from), 800);
      if (typeof buf.timer.unref === "function") buf.timer.unref();
    }
    return;
  }
  const buf = buffers.get(from);
  if (!buf) return;
  buffers.delete(from);
  const text = buf.textos.join("\n").trim();
  // Una foto sin texto TAMBIÉN se atiende: antes se descartaba y el cliente
  // quedaba sin respuesta.
  if (!text && !buf.imageId && !buf.documentId) return;
  enCurso.add(from);
  try {
    await procesarTurnoCliente(from, text, buf.messageId, buf.name, {
      prueba: buf.prueba,
      deBotonPlantilla: buf.deBotonPlantilla,
      imageId: buf.imageId,
      documentId: buf.documentId,
      documentName: buf.documentName,
    });
  } finally {
    enCurso.delete(from);
  }
}

async function handleIncoming(msg: {
  from: string;
  text: string;
  messageId: string;
  name?: string;
  esAudio?: boolean;
  deBotonPlantilla?: boolean;
  imageId?: string;
  documentId?: string;
  documentName?: string;
}): Promise<void> {
  console.log(`📩 ${msg.from}${msg.name ? ` (${msg.name})` : ""}: ${msg.esAudio ? "(nota de voz)" : msg.text}`);

  // NOTA DE VOZ. No se transcribe: Claude no procesa audio, hace falta un
  // servicio de transcripción aparte (decisión pendiente, tiene costo por
  // minuto). Hasta entonces se CONTESTA igual, que es lo que importa: antes el
  // audio se descartaba en silencio y el cliente se quedaba esperando sin
  // saber que nadie lo había escuchado.
  if (msg.esAudio) {
    void markAsRead(msg.messageId);
    try {
      await sendText(
        msg.from,
        "¡Gracias por tu mensaje! 😊 Por ahora no puedo escuchar las notas de voz. " +
          "¿Me lo escribís en un mensaje y seguimos?",
      );
    } catch (err) {
      console.error(`No se pudo responder la nota de voz de ${msg.from}:`, err);
    }
    return;
  }

  // El botón de la campaña se atiende ANTES que cualquier otra cosa, incluido
  // el panel de administrador.
  //
  // El 22/10 Kevin tocó "Showrooms" en la plantilla y el bot le contestó "No
  // reconocí ese comando": su número es admin, y los admins se desvían al
  // panel antes de llegar a la lógica de cliente. Lo mismo le habría pasado a
  // cualquier asesor o gerente de la lista. Quien toca el botón de una
  // campaña espera el PDF, sea quien sea.
  if (msg.deBotonPlantilla && config.catalogoCampana && esBotonCatalogo(msg.text)) {
    void markAsRead(msg.messageId);
    try {
      await sendDocument(
        msg.from,
        config.catalogoCampana,
        "Showrooms Gladymar.pdf",
        "Nuestros showrooms ◆ Gladymar",
      );
      console.log(`📕 Catálogo de showrooms -> ${msg.from} (botón "${msg.text}").`);
    } catch (err) {
      console.error(`No se pudo mandar el catálogo de showrooms a ${msg.from}:`, err);
    }
    return;
  }

  // Si el número es de un administrador, va al panel admin (no al agente cliente).
  const admin = getAdminByPhone(msg.from);
  if (admin) {
    const t = msg.text.toLowerCase().trim();

    // Salir del modo "probar como cliente" → volver al panel.
    if (testCliente.has(msg.from) && /\bsalir\b|volver al panel|^panel$|^admin$/.test(t)) {
      testCliente.delete(msg.from);
      const pend = buffers.get(msg.from);
      if (pend?.timer) clearTimeout(pend.timer);
      buffers.delete(msg.from);
      agent.reset(`test:${msg.from}`);
      void markAsRead(msg.messageId);
      try {
        await sendText(msg.from, "✅ Volviste al *panel de administrador*.");
        await enviarPanel(msg.from, await handleAdminCommand(`wa:${msg.from}`, admin, "menu"));
      } catch (err) {
        console.error(`Error volviendo al panel admin para ${msg.from}:`, err);
      }
      return;
    }

    // ¿Está contestando cómo le fue con un lead? Va PRIMERO: si no, el panel
    // lee "Sigue en trato" como un comando cualquiera y le muestra el menú.
    if (!testCliente.has(msg.from)) {
      try {
        const r = await registrarRespuesta(msg.from, msg.text);
        if (r) {
          void markAsRead(msg.messageId);
          console.log(
            `🔁 ${admin.nombre} respondió "${r.respuesta.resultado}" sobre el cliente ${r.seguimiento.clienteTelefono}.`,
          );
          // La etapa viaja al CRM con el teléfono del CLIENTE, que es la ficha
          // que hay que mover, no la del asesor.
          if (r.respuesta.etapa) {
            void crm.send({
              external_id: r.seguimiento.clienteTelefono,
              name: r.seguimiento.clienteNombre,
              city: r.seguimiento.ciudad,
              stage: r.respuesta.etapa,
              asesor: r.seguimiento.asesorNombre,
              departamento: departamentoDeLugar(r.seguimiento.ciudad),
            });
          }
          await sendText(msg.from, acuse(r));
          await enviarPanel(msg.from, await handleAdminCommand(`wa:${msg.from}`, admin, "menu"));
          return;
        }
      } catch (err) {
        console.error(`Error registrando la respuesta de seguimiento de ${msg.from}:`, err);
      }
    }

    const pidioProbar = /probar/.test(t) && /(cliente|crm|agente|sistema|demo)/.test(t);

    // "Quiero una cotización" escrito EN EL PANEL.
    //
    // El panel matchea `cotiz` y devuelve los leads de cotización, así que el
    // admin pedía una cotización y recibía una lista. Le pasó a un supervisor
    // el 28/09/2026 y desde afuera parecía que no tenía permiso.
    //
    // Cotizar solo se puede en modo prueba, y entrar ahí no rompe nada (no
    // registra lead ni avisa a nadie), así que en vez de explicarle el camino
    // se lo hace: pidió cotizar, queda cotizando.
    const quiereCotizar =
      !/\blead/.test(t) &&
      (/^cotizar\b/.test(t) ||
        /\b(quiero|necesito|hacer|generar|armar|crear|simular)\b[^.]{0,24}cotiza/.test(t));

    // Entrar al modo "probar como cliente" (demo).
    if (!testCliente.has(msg.from) && (pidioProbar || quiereCotizar)) {
      testCliente.add(msg.from);
      agent.reset(`test:${msg.from}`);
      void markAsRead(msg.messageId);
      try {
        await sendText(
          msg.from,
          quiereCotizar
            ? "🧪 *Modo prueba activado* para que puedas cotizar.\n\nLas cotizaciones se arman conversando como lo haría un *cliente*: contame qué producto y cuántos m², y te mando el PDF con los precios de lista.\n\nEsto no cuenta como lead ni avisa a ningún asesor.\n\nPara volver al panel, escribí *salir*."
            : "🧪 *Modo prueba activado.*\n\nAhora te atiendo como si fueras un *cliente*. Escribí como uno más: por ejemplo *\"Hola\"*, pedí el catálogo, pedí una cotización, consultá sucursales...\n\nEsto es solo una demostración: *no* cuenta como lead ni avisa a ningún asesor.\n\nCuando quieras volver al panel, escribí *salir*.",
        );
      } catch (err) {
        console.error(`Error activando modo prueba para ${msg.from}:`, err);
      }
      return;
    }

    // Si el admin está en modo prueba, sus mensajes van al agente (agrupados, como el cliente).
    if (testCliente.has(msg.from)) {
      programarCliente(msg, true);
      return;
    }

    // Panel de administrador normal.
    void markAsRead(msg.messageId);
    try {
      await enviarPanel(
        msg.from,
        await handleAdminCommand(`wa:${msg.from}`, admin, msg.text, {
          imageId: msg.imageId,
          documentId: msg.documentId,
          documentName: msg.documentName,
        }),
      );
    } catch (err) {
      console.error(`Error en panel admin para ${msg.from}:`, err);
    }
    return;
  }

  // Cliente: agrupamos los mensajes seguidos para responder una sola vez.
  programarCliente(msg);
}

// ── Catálogo Dimensión Viva ──────────────────────────────────────────────────
// El catálogo IMPRESO lleva un QR que abre WhatsApp con un mensaje ya escrito
// ("quiero información sobre dimensión viva"). Ese cliente tiene el catálogo en
// la mano: espera el PDF de inmediato, así que el envío no depende de que el
// modelo decida ofrecerlo.
// Se recuerda a quién ya se le mandó para no repetir el archivo (18 MB) en cada
// mensaje de la misma conversación.
const catalogoYaEnviado = new Set<string>();

/** URL pública del PDF (config.assets.catalogoUrl puede ser relativa o absoluta). */
function urlCatalogo(): string {
  const u = config.assets.catalogoUrl;
  if (!u) return "";
  return /^https?:\/\//i.test(u) ? u : `${config.publicBaseUrl.replace(/\/$/, "")}${u.startsWith("/") ? "" : "/"}${u}`;
}

/** Igual que urlCatalogo pero para cualquier ruta configurada. */
function urlPublica(u: string): string {
  if (!u) return "";
  return /^https?:\/\//i.test(u) ? u : `${config.publicBaseUrl.replace(/\/$/, "")}${u.startsWith("/") ? "" : "/"}${u}`;
}

// ── Reconocer un nombre propio mal escrito ──────────────────────────────────
// El cliente escucha el nombre y lo escribe de memoria: "terrafote",
// "terreforte", "platinun". Parchar letra por letra no termina nunca, así que
// se compara por DISTANCIA DE EDICIÓN contra el nombre real.
function distancia(a: string, b: string): number {
  const fila = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previo = fila[0];
    fila[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const guardado = fila[j];
      fila[j] = Math.min(
        fila[j] + 1, // borrar
        fila[j - 1] + 1, // insertar
        previo + (a[i - 1] === b[j - 1] ? 0 : 1), // sustituir
      );
      previo = guardado;
    }
  }
  return fila[b.length];
}

/**
 * Deja la palabra en cómo SUENA en español, no en cómo se escribe. La falta
 * de ortografía más común no cambia el sonido: "elejansa" por "eleganza",
 * "bisenza" por "vicenza". Comparando el sonido, esas dejan de ser errores.
 */
function comoSuena(palabra: string): string {
  return palabra
    .replace(/h/g, "")              // hache muda
    .replace(/qu|k/g, "k")
    .replace(/[gj](?=[ei])/g, "j")  // gente = jente
    .replace(/g/g, "g")
    .replace(/c(?=[ei])/g, "s")     // cena = sena
    .replace(/[zc]/g, "s")          // za/zo/zu y ca/co/cu -> s/k ya cubiertos
    .replace(/v/g, "b")             // vaca = baca
    .replace(/ll/g, "y")
    .replace(/(.)\1+/g, "$1");     // letras dobladas
}

/**
 * Cuántas letras de diferencia se perdonan. Una palabra corta no perdona
 * nada (cambiarle una letra la convierte en otra), una larga perdona dos.
 */
function margen(palabra: string): number {
  if (palabra.length <= 6) return 0;
  if (palabra.length <= 9) return 1;
  return 2;
}

/**
 * Palabras corrientes que, al compararlas por sonido, caen demasiado cerca
 * del nombre de una colección. "Busco algo con elegancia" no es un pedido
 * del catálogo Eleganza.
 */
const NO_SON_NOMBRES = new Set(["elegancia", "elegante", "elegantes"]);

/** ¿El texto nombra alguno de estos nombres, aun escrito con errores? */
function nombraAlguno(texto: string, nombres: string[]): boolean {
  const palabras = texto.split(/[^a-z0-9]+/).filter((p) => p && !NO_SON_NOMBRES.has(p));
  // También los pares pegados, para "tera forte" => "teraforte".
  const candidatos = [...palabras];
  for (let i = 0; i + 1 < palabras.length; i++) candidatos.push(palabras[i] + palabras[i + 1]);
  return nombres.some((nombre) => {
    const n = comoSuena(nombre);
    return candidatos.some((c) => {
      const s = comoSuena(c);
      return Math.abs(s.length - n.length) <= 2 && distancia(s, n) <= margen(n);
    });
  });
}

// ── Catálogos adicionales ───────────────────────────────────────────────────
// Ninguno de estos se ofrece solo: el que manda por defecto sigue siendo
// Dimensión Viva. Cada uno sale cuando el cliente lo nombra o cuando habla de
// lo que ese catálogo cubre. Agregar otro es una fila más en esta tabla.
const CATALOGOS_EXTRA: {
  clave: string;
  nombre: string;
  archivo: string;
  pie: string;
  url: () => string;
  /** Nombres propios que lo identifican (se comparan tolerando errores). */
  nombra: string[];
  /** De qué habla un cliente al que le sirve este catálogo. */
  interesa: RegExp;
}[] = [
  {
    clave: "eleganza",
    nombre: "Eleganza",
    archivo: "Gladymar - Catálogo Eleganza.pdf",
    pie: "Colección Eleganza ◆ Gladymar",
    url: () => config.assets.catalogoEleganzaUrl,
    nombra: ["eleganza"],
    interesa: /(?!)/, // solo por nombre, hasta que Gladymar defina qué cubre
  },
  {
    // CATÁLOGO DISTRIBUIDORES 2026. Porcelanato 60,8x60,8, PEI 4, 8 mm,
    // 2,22 m2 por caja (6 piezas), en tres líneas: PLATINUM, TERRAFORTE y
    // ARTEMA. Al ser de distribuidores, "interesa" incluye a quien se
    // presenta como distribuidor o mayorista, además de quien nombra una
    // de las colecciones.
    clave: "plat_terr_art",
    nombre: "Platinum · Terraforte · Artema",
    archivo: "Gladymar - Catálogo Platinum Terraforte Artema 2026.pdf",
    pie: "Platinum ◆ Terraforte ◆ Artema 2026 ◆ Gladymar",
    url: () => config.assets.catalogoPlatTerrArtUrl,
    nombra: ["platinum", "platino", "terraforte", "artema"],
    interesa: new RegExp(
      "\\b(" +
        // Quien compra por volumen: este catálogo es el suyo.
        "distribuidor(es)?|mayorista|revendedor|ferreteria|" +
        // PLATINUM
        "elvis gris|luna graffito|oxidum|paladio sand|prima blanco|" +
        "calacatta silver|madera marfil|leno wengue|ebano venato|taj ?mahal|" +
        "steelix|pedra cinza|arena beige|" +
        // TERRAFORTE
        "teefe|silver stone|madera ceniza|cimento cinza|rock cream|" +
        "rovere toscano|vicenza roble|nogal nocturno|onice bianco|" +
        "alamo beige|kuentin|piedra marcada|oxido camel|" +
        // ARTEMA
        "carrara venato|jaspe plata|blanco hielo|calacatta blanco|" +
        "perlino|oro bianco|marmol bianco|beige claro|marmol light" +
        ")\\b",
    ),
  },
];

/** A quién ya se le mandó cada catálogo extra, para no repetirlo. */
const extraYaEnviado = new Map<string, Set<string>>();

async function enviarCatalogoExtra(
  to: string,
  cat: (typeof CATALOGOS_EXTRA)[number],
): Promise<void> {
  const url = urlPublica(cat.url());
  if (!url) return;
  await sendDocument(to, url, cat.archivo, cat.pie);
  console.log(`📕 Catálogo ${cat.nombre} enviado a ${to}`);
}

/**
 * Qué catálogos extra corresponden a este mensaje. Un catálogo sin URL
 * cargada no entra: mandar un enlace roto es peor que no mandar nada.
 */
function catalogosExtraPara(texto: string): typeof CATALOGOS_EXTRA {
  const t = texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  return CATALOGOS_EXTRA.filter(
    (c) => c.url() && (nombraAlguno(t, c.nombra) || c.interesa.test(t)),
  );
}

async function enviarCatalogo(to: string): Promise<void> {
  const url = urlCatalogo();
  if (!url) return;
  await sendDocument(
    to,
    url,
    "Gladymar - Catálogo Dimensión Viva 2026.pdf",
    "Colección Dimensión Viva 2026 ◆ Gladymar",
  );
  console.log(`📕 Catálogo Dimensión Viva enviado a ${to}`);
}

/**
 * ¿A este número se le ofrece el visualizador?
 *
 * Sin URL cargada queda apagado para todos: mandar un botón que no lleva a
 * ningún lado es peor que no mandarlo. Con URL y sin lista de teléfonos, va
 * para todos; con lista, solo para esos (así se prueba con dos números antes
 * de abrirlo).
 */
/**
 * A quién ya se le ofreció el visualizador.
 *
 * En memoria: lo peor que pasa si el proceso se reinicia es que a un cliente
 * se le ofrezca una segunda vez, horas después. Guardarlo en la base por eso
 * sería caro para el daño que evita.
 */
const ambienteOfrecido = new Set<string>();

/**
 * ¿El texto que llegó es el botón del catálogo de la campaña?
 *
 * Se compara contra el TEXTO del botón, que es lo que WhatsApp manda cuando no
 * hay payload. Se acepta cualquier variante que mencione el catálogo para no
 * depender de una tilde o una mayúscula: el botón lo escribió una persona en
 * el panel de Meta y puede cambiar sin que nos enteremos.
 */
/**
 * ¿El cliente tocó el botón que pide el catálogo de showrooms?
 *
 * Mira el TEXTO del botón, que lo elige Gladymar al armar la plantilla y
 * cambia entre versiones: la primera decía "Quiero el catálogo" y la del
 * 21/10 dice "Showrooms". Con solo "catalogo" la versión nueva no disparaba
 * nada y el cliente se quedaba sin el PDF.
 */
function esBotonCatalogo(texto: string): boolean {
  const t = (texto || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  return t.includes("catalogo") || t.includes("showroom");
}

function roomvoHabilitado(telefono: string): boolean {
  if (!config.roomvo.url) return false;
  if (!config.roomvo.telefonos.length) return true;
  const d = telefono.replace(/\D/g, "");
  return config.roomvo.telefonos.some((t) => d === t || d.endsWith(t));
}

async function procesarTurnoCliente(
  from: string,
  text: string,
  messageId: string,
  name?: string,
  opts?: {
    prueba?: boolean;
    imageId?: string;
    documentId?: string;
    documentName?: string;
    /** De dónde escribió. Por defecto WhatsApp, que es como venía siendo. */
    canal?: Canal;
    /** Tocó un botón de una plantilla (campaña), no escribió el texto. */
    deBotonPlantilla?: boolean;
  },
): Promise<void> {
  const canal: Canal = opts?.canal ?? "whatsapp";
  const esWhatsApp = canal === "whatsapp";
  // En modo prueba (un admin probando como cliente) usamos una sesión aparte
  // y NO registramos nada real (ni KPIs, ni lead, ni CRM/Sheets).
  const prueba = opts?.prueba === true;
  // El QR del catálogo físico manda un texto fijo; se detecta acá para que el
  // PDF salga siempre, sin depender de cómo lo interprete el modelo.
  const porQrCatalogo = !prueba && pideDimensionViva(text);
  // También en modo prueba: mandar un PDF no crea lead ni avisa a nadie, y si
  // no, no hay forma de probarlo desde el panel.
  const extrasQueTocan = catalogosExtraPara(text);
  // La sesión de Messenger/Instagram va prefijada con el canal. Dos efectos, y
  // los dos hacen falta: separa la conversación de la de un WhatsApp con los
  // mismos dígitos, y hace que brain.ts NO tome el PSID por un teléfono (su
  // chequeo es /^\d{6,}$/, que un PSID pasa). Sin eso el bot guardaría
  // "teléfonos" de clientes a los que nadie puede llamar.
  const sessionId = prueba ? `test:${from}` : idParaCrm(canal, from);

  // Marca leído + "escribiendo…" y suma a KPIs. Son llamadas de la API de
  // WhatsApp; en Messenger e Instagram no existen y fallarían.
  if (esWhatsApp) void markReadAndTyping(messageId);
  const tEscribiendo = Date.now();
  if (!prueba) bumpConversacion();

  // Recordá la ciudad si el cliente la menciona (para mandarla siempre al CRM).
  if (!prueba) {
    const cd = detectarCiudad(text);
    if (cd) ciudadPorUsuario.set(from, cd);
  }

  // Botón del catálogo de la campaña DEXCO.
  //
  // Va ANTES del agente y manda el PDF directo: el cliente tocó un botón que
  // dice que quiere el catálogo, así que la respuesta es el catálogo. Pasarlo
  // por el modelo para que "decida" sería agregarle una oportunidad de
  // equivocarse a algo que ya está decidido.
  //
  // Es OTRO archivo que el catálogo Dimensión Viva: aquel es de productos y
  // este es de showrooms, que es lo que promete la campaña.
  if (opts?.deBotonPlantilla && config.catalogoCampana && esBotonCatalogo(text)) {
    void markAsRead(messageId);
    try {
      await sendDocument(
        from,
        config.catalogoCampana,
        "Showrooms Gladymar.pdf",
        "Nuestros showrooms ◆ Gladymar",
      );
      console.log(`📕 Catálogo de showrooms -> ${from} (botón "${text}").`);
    } catch (err) {
      console.error(`No se pudo mandar el catálogo de showrooms a ${from}:`, err);
    }
    // Y SIGUE al agente: después del PDF tiene que haber una conversación, no
    // un archivo suelto. El cliente acaba de levantar la mano.
  }

  try {
    // Si mandó una foto (captura del catálogo, un ambiente, un producto en obra),
    // se descarga de Meta para que el agente pueda VERLA. Si falla, se sigue con
    // el texto solamente: nunca se deja al cliente sin respuesta por una imagen.
    const imagen = opts?.imageId ? ((await downloadMedia(opts.imageId)) ?? undefined) : undefined;
    if (opts?.imageId) {
      console.log(`🖼️  Foto de ${from}: ${imagen ? "descargada, se envía al agente" : "no se pudo leer"}`);
    }

    // PDF: una cotización de otra casa, una orden, una ficha escrita. Claude lo
    // lee directo, sin convertirlo a imágenes.
    const docDescargado = opts?.documentId ? await downloadDocumento(opts.documentId) : null;
    const documento = docDescargado
      ? { base64: docDescargado.base64, nombre: opts?.documentName }
      : undefined;
    if (opts?.documentId) {
      console.log(`📄 PDF de ${from}: ${documento ? "descargado, se envía al agente" : "no se pudo leer"}`);
    }

    // La cotización en PDF va al CLIENTE FINAL, que es lo que promete la
    // página 8 de la propuesta.
    //
    // Estuvo reservada al Gerente General y a COTIZACION_PDF_TELEFONOS desde el
    // 15/09/2026, mientras los precios se probaban. Gladymar la abrió a todos
    // los clientes el 30/09/2026, después de que siete asesores la usaran en
    // producción y de cerrar los tres errores de precio que tenía (la unidad en
    // cajas, el origen nacional/importado y la segunda selección).
    //
    // Para volver a cerrarla: `prueba && puedeCotizarPDF(from)`.
    const cotizacionPDF = true;
    const reply = await agent.handleMessage(sessionId, text, { cotizacionPDF, prueba, imagen, documento });

    // La cotización se GENERA antes de empezar a escribir, para poder mandarla
    // en medio de los bloques y no al final.
    //
    // El orden importa: el modelo escribe un mensaje que presenta la cotización
    // y otro que cierra ("¿querés que te conecte con un asesor?"). Mandando el
    // PDF después de TODO el texto, al cliente le llegaba el cierre antes que
    // la cotización, y la conversación quedaba al revés: se despedía de él
    // antes de darle lo que había pedido.
    // El catálogo va PRIMERO, antes del texto. Kevin, 20/10: "tendría que
    // enviar el catálogo primero para que el cliente vea... y después ya el
    // cliente le pregunta o le envía un screenshot". Si el bot pregunta antes
    // de dar el PDF, le pide al cliente que decida sobre algo que todavía no
    // vio.
    for (const cat of extrasQueTocan) {
      let mandados = extraYaEnviado.get(cat.clave);
      if (!mandados) {
        mandados = new Set<string>();
        extraYaEnviado.set(cat.clave, mandados);
      }
      if (mandados.has(from)) continue;
      try {
        await enviarCatalogoExtra(from, cat);
        mandados.add(from);
      } catch (err) {
        console.error(`No pude mandar el catálogo ${cat.nombre} a ${from}:`, err);
      }
    }

    let pdfCotizacion: string | null = null;
    if (reply.cotizacion) {
      try {
        const rel = await generarCotizacionPDF(reply.cotizacion);
        pdfCotizacion = `${config.publicBaseUrl.replace(/\/$/, "")}/${rel}`;
      } catch (err) {
        console.error(`No se pudo generar la cotización de ${from}:`, err);
      }
    }

    // Respuestas en bloques: muestra "escribiendo…" antes de cada bloque (y un mínimo antes del primero).
    // El último bloque, si hay opciones, se envía como LISTA interactiva (igual que el demo).
    const bloques = splitBlocks(reply.text);
    for (let i = 0; i < bloques.length; i++) {
      const esUltimo = i === bloques.length - 1;

      if (i === 0) {
        const transcurrido = Date.now() - tEscribiendo;
        if (transcurrido < 1200) await sleep(1200 - transcurrido);
      } else {
        if (esWhatsApp) void markReadAndTyping(messageId);
        await sleep(typingMs(bloques[i]));
      }

      // Messenger e Instagram no tienen listas interactivas como WhatsApp: las
      // opciones van numeradas en el texto, que es lo que ya se usa como
      // respaldo cuando la lista falla.
      const comoTexto = (bloque: string) =>
        reply.options.length
          ? `${bloque}\n\n${reply.options.map((o, j) => `*${j + 1}.* ${o}`).join("\n")}`
          : bloque;

      if (!esWhatsApp) {
        await enviarMeta(canal, from, esUltimo ? comoTexto(bloques[i]) : bloques[i]);
      } else if (esUltimo && reply.options.length) {
        try {
          // Nunca una lista "pelada": si no vino texto, usamos una guía cálida.
          const cuerpo = (bloques[i] || "").trim() || `${reply.optionsTitle || "Contame"} 😊 ¿Cuál preferís?`;
          await sendInteractiveList(
            from,
            cuerpo,
            reply.optionsButton || "Ver opciones",
            reply.optionsTitle || "Opciones",
            reply.options,
          );
        } catch (err) {
          console.error("Lista interactiva falló; envío como texto:", err);
          await sendText(from, comoTexto(bloques[i]));
        }
      } else {
        await sendText(from, bloques[i]);
      }

      // El PDF va pegado al primer bloque, que es el que lo presenta
      // ("te paso la cotización"), y antes de los que cierran.
      if (pdfCotizacion && reply.cotizacion && i === 0) {
        try {
          await sendDocument(
            from,
            pdfCotizacion,
            `Cotización ${reply.cotizacion.numero}.pdf`,
            "Precios de lista vigentes hoy ◆ Gladymar",
          );
        } catch (err) {
          console.error(`No se pudo enviar la cotización a ${from}:`, err);
        }
      }
    }

    // "Ver en mi ambiente": botón que abre el visualizador de Gladymar.
    //
    // Va como botón y no como link pelado porque el cliente no tiene que
    // copiar ni pegar nada: toca y se abre el navegador interno de WhatsApp,
    // sin salir de la app. Es lo más cerca de visualizar dentro del chat que
    // permite Meta — un Flow no sirve, solo renderiza componentes propios y no
    // puede correr una web de terceros, que es lo que es el visualizador.
    if (reply.verEnAmbiente && esWhatsApp && roomvoHabilitado(from)) {
      // Una sola vez por conversación, y esto lo decide el CÓDIGO.
      //
      // El 15/10 llegaron dos botones idénticos seguidos. La causa fue un
      // error de edición: este bloque había quedado escrito DOS VECES en el
      // archivo, así que el turno mandaba dos. Eso ya está corregido — queda
      // un solo bloque — y este guard se queda igual, porque el prompt le pide
      // al modelo que no repita el marcador y pedírselo no es impedírselo.
      if (ambienteOfrecido.has(from)) {
        console.log(`🏠 Visualizador ya ofrecido a ${from} en esta conversación; no se repite.`);
      } else {
        try {
          await sleep(600);
          const wamid = await sendBotonUrl(
            from,
            `Así podés ver el *${reply.verEnAmbiente}* en tu propio ambiente 😊\n\n` +
              "Subí una foto de tu espacio (o usá una de las habitaciones de ejemplo) y mirá cómo queda antes de decidir.",
            "🏠 Ver en mi ambiente",
            config.roomvo.url,
          );
          ambienteOfrecido.add(from);
          console.log(`🏠 Visualizador -> ${from} (${reply.verEnAmbiente}) id=${wamid ?? "sin id"}`);
        } catch (err) {
          console.error(`No se pudo enviar el botón del visualizador a ${from}:`, err);
        }
      }
    }

    // Sucursales: enviamos el bloque OFICIAL VERBATIM (direcciones/WhatsApp/horarios
    // exactos del listado, NUNCA lo que el modelo "recuerde"). Anti-alucinación.
    if (reply.sucursales) {
      try {
        for (const parte of splitLong(reply.sucursales, 3500)) {
          await sleep(500);
          await sendText(from, parte);
        }
      } catch (err) {
        console.error(`No se pudo enviar sucursales a ${from}:`, err);
      }
    }

    // Adjunta el Manual de Asentamiento (PDF) si el cliente lo pidió y hay enlace configurado.
    if (reply.attachManual && config.assets.manualUrl) {
      try {
        await sendDocument(
          from,
          config.assets.manualUrl,
          "Gladymar - Manual de Asentamiento.pdf",
          "Manual de Asentamiento (Tríptico de Colocación) ◆ Gladymar",
        );
      } catch (err) {
        console.error(`No se pudo adjuntar el manual a ${from}:`, err);
      }
    }

    // Catálogo Dimensión Viva: se adjunta si el agente lo ofreció, o si el
    // cliente llegó por el QR del catálogo físico (ver `llegaPorQrCatalogo`).
    if ((reply.attachCatalogo || porQrCatalogo) && !catalogoYaEnviado.has(from)) {
      try {
        await enviarCatalogo(from);
        catalogoYaEnviado.add(from);
      } catch (err) {
        console.error(`No se pudo adjuntar el catálogo a ${from}:`, err);
      }
    }

    // El asesor tiene que ver lo mismo que vio el cliente ANTES de llamarlo:
    // si no, el cliente le habla de un precio que el asesor no conoce. Va
    // después de la conversación porque no la interrumpe.
    if (reply.cotizacion && pdfCotizacion && !prueba) {
      void avisarCotizacionAlAsesor(from, name, reply.cotizacion, pdfCotizacion);
    }

    console.log(`🤖 -> ${prueba ? "[PRUEBA] " : ""}${from}: ${reply.text.slice(0, 120)}...`);

    // En modo prueba no registramos nada real (ni handoff, ni Sheets, ni CRM).
    if (!prueba) {
      // ¿El remitente es un administrador/asesor del roster? Si lo es, sus chats
      // NUNCA se califican como lead ni avisan a otros asesores: solo se marca
      // como administrador en el CRM. (Un asesor puede hablar de "un cliente X"
      // desde su WhatsApp; eso no debe convertirse en un lead con datos cruzados.)
      const adminRemitente = getAdminByPhone(from);

      // Handoff: si se registró una solicitud, avisamos al asesor de su ciudad.
      // Pero NUNCA para números del roster (evita avisos de lead con datos ajenos).
      if (reply.solicitud && !adminRemitente) {
        void notificarAsesor(from, name, reply.solicitud, canal);
      }
      if (reply.escalated) {
        console.log(`🔔 Derivación a humano para ${from}`);
      }

      // Registra la interacción. Va a DOS destinos independientes:
      //  - Postgres: fuente de verdad nuestra, no se pierde nada.
      //  - Google Sheets: cómodo para el equipo, pero depende de un Apps Script
      //    externo que ya se cayó antes (401) y se perdieron conversaciones.
      // Ninguno de los dos bloquea ni interrumpe la atención si falla.
      const registro = {
        fecha: nowBolivia(),
        telefono: from,
        nombre: adminRemitente?.nombre || name,
        ciudad: adminRemitente?.region || reply.solicitud?.ciudad || ciudadPorUsuario.get(from),
        mensaje: text,
        respuesta: reply.text,
        tipo_solicitud: adminRemitente ? undefined : reply.solicitud?.tipo,
        prioridad: adminRemitente ? undefined : reply.solicitud?.prioridad,
        detalle: adminRemitente ? undefined : reply.solicitud?.detalle,
        escalado: reply.escalated,
      };
      void insertarConversacion(registro);
      void sheets.log(registro);

      // Envía la interacción al CRM de Prime en tiempo real (best-effort, sin bloquear).
      // El payload se arma ATÓMICAMENTE con datos de ESTA conversación (locales),
      // nunca de estado compartido. Si es admin: solo marca is_admin, SIN campos de
      // lead (stage/interest), para que el CRM no lo trate como cliente calificado.
      const ciudadSolicitud = reply.solicitud?.ciudad;
      if (ciudadSolicitud && !adminRemitente) {
        const cd = detectarCiudad(ciudadSolicitud) || ciudadSolicitud;
        ciudadPorUsuario.set(from, cd);
      }
      // Asesor asignado: el mismo al que se le mandó el handoff por WhatsApp,
      // resuelto por municipio -> departamento. Si no se reconoce el lugar queda
      // undefined y el campo NO viaja: mandarlo vacío borraría en el CRM una
      // asignación que alguien pudo haber hecho a mano.
      const ciudadLead = reply.solicitud?.ciudad || ciudadPorUsuario.get(from);
      const asesorLead = adminRemitente ? undefined : await asesorDeCliente(idParaCrm(canal, from), ciudadLead);
      void crm.send({
        // Prefijado con el canal cuando no es WhatsApp: un PSID y un teléfono
        // pueden tener los mismos dígitos y serían la misma ficha.
        external_id: idParaCrm(canal, from),
        channel: canal,
        name: adminRemitente?.nombre || reply.solicitud?.nombre || name,
        city: adminRemitente?.region || ciudadLead,
        segment: adminRemitente ? "Administrador" : undefined,
        stage: adminRemitente ? undefined : stageDeTipo(reply.solicitud?.tipo),
        tipo_solicitud: adminRemitente ? undefined : tipoSolicitudCrm(reply.solicitud?.tipo),
        interest: adminRemitente ? undefined : reply.solicitud?.detalle,
        // El nombre tiene que ser EXACTO al del padrón: el CRM lo cruza literal
        // para darle la cartera al asesor. Por eso sale del reparto y no de la
        // tabla de regionales, que lo tiene con tilde ("Thalía") y no cruzaría.
        asesor: adminRemitente ? undefined : asesorLead?.nombre || adminNombrePorCiudad(ciudadLead),
        // El departamento viaja aunque NO haya asesor (Beni, Pando): así el CRM
        // puede filtrar por región sin depender del nombre del asesor, y un lead
        // de una región sin asesor asignado igual lo ve alguien.
        departamento: adminRemitente ? undefined : departamentoDeLugar(ciudadLead),
        message: text,
        response: reply.text,
        is_admin: Boolean(adminRemitente),
        role: adminRemitente?.role,
      });
    }
  } catch (err) {
    console.error(`Error atendiendo a ${from}:`, err);
    try {
      await sendText(
        from,
        "Disculpe, tuvimos un inconveniente técnico. Por favor intente nuevamente en unos minutos. 🙏",
      );
    } catch {
      /* sin red, nada más que hacer */
    }
  }
}

// ── Reportes automáticos para el Gerente General ─────────────────────────────
// Se mandan a las horas configuradas (zona Bolivia, ej. 8am y 5pm), SIN que
// nadie lo pida. Reutiliza el mismo texto de "Reportes globales" del panel.
// Cada franja (fecha + hora) se manda una sola vez.
const reportesEnviados = new Set<string>(); // claves "fecha|hora"

function fechaBoliviaHoy(): string {
  return new Date().toLocaleString("es-BO", { timeZone: "America/La_Paz", hour12: false }).split(",")[0].trim();
}
function horaBoliviaActual(): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/La_Paz", hour: "numeric", hour12: false }).format(new Date()));
}

async function chequearReportesAutomaticos(): Promise<void> {
  if (!isWhatsAppConfigured()) return;
  const hoy = fechaBoliviaHoy();
  const horaActual = horaBoliviaActual();

  for (const hora of config.reporteDiario.horasBolivia) {
    if (horaActual < hora) continue; // todavía no es esta franja
    const clave = `${hoy}|${hora}`;
    if (reportesEnviados.has(clave)) continue; // ya se mandó esta franja hoy

    reportesEnviados.add(clave); // marcar ANTES de mandar, para no reintentar en loop si falla el envío
    try {
      const texto = await reportes();
      await sendText(ADMIN_TELEFONO, `🗓️ *Reporte automático* (${String(hora).padStart(2, "0")}:00)\n\n${texto}`);
      console.log(`📊 Reporte automático (${hora}:00) enviado a ${ADMIN_TELEFONO}`);
    } catch (err) {
      console.error(`No se pudo enviar el reporte automático de las ${hora}:00:`, err);
    }
  }
}

const reportesAutomaticosTimer = setInterval(() => void chequearReportesAutomaticos(), 15 * 60 * 1000);
if (typeof reportesAutomaticosTimer.unref === "function") reportesAutomaticosTimer.unref();
void chequearReportesAutomaticos(); // chequeo inicial (por si el proceso arranca después de alguna franja)

// ── Notificaciones automáticas de estado de pedido ───────────────────────────
// Avisa al cliente por WhatsApp (plantilla de Meta) cuando su pedido pasa a
// "Preparado" o "Despachado", sin que tenga que preguntar. Ver pedidoEstados.ts.
const pedidosAutomaticosTimer = setInterval(
  () => void chequearNotificacionesPedidos(),
  config.despacho.chequeoMinutos * 60 * 1000,
);
if (typeof pedidosAutomaticosTimer.unref === "function") pedidosAutomaticosTimer.unref();
void chequearNotificacionesPedidos();

// ── Consumo de tokens en el log ─────────────────────────────────────────────
// El endpoint /admin/uso requiere abrir el navegador con la clave; esto deja
// el mismo dato en los logs, que es donde se mira cuando algo preocupa.
async function loguearUso(): Promise<void> {
  const r = await resumenUso(60);
  if (!r) return;
  const t = r.totales;
  // El día de HOY se busca por su clave, no se toma el primero de la lista: si
  // alguna vez el orden vuelve a fallar, esto muestra "sin datos" en vez de
  // etiquetar como "hoy" el consumo de otro día.
  const hoy = r.dias.find((d) => d.fecha === fechaBolivia());
  console.log(
    `🧮 Tokens acumulados (${r.dias.length} día/s): ${t.llamadas} llamada(s), ` +
      `entrada ${t.entrada}, salida ${t.salida}, caché escrito ${t.cacheEscrito}, caché leído ${t.cacheLeido} ` +
      `=> USD ${r.costoUsd.toFixed(4)} (sin caché habría sido USD ${r.costoSinCacheUsd.toFixed(4)}).` +
      (hoy ? ` Hoy (${hoy.fecha}): ${hoy.llamadas} llamada(s).` : ""),
  );
}
// Seguimiento al asesor: cada 30 min se mira si hay leads derivados sin
// resultado a los que ya les toca la pregunta. El intervalo es del chequeo, no
// de la pregunta: cada lead se pregunta según config.seguimientoAsesor.horas.
const seguimientoTimer = setInterval(() => void preguntarSeguimientos(), 30 * 60 * 1000);
if (typeof seguimientoTimer.unref === "function") seguimientoTimer.unref();
void preguntarSeguimientos();

/**
 * Pregunta por DM nuevos de Messenger e Instagram.
 *
 * Es el camino alternativo al webhook, para cuando Meta no entrega los eventos
 * (le pasó a Gladymar el 12/10/2026: la página suscrita, el token con permisos
 * y ni un solo POST al webhook). Apagado por defecto: se enciende con
 * META_SONDEO_SEGUNDOS.
 */
/**
 * Avisa de un fallo del sondeo SIN inundar el log.
 *
 * El sondeo corre cada minuto, así que un error que no se va —hoy el #230 de
 * Instagram, que espera un permiso de Meta -- escribe 1.440 líneas por día y
 * tapa todo lo demás. Un log que nadie puede leer no avisa de nada; lo pidió
 * Prime después de perder un rato buscando otro error debajo de estas.
 *
 * Mientras el error sea EL MISMO, se escribe una vez por hora. Si cambia, se
 * escribe en el acto: un error distinto es justamente la noticia que estamos
 * esperando, y hacerla esperar una hora sería el error contrario.
 *
 * "El mismo" se decide SIN el fbtrace_id. Meta manda uno nuevo en cada llamada,
 * así que compararlo entero hacía que toda repetición pareciera un error nuevo
 * y el agrupado no agrupara nada: el primer intento quedó escribiendo una línea
 * por minuto igual que antes. Lo detectó Prime mirando los logs en producción.
 */
const ultimoFalloSondeo = new Map<string, { firma: string; cuando: number; repetidos: number }>();
const SILENCIO_SONDEO_MS = 60 * 60 * 1000;

/** Un identificador de traza que cambia en cada llamada no distingue un error de otro. */
function firmaDeError(err: unknown): string {
  return String(err)
    .replace(/"fbtrace_id"\s*:\s*"[^"]*"/g, "")
    .replace(/,\s*,/g, ",")
    .replace(/\s+/g, " ")
    .trim();
}

function avisarFalloSondeo(canal: Canal, err: unknown): void {
  const firma = firmaDeError(err);
  const previo = ultimoFalloSondeo.get(canal);
  const ahora = Date.now();

  if (previo && previo.firma === firma && ahora - previo.cuando < SILENCIO_SONDEO_MS) {
    previo.repetidos++;
    return;
  }

  const repetidos = previo && previo.firma === firma ? previo.repetidos : 0;
  const cola = repetidos > 0 ? ` (y ${repetidos} vez/veces más en la última hora, sin cambios)` : "";
  console.error(`No se pudieron sondear los mensajes de ${nombreCanal(canal)}${cola}:`, err);
  ultimoFalloSondeo.set(canal, { firma, cuando: ahora, repetidos: 0 });
}

async function sondearDirectos(): Promise<void> {
  if (!sondeoHabilitado() || !metaHabilitado("messenger")) return;
  for (const canal of ["instagram", "messenger"] as const) {
    if (!metaHabilitado(canal)) continue;
    try {
      const nuevos = await sondearMensajes(canal);
      for (const m of nuevos) {
        marcarAtendido(m.messageId);
        console.log(`💬 ${nombreCanal(canal)} (sondeo) ${m.from}: ${m.text}`);
        void procesarTurnoCliente(m.from, m.text, m.messageId, m.name, { canal }).catch((err) =>
          console.error(`Error atendiendo ${nombreCanal(canal)} a ${m.from}:`, err),
        );
      }
    } catch (err) {
      avisarFalloSondeo(canal, err);
    }
  }
}

/**
 * Al arrancar: conseguir el token de página y suscribir la página.
 *
 * Son los dos pasos que faltaban para que Messenger e Instagram funcionen, y
 * ninguno se puede hacer desde el panel de la app:
 *
 * 1. El token. Meta rechazaba las llamadas con "(#190) This method must be
 *    called with a Page Access Token": el token de System User tiene todos los
 *    permisos pero no ES el token de la página. Se lo pide a Meta y listo.
 * 2. La suscripción. Elegir los campos en el panel dice qué escucha la app;
 *    esto dice que los quiere de ESTA página. Sin el paso 2 el panel muestra
 *    todo suscrito y al webhook no llega nada — lo que venía pasando.
 */
if (metaHabilitado("messenger")) {
  void (async () => {
    try {
      const datos = await datosDePagina();
      if (!datos) return;
      console.log(
        `📘 Página de Meta lista: ${datos.nombre ?? datos.id}` +
          (datos.instagramId ? ` · Instagram ${datos.instagramId}` : " · sin Instagram vinculado"),
      );
      const sub = await suscribirPagina();
      console.log(
        sub.ok
          ? `📘 Página suscrita a los eventos: ${sub.detalle}`
          : `No se pudo suscribir la página a los eventos: ${sub.detalle}`,
      );
    } catch (err) {
      console.error("No se pudo preparar Messenger/Instagram:", err);
    }
  })();
}

/**
 * Orden de una sola vez: ver una plantilla y, si se pidió, mandarla.
 *
 * Se dispara con PLANTILLA_ENVIO porque desde el entorno de desarrollo no hay
 * salida ni a la API de Meta ni a este servicio, así que la variable es la
 * única palanca. Corre UNA vez aunque la variable siga puesta: el servicio se
 * reinicia seguido y una orden que se repite en cada arranque ya nos mordió
 * con el reporte diario, que volvía a salir cada vez que el proceso levantaba.
 */
/**
 * Re-registrar el número si Gladymar cargó el PIN.
 *
 * Se corre ANTES que todo lo demás: con el número desregistrado, cada envío
 * del arranque (reportes, seguimientos, plantillas) falla con 133010 y solo
 * llena el log de ruido.
 *
 * No es de una sola vez: registrar un número ya registrado no hace daño, y si
 * el número se vuelve a caer queremos que el próximo arranque lo levante sin
 * que nadie tenga que mirar.
 */
if (config.registroPin) {
  void (async () => {
    const r = await registrarNumero(config.registroPin);
    console.log(
      r.ok
        ? "📞 Número re-registrado en la API de WhatsApp."
        : `📞 No se pudo re-registrar el número: ${JSON.stringify(r.detalle)}`,
    );
  })();
}

if (config.plantillaEnvio) {
  void (async () => {
    const [nombre, destinoCrudo, media] = config.plantillaEnvio.split("|").map((x) => x.trim());
    // Varios números separados por coma: la campaña va a una lista corta y
    // mandarla de a uno obligaba a un despliegue por destinatario.
    const destinos = (destinoCrudo || "")
      .split(",")
      .map((d) => d.replace(/\D/g, ""))
      .filter(Boolean);
    if (!nombre) return;

    const def = await leerPlantilla(nombre);
    if (!Array.isArray(def)) {
      console.error(`📣 No pude leer la plantilla "${nombre}": ${def.error}`);
      return;
    }
    if (!def.length) {
      console.error(`📣 Meta no tiene ninguna plantilla llamada "${nombre}".`);
      return;
    }
    const pl = def[0];
    const header = pl.components?.find((c) => c.type === "HEADER");
    const formato = String(header?.format || "TEXTO").toUpperCase();
    const cuerpo = pl.components?.find((c) => c.type === "BODY");
    const variables = String(cuerpo?.text || "").match(/\{\{\d+\}\}/g)?.length ?? 0;
    // Los botones se loguean porque de ellos depende qué hace el bot cuando el
    // cliente los toca: hay que saber el texto EXACTO para reconocerlo.
    const botones = (pl.components?.find((c) => c.type === "BUTTONS") as
      | { buttons?: { type?: string; text?: string }[] }
      | undefined)?.buttons;
    console.log(
      `📣 Plantilla "${nombre}": estado ${pl.status ?? "?"}, categoría ${pl.category ?? "?"}, ` +
        `idioma ${pl.language ?? "?"}, encabezado ${formato}, ${variables} variable(s) en el cuerpo` +
        (botones?.length ? `, botones: ${botones.map((b) => `${b.type}:"${b.text}"`).join(" | ")}` : ", sin botones") +
        ".",
    );

    if (!destinos.length) {
      console.log("📣 Sin destino en PLANTILLA_ENVIO: solo se muestra, no se manda nada.");
      return;
    }
    if (variables > 0) {
      console.error(`📣 NO la mando: el cuerpo tiene ${variables} variable(s) y no sé con qué llenarlas.`);
      return;
    }
    // Si el encabezado es de media y no nos pasaron la URL, se intenta con el
    // identificador que Meta guardó del archivo que se usó para APROBAR la
    // plantilla (example.header_handle).
    //
    // No está documentado que sirva para enviar — ese handle es de la subida
    // de revisión, no un media id — pero el intento cuesta una llamada
    // fallida y evita tener que ir a buscar el archivo. Si Meta lo rechaza, lo
    // dice y pedimos la URL, que es donde estábamos igual.
    let mediaFinal = media;
    let deEjemplo = false;
    if (["VIDEO", "IMAGE", "DOCUMENT"].includes(formato) && !mediaFinal) {
      const ej = (header as { example?: { header_handle?: string[] } } | undefined)?.example;
      const handle = ej?.header_handle?.[0];
      if (handle) {
        mediaFinal = handle;
        deEjemplo = true;
        console.log(`📣 Sin URL propia: pruebo con el archivo del ejemplo aprobado (handle de ${formato}).`);
      } else {
        console.error(
          `📣 NO la mando: el encabezado es de ${formato}, Meta exige la media al enviar y la ` +
            "plantilla tampoco trae un ejemplo reutilizable. Agregá la URL pública al final de PLANTILLA_ENVIO.",
        );
        return;
      }
    }

    const components: unknown[] = [];
    if (["VIDEO", "IMAGE", "DOCUMENT"].includes(formato)) {
      const tipo = formato.toLowerCase();
      // Una URL va como `link`; un identificador guardado por Meta, como `id`.
      // Mandar un handle en `link` da un error de descarga que no se entiende.
      const ref = deEjemplo ? { id: mediaFinal } : { link: mediaFinal };
      components.push({ type: "header", parameters: [{ type: tipo, [tipo]: ref }] });
    }

    // Botones de URL DINÁMICA: la plantilla define la base y cada envío tiene
    // que mandar la parte variable. Sin eso Meta rechaza con
    // "(#131008) Button at index N of type Url requires a parameter".
    //
    // El valor sale del ejemplo que Gladymar aprobó con la plantilla. No se
    // inventa ninguno: mandar a un cliente a una dirección que nadie eligió es
    // peor que no mandarle el mensaje.
    const botonesPl = (pl.components?.find((c) => c.type === "BUTTONS") as
      | { buttons?: { type?: string; text?: string; url?: string; example?: string[] }[] }
      | undefined)?.buttons;
    let faltaEjemplo = false;
    botonesPl?.forEach((b, i) => {
      if (String(b.type).toUpperCase() !== "URL") return;
      if (!String(b.url || "").includes("{{")) return; // URL fija: no lleva parámetro
      // Meta quiere SOLO la parte variable, no la URL completa.
      const base = String(b.url).split("{{")[0];
      const parteVariable = (valor: string) =>
        (valor.startsWith(base) ? valor.slice(base.length) : valor).trim();

      // Primero el ejemplo aprobado. El 20/10 "dexco_gladymarbolivia" llegó
      // con el ejemplo vacío (o igual a la base), y mandar el parámetro en
      // blanco lo rechaza Meta con "(#100) Parameter 'text' ... cannot be
      // empty". En ese caso se usa el enlace de campaña que ya está cargado
      // en CATALOGO_CAMPANA_URL, que apunta a la misma base: es una dirección
      // que eligió Gladymar, no una inventada acá.
      let sufijo = parteVariable(b.example?.[0] || "");
      // Kevin, 20/10: "no sé, cualquiera, solo envíalo ahora". PLANTILLA_BOTON_URL_VALOR
      // es ese valor elegido a mano cuando la plantilla no trae ejemplo.
      if (!sufijo && config.botonUrlValor) {
        sufijo = parteVariable(config.botonUrlValor);
        if (sufijo) {
          console.log(`📣 El botón ${i} ("${b.text}") usa el valor de PLANTILLA_BOTON_URL_VALOR.`);
        }
      }
      if (!sufijo && config.catalogoCampana.startsWith(base)) {
        sufijo = parteVariable(config.catalogoCampana);
        if (sufijo) {
          console.log(
            `📣 El botón ${i} ("${b.text}") no trae ejemplo en la plantilla; uso el final de CATALOGO_CAMPANA_URL.`,
          );
        }
      }
      if (!sufijo) {
        console.error(
          `📣 El botón ${i} ("${b.text}") es de URL dinámica y no hay de dónde sacar su valor: ` +
            `la plantilla no trae ejemplo, PLANTILLA_BOTON_URL_VALOR está vacía y ` +
            `CATALOGO_CAMPANA_URL no empieza con "${base}". ` +
            "No invento una dirección: cargale un ejemplo al botón en Meta.",
        );
        faltaEjemplo = true;
        return;
      }
      components.push({
        type: "button",
        sub_type: "url",
        index: String(i),
        parameters: [{ type: "text", text: sufijo }],
      });
    });
    if (faltaEjemplo) return;

    // Huella de ESTA versión de la plantilla. Si Gladymar la edita en Meta
    // (el 21/10 cambiaron el texto y el botón), el contenido es otro y el
    // mensaje vuelve a salir. Sin esto, una plantilla ya mandada quedaba
    // congelada: se editaba y el candado seguía bloqueando la versión nueva.
    const huella = Array.from(
      JSON.stringify(pl.components ?? []) + (pl.language || ""),
    ).reduce((h, c) => ((h * 31 + c.charCodeAt(0)) | 0), 7).toString(36);

    // Esto dejó de ser "mandarle a un par de números": el 22/10 la campaña de
    // arquitectos son 243. De a dos daba igual; de a cientos hay que ir
    // parejo, parar cuando Meta dice basta, y dejar un resumen contable.
    let mandados = 0;
    let fallados = 0;
    let repetidos = 0;
    for (const [i, destino] of destinos.entries()) {
      // El candado es POR DESTINATARIO e incluye CON QUÉ se manda y QUÉ dice:
      // reintentar la misma plantilla al mismo número con otra media, o con
      // el texto editado, es otro envío y no una repetición. Y que uno ya
      // esté mandado no puede frenar a los demás de la lista.
      const candado = `plantilla:${nombre}:${destino}:${mediaFinal || "sin-media"}:${huella}`;
      if (!(await primeraVez(candado))) {
        repetidos++;
        console.log(`📣 La plantilla "${nombre}" (versión ${huella}) ya se le mandó a ${destino}; no se repite.`);
        continue;
      }
      const envio = await sendTemplateCrudo(destino, nombre, pl.language || "es", components);
      if (envio.ok) {
        mandados++;
        console.log(
          `📣 [${i + 1}/${destinos.length}] Plantilla "${nombre}" ENVIADA a ${destino} (id=${envio.wamid ?? "sin id"}).`,
        );
      } else {
        // La API contestó con un error explícito: no se entregó nada, así que
        // se suelta el candado para que el reintento pueda salir. Un timeout o
        // un corte de red NO llegan acá: en esos casos no se sabe si llegó y el
        // candado se queda puesto a propósito.
        await borrarMarca(candado);
        fallados++;
        const detalle = JSON.stringify(envio.error);
        console.error(`📣 [${i + 1}/${destinos.length}] Falló el envío de "${nombre}" a ${destino}: ${detalle}`);
        // Si se agotó el cupo diario de Meta, el resto va a fallar igual:
        // seguir solo quema intentos y ensucia el log. Los que quedaron sin
        // mandar no tienen candado, así que salen en el próximo arranque.
        if (/\b(131056|130429|80007)\b/.test(detalle) || /limit/i.test(detalle)) {
          console.error(
            `📣 Meta cortó por límite de mensajes. Freno con ${destinos.length - i - 1} sin mandar; ` +
              "salen en el próximo arranque, cuando se renueve el cupo.",
          );
          break;
        }
      }
      // Ritmo parejo: cuida la calificación del número y evita el 131056.
      if (i < destinos.length - 1) await sleep(1200);
    }
    if (destinos.length > 1) {
      console.log(
        `📣 Resumen de "${nombre}": ${mandados} enviados, ${fallados} fallados, ` +
          `${repetidos} ya estaban, de ${destinos.length}.`,
      );
    }
  })();
}

if (sondeoHabilitado()) {
  // La primera corrida solo MARCA lo que ya existe: sin esto, al encender el
  // sondeo el bot le escribiría de golpe a todo el que tenga una conversación
  // abierta, incluidas las de hace meses.
  void (async () => {
    for (const canal of ["instagram", "messenger"] as const) {
      if (!metaHabilitado(canal)) continue;
      try {
        const n = await marcarTodoComoVisto(canal);
        console.log(`💬 Sondeo de ${nombreCanal(canal)} activo (cada ${config.meta.sondeoSegundos}s). ${n} conversación(es) quedaron marcadas como ya vistas.`);
      } catch (err) {
        console.error(`No se pudo iniciar el sondeo de ${nombreCanal(canal)}:`, err);
      }
    }
    const t = setInterval(() => void sondearDirectos(), config.meta.sondeoSegundos * 1000);
    if (typeof t.unref === "function") t.unref();
  })();
}

const usoTimer = setInterval(() => void loguearUso(), 60 * 60 * 1000);
if (typeof usoTimer.unref === "function") usoTimer.unref();
void loguearUso();

// Plantilla de avisos al equipo: se verifica/crea al arrancar. Best-effort — si
// Meta falla, el bot arranca igual y los avisos siguen saliendo como texto
// libre (que es lo que ya hacía).
void asegurarPlantillaAvisos();
void asegurarPlantillaSeguimiento();

// ── Cola de avisos del CRM de Prime ─────────────────────────────────────────
// El CRM encola los avisos de estado de pedido; acá se reclaman y se mandan.
// Convive con el chequeo de la hoja: la hoja se apaga recién cuando el módulo
// logístico del CRM esté cargando pedidos de verdad.
if (config.colaAvisos.token) {
  const colaTimer = setInterval(
    () => void procesarColaAvisos(),
    config.colaAvisos.chequeoMinutos * 60 * 1000,
  );
  if (typeof colaTimer.unref === "function") colaTimer.unref();
  void procesarColaAvisos();
  console.log(`📨 Cola de avisos activa (cada ${config.colaAvisos.chequeoMinutos} min, lote ${config.colaAvisos.lote}).`);
}

// Red de seguridad global: un error no capturado en cualquier punto (ej. una
// promesa "en segundo plano" que nadie esperó) NUNCA debe tumbar el proceso
// completo y afectar a TODOS los clientes. Solo se loguea.
process.on("unhandledRejection", (reason) => {
  console.error("⚠️  Promesa rechazada sin capturar (unhandledRejection):", reason);
});
process.on("uncaughtException", (err) => {
  console.error("⚠️  Excepción no capturada (uncaughtException):", err);
});

app.listen(config.port, () => {
  console.log(`✅ Agente de Gladymar escuchando en el puerto ${config.port}`);
  console.log(`   Modelo: ${config.anthropic.model}`);
  console.log(`   Demo web: http://localhost:${config.port}/`);
  console.log(`   Webhook: GET/POST /webhook`);
  if (!isWhatsAppConfigured()) {
    console.log("   ⚠️  WhatsApp no configurado: el demo web funciona; el webhook real requiere credenciales.");
  }
});
