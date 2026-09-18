# Europa Press RSS + archivo histórico (no oficial)

Convierte `https://www.europapress.es/noticias/` en un feed RSS y, además, conserva **todas las noticias capturadas** en un archivo histórico diario.

## Qué hace

Cada 5 minutos, GitHub Actions:

1. Pide `/noticias/` sin caché.
2. Recorre automáticamente `/noticias/p2/`, `/p3/`, `/p4/`... hasta que deja de encontrar una página con noticias nuevas.
3. Deduplica por URL.
4. Reconstruye correctamente la fecha al cruzar medianoche.
5. Añade las noticias a archivos diarios en `archive/YYYY-MM-DD.json`.
6. Genera `feed.xml` con las 2.000 noticias más recientes.
7. Genera `latest.json` con las 5.000 más recientes, más cómodo para automatizaciones.
8. Genera `state.json` con la noticia más nueva, la más antigua del recorrido y estadísticas de la captura.

El histórico de `archive/` **no tiene límite temporal**: una noticia no se borra porque desaparezca de las páginas actuales de Europa Press.

## Por qué hay RSS + JSON + archivo

Un RSS infinito acabaría siendo enorme y poco práctico. Por eso:

- `feed.xml`: consumo RSS normal y procesamiento reciente.
- `latest.json`: procesamiento automático reciente y checkpoints.
- `archive/YYYY-MM-DD.json`: histórico completo y permanente.
- `state.json`: control rápido de que el rastreo funciona.

Para TTiTTulares, lo normal será procesar `latest.json` desde el último `guid`/hora conocida. Si alguna vez hubiera un salto largo entre ejecuciones, se puede recuperar exactamente el periodo perdido desde `archive/`.

## Instalación en GitHub

1. Crea un repositorio, por ejemplo `europapress-rss`.
2. Sube todos los archivos de este ZIP, incluida la carpeta `.github`.
3. En **Settings → Actions → General**, permite que GitHub Actions tenga permisos de escritura si tu configuración lo exige.
4. Ejecuta manualmente una vez **Actions → Actualizar RSS Europa Press → Run workflow**.
5. Comprueba que aparecen `feed.xml`, `latest.json`, `state.json` y la carpeta `archive/`.

## URLs útiles

Si el repositorio es público, puedes consumir directamente los ficheros RAW:

`https://raw.githubusercontent.com/TU_USUARIO/europapress-rss/main/feed.xml`

`https://raw.githubusercontent.com/TU_USUARIO/europapress-rss/main/latest.json`

`https://raw.githubusercontent.com/TU_USUARIO/europapress-rss/main/state.json`

También puedes activar GitHub Pages y utilizar:

`https://TU_USUARIO.github.io/europapress-rss/feed.xml`

`https://TU_USUARIO.github.io/europapress-rss/latest.json`

## Nota sobre la frecuencia

GitHub Actions admite el cron de 5 minutos, pero las ejecuciones programadas no son de tiempo real y ocasionalmente pueden retrasarse. El recorrido multipágina reduce el riesgo de pérdida: en la siguiente ejecución se recorren de nuevo todas las páginas actualmente disponibles y se incorporan al histórico las noticias que falten.

## Comprobación local

```bash
pip install -r requirements.txt
python generate_feed.py
```

El script tiene un límite defensivo de 100 páginas por ejecución para evitar bucles si Europa Press cambia su paginación. Si se alcanza, lo indica como advertencia en el log.
