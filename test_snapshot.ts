import puppeteer from 'puppeteer-core';
import fs from 'fs/promises';
import path from 'path';

const SANDBOX_BASE = path.join(process.cwd(), "sandbox", "projects");
const sessionId = "session-1776555466147-92mzow"; // Target Session
const targetUrl = "file://" + path.join(SANDBOX_BASE, sessionId, "index.html");
const customFilename = "live_verify.png";

async function run() {
    const isServerless = process.env.NODE_ENV === "production" || !!process.env.VERCEL;
    
    // Priority Path Matrix
    const paths = [
      path.join(process.cwd(), ".nexus/browsers/chrome/linux-147.0.7727.56/chrome-linux64/chrome"),
      "/root/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome",
      "/root/.cache/puppeteer/chrome/linux-147.0.7727.56/chrome-linux64/chrome",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/google-chrome-stable"
    ];

    const existsSync = (p: string) => {
        try {
            return require('fs').existsSync(p);
        } catch {
            return false;
        }
    };

    const executablePath = paths.find(p => existsSync(p)) || "/usr/bin/google-chrome";
    console.log("Using browser:", executablePath);

    const snapshotsDir = path.join(SANDBOX_BASE, sessionId, ".nexus", "snapshots");
    await fs.mkdir(snapshotsDir, { recursive: true });
    const fullPath = path.join(snapshotsDir, customFilename);

    const browser = await puppeteer.launch({
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
        executablePath,
        headless: true
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 800, height: 600 });

    console.log("Navigating to", targetUrl);
    await page.goto(targetUrl, { waitUntil: "networkidle2", timeout: 15000 });
    
    // Ocular Capture
    await page.screenshot({ path: fullPath });
    console.log("Snapshot saved to", fullPath);

    // Neural Audit Eval
    const audit = await page.evaluate(() => {
        const bodyStyle = window.getComputedStyle(document.body);
        const h1 = document.querySelector('h1');
        const h1Style = h1 ? window.getComputedStyle(h1) : null;
        
        return {
            bg: bodyStyle.backgroundColor,
            textAlign: bodyStyle.textAlign,
            h1Color: h1Style ? h1Style.color : null,
            title: document.title,
            viewport: { w: window.innerWidth, h: window.innerHeight }
        };
    });

    console.log("AUDIT_RESULT:" + JSON.stringify(audit));

    await browser.close();
}

run().catch(err => {
    console.error("[VISUAL INSPECTOR ERROR]", err);
    process.exit(1);
});
