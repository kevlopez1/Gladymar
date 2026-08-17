/**
 * Medición del consumo de tokens de la API de Claude.
 *
 * Existe porque hasta ahora el gasto solo se podía ESTIMAR (contar caracteres
 * del prompt y multiplicar). La API devuelve el consumo real en cada respuesta;
 * lo único que faltaba era guardarlo.
 *
 * Se acumula por día en Postgres. Si la BD no está, no se pierde la atención al
 * cliente: simplemente no se registra.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { acumularUso, obtenerUso, type UsoDia } from "../db/index.js";

/**
 * Precios por millón de tokens del modelo en uso (Haiku 4.5).
 *
 * Están acá y no en la base para que el histórico se pueda recalcular si Meta
 * o Anthropic cambian tarifas: lo que se guarda son tokens, no plata.
 */
export const PRECIOS_USD_POR_MILLON = {
  entrada: 1,
  salida: 5,
  /** Escribir en caché cuesta 25% más que la entrada normal. */
  cacheEscrito: 1.25,
  /** Leerlo cuesta un 10% de la entrada: es de donde sale el ahorro. */
  cacheLeido: 0.1,
};

function fechaBolivia(): string {
  return new Date().toLocaleString("es-BO", { timeZone: "America/La_Paz", hour12: false }).split(",")[0].trim();
}

/**
 * Registra el consumo de una llamada. No se espera (`void`): medir el gasto no
 * debe agregarle latencia a la respuesta del cliente.
 */
export function registrarUso(usage: Anthropic.Usage | undefined | null): void {
  if (!usage) return;
  void acumularUso(fechaBolivia(), {
    entrada: usage.input_tokens ?? 0,
    salida: usage.output_tokens ?? 0,
    cacheEscrito: usage.cache_creation_input_tokens ?? 0,
    cacheLeido: usage.cache_read_input_tokens ?? 0,
  });
}

export interface ResumenUso {
  dias: UsoDia[];
  totales: UsoDia;
  costoUsd: number;
  /** Lo que se habría pagado sin caché, para ver cuánto ahorra. */
  costoSinCacheUsd: number;
}

export function costoUsd(u: Omit<UsoDia, "fecha" | "llamadas">): number {
  const p = PRECIOS_USD_POR_MILLON;
  return (
    (u.entrada * p.entrada +
      u.salida * p.salida +
      u.cacheEscrito * p.cacheEscrito +
      u.cacheLeido * p.cacheLeido) /
    1_000_000
  );
}

/** Consumo de los últimos días con su costo. Null si Postgres no responde. */
export async function resumenUso(dias = 60): Promise<ResumenUso | null> {
  const filas = await obtenerUso(dias);
  if (!filas) return null;

  const totales: UsoDia = { fecha: "total", llamadas: 0, entrada: 0, salida: 0, cacheEscrito: 0, cacheLeido: 0 };
  for (const d of filas) {
    totales.llamadas += d.llamadas;
    totales.entrada += d.entrada;
    totales.salida += d.salida;
    totales.cacheEscrito += d.cacheEscrito;
    totales.cacheLeido += d.cacheLeido;
  }

  // Sin caché, cada token cacheado se habría cobrado como entrada normal.
  const sinCache = {
    entrada: totales.entrada + totales.cacheEscrito + totales.cacheLeido,
    salida: totales.salida,
    cacheEscrito: 0,
    cacheLeido: 0,
  };

  return {
    dias: filas,
    totales,
    costoUsd: costoUsd(totales),
    costoSinCacheUsd: costoUsd(sinCache),
  };
}
