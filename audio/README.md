# Audio probe reference fixture

A single short mono 16 kHz WAV (`probe.wav`) used by the speech-to-text capability
probe. It is a 0.25 s 440 Hz tone followed by silence: small, valid PCM that every
ASR model accepts and returns a 200 for, without needing a copyrighted speech clip.

The probe only checks that the transcription endpoint accepts the upload and
returns a well-formed response (a `text` field), not transcription accuracy, so a
tone burst is sufficient. Whisper returns a short hallucinated phrase ("Thank you.")
for near-silent input, which is the expected 200 path.

For local testing only; never redistributed (an input to a probe, not part of the
released package).

| File        | Subject                                 | Use                         |
| ----------- | --------------------------------------- | --------------------------- |
| `probe.wav` | 0.25 s 440 Hz tone + silence, 1 s total | STT/ASR transcription probe |

## Refresh

Regenerate with:

```bash
python3 -c "
import wave, math, struct
sr=16000
with wave.open('audio/probe.wav','wb') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
    w.writeframes(b''.join(struct.pack('<h', int(3000*math.sin(2*math.pi*440*i/sr)) if i<sr//4 else 0) for i in range(sr)))
"
```
