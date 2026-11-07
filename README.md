# Git Œil

Extension VS Code minimaliste autour de git :

- **Blame inline** : en fin de ligne courante, `Auteur, il y a 3 jours • message du commit`
  (« Vous » pour vos commits et les lignes modifiées non commitées). Le survol affiche le
  détail, avec un lien pour ouvrir le commit (`git show`). Les modifications non
  enregistrées sont prises en compte (`git blame --contents -`).
- **Vue « Stashs & branches »** dans l'onglet Contrôle de source :
  - **Branches récentes** : les dernières branches sur lesquelles vous avez basculé,
    lues dans le reflog de `HEAD` ; bouton ✓ pour y retourner.
  - **Branches** locales (la courante en tête), avec avance/retard sur l'upstream ;
    basculer (`git switch`), supprimer (clic droit, `-d` puis `-D` sur confirmation).
  - **Stashs** : clic pour voir le contenu ; boutons apply / pop / drop ;
    bouton de la barre de titre pour créer un stash (menu « … » : avec fichiers non suivis).

L'extension est de type `workspace` : en Remote SSH / WSL / conteneur, elle s'installe et
tourne côté distant, là où se trouvent les dépôts. Elle s'appuie sur l'extension intégrée
`vscode.git` pour connaître les dépôts ouverts et se rafraîchir, et appelle `git` directement
pour le reste.

## Installation

```sh
npm install              # TypeScript 7 + types (dev)
npm run package          # compile (out/) puis produit git-oeil-0.1.0.vsix
code --install-extension git-oeil-0.1.0.vsix
```

## Développement

TypeScript (`src/`, tests dans `test/`) compilé avec TypeScript 7 dans `out/`
(`npm run compile`, ou `npm run watch`). Aucune dépendance à l'exécution.
VS Code 1.145 minimum, types Node 24. Tests : `npm test` (le parsing est aussi vérifié
contre un vrai dépôt git temporaire).

## Réglages

```jsonc
{
  "gitOeil.blame.enabled": true,       // aussi : commande « Git Œil : afficher / masquer le blame inline »
  "gitOeil.blame.delayMs": 150,        // délai après un mouvement du curseur
  "gitOeil.recentBranches.count": 10   // 0 masque le groupe « Branches récentes »
}
```

Couleur du blame : `workbench.colorCustomizations` → `"gitOeil.blameForeground"`.

## Remarques

- Erreurs des commandes (conflit au `stash pop`, modifications locales qui empêchent de
  changer de branche…) : notification avec le message de git, détail dans le canal de
  sortie « Git Œil ».
- Avec GitLens installé, désactivez son blame de ligne courante pour ne pas avoir deux
  blames (`gitlens.currentLine.enabled: false`).
