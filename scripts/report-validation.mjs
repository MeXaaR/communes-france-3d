import fs from 'node:fs/promises';
const read = async (file) =>
  JSON.parse(await fs.readFile(new URL('../validation/' + file, import.meta.url), 'utf8'));
const report = await read('communes-report.json'),
  build = await read('build-report.json'),
  ui = await read('interactions-report.json'),
  mobile = await read('mobile-report.json'),
  resilience = await read('resilience-report.json'),
  reference = await read('reference-after.json');
if (
  report.results.length !== 10 ||
  report.results.some((r) => r.error || Object.values(r.check).some((v) => !v))
)
  throw Error('Les dix validations ne sont pas toutes terminées avec succès.');
const rows = report.results.map((r) => {
  const d = r.diagnostics;
  return `| ${r.name} (${r.code}) | ${r.category} | ${d.buildingCount} | ${d.model.trees} | ${d.parcels.count} | ${d.urbanism.count ?? 'Indisponible'} | ${(d.timings.firstBuildingsMs / 1000).toFixed(1)} s | ${(d.timings.modelMs / 1000).toFixed(1)} s |`;
});
const maxAlignment = Math.max(
    ...report.results.flatMap((r) => r.diagnostics.treeAlignment.map((t) => t.difference)),
  ),
  maxHeap = Math.max(...report.results.map((r) => r.diagnostics.heapBytes ?? 0));
const text = `# Validation · Communes France en 3D

Date : ${report.date.slice(0, 10)}. Tests Chrome sur la compilation de production, via les services officiels réels. Les fichiers JSON et les captures de ce dossier sont des justificatifs locaux ; ils ne sont pas inclus dans le site compilé.

## Dix communes, dix scénarios validés

| Commune | Profil | Bâtiments récupérés | Arbres affichés | Parcelles | Zones d’urbanisme | Bâtiments disponibles | Détails prêts |
|---|---|---:|---:|---:|---:|---:|---:|
${rows.join('\n')}

Les nombres concernent le secteur consulté autour de la mairie, pas l’ensemble des bâtiments de la commune. Les détails sont renouvelés pendant la navigation. Les délais commencent après la réception du contour communal ; ils varient avec les services publics. Le chronomètre « bâtiments disponibles » mesure la réception et la préparation de la première géométrie 3D, pas le temps total depuis l’ouverture du navigateur.

Chaque scénario vérifie la commune et sa limite, des bâtiments aux hauteurs IGN, des coordonnées 3D finies, le relief, les parcelles, la recherche par référence cadastrale et le résultat de la consultation d’urbanisme. Les arrondissements de Paris et Lyon sont pris en charge dans la recherche cadastrale. Les géométries sont découpées à la limite communale ; aucun bâtiment ou arbre contrôlé n’est placé à l’extérieur. Sur les 30 premiers arbres de chaque vue, l’écart maximal avec le terrain affiché après stabilisation est de ${maxAlignment.toFixed(3)} m.

Biert : les services consultés n’ont renvoyé aucun zonage sur le secteur. L’interface indique cette absence de résultat ; elle ne conclut pas à l’absence de règles d’urbanisme. Massat utilise le repli officiel de la DDT de l’Ariège. Les autres communes récupèrent leurs données depuis le Géoportail de l’urbanisme. Les liens vers les règlements et les annexes sont construits à partir des identifiants du document et des fichiers fournis par le GPU lorsque URLFIC est vide.

## Navigation et affichage

- Recherche de communes homonymes avec le département.
- Recherche du hameau de Balmes, puis centrage sur le résultat.
- Affichage et masquage des détails 3D, des parcelles et de l’urbanisme.
- Clic sur une zone de PLU : code, date, source et accès au règlement officiel.
- Rotation, inclinaison, vue communale et retour au centre.
- Déplacement vers un second secteur de Massat : nouveau chargement des détails.
- Sélections rapides Paris → Foix → Massat : aucun résultat d’une ancienne sélection ne remplace la commune active.
- Vue mobile 390 × 844, écran tactile émulé : outils repliables, cadastre accessible et aucun débordement horizontal. Ce contrôle ne mesure pas les performances d’un téléphone physique.

${ui.errors.length} erreur JavaScript pendant les essais d’interaction. Rotation sur cette machine : intervalle médian entre callbacks d’animation ${ui.fps.medianFrameMs.toFixed(1)} ms, percentile 95 ${ui.fps.p95FrameMs.toFixed(1)} ms, soit environ 60 images/s. Cela ne constitue pas une garantie pour tous les appareils. Le tas JavaScript observé atteint environ ${(maxHeap / 1e6).toFixed(0)} Mo au maximum pendant la série ; il n’inclut pas toute la mémoire GPU ni tous les workers.

## Reprise sur erreur et géométrie

Une indisponibilité simulée du service de limites produit un message explicite et efface les anciens bâtiments. Une panne simulée du GPU laisse les couches de terrain et de bâtiments utilisables. La sélection suivante retrouve le fonctionnement normal : ${resilience.recovery.buildings} bâtiments et ${resilience.recovery.urbanism} zones pour Massat, sans erreur JavaScript.

Onze tests automatisés couvrent les limites et les trous des polygones, les hauteurs absentes, les bâtiments élevés, les altitudes négatives, les cours intérieures, le placement des arbres et sa stabilité au déplacement, la recherche cadastrale, la pagination WFS et les liens des documents PLUi. Ils passent tous. La compilation TypeScript et Vite passe. L’audit npm n’a signalé aucune vulnérabilité après la mise à jour de Vite.

## Données hébergées et conservation

Le catalogue contient 34 969 communes. Le paquet de production fait ${(build.rawBytes / 1e6).toFixed(2)} Mo bruts ; la somme des fichiers compressés en gzip est estimée à ${(build.gzipBytes / 1e6).toFixed(2)} Mo si l’hébergeur active cette compression. Le navigateur ne charge pas nécessairement tous les décodeurs au premier affichage.

Le paquet contient uniquement le catalogue, le code compilé, les styles et l’icône de l’application. Les données géographiques sont demandées directement aux domaines suivants : ${report.remoteHosts.filter(Boolean).join(', ')}. Aucun backend géographique, jeton privé, fichier municipal précompilé ou stockage de carte sur notre serveur n’est nécessaire. Les caches applicatifs restent bornés en mémoire du navigateur ; le cache HTTP ordinaire suit les en-têtes des producteurs.

L’ancienne application Massat est conservée : commit inchangé (${reference.headUnchanged}), état Git inchangé (${reference.statusUnchanged}), ${reference.modifiedSourceFiles.length} fichier source modifié. La nouvelle application n’a pas été publiée.

## Limites du résultat

Le catalogue est national ; les essais détaillés portent sur les dix communes ci-dessus. La couverture et les millésimes des services ne sont pas identiques partout. Les toitures, fenêtres et arbres sont des modèles indicatifs, et non des relevés individuels. Les contours et hauteurs sources restent distincts de cette représentation. Les très grandes communes sont explorées progressivement, sans chargement intégral de leur géométrie au démarrage.

Les documents réglementaires et leurs annexes demeurent les références pour l’urbanisme. Une donnée absente ou un service indisponible n’est jamais assimilé à une absence de réglementation.
`;
await fs.writeFile(new URL('../validation/RAPPORT.md', import.meta.url), text);
console.log('Rapport final rédigé.');
