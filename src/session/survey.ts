/**
 * Programador de la encuesta de satisfacción.
 *
 * Regla de negocio: tras finalizar la conversación, enviar el enlace de la
 * encuesta. Como en un chat no hay un "fin" explícito, lo detectamos por
 * INACTIVIDAD: si el cliente no escribe durante `delayMs`, consideramos
 * terminada la conversación y enviamos la encuesta una sola vez.
 *
 * Implementación en memoria con setTimeout (suficiente para un solo proceso).
 * Para producción multi-instancia, usar una cola de trabajos con persistencia.
 */
export interface SurveySchedulerOptions {
  /** Retraso de inactividad antes de enviar la encuesta (ms). 0 = desactivado. */
  delayMs: number;
  /** Acción que envía la encuesta a un usuario. */
  onFire: (userId: string) => Promise<void> | void;
}

export class SurveyScheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly sent = new Set<string>();
  private readonly delayMs: number;
  private readonly onFire: (userId: string) => Promise<void> | void;

  constructor(opts: SurveySchedulerOptions) {
    this.delayMs = opts.delayMs;
    this.onFire = opts.onFire;
  }

  /**
   * Registra actividad del usuario. Reinicia el temporizador de la encuesta.
   * Si el cliente vuelve a escribir tras recibir la encuesta, se considera una
   * conversación nueva (podrá recibir otra encuesta al finalizar).
   */
  onActivity(userId: string): void {
    if (this.delayMs <= 0) return; // encuesta desactivada

    // La encuesta se envía UNA sola vez por cliente: si ya se envió, no re-armar
    // (evita el spam de encuestas durante una conversación con pausas).
    if (this.sent.has(userId)) return;

    const existing = this.timers.get(userId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.timers.delete(userId);
      if (this.sent.has(userId)) return;
      this.sent.add(userId);
      void this.onFire(userId);
    }, this.delayMs);

    // No mantener vivo el proceso solo por este temporizador.
    if (typeof timer.unref === "function") timer.unref();

    this.timers.set(userId, timer);
  }

  /** Cancela una encuesta pendiente (p. ej. si la conversación fue derivada a humano). */
  cancel(userId: string): void {
    const existing = this.timers.get(userId);
    if (existing) {
      clearTimeout(existing);
      this.timers.delete(userId);
    }
  }
}

/** Mensaje de la encuesta, en tono neutro y premium de Gladymar. */
export function buildSurveyMessage(url: string): string {
  return [
    "*Gladymar* ✨",
    "",
    "¡Gracias por escribirnos! Nos encantaría saber cómo te fue.",
    "",
    "Contanos en esta encuesta cortita:",
    url,
    "",
    "_Tu opinión nos ayuda a mejorar. Más que cerámicas, fabricamos emociones._",
  ].join("\n");
}
