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
    pool = new Pool({ connectionString: config.database.url, max: 5 });
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
  await p.query(`
    CREATE TABLE IF NOT EXISTS pedido_estados (
      factura TEXT PRIMARY KEY,
      estado TEXT NOT NULL,
      actualizado_en BIGINT NOT NULL
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

/**
 * Último estado notificado de una factura (para no repetir el mismo aviso de
 * pedido dos veces). Null si no hay BD o si nunca se notificó esta factura.
 */
export async function obtenerEstadoPedido(factura: string): Promise<string | null> {
  const p = getPool();
  if (!p) return null;
  try {
    await tablaLista();
    const res = await p.query<{ estado: string }>(`SELECT estado FROM pedido_estados WHERE factura = $1`, [factura]);
    return res.rows[0]?.estado ?? null;
  } catch (err) {
    console.error("No se pudo leer el estado del pedido desde Postgres:", err);
    return null;
  }
}

/** Guarda el último estado notificado de una factura. Nunca lanza. */
export async function guardarEstadoPedido(factura: string, estado: string): Promise<void> {
  const p = getPool();
  if (!p) return;
  try {
    await tablaLista();
    await p.query(
      `INSERT INTO pedido_estados (factura, estado, actualizado_en) VALUES ($1, $2, $3)
       ON CONFLICT (factura) DO UPDATE SET estado = EXCLUDED.estado, actualizado_en = EXCLUDED.actualizado_en`,
      [factura, estado, Date.now()],
    );
  } catch (err) {
    console.error("No se pudo guardar el estado del pedido en Postgres:", err);
  }
}
