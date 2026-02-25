/**
 * Deskline (feratel) Scraper via Puppeteer
 * Used by: marburg.de, wetzlar.de (and many other German tourism sites)
 * 
 * These sites load events via a Deskline widget in an iframe,
 * so we need a headless browser to render the JavaScript.
 */

const puppeteer = require('puppeteer-core');
const { format } = require('date-fns');

const CITIES = {
  marburg: {
    url: 'https://www.marburg.de/kultur-und-tourismus/veranstaltungskalender/#/veranstaltungen',
    name: 'Marburg',
    source: 'marburg.de',
  },
  wetzlar: {
    url: 'https://www.wetzlar.de/leben-in-wetzlar/veranstaltungen/index.php#/veranstaltungen',
    name: 'Wetzlar',
    source: 'wetzlar.de',
  },
};

async function fetchDeskline(cityKey, dateRange, opts) {
  const city = CITIES[cityKey];
  if (!city) return { events: [], status: `error: unknown city ${cityKey}` };

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: '/usr/bin/chromium-browser',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      timeout: 30000,
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');
    
    // Navigate and wait for Deskline widget to load
    await page.goto(city.url, { waitUntil: 'networkidle2', timeout: 30000 });
    
    // Wait for the Deskline iframe to appear
    await page.waitForSelector('iframe[src*="deskline"]', { timeout: 15000 }).catch(() => null);
    
    // Try to find events in the iframe
    const frames = page.frames();
    let events = [];
    
    for (const frame of frames) {
      const url = frame.url();
      if (!url.includes('deskline')) continue;
      
      // Wait for event content to render
      await frame.waitForSelector('[class*="event"], [class*="Event"], .search-result, article, .list-item', { timeout: 10000 }).catch(() => null);
      
      // Extract events from the Deskline iframe
      const extracted = await frame.evaluate(() => {
        const events = [];
        
        // Try multiple selectors that Deskline uses
        const selectors = [
          '.event-item', '.search-result-item', '[class*="EventCard"]',
          '[class*="event-card"]', 'article', '.list-item',
          '[class*="resultItem"]', '[class*="result-item"]',
          '.dw-result-item', '.dw-event',
        ];
        
        let elements = [];
        for (const sel of selectors) {
          const found = document.querySelectorAll(sel);
          if (found.length > elements.length) elements = [...found];
        }
        
        // Also try to extract from any structured data
        const jsonLd = document.querySelectorAll('script[type="application/ld+json"]');
        for (const script of jsonLd) {
          try {
            const data = JSON.parse(script.textContent);
            const items = Array.isArray(data) ? data : [data];
            for (const item of items) {
              if (item['@type'] === 'Event') {
                events.push({
                  name: item.name,
                  date: item.startDate || null,
                  venue: item.location?.name || null,
                  address: item.location?.address?.streetAddress || null,
                  url: item.url || null,
                  description: (item.description || '').slice(0, 200),
                });
              }
            }
          } catch {}
        }
        
        // Parse from DOM elements
        for (const el of elements) {
          const name = (el.querySelector('h2, h3, h4, [class*="title"], [class*="name"]') || {}).textContent?.trim();
          if (!name || name.length < 3) continue;
          
          const dateEl = el.querySelector('time, [class*="date"], [class*="Date"]');
          const date = dateEl?.getAttribute('datetime') || dateEl?.textContent?.trim() || null;
          
          const venueEl = el.querySelector('[class*="location"], [class*="venue"], [class*="Location"]');
          const venue = venueEl?.textContent?.trim() || null;
          
          const linkEl = el.querySelector('a[href]');
          const url = linkEl?.href || null;
          
          events.push({ name, date, venue, address: null, url, description: null });
        }
        
        return events;
      });
      
      events.push(...extracted);
    }
    
    // If iframe approach didn't work, try the main page
    if (events.length === 0) {
      // Wait a bit more for dynamic content
      await new Promise(r => setTimeout(r, 3000));
      
      const mainEvents = await page.evaluate(() => {
        const events = [];
        const items = document.querySelectorAll('[class*="event"], [class*="Event"], .search-result, article');
        for (const el of items) {
          const name = (el.querySelector('h2, h3, h4, [class*="title"]') || {}).textContent?.trim();
          if (!name || name.length < 3) continue;
          const dateEl = el.querySelector('time, [class*="date"]');
          events.push({
            name,
            date: dateEl?.getAttribute('datetime') || dateEl?.textContent?.trim() || null,
            venue: null,
            address: null,
            url: el.querySelector('a')?.href || null,
            description: null,
          });
        }
        return events;
      });
      events.push(...mainEvents);
    }

    // Normalize events
    const normalized = events.map(e => ({
      name: e.name,
      date: e.date,
      venue: e.venue,
      address: e.address || city.name,
      type: 'other',
      url: e.url,
      price: null,
      source: city.source,
      description: e.description,
    }));

    return { events: normalized, status: `ok (${normalized.length} Events)` };
  } catch (e) {
    return { events: [], status: `error: ${e.message}` };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { fetchDeskline, CITIES };
