# Aki Labs · ChatGPT bridge

Génère des images dans **ton** onglet ChatGPT, depuis un script ou Claude Code, sans copier-coller.
Une image à la fois, faible volume : on reste raisonnable avec le compte.

```
script / Claude ──► pont local (127.0.0.1:3777) ◄── extension (onglet chatgpt.com) ──► ChatGPT
```

## Installation (une fois)
1. **Navigateur** : Dia, Chrome, Arc, Brave ou Edge (tout ce qui est basé sur Chromium).
2. Ouvre la page des extensions (`chrome://extensions`).
3. Active le **mode développeur**.
4. Clique sur **Charger l'extension non empaquetée**, puis choisis le dossier `extension/` de ce dépôt.
5. Ouvre un onglet `https://chatgpt.com`, connecté à ton compte, et laisse-le ouvert.
   - Si aucun onglet ChatGPT n'est ouvert quand une image est demandée, l'extension en ouvre un en arrière-plan.

Il faut Node 18 ou plus récent. Aucune dépendance.

## Utilisation
```bash
node bridge/submit.mjs <dossier> <sortie.png> [--topic <sujet>]
```
- `<dossier>` contient `prompt.txt` et un sous-dossier `refs/`. Les références sont jointes dans l'ordre de leur nom (`1-…`, `2-…`).
- `--topic` réutilise la conversation de ce sujet (par exemple `wild` ou `accueil`), ce qui garde le contexte. Sans `--topic`, une nouvelle conversation est ouverte.
- Le pont démarre tout seul si besoin. Tu peux aussi le lancer à la main avec `node bridge/server.mjs`.
- L'icône de l'extension affiche l'état : pont allumé ou éteint, image en cours.

Les sujets et leurs conversations sont enregistrés dans `~/.aki-chatgpt/chats.json`.

## Garde-fous
- **Pas d'onglet ChatGPT qui répond** : un avertissement apparaît après 20 s. Au bout de 3 minutes, la demande est annulée.
- **Pas de réponse pendant une génération** : la demande passe en erreur après 10 minutes.
- **Réseau** : le pont n'écoute que sur `127.0.0.1`, jamais sur le réseau.

## Quand ChatGPT change son interface
Tous les sélecteurs sont en haut de `extension/content.js` (objet `SEL`) :
- zone de texte ;
- champ fichier ;
- bouton envoyer ;
- bouton stop ;
- images.

Adapte-les, puis recharge l'extension (bouton ↻ sur `chrome://extensions`).

## Limites
- L'onglet doit rester ouvert. Le navigateur ralentit les onglets en arrière-plan, donc une génération peut prendre un peu plus de temps.
- C'est ton compte ChatGPT qui travaille : garde un faible volume. Les conditions d'OpenAI encadrent l'usage automatisé. Pour un gros volume, passe par l'API officielle.
