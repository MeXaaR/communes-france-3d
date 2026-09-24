# Navigation et cache de la carte 3D

## Changement

Les bâtiments et arbres sont construits par secteurs fixes, puis conservés avec leurs géométries GPU. Les neuf secteurs voisins de la caméra sont activés, sans recréer les objets déjà présents. Le worker de modélisation est réutilisé. Les demandes concurrentes d’un même secteur partagent leur chargement.

Le cadastre conserve les parcelles visitées et met à jour la source cartographique par différences. Les grandes parcelles restent entières, même à cheval sur plusieurs secteurs. Les arbres sont attribués à un seul secteur ; les bâtiments proches des raccords sont inclus dans les obstacles pour éviter de placer des arbres dessus.

Masquer une couche ou dézoomer ne vide pas le cache. Un changement de commune annule les anciens travaux et libère les géométries. Les secteurs éloignés les moins récemment utilisés sont évincés au-delà du budget.

## Mémoire

| Cache                              |            Ordinateur |         Écran étroit |
| ---------------------------------- | --------------------: | -------------------: |
| Géométries et données 3D préparées | 256 Mio / 36 secteurs | 80 Mio / 16 secteurs |
| Cadastre                           |  40 Mio / 72 secteurs | 12 Mio / 24 secteurs |

La première limite atteinte déclenche une éviction. Les octets sont estimés à partir des tableaux de sommets, des buffers CPU/GPU, des instances d’arbres et du GeoJSON. Ce ne sont pas des mesures de la mémoire totale du navigateur : le fond IGN, le terrain, les workers, les index MapLibre et les allocations temporaires s’y ajoutent. Les secteurs évincés doivent être rechargés en cas de retour.

## Vérifications

- 18 tests unitaires réussis : géométrie, hauteurs, cours intérieures, arbres, recherche, pagination, documents PLU, grille fixe, attribution des bâtiments, absence de doublons d’arbres, chargements partagés, éviction, changement de commune pendant une requête et reprise après erreur.
- Compilation TypeScript et Vite réussie.
- Chrome réel : Massat et Lyon, affichage/masquage des couches, cadastre effectivement rendu, dézoom puis retour, rotation, limites des caches et absence de doublons.
- Émulation mobile 390 × 844 : Massat, sans débordement horizontal. Il ne s’agit pas d’une mesure sur un téléphone physique.
- Changement rapide Lyon → Paris → Foix : aucune géométrie de la commune quittée dans la vue finale.
- Aucune erreur JavaScript dans les scénarios de cache.
- Empreintes des sources de l’ancienne carte Massat vérifiées : inchangées.

Le rapport initial des dix communes demeure dans `RAPPORT.md`. Les vérifications ci-dessus portent sur l’optimisation ; elles ne remplacent pas les chiffres historiques du rapport initial.

## Restauration observée

Après dézoom puis retour sur les mêmes secteurs, la restauration côté application a pris 6 ms à Lyon et 3 ms à Massat en émulation mobile, sans nouvelle construction ni allocation de géométrie. Ces temps ne mesurent ni le premier chargement, ni le rendu complet d’une image à l’écran, ni les performances d’un téléphone réel.

À Lyon, neuf secteurs ont été conservés sans éviction : environ 220,5 Mio de cache 3D estimé, 1 355 bâtiments détaillés et 1 050 110 triangles. Les autres emprises connues restent affichées en extrusion simple avec leur hauteur IGN. À Massat en émulation mobile, le cache 3D occupait environ 15,5 Mio estimés, avec 706 bâtiments détaillés et 2 437 arbres.

La première exploration d’un secteur dépend toujours des services IGN et du calcul initial. Le préchargement des secteurs voisins peut prendre plus de temps que l’ancienne petite fenêtre ; son intérêt est de garder les objets prêts pour les mouvements suivants. L’urbanisme continue à être consulté indépendamment.

## Déplacements à Massat

| Mouvement | Requêtes bâtiments / parcelles avant | Après | Nouvelles constructions 3D après |
|---|---:|---:|---:|
| Petit déplacement | 1 / 2 | 0 / 0 | 0 |
| Retour sur la zone visitée | 1 / 2 | 0 / 0 | 0 |

Lors du déplacement vers le secteur voisin, six des neuf secteurs restent chargés ; seuls trois nouveaux secteurs sont demandés. Sur la dernière exécution, la navigation a été traitée en 3 ms pour le petit déplacement et 45 ms pour le retour en cache. Le chargement des trois secteurs nouveaux a pris 9,7 s, pendant lequel la carte restait manipulable.

Les temps mesurent le traitement applicatif et l’attente des secteurs, pas le rendu complet de chaque image. Le scénario historique forçait aussi une consultation d’urbanisme ; ses durées totales ne sont donc pas comparées à celles du nouveau test, qui isole bâtiments et cadastre. Les nombres de requêtes bâtiments/parcelles restent comparables.

## Reproduire

```sh
npm test
npm run build
npm run preview
node scripts/benchmark-navigation.mjs
node scripts/verify-cache.mjs
```

Les mesures détaillées sont dans `navigation-before.json`, `navigation-after.json` et `cache-regressions.json`. Les captures sont `navigation-after.png`, `cache-lyon.png` et `cache-massat-mobile.png`.
