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
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
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

const WEEKS_AHEAD = parseInt(process.env.WEEKS_AHEAD ?? '8', 10);

// Detect the Monday date of the week currently displayed in DayPilot
async function detectDisplayedMonday(page: Page): Promise<Date> {
  const info = await page.evaluate((): {
    isoDatesInScripts: string[];
    hiddenInputDates: string[];
    eventDataAttrs: string[];
    dpJsKeys: string[];
  } => {
    // Method 1: scan inline scripts for ISO date patterns (DayPilot serializes events as JSON)
    const isoDatesInScripts: string[] = [];
    document.querySelectorAll('script').forEach(s => {
      const matches = (s.textContent ?? '').match(/202[5-9]-\d{2}-\d{2}T\d{2}:\d{2}/g) ?? [];
      isoDatesInScripts.push(...matches);
    });

    // Method 2: hidden input fields that might carry the current date
    const hiddenInputDates = Array.from(document.querySelectorAll('input[type="hidden"]'))
      .map(el => `${(el as HTMLInputElement).name}=${(el as HTMLInputElement).value}`)
      .filter(v => /202[5-9]/.test(v) || /\d{8}/.test(v))
      .slice(0, 10);

    // Method 3: data attributes on event elements
    const eventDataAttrs = Array.from(document.querySelectorAll('.F3_plncal_eventDisposE'))
      .flatMap(el => Array.from(el.attributes).map(a => `${a.name}=${a.value}`))
      .filter(a => /date|start|end|time/i.test(a));

    // Method 4: DayPilot JS global objects
    const dpJsKeys = Object.getOwnPropertyNames(window)
      .filter(k => /daypilot|plncal|F3/i.test(k))
      .slice(0, 10);

    return { isoDatesInScripts: isoDatesInScripts.slice(0, 20), hiddenInputDates, eventDataAttrs, dpJsKeys };
  });

  console.log(`[sarool] ISO dates in scripts: ${info.isoDatesInScripts.slice(0, 5).join(' | ')}`);
  console.log(`[sarool] Hidden date inputs: ${info.hiddenInputDates.join(' | ')}`);
  console.log(`[sarool] Event data attrs: ${info.eventDataAttrs.join(' | ')}`);
  console.log(`[sarool] DayPilot JS keys: ${info.dpJsKeys.join(' | ')}`);

  // Extract first ISO date from scripts — this is the most reliable source
  if (info.isoDatesInScripts.length > 0) {
    const isoStr = info.isoDatesInScripts[0]!;
    const d = new Date(isoStr);
    if (!isNaN(d.getTime())) {
      const dow = d.getDay();
      const monday = new Date(d);
      monday.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
      monday.setHours(0, 0, 0, 0);
      console.log(`[sarool] Semaine détectée depuis script: lundi = ${monday.toLocaleDateString('fr-FR')}`);
      return monday;
    }
  }

  // Try reading DayPilot's JavaScript state directly
  const dpState = await page.evaluate((): string[] => {
    const dp = (window as any).DayPilot;
    if (!dp) return [];
    const results: string[] = [];
    // Check Calendar instances
    const cals = dp.Calendar?.instances ?? [];
    for (const cal of cals.slice(0, 3)) {
      const start = cal.startDate ?? cal.visibleStart?.();
      if (start) results.push(`cal.startDate=${JSON.stringify(start).slice(0, 50)}`);
      const events = cal.events?.list ?? [];
      for (const ev of events.slice(0, 3)) {
        results.push(`ev.start=${JSON.stringify(ev.start ?? ev.data?.start).slice(0, 30)}`);
      }
    }
    return results;
  });
  if (dpState.length > 0) {
    console.log(`[sarool] DayPilot JS state: ${dpState.join(' | ')}`);
  }

  // Fallback: next Monday if today is Sunday, otherwise this week's Monday
  const today = new Date();
  const dow = today.getDay();
  const monday = new Date(today);
  // dow=0 (Sun): go to next Monday (+1); dow=1 (Mon): stay; others: go back to Monday
  monday.setDate(today.getDate() - (dow === 0 ? -1 : dow - 1));
  monday.setHours(0, 0, 0, 0);
  console.log(`[sarool] Fallback semaine: lundi = ${monday.toLocaleDateString('fr-FR')}`);
  return monday;
}

// Navigate DayPilot to the next week — returns true if succeeded
async function navigateToNextWeek(page: Page): Promise<{ success: boolean; allButtons: string[] }> {
  // Method 1: DOM selectors
  const selectors = [
    '.F3_plncal_nav_next', '[class*="nav_next"]', '[class*="plncal_next"]',
    'input[value=">"]', 'input[value=">>"]', 'input[value=">|"]',
    '[onclick*="next"]', '[onclick*="Next"]', '[class*="F3_plncal_nav"]',
  ];
  for (const sel of selectors) {
    const el = await page.$(sel);
    if (el) {
      console.log(`[sarool] Nav: bouton trouvé "${sel}"`);
      await el.click();
      return { success: true, allButtons: [] };
    }
  }

  // Method 2: DayPilot JavaScript API
  const jsNavigated = await page.evaluate((): boolean => {
    const dp = (window as any).DayPilot;
    if (!dp) return false;
    const instances = dp.Calendar?.instances ?? [];
    for (const cal of instances) {
      if (typeof cal.navigate === 'function') { cal.navigate('Next'); return true; }
      if (typeof cal.goNext === 'function') { cal.goNext(); return true; }
      if (typeof cal.commandCallBack === 'function') { cal.commandCallBack('navigate', { offset: 1 }); return true; }
    }
    // Try __doPostBack with DayPilot-style args
    const doPostBack = (window as any).__doPostBack;
    if (typeof doPostBack === 'function') {
      // Find DayPilot control ID
      const calEl = document.querySelector('[id*="plncal"], [id*="DayPilot"]');
      if (calEl) { doPostBack(calEl.id, 'Navigate:Next'); return true; }
    }
    return false;
  });
  if (jsNavigated) {
    console.log('[sarool] Nav: DayPilot JS navigation appelée');
    return { success: true, allButtons: [] };
  }

  // Method 3: coordinate click on the right side of the calendar header
  const navCoord = await page.evaluate((): { x: number; y: number } | null => {
    const corner = document.querySelector('.F3_plncal_corner') as HTMLElement | null;
    if (!corner) return null;
    const r = corner.getBoundingClientRect();
    // The "next" arrow is usually just to the RIGHT of the corner header
    return { x: r.right + 30, y: r.top + r.height / 2 };
  });
  if (navCoord) {
    console.log(`[sarool] Nav: clic coordonnée x=${Math.round(navCoord.x)} y=${Math.round(navCoord.y)}`);
    await page.mouse.click(navCoord.x, navCoord.y);
    return { success: true, allButtons: [] };
  }

  // Log all F3_plncal elements for diagnosis
  const allButtons = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[class*="F3_plncal"]'))
      .map(el => `${el.tagName}.${(el.className + '').replace(/\s+/g, '.').slice(0, 60)}`)
      .slice(0, 30)
  );
  return { success: false, allButtons };
}

export async function checkAvailableSlots(): Promise<{ slots: Slot[]; wanted: Slot[]; debugInfo: { detectedMonday: string; ajaxDates: string[]; nextBtnFound: boolean; navButtons: string[]; htmlDates: string[] } }> {
  const ctx = await newContext();
  const page = await ctx.newPage();

  // Intercept DayPilot AJAX responses to capture real event dates
  const ajaxIsoDates: string[] = [];
  page.on('response', async response => {
    try {
      const ct = response.headers()['content-type'] ?? '';
      if (!ct.includes('json') && !ct.includes('text')) return;
      const text = await response.text();
      const matches = text.match(/202[5-9]-\d{2}-\d{2}T\d{2}:\d{2}/g) ?? [];
      if (matches.length > 0) ajaxIsoDates.push(...matches);
    } catch { /* ignore */ }
  });

  try {
    const loggedIn = await login(page);
    if (!loggedIn) throw new Error('Connexion Sarool échouée');

    console.log('[sarool] Récupération des disponibilités...');
    await page.goto(`${BASE}/agenda/Disponibilites`, { waitUntil: 'domcontentloaded' });

    // Fallback: try /agenda if Disponibilites doesn't work
    if (page.url().includes('connexion') || page.url() === `${BASE}/`) {
      await page.goto(`${BASE}/agenda`, { waitUntil: 'domcontentloaded' });
    }

    // Wait for DayPilot to render
    await page.waitForSelector('.F3_plncal_eventDisposE, .F3_plncal_main', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(3000);

    console.log(`[sarool] ISO dates capturées AJAX: ${[...new Set(ajaxIsoDates)].slice(0, 10).join(' | ')}`);

    // Try AJAX dates first, then fall back to DOM scanning
    let displayedMonday: Date;
    if (ajaxIsoDates.length > 0) {
      const d = new Date(ajaxIsoDates[0]!);
      const dow = d.getDay();
      displayedMonday = new Date(d);
      displayedMonday.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
      displayedMonday.setHours(0, 0, 0, 0);
      console.log(`[sarool] Semaine détectée depuis AJAX: lundi = ${displayedMonday.toLocaleDateString('fr-FR')}`);
    } else {
      displayedMonday = await detectDisplayedMonday(page);
    }

    // Scan full HTML for any date pattern (DayPilot may use various formats)
    const htmlDates = await page.evaluate((): string[] => {
      const html = document.documentElement.innerHTML; // includes head+body
      const patterns = [
        /202[5-9]-\d{2}-\d{2}/g,          // ISO: 2026-12-04
        /\d{2}\/\d{2}\/202[5-9]/g,         // FR: 04/12/2026
        /202[5-9]\/\d{2}\/\d{2}/g,         // US: 2026/12/04
        /new Date\(\s*202[5-9]\s*,\s*\d+\s*,\s*\d+/g,  // JS: new Date(2026, 11, 4)
        /202[5-9]\d{4}/g,                   // yyyymmdd: 20261204
        /"start"\s*:\s*"[^"]*202[5-9]/g,   // JSON start field
        /"date"\s*:\s*"[^"]*202[5-9]/g,    // JSON date field
      ];
      const found = new Set<string>();
      patterns.forEach(p => (html.match(p) ?? []).forEach(m => found.add(m)));
      return [...found].slice(0, 15);
    });
    console.log(`[sarool] Dates trouvées dans HTML: ${htmlDates.join(' | ')}`);

    const allSlots: Slot[] = [];
    let nextBtnFound = true;
    let navButtonsForDebug: string[] = [];

    for (let week = 0; week < WEEKS_AHEAD; week++) {
      if (week > 0) {
        const { success, allButtons } = await navigateToNextWeek(page);
        if (allButtons.length > 0) navButtonsForDebug = allButtons;
        if (!success) {
          nextBtnFound = false;
          console.log(`[sarool] Navigation semaine suivante impossible à semaine ${week}, arrêt`);
          break;
        }
        nextBtnFound = true;
        await page.waitForTimeout(2500);
      }

      // Compute the Monday for this week relative to what DayPilot initially showed
      const weekMonday = new Date(displayedMonday);
      weekMonday.setDate(displayedMonday.getDate() + week * 7);

      const weekSlots = await extractSlots(page, weekMonday);
      console.log(`[sarool] Semaine +${week} (${weekMonday.toLocaleDateString('fr-FR')}): ${weekSlots.length} créneau(x)`);
      weekSlots.forEach(s => console.log(`[sarool]   → ${s.date.toLocaleString('fr-FR')} (${s.duration ?? '?'})`));
      allSlots.push(...weekSlots);
    }

    // Global deduplicate across all weeks
    const seen = new Set<string>();
    const slots = allSlots.filter(s => {
      const roundedMin = Math.round(s.date.getMinutes() / 15) * 15;
      const key = `${s.date.toDateString()}-${s.date.getHours()}h${roundedMin}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    console.log(`[sarool] ${slots.length} créneau(x) total sur ${WEEKS_AHEAD} semaines`);

    const wanted = slots.filter(s => isWantedSlot(s.date));
    console.log(`[sarool] ${wanted.length} créneau(x) correspondant(s) aux critères (week-end / ≥18h)`);

    return {
      slots,
      wanted,
      debugInfo: {
        detectedMonday: displayedMonday.toLocaleDateString('fr-FR'),
        ajaxDates: [...new Set(ajaxIsoDates)].slice(0, 5),
        nextBtnFound,
        navButtons: navButtonsForDebug,
        htmlDates,
      },
    };
  } finally {
    await page.close();
    await ctx.close();
    context = null;
  }
}

async function extractSlots(page: Page, monday: Date): Promise<Slot[]> {
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

  // Step 2: build time scale from row headers
  // Sarool shows military time without separator: "600"=6h00, "1300"=13h00
  const slots: Slot[] = [];
  const rowTimes: number[] = pageState.rowHeaders
    .map(h => {
      const m = h.match(/(\d+)h?:?(\d*)/);
      if (!m) return -1;
      const num = parseInt(m[1]!);
      // HHMM format (e.g. 600=06:00, 1300=13:00) — no 'h' separator and value >= 100
      if (num >= 100 && !h.includes('h') && !h.includes(':') && (m[2] ?? '') === '') {
        return Math.floor(num / 100) * 60 + (num % 100);
      }
      return num * 60 + parseInt(m[2] || '0');
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

  // Step 3: map each event to a date using the provided monday
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
