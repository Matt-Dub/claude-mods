# claude-mods

Mods pour [Claude Code](https://claude.com/claude-code).

| Mod | Rôle | Commandes |
| --- | --- | --- |
| `prompt-rewrite` | Réécrit les prompts soumis pour plus de clarté, avec confirmation avant envoi | `/rewrite [on\|off\|<prompt>]` |
| `relay` | Écrit `relay.md`, une passation pour reprendre le travail dans une nouvelle session | `/relay [note]` |
| `brain` | Propose les connaissances à retenir d'une tâche pour `Brain/` dans SilverBullet, et n'écrit qu'après validation point par point | `/brain [reindex\|audit]` |
| `sb-sync` | Garde la page SilverBullet (`Projects/`) de chaque projet git alignée avec le travail fait dessus | `/sb-sync [new]`, `/sb-refresh` |

## Installation

Dans une session Claude Code, dans le terminal :

```
/plugin install prompt-rewrite --marketplace Matt-Dub/claude-mods
/plugin install relay --marketplace Matt-Dub/claude-mods
/plugin install sb-sync --marketplace Matt-Dub/claude-mods
/plugin install brain --marketplace Matt-Dub/claude-mods
```

Réponds `y` pour ajouter le marketplace, puis choisis une portée.

Depuis un shell :

```sh
claude plugin install prompt-rewrite --marketplace Matt-Dub/claude-mods
claude plugin install relay --marketplace Matt-Dub/claude-mods
claude plugin install sb-sync --marketplace Matt-Dub/claude-mods
claude plugin install brain --marketplace Matt-Dub/claude-mods
```

Dans l'application de bureau, où `/plugin` ne fonctionne pas : clique sur + à côté de la zone de prompt, puis Plugins, Add marketplace avec `Matt-Dub/claude-mods`, puis Add plugin.

## Configurer sb-sync

Le mod lit les accès à SilverBullet dans `~/.config/sb/credentials` (`%USERPROFILE%\.config\sb\credentials` sous Windows, ou le chemin de `SB_CREDENTIALS`), au format `CLE=valeur` : `SB_URL`, `CF_ID`, `CF_SECRET`, `SB_TOKEN`. Il parle directement à l'API `.fs` du serveur, sans bash ni `jq`, donc pareil sous macOS, Linux et Windows.

Chaque projet se relie à sa page par une ligne dans son `CLAUDE.md` :

```
SilverBullet: Projects/<Nom>/
```

La page est alors `Projects/<Nom>/<Nom>.md` (ou directement `Projects/<Page>.md` si la ligne se termine par `.md`). Sans cette ligne, le mod ne fait rien dans ce dépôt.

- **Automatique**, en fin de tour (au plus toutes les 2 minutes) et en fin de session : `last-activity:`, le bloc des 5 derniers commits et la ligne du projet dans `Projects/Projets récents.md`. Le bloc n'est jamais remplacé par celui d'un clone en retard.
- **`/sb-sync`** : la même chose, tout de suite. **`/sb-sync new`** : rédige la page d'un nouveau projet à partir du dépôt, l'affiche, et ne la crée qu'après ta confirmation.
- **`/sb-refresh`** : propose une réécriture de « État actuel » et « Prochaines étapes connues » d'après la conversation, et n'écrit qu'après ta confirmation.

Chaque écriture est conditionnelle (`If-Match` sur la révision lue) : si la page a changé dans SilverBullet entre-temps, rien n'est écrit. Seul un 404 compte comme page absente ; toute autre erreur arrête la synchro. Le mod refuse une écriture vide ou bien plus courte que la page, et ne supprime jamais rien.

## Utiliser brain

`Brain/Index.md`, dans SilverBullet, liste une ligne par page de connaissance, classée par thème. En fin de tâche, `/brain` lit cet index, propose les connaissances à retenir (nouvelle page ou complément) avec le texte prévu, et n'écrit que les points validés. Il met ensuite à jour la page Category concernée et l'index. `/brain reindex` ajoute à l'index les pages créées à la main ; `/brain audit` analyse tout le Brain avec `/graphify`, sans rien écrire.

## Mettre à jour

```sh
claude plugin marketplace update mods
claude plugin update prompt-rewrite@mods
claude plugin update relay@mods
claude plugin update sb-sync@mods
claude plugin update brain@mods
```

Puis `/reload-plugins` dans les sessions ouvertes.

## Licence

MIT
