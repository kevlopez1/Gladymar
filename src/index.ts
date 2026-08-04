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
import { InMemorySessionStore } from "./session/store.js";
import { sendText, sendDocument, sendInteractiveList, sendTemplate, markAsRead, markReadAndTyping } from "./whatsapp/client.js";
import { verifyWebhook, parseIncomingMessages } from "./whatsapp/webhook.js";
import { SurveyScheduler, buildSurveyMessage } from "./session/survey.js";
import { SheetsLogger, nowBolivia } from "./integrations/sheets.js";
import { CrmIngest, stageDeTipo } from "./integrations/crm.js";
import { getAdminByPhone, adminFromRole, adminTelefonoPorCiudad, ADMIN_TELEFONO, adminRoster } from "./admin/roles.js";
import { handleAdminCommand, reportes } from "./admin/commands.js";
import { bumpConversacion } from "./admin/data.js";
import { ciudadesConSucursal } from "./knowledge/sucursales.js";
import { chequearNotificacionesPedidos } from "./integrations/pedidoEstados.js";
import { parseCSV } from "./util/csv.js";
import { insertarConversacion, obtenerConversaciones } from "./db/index.js";
import { pideDimensionViva } from "./knowledge/dimensionViva.js";

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
async function notificarAsesor(
  from: string,
  name: string | undefined,
  sol: NonNullable<AgentReply["solicitud"]>,
): Promise<void> {
  const ciudad = sol.ciudad || "";
  const destino = adminTelefonoPorCiudad(ciudad) || ADMIN_TELEFONO;
  const prio = sol.prioridad === "critica" ? "  🔴 CRÍTICA" : sol.prioridad === "alta" ? "  🟠 ALTA" : "";
  const nombre = sol.nombre || name || "Cliente";
  const lineas = [
    `🔔 *Nuevo cliente${ciudad ? " · " + ciudad : ""}*${prio}`,
    `👤 ${nombre}`,
    `📱 ${from}  (wa.me/${from})`,
    `🗂️ ${sol.tipo}`,
    sol.detalle ? `🗒️ ${sol.detalle}` : "",
    "",
    "Escribile para continuar la atención. 💬",
  ].filter(Boolean);
  try {
    await sendText(destino, lineas.join("\n"));
    console.log(`📤 Handoff -> asesor ${destino} (cliente ${from}, ${ciudad || "sin ciudad"})`);
  } catch (err) {
    console.error(`No se pudo avisar al asesor ${destino}:`, err);
  }
}

// ── Agrupado de mensajes (anti-spam) ────────────────────────────────────────
// Si un cliente manda varios mensajes seguidos, los juntamos y respondemos UNA
// sola vez (evita respuestas repetidas). Si llega un mensaje mientras estamos
// respondiendo, queda en cola y se procesa después.
// Ventana de espera para agrupar: damos tiempo a que el cliente termine de
// escribir varios mensajes seguidos antes de responder (evita "bombardear").
const DEBOUNCE_MS = 5000;
interface BufferCliente { textos: string[]; timer: NodeJS.Timeout | null; messageId: string; name?: string; prueba?: boolean }
const buffers = new Map<string, BufferCliente>();
const enCurso = new Set<string>();
// Admins que están "probando como cliente" (modo demo): sus mensajes van al agente.
const testCliente = new Set<string>();

/** Envía una respuesta del panel admin (menú corto como lista tappable; listas largas partidas). */
async function enviarPanel(
  to: string,
  r: { text: string; options?: string[]; optionsButton?: string; optionsTitle?: string },
): Promise<void> {
  const corto = r.text.length < 900;
  if (r.options?.length && corto) {
    try {
      await sendInteractiveList(to, r.text, r.optionsButton || "Ver comandos", r.optionsTitle || "Panel", r.options);
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

function programarCliente(msg: { from: string; text: string; messageId: string; name?: string }, prueba = false): void {
  let buf = buffers.get(msg.from);
  if (!buf) {
    buf = { textos: [], timer: null, messageId: msg.messageId, name: msg.name, prueba };
    buffers.set(msg.from, buf);
  }
  // Marca leído + mantiene "escribiendo…" vivo con CADA mensaje (mientras el
  // cliente sigue tecleando), no solo con el primero.
  void markReadAndTyping(msg.messageId);
  buf.textos.push(msg.text);
  buf.messageId = msg.messageId;
  buf.prueba = prueba;
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
  if (!text) return;
  enCurso.add(from);
  try {
    await procesarTurnoCliente(from, text, buf.messageId, buf.name, { prueba: buf.prueba });
  } finally {
    enCurso.delete(from);
  }
}

async function handleIncoming(msg: {
  from: string;
  text: string;
  messageId: string;
  name?: string;
}): Promise<void> {
  console.log(`📩 ${msg.from}${msg.name ? ` (${msg.name})` : ""}: ${msg.text}`);

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

    // Entrar al modo "probar como cliente" (demo).
    if (!testCliente.has(msg.from) && /probar/.test(t) && /(cliente|crm|agente|sistema|demo)/.test(t)) {
      testCliente.add(msg.from);
      agent.reset(`test:${msg.from}`);
      void markAsRead(msg.messageId);
      try {
        await sendText(
          msg.from,
          "🧪 *Modo prueba activado.*\n\nAhora te atiendo como si fueras un *cliente*. Escribí como uno más: por ejemplo *\"Hola\"*, pedí el catálogo, pedí una cotización, consultá sucursales...\n\nEsto es solo una demostración: *no* cuenta como lead ni avisa a ningún asesor.\n\nCuando quieras volver al panel, escribí *salir*.",
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
      await enviarPanel(msg.from, await handleAdminCommand(`wa:${msg.from}`, admin, msg.text));
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

async function procesarTurnoCliente(
  from: string,
  text: string,
  messageId: string,
  name?: string,
  opts?: { prueba?: boolean },
): Promise<void> {
  // En modo prueba (un admin probando como cliente) usamos una sesión aparte
  // y NO registramos nada real (ni KPIs, ni lead, ni CRM/Sheets).
  const prueba = opts?.prueba === true;
  // El QR del catálogo físico manda un texto fijo; se detecta acá para que el
  // PDF salga siempre, sin depender de cómo lo interprete el modelo.
  const porQrCatalogo = !prueba && pideDimensionViva(text);
  const sessionId = prueba ? `test:${from}` : from;

  // Marca leído + "escribiendo…" y suma a KPIs.
  void markReadAndTyping(messageId);
  const tEscribiendo = Date.now();
  if (!prueba) bumpConversacion();

  // Recordá la ciudad si el cliente la menciona (para mandarla siempre al CRM).
  if (!prueba) {
    const cd = detectarCiudad(text);
    if (cd) ciudadPorUsuario.set(from, cd);
  }

  try {
    // La cotización en PDF solo está habilitada para admins (modo prueba).
    const reply = await agent.handleMessage(sessionId, text, { cotizacionPDF: prueba, prueba });

    // Respuestas en bloques: muestra "escribiendo…" antes de cada bloque (y un mínimo antes del primero).
    // El último bloque, si hay opciones, se envía como LISTA interactiva (igual que el demo).
    const bloques = splitBlocks(reply.text);
    for (let i = 0; i < bloques.length; i++) {
      const esUltimo = i === bloques.length - 1;

      if (i === 0) {
        const transcurrido = Date.now() - tEscribiendo;
        if (transcurrido < 1200) await sleep(1200 - transcurrido);
      } else {
        void markReadAndTyping(messageId);
        await sleep(typingMs(bloques[i]));
      }

      if (esUltimo && reply.options.length) {
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
          await sendText(
            from,
            `${bloques[i]}\n\n${reply.options.map((o, j) => `*${j + 1}.* ${o}`).join("\n")}`,
          );
        }
      } else {
        await sendText(from, bloques[i]);
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

    // Cotización en PDF: SOLO para admins (modo prueba). Un cliente real nunca
    // recibe el documento (la herramienta ni siquiera está disponible para él).
    if (reply.cotizacion && prueba) {
      try {
        const rel = await generarCotizacionPDF(reply.cotizacion);
        const url = `${config.publicBaseUrl.replace(/\/$/, "")}/${rel}`;
        await sendDocument(from, url, `Cotización ${reply.cotizacion.numero}.pdf`, "Cotización referencial ◆ Gladymar");
      } catch (err) {
        console.error(`No se pudo generar/enviar la cotización a ${from}:`, err);
      }
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
        void notificarAsesor(from, name, reply.solicitud);
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
      void crm.send({
        external_id: from,
        name: adminRemitente?.nombre || reply.solicitud?.nombre || name,
        city: adminRemitente?.region || reply.solicitud?.ciudad || ciudadPorUsuario.get(from),
        segment: adminRemitente ? "Administrador" : undefined,
        stage: adminRemitente ? undefined : stageDeTipo(reply.solicitud?.tipo),
        interest: adminRemitente ? undefined : reply.solicitud?.detalle,
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
const pedidosAutomaticosTimer = setInterval(() => void chequearNotificacionesPedidos(), 15 * 60 * 1000);
if (typeof pedidosAutomaticosTimer.unref === "function") pedidosAutomaticosTimer.unref();
void chequearNotificacionesPedidos();

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
