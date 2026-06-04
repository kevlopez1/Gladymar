/**
 * Carga y valida la configuración desde variables de entorno.
 */
import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `Falta la variable de entorno obligatoria: ${name}. Revisa tu archivo .env (ver .env.example).`,
    );
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : fallback;
}

export const config = {
  port: Number(optional("PORT", "3000")),

  anthropic: {
    apiKey: required("ANTHROPIC_API_KEY"),
    model: optional("ANTHROPIC_MODEL", "claude-sonnet-4-6"),
  },

  whatsapp: {
    accessToken: required("WHATSAPP_ACCESS_TOKEN"),
    phoneNumberId: required("WHATSAPP_PHONE_NUMBER_ID"),
    apiVersion: optional("WHATSAPP_API_VERSION", "v21.0"),
    verifyToken: required("WHATSAPP_VERIFY_TOKEN"),
  },

  session: {
    ttlMinutes: Number(optional("SESSION_TTL_MINUTES", "120")),
  },

  survey: {
    // Encuesta de satisfacción que se envía tras finalizar la conversación.
    url: optional("SURVEY_URL", "https://gladymar.com.bo/encuesta/"),
    // Minutos de inactividad tras los cuales se considera "terminada" la
    // conversación y se envía la encuesta (0 = desactivar).
    delayMinutes: Number(optional("SURVEY_DELAY_MINUTES", "5")),
  },

  assets: {
    // Enlace PÚBLICO y directo al Manual de Asentamiento (Tríptico de Colocación)
    // en PDF. Si se define, el agente lo adjunta cuando el cliente lo solicita.
    // Vacío => el agente solo lo menciona/ofrece (no adjunta el archivo).
    manualUrl: optional("MANUAL_ASENTAMIENTO_URL", ""),
  },
};

/**
 * Valida que la configuración necesaria para Claude esté presente.
 * Útil para el simulador de consola, que no necesita las credenciales de WhatsApp.
 */
export function validateAnthropicConfig(): void {
  required("ANTHROPIC_API_KEY");
}
