import json
import os
import pathlib
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = 'http://127.0.0.1:32400'
HEADERS = {'Accept': 'application/json', 'X-Plex-Client-Identifier': 'librarydownloadarr-probe',
           'X-Plex-Product': 'LibraryDownloadarr', 'X-Plex-Pms-Api-Version': '1.0'}

def request(path, method='GET', params=None, headers=None):
    url = BASE + path + ('?' + urllib.parse.urlencode(params) if params else '')
    req = urllib.request.Request(url, method=method, headers={**HEADERS, **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            data = res.read()
            return json.loads(data) if data else {}
    except urllib.error.HTTPError as exc:
        print('HTTP FAILURE', method, path, exc.code, exc.read(4000).decode(errors='replace'), flush=True)
        raise

for attempt in range(60):
    try:
        identity = request('/identity')
        if identity['MediaContainer'].get('startState') not in ['starting', 'startingPlugins']:
            print('PMS identity', identity, flush=True)
            break
    except Exception:
        if attempt == 59:
            raise
    time.sleep(1)

request('/library/sections', 'POST', {'name': 'Generated test only', 'type': 'movie',
        'agent': 'tv.plex.agents.none', 'scanner': 'Plex Video Files',
        'language': 'en-US', 'location': '/tmp/plex-test-media'})
section = request('/library/sections')['MediaContainer']['Directory'][0]['key']
request(f'/library/sections/{section}/refresh')
for attempt in range(60):
    items = request(f'/library/sections/{section}/all')['MediaContainer'].get('Metadata', [])
    if items and items[0].get('Media'):
        break
    time.sleep(1)
assert items, 'Generated sample not scanned'
key = items[0]['key']
print('Generated source', json.dumps(items[0].get('Media')), flush=True)
if os.environ.get('PROBE_SETUP_ONLY'):
    raise SystemExit(0)
extra = '+'.join(f'add-transcode-target(type=videoProfile&context={context}&protocol=http&container=mp4&videoCodec=h264&audioCodec=aac&replace=true)' for context in ['static', 'streaming'])
params = {'mediaIndex': 0, 'partIndex': 0, 'protocol': 'http', 'directPlay': 0, 'directStream': 0,
          'directStreamAudio': 0, 'videoBitrate': 2000, 'videoResolution': '1280x720',
          'audioChannelCount': 2, 'subtitles': 'burn', 'advancedSubtitles': 'burn', 'autoAdjustQuality': 0}
for profile in ['generic', 'Generic']:
    for location in ['query', 'header']:
        headers = {'X-Plex-Client-Profile-Name': profile}
        query = dict(params)
        (headers if location == 'header' else query)['X-Plex-Client-Profile-Extra'] = extra
        print(f'VARIANT profile={profile} extra={location}', flush=True)
        try:
            d = request('/video/:/transcode/universal/decision', params={**query, 'path': key, 'context': 'static'}, headers=headers)
            print('DIRECT DECISION', json.dumps(d), flush=True)
        except urllib.error.HTTPError as exc:
            print('DIRECT HTTP', exc.code, exc.read(2000).decode(errors='replace'), flush=True)
        queue_id = None
        item_ids = []
        try:
            queue_id = request('/downloadQueue', 'POST', headers=headers)['MediaContainer']['DownloadQueue'][0]['id']
            added = request(f'/downloadQueue/{queue_id}/add', 'POST', {**query, 'keys': key}, headers)
            print('ADD', json.dumps(added), flush=True)
            item_ids = [str(i['id']) for i in added['MediaContainer']['AddedQueueItems']]
            for attempt in range(45):
                status = request(f'/downloadQueue/{queue_id}/items/' + ','.join(item_ids), headers=headers)
                items = status['MediaContainer'].get('DownloadQueueItem', [])
                if items and all(i['status'] in ['available', 'error', 'expired'] for i in items):
                    break
                time.sleep(1)
            print('QUEUE RESULT', json.dumps(status), flush=True)
            if items and items[0]['status'] == 'available':
                decision = request(f'/downloadQueue/{queue_id}/item/{item_ids[0]}/decision', headers=headers)
                print('QUEUE DECISION', json.dumps(decision), flush=True)
                output = f'/tmp/plex-test-{profile}-{location}.mp4'
                req = urllib.request.Request(BASE + f'/downloadQueue/{queue_id}/item/{item_ids[0]}/media', headers={**HEADERS, **headers})
                with urllib.request.urlopen(req, timeout=60) as res, open(output, 'wb') as out:
                    out.write(res.read(10000000))
                import subprocess
                subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_name,width,height,bit_rate:format=size,duration', '-of', 'json', output], check=True)
        except urllib.error.HTTPError as exc:
            print('QUEUE HTTP', exc.code, exc.read(2000).decode(errors='replace'), flush=True)
        finally:
            if queue_id and item_ids:
                request(f'/downloadQueue/{queue_id}/items/' + ','.join(item_ids), 'DELETE', headers=headers)
