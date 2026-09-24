# Communes · France en 3D

[Ouvrir la carte gratuite](https://mexaar.github.io/communes-france-3d/) · [Ouvrir Massat](https://mexaar.github.io/communes-france-3d/?commune=09182)

Application indépendante de la carte Massat. Le serveur ne fournit que le code, les éléments d’interface et le catalogue national des communes. Aucun fichier communal de bâtiments, relief, végétation, cadastre ou urbanisme n’est livré avec l’application.

## Lancer

```sh
npm ci
npm run dev
```

Ouvrir <http://127.0.0.1:3010/>. Sur macOS, le fichier `Lancer Communes 3D.command` lance la même application. Node.js 22.12 ou plus récent est nécessaire.

```sh
npm test
npm run build
npm run preview
npm run test:communes
node scripts/update-communes.mjs
```

Le dernier script met à jour uniquement le catalogue autorisé. Les tests de communes utilisent Chrome installé sur la machine et les vrais services publics. Ils produisent des captures et un rapport dans `validation/`. Ces fichiers ne sont pas intégrés à la compilation.

## Utilisation

- Rechercher une commune par son nom, son code postal ou son code INSEE. Les homonymes indiquent leur département.
- La carte s’ouvre près de la mairie. « Toute la commune » montre son périmètre. Les détails se chargent près de la vue lorsque l’on se rapproche.
- Glisser pour déplacer la carte, molette pour zoomer. Clic droit ou Ctrl + glisser pour tourner et incliner. Sur écran tactile, utiliser deux doigts.
- Le champ de lieu recherche une adresse, une rue, un hameau ou une parcelle sous la forme `AB 123`. Un résultat recentre la carte.
- Activer les parcelles ou l’urbanisme, puis cliquer pour lire leurs attributs et ouvrir le règlement officiel lorsqu’il est disponible. Les numéros cadastraux (par exemple `0039`) sont affichés au centre des parcelles, sans la section ; cliquer sur un numéro ouvre la fiche de la parcelle, même lorsque le PLU est affiché.
- Le paramètre `?commune=09182` ouvre directement Massat. Le lien garde la commune choisie.

## Données et fonctionnement

| Élément                        | Source consultée directement par le navigateur                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Catalogue national             | API Découpage administratif, copie compacte dans `public/communes.json`                                |
| Limite communale               | API Découpage administratif, à chaque sélection                                                        |
| Fond, voies et toponymes       | Tuiles vectorielles Plan IGN                                                                           |
| Terrain                        | WMS IGN LiDAR HD / RGE ALTI, repli RGE ALTI en terrain RGB                                             |
| Bâtiments                      | WFS BD TOPO v3 : emprises, hauteurs, nature et usage                                                   |
| Boisements                     | WMS CoSIA, millésime récent puis précédents pour les zones sans couverture                             |
| Repli végétation               | WFS BD TOPO pour les zones sans CoSIA                                                                  |
| Parcelles                      | WFS Parcellaire Express IGN                                                                            |
| Adresses et lieux              | Géocodage Géoplateforme, filtré à la commune                                                           |
| PLU / PLUi / cartes communales | API Carto GPU ; repli DDT de l’Ariège lorsqu’aucun zonage n’est fourni pour une commune du département |

Le terrain et la couverture du sol sont traités dans un Web Worker. Un second worker découpe les géométries aux limites communales et construit les maillages. Three.js affiche les toitures, les fenêtres et les arbres instanciés ; MapLibre gère le fond, le terrain et la navigation.

Les bâtiments et arbres sont construits une seule fois par secteur fixe (grille Web Mercator de niveau 16, environ 450 m au sol à Massat). Les neuf secteurs proches de la caméra sont affichés. Les secteurs visités restent en mémoire, y compris leurs objets GPU : revenir dessus ne demande ni téléchargement ni reconstruction. Le cadastre reçoit seulement les ajouts et retraits de parcelles. Les grandes parcelles conservent leur contour entier, même lorsqu’elles traversent plusieurs secteurs.

Le cache conserve jusqu’à 36 secteurs 3D sur ordinateur et 16 sur écran étroit, avec un budget estimé de 256 Mio et 80 Mio respectivement ; le cadastre dispose de 40 Mio et 12 Mio. Les secteurs les moins récemment utilisés sont libérés lorsque l’une des limites est atteinte. Ces budgets concernent les caches préparés, pas la mémoire totale du navigateur : terrain, fond de carte, workers et allocations temporaires s’y ajoutent. Masquer une couche ou dézoomer garde les secteurs en cache ; changer de commune les libère.

Les appels sont limités et les tuiles dédupliquées. Un changement de commune annule les travaux précédents. Les caches de données et de géométries sont bornés et restent en mémoire du navigateur ; aucun backend, aucune clé d’API et aucune base de données ne sont nécessaires. Le cache HTTP standard du navigateur peut aussi conserver des réponses suivant les en-têtes des fournisseurs.

## Fidélité et limites

Les emprises et les hauteurs proviennent de l’IGN. Les hauteurs manquantes restent non renseignées. Le plafond de deux niveaux de l’ancienne carte Massat n’est pas appliqué aux villes françaises : une hauteur officielle de 40 mètres reste une hauteur de 40 mètres.

Les toitures à pente, les fenêtres et les arbres sont des représentations indicatives. Leur apparence n’est pas un relevé architectural. Le contour des boisements est issu des classes CoSIA, échantillonnées depuis le WMS ; les arbres sont répartis de manière déterministe dans ces classes, avec un retrait près des bordures, des bâtiments et des surfaces non boisées. Il ne s’agit pas des positions et hauteurs mesurées de chaque arbre.

Le relief conserve une exagération de 1. La résolution affichée varie avec le zoom et les données disponibles. Des écarts locaux restent possibles entre les millésimes du terrain, des bâtiments et de la végétation.

La commune entière est navigable, mais ses détails sont chargés par secteur. Une grande ville n’est jamais transformée intégralement au démarrage. Les limites des services publics et leur disponibilité peuvent ralentir le premier chargement. Les erreurs et les absences de données sont signalées séparément.

L’absence de zones retournées par un service ne prouve pas l’absence d’un document d’urbanisme. Le code de zone est affiché sans lui attribuer de règles inventées. Les règlements et annexes officiels restent la référence.

## Hébergement

La sortie `dist/` est entièrement statique et utilise des chemins relatifs. Elle peut être placée sur GitHub Pages, Netlify ou un hébergeur statique équivalent. Seul `dist/` doit être déployé. La carte est publiée gratuitement sur GitHub Pages, depuis la branche `gh-pages`. Le code source se trouve sur `main`. Le dépôt et la carte Massat existants restent indépendants.

Pour publier une mise à jour, exécuter `npm test`, puis `npm run build` et `npm run deploy`. Cette dernière commande publie uniquement `dist/` sur la branche `gh-pages` du dépôt Git configuré comme `origin`. Elle nécessite les droits GitHub de publication sur ce dépôt.

Les données sont chargées chez leurs producteurs, donc un hébergement léger ne supprime pas le trafic réseau ni le calcul sur l’appareil du visiteur. Le rapport de validation fournit les mesures réellement observées, sans promettre un délai uniforme pour toutes les connexions ou toutes les communes.

## Résultats de validation

Le rapport complet est dans [validation/RAPPORT.md](validation/RAPPORT.md), Les captures des dix communes et du mode mobile, ainsi que les rapports JSON, sont générés localement dans ce dossier et ne sont pas publiés. Les mesures de navigation et les vérifications du cache sont dans [validation/OPTIMISATION.md](validation/OPTIMISATION.md).

Les règles de téléchargement des documents GPU sont décrites dans la [documentation officielle des services](https://www.geoportail-urbanisme.gouv.fr/services/?subcategory=services_api).
