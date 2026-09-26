import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const output=fileURLToPath(new URL('../tests/fixtures/complete.m4a',import.meta.url));
const result=spawnSync('ffmpeg',['-y','-v','error','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=213.2','-ac','2','-c:a','libopus','-b:a','48k','-vbr','on','-frame_duration','20','-map_metadata','-1','-movflags','empty_moov+default_base_moof+frag_keyframe','-frag_duration','2000000','-f','mp4',output],{stdio:'inherit'});
if(result.error)throw result.error;
process.exitCode=result.status??1;
