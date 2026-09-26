"""Compare complete static HTTP outputs on an isolated, generated-media PMS."""
import http.client
import json
import pathlib
import subprocess
import urllib.error
import urllib.parse
import urllib.request
import uuid

base = 'http://127.0.0.1:32400'
results = []
for container, quality, width, height, bitrate in [
    ('mp4', '720p-2', 1280, 720, 2000),
    ('mkv', '720p-2', 1280, 720, 2000),
    ('mkv', '720p-4', 1280, 720, 4000),
    ('mkv', '1080p-8', 1920, 1080, 8000),
]:
    session = str(uuid.uuid4())
    headers = {'Accept': 'application/json', 'X-Plex-Client-Identifier': session,
               'X-Plex-Product': 'LibraryDownloadarr', 'X-Plex-Client-Profile-Name': 'Generic'}
    extra = '+'.join(f'add-transcode-target(type=videoProfile&context={context}&protocol=http&container={container}&videoCodec=h264&audioCodec=aac&replace=true)' for context in ['static', 'streaming'])
    params = {'path': '/library/metadata/1', 'context': 'static', 'mediaIndex': 0, 'partIndex': 0,
              'protocol': 'http', 'directPlay': 0, 'directStream': 0, 'directStreamAudio': 0,
              'videoBitrate': bitrate, 'videoResolution': f'{width}x{height}',
              'audioChannelCount': 2, 'subtitles': 'burn', 'advancedSubtitles': 'burn',
              'autoAdjustQuality': 0, 'X-Plex-Client-Profile-Extra': extra, 'session': session}
    query = urllib.parse.urlencode(params)
    label = container + '/' + quality
    try:
        request = urllib.request.Request(base + '/video/:/transcode/universal/decision?' + query, headers=headers)
        with urllib.request.urlopen(request, timeout=60) as response:
            decision = json.load(response)
        media = decision['MediaContainer']['Metadata'][0]['Media'][0]
        print('DECISION', label, json.dumps(decision), flush=True)
        request = urllib.request.Request(base + f'/video/:/transcode/universal/start.{container}?' + query,
                                         headers={**headers, 'Accept': '*/*'})
        with urllib.request.urlopen(request, timeout=90) as response:
            print('CONTENT TYPE', label, response.headers.get('Content-Type'), flush=True)
            data = response.read(15000000)
        assert 0 < len(data) < 15000000, 'Unexpected file size'
        output = pathlib.Path(f'/tmp/container-test-{container}-{quality}.{container}')
        output.write_bytes(data)
        info = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', str(output)]))
        video = next(s for s in info['streams'] if s['codec_type'] == 'video')
        audio = next(s for s in info['streams'] if s['codec_type'] == 'audio')
        assert video['codec_name'] == 'h264' and audio['codec_name'] == 'aac'
        assert 0 < video['width'] <= width and 0 < video['height'] <= height
        assert video['width'] == media['width'] and video['height'] == media['height']
        assert int(video['nb_read_frames']) == 96, 'Truncated or unexpected video length'
        assert len(data) < 4 * (bitrate * 1.5 + 512) * 1000 / 8
        subprocess.run(['ffmpeg', '-v', 'error', '-xerror', '-i', str(output), '-f', 'null', '-'], check=True)
        summary = {'video': video['codec_name'], 'audio': audio['codec_name'], 'width': video['width'],
                   'height': video['height'], 'frames': video['nb_read_frames'], 'bytes': len(data),
                   'format': info['format']['format_name']}
        print('COMPLETE FILE PASS', label, json.dumps(summary), flush=True)
        results.append((container, quality, True))
    except Exception as exc:
        print('COMPLETE FILE FAIL', label, type(exc).__name__, str(exc), flush=True)
        results.append((container, quality, False))
    finally:
        try:
            request = urllib.request.Request(base + '/video/:/transcode/universal/stop?' + urllib.parse.urlencode({'session': session}), headers=headers)
            urllib.request.urlopen(request, timeout=10).close()
        except Exception:
            pass

assert all(ok for container, quality, ok in results if container == 'mkv'), results
print('MKV samples completed and decoded. This does not test authenticated Download Queue or hardware encoding.', flush=True)
