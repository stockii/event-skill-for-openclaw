#!/usr/bin/env node
/**
 * Gießen Events Aggregator
 * Sammelt lokale Events aus mehreren Quellen (APIs + Scraping)
 */

const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { format, addDays, startOfDay, endOfDay, parseISO } = require('date-fns');

// ── Config ──────────────────────────────────────────────────────────────

const CACHE_DIR = path.join(__dirname, '.cache');
const CACHE_TTL_MS = 30 * 60 * 1000;
const ENV_PATH = path.join(__dirname, '.env');
const SECRETS_PATH = '/root/.openclaw/workspace/.secrets.env';
const TIMEOUT = 15000;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';

// Gießen coordinates
const GEO = { lat: 50.5840, lon: 8.6784 };

function loadEnv() {
  // Load central secrets first, then local overrides
  for (const envFile of [SECRETS_PATH, ENV_PATH]) {
    if (fs.existsSync(envFile)) {
      for (const line of fs.readFileSync(envFile, 'utf-8').split('\n')) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
      }
    }
  }
}

// ── Args ────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    city: process.env.CITY || 'Gießen',
    radius: parseInt(process.env.RADIUS_KM || '30'),
    type: 'all',
    limit: 30,
    date: null,
    json: args.includes('--json'),
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--radius' && args[i+1]) opts.radius = parseInt(args[++i]);
    if (args[i] === '--type' && args[i+1]) opts.type = args[++i];
    if (args[i] === '--date' && args[i+1]) opts.date = args[++i];
    if (args[i] === '--limit' && args[i+1]) opts.limit = parseInt(args[++i]);
    if (args[i] === '--city' && args[i+1]) opts.city = args[++i];
  }
  return opts;
}

function getDateRange(dateStr) {
  const now = new Date();
  if (!dateStr) {
    // Default: next 7 days
    return { start: startOfDay(now), end: endOfDay(addDays(now, 7)) };
  }
  if (dateStr.includes(':')) {
    const [s, e] = dateStr.split(':');
    return { start: startOfDay(parseISO(s)), end: endOfDay(parseISO(e)) };
  }
  if (dateStr === 'today') return { start: startOfDay(now), end: endOfDay(now) };
  if (dateStr === 'weekend') {
    const daysUntilSat = (6 - now.getDay() + 7) % 7 || 7;
    const sat = addDays(now, daysUntilSat);
    return { start: startOfDay(sat), end: endOfDay(addDays(sat, 1)) };
  }
  const d = parseISO(dateStr);
  return { start: startOfDay(d), end: endOfDay(d) };
}

// ── Cache ───────────────────────────────────────────────────────────────

function cacheFile(key) {
  return path.join(CACHE_DIR, crypto.createHash('md5').update(key).digest('hex') + '.json');
}

function readCache(key) {
  const f = cacheFile(key);
  if (!fs.existsSync(f)) return null;
  try {
    const d = JSON.parse(fs.readFileSync(f, 'utf-8'));
    if (Date.now() - d.ts > CACHE_TTL_MS) { fs.unlinkSync(f); return null; }
    return d.payload;
  } catch { return null; }
}

function writeCache(key, payload) {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cacheFile(key), JSON.stringify({ ts: Date.now(), payload }));
}

// ── Provider: Ticketmaster ──────────────────────────────────────────────

async function fetchTicketmaster(dateRange, opts) {
  const apiKey = process.env.TICKETMASTER_API_KEY;
  if (!apiKey) return { events: [], status: 'skip (kein API Key)' };

  try {
    const params = {
      apikey: apiKey,
      latlong: `${GEO.lat},${GEO.lon}`,
      radius: opts.radius,
      unit: 'km',
      startDateTime: format(dateRange.start, "yyyy-MM-dd'T'HH:mm:ss'Z'"),
      endDateTime: format(dateRange.end, "yyyy-MM-dd'T'HH:mm:ss'Z'"),
      size: opts.limit,
      sort: 'date,asc',
      locale: 'de',
    };

    const { data } = await axios.get('https://app.ticketmaster.com/discovery/v2/events.json', {
      params, timeout: TIMEOUT,
    });

    if (!data._embedded?.events) return { events: [], status: 'ok (0 Events)' };

    const events = data._embedded.events.map(e => ({
      name: e.name,
      date: e.dates?.start?.dateTime || e.dates?.start?.localDate || null,
      venue: e._embedded?.venues?.[0]?.name || null,
      address: [e._embedded?.venues?.[0]?.address?.line1, e._embedded?.venues?.[0]?.city?.name].filter(Boolean).join(', '),
      type: e.classifications?.[0]?.segment?.name?.toLowerCase() || 'other',
      url: e.url,
      price: e.priceRanges ? `Ab ${e.priceRanges[0].min}€` : null,
      source: 'ticketmaster',
      description: (e.info || e.pleaseNote || '').slice(0, 200) || null,
    }));

    return { events, status: `ok (${events.length} Events)` };
  } catch (e) {
    return { events: [], status: `error: ${e.message}` };
  }
}

// ── Provider: Meetup (Public Web) ───────────────────────────────────────

async function fetchMeetup(dateRange, opts) {
  try {
    const url = `https://www.meetup.com/find/?location=Gie%C3%9Fen%2C+Germany&source=EVENTS&eventType=inPerson&distance=thirtyMiles`;
    const { data } = await axios.get(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'de-DE,de;q=0.9' },
      timeout: TIMEOUT,
    });

    const $ = cheerio.load(data);
    const events = [];

    // Extract from JSON-LD if available
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const json = JSON.parse($(el).html());
        const items = Array.isArray(json) ? json : [json];
        for (const item of items) {
          if (item['@type'] === 'Event' || item['@type'] === 'SocialEvent') {
            events.push({
              name: item.name,
              date: item.startDate || null,
              venue: item.location?.name || null,
              address: item.location?.address?.streetAddress || null,
              type: 'meetup',
              url: item.url || null,
              price: item.isAccessibleForFree ? 'Kostenlos' : null,
              source: 'meetup',
              description: (item.description || '').slice(0, 200) || null,
            });
          }
        }
      } catch {}
    });

    // Fallback: parse HTML cards
    if (events.length === 0) {
      $('[data-testid="categoryResults-eventCard"], [id*="event-card"]').each((_, el) => {
        const $el = $(el);
        const name = $el.find('h2, h3, [class*="title"]').first().text().trim();
        const link = $el.find('a[href*="/events/"]').first().attr('href');
        const dateText = $el.find('time').first().attr('datetime') || $el.find('time').first().text().trim();

        if (name) {
          events.push({
            name,
            date: dateText || null,
            venue: null,
            address: null,
            type: 'meetup',
            url: link ? (link.startsWith('http') ? link : `https://www.meetup.com${link}`) : null,
            price: null,
            source: 'meetup',
            description: null,
          });
        }
      });
    }

    return { events, status: `ok (${events.length} Events)` };
  } catch (e) {
    return { events: [], status: `error: ${e.message}` };
  }
}

// ── Date Parsing (German) ───────────────────────────────────────────────

function parseDateDE(str) {
  if (!str) return null;
  // "Sa, 15.02.2026 20:00" or "15.02.2026" or "15. Feb 2026"
  const m = str.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (m) {
    const [, d, mo, y, h, min] = m;
    return `${y}-${mo.padStart(2,'0')}-${d.padStart(2,'0')}T${(h||'00').padStart(2,'0')}:${(min||'00').padStart(2,'0')}:00`;
  }
  return null;
}

// ── Deduplicate & Sort ──────────────────────────────────────────────────

function dedup(events) {
  const seen = new Map();
  for (const e of events) {
    const key = (e.name || '').toLowerCase().replace(/[^a-zäöüß0-9]/g, '').slice(0, 40)
      + '|' + (e.date || '').slice(0, 10);
    if (!seen.has(key)) {
      seen.set(key, e);
    } else {
      const ex = seen.get(key);
      if (!ex.price && e.price) ex.price = e.price;
      if (!ex.venue && e.venue) ex.venue = e.venue;
      ex.source += `, ${e.source}`;
    }
  }
  return [...seen.values()].sort((a, b) => {
    const da = a.date ? new Date(a.date).getTime() : Infinity;
    const db = b.date ? new Date(b.date).getTime() : Infinity;
    return da - db;
  });
}

// ── Output ──────────────────────────────────────────────────────────────

function formatText(events, dateRange) {
  if (events.length === 0) return '😔 Keine Events gefunden für den Zeitraum.';

  const startStr = format(dateRange.start, 'dd.MM.yyyy');
  const endStr = format(dateRange.end, 'dd.MM.yyyy');
  let out = `🎉 **${events.length} Events in Gießen & Umgebung** (${startStr} – ${endStr})\n`;

  let lastDay = '';
  for (const e of events) {
    const day = e.date ? format(new Date(e.date), 'EEEE, dd.MM.') : 'Datum unbekannt';
    if (day !== lastDay) {
      out += `\n**📅 ${day}**\n`;
      lastDay = day;
    }
    const time = e.date ? format(new Date(e.date), 'HH:mm') : '??:??';
    out += `• **${time}** — ${e.name}`;
    if (e.venue) out += ` @ ${e.venue}`;
    if (e.price) out += ` (${e.price})`;
    if (e.url) out += `\n  <${e.url}>`;
    out += '\n';
  }

  return out;
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  loadEnv();
  const opts = parseArgs();
  const dateRange = getDateRange(opts.date);

  const cacheKey = `events_${opts.city}_${format(dateRange.start, 'yyyy-MM-dd')}_${format(dateRange.end, 'yyyy-MM-dd')}_${opts.radius}`;
  const cached = readCache(cacheKey);
  if (cached) {
    console.error('📦 Cache hit');
    console.log(opts.json ? JSON.stringify(cached, null, 2) : formatText(cached, dateRange));
    return;
  }

  console.error(`🔍 Events: ${opts.city}, ${format(dateRange.start, 'dd.MM.')} – ${format(dateRange.end, 'dd.MM.yyyy')}, ${opts.radius}km`);

  const providers = [
    { name: 'Ticketmaster', fn: () => fetchTicketmaster(dateRange, opts) },
    { name: 'Meetup', fn: () => fetchMeetup(dateRange, opts) },
  ];

  const results = await Promise.allSettled(providers.map(p => p.fn()));
  let allEvents = [];

  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      console.error(`  ${providers[i].name}: ${r.value.status}`);
      allEvents.push(...r.value.events);
    } else {
      console.error(`  ${providers[i].name}: ❌ ${r.reason?.message}`);
    }
  });

  allEvents = dedup(allEvents);
  if (opts.type !== 'all') {
    allEvents = allEvents.filter(e => e.type === opts.type || e.type === 'other');
  }

  writeCache(cacheKey, allEvents);
  console.log(opts.json ? JSON.stringify(allEvents, null, 2) : formatText(allEvents, dateRange));
}

main().catch(e => { console.error(`❌ ${e.message}`); process.exit(1); });
