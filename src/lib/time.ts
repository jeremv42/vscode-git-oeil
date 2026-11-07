const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

/** « il y a 3 jours », « hier », « à l'instant »… */
export function relativeTime(epochSeconds: number, nowMs: number = Date.now(), locale = 'fr'): string {
  const diff = Math.round(nowMs / 1000 - epochSeconds);
  const abs = Math.abs(diff);
  if (abs < 60) return locale.startsWith('fr') ? "à l'instant" : 'just now';
  const fmt = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, seconds] of UNITS) {
    if (abs >= seconds) return fmt.format(-Math.trunc(diff / seconds), unit);
  }
  return fmt.format(0, 'minute');
}
