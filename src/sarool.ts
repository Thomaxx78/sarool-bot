import { Browser, BrowserContext, Page, chromium } from 'playwright';
import { config, isWantedSlot } from './config.js';

export interface Slot {
  id: string;
  date: Date;
  duration?: string;
  instructor?: string;
  bookingElement?: string; // selector to click for booking
}

const BASE = config.sarool.baseUrl;
let browser: Browser | null = null;
let context: BrowserContext | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  }
  return browser;
}

async function newContext(): Promise<BrowserContext> {
  const br = await getBrowser();
  if (context) await context.close().catch(() => {});
  context = await br.newContext({
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
    viewport: { width: 390, height: 844 },
    locale: 'fr-FR',
  });
  return context;
}

async function login(page: Page): Promise<boolean> {
  console.log('[sarool] Connexion à Sarool...');
  await page.goto(`${BASE}/compte/connexion`, { waitUntil: 'domcontentloaded' });

  // Fill email
  const emailInput = await page.$('input[type="email"], input[name*="mail"], input[id*="mail"]');
  if (!emailInput) {
    console.error('[sarool] Champ email introuvable');
    return false;
  }
  await emailInput.fill(config.sarool.email);

  // Fill password
  const passwordInput = await page.$('input[type="password"]');
  if (!passwordInput) {
    console.error('[sarool] Champ password introuvable');
    return false;
  }
  await passwordInput.fill(config.sarool.password);

  // Submit
  const submitBtn = await page.$('button[type="submit"], input[type="submit"]');
  if (!submitBtn) {
    console.error('[sarool] Bouton submit introuvable');
    return false;
  }
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }),
    submitBtn.click(),
  ]);

  // Check if login succeeded (not on connexion page anymore)
  const url = page.url();
  if (url.includes('connexion')) {
    const error = await page.$('.error, .alert-danger, [class*="error"], [class*="alert"]');
    const msg = error ? await error.textContent() : 'Identifiants incorrects';
    console.error(`[sarool] Échec connexion: ${msg}`);
    return false;
  }

  console.log('[sarool] Connexion réussie');
  return true;
}

export async function checkAvailableSlots(): Promise<{ slots: Slot[]; wanted: Slot[] }> {
  const ctx = await newContext();
  const page = await ctx.newPage();

  try {
    const loggedIn = await login(page);
    if (!loggedIn) throw new Error('Connexion Sarool échouée');

    console.log('[sarool] Récupération des disponibilités...');
    await page.goto(`${BASE}/agenda/Disponibilites`, { waitUntil: 'networkidle' });

    // Fallback: try /agenda if Disponibilites doesn't work
    if (page.url().includes('connexion') || page.url() === `${BASE}/`) {
      await page.goto(`${BASE}/agenda`, { waitUntil: 'networkidle' });
    }

    // Wait for DayPilot calendar to finish rendering
    await page.waitForFunction(() => {
      const events = document.querySelectorAll('.F3_plncal_eventDisposE');
      if (events.length === 0) return true; // no events = done
      // Check that at least one event has a non-zero top position (rendered)
      const tops = Array.from(events).map(e => parseInt((e as HTMLElement).style.top ?? '0'));
      return tops.some(t => t > 0) || tops.every(t => t === 0);
    }, { timeout: 10000 }).catch(() => {});

    await page.waitForTimeout(1000);

    const slots = await extractSlots(page);
    console.log(`[sarool] ${slots.length} créneau(x) total trouvé(s)`);
    slots.forEach(s => console.log(`[sarool]   → ${s.date.toLocaleString('fr-FR')} (${s.duration ?? '?'})`));

    const wanted = slots.filter(s => isWantedSlot(s.date));
    console.log(`[sarool] ${wanted.length} créneau(x) correspondant(s) aux critères (week-end / ≥18h)`);

    return { slots, wanted };
  } finally {
    await page.close();
    await ctx.close();
    context = null;
  }
}

async function extractSlots(page: Page): Promise<Slot[]> {
  // Step 1: count F3_plncal_eventDisposE elements
  const pageState = await page.evaluate((): {
    eventCount: number;
    colHeaders: string[];
    rowHeaders: string[];
    events: Array<{ top: number; height: number; left: string; colHeader: string }>;
  } => {
    const eventEls = Array.from(document.querySelectorAll('.F3_plncal_eventDisposE'));
    const colHeaders = Array.from(document.querySelectorAll('.F3_plncal_colheader_base'))
      .map(el => el.textContent?.trim() ?? '');
    const rowHeaders = Array.from(document.querySelectorAll('.F3_plncal_rowheader_inner'))
      .map(el => el.textContent?.trim() ?? '');

    const events = eventEls.map(el => {
      const style = (el as HTMLElement).style;
      // Find the column this event belongs to by checking parent chain
      let colHeader = '';
      let ancestor: Element | null = el.parentElement;
      while (ancestor) {
        const idx = ancestor.parentElement
          ? Array.from(ancestor.parentElement.children).indexOf(ancestor)
          : -1;
        if (idx > 0 && colHeaders[idx - 1]) {
          colHeader = colHeaders[idx - 1]!;
          break;
        }
        ancestor = ancestor.parentElement;
      }
      return {
        top: parseInt(style.top ?? '0'),
        height: parseInt(style.height ?? '32'),
        left: style.left ?? '0%',
        colHeader,
      };
    });

    return { eventCount: eventEls.length, colHeaders, rowHeaders, events };
  });

  console.log(`[sarool] eventDisposE count: ${pageState.eventCount}`);
  console.log(`[sarool] colHeaders: ${pageState.colHeaders.join(' | ')}`);
  console.log(`[sarool] rowHeaders (first 4): ${pageState.rowHeaders.slice(0, 4).join(' | ')}`);
  pageState.events.forEach((e, i) =>
    console.log(`[sarool] event[${i}]: top=${e.top}px height=${e.height}px col="${e.colHeader}"`)
  );

  if (pageState.eventCount === 0) return [];

  // Step 2: build time scale from row headers (e.g. "8h", "9h", "10h")
  const slots: Slot[] = [];
  const rowTimes: number[] = pageState.rowHeaders
    .map(h => {
      const m = h.match(/(\d+)h?:?(\d*)/);
      return m ? parseInt(m[1]!) * 60 + parseInt(m[2] || '0') : -1;
    })
    .filter(t => t >= 0);

  // Compute pixels per minute from row heights
  // We need actual pixel positions of row headers — do a second evaluate
  const rowPixels = await page.evaluate((): number[] => {
    return Array.from(document.querySelectorAll('.F3_plncal_rowheader_inner'))
      .map(el => (el as HTMLElement).offsetTop);
  });

  let pxPerMinute = 32 / 60; // fallback: 32px per hour
  if (rowPixels.length >= 2 && rowTimes.length >= 2) {
    const dpx = rowPixels[1]! - rowPixels[0]!;
    const dmin = rowTimes[1]! - rowTimes[0]!;
    if (dpx > 0 && dmin > 0) pxPerMinute = dpx / dmin;
  }
  const startMinutes = rowTimes[0] ?? 480; // default 8h
  console.log(`[sarool] pxPerMinute=${pxPerMinute.toFixed(3)} startAt=${Math.floor(startMinutes/60)}h${startMinutes%60}`);

  // Step 3: map each event to a date
  for (const ev of pageState.events) {
    // Parse column header date: "LUNDI 16/11" or "SAM. 22/11/2026"
    const dateMatch = ev.colHeader.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?/);
    if (!dateMatch) {
      console.log(`[sarool] Pas de date dans le header "${ev.colHeader}", skip`);
      continue;
    }
    const year = dateMatch[3] ? parseInt(dateMatch[3]) : new Date().getFullYear();
    const month = parseInt(dateMatch[2]!) - 1;
    const day = parseInt(dateMatch[1]!);

    const offsetMinutes = ev.top / pxPerMinute;
    const totalMinutes = startMinutes + offsetMinutes;
    const durationMin = Math.round(ev.height / pxPerMinute);

    const date = new Date(year, month, day, Math.floor(totalMinutes / 60), Math.round(totalMinutes % 60), 0, 0);

    slots.push({
      id: `${ev.colHeader}-${ev.top}`,
      date,
      duration: `${durationMin}min`,
      instructor: undefined,
    });
  }

  return slots.filter(s => !isNaN(s.date.getTime()));
}

export async function bookSlot(slot: Slot): Promise<boolean> {
  const ctx = await newContext();
  const page = await ctx.newPage();

  try {
    const loggedIn = await login(page);
    if (!loggedIn) throw new Error('Connexion échouée pour la réservation');

    console.log(`[sarool] Réservation du créneau du ${slot.date.toLocaleString('fr-FR')}...`);
    await page.goto(`${BASE}/agenda/Disponibilites`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    // Find and click the slot that matches our target
    const dateStr = slot.date.toISOString().split('T')[0];
    const timeStr = `${String(slot.date.getHours()).padStart(2, '0')}:${String(slot.date.getMinutes()).padStart(2, '0')}`;

    // Try to find the slot element
    const slotEl = await page.$(
      `[data-date*="${dateStr}"], [data-start*="${dateStr}"], [title*="${timeStr}"]`
    );

    if (!slotEl) {
      console.error('[sarool] Créneau non retrouvé pour la réservation (peut-être déjà pris)');
      return false;
    }

    await slotEl.click();
    await page.waitForTimeout(1500);

    // Look for a confirmation button
    const confirmBtn = await page.$(
      'button:has-text("Réserver"), button:has-text("Confirmer"), button:has-text("Valider")'
    );

    if (!confirmBtn) {
      console.error('[sarool] Bouton de confirmation non trouvé');
      return false;
    }

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {}),
      confirmBtn.click(),
    ]);

    // Check for success message
    const success = await page.$('[class*="success"], .alert-success, [class*="confirm"]');
    if (success) {
      console.log('[sarool] Réservation confirmée !');
      return true;
    }

    // Even if no explicit success element, consider it booked if no error
    const error = await page.$('[class*="error"], .alert-danger');
    if (error) {
      const errMsg = await error.textContent();
      console.error(`[sarool] Erreur lors de la réservation: ${errMsg}`);
      return false;
    }

    console.log('[sarool] Réservation probablement réussie (pas de message d\'erreur)');
    return true;
  } finally {
    await page.close();
    await ctx.close();
    context = null;
  }
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
  }
}
