[README.md](https://github.com/user-attachments/files/29521725/README.md)
# REB RUN — Veille épidémiologique REB

Outil de veille épidémiologique pour le risque épidémique et biologique (REB), à destination du service infectiologie / COREB.

## Contenu du dossier

- `index.html` — le tableau de bord (à ouvrir via une URL en ligne, pas en double-clic local — voir plus bas).
- `donnees.json` — toutes les données affichées (chiffres, alertes, sources, journal). C'est le seul fichier à modifier pour mettre à jour le contenu à la main.
- `moteur/` — le script Node.js qui interroge automatiquement les sources fiables (CDC, OMS, ECDC, Africa CDC, ESCMID) et met à jour `donnees.json`.
- `.github/workflows/update-reb.yml` — la tâche planifiée GitHub Actions qui exécute le moteur chaque jour à 6h (heure de La Réunion).

## Mise en ligne

1. Crée un dépôt GitHub et dépose tout le contenu de ce dossier (y compris `.github`, qui peut être masqué selon ton explorateur de fichiers).
2. Dans les réglages du dépôt → **Pages**, active GitHub Pages sur la branche principale.
3. L'outil est accessible à l'adresse `https://<ton-compte>.github.io/<nom-du-dépôt>/`.

⚠️ Le bouton « Actualiser les données » ne fonctionne que sur la version en ligne (`https://...`) — pas en ouvrant `index.html` directement depuis le disque.

## Mettre à jour les données à la main

Modifier `donnees.json` directement sur GitHub (icône crayon), puis valider (**Commit changes**). L'outil relit ce fichier à chaque chargement de page.

## Vérifier que l'actualisation automatique tourne

Onglet **Actions** du dépôt GitHub → le job `update` doit apparaître chaque jour avec une coche verte. On peut aussi le lancer à la main via **Run workflow**.
