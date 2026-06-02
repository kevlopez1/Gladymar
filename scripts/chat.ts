/**
 * Simulador de consola para probar al agente SIN WhatsApp.
 *
 * Uso:
 *   1. Define ANTHROPIC_API_KEY en tu .env
 *   2. npm run chat
 *
 * Escribe mensajes como si fueras un cliente. Comandos: /reset, /salir
 */
import "dotenv/config";
import readline from "node:readline";
import { GladymarAgent } from "../src/agent/brain.js";
import { InMemorySessionStore } from "../src/session/store.js";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("Falta ANTHROPIC_API_KEY en el entorno (.env).");
  process.exit(1);
}

const model = process.env.ANTHROPIC_MODEL?.trim() || "claude-sonnet-4-6";
const store = new InMemorySessionStore();
const agent = new GladymarAgent({ apiKey, model, store });
const USER = "consola-local";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

console.log("💬 Simulador del agente Gladymar (modelo: " + model + ")");
console.log("   Comandos: /reset para reiniciar, /salir para terminar.\n");

function prompt(): void {
  rl.question("Cliente> ", async (input) => {
    const text = input.trim();
    if (text === "/salir") {
      rl.close();
      return;
    }
    if (text === "/reset") {
      agent.reset(USER);
      console.log("(conversación reiniciada)\n");
      return prompt();
    }
    if (text === "") return prompt();

    try {
      const reply = await agent.handleMessage(USER, text);
      console.log(`\nGladymar> ${reply.text}`);
      if (reply.escalated) console.log("  [🔔 se activó derivación a humano]");
      console.log();
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : err);
    }
    prompt();
  });
}

prompt();
