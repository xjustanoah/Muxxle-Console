# NexTerm Desk

Eine lokale SSH-Arbeitsoberfläche für Serververbindungen, ein interaktives Terminal, SFTP-Dateiübertragung und Linux-Servermonitoring.

## Starten

Voraussetzung: Node.js 20 oder neuer.

```powershell
npm install
npm run dev
```

Danach die im Terminal angezeigte Vite-Adresse öffnen. Für einen Produktionslauf:

```powershell
npm run build
npm start
```

Die gebaute Anwendung läuft dann auf `http://127.0.0.1:4783`.

## Windows-Desktop-App

Baue einen Windows-Installer (`.exe`) mit:

```powershell
npm install
npm run dist:win
```

Der Installer liegt anschließend unter `release/NexTerm-Desk-0.1.0-Setup.exe`. Beim Start kannst du zwischen zwei Betriebsarten wählen:

- **Lokaler Tresor:** Die Desktop-App legt den Datenspeicher im NexTerm-App-Profil ab und verschlüsselt Konten und Serverprofile mit AES-256-GCM. Der zufällige Datenschlüssel wird über Windows DPAPI geschützt. Vorhandene Kontodaten aus `~/.nexterm` werden in den Tresor kopiert.
- **Webserver:** Gib die HTTPS-Adresse deiner NexTerm-Instanz ein und melde dich dort mit dem Konto dieser Instanz an. Nur die Serveradresse wird für den nächsten Start gemerkt. Passwörter und private SSH-Schlüssel werden nicht in der Desktop-Konfiguration gespeichert.

Für Webserver sind HTTPS und WebSocket-Weiterleitung erforderlich. Wenn TLS an einem Reverse Proxy endet, starte NexTerm dahinter mit `TRUST_PROXY=1`, leite den ursprünglichen Host und das HTTPS-Schema korrekt weiter und aktiviere den WebSocket-Upgrade für `/terminal`. HTTP ist in der Desktop-App nur für `localhost` erlaubt.

Für gespeicherte Konten auf einem selbst betriebenen Webserver kannst du zusätzlich einen festen 32-Byte-Schlüssel konfigurieren: einmalig mit `openssl rand -hex 32` erzeugen, sicher als `NEXTERM_DATA_KEY` im Dienst hinterlegen und bei jedem Start denselben Wert verwenden. Zusammen mit `TRUST_PROXY=1` werden Konten und Serverprofile serverseitig verschlüsselt. Geht dieser Schlüssel verloren, lässt sich der Datenbestand nicht mehr entschlüsseln.

## Funktionen

- SSH-Verbindungen mit Passwort oder privatem Schlüssel samt optionaler Passphrase
- Interaktives Terminal mit Größenanpassung und Scrollback
- SFTP-Ordnernavigation, Upload und Download
- Live-Anzeigen für CPU, RAM, Root-Dateisystem und Netzwerkdurchsatz
- Serverprofile und bestätigte SSH-Host-Fingerabdrücke
- Lokale Benutzerkonten mit getrennten Serverlisten
- Anmeldung an einzelnen Servern per Passwort oder SSH-Schlüssel

Monitoring liest Linux-Werte aus `/proc` und verwendet `df` für das Root-Dateisystem. Es setzt daher ein Linux-Zielsystem voraus. Terminal und SFTP laufen auf dem jeweiligen SSH-Server.

## Datenschutz und Sicherheit

Der lokale Webdienst bindet standardmäßig an `127.0.0.1`. Benutzerkonten und die jeweils eigenen Serverprofile werden im Browsermodus in `~/.nexterm/users.json` gespeichert. Die Windows-Desktop-App verwendet einen separaten, mit AES-256-GCM verschlüsselten Tresor. Kontopasswörter werden mit individuellem Salt und scrypt abgeleitet; SSH-Passwörter und private Schlüssel werden nur zum Verbindungsaufbau verwendet und nicht gespeichert. Anmeldesitzungen liegen im Arbeitsspeicher und enden nach zwölf Stunden oder beim Abmelden. Serverprofile aus älteren lokalen Dateien werden in den Tresor kopiert. Bei der ersten Serververbindung wird der SSH-Fingerabdruck angezeigt; bei einer Änderung muss der neue Fingerabdruck bewusst bestätigt werden.

Die Konten sind lokale App-Konten auf diesem Gerät; es gibt noch keine Cloud-Synchronisierung, E-Mail-Verifizierung oder zentrale Nutzerverwaltung. Wer Zugriff auf dasselbe Windows-Konto und den lokalen Dienst hat, kann ein lokales NexTerm-Konto anlegen.

Die Anwendung enthält noch keine Auto-Updates, Team-Synchronisierung, Agent-Weiterleitung oder Unterstützung für Windows/FreeBSD-Servermonitoring.
