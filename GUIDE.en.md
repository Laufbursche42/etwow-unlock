# Guide

> **Important for error reports:** switch on the **Diagnostic log** at the bottom of the page *before* you connect to the scooter. Only then is the full connection handshake captured - and those are exactly the lines we need in a [ticket](https://github.com/Laufbursche42/Laufbursche42/issues) to reproduce a problem.

## What you need
- An E-TWOW e-scooter (GT SE, GT TWO MOTOR or BOOSTER V).
- A phone or computer with **Chrome**, **Edge**, or on iOS **Bluefy**. Safari and Firefox cannot do Web Bluetooth.

## Connecting
1. Turn on Bluetooth and wake the scooter.
2. Tap **Connect** and pick the scooter from the list.
3. If it is not listed, tick **Show all devices** and try again. The real check is the Bluetooth service found (FFE0 or FF00), not the advertised name.
4. The model is detected from the service and shown in the device line. Once connected, the live-values, lock, speed and settings cards appear.

## Reading live values
The scooter streams 4-byte status frames continuously. Each tile appears once its value has arrived; a dash just means that value has not come in yet. The values are decoded (type 1 and 4 as a number times 0.1, type 2 raw, type 3 as an 8-bit status field plus a number). What each value physically means (speed, battery, voltage) is not in the app and must be checked on the device. Below the tiles, **All received frames** lets you follow the raw data per type.

## Setting the speed
- The limit is a fixed value in four steps: **No limit**, **25 km/h**, **20 km/h (eKFV)** and **6 km/h (walking pace)**. There is no free km/h value in the protocol.
- Important: an echo in the log only means the scooter accepted the frame. Whether the firmware really enforces the step is something you must test on your own device. The app does not report the currently set step back.

## Lock
In the **Lock** card you lock or unlock the scooter (immobilizer, opcode 0x05). Note: a locked scooter can only be unlocked again over Bluetooth.

## More settings
Light, unit (km/mi) and zero-start. The rows are command selectors: the scooter does not report these states back, so there is no automatic sync.

## Advanced settings (engine level)
**Send a raw frame** sends your hex bytes unchanged. **Build a frame** takes an opcode and an argument (one byte each) and adds the 0x55 header, the 0x05 constant and the checksum for you.

## Shortcuts
Copy the link to your home screen, then one tap removes the limit or locks to 20 km/h. On iOS via Bluefy, and the scooter must have been connected normally once before.

## If something does not work
- Cannot connect? Check that the browser supports Web Bluetooth, Bluetooth is on and the scooter is awake. Retry with **Show all devices**.
- Nothing happens after a command? Check the log: if it says "sent" but nothing changes on the scooter, the firmware did not act on the frame.
- **Diagnostics: list all devices** in the log area shows every Bluetooth service of a device without writing anything - useful for support.

## Contribute
Want to find out if and how tuning works on your scooter? Test this tool on your own vehicle and open a ticket on [GitHub](https://github.com/Laufbursche42/Laufbursche42/issues) - with your model and what worked (or did not). That way we figure out together what is possible on which model.
