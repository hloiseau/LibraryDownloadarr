# Download quality and Plex sign-in

Movies, episodes and season downloads offer Original, 720p / 2 Mbps,
720p / 4 Mbps and 1080p / 8 Mbps. Plex prepares converted videos through its
Download Queue API. LibraryDownloadarr then streams the prepared H.264/AAC MP4
to the browser's native downloader; seasons are ZIPs of converted episodes.
It never silently falls back to the original when conversion fails.

## Requirements

- Plex Media Server 1.41.9+ with Download Queue support.
- The requesting Plex account must have access to the item and the download
  permissions/entitlement required by Plex. The integration does not bypass Plex
  restrictions; original downloads retain their separate existing path.
- LibraryDownloadarr must reach the chosen Plex URL. HTTPS certificates must
  validate; automatic redirects are disabled.
- Plex needs enough writable storage for complete prepared files. Configure
  **Settings → Server → Transcoder → Show Advanced → Downloads temporary directory**.
  This is separate from the temporary directory for live playback transcoding.

Plex performs the encoding and uses its existing hardware configuration.
LibraryDownloadarr needs no GPU or source-media mount for converted downloads.
For containerized Plex, the download staging path must exist inside its container
and be writable by the Plex process. A dedicated local volume works on TrueNAS.

## Connect Plex

1. Create the local app administrator, then select **Settings → Connect with Plex**.
2. Sign in with the Plex server owner's account and select the server.
3. Choose an advertised **Local**, **Remote** or **Relay** address, or enter a
   **Custom address** reachable from LibraryDownloadarr. Select **Test and use
   this address**. A failed test keeps the flow available for another address.
4. Friends use **Sign in with Plex** with their own accounts. They must already
   have access to this exact Plex server; their tokens authorize their requests.

Manual token configuration remains under Advanced. The browser receives an opaque
flow handle instead of Plex credentials. Owner setup is bound to the administrator
session. An isolated popup reference must not terminate polling: Plex can still
complete sign-in after the browser separates the popup from its opener.

Plex identities use the verified account id instead of the short-lived login PIN
id. On upgrade, existing Plex-user sessions are invalidated once so users sign in
with stable identities. Local admin sessions, settings and download history are
retained; historical duplicate account records are not silently merged.

## Download permissions

The administrator can set defaults and per-user overrides under **Download
permissions**: allow/deny downloads, restrict libraries, and choose allowed
qualities. Disable **Original file** to require conversion for videos. Audio
downloads require Original. Overrides replace defaults for that user.

These policies restrict downloads through LibraryDownloadarr; Plex controls library
visibility and access. Policies are enforced on original, converted and ZIP routes,
including each episode in a season. Access and current policy are checked again
before converted bytes are handed out. A transfer already in progress is not
interrupted by a policy change. Policies are bound to the configured server id;
after changing servers the administrator must save policies for the new server.

## Download lifecycle and limits

Choose a quality, wait for preparation, then click **Save file**. You can close
the page during preparation and return to **Downloads**. Converted media is streamed without accumulating the
whole file in a browser Blob. Browser download tickets are single-use, expire
after 60 seconds, and are sent in a POST body. Plex and session tokens do not
appear in converted-download URLs; tickets are bound to the app session.

Preparation displays a measured progress bar, elapsed time, and waiting,
conversion/finalization stages. It reads `TranscodeSession.progress` from the
requesting user's queue, with no global session access or administrator fallback.
Season progress is weighted by duration when all durations are known, otherwise
equally by file. Missing progress uses an indeterminate animation. Only verified
ready files report 100%; the browser tracks transfer progress after Save file.

The bitrate is a target and resolution is a maximum. Plex may choose a lower
resolution at a constrained bitrate. Audio/subtitle selection follows Plex's
per-user selection unless explicitly chosen in Download options; selected subtitles
are burned in. Converted files do not preserve all audio/subtitle tracks. Subtitle burn-in
and HDR tone mapping can affect conversion speed and hardware use.

The app verifies Plex's decision for transcoding, MP4, H.264, bounded resolution
and video bitrate. Static MP4 responses on PMS 1.43 can omit `protocol`; an
explicit protocol other than HTTP is rejected. Transfer Content-Length is checked
against a duration/quality-based bound. These checks rely on Plex's metadata;
independent output inspection remains useful when qualifying a new server.

There are at most two jobs per user and eight overall; a season is limited to
100 episodes. Preparation expires after 24 hours. Once ready, a converted file is
retained on Plex for up to six hours from readiness. Completed and interrupted
transfers release their stream but retain the prepared queue items. **Retry
download** requests a fresh single-use ticket for the same file, starting the
transfer from byte zero without reconverting it. The browser's own resume/retry
button is not supported by the single-use POST.

Selecting the same source and quality with the same account reuses its job,
including after refreshing the page. Cache entries are isolated by account and
Plex server. Current visibility, download policy, source/stream selection and
Plex availability are checked again. Concurrent identical preparation requests
share one conversion, and only one transfer of each job can run at a time.
Season ZIPs are rebuilt from the retained converted episodes.

Inactive entries are evicted least-recently-used when a new request needs a slot;
active conversions and transfers are never evicted for another request. Cache
retention is not extended by retries, and reaching expiry does not cut short a
transfer already in progress. Plex can expire its files earlier. Dismissing a
ready download card preserves its conversion; cancelling preparation still
removes it. Definitive access/decision failures, explicit cancellation, expiry,
eviction and graceful shutdown clean up owned queue items.

Job tracking remains in memory: an app restart requires preparing the file again.
An abrupt process kill can leave items on Plex until Plex expires them. Retention
uses Plex's download staging storage; LibraryDownloadarr stores no extra media
copy and requires no additional volume. Reuse on the user's authenticated PMS
still needs deployment validation; automated tests use a simulated Plex server.

## Troubleshooting

Connection errors distinguish DNS, connection refusal, timeout, certificate
validation, HTTP refusal and unexpected responses. The app only tests and saves
the selected address. A custom address must identify the expected Plex server
before receiving a token.

Conversion failures report queue status, profile, PMS version when available and
redacted decision details. Temporary missing entries and expired files are
handled separately. General/transcode code 1001 with `Conversion OK` is a plan,
not a completed file. If the queue then fails, use the UTC observation time and
queue/item ids to inspect Plex logs; intentional `directPlay=0` is not the cause.

In Plex Web, **Settings → Manage → Troubleshooting → Download Logs** gathers a ZIP.
Keep user logs private. A confirmed deployment failure was a missing writable
download staging mount in Plex; correcting that mount allowed downloads to finish.
Successful live-playback transcoding alone does not prove the download staging
path is writable.

PMS profile names are case-sensitive on Linux. This implementation sends
`Generic`, matching `Generic.xml`, and augments the static/streaming MP4 targets.

## Validation

The operator reported successful authenticated transcoded downloads on
26 September 2026 with TrueNAS 25.10 and PMS 1.43.4.10903-e5521bd8c, with an Intel
Arc A310 assigned to Plex. This is an operator report, not an independent claim
that every profile, hardware path or permission scenario was tested on that NAS.

Automated validation uses 58 backend tests with a simulated Plex HTTP server and
real Express routes, plus 25 frontend rendering/handler tests. It covers conversion
parameters, output guards, ownership, access revocation, queue cleanup, streaming,
season ZIPs, one-use tickets, identity migration, policy enforcement, address
selection, redaction, popup isolation and progress reporting. These tests are run during Docker builds.
A captured decision fixture came from an official PMS Linux instance with a
generated UHD clip. Unclaimed-server probes do not validate authenticated Download
Queue or GPU encoding.

```sh
cd backend
npm ci
npm test
cd ../frontend
npm ci
npm test
npm run build
```

Further deployment validation should cover shared accounts, 1080p, HDR/subtitle
variants, seasons, concurrent jobs, restart cleanup and independently measured
output. No universal-platform support claim is made from the single NAS pilot.

References:
- https://developer.plex.tv/pms/
- https://support.plex.tv/articles/transcoder/
- https://support.plex.tv/articles/200250417-plex-media-server-log-files/

## Native download transfer

API requests and native file POSTs bypass service-worker interception entirely.
A network-only `respondWith(fetch(request))` still intercepts attachment
navigations; return without calling it. The worker keeps normal shell caching
and bumps its cache version for activation.

Container console logs report transfer start, completion, and failure with job
id, stage, safe HTTP/error codes, elapsed time and bytes passed to the response.
These counts do not prove that the browser saved the file. No Plex tokens, URLs,
media titles or raw Axios errors are logged. A refused file request and a stream
cut short are covered by backend tests; neither records a successful download.

Validation: 36 backend tests, 14 frontend tests and both builds pass. A separate
32 MiB transfer through actual Caddy/router/service with mock Plex and a shared
user survived a 35-second client pause and passed SHA-256 verification. This is
a controlled proxy test, not a test of an Internet connection or a real user's
Plex permissions.

A real Chrome probe also completed a 4 MiB native POST download with the old
worker and with the bypass, both under service-worker control. Thus the reported
remote failure was not reproduced and is not attributed to the worker. The
bypass removes unnecessary interception; diagnostics are needed from the failing
installation to identify its cause. Probe:
https://github.com/hloiseau/LibraryDownloadarr/actions/runs/36307251370

Retention regression tests also cover complete and interrupted retries, browser
disconnects, cache isolation, current policies, changed source/audio selection,
expiry, eviction, concurrent requests and repeated ZIP transfers. They use mock
Plex, not the user's live server.

## Personal Downloads page

Every signed-in user has a **Downloads** navigation entry (`/downloads`) with
their conversions and transfers in progress, ready files and download history.
Progress refreshes every five seconds. Ready files show expiry, **Save file** and
removal actions. History supports title search, pagination and links back to media.
The admin global history remains separate; accounts do not share prepared files
or personal history. Current access and policy are checked before serving bytes.

Closing/refreshing the page leaves conversions running. Returning fetches existing
server-side jobs without preparing again. Existing retention and capacity limits
apply; job metadata is still lost on app restart. History persists in the existing
SQLite volume. The additive migration preserves legacy rows without inventing
their quality or successful completion.

Converted history records quality and completed server transfers. Original routes
record download requests; legacy rows retain a neutral status. A completed server
transfer does not prove that the browser saved the file on disk.

New tests cover account isolation, task lifecycle and missing/expired files,
history migration/persistence, literal search and pagination, ordinary-user
navigation, recovering existing jobs and leaving without cancellation. The new
page has not yet been validated on the live NAS.

## Audio and subtitle selectors

Movie, episode and season download buttons now open an options dialog with
Quality, Audio and Subtitles together. Choose Plex selection, an available track,
or None for subtitles. The Original mode keeps embedded tracks unchanged and
disables these selectors. Cancelling the dialog does not mutate Plex or queue work.

An authenticated read-only options endpoint validates the requested source and
quality against the caller's permissions. Seasons load full episode metadata and
offer only unambiguous matching tracks present in every episode; matching includes
language, title, codec/channels and forced/SDH/commentary flags. Multi-part season
episodes require individual-file downloads to select tracks.

Explicit choices use PUT /library/parts/{partId} with the requesting user's token
and allParts=0, then re-read metadata to confirm the selection before queuing.
This also updates the item's audio/subtitle preference in that Plex account, as
explained in the dialog. None sets subtitleStreamID=0 and subtitles=none. Output
remains single-audio MP4 with burned-in subtitles, not multi-track MKV.

Creations serialize by owner/server. Overlapping active conversions cannot have
their selections changed by another app request. Readiness and transfer checks
require the requested audio id and burned-subtitle/absence evidence in the queue
decision; a mismatch stops the download. Current media access and policy remain
enforced. External changes in a Plex client are outside the app's serialization.

Cache keys, filenames, snapshots and new history records distinguish the choices.
Explicitly selected cached files remain reusable after later preference changes;
source identity and stream metadata are still verified. Additive history columns
retain null labels for legacy records. Cache hits do not reapply preferences.

Validation: 58 backend and 25 frontend tests plus both production builds. New tests
cover scoped options, exact selection, account isolation, season matching, missing
tracks, None, concurrent requests, ignored selections, wrong decisions, cache reuse,
history labels, dialog loading/cancellation/stale responses and media-page routing.
Tests use simulated Plex; multilingual downloads on the live NAS remain to be tested.
