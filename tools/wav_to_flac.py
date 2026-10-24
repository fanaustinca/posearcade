"""Convert web/songs/*.wav (from render_songs.cjs) to FLAC and delete the WAVs."""
from pathlib import Path
import soundfile as sf

for wav in sorted((Path(__file__).parent.parent / "web" / "songs").glob("*.wav")):
    data, sr = sf.read(wav, dtype="int16")
    sf.write(wav.with_suffix(".flac"), data, sr, format="FLAC", subtype="PCM_16")
    wav.unlink()
    print(wav.with_suffix(".flac").name, f"{wav.with_suffix('.flac').stat().st_size / 1e6:.1f} MB")
