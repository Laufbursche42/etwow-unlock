# Anleitung

> **Wichtig für Fehler-Reports:** Schalte unten auf der Seite den **Diagnose-Log** ein, *bevor* du dich mit dem Scooter verbindest. Nur dann wird der komplette Verbindungsaufbau mitgeschnitten - und genau diese Zeilen brauchen wir in einem [Ticket](https://github.com/Laufbursche42/Laufbursche42/issues), um ein Problem nachzuvollziehen.

## Was du brauchst
- Einen E-TWOW E-Scooter (GT SE, GT TWO MOTOR oder BOOSTER V).
- Ein Handy oder einen Rechner mit **Chrome**, **Edge** oder auf iOS **Bluefy**. Safari und Firefox können kein Web Bluetooth.

## Verbinden
1. Bluetooth am Gerät einschalten, den Scooter einschalten (wecken).
2. Auf **Verbinden** tippen und den Scooter in der Liste auswählen.
3. Taucht er nicht auf, setze den Haken bei **Alle Geräte zeigen** und verbinde erneut. Der echte Test ist der gefundene Bluetooth-Dienst (FFE0 oder FF00), nicht der angezeigte Name.
4. Das Modell wird am Dienst erkannt und im Gerätehinweis angezeigt. Nach dem Verbinden erscheinen die Karten für Live-Werte, Sperre, Geschwindigkeit und Einstellungen.

## Live-Werte lesen
Der Scooter sendet laufend 4-Byte-Status-Frames. Jede Kachel erscheint, sobald ihr Wert angekommen ist; ein Strich heißt nur, dass dieser Wert noch nicht kam. Die Werte sind decodiert (Typ 1 und 4 als Zahl mal 0,1, Typ 2 roh, Typ 3 als 8-Bit-Statusfeld plus Zahl). Was jeder Wert physikalisch bedeutet (Tempo, Akku, Spannung), steht nicht in der App und muss am Gerät geprüft werden. Unter den Kacheln kannst du mit **Alle empfangenen Frames** die Rohdaten pro Typ mitlesen.

## Geschwindigkeit setzen
- Das Limit ist ein fester Wert in vier Stufen: **Kein Limit**, **25 km/h**, **20 km/h (eKFV)** und **6 km/h (Schritttempo)**. Einen freien km/h-Wert gibt es im Protokoll nicht.
- Wichtig: Ein Echo im Log heißt nur, dass der Scooter das Frame angenommen hat. Ob die Firmware die Stufe wirklich durchsetzt, musst du an deinem Gerät ausprobieren. Die aktuell gesetzte Stufe meldet die App nicht zurück.

## Sperre
In der Karte **Sperre** sperrst oder entsperrst du den Scooter (Immobilizer, Opcode 0x05). Beachte: Einen gesperrten Scooter kannst du nur über Bluetooth wieder entsperren.

## Weitere Einstellungen
Licht, Einheit (km/mi) und Zero-Start. Die Zeilen sind Befehlswähler: Der Scooter meldet diese Zustände nicht zurück, daher gibt es keinen automatischen Abgleich.

## Erweiterte Einstellungen (Engine-Ebene)
**Rohes Frame** sendet deine Hex-Bytes unverändert. **Frame bauen** nimmt Opcode und Argument (je ein Byte) und ergänzt Header 0x55, die 0x05-Konstante und die Prüfsumme selbst.

## Shortcuts
Kopiere den Link auf den Startbildschirm, dann hebt ein Tipp das Limit auf oder sperrt auf 20 km/h. Auf iOS über Bluefy, und der Scooter muss vorher einmal normal verbunden gewesen sein.

## Wenn etwas nicht geht
- Kein Verbinden? Prüfe, dass der Browser Web Bluetooth kann, Bluetooth an ist und der Scooter wach ist. Mit **Alle Geräte zeigen** erneut versuchen.
- Nichts passiert nach einem Befehl? Schau ins Log: steht dort "gesendet" aber ändert sich nichts am Scooter, hat die Firmware das Frame nicht umgesetzt.
- **Diagnose: alle Geräte auflisten** im Log-Bereich zeigt alle Bluetooth-Dienste eines Geräts, ohne etwas zu schreiben - hilfreich für Support.

## Mithelfen
Willst du herausfinden, ob und wie Tuning bei deinem Scooter geht? Teste dieses Tool an deinem eigenen Fahrzeug und öffne ein Ticket auf [GitHub](https://github.com/Laufbursche42/Laufbursche42/issues) - mit deinem Modell und was funktioniert hat (oder nicht). So finden wir gemeinsam heraus, was bei welchem Modell möglich ist.
