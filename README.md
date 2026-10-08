# Laufbursche ETWOW unlock

A static web page that talks to E-TWOW e-scooters over Web Bluetooth. Connect, read the live status frames and - straight from the browser - set the speed-limit step, lock and unlock the scooter, toggle the light and change the zero-start and unit settings. Nothing to install: no app store, no signing, no developer account. It runs in **Bluefy** on iOS and in **Chrome** or **Edge** on Android or desktop.

> **This is a feasibility study - the writes are sent, their effect on hardware is unconfirmed.** It exists to show what E-TWOW's Bluetooth protocol makes possible, not to be a finished product; the protocol was reconstructed from the official app (`com.etwowconnect`, a React Native + Hermes build) and is documented byte for byte. Three model profiles (GT SE, GT TWO MOTOR, BOOSTER V) share one 5-byte `0x55` command frame and differ only in their BLE UUIDs, and there is no authentication, so any client that knows the frame format can read and write. The speed-limit register (opcode `0x02`) is a fixed 4-step value - no limit, 25, 20 or 6 km/h - not a free km/h number; the frame is sent on request, but whether the firmware honours it sits in the controller and cannot be proven from the app: it must be tested on the device. **Reading works, with a caveat:** the scooter streams 4-byte status frames and they are decoded (type 1/4 scaled, type 2 raw, type 3 as an 8-bit status field), but which physical quantity each value is (speed, battery, voltage) is not labelled in the app and remains device-side. Error-free operation is not promised and there is no warranty of any kind. Whatever you do with it, you do at your own risk - read the [Legal](#legal) section before you connect a scooter.

**Open the web app: [laufbursche42.github.io/etwow-unlock](https://laufbursche42.github.io/etwow-unlock/)**

Or run it yourself, no build step and no dependencies: clone the repo and serve the folder over a local HTTP server. Opening `index.html` directly as a `file://` URL will not work, the page fetches its own documents and browsers block that over `file://`.

```
git clone https://github.com/Laufbursche42/etwow-unlock.git
cd etwow-unlock
python -m http.server 8000
```

Any static server works. With Node installed, this does the same job:

```
npx serve .
```

Then open the printed address in a browser that supports Web Bluetooth.

**Guide: [Deutsch](GUIDE.de.md) | [English](GUIDE.en.md)** covers everything step by step, from connecting to the first send.

## What it does

- **Live values** - the decoded 4-byte status frames (type 1, 2, 4 numeric values, type 3 status field and number), plus a raw frame list per type.
- **Speed** - a fixed 4-step limit register (opcode `0x02`): no limit, 25, 20 or 6 km/h. There is no free km/h value in the protocol.
- **Lock** - the immobilizer, via opcode `0x05`.
- **More settings** - light (`0x06`), unit km/mi (`0x08`), zero-start (`0x03`).
- **Expert** - send a raw frame verbatim, or build one from an opcode plus a single argument byte (the `0x55` header, the `0x05` constant and the checksum are added for you).
- **Shortcut** - a home-screen link that removes the limit or locks to 20 km/h in a single tap.

## Protocol (proven)

- Three profiles, one protocol: GT SE and BOOSTER V on service `0xFFE0`, notify + write `0xFFE1`; GT TWO MOTOR on service `0xFF00`, notify `0xFF01`, write `0xFF02`. No pairing, no PIN.
- Command frame: `55 | cmd | 05 | arg | checksum`, checksum = `(0x55 + cmd + 0x05 + arg) & 0xFF`, written withoutResponse.
- Opcodes: `0x00/0x01` action off/on, `0x02` speed limit (arg 0=max, 1=6, 2=20, 3=25), `0x03` zero-start, `0x05` lock, `0x06` light, `0x08` unit, `0x09` reset km. Telemetry: 4-byte frames, byte 0 = type, bytes 1..2 = int16 LE.

## Honesty

Device-untested by design - you test on your own scooter, which is exactly the point of a public tool. An echo in the log means the scooter **accepted** the frame; only a change you can observe (a test ride, the on-device display) proves it actually took effect. The telemetry value semantics, the exact status-bit mapping and the firmware's enforcement of the speed and lock writes are device-side and were not recoverable from the app.

## Legal

License: PolyForm Noncommercial, see [License](LICENSE.md). Privacy: nothing leaves your device, see [Privacy](PRIVACY.md). Trademarks: E-TWOW is a trademark of its respective owner, this project is independent, see [Trademarks](TRADEMARKS.md).

Source: https://github.com/Laufbursche42/etwow-unlock
