/**
 * Envío best-effort de cada interacción al CRM de Prime (ingest en tiempo real).
 *
 * NUNCA bloquea ni rompe el bot: si el CRM falla o está caído, solo se registra
 * en consola y la atención al cliente sigue normal. El token es secreto y se
 * lee de CRM_INGEST_TOKEN (no se hardcodea). Si no hay token, queda desactivado.
 */
export interface CrmPayload {
  /** Teléfono / wa_id del cliente. OBLIGATORIO. */
  external_id: string;
  name?: string;
  city?: string;
  segment?: string;
  stage?: string;
  interest?: string;
  message?: string;
  response?: string;
  /** Marca de administrador (para que el CRM no lo trate como un cliente/lead más). */
  is_admin?: boolean;
  /** Rol del contacto cuando es administrador (ej. "gerente", "regional"). */
  role?: string;
}

export class CrmIngest {
  private readonly url: string;
  private readonly token: string;

  constructor(url: string, token: string) {
    this.url = url;
    this.token = token;
  }

  get enabled(): boolean {
    return this.token.length > 0 && this.url.length > 0;
  }

  /**
   * Envía una interacción al CRM. No lanza errores: un fallo de ingest jamás
   * debe interrumpir la atención al cliente. Devuelve el resultado para poder
   * contar en migraciones (los callers en vivo simplemente lo ignoran con `void`).
   */
  async send(p: CrmPayload): Promise<"ok" | "skip" | "fail"> {
    if (!this.enabled) return "skip";
    // Requisito del CRM: external_id + (message o response). Excepción: un envío
    // que sólo marca el rol de administrador (is_admin) también es válido.
    if (!p.external_id || (!p.message && !p.response && !p.is_admin)) return "skip";

    const body: Record<string, unknown> = { external_id: p.external_id };
    for (const k of ["name", "city", "segment", "stage", "interest", "message", "response", "role"] as const) {
      const v = p[k];
      if (v != null && String(v).trim() !== "") body[k] = v;
    }
    if (p.is_admin) body.is_admin = true;

    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        console.warn(`CRM ingest falló (${res.status}): ${await res.text()}`);
        return "fail";
      }
      return "ok";
    } catch (err) {
      console.warn("CRM ingest error (red):", err);
      return "fail";
    }
  }
}

/** Mapea el tipo de solicitud del agente a una etapa del embudo del CRM. */
export function stageDeTipo(tipo?: string): string | undefined {
  switch (tipo) {
    case "cotizacion":
      return "Cotizado";
    case "contactar_asesor":
      return "Contactado";
    case "seguimiento_pedido":
      return "Seguimiento";
    case "reclamo":
      return "Reclamo";
    case "visita_tecnica":
      return "Visita técnica";
    default:
      return undefined;
  }
}
