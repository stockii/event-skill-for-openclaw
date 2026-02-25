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

// ── Provider: giessen.de (Scraping) ─────────────────────────────────────

async function fetchGiessenDe(dateRange, opts) {
  try {
    const BASE = 'https://www.giessen.de';
    const url = `${BASE}/Erleben/Veranstaltungen/`;
    const { data } = await axios.get(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'de-DE,de;q=0.9' },
      timeout: TIMEOUT,
    });

    const $ = cheerio.load(data);
    const events = [];
    const startTs = dateRange.start.getTime();
    const endTs = dateRange.end.getTime();

    // Each event is a list item with link, title, date, description
    $('ul li').each((_, el) => {
      const $el = $(el);
      const $link = $el.find('a[href*="/Veranstaltungen/"]').first();
      if (!$link.length) return;

      const text = $el.text().replace(/\s+/g, ' ').trim();
      const href = $link.attr('href');
      
      // Extract name - it's the main text of the link
      const rawText = $link.text().replace(/\s+/g, ' ').trim();
      // Try to get clean name from URL slug as primary source
      let name = null;
      if (href) {
        const slugMatch = href.match(/Veranstaltungen\/([^.?]+)/);
        if (slugMatch) {
          name = decodeURIComponent(slugMatch[1])
            .replace(/-/g, ' ')
            .replace(/\.php$/, '')
            .trim();
        }
      }
      // Fallback to text with copyright cleanup
      if (!name || name.length < 3) {
        name = rawText
          .replace(/^©\s*.+?\s{2,}/, '') // © Author  Title (double space separates)
          .replace(/^©\s*/, '')
          .trim();
      }

      if (!name || name.length < 3) return;
      // Skip navigation/index links
      if (/^(heute|morgen|diese Woche|dieses Wochenende|4 Wochen|Veranstaltungen|Musikalischer Sommer|Raumkataster|index)$/i.test(name)) return;
      if (href && href.includes('index.php?')) return;

      // Extract date patterns: "25.02.2026 18:00 Uhr" or "24.02.2026 bis 26.02.2026"
      let date = null;
      let dateEnd = null;
      
      // Single date with time: "25.02.2026  18:00 Uhr" or "25.02.2026  18:00 bis 22:00 Uhr"
      const singleMatch = text.match(/(\d{2}\.\d{2}\.\d{4})\s+(\d{2}:\d{2})(?:\s+bis\s+(\d{2}:\d{2}))?\s*Uhr/);
      // Date range: "24.02.2026 bis 26.02.2026"
      const rangeMatch = text.match(/(\d{2}\.\d{2}\.\d{4})\s+bis\s+(\d{2}\.\d{2}\.\d{4})/);
      // Single date only: "25.02.2026"
      const dateOnly = text.match(/(\d{2}\.\d{2}\.\d{4})/);

      if (singleMatch) {
        date = parseDateDE(`${singleMatch[1]} ${singleMatch[2]}`);
      } else if (rangeMatch) {
        date = parseDateDE(rangeMatch[1]);
        dateEnd = parseDateDE(rangeMatch[2]);
      } else if (dateOnly) {
        date = parseDateDE(dateOnly[1]);
      }

      // Filter by date range
      if (date) {
        const eventTs = new Date(date).getTime();
        const eventEndTs = dateEnd ? new Date(dateEnd).getTime() : eventTs;
        // Skip if event ends before our range or starts after
        if (eventEndTs < startTs || eventTs > endTs) return;
      }

      // Extract description (text after the date info)
      let description = null;
      const descMatch = text.match(/Uhr\s+(.+?)(?:\s+Mehr\s*\.\.\.)?$/);
      if (descMatch) description = descMatch[1].slice(0, 200);
      else {
        // Try text after date range
        const afterDate = text.match(/\d{4}\s+(.{10,}?)$/);
        if (afterDate) description = afterDate[1].slice(0, 200);
      }

      events.push({
        name: name.split(/\d{2}\.\d{2}\.\d{4}/)[0].trim() || name,
        date,
        venue: null,
        address: 'Gießen',
        type: 'other',
        url: href ? (href.startsWith('http') ? href : `${BASE}${href}`) : null,
        price: null,
        source: 'giessen.de',
        description,
      });
    });

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
    const TAGE = ['Sonntag','Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag'];
    const d = e.date ? new Date(e.date) : null;
    const day = d ? `${TAGE[d.getDay()]}, ${format(d, 'dd.MM.')}` : 'Datum unbekannt';
    if (day !== lastDay) {
      out += `\n**📅 ${day}**\n`;
      lastDay = day;
    }
    const time = e.date ? format(new Date(e.date), 'HH:mm') : '??:??';
    out += `• **${time}** — ${e.name}`;
    if (e.venue) out += ` @ ${e.venue}`;
    if (e.price) out += ` (${e.price})`;
    if (e.url) out += ` · [→ Info](<${e.url}>)`;
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
    { name: 'Giessen.de', fn: () => fetchGiessenDe(dateRange, opts) },
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
