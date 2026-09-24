# Cache persistant — 24 septembre 2026

## Comportement

Sauvegarde IndexedDB des modèles préparés (tableaux typés, arbres, emprises), parcelles, contours communaux et rasters décodés. Conservation pendant sept jours et budget estimé de 256 Mio sur ordinateur / 80 Mio sur petit écran. Le PLU est toujours consulté via les services. Le fond cartographique dépend toujours du réseau et du cache HTTP ; ce n’est pas un mode hors ligne.

Le bouton d’effacement est à côté de l’attribution et du bouton d’information, en bas à droite. Il vide les données de cette application, suspend les écritures des onglets ouverts, et laisse la scène courante en mémoire. La sauvegarde reprend au prochain chargement. Une génération persistée empêche les téléchargements d’un autre onglet de réintroduire une ancienne sauvegarde après effacement.

## Vérification

- Compilation TypeScript + Vite réussie.
- 24 tests réussis, dont six dédiés à la persistance : restauration après nouvelle instance, tableaux typés indépendants des mutations du rendu, expiration, éviction LRU, budget, annulation, stockage indisponible, effacement pendant un chargement et invalidation entre onglets.
- Chrome, Massat, neuf secteurs autour du centre et neuf secteurs cadastraux : 73 entrées, environ 26,4 Mio estimés sur disque.
- Après rechargement : neuf modèles restaurés, zéro génération de modèle, neuf allocations graphiques nécessaires. Première géométrie en 0,50 s ; restauration des neuf secteurs en 1,82 s à partir du chargement du secteur. Mesure locale ponctuelle, hors chargement initial du fond et non représentative de tous les appareils.
- Activation du cadastre après rechargement : neuf secteurs relus depuis IndexedDB ; 65 lectures locales réussies au total avec le relief.
- Clic sur « Effacer les données » : zéro entrée, zéro octet comptabilisé, sauvegarde suspendue ; les neuf secteurs restent utilisables à l’écran. Aucune erreur cartographique observée.
- Emplacement vérifié en capture sur ordinateur et avec une largeur de 390 px.

Les secteurs non visités restent chargés progressivement. Les données ne sont pas préchargées pour toute une grande commune.
