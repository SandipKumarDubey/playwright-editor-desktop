# Playwright Editor (desktop)

A Windows app for writing Playwright tests in TypeScript (or JavaScript) and running them on your PC.
It opens a real Microsoft Edge or Google Chrome window, so there is no browser to download.

## Get the installer (no tools needed on your PC)
1. Create a GitHub repo and upload everything in this folder (keep the `.github` folder).
2. Open the **Actions** tab, choose **Build Windows installer**, press **Run workflow**.
3. When it finishes, open the run and download the **Playwright-Editor-Setup** artifact (a zip with the `.exe`).

To publish a download page, push a tag instead: `git tag v1.0.0 && git push origin v1.0.0`.
The installer is then attached to a GitHub Release that anyone can download.

## Build it yourself
Needs Node.js 20+:
```
npm install
npm run dist        # installer appears in dist/
npm start           # or just run the app without installing
```

## Using the app
1. Type the website into the URL box (it becomes `baseURL`, so `page.goto('/')` works) or press **Insert goto**.
2. Pick Microsoft Edge or Google Chrome. **Show browser** is on by default, so you can watch the test.
3. Press **Run** (Ctrl+Enter). Output and screenshots appear under the editor.

## Notes
- Windows SmartScreen shows "unrecognized app" for unsigned installers: click **More info**, then **Run anyway**.
  A code-signing certificate (paid) removes the warning.
- Python is not included. For a browser tab version use `npm run server` and open http://localhost:3000.
