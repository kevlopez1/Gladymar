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
import { InMemorySessionStore } from "./session/store.js";
import { sendText, sendDocument, sendInteractiveList, markAsRead, markReadAndTyping } from "./whatsapp/client.js";
import { verifyWebhook, parseIncomingMessages } from "./whatsapp/webhook.js";
import { SurveyScheduler, buildSurveyMessage } from "./session/survey.js";
import { SheetsLogger, nowBolivia } from "./integrations/sheets.js";
import { CrmIngest, stageDeTipo } from "./integrations/crm.js";
import { getAdminByPhone, adminFromRole, adminTelefonoPorCiudad, ADMIN_TELEFONO } from "./admin/roles.js";
import { handleAdminCommand } from "./admin/commands.js";
import { bumpConversacion } from "./admin/data.js";

const sheets = new SheetsLogger(config.sheets.webhookUrl);
const crm = new CrmIngest(config.crm.ingestUrl, config.crm.ingestToken);

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

// Endpoint del demo web: chatea con el mismo cerebro del agente (sin WhatsApp).
app.post("/api/chat", async (req, res) => {
  const { sessionId, message } = req.body ?? {};
  if (typeof sessionId !== "string" || typeof message !== "string" || message.trim() === "") {
    res.status(400).json({ error: "Se requieren 'sessionId' y 'message'." });
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
app.post("/api/admin", (req, res) => {
  const { sessionId, role, message } = req.body ?? {};
  if (typeof sessionId !== "string" || typeof role !== "string" || typeof message !== "string") {
    res.status(400).json({ error: "Se requieren 'sessionId', 'role' y 'message'." });
    return;
  }
  const admin = adminFromRole(role);
  const reply = handleAdminCommand(`adm:${sessionId}`, admin, message);
  res.json({
    reply: reply.text,
    options: reply.options ?? [],
    optionsButton: reply.optionsButton,
    optionsTitle: reply.optionsTitle,
  });
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
      void handleIncoming(msg);
    }
  } catch (err) {
    console.error("Error procesando webhook:", err);
  }
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Divide la respuesta en 2-3 bloques por párrafos (para enviarlos como mensajes separados). */
function splitBlocks(text: string): string[] {
  const parts = text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  if (parts.length <= 1) return [text.trim()];
  if (parts.length > 4) return [parts[0], parts[1], parts[2], parts.slice(3).join("\n\n")];
  return parts;
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
const DEBOUNCE_MS = 2500;
interface BufferCliente { textos: string[]; timer: NodeJS.Timeout | null; messageId: string; name?: string }
const buffers = new Map<string, BufferCliente>();
const enCurso = new Set<string>();

function programarCliente(msg: { from: string; text: string; messageId: string; name?: string }): void {
  let buf = buffers.get(msg.from);
  if (!buf) {
    buf = { textos: [], timer: null, messageId: msg.messageId, name: msg.name };
    buffers.set(msg.from, buf);
    void markReadAndTyping(msg.messageId); // "escribiendo…" ni bien llega el primero
  }
  buf.textos.push(msg.text);
  buf.messageId = msg.messageId;
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
    await procesarTurnoCliente(from, text, buf.messageId, buf.name);
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
    void markAsRead(msg.messageId);
    try {
      const r = handleAdminCommand(`wa:${msg.from}`, admin, msg.text);
      const corto = r.text.length < 900;
      if (r.options?.length && corto) {
        // Menú corto: lista interactiva tappable.
        try {
          await sendInteractiveList(msg.from, r.text, r.optionsButton || "Ver comandos", r.optionsTitle || "Panel", r.options);
        } catch (err) {
          console.error("Lista admin falló; envío como texto:", err);
          await sendText(msg.from, `${r.text}\n\n${r.options.map((o, i) => `*${i + 1}.* ${o}`).join("\n")}`);
        }
      } else {
        // Texto largo (listas de leads/reclamos): partir en varios mensajes para que NO se corte.
        const partes = splitLong(r.text, 3500);
        for (let i = 0; i < partes.length; i++) {
          await sendText(msg.from, partes[i]);
          if (i < partes.length - 1) await sleep(400);
        }
        // Menú al final para volver.
        if (r.options?.length) {
          try {
            await sendInteractiveList(msg.from, "¿Algo más?", r.optionsButton || "Menú", r.optionsTitle || "Panel", r.options);
          } catch {
            /* si falla la lista, no es crítico */
          }
        }
      }
    } catch (err) {
      console.error(`Error en panel admin para ${msg.from}:`, err);
    }
    return;
  }

  // Cliente: agrupamos los mensajes seguidos para responder una sola vez.
  programarCliente(msg);
}

async function procesarTurnoCliente(from: string, text: string, messageId: string, name?: string): Promise<void> {
  // Marca leído + "escribiendo…" y suma a KPIs.
  void markReadAndTyping(messageId);
  const tEscribiendo = Date.now();
  bumpConversacion();

  try {
    const reply = await agent.handleMessage(from, text);

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
          await sendInteractiveList(
            from,
            bloques[i] || "Selecciona una opción:",
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

    // Handoff: si se registró una solicitud, avisamos al asesor de su ciudad.
    if (reply.solicitud) {
      void notificarAsesor(from, name, reply.solicitud);
    }

    if (reply.escalated) {
      console.log(`🔔 Derivación a humano para ${from}`);
    }
    console.log(`🤖 -> ${from}: ${reply.text.slice(0, 120)}...`);

    // Registra la interacción en Google Sheets (no bloquea ni interrumpe si falla).
    void sheets.log({
      fecha: nowBolivia(),
      telefono: from,
      nombre: name,
      mensaje: text,
      respuesta: reply.text,
      tipo_solicitud: reply.solicitud?.tipo,
      prioridad: reply.solicitud?.prioridad,
      detalle: reply.solicitud?.detalle,
      escalado: reply.escalated,
    });

    // Envía la interacción al CRM de Prime en tiempo real (best-effort, sin bloquear).
    void crm.send({
      external_id: from,
      name: reply.solicitud?.nombre || name,
      city: reply.solicitud?.ciudad,
      stage: stageDeTipo(reply.solicitud?.tipo),
      interest: reply.solicitud?.detalle,
      message: text,
      response: reply.text,
    });
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

app.listen(config.port, () => {
  console.log(`✅ Agente de Gladymar escuchando en el puerto ${config.port}`);
  console.log(`   Modelo: ${config.anthropic.model}`);
  console.log(`   Demo web: http://localhost:${config.port}/`);
  console.log(`   Webhook: GET/POST /webhook`);
  if (!isWhatsAppConfigured()) {
    console.log("   ⚠️  WhatsApp no configurado: el demo web funciona; el webhook real requiere credenciales.");
  }
});
