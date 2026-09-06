# REB RUN — Veille épidémiologique REB

Outil de veille épidémiologique pour le risque épidémique et biologique (REB), à destination du service infectiologie / COREB.

## Contenu du dépôt

- `index.html` — le tableau de bord (8 onglets : Accueil, Carte, Carte de chaleur, Fiche pays, Alertes, Courbes, Sources, Synthèse). À ouvrir via l'URL en ligne, pas en double-clic local (voir plus bas). ⚠️ Fichier **généré** : ne pas l'éditer à la main, il est reconstruit en bloc à chaque évolution de l'interface.
- `donnees.json` — toutes les données affichées (chiffres, alertes, sources, journal, historique des runs). C'est le seul fichier à modifier pour corriger le contenu à la main.
- `moteur/` — le script Node.js qui interroge les sources et met à jour `donnees.json` (`update-engine.mjs`, plus les modules `odisse.js` et `reliefweb.js`).
- `.github/workflows/update-reb.yml` — la tâche planifiée GitHub Actions, chaque jour à 6h (heure de La Réunion).

## Sources automatiques

| Source | Portée | Mode |
| --- | --- | --- |
| OMS — Disease Outbreak News | Bulletins DON, toutes pathologies REB | API JSON |
| CDC — Situation Summary | Ebola Bundibugyo | CSV |
| ECDC — page de suivi Ebola RDC/Ouganda | Cas et décès confirmés RDC, ~2×/semaine | Page web |
| ESCMID Epi Alert | Bulletin scientifique | Page web |
| Odissé — Santé publique France | La Réunion : dengue, chikungunya | API JSON |
| Bulletin SpF Océan Indien | La Réunion : leptospirose, mpox (hebdomadaire) | Page web |
| ReliefWeb | Alertes épidémies de la zone (signal précoce) | API JSON, `appname` approuvé |

Africa CDC est **désactivé** : leur page de référence à URL fixe n'est plus mise à jour, et les sitreps récents changent d'adresse à chaque parution. Les sources non automatisées (COREB, ARS OI, ministères de la santé, ProMED) restent listées dans l'onglet **Sources** avec leur lien direct, pour consultation manuelle.

## Garde-fous

Le moteur ne publie pas un chiffre à l'aveugle :

- une valeur qui chute de plus de moitié (ou explose ×20) est **rejetée** et signalée comme motif probablement mal calé ;
- un chiffre n'est remplacé que s'il est **plus récent** que celui déjà publié ;
- une source en échec 3 jours de suite est marquée « motif à revoir » dans l'onglet Sources.

## Mise en ligne

Réglages du dépôt → **Pages** → activer sur la branche principale. L'outil est alors accessible à l'adresse `https://<compte>.github.io/reb-run/`.

⚠️ Le bouton « Actualiser les données » ne fonctionne que sur la version en ligne (`https://...`), pas en ouvrant `index.html` depuis le disque.

## Mettre à jour les données à la main

Modifier `donnees.json` directement sur GitHub (icône crayon) puis **Commit changes**. L'outil relit ce fichier à chaque chargement de page.

## Vérifier que l'actualisation tourne

Onglet **Actions** → le job `update` doit apparaître chaque jour avec une coche verte. On peut le relancer via **Run workflow**.

## Dépannage — « les chiffres semblent figés »

Une coche verte dans Actions signifie que le moteur a tourné, **pas** qu'il a réussi à lire les chiffres. En cas de doute :

1. Ouvrir l'onglet **Sources** du tableau de bord : chaque source y porte son statut du dernier run (à jour / vérifié / échec).
2. Un « échec — motif non trouvé » signifie que la source a reformulé sa page : le motif d'extraction doit être réajusté dans `moteur/update-engine.mjs`.
3. Corriger `donnees.json` à la main en attendant, pour que l'affichage reste juste.

Cas déjà rencontré : les sites institutionnels écrivent leurs milliers avec une espace insécable encodée (`6&nbsp;342`). Tant que les entités HTML n'étaient pas décodées avant extraction, aucun motif numérique ne pouvait correspondre et les chiffres Ebola sont restés bloqués trois semaines alors que les runs étaient tous verts. Corrigé dans `stripTags()`.
