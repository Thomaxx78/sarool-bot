import dotenv from 'dotenv';
dotenv.config();

function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Variable d'environnement manquante: ${name}`);
  return val;
}

export const config = {
  sarool: {
    email: required('SAROOL_EMAIL'),
    password: required('SAROOL_PASSWORD'),
    baseUrl: 'https://www.sarool.fr',
  },
  ntfy: {
    topic: required('NTFY_TOPIC'),
  },
  autoBook: process.env.AUTO_BOOK === 'true',
  checkIntervalMinutes: parseInt(process.env.CHECK_INTERVAL_MINUTES ?? '5', 10),
};

// Créneaux recherchés :
// - Samedi (6) toute la journée
// - Dimanche (0) toute la journée
// - Tous les jours à partir de 18h
export function isWantedSlot(date: Date): boolean {
  const day = date.getDay(); // 0=dim, 6=sam
  const hour = date.getHours();

  if (day === 6 || day === 0) return true; // Week-end
  if (hour >= 18) return true;             // En soirée (tous les jours)
  return false;
}
