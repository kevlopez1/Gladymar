/**
 * Punto de entrada: servidor HTTP que conecta WhatsApp Cloud API con el agente.
 *
 *   GET  /webhook  -> verificación del webhook con Meta
 *   POST /webhook  -> recepción de mensajes entrantes
 *   GET  /health   -> healthcheck
 */
import express from "express";
import path from "node:path";
import { config, isWhatsAppConfigured } from "./config.js";
import { GladymarAgent } from "./agent/brain.js";
import { InMemorySessionStore } from "./session/store.js";
import { sendText, sendDocument, markAsRead } from "./whatsapp/client.js";
import { verifyWebhook, parseIncomingMessages } from "./whatsapp/webhook.js";
import { SurveyScheduler, buildSurveyMessage } from "./session/survey.js";
import { SheetsLogger, nowBolivia } from "./integrations/sheets.js";

const sheets = new SheetsLogger(config.sheets.webhookUrl);

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

// Endpoint del demo web: chatea con el mismo cerebro del agente (sin WhatsApp).
app.post("/api/chat", async (req, res) => {
  const { sessionId, message } = req.body ?? {};
  if (typeof sessionId !== "string" || typeof message !== "string" || message.trim() === "") {
    res.status(400).json({ error: "Se requieren 'sessionId' y 'message'." });
    return;
  }
  try {
    const reply = await agent.handleMessage(`demo:${sessionId}`, message);
    res.json({ reply: reply.text, options: reply.options, escalated: reply.escalated });
  } catch (err) {
    console.error("Error en /api/chat:", err);
    res.status(500).json({ error: "Error procesando el mensaje." });
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
      void handleIncoming(msg);
    }
  } catch (err) {
    console.error("Error procesando webhook:", err);
  }
});

async function handleIncoming(msg: {
  from: string;
  text: string;
  messageId: string;
  name?: string;
}): Promise<void> {
  console.log(`📩 ${msg.from}${msg.name ? ` (${msg.name})` : ""}: ${msg.text}`);
  void markAsRead(msg.messageId);
  // Cada mensaje reinicia el temporizador de la encuesta (fin de conversación por inactividad).
  survey.onActivity(msg.from);

  try {
    const reply = await agent.handleMessage(msg.from, msg.text);
    // En WhatsApp real, las opciones se anexan como lista de texto (fallback).
    // (Los botones interactivos nativos se pueden implementar más adelante.)
    const outText = reply.options.length
      ? `${reply.text}\n\n${reply.options.map((o, i) => `*${i + 1}.* ${o}`).join("\n")}`
      : reply.text;
    await sendText(msg.from, outText);

    // Adjunta el Manual de Asentamiento (PDF) si el cliente lo pidió y hay enlace configurado.
    if (reply.attachManual && config.assets.manualUrl) {
      try {
        await sendDocument(
          msg.from,
          config.assets.manualUrl,
          "Gladymar - Manual de Asentamiento.pdf",
          "Manual de Asentamiento (Tríptico de Colocación) ◆ Gladymar",
        );
      } catch (err) {
        console.error(`No se pudo adjuntar el manual a ${msg.from}:`, err);
      }
    }

    if (reply.escalated) {
      console.log(`🔔 Derivación a humano para ${msg.from}`);
    }
    console.log(`🤖 -> ${msg.from}: ${reply.text.slice(0, 120)}...`);

    // Registra la interacción en Google Sheets (no bloquea ni interrumpe si falla).
    void sheets.log({
      fecha: nowBolivia(),
      telefono: msg.from,
      nombre: msg.name,
      mensaje: msg.text,
      respuesta: reply.text,
      tipo_solicitud: reply.solicitud?.tipo,
      prioridad: reply.solicitud?.prioridad,
      detalle: reply.solicitud?.detalle,
      escalado: reply.escalated,
    });
  } catch (err) {
    console.error(`Error atendiendo a ${msg.from}:`, err);
    try {
      await sendText(
        msg.from,
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
