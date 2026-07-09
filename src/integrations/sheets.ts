/**
 * Registro de interacciones en Google Sheets.
 *
 * Enfoque: el agente hace un POST con los datos a un *Web App de Google Apps
 * Script* ligado a tu hoja de cálculo (ver instrucciones en el README). Así no
 * se necesitan credenciales ni librerías de Google en el servidor.
 *
 * Si `webhookUrl` está vacío, el registro queda desactivado (solo consola).
 */
export interface InteractionLog {
  /** Fecha/hora legible (zona Bolivia). */
  fecha: string;
  /** Número del cliente (WhatsApp). */
  telefono: string;
  /** Nombre de perfil, si está disponible. */
  nombre?: string;
  /** Ciudad del cliente, si se conoce (la misma que recibe el CRM). */
  ciudad?: string;
  /** Mensaje del cliente. */
  mensaje: string;
  /** Respuesta del agente. */
  respuesta: string;
  /** Tipo de solicitud detectada (cotización, reclamo, visita_tecnica, alerta, etc.), si hubo. */
  tipo_solicitud?: string;
  /** Prioridad de la solicitud: normal | alta | critica. */
  prioridad?: string;
  /** Detalle/resumen de la solicitud, si hubo. */
  detalle?: string;
  /** Si la conversación se derivó a un asesor humano. */
  escalado: boolean;
}

export class SheetsLogger {
  private readonly webhookUrl: string;

  constructor(webhookUrl: string) {
    this.webhookUrl = webhookUrl;
  }

  get enabled(): boolean {
    return this.webhookUrl.length > 0;
  }

  /**
   * Registra una interacción. No lanza errores: un fallo de logging nunca debe
   * interrumpir la atención al cliente.
   */
  async log(row: InteractionLog): Promise<void> {
    if (!this.enabled) return;
    try {
      const res = await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(row),
      });
      if (!res.ok) {
        console.error(`Registro en Sheets falló (${res.status}): ${await res.text()}`);
      }
    } catch (err) {
      console.error("Error registrando en Sheets:", err);
    }
  }
}

/** Fecha/hora actual en formato legible de Bolivia (America/La_Paz). */
export function nowBolivia(): string {
  return new Date().toLocaleString("es-BO", { timeZone: "America/La_Paz", hour12: false });
}
