# 🎉 Gießen Events Aggregator

Wöchentlicher Event-Aggregator für Gießen und Umgebung. Sammelt Veranstaltungen aus mehreren Quellen und liefert eine übersichtliche Zusammenfassung.

## Konzept

### Problem
Lokale Events sind über viele Plattformen verstreut — Ticketmaster, Eventim, lokale Websites, Facebook. Kein einzelner Dienst hat alles.

### Lösung
Ein Node.js-Script, das mehrere Quellen parallel abfragt, dedupliziert und als formatierte Übersicht ausgibt. Läuft als wöchentlicher Cron-Job oder on-demand.

### Architektur

```
┌─────────────────────────────────────────────┐
│              giessen-events                  │
│                                              │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐  │
│  │Ticketmast│  │ Eventim  │  │  Scraper   │  │
│  │  er API   │  │ Scraper  │  │ (Generic)  │  │
│  └─────┬────┘  └─────┬────┘  └─────┬─────┘  │
│        │             │              │         │
│        └──────┬──────┴──────────────┘         │
│               ▼                               │
│     ┌──────────────────┐                      │
│     │   Normalizer &   │                      │
│     │   Deduplicator   │                      │
│     └────────┬─────────┘                      │
│              ▼                                 │
│     ┌──────────────────┐                      │
│     │  Output (JSON /  │                      │
│     │  Text / Discord) │                      │
│     └──────────────────┘                      │
└─────────────────────────────────────────────┘
```

### Datenquellen

| Quelle | Methode | API Key nötig? | Beschreibung |
|--------|---------|----------------|--------------|
| **Ticketmaster** | REST API | ✅ (kostenlos) | Konzerte, Shows, Sport |
| **Eventim** | Web Scraping | ❌ | Große dt. Ticketplattform |
| **Reservix** | Web Scraping | ❌ | Regional stark in Hessen |

Erweiterbar um weitere Quellen (Eventbrite, Meetup, Facebook etc.)

### Features

- 🔍 **Multi-Source**: Aggregiert aus APIs + Scraping
- 🗑️ **Deduplizierung**: Erkennt gleiche Events über verschiedene Plattformen
- 📍 **Geo-Filter**: Radius-basierte Suche um Gießen (default 30km)
- 📅 **Wöchentlich**: Zeigt Events der kommenden 7 Tage
- 💾 **Caching**: 30min Cache um API-Limits zu schonen
- 📤 **Multi-Output**: JSON, Text, oder Discord-ready Formatierung

## Installation

```bash
npm install
cp .env.example .env
# API Keys eintragen (optional, Scraping funktioniert ohne)
```

## Usage

```bash
# Events der nächsten 7 Tage
node index.js

# Bestimmter Zeitraum
node index.js --date "2026-02-10:2026-02-17"

# Nur Musik-Events
node index.js --type music

# JSON Output
node index.js --json

# Anderer Radius
node index.js --radius 50
```

## Cron-Job (OpenClaw)

Wöchentlich Montags um 9:00 Uhr:

```json
{
  "schedule": { "kind": "cron", "expr": "0 9 * * 1", "tz": "Europe/Berlin" },
  "payload": {
    "kind": "agentTurn",
    "message": "Führe `node /root/.openclaw/workspace/giessen-events/index.js` aus und poste die Ergebnisse formatiert im #events Channel."
  },
  "sessionTarget": "isolated",
  "delivery": { "mode": "announce", "channel": "discord", "to": "channel:1476182600342310996" }
}
```

## Konfiguration

`.env` Datei:

```env
# Optional - Scraping funktioniert ohne Keys
TICKETMASTER_API_KEY=your_key_here

# Defaults
CITY=Gießen
RADIUS_KM=30
```

## Lizenz

MIT
