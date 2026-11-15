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

interface DayPilotEventData {
  id: string;
  start: string;
  end: string;
  text?: string;
  resource?: string;
}

async function extractSlots(page: Page): Promise<Slot[]> {
  // Strategy 1: read DayPilot event data from the JavaScript object in the page
  const dpEvents = await page.evaluate((): DayPilotEventData[] | null => {
    // DayPilot stores events in the control's client-side object
    // Try various access patterns used by different DayPilot versions
    const win = window as unknown as Record<string, unknown>;

    // Pattern A: global dp object
    for (const key of Object.keys(win)) {
      const obj = win[key] as Record<string, unknown> | null;
      if (obj && typeof obj === 'object' && 'events' in obj) {
        const events = (obj as Record<string, unknown>)['events'];
        if (events && typeof events === 'object' && 'list' in (events as object)) {
          const list = ((events as Record<string, unknown>)['list']) as unknown[];
          if (Array.isArray(list) && list.length > 0) return list as DayPilotEventData[];
        }
      }
    }

    // Pattern B: DayPilot namespace
    if ('DayPilot' in win) {
      const dp = win['DayPilot'] as Record<string, unknown>;
      if ('Calendar' in dp) {
        const cal = dp['Calendar'] as Record<string, unknown>;
        if ('instances' in cal) {
          const instances = cal['instances'] as Record<string, unknown>;
          for (const id of Object.keys(instances)) {
            const inst = instances[id] as Record<string, unknown>;
            const events = inst['events'] as Record<string, unknown> | undefined;
            if (events && Array.isArray(events['list']) && (events['list'] as unknown[]).length > 0) {
              return events['list'] as DayPilotEventData[];
            }
          }
        }
      }
    }

    return null;
  });

  if (dpEvents && dpEvents.length > 0) {
    console.log(`[sarool] DayPilot events: ${dpEvents.length} trouvés`);
    return dpEvents.map(e => ({
      id: String(e.id),
      date: new Date(e.start),
      duration: computeDuration(new Date(e.start), new Date(e.end)),
      instructor: e.text ?? e.resource,
    })).filter(s => !isNaN(s.date.getTime()));
  }

  // Strategy 2: parse DayPilot event data from inline scripts
  const scriptEvents = await page.evaluate((): DayPilotEventData[] => {
    const results: DayPilotEventData[] = [];
    document.querySelectorAll('script:not([src])').forEach((s: Element) => {
      const text = (s as HTMLScriptElement).textContent ?? '';
      // DayPilot initializes with: .events.list([...]) or .update({events:[...]})
      const matches = text.matchAll(/"id"\s*:\s*"([^"]+)"[^}]*"start"\s*:\s*"([^"]+)"[^}]*"end"\s*:\s*"([^"]+)"/g);
      for (const m of matches) {
        results.push({ id: m[1]!, start: m[2]!, end: m[3]! });
      }
    });
    return results;
  });

  if (scriptEvents.length > 0) {
    console.log(`[sarool] Script events: ${scriptEvents.length} trouvés`);
    return scriptEvents.map(e => ({
      id: e.id,
      date: new Date(e.start),
      duration: computeDuration(new Date(e.start), new Date(e.end)),
      instructor: undefined,
    })).filter(s => !isNaN(s.date.getTime()));
  }

  // Strategy 3: derive date/time from DayPilot CSS positions
  // Each event div has position:absolute with top=px offset from calendar start
  // Column index = day of week, top position = time offset
  const cssSlots = await page.evaluate((): Array<{ colIndex: number; topPx: number; heightPx: number }> => {
    const results: Array<{ colIndex: number; topPx: number; heightPx: number }> = [];

    // Find the calendar scroll container
    const scroll = document.querySelector('.F3_plncal_scroll');
    if (!scroll) return results;

    // Find column containers (one per visible day)
    const columns = Array.from(scroll.querySelectorAll('[style*="position: absolute"][style*="left"]'))
      .filter(el => el.querySelector('.F3_plncal_eventDisposE'));

    // Find calendar height and row headers to determine time scale
    const rowHeaders = Array.from(document.querySelectorAll('.F3_plncal_rowheader_inner'));
    const calendarHeight = (scroll as HTMLElement).offsetHeight;

    document.querySelectorAll('.F3_plncal_eventDisposE').forEach((el: Element) => {
      const style = (el as HTMLElement).style;
      const top = parseInt(style.top ?? '0');
      const height = parseInt(style.height ?? '32');

      // Find which column this event is in
      let colIndex = 0;
      let parent: Element | null = el.parentElement;
      while (parent && parent !== scroll) {
        const siblings = parent.parentElement ? Array.from(parent.parentElement.children) : [];
        const idx = siblings.indexOf(parent);
        if (idx > 0) { colIndex = idx - 1; break; }
        parent = parent.parentElement;
      }

      results.push({ colIndex, topPx: top, heightPx: height });
    });

    return results;
  });

  if (cssSlots.length > 0) {
    console.log(`[sarool] CSS slots: ${cssSlots.length} trouvés, calcul des dates...`);

    // Get the calendar's visible week start and time scale
    const calInfo = await page.evaluate((): { weekStart: string; hourHeight: number; startHour: number } | null => {
      // Read week start from column headers (e.g. "LUNDI 15/11")
      const headers = Array.from(document.querySelectorAll('.F3_plncal_colheader_base'));
      const firstHeader = headers[0]?.textContent ?? '';
      const dateMatch = firstHeader.match(/(\d{2})\/(\d{2})\/(\d{4})|(\d{2})\/(\d{2})/);

      // Read first row header to find start hour
      const firstRow = document.querySelector('.F3_plncal_rowheader_inner');
      const firstHourText = firstRow?.textContent?.trim() ?? '8';
      const startHour = parseInt(firstHourText.replace('h', '').replace(':', ''));

      // Calculate pixels per hour by looking at row height
      const rows = Array.from(document.querySelectorAll('.F3_plncal_rowheader_inner'));
      let hourHeight = 32; // default
      if (rows.length >= 2) {
        const r1 = rows[0] as HTMLElement;
        const r2 = rows[1] as HTMLElement;
        hourHeight = r2.offsetTop - r1.offsetTop || 32;
      }

      return { weekStart: new Date().toISOString().split('T')[0]!, hourHeight, startHour };
    });

    console.log('[sarool] calInfo:', JSON.stringify(calInfo));

    const today = new Date();
    const dayOfWeek = today.getDay(); // 0=sun
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monday = new Date(today);
    monday.setDate(today.getDate() + mondayOffset);

    const hourHeight = calInfo?.hourHeight ?? 32;
    const startHour = calInfo?.startHour ?? 8;

    return cssSlots.map((s, i) => {
      const slotDay = new Date(monday);
      slotDay.setDate(monday.getDate() + s.colIndex);
      const totalMinutes = startHour * 60 + Math.round((s.topPx / hourHeight) * 60);
      slotDay.setHours(Math.floor(totalMinutes / 60), totalMinutes % 60, 0, 0);
      const durationMin = Math.round((s.heightPx / hourHeight) * 60);
      return {
        id: `css-${s.colIndex}-${s.topPx}`,
        date: slotDay,
        duration: `${durationMin}min`,
        instructor: undefined,
      };
    }).filter(s => !isNaN(s.date.getTime()));
  }

  console.warn('[sarool] Aucun créneau trouvé — URL:', page.url());
  return [];
}

function computeDuration(start: Date, end: Date): string {
  const mins = Math.round((end.getTime() - start.getTime()) / 60000);
  return `${mins}min`;
}

async function parseSlotElement(
  el: Awaited<ReturnType<Page['$']>>,
  selector: string
): Promise<Slot | null> {
  if (!el) return null;

  try {
    const text = await el.textContent() ?? '';
    const dataDate = await el.getAttribute('data-date');
    const dataStart = await el.getAttribute('data-start');
    const title = await el.getAttribute('title');

    const dateStr = dataDate ?? dataStart;
    let date: Date | null = null;

    if (dateStr) {
      date = new Date(dateStr);
    } else {
      // Try to parse date from text content
      // Patterns: "Samedi 15 novembre 2024 à 10:00", "15/11/2024 10h00"
      const frMatch = text.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\s+(\d{1,2})h?:?(\d{2})?/);
      const longMatch = text.match(/(\d{1,2})\s+\w+\s+\d{4}\s+à\s+(\d{1,2}):(\d{2})/);

      if (frMatch) {
        date = new Date(`${frMatch[3]}-${frMatch[2].padStart(2, '0')}-${frMatch[1].padStart(2, '0')}T${frMatch[4].padStart(2, '0')}:${(frMatch[5] ?? '00').padStart(2, '0')}`);
      } else if (longMatch) {
        date = new Date(text.replace(/à\s+/, ''));
      }
    }

    if (!date || isNaN(date.getTime())) return null;

    // Try to find duration and instructor from text or nearby elements
    const durationMatch = (title ?? text).match(/(\d+)\s*(?:min|h)/i);
    const duration = durationMatch ? durationMatch[0] : undefined;

    return {
      id: `${selector}-${date.getTime()}`,
      date,
      duration,
      instructor: undefined,
      bookingElement: undefined,
    };
  } catch {
    return null;
  }
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
