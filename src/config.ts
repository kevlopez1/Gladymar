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

  reporteDiario: {
    // Horas (0-23, zona Bolivia) a las que se manda el reporte global
    // automático al Gerente General, sin que lo pida. Lista separada por
    // comas, ej. "8,17" = 8am y 5pm.
    horasBolivia: optional("REPORTE_DIARIO_HORAS", "8,17")
      .split(",")
      .map((h) => Number(h.trim()))
      .filter((h) => Number.isInteger(h) && h >= 0 && h <= 23),
  },

  assets: {
    // Enlace PÚBLICO y directo al Manual de Asentamiento (Tríptico de Colocación)
    // en PDF. Si se define, el agente lo adjunta cuando el cliente lo solicita.
    // Vacío => el agente solo lo menciona/ofrece (no adjunta el archivo).
    manualUrl: optional("MANUAL_ASENTAMIENTO_URL", ""),
    // PDF del catálogo "Dimensión Viva" (66 pág.). Se sirve desde /public, así
    // que por defecto sale de nuestro propio dominio; se puede apuntar a otro
    // lado (CDN, sitio de Gladymar) con CATALOGO_URL.
    // Es el que se envía cuando el cliente llega por el QR del catálogo físico.
    catalogoUrl: optional("CATALOGO_URL", "/catalogo-dimension-viva.pdf"),
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

  despacho: {
    // Hoja de control de despacho (NO es nuestra: la administra logística de
    // Gladymar). Se lee en tiempo real para responder "¿cómo va mi pedido?"
    // por número de factura. Vacío => la consulta queda desactivada.
    sheetId: optional("DESPACHO_SHEET_ID", "1HOSOrfxrVZv0hAZFAZhjj58MwboBWXbg1pd7_31KqrA"),
    // Plantillas de WhatsApp (aprobadas en Meta) para avisar al cliente sin que
    // pregunte, cuando su factura pasa a "Preparado" o "Despachado".
    templatePreparado: optional("WHATSAPP_TEMPLATE_PEDIDO_PREPARADO", "gladymar_pedido_preparado"),
    templateDespachado: optional("WHATSAPP_TEMPLATE_PEDIDO_DESPACHADO", "gladymar_pedido_despachado"),
    // Idioma con el que la plantilla quedó registrada en Meta. OJO: el idioma
    // es parte de la identidad de la plantilla, no del texto: si en Meta se
    // creó como "English" (aunque el texto esté en español), hay que pedirla
    // como "en" o el envío falla. Por eso se puede fijar una por plantilla.
    templateIdioma: optional("WHATSAPP_TEMPLATE_IDIOMA", "es"),
    templatePreparadoIdioma: optional("WHATSAPP_TEMPLATE_PEDIDO_PREPARADO_IDIOMA", ""),
    templateDespachadoIdioma: optional("WHATSAPP_TEMPLATE_PEDIDO_DESPACHADO_IDIOMA", ""),
    // Números internos de Gladymar cargados en la hoja para hacer pruebas. Se
    // repiten a propósito en varias facturas, así que quedan exentos del
    // bloqueo por "un teléfono con varios clientes" (ese bloqueo existe para
    // no mandarle el pedido de un cliente al WhatsApp de otro cliente real).
    // Lista separada por comas, 8 dígitos, ej. "71091625,72155186".
    telefonosPrueba: optional("DESPACHO_TELEFONOS_PRUEBA", "")
      .split(",")
      .map((t) => t.replace(/\D/g, ""))
      .filter(Boolean),
    // Cada cuántos minutos se revisa la hoja buscando cambios de estado.
    // Mientras logística prueba conviene bajarlo (esperar 15 min por cada
    // prueba es mucho); el costo por chequeo es una descarga de ~3 KB.
    chequeoMinutos: Math.min(60, Math.max(1, Number(optional("PEDIDOS_CHEQUEO_MINUTOS", "15")) || 15)),
  },

  database: {
    // Postgres (Railway). Persiste leads/reclamos/seguimientos entre
    // redeploys. Vacío => se usa el respaldo en memoria (se pierde al
    // reiniciar el proceso).
    url: optional("DATABASE_URL", ""),
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
