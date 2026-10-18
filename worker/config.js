// Constantes del modelo y de la app. Son las de app.py, copiadas una a una:
// test_paridad.py comprueba que no se separen y que el modelo dé lo mismo en
// los dos lenguajes. El porqué de cada valor está comentado en app.py.

export const LIGAS = {
  "La Liga": "PD",
  "Premier League": "PL",
  "Ligue 1": "FL1",
  "Bundesliga": "BL1",
  "Serie A": "SA",
  "Eredivisie": "DED",
  "Primeira Liga": "PPL",
  "Championship": "ELC",
  "Brasileirão": "BSA",
};

// Torneos: cada equipo se mide en su liga nacional (ver fuerzasChampions).
export const TORNEOS = {
  "Champions League": "CL",
};

export const COMPETICIONES = { ...LIGAS, ...TORNEOS };
export const CODIGOS_TORNEO = new Set(Object.values(TORNEOS));

export const FACTOR_LIGA = { PL: 1.25, PD: 1.06, FL1: 1.08, SA: 1.01, BL1: 1.06, PPL: 0.86, DED: 0.73 };
export const FACTOR_OTRA_LIGA = 0.87;
export const EXPONENTE_FUERZA_CHAMPIONS = 0.82;
export const ESCALA_CHAMPIONS = [0.90, 0.89];
export const K_HISTORIAL_CHAMPIONS = 54;
export const DIAS_VALIDEZ_LIGA_EQUIPO = 30;

export const HORAS_VALIDEZ_LIGA = 12;
export const HORAS_VALIDEZ_PREDICCION = 24;
export const FACTOR_DIARIO = 0.998;
export const PSEUDO_GOLES_ATAQUE = 6;
export const PSEUDO_GOLES_DEFENSA = 8;
export const ATAQUE_RECIEN_LLEGADO = 0.8;
export const DEFENSA_RECIEN_LLEGADO = { PL: 1.3 };
export const LIGA_DE_ARRIBA = { ELC: "PL" };
export const ATAQUE_DESCENDIDO = 1.2;
export const DEFENSA_DESCENDIDO = 0.85;
export const VERSION_MODELO = 2;
export const TOLERANCIA_FUERZAS = 1e-4;
export const MAX_ITER_FUERZAS = 300;
export const K_LIGA = 50;
export const PRIOR_AVG_LOCAL = 1.50;
export const PRIOR_AVG_VISITA = 1.15;
export const DIAS_VALIDEZ_PRIOR = 30;
export const LIMITE_GOLES = 10;
export const RHO_EMPATES = -0.05;
export const ENCOGER_GOLES = 0.5;
export const LIGAS_ANO_NATURAL = new Set(["BSA"]);
export const DIAS_SEMANA = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"];
export const MAX_INTENTOS_VALIDACION = 3;

// Lo que en app.py se lee de variables de entorno sale aquí de env: los "vars"
// de wrangler.jsonc o el panel de Cloudflare, con los mismos nombres.
//
// Dos cambian de valor por defecto, porque aquí no hay un hilo que corre cada
// 5 minutos sino un cron que corre CADA MINUTO, y en el plan gratis cada
// ejecución tiene 10 ms de CPU:
//   PRESUPUESTO_REQUESTS  6 por pasada (en app.py, 40 cada 5 min). Llenar la web
//                         la primera vez tarda algo más, ~35 minutos, y luego D1
//                         la conserva: los despliegues ya no la vacían.
//   MAX_BYTES_PASADA      cuánto JSON de la API se lee como mucho en una pasada.
//                         Leerlo es casi toda la CPU: ~7 ms por MB.
//   MAX_CALCULOS_PASADA   cuántos partidos se calculan como mucho en una pasada,
//                         aunque tengan todo en caché (pasa cuando caducan
//                         muchas predicciones a la vez).
export function ajustes(env = {}) {
  const num = (clave, defecto) => {
    const v = env[clave];
    return v === undefined || v === null || v === "" ? defecto : Number(v);
  };
  const si = (clave, defecto) =>
    !["0", "false", "no"].includes(String(env[clave] ?? defecto).toLowerCase());
  return {
    tz: env.TZ_LOCAL || "America/Lima",
    apiBase: String(env.API_BASE || "https://api.football-data.org/v4").replace(/\/+$/, ""),
    maxDiasBusqueda: num("DIAS_ADELANTE", 7),
    horasValidezFixtures: num("HORAS_VALIDEZ_FIXTURES", 2),
    minMinutosActualizacion: num("MIN_MINUTOS_ACTUALIZACION", 25),
    presupuesto: num("PRESUPUESTO_REQUESTS", 6),
    pausaMs: num("PAUSA_ENTRE_REQUESTS", 6.5) * 1000,
    maxBytes: num("MAX_BYTES_PASADA", 350000),
    maxCalculos: num("MAX_CALCULOS_PASADA", 40),
    autoValidar: si("AUTO_VALIDAR", "1"),
  };
}
