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
// La tabla de cada liga (pequeña) se baja cada 12 h y lo que falta de su
// temporada (una respuesta grande) cada 24 h: ver tablas.js.
export const HORAS_VALIDEZ_TABLA = 12;
export const HORAS_VALIDEZ_RESTANTES = 24;
// Las zonas de la tabla que proyecta la web: [nombre, desde, hasta], con los
// puestos de abajo en negativo (-3 es el antepenúltimo). Descenso directo: el
// puesto de promoción (el 16 en las ligas de 18) no cuenta. Reglas de 2025/26.
const ZONAS_COMUNES = (bajan) => [["Campeón", 1, 1], ["Top 4", 1, 4], ["Descenso", -bajan, -1]];
export const ZONAS = {
  PD: ZONAS_COMUNES(3), PL: ZONAS_COMUNES(3), SA: ZONAS_COMUNES(3), BL1: ZONAS_COMUNES(2),
  FL1: ZONAS_COMUNES(2), DED: ZONAS_COMUNES(2), PPL: ZONAS_COMUNES(2), BSA: ZONAS_COMUNES(4),
  ELC: [["Campeón", 1, 1], ["Ascenso directo", 1, 2], ["Descenso", -3, -1]],
};
export const FACTOR_DIARIO = 0.998;
export const PSEUDO_GOLES_ATAQUE = 6;
export const PSEUDO_GOLES_DEFENSA = 8;
export const ATAQUE_RECIEN_LLEGADO = 0.8;
export const DEFENSA_RECIEN_LLEGADO = { PL: 1.3 };
export const LIGA_DE_ARRIBA = { ELC: "PL" };
export const ATAQUE_DESCENDIDO = 1.2;
export const DEFENSA_DESCENDIDO = 0.85;
export const VERSION_MODELO = 5;   // 3 (oct 2026): sin los playoffs de la Championship
                                   // 4 (oct 2026): los mercados de goles con ENCOGER_TOTAL
                                   // 5 (oct 2026): los mercados de goles con MENOS_CEROS
export const FORMATO_LISTAS = 2;   // partidos_liga sin playoffs (soloLiga): las de antes se bajan otra vez

// La clave de IndexNow (indexnow.js): pública a propósito, en /<clave>.txt (public/), con
// la que los buscadores comprueban que las direcciones que se les mandan son de esta web.
// Si se cambia, cambiar también el nombre y el contenido de ese archivo.
export const INDEXNOW_CLAVE = "0929ae0a00d11dc89eade75a541f841f";
export const TOLERANCIA_FUERZAS = 1e-4;
export const MAX_ITER_FUERZAS = 300;
export const K_LIGA = 50;
export const PRIOR_AVG_LOCAL = 1.50;
export const PRIOR_AVG_VISITA = 1.15;
export const DIAS_VALIDEZ_PRIOR = 30;
export const LIMITE_GOLES = 10;
export const RHO_EMPATES = -0.05;
export const ENCOGER_TOTAL = 0.6;
export const MENOS_CEROS = 0.02;
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
    // escrituras al día para las visitas (visitas.js): D1 da 100.000 y la
    // actualización necesita las suyas
    maxVisitasDia: num("MAX_VISITAS_DIA", 20000),
    // cuentas nuevas por día de Lima (cuentas.js): cada una son unas pocas escrituras
    maxCuentasDia: num("MAX_CUENTAS_DIA", 300),
    // filas que escriben las cuentas en un día (estrellas, sesiones, cuentas nuevas...): el
    // 10 % de las 100.000 de D1. Borrar una cuenta no lo mira.
    maxEscriturasCuentasDia: num("MAX_ESCRITURAS_CUENTAS_DIA", 10000),
    // intentos de entrar (o de cambiar la contraseña) en un día, aparte: así los
    // fallos no gastan lo de las estrellas. Cada uno, unas dos escrituras.
    maxIntentosDia: num("MAX_INTENTOS_DIA", 3000),
    // Cloudflare Turnstile al crear una cuenta (cuentas.js): solo con las dos claves.
    // La del sitio es pública (wrangler.jsonc); la secreta va en el panel.
    turnstileSitio: env.TURNSTILE_SITEKEY || "",
    turnstileSecreto: env.TURNSTILE_SECRET || "",
    turnstileVerificar: env.TURNSTILE_VERIFICAR || "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    // Los avisos de Mis equipos (avisos.js): cuántos minutos antes del partido, cuántos se
    // mandan como mucho por minuto (cifrar y firmar cada uno cuesta ~0,3 ms de CPU) y los
    // topes de suscripciones (en total y nuevas al día) y de lo que escriben al día.
    avisoAntesMin: num("AVISO_ANTES_MIN", 120),
    maxEnviosPasada: num("MAX_ENVIOS_PASADA", 8),
    maxSuscripciones: num("MAX_SUSCRIPCIONES", 2000),
    maxSuscripcionesDia: num("MAX_SUSCRIPCIONES_DIA", 300),
    maxEscriturasAvisosDia: num("MAX_ESCRITURAS_AVISOS_DIA", 5000),
    // la dirección de la web, que va en la firma VAPID como contacto y en lo que se manda a
    // IndexNow (indexnow.js)
    urlWeb: env.URL_WEB || "https://pronosticos-bot.alvarocornejo2010.workers.dev",
    // adónde se mandan las páginas nuevas (indexnow.js); vacío, no se mandan
    indexnowUrl: env.INDEXNOW_URL ?? "https://api.indexnow.org/indexnow",
    // solo en las pruebas: el origen de un servicio de avisos de mentira (http://127.0.0.1:...)
    pushPrueba: env.PUSH_PRUEBA || "",
    // El calendario de Mis equipos (calendario.js): cuántos puede haber, cuántos nuevos al
    // día y cuántas filas escriben al día las altas y los cambios de equipos.
    maxCalendarios: num("MAX_CALENDARIOS", 5000),
    maxCalendariosDia: num("MAX_CALENDARIOS_DIA", 300),
    maxEscriturasCalendariosDia: num("MAX_ESCRITURAS_CALENDARIOS_DIA", 3000),
  };
}
