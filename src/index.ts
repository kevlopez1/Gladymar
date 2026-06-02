/**
 * Punto de entrada: servidor HTTP que conecta WhatsApp Cloud API con el agente.
 *
 *   GET  /webhook  -> verificación del webhook con Meta
 *   POST /webhook  -> recepción de mensajes entrantes
 *   GET  /health   -> healthcheck
 */
import express from "express";
import { config } from "./config.js";
import { GladymarAgent } from "./agent/brain.js";
import { InMemorySessionStore } from "./session/store.js";
import { sendText, markAsRead } from "./whatsapp/client.js";
import { verifyWebhook, parseIncomingMessages } from "./whatsapp/webhook.js";

const store = new InMemorySessionStore(config.session.ttlMinutes);
const agent = new GladymarAgent({
  apiKey: config.anthropic.apiKey,
  model: config.anthropic.model,
  store,
});

const app = express();
app.use(express.json());

// Healthcheck
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "gladymar-whatsapp-agent" });
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

  try {
    const reply = await agent.handleMessage(msg.from, msg.text);
    await sendText(msg.from, reply.text);
    if (reply.escalated) {
      console.log(`🔔 Derivación a humano para ${msg.from}`);
    }
    console.log(`🤖 -> ${msg.from}: ${reply.text.slice(0, 120)}...`);
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
  console.log(`   Webhook: GET/POST /webhook`);
});
