# NexTerm Desk

Eine von [xjustanoah](https://github.com/xjustanoah) entwickelte SSH-Arbeitsoberfläche für Windows und Web: Serververbindungen, interaktives Terminal, SFTP-Dateiübertragung und Linux-Servermonitoring.

**Windows-Installer:** [NexTerm Desk 0.2.9 herunterladen](https://github.com/xjustanoah/NexTerm/releases/tag/v0.2.9)

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

Die gebaute Anwendung läuft dann auf `http://127.0.0.1:4783`. Beide Startbefehle verwenden `start-server.cjs`: Beim ersten Start wird in `~/.nexterm/.data-key` ein Datenschlüssel mit eingeschränkten Dateirechten angelegt. Kontodaten werden mit AES-256-GCM verschlüsselt. Bestehende Klartextdateien werden beim Start verschlüsselt. Fehlt ein Schlüssel für bereits verschlüsselte Dateien, bricht der Start ab, statt Daten unverschlüsselt neu zu speichern.

## Windows-Desktop-App

Baue einen Windows-Installer (`.exe`) mit:

```powershell
npm install
npm run dist:win
```

Der Installer liegt anschließend im Ordner `release/`. Einen fertigen Installer findest du außerdem auf der [GitHub-Releases-Seite](https://github.com/xjustanoah/NexTerm/releases). Beim Start kannst du zwischen zwei Betriebsarten wählen:

- **Lokaler Tresor:** Die Desktop-App öffnet den verschlüsselten Tresor direkt, ohne NexTerm-Konto oder Loginfenster. Serverprofile, Workspaces und Einstellungen bleiben im NexTerm-App-Profil und werden mit AES-256-GCM verschlüsselt. Der zufällige Datenschlüssel wird über Windows DPAPI geschützt. Vorhandene Kontodaten aus `~/.nexterm` werden in den Tresor kopiert.
- **Webserver:** Gib die HTTPS-Adresse deiner NexTerm-Instanz ein und melde dich dort mit dem Konto dieser Instanz an. Nur die Serveradresse wird für den nächsten Start gemerkt. Passwörter und private SSH-Schlüssel werden nicht in der Desktop-Konfiguration gespeichert.

Für Webserver sind HTTPS und WebSocket-Weiterleitung erforderlich. Wenn TLS an einem Reverse Proxy endet, starte NexTerm dahinter mit `TRUST_PROXY=1`, leite den ursprünglichen Host und das HTTPS-Schema korrekt weiter und aktiviere den WebSocket-Upgrade für `/terminal`. HTTP ist in der Desktop-App nur für `localhost` erlaubt. Aktiviere `TRUST_PROXY=1` nur, wenn direkte Zugriffe auf den Node-Port gesperrt sind und der vertrauenswürdige Proxy eingehende `X-Forwarded-*`-Header überschreibt. Andernfalls können gefälschte Forwarded-Header die IP-basierten Limits umgehen. Die Anwendungs-Limits sind pro Prozess und ersetzen keinen Rate- und Verbindungsschutz am öffentlichen Reverse Proxy; begrenze dort besonders `/api/auth`, `/api/admin` sowie HTTP-Anfragen insgesamt. Die SPA-Fallback-Route begrenzt unbekannte Seitenpfade zusätzlich auf 120 Anfragen pro Minute je erkannter IP; statische Dateien und `/` müssen weiterhin am Proxy geschützt werden.

Für selbst betriebene Webserver kannst du einen festen 32-Byte-Schlüssel sicher als `NEXTERM_DATA_KEY` im Dienst hinterlegen und bei jedem Start denselben Wert verwenden. Ohne diesen Wert erstellt `start-server.cjs` einen Schlüssel unter `~/.nexterm/.data-key`. Die Pelican-Installation verwaltet ihren Schlüssel separat in `/home/container/.nexterm/.data-key`. Geht der Schlüssel verloren, lässt sich der verschlüsselte Datenbestand nicht mehr entschlüsseln.

### Pelican-Startup

Lege im Pelican-Git-Installer `https://github.com/xjustanoah/NexTerm.git` und den Branch `main` fest und aktiviere Auto Update. Ersetze den bisherigen langen `node -e`-Startup durch:

```sh
exec /usr/local/bin/node /home/container/pelican-start.cjs
```

Das Skript installiert Produktionsabhängigkeiten, erstellt den Datenschlüssel beim ersten Start und startet `server.js` auf Port `8081`. Wenn `AUTO_UPDATE=1` und `.git` vorhanden sind, zieht es beim Start den Branch nach und prüft danach alle 60 Sekunden auf neue Commits. Für ein privates Repository müssen Pelican-Variablen `USERNAME` und `ACCESS_TOKEN` gesetzt sein; der Token wird nur an Git weitergegeben und aus der Umgebung von NexTerm und npm entfernt. Verwende keine Zugangsdaten direkt im Startup-Befehl. Der vorhandene `.nexterm/.data-key` muss bei jedem Neustart erhalten bleiben, sonst kann der verschlüsselte Datenbestand nicht geöffnet werden.

## Webkonten, Workspaces und Anmeldung

Neue Webkonten benötigen einen Anzeigenamen, Benutzernamen, eine E-Mail-Adresse und ein Passwort. Vorhandene Konten werden beim ersten Zugriff auf ein persönliches Workspace-Format migriert; gespeicherte Serverprofile bleiben dabei erhalten. Bei einer neuen, noch leeren Webserver-Installation muss der Betreiber vor dem ersten Konto `NEXTERM_ADMIN_BOOTSTRAP_TOKEN` als geschütztes Geheimnis mit mindestens 32 Zeichen setzen. Dieses Startgeheimnis ist für die Erstregistrierung erforderlich; das erste Konto wird Admin, und nach seiner Anlage ist der Startcode nicht mehr nötig. So kann niemand den Admin-Zugang durch eine schnellere öffentliche Registrierung übernehmen. Auf bestehenden Installationen wird der bisher erste Account zum Admin migriert, sofern `NEXTERM_ADMIN_USERNAME` nicht auf einen anderen Benutzernamen gesetzt ist. Admins können ausschließlich temporäre Passwörter für andere Konten setzen; betroffene Nutzer müssen dieses Passwort nach der Anmeldung ändern. Der lokale Tresor verwendet ein internes Profil, das kein sichtbares Anmeldekonto darstellt.

Passwortänderungen sind in den Kontoeinstellungen verfügbar. E-Mail-Passwort-Resets bleiben standardmäßig aus. Für den Versand müssen `NEXTERM_PASSWORD_RESET_ENABLED=1`, `NEXTERM_PUBLIC_URL`, `SMTP_HOST` und `SMTP_FROM` gesetzt werden. `NEXTERM_PUBLIC_URL` muss die feste HTTPS-Stammadresse der Instanz sein, zum Beispiel `https://ssh.noah-muxxle.dev`; sie wird für Reset-Links verwendet und verhindert, dass ein vom Request gesetzter Hostname in die E-Mail gelangt. Optional sind `SMTP_PORT` (Standard `587`), `SMTP_SECURE=1` für implizites TLS sowie `SMTP_USER` und `SMTP_PASS`. Reset-Links laufen nach 30 Minuten ab.

OTP und Passkeys sind pro Konto optional und werden in den Kontoeinstellungen aktiviert. Vor dem Aktivieren muss der Nutzer die einmalig angezeigten Wiederherstellungscodes bestätigen. Passkeys benötigen HTTPS; die lokale Desktop-App kann sie auf `localhost` verwenden. Wenn die Instanz hinter einem Proxy läuft, muss NexTerm mit `TRUST_PROXY=1` gestartet werden. Optional lassen sich `NEXTERM_WEBAUTHN_RP_ID` und `NEXTERM_WEBAUTHN_ORIGIN` explizit setzen.

Jeder Account kann mehrere Workspaces anlegen und zwischen ihnen wechseln. Serverprofile und SSH-Sitzungen sind an den jeweils aktiven Workspace gebunden. Diese Workspaces liegen für Web- und Desktop-Clients gemeinsam im NexTerm-Konto.

## Funktionen

- SSH-Verbindungen mit Passwort oder privatem Schlüssel samt optionaler Passphrase
- Interaktives Terminal mit Größenanpassung und Scrollback
- SFTP-Ordnernavigation, Upload und Download
- Live-Anzeigen für CPU, RAM, Root-Dateisystem und Netzwerkdurchsatz
- Serverprofile und bestätigte SSH-Host-Fingerabdrücke
- Lokale Benutzerkonten mit getrennten Serverlisten
- E-Mail-Adresse am Konto, Passwortänderung und optionaler SMTP-Passwortreset
- Workspaces mit getrennten Serverprofilen
- Optionales OTP und Passkeys mit bestätigungspflichtigen Wiederherstellungscodes
- Admin-Rolle zum Zurücksetzen fremder Kontopasswörter
- Anmeldung an einzelnen Servern per Passwort oder SSH-Schlüssel

Monitoring liest Linux-Werte aus `/proc` und verwendet `df` für das Root-Dateisystem. Es setzt daher ein Linux-Zielsystem voraus. Terminal und SFTP laufen auf dem jeweiligen SSH-Server.

## Datenschutz und Sicherheit

Der lokale Webdienst bindet standardmäßig an `127.0.0.1`. Benutzerkonten und die jeweils eigenen Serverprofile werden im Browsermodus in `~/.nexterm/users.json` gespeichert. Die Windows-Desktop-App verwendet einen separaten, mit AES-256-GCM verschlüsselten Tresor. Kontopasswörter werden mit individuellem Salt und scrypt abgeleitet; SSH-Passwörter und private Schlüssel werden nur zum Verbindungsaufbau verwendet und nicht gespeichert. Anmeldesitzungen liegen im Arbeitsspeicher und enden nach zwölf Stunden oder beim Abmelden. Serverprofile aus älteren lokalen Dateien werden in den Tresor kopiert. Bei der ersten Serververbindung wird der SSH-Fingerabdruck angezeigt; bei einer Änderung muss der neue Fingerabdruck bewusst bestätigt werden.

Lokale App-Konten bleiben im verschlüsselten Tresor dieses Geräts. Webserver-Konten und ihre Workspaces werden verschlüsselt auf der NexTerm-Instanz gespeichert. E-Mail-Adressen werden bei der Registrierung nicht verifiziert; aktiviere E-Mail-Resets erst, wenn SMTP und die feste öffentliche URL eingerichtet sind.

Die Anwendung enthält noch keine Auto-Updates, Team-Synchronisierung, Agent-Weiterleitung oder Unterstützung für Windows/FreeBSD-Servermonitoring.

## Lizenz und Urheberschaft

NexTerm Desk und die dazugehörigen eigenen Projektdateien wurden von **xjustanoah** erstellt. Der Quellcode wird unter einer eingeschränkten, nicht von der OSI anerkannten Lizenz veröffentlicht. Du darfst das Projekt nicht als dein eigenes ausgeben oder verkaufen. Die Bedingungen für private Nutzung, Weitergabe und kommerzielle Nutzung stehen in [LICENSE](LICENSE). Drittanbieter-Abhängigkeiten unterliegen ihren jeweiligen Lizenzen.
