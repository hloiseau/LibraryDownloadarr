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

Choose a quality, wait for preparation, then click **Save file**. Keep the page
open during preparation. Converted media is streamed without accumulating the
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
per-user selection; selected subtitles are burned in. This version does not offer
separate stream selection or preserve all audio/subtitle tracks. Subtitle burn-in
and HDR tone mapping can affect conversion speed and hardware use.

The app verifies Plex's decision for transcoding, MP4, H.264, bounded resolution
and video bitrate. Static MP4 responses on PMS 1.43 can omit `protocol`; an
explicit protocol other than HTTP is rejected. Transfer Content-Length is checked
against a duration/quality-based bound. These checks rely on Plex's metadata;
independent output inspection remains useful when qualifying a new server.

There are at most two jobs per user and eight overall; a season is limited to
100 episodes. Prepared jobs expire after 24 hours. Owned queue items are cleaned
up on cancellation, detected failure, completed/disconnected transfer, expiry and
graceful shutdown. Job tracking is in memory: an app restart requires preparing
the file again. Abrupt termination can leave items until Plex expires them.
Single-use POST downloads do not support browser resume; prepare a new download
after an interrupted transfer.

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

Automated validation uses 34 backend tests with a simulated Plex HTTP server and
real Express routes, plus 11 frontend rendering/handler tests. It covers conversion
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
