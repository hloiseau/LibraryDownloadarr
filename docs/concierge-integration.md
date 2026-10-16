# Personal Concierge integration contract v1

Related work: [Concierge #24](https://github.com/hloiseau/le-concierge/issues/24), [Hub #15](https://github.com/hloiseau/le-hub/issues/15). The fork's issue tracker is disabled; this contract is carried by the pull request instead.

`GET /api/integrations/concierge` accepts the ordinary **personal Downloadarr bearer session** in `Authorization`. It does not accept user selectors, Plex tokens, cookies from another application, or local administrator-only sessions. It returns `Cache-Control: no-store`:

```json
{
  "contractVersion": 1,
  "buildRevision": null,
  "user": { "plexId": "12345" },
  "plexServerId": "configured-machine-identifier",
  "sessionExpiresAt": 1792159200000,
  "capabilities": {
    "qualityOptions": ["720p-2", "720p-4", "1080p-8"],
    "streamOptions": true,
    "preparedDownloads": true,
    "singleUseTickets": true,
    "queuePersistence": "memory"
  }
}
```

The Plex ID is the positive numeric ID verified at Plex login and stored as `plex:<id>`. The server ID comes from current configuration, verified against `/identity` before sending the personal token to `/library/sections`. The endpoint checks the user's conversion policy and returns only allowed quality profiles. Session expiry is the existing real deadline in epoch milliseconds. Logout, token, identity, policy or server changes during upstream verification invalidate the response. Errors expose no upstream body, address or credential. `buildRevision` is null for local builds, or a validated 40-character lowercase Git SHA supplied through the image's `BUILD_REVISION` build argument and OCI revision label; this does not verify an external running image's digest.

The integrating server starts its own Downloadarr PIN flow (`POST /api/auth/plex/pin`, then `/plex/authenticate` with the returned opaque flowId). It keeps the resulting Downloadarr bearer in memory, bound to its own current session/owner, and compares both verified identities with its current Plex grant. Username/email comparisons are forbidden. The bearer never goes to the Hub browser; the integration is invalidated at logout, owner changes and the earlier of either session deadline. No existing Plex token is shared between applications.

Reuse these existing endpoints after the contract check:

| Endpoint | Behavior |
|---|---|
| `GET /api/permissions/me` | Current download policy; quality and library restrictions remain enforced server-side |
| `GET /api/downloads/options?ratingKey=…&quality=…&partKey=…&season=false` | Audio/subtitle choices rebuilt from the user's actual accessible media; only choices returned here may be offered |
| `POST /api/downloads` | Explicitly confirmed request `{ratingKey,quality,partKey?,season?,audio?,subtitle?}`; 202 with job snapshot |
| `GET /api/downloads` / `GET /api/downloads/:id` | Own jobs/status only, with fresh media and policy checks before returning private titles |
| `DELETE /api/downloads/:id` | Cancels an owned job; clients must not silently retry a destructive user choice |
| `POST /api/downloads/:id/ticket` then `POST /api/downloads/:id/file` | One-use 60-second ticket bound to owner/session/job, placed in the POST body; normal authorization and media checks run before bytes |
| `GET /api/media/download-history?limit=…&offset=…&search=…` | Own bounded recorded history; older `recorded` / `requested` rows do not prove a completed transfer |

Quality profiles are currently H.264/AAC MP4 at 720p/2 Mbps, 720p/4 Mbps or 1080p/8 Mbps. Seasons become ZIP archives; audio/subtitle matching is exact and common to every episode. Explicit selections may change that Plex account's selected tracks, so require user confirmation. A request never silently falls back to the original file when conversion/track verification fails.

Job snapshots expose state (`preparing`, `ready`, `sending`, `error`), stage (`deciding`, `waiting`, `processing`, `finalizing`, `ready`), progress (`number` or `null`), readyCount/fileCount and expiresAt. Null means no measured percentage; an integration must show the stage without inventing progress. Media identity, source signature, quality and exact selections are included in reuse checks. The queue is bounded to two jobs per owner/eight globally, with preparation TTL 24 h and ready cache TTL 6 h. These are limits, not guaranteed file lifetimes: Plex may expire a file first.

Jobs are **in memory**. Restart loses local handles; graceful shutdown clears its own Plex queue items. A client must not automatically recreate a missing/expired job after restart or timeout, because an unobserved conversion may still exist on Plex. Reload can recover existing jobs only within the same running instance. File transfer is a native POST stream; HTTP Range resume is not promised. A failed transfer can be explicitly retried while a verified ready job remains, without requesting another conversion.

No live conversion, playback or deployment is needed to validate this contract. Backend tests exercise identity/session/policy boundaries and mocked Plex sources. Installed image revision, real Plex download entitlement, codecs and transfer behavior must still be validated on the operator's chosen deployment.
