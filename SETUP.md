# Tip Calculator Setup

One-time setup. Total time: about 15 minutes.

## 1. Create the Google Sheet

1. Go to sheets.new
2. Rename it (e.g., "Tip Ledger")
3. In row 1, paste this header (one paste fills A1:M1):

   ```
   Date	Time	Entered by	Total tips	# of full servers	Server names	Trainee name	Trainee %	Kitchen $	Chefs $	Per-server $	Trainee $	Submission ID
   ```

4. File → Settings → set the time zone to your restaurant's local timezone. Save.
5. Optional: freeze row 1 (View → Freeze → 1 row) and format columns D, I, J, K, L as currency.

## 2. Add the Apps Script

1. From the Sheet: Extensions → Apps Script
2. Delete any starter code in `Code.gs`
3. Paste the entire contents of `apps-script.gs` from this project
4. Click the disk icon to save. Name the project (e.g., "Tip Calc Webhook")

## 3. Deploy as a Web App

1. Click **Deploy** → **New deployment**
2. Click the gear icon next to "Select type" → choose **Web app**
3. Settings:
   - Description: anything (e.g., "Tip calc v1")
   - Execute as: **Me**
   - Who has access: **Anyone**
4. Click **Deploy**
5. The first time, you will be asked to authorize the script. Allow it.
6. Copy the **Web app URL** that ends in `/exec`. You'll need it in the next step.

## 4. Wire the form to the script

1. Open `index.html` in any text editor (Notepad, VS Code, etc.)
2. Find the line near the top of the second `<script>` block:

   ```javascript
   const ENDPOINT_URL = "PASTE_APPS_SCRIPT_URL_HERE";
   ```

3. Replace the placeholder with the `/exec` URL you copied. Save.

## 5. Test locally

1. Double-click `index.html` to open it in a browser
2. Fill in a fake shift:
   - Your name: TEST
   - Total tip amount: 100
   - 1 server, name TEST
3. Tap Submit. You should see "Shift recorded" with the breakdown.
4. Open your Sheet, a new row should appear with the timestamp and split.
5. Delete that test row from the Sheet before going live.

## 6. Host the form publicly

1. Go to https://app.netlify.com/drop
2. Drag the **entire `tip-calc/` folder** (containing `index.html`, `calc.js`, and any other files) onto the drop zone
3. Netlify gives you a public URL like `https://stately-bird-12345.netlify.app`
4. Open the URL on your phone. Save it as a home-screen bookmark.

To share with the team: text every server the link and have them save it to their home screen.

## Updates

If you change `apps-script.gs`:
- In the Apps Script editor: **Deploy** → **Manage deployments** → edit the existing deployment → bump the version → **Deploy**
- The `/exec` URL stays the same.

If you change `index.html` or `calc.js`:
- Go to your Netlify site → **Deploys** → drag the updated folder onto the deploy page to overwrite.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| "Could not save. Check your connection..." | The `ENDPOINT_URL` is wrong, or the Apps Script deployment is not set to "Anyone". |
| Form submits but no row appears in Sheet | Deployment is bound to the wrong Sheet, or "Execute as: me" was not selected during deployment. |
| Numbers in the Sheet show as `0.10` not `$0.10` | Format columns I/J/K/L as currency (Format → Number → Currency). |
| Time on rows is wrong | Sheet timezone is not set. File → Settings → Time zone. |
| Two rows for one shift | Should not happen with submissionId dedup; if it does, check that column M (Submission ID) is populated on both rows. |
