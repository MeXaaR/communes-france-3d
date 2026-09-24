# Validation · Communes France en 3D

Date : 2026-09-21. Tests Chrome sur la compilation de production, via les services officiels réels. Les fichiers JSON et les captures de ce dossier sont des justificatifs locaux ; ils ne sont pas inclus dans le site compilé.

## Dix communes, dix scénarios validés

| Commune | Profil | Bâtiments récupérés | Arbres affichés | Parcelles | Zones d’urbanisme | Bâtiments disponibles | Détails prêts |
|---|---|---:|---:|---:|---:|---:|---:|
| Biert (09057) | Village | 357 | 4183 | 1368 | 0 | 0.7 s | 20.5 s |
| Massat (09182) | Village de montagne | 692 | 1320 | 1332 | 124 | 0.9 s | 22.7 s |
| Saint-Cirq-Lapopie (46256) | Petit village | 250 | 3900 | 653 | 21 | 0.6 s | 20.0 s |
| Foix (09122) | Petite ville | 1860 | 674 | 2113 | 53 | 3.1 s | 20.8 s |
| Albi (81004) | Ville moyenne | 2114 | 339 | 2367 | 46 | 5.0 s | 21.9 s |
| La Rochelle (17300) | Ville moyenne littorale | 3128 | 226 | 2797 | 54 | 12.7 s | 42.2 s |
| Chamonix-Mont-Blanc (74056) | Commune alpine | 1057 | 330 | 1583 | 89 | 5.0 s | 23.5 s |
| Paris (75056) | Grande ville | 1252 | 105 | 1355 | 104 | 3.0 s | 21.4 s |
| Lyon (69123) | Grande ville | 1326 | 230 | 1611 | 89 | 3.4 s | 30.1 s |
| Saint-Denis (97411) | Ville de La Réunion | 1428 | 33 | 1221 | 18 | 4.6 s | 29.2 s |

Les nombres concernent le secteur consulté autour de la mairie, pas l’ensemble des bâtiments de la commune. Les détails sont renouvelés pendant la navigation. Les délais commencent après la réception du contour communal ; ils varient avec les services publics. Le chronomètre « bâtiments disponibles » mesure la réception et la préparation de la première géométrie 3D, pas le temps total depuis l’ouverture du navigateur.

Chaque scénario vérifie la commune et sa limite, des bâtiments aux hauteurs IGN, des coordonnées 3D finies, le relief, les parcelles, la recherche par référence cadastrale et le résultat de la consultation d’urbanisme. Les arrondissements de Paris et Lyon sont pris en charge dans la recherche cadastrale. Les géométries sont découpées à la limite communale ; aucun bâtiment ou arbre contrôlé n’est placé à l’extérieur. Sur les 30 premiers arbres de chaque vue, l’écart maximal avec le terrain affiché après stabilisation est de 0.000 m.

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

0 erreur JavaScript pendant les essais d’interaction. Rotation sur cette machine : intervalle médian entre callbacks d’animation 16.7 ms, percentile 95 16.7 ms, soit environ 60 images/s. Cela ne constitue pas une garantie pour tous les appareils. Le tas JavaScript observé atteint environ 349 Mo au maximum pendant la série ; il n’inclut pas toute la mémoire GPU ni tous les workers.

## Reprise sur erreur et géométrie

Une indisponibilité simulée du service de limites produit un message explicite et efface les anciens bâtiments. Une panne simulée du GPU laisse les couches de terrain et de bâtiments utilisables. La sélection suivante retrouve le fonctionnement normal : 692 bâtiments et 124 zones pour Massat, sans erreur JavaScript.

Onze tests automatisés couvrent les limites et les trous des polygones, les hauteurs absentes, les bâtiments élevés, les altitudes négatives, les cours intérieures, le placement des arbres et sa stabilité au déplacement, la recherche cadastrale, la pagination WFS et les liens des documents PLUi. Ils passent tous. La compilation TypeScript et Vite passe. L’audit npm n’a signalé aucune vulnérabilité après la mise à jour de Vite.

## Données hébergées et conservation

Le catalogue contient 34 969 communes. Le paquet de production fait 5.42 Mo bruts ; la somme des fichiers compressés en gzip est estimée à 1.74 Mo si l’hébergeur active cette compression. Le navigateur ne charge pas nécessairement tous les décodeurs au premier affichage.

Le paquet contient uniquement le catalogue, le code compilé, les styles et l’icône de l’application. Les données géographiques sont demandées directement aux domaines suivants : data.geopf.fr, geo.api.gouv.fr, apicarto.ign.fr, carto2.geo-ide.din.developpement-durable.gouv.fr. Aucun backend géographique, jeton privé, fichier municipal précompilé ou stockage de carte sur notre serveur n’est nécessaire. Les caches applicatifs restent bornés en mémoire du navigateur ; le cache HTTP ordinaire suit les en-têtes des producteurs.

L’ancienne application Massat est conservée : commit inchangé (true), état Git inchangé (true), 0 fichier source modifié. La nouvelle application n’a pas été publiée.

## Limites du résultat

Le catalogue est national ; les essais détaillés portent sur les dix communes ci-dessus. La couverture et les millésimes des services ne sont pas identiques partout. Les toitures, fenêtres et arbres sont des modèles indicatifs, et non des relevés individuels. Les contours et hauteurs sources restent distincts de cette représentation. Les très grandes communes sont explorées progressivement, sans chargement intégral de leur géométrie au démarrage.

Les documents réglementaires et leurs annexes demeurent les références pour l’urbanisme. Une donnée absente ou un service indisponible n’est jamais assimilé à une absence de réglementation.
