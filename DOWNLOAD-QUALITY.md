# Download quality preview

This branch implements quality selection for movies, episodes and season ZIPs.
The operator confirmed a successful authenticated download on 26 September 2026
with TrueNAS 25.10, PMS 1.43.4.10903-e5521bd8c and an Intel Arc A310 assigned to Plex.
This is an operator-reported result, not an independent codec or GPU measurement.
The decision request has also been checked on a real Linux Plex test server.
Original and audio downloads remain available subject to the new download permissions.

For the validated image with automatically created Compose volumes and an
existing Caddy installation, see `deploy/TRUENAS-CADDY.md`,
`deploy/truenas-compose.yaml` and `deploy/Caddyfile.librarydownloadarr`.

## Connection and download permissions

1. Create the local administrator once, then open **Settings → Connect with Plex**.
2. Authorize using the Plex server owner's account. Select the server, then choose
   an address from the **Server address** dropdown. Each choice shows its full URL,
   HTTP/HTTPS and Local/Remote/Relay type. **Custom address…** accepts a NAS LAN URL
   or another address you supply. Click **Test and use this address**. Only that
   address is tested and saved; a failed check keeps your selection and permits
   another choice without signing in again (the authorized setup lasts 15 minutes).
   No manual token extraction is needed. Manual setup remains under Advanced.
3. Friends open the app and choose **Sign in with Plex** using their own accounts.
   They must already have access to the exact configured server in Plex.
4. Open **Download permissions** as administrator. Set default download rules,
   or override them for an individual friend after their first sign-in. You can
   disable downloads, select libraries, and allow only chosen quality profiles.
   Disable **Original file** to require video conversion. Audio requires Original.

These are restrictions on downloads through this app, not changes to Plex's
library visibility or sharing. They cannot grant access or download entitlement
that Plex denies. Defaults allow all Plex-authorized downloads unless changed;
individual rules replace defaults. Rules apply to original files, album/season
ZIPs and converted files, and are rechecked before converted bytes are delivered.
Transfers already in progress are not interrupted. Rules tied to a different
Plex server fail closed until an administrator saves them for the current server.

This update invalidates existing Plex-user app sessions once: old versions used
the temporary login PIN id as the account identity. Friends must sign in again
before they appear in the permissions page. Administrator sessions, configuration
and historical download records are retained; historical duplicate account rows
are not silently merged. Future logins use the verified Plex account id, so rules
survive logouts and restarts. Owner authorization flows are bound to the admin
session; Plex tokens stay on the backend. Popup isolation or a closed Plex tab
does not cancel authorization polling. The app waits for the backend result or
expiry; an unsuccessful attempt to close a popup cannot discard a valid login.

Connection failures now identify the selected endpoint and whether the failure
was DNS, a refused port, timeout, HTTPS certificate validation, an HTTP refusal,
or an unexpected API response. The app accepts JSON/XML identity responses and
can authenticate an identity request at the exact URL advertised by an owned
server. During owner setup, a custom URL must identify the expected Plex server
before receiving the Plex token. TLS validation remains enabled and HTTP redirects are not followed.

## Diagnosing a failed conversion

The previous message “Plex could not prepare a file. Check the Plex transcoder
and temporary storage.” did not identify a cause. It also treated missing queue
entries, expired files, and Plex conversion errors as the same failure.

Errors now show the queue state, chosen quality, PMS version when available, and
Plex's decision code/text (with known tokens and URLs redacted). Missing entries
are retried briefly. Expired files have their own message. If Plex reports an error
without a reason, inspect the Plex Media Server logs for that attempt. A successful
conversion decision followed by queue failure can still require Plex logs.

An earlier NAS attempt passed the decision stage (`general 1001`, `transcode
1001`, `Conversion OK`) but the queue still returned `status: error`.
`directPlay 3000` is expected because this app requests conversion with
`directPlay=0`; it does not explain why file creation failed. The branch now
clarifies this case and includes the UTC observation time and queue/item ids for
log correlation. Actual transcode refusals still retain their decision details.
This diagnostic clarification is included in the progress image `c13399c`.
It does not alter the conversion parameters used by the successful `85505d0` pilot.

The server logs identified a filesystem permission error while creating a
subdirectory under Plex's configured download staging path. That path had not
been mounted into the Plex container. After configuring writable storage for it,
the operator confirmed that downloads worked. This storage belongs to Plex,
not LibraryDownloadarr, and is distinct from the live-streaming transcoder cache.

From Plex Web using the server owner's account, select the server in Settings,
then **Manage → Troubleshooting → Download Logs** and save the ZIP. The logs from
the failed attempt are needed to identify the actual cause. Do not publish a
user's logs in this repository.
https://support.plex.tv/articles/200250417-plex-media-server-log-files/

The reported `general 2004: Could not construct decision request` exposed a
case-sensitive profile-name bug: the app requested `generic`, but Linux PMS ships
`Generic.xml`. With official PMS 1.43.4.10903-e5521bd8c and a generated UHD clip,
the former fails with `unable to find a matching profile`; changing it to
`Generic` produces `Conversion OK`. The app now sends that exact name.

The same live test showed that static MP4 decisions can omit `protocol`. Output
verification accepts that omission while still rejecting an explicitly different
protocol, non-MP4 containers, original/direct-play decisions, unsupported video
codecs and excessive resolution/bitrate. A captured response is included in the
regression tests. The comparison run is available at:
https://github.com/hloiseau/LibraryDownloadarr/actions/runs/36254437804

This temporary, unclaimed test server returned HTTP 404 for Download Queue.
It therefore validates the underlying decision request, not an authenticated
end-to-end download or the NAS's A310. The later operator pilot is described above.
The universal playback endpoint also reduced the 2-Mbps test to 720×404 despite
a 1280×720 maximum, logging a bitrate-driven playback-quality reduction. This
does not establish Download Queue's final resolution. No speculative bitrate or
client-capability changes were added to the fix; quality remains a maximum.
An additional direct `start.mp4` smoke test reached the transcoder but failed
when PMS tried to open an empty output path. No complete converted file was
obtained; this separate playback endpoint does not validate Download Queue.
The unsuccessful encoding run is recorded at:
https://github.com/hloiseau/LibraryDownloadarr/actions/runs/36255528410

A follow-up comparison of direct MP4 and MKV output also failed for both formats
with the empty output path. No complete file was produced, and this does not
establish a container-format problem in authenticated Download Queue. The app's
MP4 request remains unchanged; the NAS failure was resolved with writable Plex storage.
https://github.com/hloiseau/LibraryDownloadarr/actions/runs/36256485663

## Behavior

Preparation now has a visible progress bar, elapsed time, and explicit waiting,
conversion and finalization stages. Progress comes from the requesting user's
Download Queue items, including `TranscodeSession.progress`; no global server
session access or administrator token is needed. For seasons, progress is
weighted by episode duration when all durations are available, otherwise by file
count. Missing percentages use an indeterminate animation instead of invented
progress. Only verified ready files reach 100%; transfer after Save file is
tracked by the browser's download manager. Regression coverage includes 36 backend
tests and 14 frontend tests; the progress UI is not yet independently tested on
the live NAS.

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

## Try the updated preview on your computer

Published application commit: `c13399c`. All 34 backend tests and 11 frontend
tests pass; both production builds pass. The Docker build reran both test suites.
Anonymous image access and the embedded commit revision were verified. Build:
https://github.com/hloiseau/LibraryDownloadarr/actions/runs/36268906131

To keep an earlier test container intact, launch this version on port 5071 with
its own persistent data volume:

```sh
docker run --pull always -d --name librarydownloadarr-test-v2 -p 127.0.0.1:5071:5069 -v librarydownloadarr-test-v2:/app/data ghcr.io/hloiseau/librarydownloadarr:quality-preview
```

Open http://localhost:5071, create the local administrator and choose **Settings →
Connect with Plex**. Use your NAS's Plex address, not localhost, when selecting the
server connection. This creates a separate app configuration; it does not migrate
the previous test or deploy anything on the NAS. Stop it with
`docker stop -t 45 librarydownloadarr-test-v2`; its named volume keeps the settings.

To update that named test container later while keeping its configuration:

```sh
docker pull ghcr.io/hloiseau/librarydownloadarr:quality-preview
docker stop -t 45 librarydownloadarr-test-v2
docker rm librarydownloadarr-test-v2
docker run -d --name librarydownloadarr-test-v2 -p 127.0.0.1:5071:5069 -v librarydownloadarr-test-v2:/app/data ghcr.io/hloiseau/librarydownloadarr:quality-preview
```

The named data volume is retained. Refresh the browser after replacing the
container. These commands apply to the exact `test-v2` setup above.

For an existing TrueNAS installation, update the image while retaining its
`/app/data` dataset mapping. The earlier quick test command used `--rm` without a
data volume: stopping that earlier disposable container deletes its configuration.

## TrueNAS 25.10 pilot and deployment

Use `deploy/truenas-quality.yaml` as the Custom App YAML. Before deployment:

1. The template pins a verified image digest. The mutable convenience tag is
   `quality-preview`; pull it again and recreate the container when updating.
   Check the pinned digest and branch build status before a new deployment.
2. Replace `NAS_LAN_IP` and `/mnt/POOL/...` using the NAS's actual configuration.
   Create dedicated app data/log datasets and keep any existing installation intact.
3. Deploy as `librarydownloadarr-quality` on port 5070, then set up the app's
   administrator and use **Settings → Connect with Plex**.
4. Sign in with a shared Plex account for the permission test.

The A310 stays assigned to Plex. Confirm Plex's existing hardware acceleration
settings and observe whether the download conversion uses hardware; successful
streaming transcoding alone does not prove that this download path uses it.
No GPU passthrough change to LibraryDownloadarr is required.

The operator confirmed successful downloads after the Plex storage correction.
The following extended acceptance scenarios are not all independently verified:

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
Following the successful operator pilot, an upstream PR is authorized.

## Development verification

```sh
cd backend
npm ci
npm test
cd ../frontend
npm ci
npm test
npm run build
```

The Node test suite uses a mock Plex HTTP server and real Express routes to check
quality parameters, queue state transitions, ownership, permission revocation,
no original fallback, cancellation, one-use session-bound tickets, MP4 streaming
and season ZIP contents. Additional tests cover stable account identity, strict
server selection, session-bound owner setup, migration, default/user policies,
original and bulk-route enforcement, and safe diagnostics. These use SQLite,
Express and simulated Plex responses; they do not validate live Plex OAuth,
a real PMS transcode or GPU use. Seven frontend page-handler tests simulate
isolated popup references and backend authorization/denial for both friend login
and owner setup, including explicit address selection and retry with a custom
URL. They run in the Docker build and do not use a live Plex account.

References:
- https://developer.plex.tv/pms/ (Download Queue and Profile Augmentations)
- https://apps.truenas.com/managing-apps/installing-custom-apps/

## Native download diagnostics and TrueNAS updates

The deployment examples now follow `quality-preview`, so TrueNAS can detect
image updates and offer its Update action. See `deploy/TRUENAS-CADDY.md` for the
one-time change from a pinned digest and rollback instructions.

API requests and native file POSTs now bypass the service worker entirely.
Previously its network-only handler still intercepted them via
`respondWith(fetch(request))`. The worker cache version is bumped for activation.
The app retains its normal shell caching; private API responses never enter it.

Transfer diagnostics report started/completed/failed, stage, HTTP status from
Plex if available, a bounded network code, elapsed milliseconds, and bytes passed
to the HTTP response. They do not log credentials, URLs, or media titles and
are visible in container console logs. Bytes passed to Caddy do not prove that
the browser has saved the file.

Validation: 36 backend tests (including a shared-user Plex 403 and a truncated
stream), 14 frontend tests, and both builds. A separate test sent 32 MiB through
real Caddy and the actual router/service with mock Plex and a shared account,
paused the receiving client for 35 seconds, then verified the complete SHA-256.
It completed in about 40 seconds. This does not reproduce the user's Internet
connection or prove the cause of their friend's failure.

A real Chrome probe also completed a 4 MiB native POST download with the old
worker and with the bypass, both under service-worker control. Thus the reported
remote failure was not reproduced and is not attributed to the worker. The
bypass removes unnecessary interception; diagnostics are needed from the failing
installation to identify its cause. Probe:
https://github.com/hloiseau/LibraryDownloadarr/actions/runs/36307251370
