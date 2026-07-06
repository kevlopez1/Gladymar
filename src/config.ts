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

  // URL pública del servicio (para armar enlaces a documentos que enviamos por WhatsApp,
  // ej. cotizaciones PDF). Debe ser HTTPS y accesible por Meta.
  publicBaseUrl: optional("PUBLIC_BASE_URL", "https://gladymar-production.up.railway.app"),

  anthropic: {
    apiKey: required("ANTHROPIC_API_KEY"),
    model: optional("ANTHROPIC_MODEL", "claude-sonnet-4-6"),
  },

  whatsapp: {
    // Opcionales: el demo web funciona sin estas credenciales (solo necesita
    // ANTHROPIC_API_KEY). Se requieren únicamente para operar en WhatsApp real.
    accessToken: optional("WHATSAPP_ACCESS_TOKEN", ""),
    phoneNumberId: optional("WHATSAPP_PHONE_NUMBER_ID", ""),
    apiVersion: optional("WHATSAPP_API_VERSION", "v21.0"),
    verifyToken: optional("WHATSAPP_VERIFY_TOKEN", ""),
  },

  session: {
    ttlMinutes: Number(optional("SESSION_TTL_MINUTES", "120")),
  },

  survey: {
    // Encuesta de satisfacción que se envía tras finalizar la conversación.
    url: optional("SURVEY_URL", "https://gladymar.com.bo/encuesta/"),
    // Minutos de inactividad tras los cuales se considera "terminada" la
    // conversación y se envía la encuesta (0 = desactivar).
    delayMinutes: Number(optional("SURVEY_DELAY_MINUTES", "30")),
  },

  assets: {
    // Enlace PÚBLICO y directo al Manual de Asentamiento (Tríptico de Colocación)
    // en PDF. Si se define, el agente lo adjunta cuando el cliente lo solicita.
    // Vacío => el agente solo lo menciona/ofrece (no adjunta el archivo).
    manualUrl: optional("MANUAL_ASENTAMIENTO_URL", ""),
  },

  sheets: {
    // URL del Web App de Google Apps Script para registrar cada interacción.
    // Vacío => registro desactivado (solo consola). Ver README.
    webhookUrl: optional("SHEETS_WEBHOOK_URL", ""),
  },

  crm: {
    // CRM de Prime: cada interacción se envía en tiempo real (best-effort).
    // El token es secreto: va en CRM_INGEST_TOKEN (no se hardcodea). Vacío => desactivado.
    ingestUrl: optional("CRM_INGEST_URL", "https://www.primebusiness.live/api/crm/ingest"),
    ingestToken: optional("CRM_INGEST_TOKEN", ""),
    // Migración única del histórico (endpoint /admin/backfill-crm?key=...).
    // Clave secreta para protegerlo; vacío => endpoint desactivado.
    backfillKey: optional("BACKFILL_KEY", ""),
    // ID del Google Sheet con el historial (para leerlo por CSV export).
    backfillSheetId: optional("BACKFILL_SHEET_ID", "11UafcrSOl7YZ7G3cYfrrUvKBzM_irS7RXsq-Avdw8eE"),
  },
};

/**
 * Valida que la configuración necesaria para Claude esté presente.
 * Útil para el simulador de consola, que no necesita las credenciales de WhatsApp.
 */
export function validateAnthropicConfig(): void {
  required("ANTHROPIC_API_KEY");
}

/** Indica si las credenciales de WhatsApp están completas (modo producción). */
export function isWhatsAppConfigured(): boolean {
  return Boolean(
    config.whatsapp.accessToken && config.whatsapp.phoneNumberId && config.whatsapp.verifyToken,
  );
}
