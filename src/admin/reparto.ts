/**
 * A qué asesor le toca cada cliente.
 *
 * Regla definida por Gladymar el 12/10/2026, en tres pasos:
 *
 *   1. El cliente va a la sucursal MÁS CERCANA. Si su ciudad tiene una sola,
 *      esa; si tiene varias (Santa Cruz, La Paz, Cochabamba), la de su zona.
 *      Beni y Pando los atiende Santa Cruz (Gladymar Plus).
 *   2. Dentro de la sucursal, POR TURNOS entre sus asesores.
 *   3. Si no se sabe la zona y la ciudad tiene varias sucursales, va al
 *      supervisor, como venía pasando.
 *
 * Lo que esto cambia: hasta hoy TODO un departamento caía en una sola persona
 * —todo Santa Cruz en la supervisora de Plus— y los 25 asesores del padrón no
 * recibían un lead a su nombre. No era que el bot no asignara: asignaba
 * siempre al mismo.
 *
 * La asignación se PEGA al cliente (ver db/asignacion_asesor). Un cliente que
 * escribe tres veces tiene que caer siempre en el mismo asesor: si no, lo
 * atienden tres personas que no saben lo que dijo antes.
 */
import { asignacionDe, guardarAsignacion, siguienteTurno } from "../db/index.js";
import { asesorParaLugar, asesoresDeSucursal, sucursalParaLugar, type Asesor } from "./asesores.js";
import { toIntlBolivia } from "./roles.js";

export interface Asignado {
  /** Nombre EXACTO del padrón: el CRM lo cruza literal para dar la cartera. */
  nombre: string;
  telefono: string;
  sucursal: string;
  /** Cómo se resolvió, para el log. */
  via: "pegada" | "turno" | "supervisor";
}

function deAsesor(a: Asesor, via: Asignado["via"]): Asignado {
  // El padrón trae el número local ("67703821") y para mandarle un WhatsApp
  // hace falta el internacional. Se normaliza acá, una vez, y no en cada
  // caller: un número a medio normalizar es un aviso que no llega.
  return { nombre: a.nombre, telefono: toIntlBolivia(a.telefono), sucursal: a.sucursal, via };
}

/**
 * El asesor que atiende a este cliente.
 *
 * `cliente` es el identificador del CRM (con prefijo de canal si no es
 * WhatsApp), para que un PSID y un teléfono con los mismos dígitos no compartan
 * asignación.
 */
export async function asesorDeCliente(cliente: string, ciudad?: string): Promise<Asignado | undefined> {
  const pegada = await asignacionDe(cliente);
  if (pegada) {
    return {
      nombre: pegada.asesorNombre,
      telefono: pegada.asesorTelefono,
      sucursal: pegada.sucursal,
      via: "pegada",
    };
  }

  const sucursal = sucursalParaLugar(ciudad);
  const equipo = sucursal ? asesoresDeSucursal(sucursal) : [];
  if (!sucursal || equipo.length === 0) {
    // Sin sucursal resoluble (no dijo la zona, o es una ciudad sin showroom):
    // al supervisor, como venía siendo. NO se guarda: si en el próximo mensaje
    // el cliente dice su zona, todavía se puede asignar bien.
    const sup = asesorParaLugar(ciudad);
    return sup ? deAsesor(sup, "supervisor") : undefined;
  }

  const turno = await siguienteTurno(sucursal);
  if (turno === null) {
    // Sin base no hay turnos; mejor el supervisor que nadie. Tampoco se guarda.
    const sup = asesorParaLugar(ciudad);
    return sup ? deAsesor(sup, "supervisor") : undefined;
  }

  const elegido = equipo[turno % equipo.length];
  const asignado = deAsesor(elegido, "turno");
  await guardarAsignacion(cliente, {
    asesorNombre: asignado.nombre,
    asesorTelefono: asignado.telefono,
    sucursal: asignado.sucursal,
  });
  return asignado;
}
