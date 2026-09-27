# Installation TrueNAS 25.10 et Caddy

Le Compose suit le tag public `ghcr.io/hloiseau/librarydownloadarr:quality-preview`.
Les publications de la branche du fork mettent ce tag à jour après les tests et
le build Docker. TrueNAS peut détecter les changements et proposer **Update**.

## Mise à jour depuis TrueNAS

Pour l'application déjà installée, faire une seule modification dans
**Apps → LibraryDownloadarr → Edit** : remplacer la ligne `image:` épinglée
sur `@sha256:…` par :

```yaml
image: ghcr.io/hloiseau/librarydownloadarr:quality-preview
```

Enregistrer avec **Update**, puis rafraîchir la page de LibraryDownloadarr.
Conserver le nom de l'application, ses volumes, son IP, son domaine et tous
les autres réglages. Ne pas réinstaller l'application.

Dans **Apps → Configuration → Settings**, laisser **Check for docker image
updates** activé. Lors des publications suivantes, après détection par TrueNAS,
utiliser **Apps → LibraryDownloadarr → ⋮ → Update**. Le bouton n'apparaît que
si une nouvelle image est détectée ; la détection n'est pas instantanée.
Aucun service de mise à jour supplémentaire n'est nécessaire.

Le téléchargement de l'image et le remplacement du conteneur passent par
TrueNAS. Cette configuration n'installe pas de nouvelle version pendant qu'un
transfert est en cours sans action de l'administrateur. Attendre la fin des
conversions et téléchargements avant de cliquer sur Update.

Si l'installation est exactement en **25.10.0**, les correctifs de **25.10.0.1**
résolvent des erreurs de mise à jour des applications personnalisées.

Pour revenir à la version testée avant ces diagnostics (barres de conversion),
remplacer temporairement la ligne par :

```yaml
image: ghcr.io/hloiseau/librarydownloadarr@sha256:2ce1026be6c86110a48e918175abe76df4ab4b0bd81628a144a0361858361992
```

Ce retour fige à nouveau l'image et désactive le suivi des nouvelles publications.

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

## Échec après « Save file »

Après mise à jour, fermer les onglets de LibraryDownloadarr et rouvrir le site
pour charger la nouvelle version du service worker. Les transferts de fichiers
passent maintenant directement par le navigateur, sans interception du worker.

Le navigateur télécharge depuis le même domaine que LibraryDownloadarr. Les
fichiers Plex transitent par l'application et Caddy ; le navigateur n'a pas
besoin d'accéder à l'adresse interne de Plex. Une réussite en local ne permet
pas à elle seule de distinguer un problème de réseau d'un problème de compte.

La console de l'application contient maintenant des lignes `Converted download
started`, `Converted download transferred` ou `Converted download failed`.
L'échec indique l'étape, le statut HTTP de Plex s'il est disponible, le code
réseau, la durée et les octets envoyés au proxy. Ces octets ne prouvent pas que
le navigateur a enregistré le fichier. Les traces ne contiennent ni les tokens,
ni les URL de Plex, ni les titres des médias.

Pour diagnostiquer un échec, relever le message exact du gestionnaire de
téléchargements du navigateur, l'heure de l'essai et les lignes `Converted
download` correspondantes dans **Apps → LibraryDownloadarr → Workloads → Logs**.
Si aucune ligne `started` n'apparaît, le transfert n'a pas atteint le gestionnaire
authentifié : examiner alors la réponse HTTP et les journaux du proxy.

Références pour les mises à jour :
- https://www.truenas.com/docs/scale/25.10/scaleuireference/apps/
- https://apps.truenas.com/managing-apps/managing-installed-apps/
- https://www.truenas.com/docs/scale/25.10/gettingstarted/versionnotes/

## Réessayer sans reconvertir

Après « Save file », le bouton **Retry download** relance le transfert du fichier
déjà préparé. La conversion reste sur Plex jusqu'à six heures après sa préparation,
y compris après une coupure du téléchargement. Le transfert recommence au début ;
il ne reprend pas au dernier octet reçu.

Après rechargement de la page, choisir le même film et la même qualité avec le
même compte retrouve la préparation. Les comptes ne partagent pas leur cache,
et les droits sont revérifiés avant de servir le fichier. Le cache compte au
maximum deux préparations par compte et huit au total. Les entrées inactives les
moins récemment utilisées libèrent leur place pour les nouvelles demandes.

Plex peut expirer un fichier avant cette limite. Un redémarrage ou une mise à jour
de LibraryDownloadarr vide le suivi en mémoire : il faudra alors reconvertir.
Les fichiers utilisent le stockage temporaire de téléchargement déjà monté dans
Plex, sans montage supplémentaire pour LibraryDownloadarr.
