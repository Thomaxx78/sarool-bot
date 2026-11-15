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
    await page.goto(`${BASE}/agenda/Disponibilites`, { waitUntil: 'domcontentloaded' });

    // Fallback: try /agenda if Disponibilites doesn't work
    if (page.url().includes('connexion') || page.url() === `${BASE}/`) {
      await page.goto(`${BASE}/agenda`, { waitUntil: 'domcontentloaded' });
    }

    // Wait for DayPilot UpdatePanel to finish rendering events
    await page.waitForSelector('.F3_plncal_eventDisposE, .F3_plncal_main', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(3000);

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
    events: Array<{ top: number; height: number; left: string; colIndex: number; ancestorLefts: string }>;
  } => {
    const eventEls = Array.from(document.querySelectorAll('.F3_plncal_eventDisposE'));
    const colHeaders = Array.from(document.querySelectorAll('.F3_plncal_colheader_base'))
      .map(el => el.textContent?.trim() ?? '');
    const rowHeaders = Array.from(document.querySelectorAll('.F3_plncal_rowheader_inner'))
      .map(el => el.textContent?.trim() ?? '');

    // Find all column containers (direct children of the scroll content area)
    // DayPilot renders one absolute-positioned div per day column
    const scrollContent = document.querySelector('.F3_plncal_scroll > div > div');
    const colContainers = scrollContent
      ? Array.from(scrollContent.children).filter(c =>
          (c as HTMLElement).style.position === 'absolute' && c.querySelector('.F3_plncal_event')
        )
      : [];

    // Use getBoundingClientRect to get real screen positions
    const mainEl = document.querySelector('.F3_plncal_main') as HTMLElement | null;
    const mainRect = mainEl?.getBoundingClientRect();
    const numCols = Math.max(colHeaders.length, 1);

    const events = eventEls.map(el => {
      const style = (el as HTMLElement).style;
      const rect = el.getBoundingClientRect();
      let colIndex = 0;
      if (mainRect && mainRect.width > 0) {
        // Calendar starts after the row header (approx 62px from class F3_plncal_corner width)
        const rowHeaderWidth = 62;
        const calWidth = mainRect.width - rowHeaderWidth;
        const colWidth = calWidth / numCols;
        const relativeLeft = rect.left - mainRect.left - rowHeaderWidth;
        colIndex = Math.max(0, Math.min(numCols - 1, Math.floor(relativeLeft / colWidth)));
      }
      return {
        top: parseInt(style.top ?? '0'),
        height: parseInt(style.height ?? '32'),
        left: style.left ?? '0%',
        colIndex,
        ancestorLefts: `rect.left=${Math.round(rect.left)},mainLeft=${Math.round(mainRect?.left ?? 0)},mainW=${Math.round(mainRect?.width ?? 0)},numCols=${numCols}`,
      };
    });

    return { eventCount: eventEls.length, colHeaders, rowHeaders, events };
  });

  console.log(`[sarool] eventDisposE count: ${pageState.eventCount}`);
  console.log(`[sarool] colHeaders: ${pageState.colHeaders.join(' | ')}`);
  console.log(`[sarool] rowHeaders (first 4): ${pageState.rowHeaders.slice(0, 4).join(' | ')}`);
  pageState.events.forEach((e, i) =>
    console.log(`[sarool] event[${i}]: top=${e.top}px height=${e.height}px colIndex=${e.colIndex} ancestors=[${e.ancestorLefts}]`)
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

  // Map French day names to Monday-based index (0=lundi, 1=mardi, ...)
  const DAY_INDEX: Record<string, number> = {
    'LUNDI': 0, 'LUN': 0, 'LUN.': 0,
    'MARDI': 1, 'MAR': 1, 'MAR.': 1,
    'MERCREDI': 2, 'MER': 2, 'MER.': 2,
    'JEUDI': 3, 'JEU': 3, 'JEU.': 3,
    'VENDREDI': 4, 'VEN': 4, 'VEN.': 4,
    'SAMEDI': 5, 'SAM': 5, 'SAM.': 5,
    'DIMANCHE': 6, 'DIM': 6, 'DIM.': 6,
  };

  // Find the Monday of the week shown in the calendar
  const today = new Date();
  const dow = today.getDay(); // 0=sun
  const monday = new Date(today);
  monday.setDate(today.getDate() - (dow === 0 ? 6 : dow - 1));
  monday.setHours(0, 0, 0, 0);

  // Also try to find week start from colHeaders index (some headers may have dates)
  // Check if any header has an explicit date (e.g. "LUNDI 16/11")
  for (let i = 0; i < pageState.colHeaders.length; i++) {
    const h = pageState.colHeaders[i] ?? '';
    const dm = h.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?/);
    if (dm) {
      // Infer Monday from this dated header
      const dIdx = DAY_INDEX[h.split(/\s+/)[0]?.toUpperCase() ?? ''] ?? i;
      const year = dm[3] ? parseInt(dm[3]) : today.getFullYear();
      const slotDate = new Date(year, parseInt(dm[2]!) - 1, parseInt(dm[1]!));
      monday.setTime(slotDate.getTime() - dIdx * 86400000);
      monday.setHours(0, 0, 0, 0);
      console.log(`[sarool] Semaine inférée depuis header "${h}": lundi = ${monday.toLocaleDateString('fr-FR')}`);
      break;
    }
  }

  // Step 3: map each event to a date
  for (const ev of pageState.events) {
    const colIdx = ev.colIndex;

    const slotDay = new Date(monday);
    slotDay.setDate(monday.getDate() + colIdx);

    const offsetMinutes = pxPerMinute > 0 ? ev.top / pxPerMinute : 0;
    const totalMinutes = startMinutes + offsetMinutes;
    const durationMin = pxPerMinute > 0 ? Math.round(ev.height / pxPerMinute) : 60;

    slotDay.setHours(Math.floor(totalMinutes / 60), Math.round(totalMinutes % 60), 0, 0);

    slots.push({
      id: `col${colIdx}-top${ev.top}`,
      date: slotDay,
      duration: `${durationMin}min`,
      instructor: undefined,
    });
  }

  // Deduplicate by date+time, filter out bogus slots
  const seen = new Set<string>();
  return slots.filter(s => {
    if (isNaN(s.date.getTime())) return false;
    const hour = s.date.getHours();
    const durationMin = parseInt(s.duration ?? '60');
    // Filter: driving lessons are between 7h-21h and ≤ 4h duration
    if (hour < 7 || hour >= 21) return false;
    if (durationMin > 240) return false;
    // Deduplicate by day + hour + 15-min bucket (handles multiple monitors at same slot)
    const roundedMin = Math.round(s.date.getMinutes() / 15) * 15;
    const key = `${s.date.toDateString()}-${s.date.getHours()}h${roundedMin}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
