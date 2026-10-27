// La limpieza del día: lo caducado que nadie va a volver a pedir. Una sesión de 180
// días sin usarse se borraba solo cuando alguien intentaba usarla, y un calendario de
// 120 días sin pedirse, cuando se creaba otro: si nadie lo hacía, se quedaban en D1.
// Una vez al día, en un minuto libre del cron (planificador.js), con dos DELETE. Así
// lo que dice la política de privacidad (cuánto dura cada cosa) se cumple aunque
// nadie vuelva. Los avisos ya se limpian solos en cada pasada de avisos.js.

import { DIAS_SESION } from "./cuentas.js";
import { DIAS_SIN_USO } from "./calendario.js";

const MS_HORA = 3600000, MS_DIA = 24 * MS_HORA;
export const HORAS_LIMPIEZA = 24;

// doc: el documento limpieza tal como lo lee el planificador ({texto, actualizado}).
export function tocaLimpieza(doc, ahora) {
  if (!doc) return "nunca se ha hecho";
  const horas = (ahora - doc.actualizado) / MS_HORA;
  return horas >= HORAS_LIMPIEZA ? `la última hace ${Math.trunc(horas)} h` : null;
}

// Si falla, se apunta igual y se vuelve a intentar al día siguiente: no corre prisa,
// y así no se repite el error cada minuto.
export async function limpiar(almacen, ahora) {
  const db = almacen.db;
  let hecho;
  try {
    const [s, c] = await almacen.consultar(() => db.batch([
      db.prepare("DELETE FROM sesiones WHERE vista < ?1").bind(ahora - DIAS_SESION * MS_DIA),
      db.prepare("DELETE FROM calendarios WHERE visto < ?1").bind(ahora - DIAS_SIN_USO * MS_DIA),
    ]));
    hecho = { sesiones: s.meta.changes, calendarios: c.meta.changes };
  } catch (e) {
    console.error(`Error en la limpieza: ${(e && e.stack) || e}`);
    hecho = { error: String((e && e.message) || e) };
  }
  await almacen.escribir([almacen.sentenciaDoc("limpieza", { hecha: new Date(ahora).toISOString(), ...hecho }, ahora)]);
  return hecho;
}
