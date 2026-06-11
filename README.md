# Mundial 2026: fixtures y cuotas unificados

Backend serverless para cruzar los partidos de API-Football v3 con las cuotas
1X2 de The Odds API v4. El frontend y el calendario ICS existentes siguen
funcionando de forma independiente.

La pestaña PRO también incluye KPIs deportivos del torneo y está protegida por
una sesión HTTP-only que se destruye al abandonar el apartado.

Los KPIs de equipos y partidos usan API-Football y degradan al feed Fixtur.es
si el plan configurado no da acceso a la temporada 2026. Los líderes de
jugadores requieren acceso de API-Football a esa temporada.

## Endpoint

`GET /api/unified-matches`

Parámetros opcionales:

- `league`, `season`, `from`, `to`: filtros de API-Football.
- `sportKey`: fuerza una clave, pero se valida contra `/v4/sports`.
- `enrichment`: `none`, `basic` o `full`.

La respuesta incluye:

- IDs de ambos proveedores.
- Features de API-Football.
- Cuotas 1X2 por casa.
- Overround por casa, probabilidades implícitas sin margen y mejor precio.
- Método y confianza de la reconciliación.
- Partidos no reconciliados y metadatos de caché/cuota.

Otros endpoints:

- `GET /api/live-matches`: partidos activos, marcador, estadísticas e incidencias.
- `POST /api/analysis-auth`: registra solicitudes o inicia una sesión PRO.
- `DELETE /api/analysis-auth`: cierra y elimina la sesión PRO.
- `GET /api/tournament-stats`: líderes y KPIs del torneo.
- `GET /api/picks`: picks del modelo y analítica de mercado.

## Variables de entorno

Configura en Vercel, nunca en el navegador:

```dotenv
APISPORTS_KEY=...
ODDS_API_KEY=...
API_FOOTBALL_LEAGUE_ID=1
API_FOOTBALL_SEASON=2026
API_FOOTBALL_SEASON_DATA_ENABLED=false
ODDS_SPORT_TITLE_HINTS=FIFA World Cup,World Cup,soccer_fifa_world_cup
ODDS_REGIONS=eu,uk
ODDS_MARKETS=h2h
FOOTBALL_ENRICHMENT=basic
API_FOOTBALL_LIVE_STATS_TTL_MS=300000
FIREBASE_PROJECT_ID=...
FIREBASE_CLIENT_EMAIL=...
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
FIREBASE_PRO_USERS_COLLECTION=pro_users
ANALYSIS_SESSION_SECRET=...
PRO_ADMIN_PASSWORD=...
```

`API_FOOTBALL_KEY` continúa admitido como alias de `APISPORTS_KEY` para que el
endpoint ICS existente no pierda su configuración.

Con el plan gratuito actual, usa `API_FOOTBALL_SEASON_DATA_ENABLED=false` para
evitar consultas de temporada 2026 que serán rechazadas. Esto no desactiva el
endpoint de partidos en directo.

## Acceso PRO con Firebase

1. Crea un proyecto Firebase y una base Cloud Firestore.
2. En `Configuración del proyecto > Cuentas de servicio`, genera una clave.
3. Añade sus valores como variables de entorno en Vercel.
4. Despliega las reglas cerradas con `firebase deploy --only firestore:rules`.
5. El cliente hace el Bizum y crea una solicitud con teléfono y PIN.
6. Abre `/admin.html`, inicia sesión y aprueba o revoca cada solicitud.

La contraseña se valida únicamente en el servidor mediante
`PRO_ADMIN_PASSWORD`. Usa un valor largo, único y distinto del secreto de
sesión.

También puedes activar una cuenta desde terminal:

```bash
npm run pro:activate -- +34611476090
```

Las solicitudes se guardan en `pro_users` con `status: "pending"`. El panel o
el script las cambia a `status: "active"` y `active: true`. Tras la aprobación,
el navegador registrado abre PRO sin volver a pedir teléfono ni PIN. La
sesión corta se elimina al salir de PRO y se recrea solo si el usuario sigue
aprobado. El PIN se deriva con `scrypt` y nunca se almacena en texto claro.
Tras cinco intentos incorrectos, la cuenta queda bloqueada durante quince
minutos.

## Arquitectura

```text
api/unified-matches.js
lib/
  cache.js
  config.js
  orchestrator.js
  merger.js
  reconciler.js
  providers/
    footballProvider.js
    oddsProvider.js
```

Los proveedores son los únicos módulos que conocen URLs, autenticación y forma
de respuesta externa. El orquestador obtiene el catálogo de deportes, resuelve
el `sport_key`, descarga fixtures/cuotas, reconcilia y fusiona.

## Reconciliación

Un partido se casa por:

1. Pareja local/visitante normalizada.
2. Fecha y hora dentro de una ventana de 90 minutos.
3. Coincidencia exacta, alias o similitud Levenshtein como último recurso.
4. Orientación directa o invertida, porque el Mundial se juega en sede neutral.

Los alias están en `DEFAULT_ALIAS_GROUPS` dentro de
`lib/reconciler.js`. Para añadir uno, incorpora todas sus variantes al mismo
grupo. Los no reconciliados se registran y se devuelven en `unmatched`.
La respuesta indica `orientacion: "same" | "swapped"`. Se puede desactivar el
segundo caso con `MATCH_ALLOW_SWAPPED=false`.

El pipeline Python dispone de la misma estrategia en `ml/reconciler.py`, sin
dependencias externas.

## Caché y límites

- API-Football free: 100 peticiones al día; las temporadas disponibles están
  limitadas por el plan.
- The Odds API Starter: 500 créditos al mes, con reinicio el día 1.
- API-Football fixtures: 6 horas; detalles: 12 horas.
- Catálogo de The Odds API: 24 horas.
- Cuotas: 1 hora.
- Si una actualización falla o devuelve límite, se usa el último dato stale
  disponible en la misma instancia serverless.

The Odds API no cobra créditos por `/v4/sports`. La consulta configurada con
`regions=eu,uk` y `markets=h2h` cuesta normalmente 2 créditos: una región por
un mercado. Las cabeceras de cuota de ambos proveedores se exponen en
`sources` y se escriben en los logs de Vercel.

El modo `basic` solo añade clasificación. `full` puede realizar hasta cuatro
peticiones extra por partido (predicción, estadísticas, alineaciones y
lesiones), limitado por `FOOTBALL_ENRICH_LIMIT`.

La caché en memoria es deliberadamente best-effort en Vercel. Para conservar
stale entre arranques en frío, sustituye `CacheStore` por Vercel KV, Redis o
otro almacén persistente manteniendo su interfaz.

## Desarrollo y pruebas

```bash
node --test test/*.test.js
python3 -m unittest discover -s ml -p 'test_*.py' -v
vercel dev
```

Prueba local:

```bash
curl "http://localhost:3000/api/unified-matches?enrichment=none"
```

Documentación oficial:

- [API-Football v3](https://www.api-football.com/documentation-v3)
- [The Odds API v4](https://the-odds-api.com/liveapi/guides/v4/)
