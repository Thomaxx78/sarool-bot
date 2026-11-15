import { config } from './config.js';
import type { Slot } from './sarool.js';

function stripEmoji(str: string): string {
  // HTTP headers only support ASCII — remove emoji
  return str.replace(/[^\x00-\x7F]/g, '').trim();
}

async function ntfyPost(title: string, message: string, priority: 'default' | 'high' | 'urgent' = 'high'): Promise<void> {
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
  if (!response.ok) {
    throw new Error(`ntfy error: ${response.status} ${response.statusText}`);
  }
}

export async function sendNotification(slots: Slot[]): Promise<void> {
  const lines = slots.map(s => {
    const dateStr = s.date.toLocaleString('fr-FR', {
      weekday: 'long', day: '2-digit', month: 'long',
      hour: '2-digit', minute: '2-digit',
    });
    return `${dateStr}${s.duration ? ` (${s.duration})` : ''}${s.instructor ? ` — ${s.instructor}` : ''}`;
  });

  const body = lines.join('\n') + '\n\nsarool.fr/agenda';
  await ntfyPost(`🚗 ${slots.length} créneau(x) dispo sur Sarool !`, body, 'urgent');
  console.log(`[notifier] Notification ntfy envoyée pour ${slots.length} créneau(x)`);
}

export async function sendError(error: string): Promise<void> {
  try {
    await ntfyPost('⚠️ SaroolBot erreur', error, 'default');
  } catch {
    // ignore notification errors
  }
}

export async function sendBookingConfirmation(slot: Slot): Promise<void> {
  const dateStr = slot.date.toLocaleString('fr-FR', {
    weekday: 'long', day: '2-digit', month: 'long',
    hour: '2-digit', minute: '2-digit',
  });
  const body = `${dateStr}${slot.instructor ? `\n${slot.instructor}` : ''}`;
  await ntfyPost('✅ Créneau Sarool réservé !', body, 'urgent');
  console.log(`[notifier] Confirmation de réservation ntfy envoyée`);
}
