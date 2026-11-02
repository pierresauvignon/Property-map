/* ---------------------------------------------------------------------------
 *  properties.js — the starting data. `node api/seed.mjs` loads it into the
 *  table; the app also runs straight from this file with no backend at all.
 *
 *  These six are made up: replace them with your own. Once the app is
 *  deployed, most people add listings from the app itself (or with the
 *  bookmarklet / extension from the listing page) rather than here.
 *
 *  price / surface / rooms / chambres / terrain: numbers or null. The pins,
 *  EUR/m2 figures, sorting and averages all follow from them.
 *
 *  geo: 'dms'            exact — the point was dropped by hand
 *       'geocode'        street address resolved via OpenStreetMap
 *       'geocode-town'   only the town resolved — position is approximate
 *       'geocode-street' street resolved, house number not found
 *  Approximate points are drawn with a hollow marker.
 *
 *  photo: a listing image URL, or null for a placeholder.
 *  listing: 'live' or 'gone' (the advert has been taken down).
 * ------------------------------------------------------------------------- */

window.PROPERTIES = [
  {
    id: 'p01',
    name: 'Maison de ville, rue des Tilleuls',
    address: '33000 Bordeaux',
    lat: 44.8469, lng: -0.5862, geo: 'dms',
    price: 485000, surface: 128, rooms: 5,
    photo: null,
    url: '',
    note: 'Exemple : jardin plein sud, travaux de cuisine à prévoir.',
    type: 'Maison',
    chambres: 3,
    terrain: 140,
    listing: 'live',
    town: 'Bordeaux',
    kind: 'property',
  },
  {
    id: 'p02',
    name: 'Échoppe double, Saint-Augustin',
    address: '33000 Bordeaux',
    lat: 44.8362, lng: -0.6042, geo: 'geocode',
    price: 612000, surface: 154, rooms: 6,
    photo: null,
    url: '',
    note: '',
    type: 'Maison',
    chambres: 4,
    terrain: 210,
    listing: 'live',
    town: 'Bordeaux',
    kind: 'property',
  },
  {
    id: 'p03',
    name: 'Villa avec piscine',
    address: '33600 Pessac',
    lat: 44.8061, lng: -0.6312, geo: 'geocode',
    price: 739000, surface: 196, rooms: 7,
    photo: null,
    url: '',
    note: 'Exemple : à revoir après la visite du samedi.',
    type: 'Maison',
    chambres: 5,
    terrain: 820,
    listing: 'live',
    town: 'Pessac',
    kind: 'property',
  },
  {
    id: 'p04',
    name: 'Maison années 30',
    address: '33200 Le Bouscat',
    lat: 44.865, lng: -0.5995, geo: 'geocode-street',
    price: 558000, surface: 141, rooms: 5,
    photo: null,
    url: '',
    note: '',
    type: 'Maison',
    chambres: 3,
    terrain: 390,
    listing: 'live',
    town: 'Le Bouscat',
    kind: 'property',
  },
  {
    id: 'p05',
    name: 'Terrain constructible',
    address: '33170 Gradignan',
    lat: 44.7726, lng: -0.6158, geo: 'geocode-town',
    price: 189000, surface: null, rooms: null,
    photo: null,
    url: '',
    note: '',
    type: 'Terrain',
    chambres: null,
    terrain: 1150,
    listing: 'live',
    town: 'Gradignan',
    kind: 'land',
  },
  {
    id: 'p06',
    name: 'Longère à rénover',
    address: '33160 Saint-Médard-en-Jalles',
    lat: 44.896, lng: -0.718, geo: 'geocode',
    price: 345000, surface: 165, rooms: 6,
    photo: null,
    url: '',
    note: 'Exemple : annonce retirée, gardée pour comparer les prix.',
    type: 'Maison',
    chambres: 4,
    terrain: 2400,
    listing: 'gone',
    town: 'Saint-Médard-en-Jalles',
    kind: 'property',
  },
];
