import cron from 'node-cron';
import express from 'express';
import { config } from './config.js';
import { checkAvailableSlots, bookSlot, closeBrowser, type Slot } from './sarool.js';
import { sendNotification, sendBookingConfirmation, sendError } from './notifier.js';

const notifiedSlotIds = new Set<string>();
let isRunning = false;
let lastCheck: Date | null = null;
let lastStatus = 'En attente du premier check...';
let lastDebug: { totalSlots: number; wantedSlots: number; sample: string[] } = { totalSlots: 0, wantedSlots: 0, sample: [] };

async function check(): Promise<void> {
  if (isRunning) return;
  isRunning = true;

  try {
    lastCheck = new Date();
    console.log(`\n[main] ⏰ ${lastCheck.toLocaleString('fr-FR')} — Vérification des créneaux...`);

    const { slots, wanted } = await checkAvailableSlots();
    lastDebug = {
      totalSlots: slots.length,
      wantedSlots: wanted.length,
      sample: slots.slice(0, 5).map(s => s.date.toLocaleString('fr-FR') + (s.duration ? ` (${s.duration})` : '')),
    };

    const newSlots = wanted.filter(s => !notifiedSlotIds.has(s.id));

    if (newSlots.length === 0) {
      lastStatus = `Aucun créneau voulu (${slots.length} total trouvé) — ${lastCheck.toLocaleString('fr-FR')}`;
      console.log(`[main] Aucun créneau correspondant (${slots.length} slots trouvés au total)`);
      return;
    }

    console.log(`[main] 🎯 ${newSlots.length} nouveau(x) créneau(x) trouvé(s) !`);

    // DEBUG: skip notifications temporarily to avoid ntfy rate limit
    console.log(`[main] DEBUG: ${newSlots.length} créneau(x) voulu(s), notification désactivée temporairement`);
    newSlots.forEach(s => console.log(`[main]   → ${s.date.toLocaleString('fr-FR')} (${s.duration ?? '?'})`));
    newSlots.forEach(s => notifiedSlotIds.add(s.id));
    return;

    if (config.autoBook) {
      const target = newSlots[0]!;
      console.log(`[main] Tentative de réservation: ${target.date.toLocaleString('fr-FR')}`);

      const booked = await bookSlot(target);
      if (booked) {
        await sendBookingConfirmation(target);
        notifiedSlotIds.add(target.id);
        lastStatus = `✅ Réservé: ${target.date.toLocaleString('fr-FR')}`;
      } else {
        await sendNotification(newSlots);
        newSlots.forEach(s => notifiedSlotIds.add(s.id));
        lastStatus = `⚠️ Résa auto échouée — alerte envoyée`;
      }
    } else {
      await sendNotification(newSlots);
      newSlots.forEach(s => notifiedSlotIds.add(s.id));
      lastStatus = `📬 ${newSlots.length} créneau(x) notifié(s)`;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    lastStatus = `❌ Erreur: ${msg}`;
    console.error(`[main] ❌ Erreur: ${msg}`);
    await sendError(msg);
  } finally {
    isRunning = false;
  }
}

function startHttpServer(): void {
  const app = express();
  const port = parseInt(process.env['PORT'] ?? '3000', 10);

  app.get('/', (_req, res) => {
    res.json({
      service: 'SaroolBot',
      status: 'running',
      lastCheck: lastCheck?.toISOString() ?? null,
      lastStatus,
      autoBook: config.autoBook,
      debug: lastDebug,
    });
  });

  app.get('/health', (_req, res) => res.send('ok'));

  app.listen(port, () => {
    console.log(`[http] Serveur démarré sur le port ${port}`);
  });
}

async function main(): Promise<void> {
  console.log('🚗 SaroolBot démarré');
  console.log(`   Mode: ${config.autoBook ? 'Réservation automatique' : 'Notification seulement'}`);
  console.log(`   Intervalle: ${config.checkIntervalMinutes} min`);
  console.log(`   Critères: Samedi, Dimanche, et tous les jours ≥ 18h`);

  startHttpServer();
  await check();

  const cronExpr = `*/${config.checkIntervalMinutes} * * * *`;
  cron.schedule(cronExpr, check);
  console.log(`[main] Surveillance active (cron: ${cronExpr})`);
}

process.on('SIGINT', async () => {
  console.log('\n[main] Arrêt...');
  await closeBrowser();
  process.exit(0);
});

main().catch(err => {
  console.error('Erreur fatale:', err);
  process.exit(1);
});
