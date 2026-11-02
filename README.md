# claude-mods

Mods pour [Claude Code](https://claude.com/claude-code).

| Mod | Rôle | Commandes |
| --- | --- | --- |
| `prompt-rewrite` | Réécrit les prompts soumis pour plus de clarté, avec confirmation avant envoi | `/rewrite [on\|off\|<prompt>]` |
| `relay` | Écrit `relay.md`, une passation pour reprendre le travail dans une nouvelle session | `/relay [note]` |
| `obsidian-sync` | Garde un vault Obsidian de projets aligné avec les projets git sur lesquels tu travailles | `/vault-sync`, `/vault-refresh` |

## Installation

Dans une session Claude Code, dans le terminal :

```
/plugin install prompt-rewrite --marketplace Matt-Dub/claude-mods
/plugin install relay --marketplace Matt-Dub/claude-mods
/plugin install obsidian-sync --marketplace Matt-Dub/claude-mods
```

Réponds `y` pour ajouter le marketplace, puis choisis une portée.

Depuis un shell :

```sh
claude plugin install prompt-rewrite --marketplace Matt-Dub/claude-mods
claude plugin install relay --marketplace Matt-Dub/claude-mods
claude plugin install obsidian-sync --marketplace Matt-Dub/claude-mods
```

Dans l'application de bureau, où `/plugin` ne fonctionne pas : clique sur + à côté de la zone de prompt, puis Plugins, Add marketplace avec `Matt-Dub/claude-mods`, puis Add plugin.

## Configurer obsidian-sync

Le mod reste inactif tant que `vaultPath` est vide. Indique le chemin absolu du vault à l'installation ou dans `/config`.

Chaque projet du vault est un dossier `<Nom>/` contenant une note `<Nom>.md` dont le frontmatter `repo:` pointe vers le dépôt git. L'index `Projets récents.md`, à la racine du vault, est mis à jour s'il existe déjà.

Le mod envoie des extraits du dépôt (`CLAUDE.md`, `CONTEXT.md`, `README.md`, historique git, liste de fichiers) au modèle pour rédiger la note d'un nouveau projet. Il agit automatiquement à la fin des tours et de la session, dès que tu travailles dans un dépôt git.

## Mettre à jour

```sh
claude plugin marketplace update mods
claude plugin update prompt-rewrite@mods
claude plugin update relay@mods
claude plugin update obsidian-sync@mods
```

Puis `/reload-plugins` dans les sessions ouvertes.

## Licence

MIT
