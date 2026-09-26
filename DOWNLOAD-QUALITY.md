# Download quality preview

This branch implements quality selection for movies, episodes and season ZIPs.
It is an experimental integration awaiting validation with a real Plex server.
Original downloads and audio downloads keep their existing behavior.

## Behavior

Select Original, 720p / 2 Mbps, 720p / 4 Mbps or 1080p / 8 Mbps on a media page.
Plex prepares the selected video as an H.264/AAC MP4. When preparation finishes,
click **Save file**. The browser's download manager handles the transfer directly;
the app does not accumulate the converted file in a JavaScript Blob. A season
is delivered as a ZIP containing the converted episodes.

The bitrate is a target, not an exact file-size guarantee. Resolution is a maximum.
The selected audio/subtitle streams follow Plex's per-user selection; selected
subtitles are burned into the video. This preview does not offer a separate
language selector or preserve all audio/subtitle tracks. Subtitle burn-in and HDR
tone mapping can affect conversion speed and hardware use.

There is no fallback to the original file when conversion fails. The app checks
Plex's output decision (transcoding, MP4/HTTP, H.264, dimensions and video bitrate)
and rejects unexpectedly large Content-Length values before serving a file.
These checks rely on Plex's reported decision; actual codec/resolution must also
be checked on the first real downloaded sample.

## Plex requirements

- Plex Media Server 1.41.9+ with the Download Queue API.
- Each account must have access to the item and permission/entitlement to download.
  Plex enforces entitlement; this feature does not bypass it.
- A working configured Plex URL reachable from LibraryDownloadarr. HTTPS requires
  a valid certificate; use a valid plex.direct name or an appropriate LAN URL.
- Enough temporary storage on Plex for the converted files. Plex does the encoding;
  LibraryDownloadarr does not require access to media datasets or `/dev/dri`.

The requesting user's Plex token is used for metadata, queue operations and file
transfer. Only an actual app administrator can use the configured admin token.
Job ownership is checked on every authenticated route, and media permissions are
checked again before file transfer. Browser download tickets are single-use,
expire after 60 seconds, and are bound to the issuing app session; they are sent
in a POST body. Session and Plex tokens never appear in converted download URLs.

Up to two jobs per user and eight overall are allowed. Each season is limited to
100 episodes. Queue items are removed on cancellation, transfer completion,
transfer disconnect, a detected conversion error, expiry (24 hours) or graceful
app shutdown. Keep the page open during preparation and save before expiry.

Job tracking is in memory in this preview: app restarts require preparing the
file again. An abrupt process kill can leave queue items on Plex until Plex
expires them. This lifecycle needs observation during the NAS pilot. Browser
resume after an interrupted transfer is not supported by the single-use POST;
prepare a new download. If the file request itself fails, the browser displays
the error response; go back to the app to retry.

## TrueNAS 25.10 pilot

Use `deploy/truenas-quality.yaml` as the Custom App YAML. Before deployment:

1. The template pins the image built from commit `8b6e625` on 2026-09-26.
   Its GitHub Actions build passed all 11 tests and anonymous registry access
   was verified. The mutable convenience tag is `quality-preview`.
   For future builds, update the pinned digest after verifying publication.
2. Replace `NAS_LAN_IP` and `/mnt/POOL/...` using the NAS's actual configuration.
   Create dedicated app data/log datasets and keep any existing installation intact.
3. Deploy as `librarydownloadarr-quality` on port 5070, then set up the app's
   administrator and configure the existing Plex server through its Settings.
4. Sign in with a shared Plex account for the permission test.

The A310 stays assigned to Plex. Confirm Plex's existing hardware acceleration
settings and observe whether the download conversion uses hardware; successful
streaming transcoding alone does not prove that this download path uses it.
No GPU passthrough change to LibraryDownloadarr is required.

Pilot acceptance:

- Convert a short 4K sample to 720p / 2 Mbps; verify downloaded resolution, duration,
  audio, subtitles and size with a player or ffprobe, and check A310 usage on Plex.
- Repeat with 1080p, a season ZIP, and a different source codec/HDR sample.
- A shared account sees only its allowed libraries. Disabling downloads or removing
  media access during preparation prevents file transfer.
- Cancel an active preparation and interrupt a transfer; verify queue/temp cleanup.
- Verify Original still returns the original and album ZIPs still work.
- Observe app/Plex restart behavior and simultaneous playback plus conversion.

Rollback: stop/remove only this preview app; retain its datasets if needed for
inspection. The pilot does not modify Plex's originals or the existing app.
An upstream PR should follow a successful pilot, not precede it.

## Development verification

```sh
cd backend
npm ci
npm test
cd ../frontend
npm ci
npm run build
```

The Node test suite uses a mock Plex HTTP server and real Express routes to check
quality parameters, queue state transitions, ownership, permission revocation,
no original fallback, cancellation, one-use session-bound tickets, MP4 streaming
and season ZIP contents. It does not validate a real PMS transcode or GPU use.

References:
- https://developer.plex.tv/pms/ (Download Queue and Profile Augmentations)
- https://apps.truenas.com/managing-apps/installing-custom-apps/
