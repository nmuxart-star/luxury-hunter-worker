# Luxury Hunter v1.4.3

## Novedad: coste importado a España

Cada anuncio muestra ahora dos precios separados:

- **Precio del producto**: conversión directa del anuncio a EUR con el FX de Luxury Hunter.
- **Precio final importado**: producto + envío doméstico + agente/proxy + envío internacional + arancel + IVA de importación + gestión aduanera/courier + autenticación + otros costes configurados.

Los costes se configuran por fuente en **Configuración → Coste de importación a España**. El cálculo es determinista y se hace en Luxury Hunter, no se deja a Gemini. Los valores iniciales son estimaciones editables. El arancel puede variar por clasificación/material/origen y debe verificarse antes de una compra real.

# Luxury Hunter v1.4 — Technical Execution Inspector

This update adds a technical inspector so every task/run can be audited from the UI.

## New in v1.4

- `Ver código` on each configured task: previews the exact generated marketplace queries, effective limits, filters, connector calls, Gemini model/instruction/criteria, scheduler and email thresholds.
- `Ver ejecución` on an active or historical run: shows the snapshot of the task that actually ran, not just the current edited task.
- Live source state while a run is executing. The inspector refreshes automatically every 2.5 seconds.
- Bunjang displays the exact CLI commands used.
- Xianyu displays the exact temporary-task HTTP payload and request sequence used by Luxury Hunter.
- Japan/Buyee displays the exact search URLs requested.
- Gemini displays the central instruction, selected model, image-analysis flag, and the task-specific AI criteria.
- Full technical execution manifest is available as JSON and can be copied.
- Secrets such as `GEMINI_API_KEY` and SMTP passwords are never exposed by the inspector.

## Update existing install

Stop Luxury Hunter, copy the update over `~/luxury-hunter`, then run `npm install` and `npm start`. Existing `.env`, database, tasks and results remain untouched.

## v1.4.1 fixes

- Fixes Xianyu ingestion for the current nested Chinese result schema (`商品信息`, `卖家信息`).
- Filters Xianyu result records to the temporary task name so historical records from the same keyword do not contaminate a live search.
- Adds per-query rejection counters for Xianyu (`staleTask`, `missingCoreFields`, `invalidPrice`, `belowMin`, `aboveMax`).
- Buyee zero-results now includes a warning when no product cards were actually extracted; a zero extraction is no longer treated as proof of zero inventory.
- Adds `npm run browsers:install` for the Chromium binary required by Bunjang/Playwright after dependency updates.


## v1.4.2 — Spanish rejection reasons

- Gemini now returns `decision_reasons_es`: 1–4 concise reasons in Spanish for every decision.
- REJECT results show a visible “Por qué se ha rechazado” box with bullet points.
- Existing REJECT analyses are backfilled on startup using their structured fields, so the section appears without having to re-run every old listing.
- Reanalyzing an existing listing asks Gemini for more specific Spanish reasons and replaces the fallback reasons.

## GitHub Actions mode (v1.5)

- `npm run cloud:export` exports task/economics configuration to `cloud/config.json`.
- `.github/workflows/luxury-hunter.yml` runs every 3 hours (minute 17) and can also be started manually.
- The SQLite state is persisted between ephemeral runners using a short-retention workflow artifact.
- `npm run cloud:encrypt-xianyu` encrypts the Xianyu login state before it is committed to a private repository.

## v1.6 — Velocidad y fiabilidad

- **Avisos inmediatos**: cada STRONG BUY / BUY verificado se avisa al momento por email (y por Telegram si existen los secretos `TELEGRAM_BOT_TOKEN` y `TELEGRAM_CHAT_ID`), sin esperar al resumen de 3 h. Nunca se repite el aviso de un mismo anuncio. Variables: `INSTANT_ALERT_DECISIONS` (por defecto `STRONG BUY,BUY`), `INSTANT_ALERT_MIN_PROFIT_EUR`, `INSTANT_ALERTS=0` para desactivar.
- **Alertas de salud**: si Gemini se queda sin créditos/cuota, si todos los análisis fallan o si una fuente deja de responder, llega un email "⚠️ Luxury Hunter necesita atención" (Gemini: como mucho cada 6 h; fuentes: cada 24 h). El resumen de 3 h marca en rojo las ejecuciones fallidas.
- **Frescura**: los anuncios sin fecha de publicación (Komehyo, Rakuma...) ya no se descartan si Luxury Hunter los ve por primera vez dentro de la ventana.
- **IA con OpenAI**: si existe `OPENAI_API_KEY` se usa OpenAI (Responses API); si no, Gemini (`AI_PROVIDER=openai|gemini` para forzar). Análisis completo con `OPENAI_MODEL` (por defecto `gpt-6.1-sol`) y triaje con `OPENAI_TRIAGE_MODEL` (por defecto `gpt-6-luna`). La búsqueda de mercado usa la búsqueda web de OpenAI limitada a las webs de reventa de confianza. Google Lens (SerpApi) y Cloud Vision no cambian.
- **Coste mínimo**: primero un *triaje* barato (una sola llamada de texto por tarea con hasta 40 anuncios) puntúa cada anuncio; solo los que superan `AI_TRIAGE_MIN_SCORE` (60) pasan al análisis completo, como mucho `AI_MAX_ITEMS_PER_TASK_RUN` (5) por ejecución, ordenados por puntuación y precio frente a la mediana de la tarea. Lo descartado en el triaje no se vuelve a pagar. `AI_TRIAGE=0` lo desactiva.
- **Informe diario**: el resumen se envía una vez al día, en la primera ejecución a partir de `DIGEST_DAILY_HOUR` (9:00, Europe/Madrid). `DIGEST_SCHEDULE=interval` vuelve al modo de cada 3 h. Los avisos inmediatos de STRONG BUY/BUY siguen llegando al momento.
- **Pre-filtro**: títulos con términos de réplica o "solo accesorio" se descartan sin llamar a Gemini.
- **Nube más rápida**: `TASK_CONCURRENCY` (por defecto 3) ejecuta varias tareas a la vez. `LOOP_MINUTES` repite ciclos dentro de una misma ejecución (cada `CYCLE_MIN_MINUTES`, por defecto 20) y `SELF_CHAIN=true` encadena la siguiente ejecución al terminar. Se configuran como *variables* del repositorio en GitHub.
- **Sesión de Xianyu que se renueva sola**: `npm run xianyu:login` abre Chromium para iniciar sesión una vez en Goofish y cifra la sesión en `cloud/xianyu-state.enc`. En cada ejecución en la nube, `scripts/xianyu-keepalive.mjs` visita Goofish con la sesión, guarda las cookies renovadas (cifradas) en el estado persistente y la siguiente ejecución usa la más reciente. Si caduca o Goofish pide verificación anti-bot, llega una alerta "⚠️ Luxury Hunter necesita atención" con el comando para renovarla.
