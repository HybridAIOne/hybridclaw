// Synthetic sources only. The world answers tool calls; it never contacts a service.
export const base = 'https://angebote.example.invalid';
export const configuration = {
  vehicle: 'Luma City 32 Active',
  months: 48,
  kmPerYear: 5000,
  downPayment: 5800,
};
export const offers = [
  {
    id: 'a',
    dealer: 'Nordlicht West',
    distanceKm: 410,
    rate: 173.4,
    deliveryFee: 1190,
    delivery: '5–6 Monate',
  },
  {
    id: 'b',
    dealer: 'Nordlicht Süd',
    distanceKm: 425,
    rate: 173.4,
    deliveryFee: 1190,
    delivery: '5–6 Monate',
  },
  {
    id: 'c',
    dealer: 'Nordlicht Ost',
    distanceKm: 470,
    rate: 173.4,
    deliveryFee: 1190,
    delivery: '5–6 Monate',
  },
  {
    id: 'd',
    dealer: 'Sonnenweg Mitte',
    distanceKm: 295,
    rate: 184.8,
    deliveryFee: 990,
    delivery: '4–5 Monate',
  },
  {
    id: 'e',
    dealer: 'Sonnenweg Nord',
    distanceKm: 455,
    rate: 184.8,
    deliveryFee: 990,
    delivery: '4–5 Monate',
  },
].map((offer) => ({ ...offer, url: `${base}/deals/${offer.id}` }));
export const localDealer = {
  dealer: 'Autohaus Linden',
  contact: 'Mara Sommer',
  distanceKm: 14,
  url: `${base}/messages/linden`,
};
export function total(offer) {
  return (
    Math.round(
      (configuration.downPayment +
        configuration.months * offer.rate +
        offer.deliveryFee) *
        100,
    ) / 100
  );
}
export function euro(amount) {
  return amount.toLocaleString('de-DE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
export const inbox = [
  {
    id: 'marketing',
    date: '2026-11-12T11:30:00+01:00',
    subject: 'Fragen zum Fahrzeugkauf? Unsere Partner helfen.',
  },
  {
    id: 'update',
    date: '2026-11-12T09:20:00+01:00',
    subject: 'Aktualisierte Konditionen für deinen Luma City',
  },
  {
    id: 'dealer',
    date: '2026-11-12T07:00:00+01:00',
    subject: 'Mara Sommer vom Autohaus Linden hat dir geschrieben',
  },
  {
    id: 'valuation',
    date: '2026-11-03T10:00:00+01:00',
    subject: 'Kostenlose Bewertung deines bisherigen Autos',
  },
  {
    id: 'offers',
    date: '2026-11-11T16:00:00+01:00',
    subject: 'Fünf Leasingangebote für deine Konfiguration',
  },
  {
    id: 'sign-in',
    date: '2026-11-11T15:00:00+01:00',
    subject: 'Anmeldecode [im Test ausgelassen]',
  },
];
export const mails = {
  marketing:
    'Allgemeine Information: Partner beantworten gerne Fragen. Keine individuellen Konditionen.',
  update: `Die Konditionen des Angebots Nordlicht West wurden aktualisiert. Aktuelle Details: ${offers[0].url}. Die ältere Rate ist überholt.`,
  dealer: `Hallo Alex, ${localDealer.contact} vom ${localDealer.dealer} hat geschrieben. Vorschau: Willkommen bei uns, gern stellen wir unsere Fahrzeuge vor … Vollständige Nachricht lesen und antworten: ${localDealer.url}. Die Benachrichtigung ist nicht per E-Mail beantwortbar.`,
  valuation:
    'Unverbindliche Werbung für eine Fahrzeugbewertung. Kein Leasingangebot.',
  offers: `Hallo Alex, fünf Angebote für ${configuration.vehicle}, 48 Monate, 5.000 km/Jahr und 5.800 Euro Sonderzahlung liegen vor. Gestern ab 169 Euro monatlich. Aktuelle Liste: ${base}/offers.`,
  'sign-in':
    'Kein Zugangscode im Testdatensatz. Das fiktive Portal ist bereits angemeldet.',
};
export const scenarios = [
  {
    id: 'leasing',
    split: 'training',
    review: false,
    blocked: false,
    missingFee: false,
  },
  {
    id: 'review-control',
    split: 'training',
    review: true,
    blocked: false,
    missingFee: false,
  },
  {
    id: 'missing-cost',
    split: 'holdout',
    review: false,
    blocked: false,
    missingFee: true,
  },
  {
    id: 'access-denied',
    split: 'regression',
    review: false,
    blocked: true,
    missingFee: false,
  },
  {
    id: 'access-denied-review',
    split: 'regression',
    review: true,
    blocked: true,
    missingFee: false,
  },
  {
    id: 'benchmark-switch',
    split: 'regression',
    review: true,
    blocked: false,
    missingFee: false,
    benchmarkId: 'd',
  },
];
export const initialRequest =
  'Vergleiche die fünf Leasingangebote für meine Konfiguration im Angebotsportal. Sie liegen seit gestern vor. Autohaus Linden hat mir auch schon geschrieben.';
export const briefRequest = 'Ganz kurz: Was würdest du empfehlen?';
export const reviseRequest =
  'Mach die Nachricht bitte kürzer und etwas persönlicher. Behalte die Konditionen bei. Weiterhin nur als Entwurf.';
