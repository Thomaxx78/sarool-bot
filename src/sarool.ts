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

export async function checkAvailableSlots(): Promise<Slot[]> {
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

    await page.waitForTimeout(2000);

    const slots = await extractSlots(page);
    console.log(`[sarool] ${slots.length} créneau(x) disponible(s) trouvé(s)`);

    const wanted = slots.filter(s => isWantedSlot(s.date));
    console.log(`[sarool] ${wanted.length} créneau(x) correspondant(s) aux critères`);

    return wanted;
  } finally {
    await page.close();
    await ctx.close();
    context = null;
  }
}

async function extractSlots(page: Page): Promise<Slot[]> {
  // Dump page HTML to understand structure on first run
  const slots: Slot[] = [];

  // Strategy 1: look for time slots as list items / cards / table rows
  // Common patterns in French driving school apps
  const slotSelectors = [
    '[class*="slot"]',
    '[class*="creneau"]',
    '[class*="dispo"]',
    '[class*="rdv"]',
    '[data-date]',
    '[data-slot]',
    '.fc-event',      // FullCalendar events
    '.calendar-event',
    'li[class*="item"]',
  ];

  for (const selector of slotSelectors) {
    const elements = await page.$$(selector);
    if (elements.length > 0) {
      console.log(`[sarool] Stratégie "${selector}": ${elements.length} éléments trouvés`);
      // Log the first 3 elements for debugging
      for (let i = 0; i < Math.min(3, elements.length); i++) {
        const html = await elements[i]!.evaluate((el: Element) => el.outerHTML);
        console.log(`[sarool] Element[${i}]: ${html.substring(0, 500)}`);
      }
      for (const el of elements) {
        const slot = await parseSlotElement(el, selector);
        if (slot) slots.push(slot);
      }
      if (slots.length > 0) return slots;
    }
  }

  // Strategy 2: look for JSON data in the page (SPA pattern)
  const jsonSlots = await page.evaluate((): unknown[] | null => {
    const scripts = Array.from((document as Document).querySelectorAll('script:not([src])'));
    for (const script of scripts) {
      const text = (script as HTMLScriptElement).textContent ?? '';
      if (text.includes('"date"') || text.includes('"start"') || text.includes('"debut"')) {
        try {
          const match = text.match(/\[[\s\S]*"(?:date|start|debut)"[\s\S]*\]/);
          if (match) return JSON.parse(match[0]) as unknown[];
        } catch {
          // ignore parse errors
        }
      }
    }
    return null;
  });

  if (jsonSlots && Array.isArray(jsonSlots)) {
    console.log(`[sarool] Stratégie JSON inline: ${jsonSlots.length} éléments`);
    for (const raw of jsonSlots) {
      const item = raw as Record<string, unknown>;
      const dateStr = (item['date'] ?? item['start'] ?? item['debut'] ?? item['dateDebut']) as string | undefined;
      if (dateStr) {
        const date = new Date(dateStr);
        if (!isNaN(date.getTime())) {
          slots.push({
            id: String(item['id'] ?? item['idSeance'] ?? date.getTime()),
            date,
            duration: (item['duree'] ?? item['duration']) as string | undefined,
            instructor: (item['moniteur'] ?? item['instructor'] ?? item['enseignant']) as string | undefined,
          });
        }
      }
    }
    if (slots.length > 0) return slots;
  }

  // If nothing found, log page content for debugging
  console.warn('[sarool] Aucun créneau trouvé avec les stratégies actuelles');
  console.warn('[sarool] URL actuelle:', page.url());

  // Save debug snapshot
  const html = await page.content();
  const fs = await import('fs/promises');
  await fs.writeFile('/tmp/sarool_debug.html', html);
  console.log('[sarool] HTML de debug sauvegardé dans /tmp/sarool_debug.html');

  return slots;
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
