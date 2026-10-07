# ModdedTransfer

I had a problem: I needed to upload samples to my modded Model:Cycles from
my iPad via a USB cable, and there was no tool for that — so [this page](https://ktwzk.github.io/modded-transfer/) is my
workaround for it.

For this to work you'll need [Web MIDI Browser](https://apps.apple.com/us/app/web-midi-browser/id953846217)
by that guy — Takashi Mizuhiki ([mizuhiki/WebMIDIAPIShimForiOS](https://github.com/mizuhiki/WebMIDIAPIShimForiOS)).
Open [this page](https://ktwzk.github.io/modded-transfer/) in his app, plug the iPad into the Cycles, upload.

Honest disclaimer: it's pure AI slop, no code was written by a human. It's
tested with Modded-Cycles 1.21 on my Model:Cycles and iPad mini 6 though.

I recommend only using it in Web MIDI Browser, but it'll probably work
somewhere else — any browser with Web MIDI should do.

Design is poorly stolen from 18nelli18's [Modded-Cycles](https://18nelli18.github.io/Modded-Cycles/) —
also I recommend his flasher and truly appreciate his work. If you've found
this sample uploader useful, tip 18nelli18 on [Ko-fi](https://ko-fi.com/18nelli).

None of this would be possible without the great work of TinyGregAudio on
[Model-TG](https://github.com/TinyGregAudio/Model-TG) —
the custom firmware that makes sample transfer to the Model:Cycles possible
in the first place.

## Quick start

1. On the Cycles: **Device Config → Transfer → SMP** (after a power cycle it
   returns to CYC — set SMP again). In Web MIDI Browser's Device Config make
   sure SysEx is enabled.
2. Open [https://ktwzk.github.io/modded-transfer/](https://ktwzk.github.io/modded-transfer/)
   in Web MIDI Browser, tap **Connect**, pick the output + input ports.
3. Choose audio, rename each sample (that name is what lands on the device),
   tap **Upload**.
4. If the app ever closes the moment you send something: reopen, Connect,
   run **Probe** — it retests the send path and remembers what crashed.

## Supported formats

WAV · MP3 · M4A · AAC · OGG · AIFF · FLAC · MP4 · MOV. Everything is
converted on the page to 48 kHz mono 16-bit; MP4/MOV contribute only their
audio track (there is a separate picker that opens Apple Photos on
iPad/iPhone).

## Troubleshooting

- No MIDI ports at all — SysEx is probably disabled in the Web MIDI
  Browser app's Device Config.
- The app closes on send — that's the native bridge, not the page: reopen,
  Connect, Probe; it marks the crashing format dead and uses the other one.
- "Not 48kHz mono" on the device for an uploaded sample — open an issue;
  the page may need a byte-order flip (`WIRE_LE` in `js/core.js`).
- Deleting a sample sometimes doesn't work — that's the device, not the
  page: it doesn't work in the official transfer app either. Just reboot
  the device and then you can delete.

## License

WTFPL — do what the fuck you want to (see LICENSE).
