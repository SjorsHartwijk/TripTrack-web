# TripTrack web

Statische pagina voor GitHub Pages die je TripTrack-ritten op een groot scherm toont: overzicht, rittentabel, ritdetail met kaart en grafieken, kaart van alle ritten en records. Geen server en geen build nodig.

Twee manieren om gegevens te laden:

1. **Online (automatisch):** de app zet na elke opgeslagen rit je ritten versleuteld op de branch `data` van je eigen repository (Instellingen → Webpagina). Op `https://<eigenaar>.github.io/<repo>/` vraagt de pagina het wachtwoord en ontsleutelt alles in de browser.
2. **Bestand:** sleep een `.ttbackup` op de pagina. Het bestand blijft in de browser (IndexedDB) tot je op *Vergeten* klikt.

## Gegevens op de branch `data`

| Bestand | Inhoud |
|---|---|
| `index.tte` | header, auto (zonder kenteken), records, vaste stukken, alle ritten zonder GPS-punten (met `m`: de maand) |
| `m/2026-11.tte` | de GPS-punten van de ritten die in die maand begonnen |

Elk bestand is gzip-JSON Lines, versleuteld als `"TTE1" | salt (16) | iteraties (uint32) | IV (12) | AES-256-GCM`, met de sleutel uit PBKDF2-HMAC-SHA256 (310.000 iteraties) over het wachtwoord. Dezelfde code staat in `tte.js` (pagina) en `TteCrypto.kt` (app). De app schrijft de branch telkens opnieuw als één commit zonder voorganger, zodat de repository niet groeit; de pagina haalt de nieuwste commit op via de GitHub-API en leest de bestanden van `raw.githubusercontent.com`.

## Lokaal bekijken en testen

```bash
python -m http.server 8765 --bind 127.0.0.1 --directory web
node web/tools/sample-backup.mjs      # verzonnen back-up: tools/sample.ttbackup
node web/tools/sample-web.mjs         # dezelfde ritten versleuteld: tools/sample-web/ (wachtwoord "testwachtwoord")
```

- Bestand: http://localhost:8765/?data=tools/sample.ttbackup
- Online-modus: http://localhost:8765/?source=tools/sample-web/
- Een andere repository: `?repo=eigenaar/naam`

`node web/tools/check-tte.mjs <bestand.tte> <wachtwoord>` ontsleutelt een bestand met de code van de pagina (de unit-test `TteCryptoTest` schrijft er een in `app/build/tte-sample/`).

## Bestanden

- `index.html`, `app.css`, `app.js`, `tte.js`: de pagina (geen afhankelijkheden behalve Leaflet).
- `vendor/leaflet`: Leaflet 1.9.4, dezelfde als in de app.
- `fonts`: Inter (OFL) en Futura PT Bold Oblique voor de titels.
