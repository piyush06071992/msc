# Minerva Email Bot (Google Apps Script)

This folder is the source of the **Minerva Email Bot** Apps Script project (the web app the portal
and the Cloud Function call to send emails).

- `Code.gs` — the script
- `appsscript.json` — its settings (permissions, web app access)
- `.clasp.json` — which Apps Script project this is (Script ID)

**Edit the script here, not in the Apps Script editor.** On every merge to `main` that changes this
folder, the GitHub Action *Deploy Email Bot (Apps Script)* uploads the files and updates the
existing web app deployment (same URL), so the portal keeps working without changes.

The Action needs the GitHub secret `CLASPRC_JSON` (the login key of the account that owns the
script). Without it the Action only reports that the secret is missing.

This folder is not published on the website (see `firebase.json` → `ignore`).
