# Photo Booth voor iPad

Web-app (PWA) + kleine server. Gasten drukken op **Maak foto's**, de app maakt 3 foto's met elke keer 5 seconden aftellen (optioneel met schermflits), maakt er een fotostrip van en verstuurt die via **e-mail** (als bijlage), **sms** (met downloadlink) of toont een **QR-code** waarmee de gast de foto direct op de eigen telefoon downloadt. Voor de QR-code is geen mail of sms nodig, maar `PUBLIC_URL` moet wel kloppen en bereikbaar zijn vanaf de telefoon van de gast.

```
photobooth/
├── server.js          ← server: opslaan, mail, sms, downloadpagina
├── .env.example       ← instellingen (kopiëren naar .env)
└── public/            ← de iPad-app (index.html, app.js, style.css)
```

---

## 1. Lokaal testen (5 minuten)

Nodig: [Node.js 18+](https://nodejs.org).

```bash
cd photobooth
npm install
cp .env.example .env      # laat mail/sms leeg = testmodus (er wordt alleen gelogd)
npm start
```

Open http://localhost:3000 in Chrome/Safari op je computer. In testmodus zie je in de terminal welke mail/sms verstuurd zou worden.

### Testen op de iPad (zonder eigen server)
```bash
npm run test-ipad
```
Dit start een gratis tijdelijke https-tunnel en toont een QR-code. Scan die met de camera van de iPad, open de link in Safari en sta de camera toe. De computer moet aan blijven tijdens het testen; elke keer krijg je een nieuw adres.

---

## 2. Versturen instellen

### E-mail: gratis via Gmail
1. Maak een apart Gmail-adres voor de booth (bv. `jouwfeest.photobooth@gmail.com`).
2. Zet tweestapsverificatie aan en maak een **app-wachtwoord** aan via myaccount.google.com/apppasswords.
3. Vul `SMTP_USER`, `SMTP_PASS` en `MAIL_FROM` in `.env` in.

Gmail laat ongeveer 500 mails per dag toe – ruim voldoende voor een feest. De fotostrip zit als bijlage in de mail.

### Sms: zonder kosten per bericht, via je eigen Android-telefoon
Echt gratis sms-diensten bestaan niet: elke sms-provider (Twilio, MessageBird, enz.) rekent per bericht. De gratis route is **je eigen telefoon de sms laten versturen** met de open-source app **TextBee**:

1. Pak een (oude) **Android**-telefoon met een simkaart met **onbeperkt sms** of een ruime sms-bundel. (iPhones kunnen dit niet: iOS laat apps niet automatisch sms'en.)
2. Maak een account op textbee.dev, installeer de TextBee-app op die telefoon en koppel hem.
3. Zet `TEXTBEE_API_KEY` en `TEXTBEE_DEVICE_ID` in `.env`.
4. Laat de telefoon aan de oplader en aan wifi tijdens het event.

De sms bevat een link naar een downloadpagina met de foto. Controleer vooraf even de actuele voorwaarden/limieten van TextBee's gratis account; je kunt TextBee ook zelf hosten (open source).

---

## 3. Online zetten (nodig voor iPad en sms-links)

De iPad-camera werkt alleen via **https**, en gasten moeten de downloadlink op hun eigen telefoon kunnen openen. De server moet dus via internet bereikbaar zijn. Twee opties:

**A. Laptop/mini-pc op het event + Cloudflare Tunnel (gratis)**
```bash
npm start
cloudflared tunnel --url http://localhost:3000
```
Je krijgt een `https://…trycloudflare.com`-adres. Open dat op de iPad. QR-codes en links gebruiken automatisch hetzelfde adres als de iPad, dus `PUBLIC_URL` hoef je niet in te vullen (alleen nodig als de iPad de app via `localhost` opent).

**Zonder internet/server:** met de knop **Delen / AirDrop** stuurt de iPad de fotostrip direct naar de telefoon van de gast (AirDrop, WhatsApp, Berichten). Daar is geen server voor nodig. Nadeel: als de laptop uit gaat, werken de sms-links niet meer (mail heeft de foto als bijlage, dus die blijft werken). Met een eigen domein kun je een vaste Cloudflare-tunnel maken, bv. op een Raspberry Pi thuis die altijd aan staat.

**B. Kleine server/VPS (± €4–6 per maand)** – bv. Hetzner of een vergelijkbare provider. Zet de map erop, `npm install`, draai met `pm2 start server.js`, en zet er https voor (Caddy doet dat automatisch). Links blijven dan altijd werken.

Foto's worden na `KEEP_DAYS` dagen (standaard 30) automatisch verwijderd.

---

## 4. Op de iPad zetten

1. Open in **Safari** op de iPad: `https://JOUW-ADRES/?key=JOUW_BOOTH_KEY` (eenmalig, zodat de iPad de sleutel onthoudt).
2. Tik op **Deel** (vierkantje met pijl) › **Zet op beginscherm**. Je hebt nu een "Photo Booth"-app zonder adresbalk.
3. Open de app vanaf het beginscherm en tik op **Sta toe** bij de cameravraag.
   - Vraagt hij steeds opnieuw? Ga naar **Instellingen › Apps › Safari › Camera** en kies **Sta toe**.
4. Instellingen voor een booth:
   - **Instellingen › Beeldscherm en helderheid › Automatische vergrendeling**: *Nooit*.
   - Helderheid op maximaal (dan werkt de schermflits het best).
   - **Niet storen** aan, zodat er geen meldingen in beeld komen.
   - Volume aan voor de aftelpiepjes.
5. Zet de iPad in een standaard/stand op ooghoogte, aan de oplader, liefst in liggende stand.

**Over de flits:** de frontcamera van een iPad heeft geen flitser. De app gebruikt daarom een **schermflits**: het scherm wordt fel wit op het moment van de foto (zoals de selfie-flits van Apple). Voor nog betere foto's: zet een ringlamp achter/boven de iPad.

---

## 5. iPad vergrendelen op alleen deze app

### Optie 1: Begeleide toegang (gratis, ingebouwd – aanbevolen)
1. **Instellingen › Toegankelijkheid › Begeleide toegang** › aanzetten.
2. Tik op **Toegangscode-instellingen** › stel een code in (en eventueel Face ID / Touch ID).
3. Zet **Automatische schermvergrendeling** binnen Begeleide toegang op *Nooit*.
4. Open de Photo Booth-app en **druk 3× snel op de zij-/topknop** (of de thuisknop op oudere iPads).
5. Zet in het menu eventueel *Volumeknoppen* en *Bewegingen* uit, tik op **Start**.

Gasten kunnen nu de app niet verlaten. Om te stoppen: 3× klikken en je code invoeren.

### Optie 2: Single App Mode via MDM (voor professioneel/meerdere iPads)
Met een **supervised** iPad (via Apple Configurator op een Mac) en een MDM-dienst kun je de iPad zó instellen dat hij altijd in één app opstart, ook na een herstart. Let op: supervisen wist de iPad. Dit is alleen de moeite waard als je meerdere booths of verhuur doet; voor eigen events is Begeleide toegang ruim voldoende.

---

## 6. Checklist op de dag zelf
- [ ] Server/laptop draait, QR-code getest met een telefoon op mobiele data
- [ ] Testmail en test-sms naar jezelf gestuurd
- [ ] Android-sms-telefoon aan de oplader en online
- [ ] iPad: oplader, helderheid max, Niet storen, Begeleide toegang aan
- [ ] Goede verlichting (ringlamp) en een leuke achtergrond

## Aanpassen
- Aantal foto's / aftelduur: bovenaan `public/app.js` (`SHOTS`, `COUNTDOWN`).
- Naam van het event en tekst onder de strip: `EVENT_NAME` en `STRIP_FOOTER` in `.env`.
- Kleuren: bovenaan `public/style.css`.

**Privacy:** je verwerkt e-mailadressen, telefoonnummers en foto's van gasten. De server bewaart alleen de foto (niet het adres/nummer) en verwijdert die automatisch. Meld bij de booth kort dat foto's tijdelijk worden opgeslagen.
