import { config } from './config.js';
import type { Slot } from './sarool.js';

// ── Telegram ────────────────────────────────────────────────────────────────

async function telegramSend(message: string): Promise<boolean> {
  const { botToken, chatId } = config.telegram;
  if (!botToken || !chatId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' }),
    });
    if (res.ok) { console.log('[notifier] Telegram envoyé'); return true; }
    console.error(`[notifier] Telegram erreur: ${res.status}`);
    return false;
  } catch (err) {
    console.error(`[notifier] Telegram fetch failed: ${err}`);
    return false;
  }
}

// ── ntfy (fallback) ──────────────────────────────────────────────────────────

function stripEmoji(str: string): string {
  return str.replace(/[^\x00-\x7F]/g, '').trim();
}

async function ntfyPost(title: string, message: string, priority: 'default' | 'high' | 'urgent' = 'high'): Promise<void> {
  if (!config.ntfy.topic) throw new Error('NTFY_TOPIC non configuré');
  for (let attempt = 1; attempt <= 3; attempt++) {
    const response = await fetch(`https://ntfy.sh/${config.ntfy.topic}`, {
      method: 'POST',
      headers: {
        'Title': stripEmoji(title),
        'Priority': priority,
        'Tags': 'car',
        'Content-Type': 'text/plain; charset=utf-8',
      },
      body: message,
    });
    if (response.ok) return;
    if (response.status === 429 && attempt < 3) {
      await new Promise(r => setTimeout(r, 10000 * attempt));
      continue;
    }
    throw new Error(`ntfy error: ${response.status} ${response.statusText}`);
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function sendNotification(slots: Slot[]): Promise<void> {
  const lines = slots.map(s => {
    const dateStr = s.date.toLocaleString('fr-FR', {
      weekday: 'long', day: '2-digit', month: 'long',
      hour: '2-digit', minute: '2-digit',
    });
    return `${dateStr}${s.duration ? ` (${s.duration})` : ''}`;
  });

  const tgMsg = `🚗 <b>${slots.length} créneau(x) dispo sur Sarool !</b>\n\n${lines.join('\n')}\n\n<a href="https://www.sarool.fr/agenda">👉 Réserver maintenant</a>`;
  const ntfyBody = lines.join('\n') + '\n\nsarool.fr/agenda';

  const sent = await telegramSend(tgMsg);
  if (!sent) await ntfyPost(`🚗 ${slots.length} créneau(x) dispo sur Sarool !`, ntfyBody, 'urgent');
}

export async function sendError(error: string): Promise<void> {
  if (error.includes('429')) return;
  try {
    const sent = await telegramSend(`⚠️ SaroolBot erreur:\n${error}`);
    if (!sent) await ntfyPost('SaroolBot erreur', error, 'default');
  } catch {
    // ignore
  }
}

export async function sendBookingConfirmation(slot: Slot): Promise<void> {
  const dateStr = slot.date.toLocaleString('fr-FR', {
    weekday: 'long', day: '2-digit', month: 'long',
    hour: '2-digit', minute: '2-digit',
  });
  const tgMsg = `✅ <b>Créneau Sarool réservé !</b>\n${dateStr}`;
  const sent = await telegramSend(tgMsg);
  if (!sent) await ntfyPost('Créneau Sarool réservé !', dateStr, 'urgent');
}
