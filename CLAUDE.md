# pronosticos-bot — contexto de proyecto

Resume el estado, las decisiones ya tomadas y por qué, para no repetir
investigación ya hecha. Claude Code lee este archivo automáticamente al abrir el
proyecto.

## Qué es

Web que predice resultados de fútbol (1/X/2, doble oportunidad y mercados de
goles: más/menos, ambos marcan, porterías a cero y marcadores) con un modelo
Poisson de fuerzas ataque/defensa. Corre en dos sitios con la misma lógica:

- **Cloudflare Workers** (`worker/`, oct 2026): adonde se muda. JavaScript, base
  D1 y un cron por minuto. Ver "Cloudflare: cómo funciona".
- **Render** (`app.py`, Flask): la versión de siempre. Sigue siendo la
  referencia del modelo (la usan `backtest.py`, `afinar*.py` y `validacion.py`
  offline) y sigue desplegándose desde `main` hasta que se apague.

- Repo: `pronosticos-bot`
- Carpeta local: `C:\Users\Alvaro\Desktop\webapp`
- URL en Render: https://pronosticos-bot.onrender.com
- URL en Cloudflare: `https://pronosticos-bot.<subdominio>.workers.dev` (el
  subdominio es el de la cuenta: Workers & Pages → el Worker → Settings → Domains)
- Ficheros clave: `app.py`, `public/index.html`, `validacion.py`, `worker/`,
  `wrangler.jsonc`, `test_paridad.py`, `backtest.py`, `afinar.py`,
  `afinar_goles.py`, `diagnostico.py`

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
`RENDER_EXTERNAL_URL`), para que `backtest.py`/`afinar.py` puedan importar
`app.py` sin gastar cuota de la API.

**Coste:** el plan free da ~750h de instancia/mes por workspace (el mes tiene
~730h). Con el keep-alive el servicio va 24/7 y las consume casi todas. Cabe si
`pronosticos-bot` es el único servicio del workspace — un segundo servicio free
suspendería a ambos.

**La interfaz no usa Jinja2.** `public/index.html` (antes `templates/`) no tiene
ni una etiqueta `{{ }}`: Flask la sirve como plantilla (`template_folder=
"public"`) y Cloudflare como archivo estático, con sus cabeceras en
`public/_headers`. Es un shell estático con el CSS y el JS en línea que se pinta entero en
el cliente sondeando `/api/estado` (cada 4s mientras hay cálculo en curso, cada
30s el resto del tiempo). No hay `static/`, ni build, ni dependencias de JS; de
fuera solo llegan las fuentes Saira y Figtree (Google Fonts, con fallback del
sistema) y los escudos (URLs de football-data.org). Al tocar la web se trabaja
sobre las funciones `pintar*` y `html*` del `<script>`, no sobre bucles de
plantilla. Ojo al probar en local: fuera del modo debug, Flask guarda la
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
  1X2 / +2.5 / Ambos). Centro: tira de días + tabla. Derecha: Los más claros
  (los 8 favoritos más fuertes de la semana; un clic abre el partido) y
  Confianza del favorito (histograma). Abajo, barra de estado. Entre 880 y
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
  reparto. Al abrir un partido sale el detalle, con los mercados de goles
  (histograma de goles totales, más/menos 1.5-3.5, ambos marcan, porterías a
  cero, tres marcadores) y una nota con lo que mide su liga. La columna Liga
  solo aparece en las vistas que mezclan ligas.
- Los % de 1/X/2 se redondean por resto mayor para que sumen 100, y la doble
  oportunidad se suma de esos mismos enteros: lo que se lee, cuadra. Igual el
  histograma de goles; "menos de" y "ambos marcan: no" se restan del número ya
  redondeado. La casilla de los próximos y la de los más claros usan el mismo
  entero que la tabla (`pctFavorito`).
- Rutas por hash: `#/`, `#/semana`, `#/dia/2026-10-10`, `#/liga/PD`,
  `#/liga/PD/2026-10-10`. `#/` es toda la semana en escritorio y el primer día
  en móvil.
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
`/validar?token=...[&temporada=N]` (lanza el backtest) y `/api/validacion` (su
resultado).

**Efecto secundario de cada deploy:** el disco de Render free es efímero, cada
deploy borra `cache.json` y `data.json`. La web dice "Todavía no hay datos"
hasta la primera actualización, que el planificador lanza sola unos 20 s
después de arrancar y que paga el coste completo de API (~2 peticiones/equipo)
porque la caché está vacía; las pasadas siguientes continúan cada 5 min
mientras queden partidos pendientes. Con 9 ligas y la Champions una semana
normal son unas 220 peticiones (la Champions suma unas 25: su calendario, su
media y la liga de los equipos que no salen en ningún calendario de liga): 5 o
6 pasadas de 40, y la ventana tarda del orden de 55 min en llenarse entera (los
partidos más cercanos salen primero).
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
esperados, 1X2, mercados, Champions, validación entera, redondeo) y da 0
diferencias en 170.000 valores. Y de punta a punta, contra una API falsa
determinista (`/api/estado` con 166 partidos y 16 de Champions, `/api/ligas`,
`/api/validacion` de las 9 ligas): 0 diferencias entre Flask y el Worker,
también con 1 de cada 5 peticiones respondida con 429.

Ficheros: `config.js` (constantes, las mismas de `app.py`), `modelo.js` (el
modelo y un `redondear` que imita a `round()` de Python, empates al par
incluidos), `actualizacion.js` (la pasada), `validacion.js`, `planificador.js`
(el cron), `almacen.js` (D1), `api.js` (football-data con su presupuesto),
`tiempo.js` (hora de Lima) e `index.js` (rutas).

**El ritmo lo marca la CPU.** El plan gratis da 10 ms por ejecución y leer el
JSON de la API cuesta ~7 ms por MB, así que en vez de una pasada de 40
peticiones cada 5 min hay una cada minuto con: como mucho 6 peticiones
(`PRESUPUESTO_REQUESTS`), separadas 6.5 s también entre pasadas (la hora de la
última va en D1), 350 KB de JSON (`MAX_BYTES_PASADA`), una sola respuesta
grande (una temporada entera, ~400 KB) y al principio de la pasada, y 40
partidos calculados (`MAX_CALCULOS_PASADA`). Lo que no cabe queda pendiente y el
estado sigue en `actualizando` (no hay `parcial`: el siguiente minuto continúa).
Medido dentro de `workerd` (el runtime de Cloudflare, en local, D1 incluido):
3 a 9 ms por pasada, ~5 ms lo normal. Llenar la semana entera: ~40 pasadas.

**Para que quepa, casi no se lee JSON.** El calendario va en la tabla
`partidos`, cada partido con su ficha (nombres, hora, escudos) ya en JSON; las
predicciones, en `predicciones`, también en JSON. Lo que lee la web sale de un
solo JOIN y se monta pegando textos. La caché de la API (`cache`, por
secciones como `cache.json`) se lee fila a fila solo cuando se usa.

**Tablas de D1** (se crean solas si faltan, `ESQUEMA` en `almacen.js`):
`cache`, `partidos`, `predicciones` (la última publicada de cada partido; no se
borra al empezar el partido: es el registro de lo que dijo la web),
`documentos` (`estado` que sirve `/api/estado`, `resumen`, `validacion`,
pedidos, temporadas terminadas compactas) y `candado` (que dos pasadas no se
pisen, hora de la última petición, pasadas muertas).

**Si una pasada muere** (lo más probable, por CPU) deja el candado puesto; la
siguiente lo nota y hace la mitad (presupuesto, bytes y cálculos), hasta un
octavo, y recupera el ritmo de uno en uno cuando vuelven a terminar bien. El
candado caduca a los 5 min.

**La validación va por pasos de un minuto**, solo con la web `listo`: bajar
una temporada, bajar la otra, y recorrer la liga de 25 en 25 partidos
(`PARTIDOS_POR_PASO`) guardando por dónde iba. Unas 2 h y media la primera vez;
las temporadas quedan en D1. Como D1 no se borra, se repite sola cuando termina
una temporada nueva.

**Cambios respecto a `app.py`** (ninguno toca el modelo):
- un 429 de la API no se calcula a ciegas: el partido espera al minuto
  siguiente (`app.py` lo publicaba solo con la media de liga, 24 h);
- una petición que falla no se repite partido tras partido en la misma pasada;
- si el calendario cambia la hora o el nombre de un partido ya calculado, la
  ficha se corrige sin recalcular (`app.py` enseñaba la hora vieja hasta 24 h);
- los intentos de la validación se arrastran (en `validacion.py` se perdían y
  el tope de 3 no frenaba nada);
- `/actualizar?forzar=1` y `/validar` dejan un pedido en D1 que el cron recoge
  en menos de un minuto: una petición web no puede durar lo que una pasada.

**En local:** `npm install`, copiar `.dev.vars.example` a `.dev.vars`, `npm run
dev` y lanzar el cron a mano con
`curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=*+*+*+*+*"`. Con
`API_BASE` en `.dev.vars` se apunta a una API falsa y con
`PAUSA_ENTRE_REQUESTS=0` no espera entre peticiones.

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

## Champions: cómo se predice (oct 2026)

El modelo de liga no sirve para la Champions: mide a cada equipo con sus
partidos en la misma competición, y en la Champions son 4 en casa y 4 fuera
contra rivales de niveles muy distintos; su "media de liga" mezcla al Bayern con
el campeón de Kazajistán. Por eso la Champions va en `TORNEOS` y no en `LIGAS`,
con su propio cálculo:

- Cada equipo se mide en SU liga nacional (`fuerzas_champions`): los mismos
  `obtener_stats_equipo` y `obtener_promedio_liga` que sus partidos de liga, así
  que casi siempre salen de la caché. Su ataque y su defensa relativos a la
  media de su liga se elevan a `EXPONENTE_FUERZA_CHAMPIONS` (0.5): los grandes
  arrasan en su liga y su fuerza nacional tomada tal cual exagera.
- Se ajusta por el nivel de su liga (`FACTOR_LIGA`): PL 1.33, PD 1.16, FL1 1.13,
  SA 1.10, BL1 1.03, PPL 0.93, DED 0.91, y 0.72 para un equipo de una liga fuera
  del plan (`FACTOR_OTRA_LIGA`), que cuenta como un equipo medio de ese nivel.
- Goles esperados (`calcular_xg_champions`): media de la Champions ×
  `ESCALA_CHAMPIONS` × ataque propio × defensa rival × nivel propio / nivel
  rival. Luego, el mismo `calcular_poisson` y `mercados_de_goles` que en liga.
- De qué liga es cada equipo (`liga_domestica`): primero, gratis, en los
  calendarios de liga ya descargados; si no sale, una petición a `/teams/{id}`
  (`runningCompetitions`). Se guarda 30 días en la caché (`liga_equipo`).
- Los cruces de eliminatoria aún sin decidir (equipo sin id) no se pintan.

Medido con `afinar_champions.py` sobre la Champions 2024/25 (188 partidos con
resultado, datos de openfootball; 10 de los 36 equipos venían de ligas fuera del
plan), con validación cruzada de 5 bloques. Skill del 1X2 frente a "equipo
medio":

```
solo liga nacional                 +3.6%  (-1.1 se)
solo nivel de liga                 +6.6%  (-1.7 se)
liga nacional + nivel              +5.9%  (-1.3 se)
liga nacional atenuada + nivel     +7.1%  (-1.7 se)   <- el de la app
```

El exponente sale entre 0.44 y 0.59 en los cinco bloques. Es UNA temporada: ninguna
mejora llega a 2 errores estándar, así que es una base, no una conclusión. La
fórmula de producción reproduce la del estudio (Brier 0.5367 frente a 0.5369 en
la muestra). La Champions no entra en la validación de la app (`validacion.py`
recorre solo `LIGAS`): la web explica el cálculo en el detalle de cada partido.

## Validación

Backtest sobre LaLiga 2023+2024 (720 partidos evaluados):

```
Modelo corregido      Brier 0.6013   LogLoss 1.0072   Acierto 49.0%
Base "equipo medio"   Brier 0.6499   LogLoss 1.0749   Acierto 44.4%
```

Skill score del 7.5% sobre la base. Para el mismo backtest de dos temporadas que
LaLiga en otra liga: `LIGA_BACKTEST=PL python backtest.py 2023 2024`, etc.

**Las nueve ligas, medidas igual (oct 2026).** Resultados de openfootball (ver
"Más temporadas de datos"), recorridos con `validacion.validar_liga`: ancla e
historial en la temporada anterior, y cada partido predicho solo con lo de antes.
Skill del 1X2 frente a la base "equipo medio", con el test pareado de Brier en
errores estándar (se), y la desviación típica de puntos por partido entre
equipos, que mide lo igualada que está la liga (más baja = más igualada):

```
Liga            2023/24              2024/25              Igualdad
LaLiga           +7.9  (-5.2 se)      +6.9  (-3.7 se)     0.52 / 0.45
Premier         +10.1  (-5.1 se)      +7.9  (-4.0 se)     0.52 / 0.48
Ligue 1          +2.3  (-1.4 se)      +8.0  (-3.7 se)     0.40 / 0.46
Bundesliga       +8.6  (-4.1 se)      +3.1  (-1.4 se)     0.54 / 0.44
Serie A          +7.4  (-4.1 se)      +7.4  (-4.1 se)     0.48 / 0.49
Eredivisie      +10.7  (-4.5 se)      +8.2  (-3.6 se)     0.58 / 0.49
Primeira Liga    +9.4  (-4.5 se)     +11.2  (-5.5 se)     0.56 / 0.52
Championship     -0.2  (+0.1 se)      +1.8  (-1.4 se)     0.35 / 0.33
Brasileirão      2025, 2ª mitad (190 partidos): +1.7 (-0.6 se)    0.38
```

- **La Championship no mejora a la base.** No es por los equipos que cambian
  cada año: en los 1.042 partidos en que los dos equipos tenían historial en la
  liga, el skill es +0.7% (−0.7 se). Es la liga más igualada de las nueve, y el
  skill va en la misma dirección que la igualdad: las más desiguales
  (Eredivisie, Primeira) son las más previsibles.
- **El Brasileirão no se puede medir bien con estos datos:** openfootball solo
  tiene 2025 (falta 2024), así que se ancla en la primera mitad y se puntúa la
  segunda. Es la segunda liga más igualada; lo esperable es un skill bajo,
  como en la Championship. La validación de la app (`/api/validacion`) lo mide
  con la temporada completa y la anterior de football-data.
- En la Championship se quitan los playoffs de ascenso: no son liga, y
  openfootball los escribe de tres formas distintas según la temporada (solo
  vale `round` con "Matchday").

`validacion.py` corre ese mismo backtest walk-forward **dentro de la app**
(`/validar?token=...`, resultado en `/api/validacion`): importa
`calcular_xg_partido`, `calcular_poisson` y `mercados_de_goles` de `app` en vez de
reimplementarlos, para no validar una copia desincronizada del modelo desplegado.
Además del 1X2 mide más de 2.5 y ambos marcan (`mercados` en el resultado) contra
la misma base "equipo medio". Cuesta 2
peticiones por liga y solo la primera vez — las temporadas terminadas no cambian,
así que quedan cacheadas en disco.

## Mercados de goles — `ENCOGER_GOLES = 0.3` (oct 2026)

Más/menos, ambos marcan, porterías a cero y marcadores salen de
`mercados_de_goles`, no de `calcular_poisson`. El 1X2 no cambió ni en el código.
La función usa los goles esperados acercados a la media de la liga, en escala
logarítmica: `media · (xg/media)^0.3`.

Por qué: con los goles esperados tal cual, el modelo exagera las diferencias de
goles entre partidos. Donde daba 27% de "más de 2.5" pasó un 42%, y donde daba
74% pasó un 62%. El orden lo acierta, la magnitud no. Así perdía contra la base
"equipo medio": skill −1.3% en más de 2.5 y −1.0% en ambos marcan.

Medido con `afinar_goles.py` sobre 3.484 partidos reales (LaLiga, Premier,
Bundesliga, Serie A y Ligue 1; temporadas 2023 y 2024, ancla 2022):

- Elegido con 2023 sale α=0.2. Juzgado con 2024 gana a la base en más de 2.5
  (−3.7 errores estándar) y en ambos marcan (−2.3 se).
- Elegido con 2024 sale α=0.5. Juzgado con 2023 empata con la base.
- Cualquier α entre 0.2 y 0.4 gana a la base en las dos temporadas. α=1 (sin
  encoger) pierde en 2023 por +2.4 se. 0.3 es el centro de esa franja, no un
  óptimo demostrado.

Aun con 0.3 la ganancia es pequeña: skill de +0.2% a +1.2%, frente al ~7.5% del
1X2. En Eredivisie, Primeira, Championship y Brasileirão (medidas después, sin
reajustar α) sale entre −0.6% y +1.8%. Con solo goles marcados y encajados, el total de goles de un partido apenas
se predice mejor que con la media de su liga. La web lo dice en el detalle de cada
partido y en el panel Fiabilidad. No vender estos números como el 1X2.

## Afinado del modelo — dos decisiones cerradas (sept 2026)

Datos disponibles: solo LaLiga 2023+2024 (2021/2022 dan 403 en plan free).

### 1. Hiperparámetros (`PSEUDO_PARTIDOS=6`, `rho=0`): se quedan como están

No porque estén demostrados óptimos, sino porque con 760 partidos no se puede
distinguir ninguna configuración de otra:

- Train 2023 → gana `pseudo=3, rho=-0.2`; validado en 2024, pierde.
- Train 2024 → gana `pseudo=6, rho=0` (la config actual).
- Mínimo global de LogLoss sobre las dos temporadas juntas: `(pseudo=4,
  rho=-0.1)` = 1.0052 vs 1.0073 actual — diferencia 0.0021, y el test pareado da
  `+0.0021 ± 0.0029`: no significativo. Ídem para las otras comparaciones
  probadas.
- Matiz para el futuro: en las 7 configuraciones de la tabla, `rho` entre -0.05 y
  -0.15 sale sistemáticamente algo mejor que `rho=0`, coherente con el sesgo de
  empates de la calibración (25.3% predicho vs 27.6% real). Pero son los mismos
  760 partidos reutilizados 7 veces, no pruebas independientes. Si algún día hay
  más temporadas, esta es la primera hipótesis a reprobar.

### 2. Prior de equipos ascendidos: medido, real, y aun así descartado

Ascendidos a 2024 (Espanyol, Leganés, Valladolid), 57 partidos local + 57
visitante: ataque local 0.688 vs 1.055 del resto, ataque visitante 0.722 vs
1.049, defensa visitante 1.425 vs 0.925 (3 de 4 efectos superan 2 errores
estándar — el fenómeno es real, el modelo no lo captura).

No se implementa. Razones: la magnitud solo se puede medir en 2024, que es
también el único set de validación disponible — ajustar y evaluar sobre los
mismos datos es circular (exactamente lo que el punto 1 mostró que no sirve). Son
3 equipos de una sola temporada; el 0.688 concreto casi seguro no se repite. La
web ya avisa "⚠ Pocos partidos previos" en predicciones con poca muestra, así que
el usuario tiene la señal aunque el número no la tenga.

Si se retoma: no hace falta lista de ascendidos. Un equipo con muy pocos partidos
en la ventana de 400 días es un recién llegado — basta con cambiar el objetivo del
encogimiento (`_encoger`) para esos equipos en vez de añadir un campo nuevo. El
efecto se diluye solo conforme acumulan partidos.

## Herramientas de afinado

- `afinar.py` compara configuraciones con un test pareado de LogLoss y su error
  estándar: dice si una diferencia es real, no solo cuál gana.
- `afinar.py` avisa ("AVISO: no se pudo cargar …") si una temporada no carga.
  `backtest.py` solo imprime el error HTTP de esa temporada, y su resumen sigue
  listando todas las temporadas pedidas: si una falla, mira cuántos partidos
  cargó antes de fiarte del resultado.
- `backtest.py` captura `requests.RequestException`: sin conexión, esa temporada
  vuelve vacía en vez de tumbar el script.
- `afinar_goles.py` mide `ENCOGER_GOLES` con el mismo método de train/test y test
  pareado. No necesita token: baja resultados de openfootball (ver "Más
  temporadas de datos" abajo) y los cachea en `openfootball_cache/`.
- `afinar_champions.py` estima `FACTOR_LIGA`, `FACTOR_OTRA_LIGA`,
  `EXPONENTE_FUERZA_CHAMPIONS` y `ESCALA_CHAMPIONS` con la Champions 2024/25 y
  las ligas nacionales de openfootball, y compara modelos con validación
  cruzada. Tampoco necesita token.

## Cloudflare: cómo se despliega

Workers Builds, conectado al repo de GitHub desde el panel (Workers & Pages →
Create → Import a repository): **un push a `main` despliega solo**, con
`npx wrangler deploy` (sin comando de build). El Worker del panel tiene que
llamarse `pronosticos-bot`, como `name` en `wrangler.jsonc`, o el build falla.
La base D1 va enlazada por su id en `wrangler.jsonc`; el cron, también ahí.

Secretos, en el panel (Settings → Variables and Secrets, tipo Secret):
`FOOTBALL_DATA_TOKEN` y `UPDATE_SECRET`, los mismos valores que en Render →
Environment. Sin el token, la web lo dice ("Falta el secreto
FOOTBALL_DATA_TOKEN...") y en cuanto se pone, el siguiente minuto arranca.

Para ver qué pasa: Workers & Pages → `pronosticos-bot` → Deployments (qué
versión está viva) y Logs (cada pasada escribe una línea con lo que hizo:
`{"tarea":"actualizar","estado":...,"peticiones":6,"kb":180,"muertes":0}`).
`muertes` mayor que 0 quiere decir que alguna pasada se pasó de CPU.

**Apagar Render** cuando Cloudflare esté lleno: poner `REDIRIGIR_A=https://...
workers.dev` en Render → Environment. Desde entonces Render manda cada
petición a la misma ruta de Cloudflare (302) y su planificador no arranca. Hace
falta: los dos usan el mismo token, y juntos se pasarían de 10 peticiones por
minuto.

## Render: cómo se despliega

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

- **Champions con más datos:** los niveles de liga salen de una sola temporada
  (openfootball solo tiene la 2024/25). Con la 2025/26 o más, reajustar con
  `afinar_champions.py`. Mejoras pensadas: contar también los partidos de
  Champions y copas de cada equipo (no solo su liga), medir a los equipos de
  ligas fuera del plan con sus propios partidos, y meter la Champions en la
  validación de la app.

- **Championship (y seguramente Brasileirão) casi no aportan:** sus
  pronósticos valen lo que la media de la liga (tabla en "Validación"). La web
  lo enseña en Fiabilidad, pero la tabla los pinta igual que los demás.
  Opciones: quitarlas, marcarlas en la tabla, o probar un encogimiento propio
  para ligas igualadas con el método de `afinar_goles.py`.
- **Registro de predicciones en vivo:** nadie mide si los pronósticos publicados
  aciertan. Con Cloudflare ya no lo bloquea la persistencia: la tabla
  `predicciones` de D1 guarda la última predicción publicada de cada partido y
  no la borra. Falta bajar los resultados (los partidos `FINISHED` de cada
  competición, una petición por liga) y medirlos. Cerraría el círculo y
  acumularía datos propios que el plan free no vende: es lo único que puede
  sacar el `rho` del empate estadístico descrito arriba. En Render sigue igual
  (disco efímero).
- **`test_migracion.py` está desincronizado:** prueba `app._parsear_standings` y
  `app.USAR_PRIOR_PREVIA`, que no existen en `app.py`. Es de una migración a
  `/standings` que no está en el código actual, así que el archivo revienta con
  `AttributeError` si se corre. O se completa la migración o se borra el test;
  tal como está no prueba nada.
- **Más temporadas de datos: ya hay fuente gratis.** El plan free de
  football-data.org no da temporadas viejas, pero `openfootball/football.json` en
  GitHub sí: resultados de LaLiga, Premier, Bundesliga, Serie A y Ligue 1,
  comprobados de 2022/23 a 2024/25 (oct 2026), sin token. Algunas vienen
  incompletas: LaLiga y Serie A 2024/25 traen 370 de 380 partidos. Con ellos el
  backtest de LaLiga 2023+2024 da skill +7.9% y +6.9%, en línea con el 7.5% de
  arriba. Es lo que hace falta para reabrir el "empate estadístico" de
  `PSEUDO_PARTIDOS`/`rho` y el prior de ascendidos, con 5 ligas en vez de una.
  No se ha hecho todavía.
- **xG real** (tier de pago): el techo de un modelo basado solo en goles
  marcados/encajados ronda un skill score del 9-10%; el actual ya está en 7.5%.

## Convenciones para seguir trabajando aquí

- No reabrir el debate de `PSEUDO_PARTIDOS`/`rho` ni el prior de ascendidos sin
  datos nuevos (más temporadas) — ya se demostró que con los datos de LaLiga
  cualquier conclusión es ruido. Ver "Afinado del modelo" arriba. Los datos de
  openfootball son justo esos datos nuevos: reabrirlo con ellos sí tiene sentido.
- Cualquier cambio al modelo debe pasar por `backtest.py` sobre LaLiga 2023+2024
  como mínimo, y usar el test pareado de `afinar.py` para saber si una diferencia
  es real o ruido antes de adoptarla.
- El modelo vive dos veces: `app.py`/`validacion.py` (Python, lo que miden las
  herramientas de afinado) y `worker/` (lo que publica Cloudflare). Un cambio
  va en los dos y `python test_paridad.py` tiene que dar "todo igual".
- En el Worker, cada ejecución tiene 10 ms de CPU: nada de recorrer o parsear
  la semana entera en cada pasada sin medirlo antes (ver "Cloudflare: cómo
  funciona").
- Antes de depurar "la web no se actualiza", mirar primero qué versión está
  viva: Cloudflare → Deployments (y sus Logs), o Render → Events.
- Los hilos de fondo (keep-alive, actualizador) solo se activan si existe
  `RENDER_EXTERNAL_URL` — en local no consumen cuota de API al importar `app.py`.
