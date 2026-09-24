import fs from 'node:fs/promises';
const source =
  'https://geo.api.gouv.fr/communes?fields=nom,code,codesPostaux,codeDepartement,population,centre,mairie,surface&format=json';
const response = await fetch(source);
if (!response.ok) throw Error(`Catalogue : HTTP ${response.status}`);
const communes = await response.json();
if (!Array.isArray(communes) || communes.length < 30000) throw Error('Catalogue incomplet');
const rows = communes.map((c) => [
  c.code,
  c.nom,
  c.codeDepartement,
  c.population ?? null,
  c.surface ?? 0,
  c.mairie?.coordinates ?? null,
  c.centre?.coordinates ?? null,
  c.codesPostaux ?? [],
]);
if (rows.some((r) => !r[5] && !r[6])) throw Error('Coordonnées manquantes dans le catalogue');
await fs.writeFile(
  new URL('../public/communes.json', import.meta.url),
  JSON.stringify({
    updatedAt: new Date().toISOString().slice(0, 10),
    source: 'https://geo.api.gouv.fr/communes',
    fields: [
      'code',
      'name',
      'department',
      'population',
      'areaHa',
      'townHall',
      'center',
      'postcodes',
    ],
    rows,
  }),
);
console.log(`${rows.length} communes mises à jour.`);
