// Renders banner.html to banner.png (1200x600). Run from anywhere: node docs/store/render.mjs [path-to-playwright-core]
import path from "node:path"; import { fileURLToPath, pathToFileURL } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const pw = process.argv[2] ?? "playwright-core";
const { chromium } = await import(pw.startsWith("file:") || !path.isAbsolute(pw) ? pw : pathToFileURL(pw).href);
const b = await chromium.launch({ executablePath: process.env.CHROME ?? path.join(process.env.LOCALAPPDATA ?? "", "ms-playwright", "chromium-1254", "chrome-win64", "chrome.exe") });
const p = await b.newPage({ viewport: { width: 1200, height: 600 } });
await p.goto(pathToFileURL(path.join(here, "banner.html")).href); await p.evaluate(async () => { await document.fonts.load("400 50px 'Work Sans'"); await document.fonts.load("600 20px 'Work Sans'", "₮"); await document.fonts.ready; });
await p.screenshot({ path: path.join(here, "banner.png") }); await b.close(); console.log("banner.png written");
