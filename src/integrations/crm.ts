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
  /**
   * Nombre del asesor al que se derivó el lead, con tildes y tal cual figura en
   * el padrón (el panel del CRM filtra por comparación literal).
   *
   * OJO: el CRM lo aplica con COALESCE, así que una cadena vacía BORRARÍA la
   * asignación existente. Por eso este campo, como el resto, se omite del body
   * cuando viene vacío en vez de mandarse como "".
   */
  asesor?: string;
  /**
   * Qué vino a hacer el cliente: cotizacion, reclamo, seguimiento_pedido,
   * visita_tecnica, etc.
   *
   * Va SEPARADO de `stage` a pedido de Prime, y con razón: una etapa del embudo
   * contesta qué tan cerca está esta venta de cerrarse, y por eso se puede
   * contar de una a la siguiente. Un reclamo no contesta esa pregunta — no está
   * más cerca de cerrarse que una cotización, es otra cosa que le pasa al mismo
   * cliente. Metido como etapa, un cliente con reclamo desaparecía del embudo
   * aunque su cotización siguiera viva, y la conversión que mira Gerencia
   * quedaba mal sin que se notara.
   */
  tipo_solicitud?: string;
  /**
   * Departamento del lead (los 9 reales de Bolivia, no la clave del padrón).
   *
   * Viaja aunque no haya asesor: un lead de Beni o Pando, o de una región sin
   * asesor asignado, igual queda filtrable por región en el CRM en vez de
   * quedar visible solo para el Gerente General.
   */
  departamento?: string;
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
    for (const k of ["name", "city", "segment", "stage", "tipo_solicitud", "interest", "message", "response", "role", "asesor", "departamento"] as const) {
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
      // Traza de asignación, SOLO para envíos que son un lead (los que llevan
      // stage). Sin esto no hay forma de contestar "¿con qué asesor salió este
      // lead?" sin acceso a la base del CRM: el payload se iba sin dejar rastro.
      // No se loguea el mensaje ni la respuesta (son texto del cliente).
      if (p.stage) {
        console.log(
          `🔗 CRM lead: external_id=${p.external_id} city=${p.city ?? "—"} ` +
            `departamento=${p.departamento ?? "—"} asesor=${p.asesor ?? "—"} stage=${p.stage}`,
        );
      }
      return "ok";
    } catch (err) {
      console.warn("CRM ingest error (red):", err);
      return "fail";
    }
  }
}

/**
 * Mapea el tipo de solicitud del agente a una etapa del embudo del CRM.
 *
 * Los valores son los SLUGS del embudo de Gladymar, no etiquetas para mostrar:
 * el CRM compara la cadena literal. Antes se mandaba "Cotizado" / "Visita
 * técnica" (capitalizados y con tilde) y no coincidían con los slugs, así que
 * la etapa no se aplicaba. No cambiar sin coordinar con el CRM.
 */
/**
 * Etapa del EMBUDO DE VENTA, y solo eso.
 *
 * Las cinco de la propuesta son nuevo → contactado → cotizado → negociacion →
 * ganado / perdido. El bot solo puede deducir dos: que el cliente pidió hablar
 * con un asesor, y que pidió una cotización. Negociación, ganado y perdido las
 * mueve una persona en la plataforma; una conversación de WhatsApp no alcanza
 * para afirmarlas.
 *
 * Todo lo demás (reclamo, seguimiento de pedido, visita técnica) NO es una
 * etapa: va por `tipoSolicitudCrm`. Devolver undefined acá es deliberado — el
 * CRM aplica COALESCE, así que no mandar etapa deja la que el cliente ya tenía
 * en vez de sacarlo del embudo por haber hecho un reclamo.
 */
export function stageDeTipo(tipo?: string): string | undefined {
  switch (tipo) {
    case "cotizacion":
      return "cotizado";
    case "contactar_asesor":
      return "contactado";
    default:
      return undefined;
  }
}

/**
 * Qué vino a hacer el cliente. Viaja aparte de la etapa.
 *
 * Es lo que hace posible "mostrame todos los reclamos abiertos de Santa Cruz",
 * que es una pregunta real, sin romper "cuántos pasaron de cotizado a
 * negociación", que es la que mira Gerencia.
 */
export function tipoSolicitudCrm(tipo?: string): string | undefined {
  const t = (tipo || "").trim();
  return t ? t : undefined;
}
