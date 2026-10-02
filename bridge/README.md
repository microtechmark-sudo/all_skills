# Phone ⇄ PC Bridge

A tiny web page, served from your PC over the **local Wi-Fi address**, that lets a
smartphone and a desktop share text and files in real time. No internet, accounts or
`npm install` needed — just Node.js 18+.

```bash
cd bridge
node server.js            # optional: --port 9000, --no-key
```

The terminal prints the Wi-Fi link, e.g. `http://192.168.1.20:8080/?key=ab12cd34`.
Open `http://localhost:8080/…` on the PC; its page shows a QR code for the same link —
scan it with the phone (both on the same Wi-Fi).

## Features
- Send text either way (links are clickable, one-tap copy)
- Send files either way with progress bars; drag & drop, file picker, or paste images
- Live updates (Server-Sent Events); works in any modern browser
- Pairing key in the link/QR so only people with it can use the bridge on shared Wi-Fi
  (`--no-key` disables this)

## Notes
- Shared items live in memory/temp storage and are deleted when the server stops.
- If the phone can't connect, allow Node through the PC firewall for private networks.
- Traffic is plain HTTP on your LAN; don't use on untrusted networks.
- Bundled `public/qrcode.js` is qrcode-generator (MIT, Kazuhiko Arase).
