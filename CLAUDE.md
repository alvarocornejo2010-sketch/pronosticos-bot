# pronosticos-bot — contexto de proyecto

Resume el estado, las decisiones ya tomadas y por qué, para no repetir
investigación ya hecha. Claude Code lee este archivo automáticamente al abrir el
proyecto.

## Qué es

Web que predice resultados de fútbol (1/X/2, doble oportunidad y mercados de
goles: más/menos, ambos marcan, porterías a cero y marcadores) con un modelo
Poisson de fuerzas de ataque y defensa ajustadas por rival (ver "El modelo").
Corre en dos sitios con la misma lógica:

- **Cloudflare Workers** (`worker/`, oct 2026): la web pública desde el 18 oct
  2026. JavaScript, base D1 y un cron por minuto. Ver "Cloudflare: cómo funciona".
- **Render** (`app.py`, Flask): la versión de siempre, **suspendida desde el 18
  oct 2026**. Sigue siendo la referencia del modelo: la usan `afinar_liga.py`,
  `afinar_champions.py`, `validacion.py` y `test_paridad.py`, en local.

- Repo: `pronosticos-bot`
- Carpeta local: `C:\Users\Alvaro\Desktop\webapp`
- URL en Render: https://pronosticos-bot.onrender.com (suspendido: no responde;
  ver "Render: cómo se despliega").
- URL en Cloudflare: https://pronosticos-bot.alvarocornejo2010.workers.dev
  (funcionando desde el 18 oct 2026). En Settings → Domains sale también
  `*-pronosticos-bot.alvarocornejo2010.workers.dev`: es el patrón de las URLs de
  Preview, no la web (ver "Cloudflare: cómo se despliega").
- Ficheros clave: `app.py`, `public/index.html`, `public/app.js`,
  `validacion.py`, `worker/`, `wrangler.jsonc`, `test_paridad.py`, `pruebas/`,
  `.github/workflows/`, `afinar_liga.py`, `afinar_champions.py`, `diagnostico.py`
- **El repo es público**: todo lo que se sube (y su historial) lo ve cualquiera.
  Ver "Seguridad".

## Stack

- Python 3.12.7 en Render (el default de Render es 3.14 y rompe scipy — fijar
  versión explícitamente, `runtime.txt`). En local: 3.14.
- Flask + gunicorn (`gunicorn app:app`), scipy para el modelo Poisson.
- Datos: football-data.org, plan free (10 peticiones/minuto, sin acceso a
  temporadas 2021/2022 — devuelven HTTP 403).
- Ligas activas: PD, PL, FL1, BL1, SA, DED, PPL, ELC, BSA: todas las ligas del
  plan free. Torneo: la Champions (CL, en `TORNEOS`), que se predice con un
  modelo propio (ver "Champions: cómo se predice"). Mundial y Eurocopa no se
  ponen: son de selecciones y no hay con qué medirlas. Europa League y
  Conference League no están en el plan free.
- El Brasileirão (BSA) va de enero a diciembre: su temporada es el año natural
  (`LIGAS_ANO_NATURAL`). `temporada_actual(codigo)` lo tiene en cuenta para el
  prior; sin eso, entre enero y junio se anclaría en la temporada de hace dos
  años.
- Cloudflare, plan gratis: Worker en JavaScript (módulos ES, sin build ni
  dependencias), D1 (base `pronosticos-bot`, id
  `ab0a2af0-6f18-4e8d-92f4-32326e651bff`, región ENAM), un Cron Trigger cada
  minuto y la web como archivo estático (`public/`). Límites que mandan en el
  diseño: **10 ms de CPU por ejecución** (también en el cron), 50 peticiones
  externas por ejecución, 100.000 peticiones al día, 5 crons por cuenta; D1, 5
  millones de filas leídas y 100.000 escritas al día (desde sept 2026 se
  cortan al pasarse). `wrangler` va fijado en `package.json`.

## Arquitectura

Lo que sigue describe `app.py`. El Worker hace lo mismo con otro ritmo y otro
almacén: ver "Cloudflare: cómo funciona".

**Actualización reanudable por presupuesto.** Cada pasada gasta como mucho
`PRESUPUESTO_REQUESTS` (40). Al agotarse, el estado queda en `parcial` y la
siguiente pasada continúa por los partidos más cercanos. Las predicciones se
conservan 24h. `MIN_MINUTOS_ACTUALIZACION` no aplica cuando el estado es
`parcial`: continuar no es rehacer trabajo.

**Planificador interno** (sustituyó a cron-job.org). Hilos que arrancan al
importar el módulo:

- keep-alive cada 9 min: pide `/salud` a sí mismo vía `RENDER_EXTERNAL_URL`.
  Render free duerme el servicio tras 15 min sin peticiones entrantes, y un hilo
  de fondo no cuenta como tráfico.
- actualizador cada 5 min: decide si toca actualizar y ejecuta. También lanza la
  validación la primera vez, pero solo cuando el calendario ya está `listo`:
  llenar la web es más urgente que medir el modelo y las dos cosas compiten por
  las mismas 10 peticiones/minuto.

En local viene desactivado por defecto (solo se activa si detecta
`RENDER_EXTERNAL_URL`), para que `afinar_liga.py`/`afinar_champions.py` puedan importar
`app.py` sin gastar cuota de la API.

**Coste:** el plan free da ~750h de instancia/mes por workspace (el mes tiene
~730h). Con el keep-alive el servicio va 24/7 y las consume casi todas. Cabe si
`pronosticos-bot` es el único servicio del workspace — un segundo servicio free
suspendería a ambos.

**La interfaz no usa Jinja2.** `public/index.html` (antes `templates/`) no tiene
ni una etiqueta `{{ }}`: Flask la sirve como plantilla (`template_folder=
"public"`) y Cloudflare como archivo estático, con sus cabeceras en
`public/_headers`. Es un shell estático con el CSS en línea y el JS en
`public/app.js` (Flask lo sirve en `/app.js`; la imagen para historias va aparte,
en `public/imagen.js`, que se carga con `import()` solo al pulsar "Imagen"), que se pinta entero en
el cliente sondeando `/api/estado` (cada 15 s mientras hay cálculo en curso, cada
minuto el resto del tiempo y nada con la pestaña oculta: al volver a ella pide en
el acto). El sondeo lleva el ETag de la vez anterior y, si nada cambió, el servidor
contesta 304 sin cuerpo (`condicional` en `worker/index.js`, `_condicional` en
`app.py`; también `/api/registro` y `/api/validacion`): antes viajaban ~100 KB (15
comprimidos) cada 30 s, ~1,8 MB por hora de datos móviles. Con 304 la web repinta
igual, por lo que depende de la hora (la cuenta atrás, los que ya empezaron, Hoy y
Mañana): cuesta 11-26 ms en un móvil lento. No hay `static/`, ni build, ni
dependencias de JS; de
fuera solo llegan las fuentes Saira y Figtree (Google Fonts, con fallback del
sistema), los escudos (URLs de football-data.org) y, al crear una cuenta,
Cloudflare Turnstile (ver "Cuentas"). Al tocar la web se trabaja
sobre las funciones `pintar*` y `html*` de `app.js`, no sobre bucles de
plantilla. **Nada de JavaScript en `index.html`** (ni `<script>` en línea ni
`onclick=`): la CSP (`script-src 'self'`) lo bloquearía y la web se quedaría en
blanco. Para cargar algo de otro dominio hay que añadirlo a la CSP en los dos
sitios (ver "Seguridad"). Ojo al probar en local: fuera del modo debug, Flask guarda la
plantilla compilada y no ve los cambios de `index.html` hasta reiniciar. Cada
zona guarda una "huella" de lo último que pintó y solo toca el DOM si cambió
(`pintarBloques` lo hace bloque a bloque en la lista central): sin eso la tabla
parpadearía y perdería el scroll en cada sondeo. Los nombres de equipo vienen de
football-data.org, así que todo lo que entra pasa por `esc()`.

**Interfaz: marcador de estadio de noche (oct 2026).** Grande y legible, sin
márgenes vacíos. La banda de arriba es el marcador; debajo, tableros redondeados:

- Escritorio (≥1180px): banda del marcador arriba (marca, buscador —`/` lo
  enfoca, Esc lo limpia— y los 10 próximos partidos como tarjetas con escudos,
  cuenta atrás y la casilla dorada del favorito). Debajo, tres tableros de alto
  fijo. Izquierda: Ligas (insignia con la sigla, media de goles que usa el
  modelo y recuento) y Fiabilidad medida (`/api/validacion`, con selector
  1X2 / +2.5 / Ambos y, en Cloudflare, Temporada / En vivo: el registro en
  vivo de `/api/registro`). Centro: tira de días + tabla. Derecha: Los más
  claros (los 8 favoritos más fuertes de la semana; un clic abre el partido),
  Confianza del favorito (histograma), Últimos 7 días (en cuántos acertó el
  favorito frente a lo que esperaban sus probabilidades, por tramo, y la mayor
  sorpresa) y Resultados (los últimos 8 partidos terminados del registro: lo que
  la web le dio a lo que pasó y si acertó el favorito); los dos últimos, solo en
  Cloudflare. Abajo, barra de estado. Entre 880 y
  1179px los laterales se apilan en una sola columna. En móvil, una columna con
  pestañas fijas abajo: Partidos / Panorama / Ligas; la cabecera no es pegajosa
  (se va al bajar y las cabeceras de grupo se anclan arriba del todo).
- Un solo calendario: la tira de días. Primera tarjeta "Semana" (o "Todas" en
  una liga) y luego un día por tarjeta, con su recuento y una barrita por
  partido coloreada por la fuerza del favorito. Antes había además un
  calendario mensual a la izquierda y un "mapa de la ventana" por días a la
  derecha: se quitaron por repetir lo mismo. "Cómo leer la tabla" también se
  quitó: cada cabecera de columna lo explica en un tooltip.
- La tabla responde al ancho del panel central (container query `centro`), no
  al de la ventana. Las columnas entran por prioridad: <640px compacta (equipos
  apilados + 1 X 2), ≥640px tabla con 1 X 2, ≥780px más de 2.5 y ambos marcan,
  ≥940px 1X/X2/12, ≥1080px goles esperados y muestra, ≥1280px la barra de
  reparto. La columna Liga solo aparece en las vistas que mezclan ligas. En las
  que mezclan días en una sola lista (Claros o Reñidos, una liga entera fuera del
  orden por hora, la búsqueda) cada fila lleva su día ("Sáb 31 oct", o solo "Hoy" /
  "Mañana") debajo de la hora, y la columna de la hora se ensancha (`con-dia` en
  `.centro`, `--col-hora` y `--col-hora-c`): antes iba al lado, no cabía en la
  columna y se metía bajo el escudo del local (oct 2026).
- **El detalle de un partido** (al abrirlo, oct 2026; antes era una lista de
  etiquetas con frases). Arriba, los dos equipos frente a frente (escudo,
  nombre entero y "Seguir"; con el panel central de menos de 420px, solo la
  estrella, que el texto no cabía), y en medio la liga, la hora y Compartir. Debajo,
  el pronóstico en una frase (`htmlVeredicto`: "Favorito claro: X. De cada 10
  partidos así, gana unos 7"; claro con 60 o más, intermedio de 45 a 59 y parejo
  por debajo, los tramos del registro, con el entero que enseña la tabla). Luego,
  bloques con título pequeño: Quién gana (una barra repartida 1/X/2, cada tramo
  en el tono de la rampa de su probabilidad, con leyenda), Doble oportunidad
  (tres casillas), Goles esperados (dos barras enfrentadas desde el centro, en
  la tinta del texto: no son probabilidades), Portería a cero, Goles en el
  partido (el histograma 0 a 5+), Más / menos (1.5, 2.5 y 3.5, una barra
  repartida cada una), Ambos marcan y Marcadores más probables (tres
  casillas). Al final, apagado, "Cómo se calculó": muestra, cuándo, lo de la
  Champions y las notas. Los avisos (pocos partidos, liga fuera del plan,
  números viejos) van justo debajo de los equipos. Con el panel central de
  760px o más (container query `centro`), resultado y goles en dos columnas.
  Todos los % son enteros, los mismos que la tabla (`reparto`); "menos de" y
  "ambos marcan: no" son 100 menos el entero de "más de" y "sí". Cada % de los
  mercados (1X2, doble oportunidad, porterías a cero, más/menos, ambos marcan y
  marcadores) lleva debajo su **cuota justa** (`cuotaJusta`: 100 / el entero que
  se enseña, para que cuadre a la vista: 56 % es 1.79), siempre visible, como
  pidió el dueño del proyecto (oct 2026); "Cómo se calculó" explica qué es (lo que
  pagaría una apuesta sin el margen de la casa; las casas pagan menos) y que
  apostar es solo para mayores de 18. El histograma de goles no la lleva.
- Los % de 1/X/2 se redondean por resto mayor para que sumen 100, y la doble
  oportunidad se suma de esos mismos enteros: lo que se lee, cuadra. Igual el
  histograma de goles; "menos de" y "ambos marcan: no" se restan del número ya
  redondeado. La casilla de los próximos y la de los más claros usan el mismo
  entero que la tabla (`pctFavorito`).
- Rutas por hash: `#/`, `#/semana`, `#/dia/2026-10-10`, `#/liga/PD`,
  `#/liga/PD/2026-10-10`, `#/liga/PD/tabla` (ver "Tabla y proyección"), `#/favoritos`,
  `#/equipo/86` (ver "Página de cada equipo"). `#/` es toda la semana en escritorio y
  el primer día en móvil. Y dos sin hash, para compartir: `/partido/123` (ver
  "Compartir y favoritos") y `/equipo/86`, que pasa en el acto a `/#/equipo/86`.
- Tipografía: Saira (marca, títulos y todos los números) y Figtree (nombres y
  textos), de Google Fonts. Las dos tienen cifras tabulares, comprobadas en el
  navegador: las columnas de números no bailan.
- Redondeo con jerarquía: tableros 20px, tarjetas 14, controles 10, celdas 8 y
  píldoras redondas. Sin sombras ni degradados de adorno.
- Color: el oro es la probabilidad y nada más lo usa. La rampa es de un solo
  tono ámbar, 8 tramos (`RAMPA`), validada con el modo `--ordinal` del script
  de dataviz: luminosidad monótona, saltos ≥ 0.06, el tramo más bajo ≥ 2:1
  sobre el tablero y sobre el hover, tono que varía 11°. Tinta blanca en los
  tres primeros tramos y oscura en el resto, todas ≥ 4.8:1. La rampa anterior
  (arena oliva) no pasaba ese validador: dos tramos casi iguales, el más bajo a
  1.15:1 del fondo y 53° de tono. El blanco marca lo seleccionado (día, liga,
  orden).
- Ligas: la Champions va primera, con una insignia de contorno (UCL): es un
  torneo y no gasta un tono. Las ligas llevan insignia con la sigla dentro (ESP,
  ENG, FRA, ALE, ITA, NED, POR, EN2, BRA) y el tono de la liga de fondo; tinta oscura o blanca según el tono, todas
  ≥ 4.8:1. Como la sigla va siempre dentro, las insignias pueden ir mezcladas
  (tabla, próximos, más claros). Los tonos son los 8 de la paleta oscura de
  referencia del skill dataviz, validados por pares vecinos en el orden fijo
  PD, PL, FL1, BL1, SA, DED, PPL, ELC (`ORDEN_LIGAS`): cada vecino se separa al
  menos ΔE 19 en visión normal y 8.7 con daltonismo. La novena, BSA, va en gris
  rayado (`--liga-BSA`): la paleta validada tiene 8 tonos y un noveno inventado
  no pasaría la prueba. Pares que no son vecinos se parecen mucho (LaLiga rojo y
  Bundesliga naranja, ΔE ≈ 7; Bundesliga y Eredivisie ámbar, ΔE ≈ 11): si cambia
  el orden o se añade una liga, hay que volver a validar la paleta. Ningún texto
  va en color de liga.
- Escudos y nombres cortos: `_ficha_base` añade `local_corto`, `local_sigla` y
  `local_escudo` (y los de visita) sacados de la misma respuesta del calendario:
  cero peticiones extra. `_escudo` solo deja pasar URLs https; si una imagen no
  carga, la web pinta un monograma, y sin esos campos abrevia el nombre largo.
- Logo "Casilla": tres casillas 1 X 2 con el favorito encendido, en tres tramos
  de la rampa (#ffd24c, #a18047, #594d39). El mismo SVG va en la cabecera y
  como favicon (data URI del `<link rel="icon">`).

**Endpoints:** `/` (web), `/api/estado`, `/api/ligas` (qué ancla y qué media usa
cada liga), `/salud`, `/actualizar?token=...&forzar=1`,
`/validar?token=...[&temporada=N]` (lanza el backtest), `/api/validacion` (su
resultado), `/api/registro` (el registro en vivo; en Render responde
`no_disponible`) y `/api/contar` (POST: los avisos de visita de la web; en Render
no hace nada). Solo en Cloudflare: `/visitas?token=...`, el panel de visitas, y
`/api/visitas?token=...`, lo mismo en JSON (ver "Visitas"). Y `/partido/123`, la
web con la tarjeta de ese partido para compartir (en Render, la web sin tarjeta;
ver "Compartir y favoritos"), y `/robots.txt` y `/sitemap.xml` para los buscadores
(ver "Instalable y buscadores"). Y las cuentas: `/api/cuenta` (la de la sesión;
en Render, `disponible: false`) y, solo en Cloudflare, `/api/cuenta/crear`,
`/entrar`, `/equipo`, `/contrasena`, `/correo`, `/usuario`, `/salir`, `/borrar` (POST) y
`/datos` (ver "Cuentas"). Y `/api/tabla/PD`, la tabla de una liga y lo que le falta
de temporada (en Render, `no_disponible`; ver "Tabla y proyección"). Y los avisos de
Mis equipos: `/api/avisos` (la clave pública VAPID; en Render, `disponible: false`) y,
solo en Cloudflare, `/api/avisos/alta` y `/api/avisos/baja` (POST; ver "Avisos de Mis
equipos"). Y `/api/equipo/86`, la página de un equipo (en Render, `no_disponible`), y
`/equipo/86`, la web con su tarjeta (en Render, la web sin tarjeta; ver "Página de cada
equipo"). Y el calendario de Mis equipos, solo en Cloudflare: `/api/calendario` (POST) y
`/calendario/<clave>.ics` (ver "Calendario de Mis equipos").

**Efecto secundario de cada deploy:** el disco de Render free es efímero, cada
deploy borra `cache.json` y `data.json`. La web dice "Todavía no hay datos"
hasta la primera actualización, que el planificador lanza sola unos 20 s
después de arrancar y que paga el coste completo de API porque la caché está
vacía. Desde oct 2026 eso son unas 45 peticiones: por liga, su calendario, la
temporada anterior y lo jugado de esta (de ahí salen las fuerzas de todos sus
equipos), y para la Champions lo mismo más la liga de los equipos que no salen
en ningún calendario. Dos pasadas de 40: la web se llena en unos 10 minutos
(antes eran ~220 peticiones, dos por equipo, y ~55 minutos).
`/actualizar?token=...&forzar=1` no acelera
esto: sirve para rehacer una pasada antes de `MIN_MINUTOS_ACTUALIZACION`
(25 min) y para volver a bajar el calendario ignorando la caché.

En Cloudflare no pasa: D1 sobrevive a los despliegues y la web solo arranca
vacía la primera vez (unos 40 min hasta llenarse). La web sabe en cuál de los
dos está (`plataforma: "cloudflare"` en `/api/estado`) y explica cada caso.

## Cloudflare: cómo funciona (oct 2026)

`worker/` es `app.py` + `validacion.py` pasados a JavaScript función a función,
con las mismas cachés, validez, orden y redondeos. **Mismos números:**
`test_paridad.py` corre el modelo de los dos lados con miles de casos (goles
esperados, 1X2, mercados, Champions, validación entera, redondeo, ascendidos y
descendidos) y da 0 diferencias en unos 187.000 valores. Y de punta a punta,
contra una API falsa determinista (`/api/estado` con 149 partidos y 16 de
Champions, `/api/ligas`, `/api/validacion` de las 9 ligas, con equipos que
suben a la Premier y bajan a la Championship): 0 diferencias entre Flask y el
Worker, también con 1 de cada 5 peticiones respondida con 429. Esa prueba está en
`pruebas/` (ver "Pruebas automáticas").

Ficheros: `config.js` (constantes, las mismas de `app.py`), `modelo.js` (el
modelo y un `redondear` que imita a `round()` de Python, empates al par
incluidos), `actualizacion.js` (la pasada), `validacion.js`, `metricas.js`
(Brier, LogLoss, acierto y calibración, los de `validacion.py`), `registro.js`
(el registro en vivo), `planificador.js` (el cron), `almacen.js` (D1), `api.js`
(football-data con su presupuesto), `tiempo.js` (hora de Lima), `visitas.js`
(el contador de visitas), `compartir.js` (la tarjeta de `/partido/123`),
`buscadores.js` (`robots.txt` y `sitemap.xml`), `cuentas.js` (las cuentas),
`tablas.js` (la tabla de cada liga y lo que le falta), `avisos.js` (los avisos de Mis
equipos), `push.js` (su cifrado y su firma, Web Push), `equipos.js` (la página de cada
equipo), `calendario.js` (el calendario `.ics` de Mis equipos) e `index.js` (rutas).

**El ritmo lo marca la CPU.** El plan gratis da 10 ms por ejecución y leer el
JSON de la API cuesta ~7 ms por MB, así que en vez de una pasada de 40
peticiones cada 5 min hay una cada minuto con: como mucho 6 peticiones
(`PRESUPUESTO_REQUESTS`), separadas 6.5 s también entre pasadas (la hora de la
última va en D1), 350 KB de JSON (`MAX_BYTES_PASADA`), 40 partidos calculados
(`MAX_CALCULOS_PASADA`) y **una sola tarea pesada**: o una respuesta grande (una
temporada entera, ~400 KB) o un ajuste de fuerzas de una liga (`ajustarFuerzas`:
~4 ms en un isolate recién creado, que aún no ha compilado nada, y ~0.2 ms ya
compilado), nunca las dos (`api.pesada`). Lo que no cabe queda pendiente y el
estado sigue en `actualizando` (no hay `parcial`: el siguiente minuto continúa).
Medido con el perfilador de V8 del isolate del Worker en `wrangler dev`
(`pruebas/cpu_isolate.mjs`, lo que cuenta Cloudflare: sin el SQLite de la D1 local):
6-13 ms por pasada con la web al día (media ~8) y hasta ~37 en las de llenarla
desde cero; las tablas, hasta 20. Es una cota alta: el perfilador pesa y la máquina
no es la de Cloudflare. En producción no ha muerto ni una pasada desde el 18 oct
(`muertes` en los Logs y en D1), así que caben, con poco margen: Cloudflare tolera
que un isolate se pase del límite de vez en cuando, no siempre. **Ojo:** hasta el 25
oct las pruebas medían otro proceso (el intermediario de `wrangler dev`, ~3 ms haga
lo que haga el Worker) y de ahí salían los "3.5 ms de media" que decía este archivo:
no medían nada. Para ver la CPU de verdad en producción: Workers & Pages →
`pronosticos-bot` → Metrics (CPU time). Llenar la semana entera desde vacío: ~31
pasadas (por liga, una para cada temporada y otra para el ajuste).

**Para que quepa, casi no se lee JSON.** El calendario va en la tabla
`partidos`, cada partido con su ficha (nombres, hora, escudos) ya en JSON; las
predicciones, en `predicciones`, también en JSON. Lo que lee la web sale de un
solo JOIN y se monta pegando textos. La caché de la API (`cache`, por
secciones como `cache.json`) se lee fila a fila solo cuando se usa.

**Tablas de D1** (se crean solas si faltan, `ESQUEMA` en `almacen.js`):
`cache` (secciones `ligas`, `priors`, `partidos_liga` con los partidos de cada
liga de las dos temporadas, compactos, `fuerzas`, `calendario`,
`liga_equipo` y `tablas`, la clasificación y lo que falta de cada liga), `partidos`, `predicciones` (la última publicada de cada partido; no se
borra al empezar el partido: es lo que dijo la web. Con un índice por el nombre de cada
equipo, `predicciones_por_local` y `predicciones_por_visita`, para su página: las
consultas los piden con `INDEXED BY`, y si faltan, el "no such index" vuelve a pasar el
`ESQUEMA`, como una tabla que falta), `resultados` (el marcador
a los 90 minutos de cada partido con predicción, ya sumado al registro en
vivo), `documentos` (`estado` que sirve `/api/estado`, `resumen`, `validacion`,
`registro` y `registro_publico`, pedidos, temporadas terminadas compactas,
`temporada:liga:{código}:{año}`, `tabla:{código}` que sirve `/api/tabla/...` y
`tablas_resumen`, cuándo se bajó cada cosa, y los de los avisos: `vapid`, su par
de claves, y `avisos_resumen`, cuándo volver a mirar) y
`candado` (que dos pasadas no se pisen, hora de la última petición, pasadas
muertas), `visitas` (los contadores de visitas por día, ver "Visitas"), las de
las cuentas: `cuentas`, `usuarios`, `correos`, `accesos`, `sesiones` y `favoritos` (ver
"Cuentas"), y las de los avisos: `suscripciones`, `avisos` y `envios` (ver "Avisos de
Mis equipos"), y `calendarios` (ver "Calendario de Mis equipos").

**Si una pasada muere** (lo más probable, por CPU) deja el candado puesto; la
siguiente lo nota y hace la mitad (presupuesto, bytes y cálculos), hasta un
octavo, y recupera el ritmo de uno en uno cuando vuelven a terminar bien. El
candado caduca a los 5 min.

**La validación va por pasos de un minuto**, solo con la web `listo`: bajar
una temporada, bajar la otra, y recorrer la liga de 15 en 15 partidos
(`PARTIDOS_POR_PASO`) guardando por dónde iba (con las fuerzas del último día,
de las que arranca el ajuste siguiente). Cada día con partidos es un ajuste de
fuerzas, así que un paso cuesta más que con el modelo de antes (que iba de 25
en 25): 1 a 4 ms en caliente. Unas 4 horas la primera vez; las temporadas
quedan en D1. Como D1 no se borra, se repite sola cuando termina una temporada
nueva y cuando cambia el modelo: cada validación guarda su `version_modelo`, y
una de otra versión (o de antes de que existiera, que cuenta como la 1) se
repite con la web al día; una a medias de otra versión se empieza de cero.

**El registro en vivo** (`registro.js`, oct 2026): lo que publicó la web contra
lo que pasó, liga a liga, con las mismas métricas que la validación (Brier,
LogLoss, acierto y mercados de goles, frente a la base "equipo medio"). No
cuesta peticiones: cuando la pasada baja lo jugado de una competición
(`obtenerPromedioLiga`, cada 12 h, para la media y las fuerzas) cruza sus
marcadores con las predicciones de esa competición que no tienen resultado
(`liquidar`). Solo cuenta lo publicado antes de empezar. La base usa la media de
liga con la que se calculó la ficha (`media_local`/`media_visita`, también en
`app.py` para que `/api/estado` sea igual en los dos). Para la última jornada
de una temporada o la de antes de un parón ya no se pide esa liga, así que una
pasada que acaba con la ventana al día (o sin partidos) mira qué competiciones
tienen partidos terminados (2 h 30 después de empezar) sin resultado y con lo
jugado bajado antes de que acabaran, y vuelve a bajar lo de una
(`refrescarParaRegistro`): unas pocas peticiones a la semana. Las cuentas van
sumadas en el documento `registro` (no se releen las fichas) y lo que sirve
`/api/registro` va montado aparte (`registro_publico`): pedirlo es leer una
fila. Probado contra la API falsa: 149 partidos liquidados en 10 pasadas, una
por competición, sin contar ninguno dos veces. En la web: Fiabilidad medida →
En vivo, y los tableros Últimos 7 días y Resultados. En Render no existe (disco
efímero): `/api/registro` responde `no_disponible` y la web no lo enseña.

El registro lleva además un **resumen por día** (`dias`, 21 días; la web recibe
los 14 últimos en `semana` y suma los suyos): cuántos terminaron, en cuántos
acertó el favorito (el de la web, `veredictoDe`: el mayor, y si empatan, el
primero), cuántos aciertos esperaban sus propias probabilidades, lo mismo por
tramo de confianza (claros, 60 % o más; intermedios, 45-60; reñidos, menos de 45,
con el entero que enseña la web: un favorito que sale con 60 es claro) y el fallo
del favorito más claro. Un registro de antes (sin `dias`) se rehace
una vez con `resultados` y la ficha publicada (`rehacerDias`, con `json_extract`
para no leer las fichas enteras). Lo prueba `pruebas/semana.mjs`.

**Cambios respecto a `app.py`** (ninguno toca el modelo):
- un 429 de la API no se calcula a ciegas: el partido espera al minuto
  siguiente (`app.py` lo publicaba solo con la media de liga, 24 h);
- una petición que falla no se repite partido tras partido en la misma pasada;
- si el calendario cambia la hora o el nombre de un partido ya calculado, la
  ficha se corrige sin recalcular (`app.py` enseñaba la hora vieja hasta 24 h);
- un partido por jugar que deja de venir en el calendario se conserva hasta que
  falta en dos descargas seguidas (`VECES_AUSENTE`; la cuenta va en `ausentes`
  de la sección `calendario`). Y si una descarga falla, los partidos que ya había
  se quedan (`app.py` borraba la liga entera y la rehacía con lo que llegara).
  football-data responde a veces 200 con la lista incompleta: el 21 oct 2026, a
  las 09:14 de Lima, dio 5 de los 11 partidos de LaLiga de la semana, y los otros
  6 seguían programados. La web los perdió dos horas;
- una predicción caducada (24 h) se sigue enseñando hasta que la nueva está
  calculada; solo sale sin números un partido que nunca tuvo predicción
  (`app.py` la quitaba al caducar). Como las predicciones se calculan casi
  todas a la vez, caducan casi a la vez: sin esto, cada noche media semana
  salía "sin calcular" durante los ~20 minutos del recálculo (oct 2026). El
  resumen lleva `recalculando` (las que se están rehaciendo), que
  `/api/estado` no enseña;
- los intentos de la validación se arrastran (en `validacion.py` se perdían y
  el tope de 3 no frenaba nada);
- `/actualizar?forzar=1` y `/validar` dejan un pedido en D1 que el cron recoge
  en menos de un minuto: una petición web no puede durar lo que una pasada;
- el registro en vivo (`/api/registro`), las visitas (`/visitas`), la tabla con
  su proyección (`/api/tabla/PD`), los avisos de Mis equipos (`/api/avisos`), la
  página de cada equipo (`/api/equipo/86`) y el calendario de Mis equipos
  (`/calendario/<clave>.ics`) solo existen aquí.

**En local:** `npm install`, copiar `.dev.vars.example` a `.dev.vars`, `npm run
dev` y lanzar el cron a mano con
`curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=*+*+*+*+*"`. Con
`API_BASE` en `.dev.vars` se apunta a una API falsa y con
`PAUSA_ENTRE_REQUESTS=0` no espera entre peticiones.

## Visitas (oct 2026)

Para saber cuánta gente entra, si vuelve y qué mira, sin cookies, sin guardar IPs
y sin servicios de fuera (la CSP sigue igual). Lo cuenta `worker/visitas.js`; se
ve en `/visitas?token=...` (el mismo `UPDATE_SECRET`), una página ya pintada por
el Worker, sin JavaScript, con su propia CSP y `noindex`.

- **La web avisa** (`app.js`, sección VISITAS) con una petición al entrar
  (`entrada`: nuevo, vuelve o repite, días desde la última visita, ancho de
  pantalla y dominio de la página de la que llegó) y otra al irse, con lo demás
  junto (`sendBeacon` al ocultar la pestaña): partidos abiertos, ligas, búsquedas
  y pestañas del móvil. Para saber si vuelve, el navegador guarda en
  `localStorage` solo el día de su última visita
  (`pronosticos.ultima_visita`). Un visitante es un navegador en un día.
- **Se guarda sumado** en la tabla `visitas` (día de Lima, tipo, clave, n), sin
  nada de quién es quién: unas 200 filas al día, casi todas de partidos.
  `WITHOUT ROWID`, para que cada suma sea una escritura y no dos.
- **Nada inventado entra:** cada clave se coteja con una lista fija (ligas,
  pantallas, pestañas, orígenes por dominio) y un partido solo cuenta si tiene
  predicción. No cuenta lo que llega de otra web (`Origin`), de un bot que ejecuta
  JavaScript (`bot/`, `headless`, `lighthouse`...) ni lo de más de 4 KB.
- **Tope diario** (`MAX_VISITAS_DIA`, 20.000 escrituras): D1 da 100.000 al día y
  la actualización necesita las suyas. Si alguien machaca
  `/api/contar`, se pierden las cuentas de ese día, no las predicciones; el
  panel avisa de los días en que se llegó al tope. Con ~6 escrituras por
  visitante nuevo, da para unos 2.000-3.000 visitantes al día; si se llega, subir
  el tope o juntar más los avisos.
- **Lo que no se sabe:** WhatsApp y las demás apps casi nunca mandan de dónde
  viene la gente (sale como "Directo o desde una app"); quien entra desde dos
  aparatos cuenta dos veces.
- **El sondeo, con la pestaña oculta, para** (`bucle` en `app.js`): antes una
  pestaña olvidada pedía `/api/estado` cada 30 s todo el día, hasta 2.880
  peticiones de las 100.000 diarias del plan gratis. El registro en vivo (cada
  15 min) tampoco se pide con la pestaña oculta. Con la pestaña a la vista, una
  petición por minuto (ver "Arquitectura").
- **Errores del navegador** (`error`, clave `tipo:línea`): `app.js` apunta desde
  su primera línea los errores de JavaScript de sí misma (no los de una extensión)
  y las promesas rechazadas sin atrapar (`Promesa:0`), solo el tipo (de una lista
  cerrada; lo demás cuenta como `Error`) y la línea, nada del mensaje, que puede
  llevar datos de la página. Como mucho 3 por visita y 3 por aviso. En el panel,
  "Errores del navegador": si una línea sube, la web falla en algún aparato.
- **Compartir y favoritos** también se cuentan: veces que se pulsó Compartir
  (`compartir`, por partido), imágenes para historias (`imagen`, por partido), visitas que llegaron por un enlace `/partido/123`
  (`enlace`), estrellas puestas (`favorito`) y visitantes que siguen a algún
  equipo (`con_favoritos`). Y la app: instalaciones (`instalada`) y visitantes
  que entraron desde la app instalada (`en_app`, `display-mode: standalone`). En
  el panel, el tablero "Compartir, favoritos y app". Los avisos los cuenta el Worker,
  no la web (ver "Avisos de Mis equipos").
- **La página de cada equipo:** las veces que se abre (`equipo`, por equipo: solo cuenta
  si está en la tabla de una liga o juega en la semana) y que se pulsa su Compartir
  (`compartir_equipo`); las llegadas por un enlace `/equipo/86` van con las de
  `/partido/123` (`enlace`). En el panel, "Equipos que más se abren".

## Tabla y proyección (oct 2026)

En cada liga, una tarjeta "Tabla" en la tira de días (justo después de "Todas")
lleva a `#/liga/PD/tabla`: la clasificación de football-data y, por equipo, sus
puntos al final de la temporada (de media) y en cuántas de las temporadas
simuladas acaba campeón, entre los cuatro primeros (en la Championship, en el
ascenso directo, los dos primeros) y en el descenso directo. Para la Champions no
hay (es un torneo).

- **El servidor** (`worker/tablas.js`) baja, por liga, la tabla
  (`/competitions/PD/standings`, unos KB) cada 12 h y lo que falta de la temporada
  (`/matches?status=SCHEDULED,TIMED,POSTPONED`, una respuesta grande) cada 24 h,
  y monta el documento `tabla:PD`: la tabla y cada partido que falta con sus goles
  esperados, de `calcularXgPartido` con las mismas fuerzas y la misma media de liga
  que los partidos de la semana (`tablas.py` comprueba que coinciden). Entra lo que
  falta y no había empezado 2 h 30 antes de bajar la tabla (lo que estaba en juego
  no está en ella), y los aplazados; los playoffs no (`soloLiga`). Es lo menos
  urgente: va en un paso propio del cron, `tablas`, solo en los minutos en que no
  toca ni actualizar ni validar y con la web al día, una liga y una petición por
  minuto (`tocaTablas`, `pasoTablas`; lo lee del documento `tablas_resumen`, uno
  más en los que el planificador lee cada minuto). Una tabla que falla no se vuelve
  a pedir hasta pasada una hora. Unas 27 peticiones al día. Desde cero, unos 18
  minutos libres para las 9 ligas.
- **La web** la simula (`simularPorTandas`, sección TABLA de `app.js`): 4.000
  temporadas, cada partido con dos Poisson de sus goles esperados, de 500 en 500
  para que la página responda (en un móvil, menos de medio segundo con 300
  partidos). Semilla fija (mulberry32 con la liga y las fechas de la tabla): los
  mismos datos dan los mismos números en cada visita. En empate a puntos cuenta la
  diferencia de goles y luego los goles a favor; algunas ligas desempatan antes por
  los enfrentamientos directos (lo dice la nota). Las zonas, en `ZONAS`
  (`worker/config.js`, reglas de 2025/26): bajan 3 en LaLiga, la Premier, la Serie A
  y la Championship, 2 directos en la Bundesliga, la Ligue 1, la Eredivisie y la
  Primeira (el 16 juega la promoción, no cuenta) y 4 en el Brasileirão. **Si cambia
  el reglamento de una liga, cambiarlas ahí.**
- Los % van en la escala de probabilidad de la web (oro), "<1" por debajo de 1 y
  "—" si no pasa nunca. Con el panel central estrecho, sin PJ ni DG y con las
  cabeceras abreviadas. Es una `<table>` de verdad, con `caption` y títulos de
  columna con su explicación (`abbr`).
- **Lo que no sabe:** cada equipo juega lo que le queda como dicen sus fuerzas de
  hoy, sin que cambien por el camino; las simulaciones no varían la fuerza de un
  equipo, así que la proyección es algo más segura de sí misma de lo que debería.
  No se ha medido contra temporadas pasadas (`afinar_liga.py` tendría con qué).
- Se cuenta en las visitas (`tabla`, por liga): "Tablas que más se abren".

## Compartir y favoritos (oct 2026)

- **Imagen para historias** (oct 2026): bajo Compartir, el botón "Imagen" hace un
  PNG de 1080×1920 con el pronóstico (`public/imagen.js`, en un canvas, en el
  navegador: cero peticiones y cero CPU del Worker). Lleva la liga, la fecha con la
  hora de Lima, los dos equipos, la frase del veredicto, la barra 1X2 con los mismos
  enteros y tonos que la web, más de 2.5, ambos marcan y el marcador más probable,
  y la dirección de la web, todo por encima de los ~200 px de abajo, que en una
  historia de Instagram tapa la barra de responder. Se comparte con el menú del
  sistema si deja compartir archivos (`navigator.canShare({files})`: Android,
  iPhone) y si no, se descarga. Los escudos se piden con CORS; si football-data no
  lo permite, va el monograma (un escudo sin CORS no se puede exportar del canvas).
  Los tonos de liga salen de las variables CSS; el Brasileirão, rayado en la web, va
  en gris. `interfaz.mjs` comprueba que sale un PNG de 1080×1920.
- **Compartir:** cada partido abierto tiene un botón Compartir (en la cabecera del
  detalle, bajo la hora). En el móvil abre
  el menú del sistema (WhatsApp, Telegram...); si no lo hay, copia el enlace
  `/partido/123`. El texto lleva la fecha escrita y la hora de Lima, como la
  tarjeta: se lee otro día y quizá en otro país, así que nada de "Mañana 14:00". Esa ruta la sirve el Worker (`compartir.js`): pide `index.html`
  a los archivos estáticos (con sus cabeceras de `public/_headers`, CSP incluida)
  y cambia el bloque entre `<!-- og -->` y `<!-- /og -->` por las etiquetas Open
  Graph del partido: título con los equipos y descripción con la liga, la hora de
  Lima y el 1X2 con los mismos enteros que la tabla (`enterosQueSuman`). Cuesta
  una fila de D1. La imagen es `public/og.png` (1200×630, la misma para todos: un
  PNG por partido no cabe en 10 ms de CPU), hecha con Playwright desde un HTML con
  Saira y Figtree. Un partido que no existe da la tarjeta de siempre (la de
  `index.html`, que lleva la dirección de workers.dev escrita: si la web cambia
  de dominio, cambiarla ahí), con `X-Robots-Tag: noindex`. La web, al ver
  `/partido/123`, abre ese partido en cuanto tiene partidos (con la web vacía o un
  error, espera a la siguiente vez) y deja la dirección en `/#/dia/...`
  (`abrirEnlazado`); si ya empezó, lo dice y va a `#/`. En Render, `/partido/123` sirve la web sin tarjeta.
- **Favoritos:** en el detalle, "Seguir" con una estrella bajo cada equipo. Se
  guardan en el navegador (`pronosticos.favoritos`, los nombres completos, hasta
  60), sin cuenta. Sus partidos salen en `#/favoritos` ("Mis equipos", en el
  tablero de Ligas y en la tira de ligas del móvil), en la vista de un día en un
  grupo "Mis equipos" al principio (sin repetirse en su liga), en "Toda la
  semana" los primeros de su día, primero en Próximos y con una estrella junto al
  nombre. La estrella va en blanco: el oro es la probabilidad. Sin cuenta viven solo
  en ese navegador; con cuenta, también en la web (ver "Cuentas"). Con la web abierta
  en dos pestañas, cada una toma al momento las estrellas de la otra (evento
  `storage`), para no borrarlas al guardar las suyas. Y pueden avisar antes de cada
  partido (ver "Avisos de Mis equipos") y salir en el calendario de cada uno (ver
  "Calendario de Mis equipos").

## Página de cada equipo (oct 2026)

Cada equipo tiene su página, `#/equipo/86` (el id de football-data). Se llega desde su
nombre en el detalle de un partido y en la tabla de su liga, y se comparte con
`/equipo/86`, que lleva su tarjeta (título "Real Madrid: próximos partidos y
pronóstico", su liga, su puesto y su próximo partido con el 1X2) y entra en el sitemap
(todos los equipos de las tablas): es lo que Google puede encontrar por el nombre de un
equipo. Para enlazarla, cada ficha lleva `local_id` y `visita_id` (`fichaBase` y
`_ficha_base`, en los dos lados: `/api/estado` sigue igual en Flask y en el Worker). Las
predicciones de antes se ponen al día solas: la base cambia y la ficha se rehace sin
recalcular, con la siguiente descarga de su calendario.

- **Arriba, su ficha:** escudo, liga, puesto, puntos y su balance, su forma ("Últimos de
  liga": los 5 últimos, G/E/P con el marcador; en tinta, no en colores de estado), Seguir
  y Compartir. La pestaña del navegador lleva el mismo título que su tarjeta. Debajo, "En la tabla": cuántas temporadas simuladas acaba en cada zona de
  su liga y sus puntos medios, con la simulación de la tabla (`simularPorTandas`, la
  misma semilla: los mismos números que en `#/liga/PD/tabla`), y "Cómo juega": cuánto
  marca y cuánto encaja frente a un equipo medio de su liga contra los mismos rivales
  (sus fuerzas del modelo, `fuerzaEquipo`, en %) y su puesto en las dos cosas.
- **Luego, sus próximos partidos** de la ventana, por su nombre (como Mis equipos), con
  las filas de siempre: se abren ahí mismo.
- **Al final, lo que dijo la web** de sus últimos 6 partidos con resultado (de todas las
  competiciones; solo lo publicado antes de empezar, `contado`), con la fila del tablero
  Resultados (`htmlFilaResultado`): la casilla es lo que le dio a lo que pasó.
- **`/api/equipo/86`** (`worker/equipos.js`) se monta en cada petición, sin pedir nada a
  la API: la tabla de su liga (la que la contiene, buscada con `json_each` en los
  documentos `tabla:*`), sus fuerzas (`fuerzas`), lo jugado de esta temporada
  (`partidos_liga` `PD:actual`) y sus predicciones con resultado, por su nombre, con los
  dos índices. Menos de 1 ms de CPU y unas pocas filas leídas, con ETag y 304. Uno que no
  existe da 404. Un equipo que no está en ninguna tabla (de la Champions, de una liga
  fuera del plan) sale con su nombre del calendario y sin tabla ni fuerza.
- **Lo que no sabe:** la forma es solo de liga y de esta temporada (en las primeras
  jornadas, menos de 5); el puesto de su ataque y su defensa es entre los equipos de la
  tabla de hoy. En Render no hay tabla, fuerza ni registro: la página enseña solo sus
  partidos.

## Avisos de Mis equipos (oct 2026)

Un aviso del sistema (Web Push) 2 h antes de cada partido de los equipos con estrella,
con el pronóstico ("Hoy a las 14:00 (hora de Lima) · LaLiga. Real Madrid 48 % · empate
26 % · Barcelona 26 %."), y otro cuando termina, con el resultado y si acertó el
favorito ("Final: Real Madrid 2-1 Barcelona"). Si el de antes cae de madrugada en Lima
(de 23:00 a 6:59), llega a las 22:00 de la noche anterior. Gratis, sin cuenta y sin
correo; en el iPhone, solo con la web instalada (Safari no los deja de otra forma).

- **En la web** (sección AVISOS de `app.js`): una tarjeta arriba de Mis equipos
  ("Activar avisos" / "Quitar los avisos", o por qué no se puede: bloqueados,
  iPhone sin instalar, navegador sin avisos) y una invitación en el detalle de un
  partido de un equipo que sigues ("Ahora no" la quita para siempre). Al activarlos,
  el navegador pide permiso y se suscribe con la clave pública VAPID del servidor
  (`GET /api/avisos`, guardada un día en `pronosticos.avisos_clave` para que el
  permiso se pida en el mismo clic: Safari lo exige), y manda la suscripción y la
  lista de equipos a `/api/avisos/alta`. Cada vez que cambian las estrellas (y una
  vez por semana, para que el servidor sepa que sigue viva) la vuelve a mandar; si
  la suscripción se perdió o la clave del servidor cambió, se rehace sola.
  `/api/avisos/baja` la borra (pide la clave `auth` de la suscripción, que solo
  conocen el navegador y el Worker). `pronosticos.avisos` guarda lo último mandado;
  sin él, están apagados. Solo en Cloudflare: en Render, `/api/avisos` responde
  `disponible: false` y la web no los ofrece.
- **El service worker** (`sw.js`) enseña cada aviso (con `icono-192.png` y la
  insignia monocroma `insignia-96.png` para la barra de Android) y, al tocarlo, abre
  la web en ese partido (`/partido/123`), en la pestaña que ya estuviera abierta si
  la hay. Solo abre direcciones de esta web. Los dos avisos de un partido llevan la
  misma etiqueta: el del resultado sustituye al de antes.
- **En el Worker** (`avisos.js`): la tarea `avisos` del cron, con prioridad sobre la
  validación y las tablas (no sobre la actualización), cuando lo dice
  `avisos_resumen` (`proximo`: cuándo volver a mirar; `cola`: cuántos faltan). Mira
  las predicciones de las próximas horas y los resultados de las últimas 24 h de los
  equipos seguidos, pone en `envios` los avisos que ya tocan (una sola vez por
  partido y tipo: `avisos`) y manda hasta `MAX_ENVIOS_PASADA` (8) por minuto, los
  partidos más cercanos primero. Un resultado no llega antes de 2 h 35 después de
  empezar (`registro.js` lo apunta con 2 h 30 de margen), así que desde entonces se
  mira cada 10 minutos; si no, cada media hora. Un alta pide mirar en el minuto
  siguiente. Sin suscripciones, la tarea no corre nunca.
- **Cómo se manda** (`push.js`, sin dependencias, con WebCrypto): el mensaje se
  cifra para las claves del navegador (RFC 8291, `aes128gcm`; `pruebas/push.mjs`
  reproduce byte a byte el ejemplo del apéndice A) y la petición va firmada con
  VAPID (un JWT ES256 de 12 h, con la dirección de la web de contacto: `URL_WEB`).
  Cifrar y firmar cuesta ~0,3 ms de CPU por aviso. 201 es que llegó; 404 o 410, que
  el navegador ya quitó la suscripción (se borra, con su cola); un fallo de red, 429
  o 5xx se reintenta en el minuto siguiente, hasta 3 veces; lo demás se descarta y
  va al log. El de antes vale hasta que empieza el partido (`TTL`); el del
  resultado, un día. Un aviso que se queda sin tiempo en la cola no se manda.
- **El par VAPID lo crea el Worker** la primera vez que alguien pide
  `/api/avisos`, y vive en D1 (documento `vapid`, con la privada en JWK): no hay
  ningún secreto que poner en el panel. Quien lea la base (solo el dueño de la
  cuenta) podría mandar avisos a los suscritos. Para cambiarlo, borrar `vapid`: las
  suscripciones de antes dejan de valer y cada navegador se vuelve a suscribir solo
  al abrir la web.
- **Solo a los servicios de los navegadores:** la dirección de una suscripción
  tiene que ser de Google (`fcm.googleapis.com`), Mozilla, Apple (`web.push.apple.com`)
  o Microsoft (`*.notify.windows.com`) (`endpointValido`); si no, cualquiera podría
  hacer que el Worker mandara peticiones a la web que quisiera. Y la clave del
  navegador tiene que ser un punto de la curva P-256. En las pruebas, `PUSH_PRUEBA`
  deja además el servicio de mentira de `api_falsa.py`.
- **Topes** (contados en `visitas`): `MAX_SUSCRIPCIONES` (2.000 en total),
  `MAX_SUSCRIPCIONES_DIA` (300 nuevas al día) y `MAX_ESCRITURAS_AVISOS_DIA` (5.000
  filas al día por las altas). Una suscripción que no se renueva en 180 días se
  borra. Cada minuto caben 8 avisos (~480 por hora): para cientos de suscritos con el
  mismo equipo sobra; si se llegara a miles, subir `MAX_ENVIOS_PASADA` midiendo la CPU.
  Leer quién sigue a quién recorre todas las suscripciones en cada pasada de avisos
  (unas pocas por hora): con 2.000, unas 300.000 filas leídas al día de los 5 millones.
- **Qué se guarda** (`suscripciones`): la dirección del servicio, las dos claves del
  navegador y los nombres de los equipos, con cuándo se creó y se renovó. Nada de
  quién es. La política de privacidad tendrá que decirlo.
- **En el panel de visitas**, el tablero "Avisos de Mis equipos": suscripciones
  (y cuántas siguen a algún equipo), altas de la semana, avisos mandados antes del
  partido y con el resultado, los que el servicio no aceptó, los que llegaron tarde y
  las suscripciones borradas por 404/410 (`push` y `suscripciones` en `visitas`).

## Calendario de Mis equipos (oct 2026)

Los partidos de los equipos con estrella en el calendario de cada uno (Google Calendar, el
iPhone, Outlook), con su pronóstico, que se pone al día solo. Sin cuenta: una tarjeta en
Mis equipos ("Añadir a mi calendario") pide al Worker un calendario con la lista de
equipos de ese navegador (`POST /api/calendario`), que da una clave al azar (128 bits,
base32); la dirección es `/calendario/<clave>.ics`, y la tarjeta la ofrece para Google
Calendar (`calendar.google.com/calendar/render?cid=webcal://...`), para el iPhone, el Mac
u Outlook (`webcal://...`) y para copiarla. Cada vez que cambian las estrellas (y al abrir
la web, si cambiaron en otra pestaña o con la cuenta) la lista nueva va con la misma clave
(`calendarioAlDia` en `app.js`; `pronosticos.calendario` guarda la clave y lo último
mandado): el calendario suscrito la sigue solo. La clave es el único secreto; quien la
tenga ve y cambia esa lista de equipos, nada más.

- **Qué lleva** (`worker/calendario.js`): un evento de 2 h por partido de esos equipos
  (los de la ventana, con predicción o sin ella, y los de los últimos 7 días), en UTC (cada
  calendario lo pasa a su hora), "libre" (`TRANSP:TRANSPARENT`, no ocupa la agenda). Antes
  de terminar: "Real Madrid – Barcelona" y el pronóstico con los enteros de la web y más de
  2.5; con resultado: "Real Madrid 2-1 Barcelona" y lo que dijo la web, el texto de los
  avisos (`mensajeAviso`). Siempre con el enlace a `/partido/123`. `UID` por partido: un
  partido que cambia de hora se mueve, no se duplica. Pide volver a leerlo cada 6 h
  (`REFRESH-INTERVAL`; Google lo lee cuando quiere, a veces cada 12-24 h).
- **Formato:** iCalendar (RFC 5545) a mano, sin dependencias: texto escapado, líneas de 75
  octetos como mucho sin partir un carácter de UTF-8, CRLF. Lo comprueba `ics.py`.
- **Coste:** leerlo es una consulta (por el nombre de cada equipo, con los índices de las
  predicciones de "Página de cada equipo") y como mucho una escritura al día (`visto`). Un
  alta o un cambio de equipos, una fila.
- **Topes** (contados en `visitas`): `MAX_CALENDARIOS` (5.000 en total),
  `MAX_CALENDARIOS_DIA` (300 nuevos al día) y `MAX_ESCRITURAS_CALENDARIOS_DIA` (3.000 filas
  al día por altas y cambios). Uno que ningún calendario pide en 120 días se borra (al
  crear otro); si la web lo vuelve a mandar con su clave, se crea de nuevo con la misma, y
  la dirección que la persona tenía suscrita sigue valiendo.
- **Qué se guarda** (`calendarios`): la clave, los nombres de los equipos y cuándo se creó
  y se pidió por última vez. Nada de quién es. La política de privacidad tendrá que decirlo.
- `robots.txt` deja fuera `/calendario/` y `/api/calendario`. En el panel de visitas, el
  tablero "Calendario de Mis equipos": guardados, nuevos de la semana y pedidos en la
  última semana. Solo en Cloudflare: en Render la tarjeta no sale y `/api/calendario` da 404.

## Cuentas (oct 2026)

Para que los equipos que sigues se vean en todos tus aparatos y no se pierdan al
borrar los datos del navegador. **Usuario y contraseña, y un correo si la persona
quiere** (para entrar con él; aún sin verificar). La primera versión (23 oct) entraba
con un código de acceso; desde el 24 oct el código ya no sirve para entrar y cada
cuenta tiene un **ID** ("K7P4-QX2M", `idPublico`: los 40 primeros bits de su id en
letras de Crockford) que solo sirve para identificarla. **Todo en Cloudflare y gratis:**
es lo que pidió el dueño del proyecto; lo que cueste dinero (mandar correos) espera.

- **Cómo se entra:** "Entrar" en la cabecera (en el móvil, el icono de la persona;
  con la sesión abierta, "Mi cuenta" y la cabeza rellena) abre una ventana
  (`<dialog>`, sección CUENTA de `app.js`) con sus formularios: crear (usuario,
  correo opcional, contraseña y repetirla, y el recuadro de Turnstile), entrar
  ("Usuario o correo": si lleva `@` es un correo), cambiar o quitar el correo y
  cambiar la contraseña. Al crear la cuenta o entrar, los equipos de ese navegador
  pasan a la cuenta. El usuario: de 3 a 24
  letras sin tildes, números, punto, guion o guion bajo, empezando por letra o
  número, sin distinguir mayúsculas (`normalizarUsuario`, igual en los dos lados).
  La contraseña: 8 caracteres o más, distinta del usuario y fuera de una lista corta
  de las más comunes (eso lo mira el navegador: el servidor nunca la ve). Los
  campos llevan su `autocomplete` (`username`, `new-password`, `current-password`)
  para que el gestor de contraseñas del navegador las guarde. Un error sale junto
  al formulario y lo escrito se queda. La primera estrella sin cuenta avisa (una
  vez) de que se guarda solo en ese navegador.
- **La contraseña no sale del navegador tal cual:** `claveDe` la pasa por
  PBKDF2-SHA256 con 600.000 vueltas (`ITERACIONES`) y el usuario como sal, y manda
  el resultado (64 caracteres hexadecimales). El Worker guarda el SHA-256 de eso
  con una sal al azar (`usuarios`: `sal`, `hash`) y lo compara en tiempo constante.
  Así el trabajo lento lo hace el navegador (menos de un segundo en Chromium,
  petición incluida): un hash de contraseñas en el Worker no cabe en sus 10 ms de
  CPU. Quien leyera la base tendría que pasar cada intento por las 600.000 vueltas.
  **Si cambia `ITERACIONES` o la sal (`"pronosticos-bot/" + usuario`), todas las
  contraseñas guardadas dejan de valer.** Usuario que no existe y contraseña mal
  dan el mismo error. La contraseña actual mal al cambiarla responde 403, no 401
  (401 es "sin sesión" y la web saldría de la cuenta).
- **El bloqueo:** diez intentos seguidos sin acertar bloquean ese usuario 15
  minutos (`MAX_FALLOS`, `BLOQUEO_MS`); acertar pone la cuenta a cero. Cada intento
  se apunta **antes** de mirar la contraseña (`intento`, un `UPDATE ... RETURNING`
  que solo pasa si el usuario no está bloqueado): D1 los apunta de uno en uno, así
  que aunque lleguen 30 a la vez solo se comparan 10 (lo prueba `cuentas.py`). Si
  se apuntaran después, todos los que llegan a la vez leerían "0 fallos" y se
  compararían. Cambiar la contraseña con la actual cuenta igual: una sesión robada
  no sirve para probar contraseñas. Quien ya estaba dentro sigue dentro; lo que
  queda bloqueado es entrar desde otro aparato. **Límite aceptado:** quien sepa un
  usuario puede tenerlo bloqueado probando contraseñas cada 15 minutos (sin email
  no hay otra forma de demostrar quién es); su dueño sigue dentro donde ya tenía la
  sesión.
- **El correo** (`correos`, `/api/cuenta/correo`): opcional, en minúsculas, sin
  tildes ni ñ (`normalizarCorreo`, igual en los dos lados), uno por cuenta y el mismo
  no puede estar en dos. Para entrar con él sin preguntarle antes al servidor cuál es
  su usuario (eso diría a cualquiera el usuario de un correo), el navegador manda la
  contraseña pasada por PBKDF2 dos veces, con el usuario y con el correo de sal
  (`clave_correo`), y el Worker guarda las dos, cada una con su sal. Un usuario no
  lleva `@`, así que las dos sales no coinciden nunca. Por eso cambiar la contraseña
  manda también la nueva con el correo (`nueva_correo`), y poner o cambiar el correo
  pide la contraseña (cuenta como intento, como cambiar la contraseña). Los fallos con
  el correo van al bloqueo de su cuenta. Las cuentas de la primera versión, sin
  usuario, no pueden poner correo hasta tener usuario.
- **Sin verificar y sin recuperación:** mandar correos a cualquier dirección desde
  Cloudflare (Email Service) necesita el plan de pago de Workers (US$5 al mes) y un
  dominio propio; en el plan gratis solo se puede mandar a direcciones verificadas de
  la propia cuenta de Cloudflare. Así que hoy el correo no se verifica (`verificado`
  = 0) y una contraseña olvidada no se recupera: solo se puede cambiar desde un
  aparato donde ya se haya entrado. Lo dicen los formularios. Mientras tanto,
  alguien podría poner un correo que no es suyo y quien sí lo es no podría usarlo:
  cuando se verifique, que uno verificado pueda quitárselo a uno sin verificar.
- **Turnstile** (Cloudflare, gratis, contra los bots): "Crear cuenta" lleva su
  recuadro (casi siempre pasa solo) y el Worker comprueba la ficha con siteverify
  (`turnstileValido`: que sea buena, de esta web y para `crear`; cada ficha vale una
  vez, y tras cada intento la web pide otra). Solo funciona con las dos claves:
  `TURNSTILE_SITEKEY` y `TURNSTILE_SECRET`, las dos en el panel como tipo Secret (la
  del sitio es pública y la web la recibe en `GET /api/cuenta`, pero como Secret el
  despliegue no la borra: `wrangler deploy` quita las variables de texto que no
  están en `wrangler.jsonc`). Sin ellas, crear no lo pide. Se crean en Cloudflare →
  Turnstile → Add widget, con el dominio `pronosticos-bot.alvarocornejo2010.workers.dev`
  y modo Managed. El script se carga solo al abrir "Crear cuenta" (la CSP deja
  `script-src` y `frame-src` de `challenges.cloudflare.com` en los dos sitios). La IP
  va a Cloudflare con la ficha, como pide siteverify; aquí no se guarda. Entrar no lo
  lleva: lo frenan el bloqueo y el tope de intentos. La web va con `Referrer-Policy:
  no-referrer`; si con la clave de verdad Turnstile diera el error 110200 ("dominio no
  autorizado") con el dominio bien puesto, probar con `strict-origin`.
- **La sesión** es una cookie `sesion` (HttpOnly, Secure, SameSite=Lax; 180 días
  que se renuevan al usarla) con un token al azar; en D1 solo va su SHA-256.
  Cambiar la contraseña cierra las sesiones de los demás aparatos. Cada cuenta
  guarda sus 20 sesiones más recientes. Las rutas que escriben exigen JSON y venir
  de la propia web (`mismoSitio`, la misma comprobación que `/api/contar`), y cada
  una va por su nombre: una que no existe da 404. El botón sale con `plataforma:
  "cloudflare"` en `/api/estado`, y `/api/cuenta` solo se pide si ese navegador
  entró (`pronosticos.sesion` en `localStorage`, que además avisa a las otras
  pestañas): sin cuenta no cuesta ni una petición.
- **Las cuentas de la primera versión** (con código y sin usuario): "Mi cuenta" les
  pide usuario y contraseña (`/api/cuenta/usuario`); al ponerlos, el código se
  borra. Mientras no los tengan, solo se entra desde los aparatos donde ya tenían
  la sesión abierta.
- **Los equipos:** con la sesión abierta, los de la cuenta son los del navegador
  (al cargar la página, la cuenta manda) y cada estrella se guarda en los dos
  (`/api/cuenta/equipo`). Las estrellas van a la cuenta de una en una y en orden,
  por una cola guardada en el navegador (`pronosticos.cola_cuenta`): si falla la red
  o el tope, se reintentan con la siguiente estrella o al volver a abrir la web
  (antes de traer la lista de la cuenta, para no perderlas). Al crear la cuenta o
  entrar, los que ya había en el navegador se suman; al salir o borrar la cuenta,
  los del navegador se quedan. Hasta 60, como en el navegador.
- **Todo lo hace la persona sola**, en "Mi cuenta": cambiar la contraseña,
  descargar sus datos (`/api/cuenta/datos`: un JSON con todo lo guardado, sin la
  contraseña ni los tokens), cerrar sesión en este aparato o en todos, y **borrar
  la cuenta** (con confirmación en la misma ventana): se borran en el acto la cuenta,
  su usuario (que queda libre), sesiones y equipos. D1 guarda copias de los
  últimos 7 días (Time Travel del plan gratis): la política de privacidad tendrá
  que decirlo. Mientras va una petición, la ventana no se cierra.
- **Qué se guarda** (`worker/cuentas.js`): `cuentas` (id al azar, creada, última
  vez), `usuarios` (usuario, cuenta, sal, hash, fallos seguidos, bloqueo),
  `correos` (correo, cuenta, sal, hash, verificado, desde cuándo), `sesiones`
  (SHA-256 del token, creada, última vez), `favoritos` (cuenta, equipo, desde
  cuándo) y `accesos` (los códigos de la primera versión; queda para una passkey o
  Google). Nada de nombre ni IP. Las tablas se crean solas la primera vez que hacen
  falta (probado sobre una base sin `usuarios` y otra sin `correos`, como la de
  producción el 24 oct). Con correos guardados, la política de privacidad ya hace
  falta (ver "Pendiente").
- **Topes del día** (de Lima), contados en `visitas`: `MAX_CUENTAS_DIA` (300)
  cuentas nuevas (tipo `cuentas`; cuentan las creadas, no las que quedan, así que
  crear y borrar en bucle no lo esquiva), `MAX_ESCRITURAS_CUENTAS_DIA` (10.000,
  el 10 % de las escrituras de D1) filas escritas por las cuentas (tipo
  `escrituras_cuentas`, dos por sentencia, por lo alto: sin él, una sola cuenta
  poniendo y quitando estrellas en bucle podría gastar las 100.000 del día y dejar
  al cron sin guardar predicciones) y `MAX_INTENTOS_DIA` (3.000, unas dos
  escrituras cada uno) intentos de entrar o de cambiar la contraseña (tipo
  `intentos`). Los intentos van aparte para que probar contraseñas en bucle no
  gaste lo de las estrellas: al llegar al tope nadie puede entrar hasta el día
  siguiente, pero quien ya tiene la sesión abierta sigue guardando sus equipos.
  Borrar la cuenta no mira ningún tope: tiene que funcionar siempre. El panel de
  visitas tiene un tablero "Cuentas" (en total, creadas esta semana contando las
  borradas, activas, con equipos, con usuario, con correo e intentos de entrar de la semana:
  muchos más intentos que entradas es alguien probando contraseñas). Lo que
  falta para que un solo atacante no pueda gastar el tope de intentos: un límite
  por IP (el binding de Rate Limiting de Workers, que no cuesta escrituras; no
  está claro que entre en el plan gratis) o la regla de límite de un dominio
  propio.
- **Solo en Cloudflare:** en Render, `/api/cuenta` responde `disponible: false` y
  el botón no sale.
- **Para crecer:** verificar el correo y recuperar la contraseña con él (cuando se
  pague el plan de Workers y haya dominio), entrar con passkey o con Google (otro tipo
  en `accesos` de la misma cuenta). Lo que falta antes de anunciarlo a lo grande, en
  "Pendiente".

## Instalable y buscadores (oct 2026)

- **Instalar como app:** `public/manifest.webmanifest` (nombre, `standalone`,
  colores de la web e iconos 192, 512 y 512 "maskable", más
  `apple-touch-icon.png` para el iPhone; todos del logo Casilla, hechos con
  Playwright) y `public/sw.js`, un service worker que de las peticiones solo toca
  las navegaciones: si no hay red, responde una página "Sin conexión" (503) en vez
  del error del navegador. También enseña los avisos de Mis equipos. No guarda nada en caché: la web va con `no-store` y los números
  cambian cada minuto. Chrome la da por instalable (`Page.getInstallabilityErrors`
  vacío). Cuando el navegador ofrece instalarla (`beforeinstallprompt`: Chrome,
  Edge, Android), sale "Instalar app" en la cabecera ("App" en el móvil, que no
  cabe; por debajo de 380px el estado se queda en su punto); en el iPhone se
  instala desde Compartir → "Añadir a pantalla de inicio". La CSP lleva
  `manifest-src 'self'` y `worker-src 'self'` en los dos sitios. En Flask, los
  archivos de `public/` que no son la página van por una lista cerrada
  (`ARCHIVOS_WEB`), y `sw.js` lleva la CSP de la web (su `connect-src 'self'` es
  lo que le deja pedir la página).
- **Buscadores:** toda la web va detrás del `#`, que Google no ve como páginas
  distintas; lo que sí ve son los `/partido/123` y los `/equipo/86` (ver "Página de cada
  equipo"), cada uno con su título, su `meta description` (la misma que la tarjeta) y su
  `canonical`. El Worker sirve
  `/robots.txt` (sí a la web, los partidos y los datos que pinta: Google pinta la
  página pidiendo `/api/estado`, y sin él indexaría "Cargando"; no a
  `/api/contar`, `/api/visitas`, `/visitas`, `/api/avisos`, `/api/calendario`, `/calendario/`, `/actualizar` ni `/validar`) y `/sitemap.xml` con la portada, los partidos por
  jugar y los equipos de las tablas (`buscadores.js`, dos consultas a D1). Las direcciones salen del origen de
  la petición. Solo en Cloudflare. Para que Google lo lea antes, falta darlo de
  alta en Search Console (verificar la propiedad con una etiqueta `meta`, la
  pondría el dueño de la cuenta).
- **Ligas de fiabilidad baja:** la Championship (+2.7 % de mejora sobre "no
  saber nada", 2.855 partidos) y el Brasileirão (+3.5 %, 277) aportan mucho menos
  que las demás (+7.5 a +15.6 %, ver "Validación"). La web lo marca:
  "fiabilidad baja" en la cabecera de su grupo (con un tooltip que lo explica; con
  la tabla de menos de 640px, solo el icono, para que quepa el nombre de la liga),
  en su fila del tablero de Ligas y en el título de su vista, y un aviso en el
  detalle de cada partido. Los números están fijos en `POCO_FIABLES` (`app.js`),
  medidos con `afinar_liga.py` en las temporadas de prueba: si se reajusta el
  modelo, actualizarlos.

## Seguridad (revisada en oct 2026)

**El repo es público.** Revisados el 16 oct 2026 el árbol y los 36 commits que
había entonces en todas las ramas (y las descripciones de las PRs): no había ni
una clave; los commits posteriores no se han revisado igual. Lo único que
parece un secreto son valores de ejemplo (`tu_token`, `*_dummy_secret`) y dos
identificadores que no dan acceso a nada sin una clave: el id de la base D1
(`wrangler.jsonc`; Cloudflare lo pone ahí a propósito) y el del servicio de
Render. Los commits de fusión hechos desde la web de GitHub llevan el email de
la cuenta; para que los siguientes no lo lleven: GitHub → Settings → Emails →
"Keep my email addresses private".

**Los secretos** y dónde viven (nunca en el repo):
- `FOOTBALL_DATA_TOKEN`: la clave de la API. Render → Environment y Cloudflare
  → Settings → Variables and Secrets (tipo Secret). Viaja en la cabecera
  `X-Auth-Token`, nunca en la URL, y no se escribe en ningún log.
- `UPDATE_SECRET` (12 caracteres o más): protege `/actualizar` y `/validar`. Se
  compara en tiempo constante (`hmac.compare_digest` en bytes en Python;
  SHA-256 + `timingSafeEqual` en el Worker). Va en la URL (`?token=`), así que
  queda en el historial del navegador y en los logs de Render y Cloudflare, que
  solo ve el dueño de la cuenta: no pegar esa URL en ningún sitio público. Si
  se filtra, se cambia en los dos paneles y listo (no hay nada más atado a él).
- `TURNSTILE_SECRET`, solo en Cloudflare (tipo Secret, con `TURNSTILE_SITEKEY`,
  que es pública: ver "Cuentas"). Si se filtra, se rota en Cloudflare →
  Turnstile y se cambia en el panel.
- La clave privada VAPID de los avisos no está en el panel: la crea el Worker y vive
  en D1 (ver "Avisos de Mis equipos").
- En local van en `.env` / `.dev.vars`, que `.gitignore` deja fuera
  (`.dev.vars.example` sí se sube: solo lleva ejemplos).

**Cabeceras** (las mismas en `app.py` y `public/_headers`; `test_paridad.py`
comprueba que coinciden): `nosniff`, `X-Frame-Options: DENY`, `no-referrer`,
`no-store`, HSTS de un año y una **CSP** que solo deja cargar el JS de la propia
web (`script-src 'self'`, nada en línea), las fuentes de Google, los escudos de
`crests.football-data.org`, el manifiesto y el service worker de la propia web
(`manifest-src 'self'`, `worker-src 'self'`) y Cloudflare Turnstile (`script-src` y
`frame-src` de `challenges.cloudflare.com`, al crear una cuenta); un escudo de otro dominio se
bloquea y la web pinta el monograma. Probado en Chromium en los dos sitios: la web pinta igual, sin
violaciones, y un `<img onerror=...>` inyectado a mano no se ejecuta. Las
respuestas JSON llevan `default-src 'none'`.

**Lo demás, revisado y bien:** todo lo que llega de la API pasa por `esc()`
antes del DOM (también los textos de error); las consultas a D1 van todas con
parámetros (`?1`), sin pegar texto; el JSON que se monta a mano en el Worker
sale siempre de `JSON.stringify`; los escudos solo pasan si son `https://`;
`REDIRIGIR_A` antepone un origen fijo, así que no sirve para redirigir a otro
sitio; un error 500 del Worker no enseña el detalle (va a los logs). En
`wrangler.jsonc`, `preview_urls: false`: sin eso cada versión subida tendría
una URL pública propia, con la base y los secretos de producción, para siempre.

**Dependencias** (oct 2026, `pip-audit` y `npm audit` a cero): Flask 3.1.3 y
requests 2.33.1 (los avisos de 3.1.0 y 2.32.3 no afectaban a esta app: no usa
sesiones ni `.netrc`), wrangler 4.149.0 (la 4.146 arrastraba un `sharp`
vulnerable, solo en local). El 25 oct `npm audit` ya no daba cero: tres avisos de
`undici` (dos moderados y uno alto, denegación de servicio y SRI), que llega por
`wrangler` → `miniflare`. Solo en local (`wrangler dev`), nada en producción; no
había aún una versión de wrangler que lo arreglara (`npm audit fix --force` la
bajaba a la 4.35): subir wrangler cuando la haya. Playwright 1.56.1 y axe-core
4.10.2 solo sirven a las pruebas. Para repasarlo: `pip install pip-audit &&
pip-audit -r requirements.txt` y `npm audit`.

**Riesgo que queda:** las rutas públicas solo leen, pero cada petición al
Worker cuenta para las 100.000 diarias del plan gratis. Alguien que las
machacara a propósito dejaría `/api/estado` sin servicio hasta la medianoche
UTC (la web en sí, que es estática, seguiría cargando). En `workers.dev` no hay
reglas de WAF; con un dominio propio en Cloudflare sí habría una regla de
límite de peticiones gratis. Las rutas públicas que escriben en D1 son
`/api/contar`, las de las cuentas, el alta de los avisos y la del calendario, todas con
tope diario (ver "Visitas", "Cuentas", "Avisos de Mis equipos" y "Calendario de Mis equipos"); quien machaque `/api/cuenta/entrar` deja a todos sin poder entrar ese
día (no sin sus equipos).

## El modelo (oct 2026)

**Fuerzas ajustadas por rival** (`ajustar_fuerzas`, `obtener_fuerzas_liga`). Cada
equipo tiene un ataque y una defensa (1 = equipo medio de su liga), sacados de
TODOS sus partidos de liga de la temporada anterior y lo jugado de esta, en
casa y fuera. Los goles esperados de un partido son media de la liga (en casa o
fuera, `obtener_promedio_liga`, como siempre) × ataque propio × defensa del
rival, y cada fuerza se elige para que cuadre con lo que pasó:

```
ataque = (goles marcados + k·a0) / (goles que habría marcado un equipo medio
          contra esas mismas defensas + k)
```

y lo mismo con la defensa. Como cada una depende de las de los rivales, se
repite hasta que no cambian (unas 13 vueltas). Cada partido pesa
`FACTOR_DIARIO`^días (0.998: a los 347 días, la mitad), y `k`
(`PSEUDO_GOLES_ATAQUE` 6, `PSEUDO_GOLES_DEFENSA` 8, en goles esperados) encoge
hacia el prior del equipo: 1 si ya estaba en la liga la temporada anterior; si
no, lo que diga `prior_recien_llegado` (ver "Recién llegados"). Encima, el 1X2
lleva la corrección de Dixon-Coles de los marcadores bajos (`RHO_EMPATES` =
-0.05) y los mercados de goles encogen con `ENCOGER_GOLES` = 0.5.

**Recién llegados** (`prior_recien_llegado`, oct 2026). Un equipo que no estaba
en la liga la temporada anterior parte de:
- un ascendido: ataque `ATAQUE_RECIEN_LLEGADO` (0.8) y defensa 1, salvo en la
  Premier, donde el que sube de la Championship encaja mucho más
  (`DEFENSA_RECIEN_LLEGADO` = {PL: 1.3});
- uno que baja de la liga de arriba (`LIGA_DE_ARRIBA` = {ELC: PL}, los de la
  Premier a la Championship): ataque 1.2 y defensa 0.85 (`ATAQUE_DESCENDIDO`,
  `DEFENSA_DESCENDIDO`): son de los fuertes de su nueva liga. Para saber quién
  baja, `obtener_fuerzas_liga` mira los equipos de la temporada anterior de la
  Premier, que ya están en `partidos_liga` (`PL:previa`): cero peticiones más.

Medido con `afinar_liga.py descensos`, eligiendo en las temporadas de ajuste:
en su primera temporada en la Championship los que bajan marcan un 12% más que
el medio y encajan un 13% menos (21 equipos; en prueba, 19% y 22%), y con su
prior la Championship gana -0.0016 de Brier en ajuste y en prueba (-2.2 y -1.9
se). Las combinaciones de ataque y defensa con la misma fuerza neta (1.4 y 1.0,
1.3 y 0.95...) dan casi lo mismo; se queda la del reparto medido. Los que suben
a la Premier encajan un 13% más que el medio (ajuste; en prueba, un 28%): con
defensa 1.3, la Premier gana -0.0008 en ajuste y -0.0011 en prueba (-1.6 y
-1.7 se). En las demás ligas una defensa peor para el ascendido no se distingue
de 1 en el ajuste (1.1: -0.0001, -0.8 se), así que no se pone. La fuerza del que
sube en la Championship apenas anticipa la que tendrá en la Premier
(correlación 0.1-0.2): no se usa.

Las listas de partidos salen de lo que ya se bajaba para las medias de liga:
`obtener_prior_liga` (la temporada anterior, una petición al mes) y
`obtener_promedio_liga` (lo jugado de esta, cada `HORAS_VALIDEZ_LIGA` = 12 h)
guardan los partidos compactos (`partidos_compactos`: día, local, visita,
goles) en `partidos_liga`. Ya no hay una petición por equipo
(`/teams/{id}/matches`): llenar la semana cuesta ~45 peticiones en vez de ~220,
y la fuerza se actualiza cada 12 h en vez de cada 3 días.

**Solo partidos de liga** (`solo_liga`/`soloLiga`, modelo 3, oct 2026). La media,
las listas de `partidos_liga` y las temporadas de la validación cuentan solo los
partidos con `stage` `REGULAR_SEASON` (o sin `stage`). Sin esto, los playoffs de
ascenso de la Championship se colaban: 557 partidos en la temporada 2025/26 en
vez de 552. `afinar_liga.py` ya los quitaba, así que ahora producción mide lo
mismo que se afinó. Si el filtro dejara menos de la mitad (la API marcara la fase
de otra forma), se quedan todos. La Champions no pasa por el filtro. Las listas
llevan `formato` (`FORMATO_LISTAS` = 2) y las de antes se vuelven a bajar. Las
temporadas de la validación van con otro nombre: en D1, `temporada:liga:PD:2025`
(las `temporada:PD:2025` de antes ya no se leen); en disco,
`validacion_cache/PD_2025_liga.json`.

**El de antes** (hasta oct 2026), para comparar: los últimos 20 partidos de
cada equipo en 400 días, en casa y fuera por separado (el ataque en casa salía
solo de sus ~10 partidos en casa), encogidos hacia la media de la liga con 6
partidos de pseudo-cuenta, y sin mirar contra quién fueron. Sigue en
`afinar_liga.py` (`recorrer_anterior`) como referencia.

**Medido con `afinar_liga.py`**: resultados de openfootball de 8 ligas (las cinco
grandes desde 2010/11-2014/15, Países Bajos y Portugal desde 2018/19, la
Championship con huecos) más el Brasileirão (2020 y 2026), 102 temporadas y
35.586 partidos, cada uno predicho solo con lo jugado en días anteriores, como
`validacion.py`. Los parámetros se eligieron mirando solo las temporadas hasta
2020/21 (20.133 partidos) y se juzgan en las de 2021/22 a 2025/26 (14.706), que
no se usaron para elegir nada. Skill del 1X2 frente a "equipo medio":

```
                          partidos   antes    ahora   diferencia de Brier
ajuste (hasta 2020/21)     20.133    +5.1%    +8.2%   -0.0202 ± 0.0011 (-18.2 se)
prueba (2021/22-2025/26)   14.706    +6.1%    +8.9%   -0.0180 ± 0.0013 (-13.6 se)
2026/27 hasta octubre         747    +4.2%    +7.2%   -0.0204 ± 0.0059  (-3.5 se)
```

Mejor en las 9 ligas y en las 16 temporadas por separado. Lo que más pesa:
medir a cada equipo con todos sus partidos (casa y fuera juntos, el doble de
datos) y frente al rival que tuvo. Los recién llegados y el peso por antigüedad
suman menos, pero se ven (el ascendido, 0.0003 de Brier en el ajuste). LogLoss:
de 1.0199 a 0.9935 en la prueba. Empates: 25.1% predichos frente a 25.4% reales
(sin la corrección, 24.1%).

Probado y descartado (diferencias de ±0.0003 o peor en el ajuste): pesar menos
la temporada anterior aparte del peso por días, la media de liga pesada como
los partidos, normalizar las fuerzas a media 1, recortar goleadas a 4 o 5
goles, K_LIGA 20 o 200, y acercar los goles esperados del 1X2 a la media (beta
1.05: -0.0001). Y en oct 2026:
- **Ventaja de campo propia de cada equipo**: un multiplicador de lo que marca
  en casa y otro de lo que encaja en casa, encogidos hacia la ventaja de su liga.
  Con 5 a 40 goles de pseudo-cuenta empeora (+0.0043 a +0.0003 de Brier en el
  ajuste); con 80 o 160 no se distingue de no tenerla (±0.00002). Lo que parece
  ventaja de campo propia es ruido.
- **Lo que rinde cada equipo en la Champions, en su fuerza de liga**: lo que
  marcó y encajó en la Champions frente a lo que daba su fuerza de liga,
  encogido, aplicado a sus partidos de liga. Criba con las cuatro Champions de
  `afinar_champions.py` (2022/23 a 2025/26): con el encogimiento más fuerte,
  -0.0003 a -0.0005 de Brier en los partidos de liga de equipos con Champions
  (-2.2 a -2.5 se, sin temporadas aparte para elegir), unas -0.0002 en toda la
  liga. No compensa: el Worker tendría que cargar la Champions y las fuerzas de
  otras ligas para cada partido de liga. Las copas nacionales no están en el
  plan free.

Ojo con openfootball: cambió la forma de escribir los nombres en 2020/21 (las
cinco grandes y la Championship: "Arsenal" a "Arsenal FC") y en 2023/24
(Francia, Países Bajos y Portugal: "PSV Eindhoven" a "PSV"). Sin casarlos
(`mapa_nombres`), media liga contaba como recién ascendida esas temporadas; el
modelo de antes también lo sufría en la tabla de "Validación" de antes de oct
2026 (por eso la Ligue 1 2023/24 salía en +2.3%). Y los 0-0 de 2025/26 en
adelante vienen como `[0, 0]` en vez de `{"ft": [0, 0]}`.

**Mismos números en el Worker**: `ajustarFuerzas` en `worker/modelo.js` hace las
mismas operaciones en el mismo orden (el peso de cada día se multiplica día a
día en vez de con `exp`, para que salga el mismo double), y `test_paridad.py` lo
comprueba sin tolerancia en 300 ligas al azar. Las vueltas del ajuste usan el
peso total de cada cruce (i en casa contra j), así cuestan 24×24 y no lo que
tenga la lista. `TOLERANCIA_FUERZAS` = 1e-4: con 1e-6 hacían falta el doble de
vueltas y los goles esperados (con dos decimales) salían iguales salvo algún
0.01 suelto en el borde de un redondeo.

## Bugs ya encontrados y corregidos (no reabrir sin motivo nuevo)

1. **Normalizador equivocado en `calcular_xg_partido`** (crítico). La defensa del
   visitante se dividía entre `avg_visita`, pero los goles que encaja fuera son
   goles de local. Dos equipos medios daban xG 2.00-0.93 en vez de 1.55-1.20 —
   sesgo sistemático a favor del local en todos los partidos.
2. **`/v4/matches` global no sirve en plan free:** devuelve HTTP 200 con lista
   vacía en vez de 403. Se usa `/v4/competitions/{cod}/matches` con
   `dateFrom`/`dateTo`, inyectando a mano el bloque `competition`.
3. **Fallback todo-o-nada** (`n_local == 0 or n_visita == 0` → 1.3 fijo) producía
   predicciones idénticas a inicio de temporada. Sustituido por encogimiento
   bayesiano hacia la media de liga.
4. **Datos contaminados:** `/teams/{id}/matches` sin `competitions` mezclaba Copa
   del Rey, Champions y amistosos; `limit=20` sin orden no garantizaba los 20
   últimos.
5. **Prior de una liga aplicado a las cuatro** (sept 2026). `PRIOR_AVG_LOCAL` /
   `PRIOR_AVG_VISITA` salían de LaLiga y se usaban en todas. Con `K_LIGA=50`, a
   30 partidos jugados el prior pesa el 62% del valor estimado; Bundesliga (más
   goleadora) salía ~9-12% por debajo. Arreglado: cada liga se ancla en su propia
   temporada anterior (`obtener_prior_liga`), una petición por liga cacheada 30
   días. Las constantes quedan solo como último recurso. Verificado: BL1 pasó de
   -11.8% a +3.2% de sesgo.
6. **Zona horaria en Windows:** `zoneinfo` no encuentra `America/Lima` sin el
   paquete `tzdata` (en Linux viene con el SO). Añadido a `requirements.txt` +
   fallback a UTC-5 fijo (exacto para Perú todo el año).
7. **Poisson truncado en 5 goles** perdía hasta 6.5% de masa → límite subido a 10
   y normalizado. Añadidas dobles oportunidad X2 y 12. `Cache-Control: no-store`
   para que un deploy no deje al navegador con la interfaz vieja.
8. **La validación no medía la media de liga de producción** (oct 2026).
   `validacion.py` metía la temporada anterior entera en la media de liga
   (380 partidos más los de esta más K_LIGA de ancla), y producción usa solo
   los de esta más K_LIGA. Ahora las dos hacen lo de producción.

## Champions: cómo se predice (oct 2026)

El modelo de liga no sirve para la Champions: mide a cada equipo con sus
partidos en la misma competición, y en la Champions son 4 en casa y 4 fuera
contra rivales de niveles muy distintos; su "media de liga" mezcla al Bayern con
el campeón de Kazajistán. Por eso la Champions va en `TORNEOS` y no en `LIGAS`,
con su propio cálculo, que junta tres cosas:

- **Su liga nacional** (`fuerzas_champions`): sus fuerzas de liga, las mismas
  de sus partidos de liga (`obtener_fuerzas_liga`), sin una sola petición más.
  Se elevan a `EXPONENTE_FUERZA_CHAMPIONS` (0.82): los grandes arrasan en su
  liga y su fuerza nacional tomada tal cual exagera. Con las fuerzas de antes
  (sin ajustar por rival ni encoger) el exponente salía 0.39.
- **El nivel de su liga** (`FACTOR_LIGA`): PL 1.25, FL1 1.08, PD 1.06, BL1 1.06,
  SA 1.01, PPL 0.86, DED 0.73, y 0.87 para un equipo de una liga fuera del plan
  (`FACTOR_OTRA_LIGA`), que cuenta como un equipo medio de ese nivel.
- **Su historial en la Champions** (`historial_champions`): lo que marcó y
  encajó en sus partidos de Champions de esta temporada y la anterior, frente a
  lo esperado de un equipo de su nivel de liga contra esos mismos rivales
  (media de la Champions × escala × nivel propio / nivel del rival). Se encoge
  hacia 1 con `K_HISTORIAL_CHAMPIONS` (54 goles de pseudo-cuenta,
  `multiplicadores_historial`): con 16 partidos de Champions su historial pesa
  algo menos de un tercio, y sin partidos queda como estaba. Las dos temporadas
  pesan igual (medido: la anterior aporta tanto como la actual).
  Los partidos salen de lo que ya se baja para la media (`historial` en la
  entrada de la Champions de `ligas` y de `priors`); solo cuesta alguna
  petición la liga de un rival de la temporada pasada que no esté en caché
  (`liga_domestica`, guardada 30 días): unas pocas al mes.
- Goles esperados (`calcular_xg_champions`): media de la Champions ×
  `ESCALA_CHAMPIONS` (0.90, 0.89) × ataque propio × defensa rival × nivel propio
  / nivel rival × historial de ataque propio × historial de defensa rival.
  Luego, el mismo `calcular_poisson` y `mercados_de_goles` que en liga.
- Los goles de la Champions se cuentan a los 90 minutos (`goles_90`): con
  prórroga o penaltis, `fullTime` es el resultado final (en la v4, con la
  tanda sumada) y manda `regularTime`. Afecta a la media y al historial; en
  liga no cambia nada.
- De qué liga es cada equipo (`liga_domestica`): primero, gratis, en los
  calendarios de liga ya descargados; si no sale, una petición a `/teams/{id}`
  (`runningCompetitions`). Se guarda 30 días en la caché (`liga_equipo`).
- Los cruces de eliminatoria aún sin decidir (equipo sin id) no se pintan.

Medido con `afinar_champions.py` sobre cuatro Champions (2022/23 a 2025/26, 628
partidos con resultado, de openfootball; las ligas nacionales de 2021/22 a
2025/26), cada partido predicho solo con lo anterior a su fecha. Skill del 1X2
frente a "equipo medio", dejando fuera una temporada entera cada vez (con 5
bloques al azar sale casi igual):

```
                                   fuerza de liga     fuerza de liga
                                   de antes           de ahora (oct 2026)
solo nivel de liga                  +7.4%              +7.4%  (-3.8 se)
liga nacional atenuada + nivel     +10.2%             +12.3%  (-5.8 se)
+ historial en la Champions        +12.3%             +13.1%  (-6.2 se)   <- la app
```

Con la fuerza de liga nueva, mejor medida, la liga sola ya da casi lo que
daban liga e historial juntos, y el historial aporta menos (-0.0049 ± 0.0024 de
Brier, -2.1 se; antes -3.6 se). Se queda: gana en las cuatro temporadas. Los
parámetros salen estables: exponente entre 0.74 y 0.90, K entre 44 y 78 en los
nueve ajustes. En un estudio previo con los mismos partidos (y la fuerza de
antes) se probaron otras dos formas de medir el historial: frente a la media de
la Champions sin mirar a los rivales y frente a lo que decía el modelo
completo; la elegida les ganaba por unos 2 se. La fórmula de producción
reproduce la del estudio (Brier 0.5343 frente a 0.5344 en la muestra). Lo
esperado del historial usa los niveles y la escala de `app.py`, así que se
ajustan dando vueltas hasta que no se mueven (con la fuerza nueva, tres
vueltas: la escala bajó de 0.92 a 0.90 y K subió de 46 a 54).

Ojo con los datos: la Champions 2022/23 de openfootball usa nombres cortos
("Real Madrid", "Inter", "Sporting CP") y las demás temporadas y las ligas, los
largos. Sin casarlos (`casar` y `ALIAS` en `afinar_champions.py`), 8 grandes de
2022/23 contaban como "otra liga" y el historial parecía mejor de lo que es.
Las ligas se leen con `afinar_liga.cargar`, que casa además los nombres de una
temporada a otra (ver "El modelo").

La Champions no entra en la validación de la app (`validacion.py` recorre solo
`LIGAS`): la web explica el cálculo en el detalle de cada partido, con lo que
dice el historial de cada equipo.

## Validación

**Por liga** (`afinar_liga.py`, temporadas de prueba 2021/22 a 2026/27, cada
partido solo con lo de antes): skill del 1X2 frente a la base "equipo medio",
el modelo de antes y el de ahora, y el test pareado de Brier entre los dos en
errores estándar (se):

```
Liga            partidos   antes     ahora
LaLiga            1.959    +5.9%     +8.7%   (-5.1 se)
Premier           1.950    +7.1%     +9.8%   (-4.2 se)
Bundesliga        1.566    +4.5%     +8.0%   (-5.4 se)
Serie A           1.940    +7.5%    +10.5%   (-5.7 se)
Ligue 1           1.722    +5.2%     +7.5%   (-3.9 se)
Eredivisie        1.592    +9.5%    +12.6%   (-4.8 se)
Primeira Liga     1.592   +12.0%    +15.6%   (-6.6 se)
Championship      2.855    +0.7%     +2.7%   (-4.4 se)
Brasileirão         277    +1.1%     +3.5%   (-1.7 se)   (2026 hasta octubre)
```

- **La Championship y el Brasileirão siguen siendo los que menos aportan.** Son
  las ligas más igualadas (desviación típica de puntos por partido entre
  equipos ~0.35, frente a 0.45-0.58 de las demás), y el skill va en la misma
  dirección que la igualdad: las más desiguales (Eredivisie, Primeira) son las
  más previsibles. La Championship ya gana a la base (+2.7%, antes +0.7%; los
  descendidos de la Premier con su propio prior suman 0.2 de eso).
- **El Brasileirão no se puede medir bien con estos datos:** openfootball solo
  tiene 2019, 2020, 2025 y 2026. La validación de la app (`/api/validacion`) lo
  mide con la temporada completa y la anterior de football-data.
- En la Championship se quitan los playoffs de ascenso: no son liga, y
  openfootball los escribe de tres formas distintas según la temporada (solo
  vale `round` con "Matchday"). En la app, desde el modelo 3, también
  (`solo_liga`, ver "El modelo").

`validacion.py` corre ese mismo backtest walk-forward **dentro de la app**
(`/validar?token=...`, resultado en `/api/validacion`): importa
`ajustar_fuerzas`, `calcular_xg_partido`, `calcular_poisson` y
`mercados_de_goles` de `app` en vez de reimplementarlos, para no validar una
copia desincronizada del modelo desplegado. Recorre la temporada día a día: las
fuerzas de cada día se ajustan con lo jugado en días anteriores, arrancando de
las del día anterior (solo acelera la convergencia).
Además del 1X2 mide más de 2.5 y ambos marcan (`mercados` en el resultado) contra
la misma base "equipo medio". Cuesta 2
peticiones por liga y solo la primera vez — las temporadas terminadas no cambian,
así que quedan cacheadas en disco.

## Mercados de goles — `ENCOGER_GOLES = 0.5` (oct 2026)

Más/menos, ambos marcan, porterías a cero y marcadores salen de
`mercados_de_goles`, no de `calcular_poisson`. El 1X2 no cambió ni en el código.
La función usa los goles esperados acercados a la media de la liga, en escala
logarítmica: `media · (xg/media)^0.3`.

Por qué: con los goles esperados tal cual, el modelo exagera las diferencias de
goles entre partidos. Donde daba 27% de "más de 2.5" pasó un 42%, y donde daba
74% pasó un 62%. El orden lo acierta, la magnitud no. Así perdía contra la base
"equipo medio": skill −1.3% en más de 2.5 y −1.0% en ambos marcan.

Primera medida (con el modelo de antes y `afinar_goles.py`, ya retirado): 3.484
partidos de cinco ligas, 2023 y 2024; cualquier α entre 0.2 y 0.4 ganaba a la
base en las dos temporadas y se puso 0.3.

Con las fuerzas ajustadas por rival los goles esperados son mejores y conviene
encoger menos. Medido con `afinar_liga.py afinar` (ajuste | prueba, skill frente
a la base "equipo medio"):

```
alfa   más de 2.5          ambos marcan
0.3    +0.94% | +0.85%     +0.56% | +0.55%
0.5    +1.24% | +1.13%     +0.69% | +0.69%   <- app.py
0.6    +1.29% | +1.18%     +0.68% | +0.68%
1.0    +0.74% | +0.74%     +0.06% | +0.07%
```

Con el modelo de antes y su 0.3 eran +0.46% y +0.23% en la prueba. Aun así la
ganancia es pequeña frente al ~9% del 1X2: con solo goles marcados y encajados,
el total de goles de un partido apenas se predice mejor que con la media de su
liga. La web lo dice en el detalle de cada partido y en el panel Fiabilidad. No
vender estos números como el 1X2.

## Afinado del modelo en sept 2026: por qué entonces no se cambió nada

En sept 2026 solo se podían bajar LaLiga 2023 y 2024 (760 partidos; 2021 y 2022
dan 403 en el plan free), y con eso ninguna configuración se distinguía de otra:
la que ganaba en una temporada perdía al validarla en la otra, y el mínimo de
LogLoss de las dos juntas ganaba por 0.0021 ± 0.0029. Por eso entonces no se
tocaron la corrección de empates ni el prior de los ascendidos, aunque los dos
efectos se veían. Con los 35.586 partidos de openfootball se reabrieron y los dos
salieron reales: `RHO_EMPATES` = -0.05 y `ATAQUE_RECIEN_LLEGADO` = 0.8, elegidos
en las temporadas de ajuste y confirmados en las de prueba (ver "El modelo"). De
ahí la regla de "Convenciones": elegir con unas temporadas y juzgar con otras.

## Herramientas de afinado

- `afinar_liga.py` (oct 2026) mide el modelo de liga de `app.py` frente al de
  antes, por liga y por temporada, con test pareado de Brier y LogLoss (~30 s), y
  con `afinar` busca los parámetros en las temporadas de ajuste y los juzga en
  las de prueba; con `descensos`, de dónde parten los recién llegados (los que
  bajan de la Premier a la Championship y los que suben a cada liga, con su
  fuerza de verdad en su primera temporada). Baja ~120 ficheros de openfootball (sin token) a
  `openfootball_cache/` y casa los nombres entre temporadas. La evaluación usa
  las funciones de `app.py` y el recorrido de `validacion.py`; la búsqueda, una
  gemela en numpy del mismo ajuste, y al final comprueba que da lo mismo.
  Sustituye a `backtest.py`, `afinar.py` y `afinar_goles.py`, que medían el
  modelo de antes con LaLiga sola (y los dos primeros necesitaban el token).
- `afinar_champions.py` estima `FACTOR_LIGA`, `FACTOR_OTRA_LIGA`,
  `EXPONENTE_FUERZA_CHAMPIONS`, `ESCALA_CHAMPIONS` y `K_HISTORIAL_CHAMPIONS` con
  cuatro Champions (2022/23 a 2025/26, del repositorio `champions-league` de
  openfootball, en formato de texto) y las ligas nacionales de football.json, y
  compara modelos con validación cruzada y dejando fuera una temporada entera.
  Usa las funciones de `app.py` (`historial_champions`, `calcular_xg_champions`),
  no una copia. Tampoco necesita token. Tarda ~1 minuto.

## Cloudflare: cómo se despliega

Workers Builds, conectado al repo de GitHub desde el panel (Workers & Pages →
Create → Import a repository): **un push a `main` despliega solo**, con
`npx wrangler deploy` (sin comando de build). El Worker del panel tiene que
llamarse `pronosticos-bot`, como `name` en `wrangler.jsonc`, o el build falla.
La base D1 va enlazada por su id en `wrangler.jsonc`; el cron, también ahí.

**Builds de las otras ramas: hay que desactivarlos** (Settings → Build → Branch
control → desmarcar "Enable Preview Builds"). Un Worker creado desde el 22 sept
2026 compila las ramas que no son `main` como Worker Previews (`npx wrangler
preview`), que exige un bloque `previews` en `wrangler.jsonc`. Mientras sigan
activos, el check "Workers Builds: pronosticos-bot" de cada PR sale en rojo
aunque producción despliegue bien: no es un fallo de la PR. No se añade el
bloque a propósito: cada rama tendría una URL pública propia, sin la base ni los
secretos (la página saldría rota), y el proyecto evita URLs de más
(`preview_urls: false`). Los checks de las PR salen de GitHub Actions (ver
"Pruebas automáticas").

Secretos, en el panel (Settings → Variables and Secrets, tipo Secret):
`FOOTBALL_DATA_TOKEN` y `UPDATE_SECRET`, los mismos valores que en Render →
Environment, y las dos claves de Turnstile (`TURNSTILE_SITEKEY` y
`TURNSTILE_SECRET`, ver "Cuentas"). Sin el token, la web lo dice ("Falta el secreto
FOOTBALL_DATA_TOKEN...") y en cuanto se pone, el siguiente minuto arranca.

Para ver qué pasa: Workers & Pages → `pronosticos-bot` → Deployments (qué
versión está viva) y Logs (cada pasada escribe una línea con lo que hizo:
`{"tarea":"actualizar","estado":...,"peticiones":6,"kb":180,"muertes":0}`).
`muertes` mayor que 0 quiere decir que alguna pasada se pasó de CPU.

**Render y Cloudflare no pueden ir los dos a la vez**: usan el mismo token y
juntos se pasarían de 10 peticiones por minuto. Render está suspendido desde el
18 oct 2026. Si algún día se reanuda (por ejemplo, para que quien entre por la
dirección vieja llegue a la nueva), antes hay que poner
`REDIRIGIR_A=https://pronosticos-bot.alvarocornejo2010.workers.dev` en Render →
Environment: así manda cada petición a la misma ruta de Cloudflare (302) y su
planificador no arranca.

## Render: cómo se despliega

**Suspendido desde el 18 oct 2026**: un push a `main` ya no despliega nada ahí
y la dirección de Render no responde. Lo que sigue es cómo funcionaba, por si
se reanuda (con `REDIRIGIR_A`, ver "Cloudflare: cómo se despliega").

Configuración del servicio `pronosticos-bot` (`srv-da749a2d0e5s73d8iuvg`),
consultada en la API de Render (sept 2026):

```
autoDeploy: yes    autoDeployTrigger: commit    branch: main    rootDir: (vacío)
```

**Un push a `main` despliega solo**, normalmente en menos de un minuto.
**Un push a cualquier otra rama no despliega nada**: si el trabajo está en una
rama con su pull request abierta, hay que mergear a `main` primero. La pestaña
Events del panel no sirve para saber si el auto-deploy funciona: ahí los
deploys manuales se leen fácil y los automáticos pasan desapercibidos.

Cómo comprobarlo en 5 segundos: Render → Events, comparar el hash del último
"Deploy live" con `git log --oneline -1 main`. Si no coinciden, mira primero en
qué rama está tu commit.

Después de cada deploy el disco arranca vacío y la web se llena sola en unos
minutos (ver "Efecto secundario de cada deploy"). Para rehacer una pasada a
mano: `/actualizar?token=...&forzar=1` con el valor de `UPDATE_SECRET` (Render →
Environment).

## Pendiente (por orden de lo que más mueve la aguja)

- **Mirar `/visitas` a las dos semanas** (en marcha desde oct 2026), también
  "Compartir, favoritos y app". Con eso se decide lo siguiente, ideas ya
  habladas: un dominio propio (más fácil de recordar, Search Console y la regla
  de límite de peticiones; ojo, `canonical`, `og:url` y `og:image` de
  `index.html` llevan workers.dev) y, si hay gente que vuelve, una porra gratis
  contra el modelo con las cuentas que ya hay (sin dinero ni premios). Hecho en
  oct 2026: el enlace con vista previa, los favoritos, el resumen de la semana,
  instalarla como app, el sitemap, la marca de las ligas de fiabilidad baja, las
  cuentas (ver "Cuentas"; lo que les falta, en el punto siguiente), los avisos de
  Mis equipos (ver "Avisos de Mis equipos"), la página de cada equipo (ver "Página
  de cada equipo") y el calendario de Mis equipos (ver "Calendario de Mis equipos").

- **Cuentas, la versión siguiente** (ver "Cuentas"): una página de política de
  privacidad (Ley 29733: qué se guarda, ahora también el correo, las suscripciones
  de los avisos y los calendarios, para qué, los 7 días
  de copias de D1 y cómo pedir o borrar los datos; conviene que la revise alguien que
  sepa de leyes); poner las claves de Turnstile en el panel; verificar el correo y
  recuperar la contraseña con él (Cloudflare Email Service: plan de pago de Workers,
  US$5 al mes con 3.000 correos, y un dominio propio en Cloudflare, que además daría
  Search Console y la regla de límite por IP); y, si la gente las usa, entrar con
  passkey (huella o cara) como otro tipo de acceso. Las sesiones de 180 días sin uso solo se borran
  cuando alguien intenta usarlas (y cada cuenta guarda 20 como mucho): si se
  acumulan, limpiarlas en el cron.

- **Leer el registro en vivo cuando crezca** (en marcha desde oct 2026, ver
  "El registro en vivo"). Con unos pocos partidos por liga es ruido; con una
  temporada (unos 300 por liga) ya se puede comparar con el backtest de
  `/api/validacion`, y es lo único que puede afinar `RHO_EMPATES` con datos
  propios. Cada ficha guarda con qué versión del modelo se calculó
  (`version_modelo`), pero el registro las suma todas juntas: cuando cambie el
  modelo, separarlas.
- **Champions:** ya junta liga nacional, nivel de liga e historial en la
  Champions, medido con cuatro temporadas (ver "Champions: cómo se predice").
  Cada verano, añadir la temporada que termina a `TEMPORADAS_CL` en
  `afinar_champions.py` y reajustar. Idea sin probar: meter la Champions en la
  validación de la app. (Las copas nacionales no están en el plan free.)
- **Championship y Brasileirão aportan poco** (+2.7% y +3.5%, tabla en
  "Validación"). La web ya lo marca ("fiabilidad baja", ver "Instalable y
  buscadores"); mejorar el modelo en ligas tan igualadas necesitaría otra
  información (ver "xG real").
- **Defensa de partida de un ascendido en las demás ligas:** 1.1 no se
  distingue de 1 en las temporadas de ajuste (-0.0001, -0.8 se) pero ayuda en
  las de prueba (-0.0003, -2.9 se). Con el protocolo no se puede poner; volver
  a mirarlo cuando haya más temporadas (`afinar_liga.py descensos`).
- **xG real** (tier de pago): con solo goles marcados y encajados, el modelo ya
  está en +8.9% de skill en las temporadas de prueba; los modelos de goles
  publicados no suelen pasar mucho de ahí. Para más hace falta otra información
  (tiros, xG, alineaciones), que el plan free no da.

## Pruebas automáticas (GitHub Actions, oct 2026)

- `.github/workflows/pruebas.yml`, en cada PR y cada push a `main`, dos checks:
  - **Paridad Python / Worker**: `node --check` de `worker/*.js`, `public/app.js`, `public/sw.js` y `public/imagen.js`,
    `python test_paridad.py` ("todo igual"), `node pruebas/semana.mjs` (el resumen
    de la semana del registro y los textos de la tarjeta para compartir), `node
    pruebas/sw.mjs` (el service worker: "Sin conexión" sin red, la web con red, y los
    avisos: su texto, adónde llevan y la pestaña que abren) y `node pruebas/push.mjs`
    (el cifrado de los avisos contra el ejemplo de RFC 8291, la firma VAPID, la hora
    de cada aviso y qué servicios se aceptan).
  - **Flask contra el Worker**: `bash pruebas/e2e.sh`. Levanta la API falsa
    (`pruebas/api_falsa.py`, determinista), corre `app.py` + `validacion.py` contra
    ella (`correr_flask.py`), arranca `wrangler dev --test-scheduled` con una D1
    local y lanza el cron hasta que la web y la validación están listas
    (`correr_cron.py`, que mide la CPU del Worker en cada pasada con el perfilador de
    su isolate, por el inspector de `wrangler dev`: `medir_cpu.py` y `cpu_isolate.mjs`;
    tope `MAX_MS`, 60 en local, ver "El ritmo lo marca la CPU"). Exige 0 diferencias
    en `/api/estado`, `/api/ligas` y `/api/validacion` (`comparar.py`) y ninguna
    pasada muerta. Después caduca todas las predicciones a la vez y comprueba que
    la web sigue enseñando números mientras se recalculan (`caducidad.py`), y que
    un calendario que llega incompleto no quita partidos a la primera
    (`calendario.py`, con `/__omitir` de la API falsa). Que `/partido/123` lleva la
    tarjeta de ese partido, con su descripción y su `canonical`, y la CSP de la web
    (`compartir.py`). Que la web es instalable (manifiesto, iconos, service worker,
    CSP) y que `robots.txt` y `sitemap.xml` traen lo que deben (`descubrir.py`). Y
    que las visitas se cuentan bien, que lo inventado no entra y que el tope corta
    (`visitas.py`, con `MAX_VISITAS_DIA=60`). Que el cron baja en sus minutos libres
    la tabla de cada liga y lo que le falta, sin pasarse de CPU, que los goles
    esperados de lo que falta son los de los partidos de la semana entre esos
    equipos, que una tabla que falla no se pide cada minuto y que Flask responde
    `no_disponible` (`tablas.py`, con `/standings` y lo que falta en la API falsa;
    la primera tabla del Brasileirão da 500). Que `/api/estado`, `/api/registro` y
    `/api/validacion` dan 304 sin cuerpo con su ETag, también con el `W/` que pone
    Cloudflare al comprimir, en el Worker y en Flask (`sondeo.py`). Y las cuentas, de crear a borrar,
    con el bloqueo por intentos (también 30 a la vez), la cuenta de la primera
    versión que se pasa a usuario, el correo (crear, entrar, cambiar y quitar),
    Turnstile y los tres topes (`cuentas.py`, con `MAX_CUENTAS_DIA=4`,
    `MAX_INTENTOS_DIA=120`, `MAX_ESCRITURAS_CUENTAS_DIA=600` y el Turnstile de mentira
    de `api_falsa.py`, `/turnstile/v0/siteverify`, por `TURNSTILE_VERIFICAR`). Que los
    avisos de Mis equipos llegan (`avisos.mjs`, con el servicio de avisos de mentira
    de `api_falsa.py`, `/push/<id>`, y `AVISO_ANTES_MIN` de dos semanas para que toquen
    todos los de la semana): cuatro navegadores de mentira se suscriben, cada aviso se
    descifra con la clave de su navegador y lleva su firma VAPID, sus cabeceras y los
    enteros de la web; ninguno se repite ni falta; una estrella nueva trae solo sus
    partidos; el resultado llega una vez; un 410 borra la suscripción; las altas raras
    no entran; la baja pide `auth`; el panel lo cuenta; y la CPU de cada pasada de
    avisos. Que la página de cada equipo trae su fila de la tabla, su ataque y su defensa
    (los del modelo, con su puesto), su forma (la de la caché) y lo que dijo la web de un
    partido suyo con resultado, con ETag, 404 para uno que no existe, su tarjeta en
    `/equipo/86` y todos los equipos en el sitemap (`equipos.py`). Que el calendario de
    Mis equipos es un iCalendar bien formado (CRLF, líneas de 75 octetos, texto escapado)
    con un evento por partido de sus equipos, su hora y su pronóstico, y el resultado al
    terminar; que cambiar los equipos con la misma clave cambia los eventos, que una clave
    borrada vuelve, que lo raro no entra y que el tope de nuevos corta (`ics.py`, con
    `MAX_CALENDARIOS_DIA=5`; va después de la interfaz, que también crea uno). Y la
    interfaz en un navegador de verdad (`interfaz.mjs`,
    Playwright): 13 vistas (semana, día, liga, por claros y por reñidos, búsqueda,
    Mis equipos, el detalle abierto, el de un partido de Mis equipos, la tabla con su
    proyección y la página de un equipo) en 7 anchos de 360 a 1920 px, sin texto que se salga de su caja, sin
    piezas de una fila que se pisen, sin errores de JavaScript, con la tarjeta y la
    invitación de los avisos (y activarlos y quitarlos contra el Worker, con el
    servicio de avisos del navegador de mentira), crear el calendario y sus enlaces, los nombres del detalle enlazando con
    la página de su equipo, y axe-core sin nada en la semana,
    Mis equipos, los dos detalles, la tabla y la página de un equipo, en el móvil y en escritorio. Es lo que en oct
    2026 encontró la fecha bajo el escudo y "Seguir" cortado en el móvil. El job
    instala Chromium (`npx playwright install --with-deps chromium`); sin red para
    las fuentes de Google, `FUENTES=carpeta` (con `fuentes.css`, `mapa.txt` y los
    woff2) las sirve en local. En GitHub, 3-4 minutos; en local, unos 12.
  - Las variables del Worker van con `--var`, que manda sobre `.dev.vars`: el token
    de verdad, si está ahí, no se usa ni sale a ningún sitio.
  - En local, lo mismo: `npm ci`, `pip install -r requirements.txt` y
    `bash pruebas/e2e.sh`.
- `.github/workflows/vigilancia.yml`: cada 3 horas pide `/salud` a la web de
  Cloudflare. Falla si hay error, si no responde o si la última actualización tiene
  más de 90 minutos, y GitHub manda un email. Se prueba a mano en Actions →
  vigilancia → Run workflow, con una URL que no exista. En un repo público, GitHub
  desactiva las tareas programadas tras 60 días sin actividad (avisa antes por
  email; se reactivan en la pestaña Actions).

## Convenciones para seguir trabajando aquí

- Cualquier cambio al modelo de liga pasa por `afinar_liga.py`: se elige mirando
  solo las temporadas de ajuste (hasta 2020/21) y se juzga en las de prueba con
  el test pareado. Elegir y juzgar con los mismos partidos es lo que en sept 2026
  hacía que todo pareciera ruido o señal según el día. Los de la Champions, por
  `afinar_champions.py`.
- El modelo vive dos veces: `app.py`/`validacion.py` (Python, lo que miden las
  herramientas de afinado) y `worker/` (lo que publica Cloudflare). Un cambio
  va en los dos y `python test_paridad.py` tiene que dar "todo igual", y
  `bash pruebas/e2e.sh`, 0 diferencias (GitHub los corre en cada PR).
- Al cambiar el modelo, subir `VERSION_MODELO` (en `app.py` y en
  `worker/config.js`): las fuerzas guardadas se recalculan y la validación de
  Cloudflare, que D1 conserva, se repite sola.
- En el Worker, cada ejecución tiene 10 ms de CPU: nada de recorrer o parsear
  la semana entera en cada pasada sin medirlo antes (ver "Cloudflare: cómo
  funciona").
- Antes de depurar "la web no se actualiza", mirar primero qué versión está
  viva: Cloudflare → Deployments (y sus Logs), o Render → Events.
- Los hilos de fondo (keep-alive, actualizador) solo se activan si existe
  `RENDER_EXTERNAL_URL` — en local no consumen cuota de API al importar `app.py`.
