# Ottoman Bey Restaurant POS — Online Edition

This is your POS turned into a real website: one shared database on a server,
live-synced to every phone and computer that opens it — for free.

## What changed from the offline version
- Same exact app (menus, roles, screens, sounds, bilingual toggle) — only the
  data layer changed.
- Data now lives on a small Node.js server instead of each device's browser.
- Real-time updates (new orders, status changes, messages) now travel over
  the internet via Socket.io, so a phone in the kitchen and a laptop at the
  cashier stay in sync instantly, from anywhere.
- Login now uses a token stored on each device, so staff don't need to
  re-login every time they refresh.

## Deploy it for free (Render.com)
Render's free tier costs nothing, needs no credit card, and gives you a
public `https://` link you can open from any phone or computer.

1. Create a free account at https://render.com (sign in with GitHub is
   easiest).
2. Put this `server` folder in its own GitHub repository (create a new repo,
   upload/push these files).
3. In Render, click **New +** → **Web Service** → connect that repo.
4. Settings:
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free
5. Click **Create Web Service**. Render will give you a URL like
   `https://ottoman-bey-pos.onrender.com`.
6. Open that URL on any phone or computer — it shows two buttons: **Staff
   POS** and **Admin Panel**. Bookmark/add-to-homescreen whichever one each
   device needs.

First login (change this immediately in Admin → Staff Management):
- Username: `superadmin`
- Password: `Admin@Ottoman2024!`

### The one free-tier tradeoff, and how it's covered
Render's free web services "sleep" after 15 minutes with no visitors and
take ~30–50 seconds to wake up on the next visit — normal for a free plan
with no card on file. Once awake, everything (including live sync) runs
normally. During a busy service with people using it continuously, it won't
sleep at all.

The data itself lives in a file on the server. It survives sleep/wake just
fine. It only resets if you redeploy the code or Render restarts the
underlying container (rare, but possible on a free plan). To be safe:
- Admin Panel → Settings has **Export Backup** — download it weekly (takes
  two seconds) and keep the file somewhere safe (email it to yourself,
  Google Drive, etc.).
- If data ever does reset, Admin → Settings → **Import Backup** restores it
  from that file instantly.

If this ever outgrows the free tier (busy enough that the sleep delay
becomes annoying), Render's paid tier ($7/mo) removes the sleep behavior —
but you don't need it to get started.

## Running it locally first (optional, to try before deploying)
```
cd server
npm install
npm start
```
Then open `http://localhost:3000` in a browser.

## Project structure
```
server/
  server.js              ← Express + Socket.io API server
  db.js                  ← all business logic + JSON file persistence
  data/data.json          ← the live database (created automatically)
  public/
    index.html            ← landing page (links to Staff / Admin)
    staff/index.html       ← Waiter / Cashier / Kitchen app
    admin/index.html       ← Admin app
    shared/api-client.js   ← connects both apps to the server + live sync
```
