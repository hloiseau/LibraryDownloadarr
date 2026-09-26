# Installation TrueNAS 25.10 et Caddy

Le Compose `truenas-compose.yaml` utilise l'image du fork dont le téléchargement
transcodé a été confirmé fonctionnel le 26 septembre 2026. Son digest est épinglé :
une nouvelle publication de `quality-preview` ne la remplacera pas implicitement.

## TrueNAS

1. Remplacer `NAS_LAN_IP` par l'adresse locale du NAS et `downloads.example.com`
   par le sous-domaine choisi, dans les deux fichiers.
2. Dans **Apps → Discover Apps → menu → Install via YAML**, choisir le nom
   `librarydownloadarr` et coller le contenu de `truenas-compose.yaml`.
3. Les volumes Docker nommés `app-data` et `app-logs` sont créés automatiquement
   sur le stockage des applications. Ils persistent lors des redémarrages et
   des mises à jour avec le même nom d'application. Ce sont des volumes Compose,
   pas la déclaration d'un ixVolume du catalogue TrueNAS.
4. Ouvrir `http://NAS_LAN_IP:5070`, créer l'administrateur, puis utiliser
   **Settings → Connect with Plex**. Sélectionner l'adresse Plex joignable depuis
   cette nouvelle application. Terminer cette initialisation avant d'activer
   l'accès public via Caddy.

Le fichier convient à une nouvelle installation. Pour remplacer une installation
existante, conserver son montage `/app/data` : un nouveau volume donne une nouvelle
configuration. Ne pas supprimer les volumes lors d'une mise à jour. Une suppression
des volumes supprime aussi les comptes, les réglages et les permissions enregistrés.

Le montage `/downloads` déjà corrigé appartient à **Plex**, qui prépare les fichiers.
Le réglage Plex **Downloads temporary directory** doit désigner ce dossier
accessible en écriture. LibraryDownloadarr utilise l'API Plex ; il n'a besoin ni
du montage `/downloads`, ni des médias, ni de l'A310.

## Caddy

Ajouter le bloc `Caddyfile.librarydownloadarr` au Caddyfile existant. Le sous-domaine
doit pointer vers l'installation Caddy existante ; Caddy doit pouvoir joindre
`NAS_LAN_IP:5070`. Le port public HTTPS est celui de Caddy. Ne pas créer de
redirection Internet du port 5070. L'exemple utilise un sous-domaine dédié, car
l'application et ses routes `/api` sont servies à la racine.

Le bloc supprime `X-Forwarded-For` vers cette version de l'application, qui ne
configure pas Express `trust proxy`. La limite API est donc commune aux visiteurs
passant par Caddy (10 000 requêtes / 15 minutes) ; les permissions restent liées
au compte connecté. Aucun tampon de fichier complet ou délai court de transfert
n'est ajouté au proxy.

Vérifier puis recharger Caddy avec son mécanisme habituel. Pour une installation
sur l'hôte, avec son Caddyfile dans `/etc/caddy/Caddyfile` :

```sh
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
```

Si Caddy est conteneurisé, exécuter ces commandes dans son conteneur avec le
chemin du Caddyfile monté. Ne pas utiliser `localhost:5070` depuis ce conteneur
pour atteindre une autre application.

Ouvrir ensuite `https://downloads.example.com`. Les amis utilisent **Sign in with
Plex** ; les règles se configurent dans **Download permissions**.

Sources :
- https://apps.truenas.com/managing-apps/installing-custom-apps/
- https://caddyserver.com/docs/caddyfile/directives/reverse_proxy
- https://support.plex.tv/articles/transcoder/
