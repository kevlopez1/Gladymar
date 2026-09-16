/**
 * Persistencia de solicitudes (leads/reclamos/seguimientos) en Postgres.
 *
 * Reemplaza el almacén en memoria de admin/data.ts: antes, cada redeploy
 * borraba todo lo acumulado (pasó con un lead real el 9/7/2026). Ahora vive
 * en una base de datos real que sobrevive a los despliegues.
 *
 * Si DATABASE_URL no está configurada o la conexión falla, las funciones
 * devuelven null/no hacen nada, para que el caller use el respaldo en
 * memoria en vez de romper el panel de administradores.
 */
import { Pool } from "pg";
import { config } from "../config.js";

let pool: Pool | null = null;
let initPromise: Promise<void> | null = null;

function getPool(): Pool | null {
  if (!config.database.url) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: config.database.url,
      max: 5,
      // Sin estos topes, una consulta que no responde deja el `await` colgado
      // para siempre y el proceso que la esperaba (ej. el chequeo de avisos de
      // pedido) queda mudo e inerte, sin error ni reintento.
      connectionTimeoutMillis: 10_000,
      statement_timeout: 15_000,
      query_timeout: 15_000,
    });
    pool.on("error", (err) => console.error("Error inesperado en el pool de Postgres:", err));
  }
  return pool;
}

async function crearTabla(): Promise<void> {
  const p = getPool();
  if (!p) return;
  await p.query(`
    CREATE TABLE IF NOT EXISTS solicitudes (
      id SERIAL PRIMARY KEY,
      tipo TEXT NOT NULL,
      prioridad TEXT NOT NULL,
      nombre TEXT,
      ciudad TEXT,
      telefono TEXT,
      detalle TEXT NOT NULL,
      fecha TEXT NOT NULL,
      creado_en BIGINT NOT NULL
    );
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS solicitudes_creado_en_idx ON solicitudes (creado_en DESC);`);
  // Clave compuesta (factura, telefono): una factura puede tener dos números de
  // contacto y a ambos hay que avisarles, sin que el aviso a uno marque como
  // "ya notificado" al otro.
  await p.query(`
    CREATE TABLE IF NOT EXISTS pedido_estados (
      factura TEXT NOT NULL,
      telefono TEXT NOT NULL,
      estado TEXT NOT NULL,
      actualizado_en BIGINT NOT NULL,
      PRIMARY KEY (factura, telefono)
    );
  `);
  // Registro de conversaciones. Existe porque el registro en Google Sheets
  // depende de un Apps Script externo que puede caerse (pasó: 34 fallos 401 en
  // un día, con esas conversaciones perdidas para siempre). Acá no se pierden.
  await p.query(`
    CREATE TABLE IF NOT EXISTS conversaciones (
      id SERIAL PRIMARY KEY,
      fecha TEXT NOT NULL,
      telefono TEXT NOT NULL,
      nombre TEXT,
      ciudad TEXT,
      mensaje TEXT NOT NULL,
      respuesta TEXT NOT NULL,
      tipo_solicitud TEXT,
      prioridad TEXT,
      detalle TEXT,
      escalado BOOLEAN NOT NULL DEFAULT FALSE,
      creado_en BIGINT NOT NULL
    );
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS conversaciones_creado_en_idx ON conversaciones (creado_en DESC);`);
  // Guarda de idempotencia de los avisos al cliente.
  //
  // POR QUÉ NO ALCANZA pedido_estados: esa tabla guarda el ÚLTIMO estado
  // avisado por (factura, telefono). Sirve para el flujo que lee la hoja, pero
  // no para una cola con reintentos: si el bot manda, Meta acepta, y el acuse
  // de vuelta al emisor se pierde por red, la fila vuelve a la cola y se manda
  // otra vez. El cliente recibe dos mensajes y Gladymar los paga dos veces.
  //
  // La clave incluye el ESTADO, no solo factura y teléfono: un pedido que
  // vuelve de "despachado" a "preparado" tiene que poder avisar de nuevo.
  //
  // Se reserva ANTES de llamar a Meta, no después. Reservar después deja la
  // ventana abierta justo donde está la llamada de red.
  await p.query(`
    CREATE TABLE IF NOT EXISTS avisos_enviados (
      clave_idem TEXT PRIMARY KEY,
      wamid TEXT,
      enviado_en BIGINT NOT NULL
    );
  `);
  // cola_id: qué fila de la cola del CRM originó este envío. Sirve para el
  // camino de vuelta: cuando Meta avisa MINUTOS DESPUÉS que el mensaje no se
  // entregó, el acuse solo trae el wamid, y sin esta columna no habría forma de
  // decirle al CRM en qué aviso anotar el motivo. Se agrega aparte porque la
  // tabla ya existe en producción.
  await p.query(`ALTER TABLE avisos_enviados ADD COLUMN IF NOT EXISTS cola_id TEXT;`);
  await p.query(`CREATE INDEX IF NOT EXISTS avisos_enviados_wamid ON avisos_enviados (wamid);`);

  // Consumo de tokens por día (zona Bolivia). Hasta ahora el gasto solo se
  // podía estimar; con esto se mide. Se separa lo escrito en caché de lo leído
  // porque cuestan distinto (leer de caché sale ~10 veces más barato).
  await p.query(`
    CREATE TABLE IF NOT EXISTS uso_tokens (
      fecha TEXT PRIMARY KEY,
      llamadas BIGINT NOT NULL DEFAULT 0,
      entrada BIGINT NOT NULL DEFAULT 0,
      salida BIGINT NOT NULL DEFAULT 0,
      cache_escrito BIGINT NOT NULL DEFAULT 0,
      cache_leido BIGINT NOT NULL DEFAULT 0
    );
  `);
}

/** Asegura que la tabla exista antes de la primera consulta (idempotente, con reintento si falló). */
function tablaLista(): Promise<void> {
  if (!initPromise) {
    initPromise = crearTabla().catch((err) => {
      initPromise = null; // reintentar en la próxima llamada
      throw err;
    });
  }
  return initPromise;
}

export interface SolicitudRow {
  tipo: string;
  prioridad: string;
  nombre?: string;
  ciudad?: string;
  telefono?: string;
  detalle: string;
  fecha: string;
  creadoEn: number;
}

export const dbHabilitada = (): boolean => Boolean(config.database.url);

/**
 * Inserta una solicitud. Nunca lanza: un fallo de persistencia no debe
 * interrumpir la atención al cliente (el registro en memoria sigue andando).
 */
export async function insertarSolicitud(r: SolicitudRow): Promise<void> {
  const p = getPool();
  if (!p) return;
  try {
    await tablaLista();
    await p.query(
      `INSERT INTO solicitudes (tipo, prioridad, nombre, ciudad, telefono, detalle, fecha, creado_en)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [r.tipo, r.prioridad, r.nombre ?? null, r.ciudad ?? null, r.telefono ?? null, r.detalle, r.fecha, r.creadoEn],
    );
  } catch (err) {
    console.error("No se pudo guardar la solicitud en Postgres:", err);
  }
}

/** Devuelve todas las solicitudes guardadas (más recientes primero), o null si la BD no está disponible. */
export async function obtenerSolicitudes(): Promise<SolicitudRow[] | null> {
  const p = getPool();
  if (!p) return null;
  try {
    await tablaLista();
    const res = await p.query<{
      tipo: string;
      prioridad: string;
      nombre: string | null;
      ciudad: string | null;
      telefono: string | null;
      detalle: string;
      fecha: string;
      creado_en: string;
    }>(
      `SELECT tipo, prioridad, nombre, ciudad, telefono, detalle, fecha, creado_en
       FROM solicitudes ORDER BY creado_en DESC LIMIT 2000`,
    );
    return res.rows.map((row) => ({
      tipo: row.tipo,
      prioridad: row.prioridad,
      nombre: row.nombre ?? undefined,
      ciudad: row.ciudad ?? undefined,
      telefono: row.telefono ?? undefined,
      detalle: row.detalle,
      fecha: row.fecha,
      creadoEn: Number(row.creado_en),
    }));
  } catch (err) {
    console.error("No se pudieron leer las solicitudes desde Postgres:", err);
    return null;
  }
}

export interface ConversacionRow {
  fecha: string;
  telefono: string;
  nombre?: string;
  ciudad?: string;
  mensaje: string;
  respuesta: string;
  tipo_solicitud?: string;
  prioridad?: string;
  detalle?: string;
  escalado: boolean;
}

/**
 * Guarda una conversación. Nunca lanza: un fallo de registro no debe
 * interrumpir la atención al cliente.
 */
export async function insertarConversacion(c: ConversacionRow): Promise<void> {
  const p = getPool();
  if (!p) return;
  try {
    await tablaLista();
    await p.query(
      `INSERT INTO conversaciones
         (fecha, telefono, nombre, ciudad, mensaje, respuesta, tipo_solicitud, prioridad, detalle, escalado, creado_en)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        c.fecha,
        c.telefono,
        c.nombre ?? null,
        c.ciudad ?? null,
        c.mensaje,
        c.respuesta,
        c.tipo_solicitud ?? null,
        c.prioridad ?? null,
        c.detalle ?? null,
        c.escalado,
        Date.now(),
      ],
    );
  } catch (err) {
    console.error("No se pudo guardar la conversación en Postgres:", err);
  }
}

/** Conversaciones guardadas, más recientes primero. Null si la BD no responde. */
export async function obtenerConversaciones(limite = 5000): Promise<(ConversacionRow & { creadoEn: number })[] | null> {
  const p = getPool();
  if (!p) return null;
  try {
    await tablaLista();
    const res = await p.query<{
      fecha: string; telefono: string; nombre: string | null; ciudad: string | null;
      mensaje: string; respuesta: string; tipo_solicitud: string | null;
      prioridad: string | null; detalle: string | null; escalado: boolean; creado_en: string;
    }>(
      `SELECT fecha, telefono, nombre, ciudad, mensaje, respuesta, tipo_solicitud, prioridad, detalle, escalado, creado_en
       FROM conversaciones ORDER BY creado_en DESC LIMIT $1`,
      [limite],
    );
    return res.rows.map((r) => ({
      fecha: r.fecha,
      telefono: r.telefono,
      nombre: r.nombre ?? undefined,
      ciudad: r.ciudad ?? undefined,
      mensaje: r.mensaje,
      respuesta: r.respuesta,
      tipo_solicitud: r.tipo_solicitud ?? undefined,
      prioridad: r.prioridad ?? undefined,
      detalle: r.detalle ?? undefined,
      escalado: r.escalado,
      creadoEn: Number(r.creado_en),
    }));
  } catch (err) {
    console.error("No se pudieron leer las conversaciones desde Postgres:", err);
    return null;
  }
}

/**
 * Estados ya notificados, por factura (una sola consulta, no N).
 *
 * IMPORTANTE: devuelve `null` cuando la BD no está disponible, para poder
 * distinguirlo de "no hay ninguno notificado todavía" (Map vacío). Sin esa
 * distinción, una caída de Postgres haría que se reenvíen los avisos a TODOS
 * los clientes en cada chequeo (spam + costo por plantilla de Meta).
 */
export async function obtenerEstadosPedidos(): Promise<Map<string, string> | null> {
  const p = getPool();
  if (!p) return null;
  try {
    await tablaLista();
    const res = await p.query<{ factura: string; telefono: string; estado: string }>(
      `SELECT factura, telefono, estado FROM pedido_estados`,
    );
    return new Map(res.rows.map((r) => [claveEstadoPedido(r.factura, r.telefono), r.estado]));
  } catch (err) {
    console.error("No se pudieron leer los estados de pedidos desde Postgres:", err);
    return null;
  }
}

/** Clave del mapa de estados ya notificados. */
export function claveEstadoPedido(factura: string, telefono: string): string {
  return `${factura}|${telefono}`;
}

/** Guarda el último estado notificado a un teléfono para una factura. Nunca lanza. */
export async function guardarEstadoPedido(factura: string, telefono: string, estado: string): Promise<void> {
  const p = getPool();
  if (!p) return;
  try {
    await tablaLista();
    await p.query(
      `INSERT INTO pedido_estados (factura, telefono, estado, actualizado_en) VALUES ($1, $2, $3, $4)
       ON CONFLICT (factura, telefono) DO UPDATE SET estado = EXCLUDED.estado, actualizado_en = EXCLUDED.actualizado_en`,
      [factura, telefono, estado, Date.now()],
    );
  } catch (err) {
    console.error("No se pudo guardar el estado del pedido en Postgres:", err);
  }
}

export interface UsoDia {
  fecha: string;
  llamadas: number;
  entrada: number;
  salida: number;
  cacheEscrito: number;
  cacheLeido: number;
}

/**
 * Suma el consumo de una llamada al día en curso. Nunca lanza: medir el gasto
 * jamás debe tumbar la atención al cliente.
 */
export async function acumularUso(fecha: string, u: Omit<UsoDia, "fecha" | "llamadas">): Promise<void> {
  const p = getPool();
  if (!p) return;
  try {
    await tablaLista();
    await p.query(
      `INSERT INTO uso_tokens (fecha, llamadas, entrada, salida, cache_escrito, cache_leido)
       VALUES ($1, 1, $2, $3, $4, $5)
       ON CONFLICT (fecha) DO UPDATE SET
         llamadas      = uso_tokens.llamadas + 1,
         entrada       = uso_tokens.entrada + EXCLUDED.entrada,
         salida        = uso_tokens.salida + EXCLUDED.salida,
         cache_escrito = uso_tokens.cache_escrito + EXCLUDED.cache_escrito,
         cache_leido   = uso_tokens.cache_leido + EXCLUDED.cache_leido`,
      [fecha, u.entrada, u.salida, u.cacheEscrito, u.cacheLeido],
    );
  } catch (err) {
    console.error("No se pudo registrar el uso de tokens en Postgres:", err);
  }
}

/** Consumo diario, del más reciente al más viejo. `null` si la BD no responde. */
export async function obtenerUso(dias = 60): Promise<UsoDia[] | null> {
  const p = getPool();
  if (!p) return null;
  try {
    await tablaLista();
    const res = await p.query<{
      fecha: string;
      llamadas: string;
      entrada: string;
      salida: string;
      cache_escrito: string;
      cache_leido: string;
    }>(`SELECT * FROM uso_tokens ORDER BY fecha DESC LIMIT $1`, [dias]);
    return res.rows.map((r) => ({
      fecha: r.fecha,
      llamadas: Number(r.llamadas),
      entrada: Number(r.entrada),
      salida: Number(r.salida),
      cacheEscrito: Number(r.cache_escrito),
      cacheLeido: Number(r.cache_leido),
    }));
  } catch (err) {
    console.error("No se pudo leer el uso de tokens desde Postgres:", err);
    return null;
  }
}


/**
 * Reserva la clave de un aviso ANTES de mandarlo.
 *
 * Devuelve true si la reserva es nuestra (hay que mandar) y false si ya estaba
 * tomada (ya se mandó, no se repite). El INSERT ... ON CONFLICT DO NOTHING es
 * atómico, así que dos procesos que reclamen la misma fila a la vez no pueden
 * mandar los dos.
 *
 * Ante un fallo de base devuelve FALSE, o sea NO manda. Es deliberado: sin
 * poder registrar el envío, mandar es arriesgarse a duplicar, y un aviso que
 * no sale se recupera en el próximo ciclo. Un aviso duplicado no se recupera.
 */
export async function reservarAviso(claveIdem: string): Promise<boolean> {
  const p = getPool();
  if (!p) return false;
  try {
    await tablaLista();
    const res = await p.query(
      `INSERT INTO avisos_enviados (clave_idem, enviado_en) VALUES ($1, $2)
       ON CONFLICT (clave_idem) DO NOTHING`,
      [claveIdem, Date.now()],
    );
    return (res.rowCount ?? 0) > 0;
  } catch (err) {
    console.error("No se pudo reservar el aviso en Postgres:", err);
    return false;
  }
}

/**
 * Guarda el wamid del aviso ya mandado, para poder cruzarlo con el acuse.
 *
 * colaId es opcional y solo lo trae lo que salió por la cola del CRM: es el
 * hilo que permite volver a esa fila cuando el fallo de entrega llega tarde.
 */
export async function confirmarAviso(
  claveIdem: string,
  wamid: string | null,
  colaId?: string,
): Promise<void> {
  const p = getPool();
  if (!p || !wamid) return;
  try {
    await tablaLista();
    await p.query(`UPDATE avisos_enviados SET wamid = $2, cola_id = COALESCE($3, cola_id) WHERE clave_idem = $1`, [
      claveIdem,
      wamid,
      colaId ?? null,
    ]);
  } catch (err) {
    console.error("No se pudo guardar el wamid del aviso:", err);
  }
}

/**
 * Busca de qué fila de la cola salió el mensaje con este wamid.
 *
 * Devuelve null si el mensaje no salió por la cola (ej. los avisos que el bot
 * manda leyendo la hoja de despacho): esos no tienen fila que anotar.
 */
export async function colaIdPorWamid(wamid: string): Promise<string | null> {
  const p = getPool();
  if (!p || !wamid) return null;
  try {
    await tablaLista();
    const res = await p.query<{ cola_id: string | null }>(
      `SELECT cola_id FROM avisos_enviados WHERE wamid = $1 LIMIT 1`,
      [wamid],
    );
    return res.rows[0]?.cola_id ?? null;
  } catch (err) {
    console.error("No se pudo buscar el aviso por wamid:", err);
    return null;
  }
}

/**
 * ¿La clave de este aviso ya está reservada, o sea el aviso ya salió?
 *
 * Lo usa el vigilante de la cola: si encolamos un aviso hace rato y su clave
 * sigue libre, nadie lo mandó. Ante un fallo de base devuelve TRUE (="ya
 * salió"), que es el lado prudente: el vigilante se calla en vez de mandar un
 * aviso que quizá ya se mandó.
 */
export async function avisoYaTomado(claveIdem: string): Promise<boolean> {
  const p = getPool();
  if (!p) return true;
  try {
    await tablaLista();
    const res = await p.query(`SELECT 1 FROM avisos_enviados WHERE clave_idem = $1`, [claveIdem]);
    return (res.rowCount ?? 0) > 0;
  } catch (err) {
    console.error("No se pudo verificar si el aviso ya estaba tomado:", err);
    return true;
  }
}

/**
 * Libera la reserva cuando el envío falló de verdad (Meta lo rechazó).
 *
 * Solo para fallos del ENVÍO. Si Meta aceptó y después no se entregó, la
 * reserva se mantiene: el mensaje salió y volver a mandarlo se cobra igual.
 */
export async function liberarAviso(claveIdem: string): Promise<void> {
  const p = getPool();
  if (!p) return;
  try {
    await tablaLista();
    await p.query(`DELETE FROM avisos_enviados WHERE clave_idem = $1`, [claveIdem]);
  } catch (err) {
    console.error("No se pudo liberar la reserva del aviso:", err);
  }
}
