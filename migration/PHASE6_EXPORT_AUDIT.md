# Phase 6 — audit et format de l’export Firebase

## Comparaison de la source testée

Le fichier suivi `Exporter.2026-08-12_05-54-16.su` est un export partiel au format JSON : il contient les trois tableaux `pages.page1` (7 documents), `pages.page2` (234) et `pages.page3` (875). Il ne contient aucune autre source du contrat.

| Source requise | Présente dans l’export actuel | Absente |
|---|---:|---:|
| `pages/page1/items` | oui (7) | non |
| `pages/page2/items` | oui (234) | non |
| `pages/page3/items` (dont `returns[]`) | oui (875) | non |
| `users` (dont `readMessages[]`) | non | oui |
| `users/{uid}/outDeletionLimits` | non | oui |
| `appSettings/maintenance`, `appSettings/trash` | non | oui |
| `materialCodes` | non | oui |
| `historiques` | non | oui |
| `trash` | non | oui |
| `sites/{siteId}/achatsMateriels` | non | oui |
| `materialRequests` (dont `items[]`) | non | oui |
| `adminMessages` (dont `recipientIds[]`) | non | oui |

`unlockProtections` est un champ imbriqué de chaque document `page1`; sa présence dépend des documents et le nouvel export le conserve sans transformation.

## Format versionné

`export-firebase-data.js` produit `firebase-supabase-migration-export`, version 1. Les données brutes sont placées sous `collections`; les documents sont des maps indexées par leur ID Firebase. `purchasesBySite` et `outDeletionLimitsByUser` ajoutent un niveau indexé par l’ID parent. Aucun ID n’est régénéré.

Les timestamps sont encodés sous la forme `{ "__type": "firestore_timestamp", "seconds": <entier>, "nanoseconds": <0..999999999> }`. Les entiers hors de la plage sûre JavaScript, octets, références et points géographiques utilisent également un objet `__type`. Les maps, tableaux, valeurs `null`, `false`, `0`, chaînes vides, champs legacy et snapshots restent inchangés. La normalisation reste exclusivement dans le dry-run.

Le manifeste inventorie chaque source avec `collection`, `documents_count`, `subcollections_count` et `export_status` (`EXPORTED`, `EMPTY`, `FAILED`, `NOT_ACCESSIBLE`). Les singletons `appSettings/maintenance` et `appSettings/trash` ont chacun une entrée d’inventaire, afin que l’absence de l’un ne soit pas masquée par la présence de l’autre. Une erreur d’accès arrête l’export et ne peut donc pas être confondue avec une collection vide. Toutes les lectures sont paginées.

Le fichier est créé avec le mode `0600`, sans écrasement, puis son SHA-256 est écrit dans un fichier local `.sha256`. Le hash ne peut pas être inclus dans le fichier qu’il hash sans devenir autoréférentiel; le dry-run le recalcule et l’inscrit dans son rapport.

## Sécurité et Auth

L’outil utilise exclusivement des requêtes HTTP `GET`. Un garde statique échoue si une primitive d’écriture Firebase est introduite. Il ne contacte jamais Supabase. L’accès Firebase vient uniquement de `FIREBASE_ACCESS_TOKEN` ou d’Application Default Credentials indiqué par `GOOGLE_APPLICATION_CREDENTIALS`; aucune valeur ni aucun jeton n’est journalisé.

Les champs dont le nom exact est sensible (`password`, `loginMemo`, jetons, clé privée, compte de service, `service_role`) font échouer l’export plutôt que d’être copiés. Les documents Firestore `users/{uid}` ne sont pas Firebase Authentication : le manifeste indique explicitement `FIREBASE_AUTH_EXPORT_REQUIRED = YES` et `FIREBASE_AUTH_EXPORTED = NO`; l’export Auth est une phase séparée.
