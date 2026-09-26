"""Build the unpacked extension zip using only Python's standard library."""
from pathlib import Path
import hashlib
import json
import zipfile

root = Path(__file__).resolve().parents[1]
source = root / 'extension'
version = json.loads((source / 'manifest.json').read_text())['version']
assert (source / 'bootstrap-state.js').read_text().strip().endswith('export const bootstrapState = null;'), 'Personal migration data cannot be released'
output = root / 'dist'
output.mkdir(exist_ok=True)
archive = output / f'suno-save-assistant-v{version}.zip'
with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as z:
    for path in sorted(source.rglob('*')):
        if not path.is_file() or path.name.startswith('.'):
            continue
        name = 'suno-save-assistant/' + path.relative_to(source).as_posix()
        info = zipfile.ZipInfo(name, (2026, 9, 26, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        z.writestr(info, path.read_bytes())
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
(output / 'SHA256SUMS').write_text(f'{digest}  {archive.name}\n')
print(f'{archive.name}: {digest}')
