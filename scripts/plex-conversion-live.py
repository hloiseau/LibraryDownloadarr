import json
import pathlib
import subprocess
import sys
import time
import urllib.parse
import urllib.request

base = 'http://127.0.0.1:32400'
headers = {'Accept': 'application/json', 'X-Plex-Client-Identifier': 'librarydownloadarr-live-test',
           'X-Plex-Product': 'LibraryDownloadarr', 'X-Plex-Client-Profile-Name': 'Generic'}
extra = '+'.join(f'add-transcode-target(type=videoProfile&context={context}&protocol=http&container=mp4&videoCodec=h264&audioCodec=aac&replace=true)' for context in ['static', 'streaming'])
profiles = [('720p-2', 1280, 720, 2000), ('720p-4', 1280, 720, 4000), ('1080p-8', 1920, 1080, 8000)]
for quality, width, height, bitrate in profiles:
    params = {'path': '/library/metadata/1', 'context': 'static', 'mediaIndex': 0, 'partIndex': 0,
              'protocol': 'http', 'directPlay': 0, 'directStream': 0, 'directStreamAudio': 0,
              'videoBitrate': bitrate, 'maxVideoBitrate': bitrate, 'videoResolution': f'{width}x{height}', 'videoQuality': 100,
              'audioChannelCount': 2, 'subtitles': 'burn', 'advancedSubtitles': 'burn',
              'autoAdjustQuality': 0, 'X-Plex-Client-Profile-Extra': extra,
              'session': 'librarydownloadarr-live-' + quality}
    if quality == '720p-2':
        for variant in [{}, {'maxVideoBitrate': bitrate}, {'hasMDE': 1}, {'maxVideoBitrate': bitrate, 'hasMDE': 1}]:
            probe_params = {k: v for k, v in params.items() if k != 'maxVideoBitrate'}
            probe_params.update(variant)
            url = base + '/video/:/transcode/universal/decision?' + urllib.parse.urlencode(probe_params)
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=60) as res:
                container = json.load(res)['MediaContainer']
            media = container['Metadata'][0]['Media'][0]
            print('PARAMETER PROBE', json.dumps(variant), json.dumps({k: media.get(k) for k in ['width', 'height', 'bitrate', 'container']}), flush=True)
    query = urllib.parse.urlencode(params)
    url = base + '/video/:/transcode/universal/decision?' + query
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=60) as res:
        decision = json.load(res)
    print('LIVE DECISION', quality, json.dumps(decision), flush=True)
    result = pathlib.Path('/tmp/live-decision.json')
    result.write_text(json.dumps(decision))
    subprocess.run(['node', '-e', 'const {verifyDecision}=require("./backend/dist/services/downloadService"); verifyDecision(require("/tmp/live-decision.json").MediaContainer, process.argv[1]);', quality], check=True)
    media = decision['MediaContainer']['Metadata'][0]['Media'][0]
    assert media['width'] == width and media['height'] == height, 'Requested output dimensions not reached'
    output = pathlib.Path('/tmp/live-' + quality + '.mp4')
    try:
        url = base + '/video/:/transcode/universal/start.mp4?' + query
        with urllib.request.urlopen(urllib.request.Request(url, headers={**headers, 'Accept': 'video/mp4'}), timeout=120) as res:
            print('LIVE CONTENT TYPE', res.headers.get('Content-Type'), flush=True)
            data = res.read(15000000)
            assert len(data) < 15000000, 'Unexpectedly large output'
            output.write_bytes(data)
        info = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(output)]))
        video = next(s for s in info['streams'] if s['codec_type'] == 'video')
        audio = next(s for s in info['streams'] if s['codec_type'] == 'audio')
        assert video['codec_name'] == 'h264' and audio['codec_name'] == 'aac'
        assert video['width'] == width and video['height'] == height
        assert 3.8 <= float(info['format']['duration']) <= 4.5
        assert int(video['bit_rate']) <= bitrate * 1250
        print('LIVE ENCODING PASS', quality, json.dumps({'video': video['codec_name'], 'audio': audio['codec_name'],
              'width': video['width'], 'height': video['height'], 'bitrate': video['bit_rate'],
              'bytes': info['format']['size'], 'duration': info['format']['duration']}), flush=True)
    finally:
        try:
            urllib.request.urlopen(base + '/video/:/transcode/universal/stop?' + urllib.parse.urlencode({'session': params['session']}), timeout=10).close()
        except Exception:
            pass
