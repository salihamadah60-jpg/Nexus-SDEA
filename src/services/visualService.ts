import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import puppeteer, { KnownDevices } from "puppeteer-core";
import chromium from "@sparticuz/chromium-min";
import { SANDBOX_BASE } from "../config/backendConstants.js";

export type DeviceProfile = 'mobile' | 'tablet' | 'desktop';

export async function captureVisualSnapshot(
  sessionId: string, 
  targetUrl: string, 
  customFilename?: string,
  profile: DeviceProfile = 'desktop',
  throttling: boolean = false
) {
  const projectPath = path.join(SANDBOX_BASE, sessionId);
  const snapshotDir = path.join(projectPath, ".nexus", "snapshots");
  // ... rest of path logic
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = customFilename || `snapshot-${profile}-${timestamp}.png`;
  const jsonName = (customFilename ? customFilename.replace(".png", "") : `map-${profile}-${timestamp}`) + ".json";
  const fullPath = path.join(snapshotDir, filename);
  const jsonPath = path.join(snapshotDir, jsonName);

  let browser;
  try {
    await fs.mkdir(snapshotDir, { recursive: true });
    // ... chrome path logic
    const isServerless = process.env.NODE_ENV === "production" || !!process.env.VERCEL;
    const candidatePaths = [
      process.env.PUPPETEER_EXECUTABLE_PATH,
      process.env.CHROME_PATH,
      path.join(process.cwd(), ".nexus/browsers/chrome/linux-147.0.7727.57/chrome-linux64/chrome"),
      path.join(process.cwd(), ".nexus/browsers/chrome/linux-147.0.7727.56/chrome-linux64/chrome"),
      path.join(process.env.HOME || "", ".cache/puppeteer/chrome/linux-127.0.6533.88/chrome-linux64/chrome"),
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/snap/bin/chromium",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
    ].filter(Boolean) as string[];

    let executablePath: string | undefined;
    if (isServerless) {
      try { executablePath = await chromium.executablePath(); } catch {}
    } else {
      executablePath = candidatePaths.find(p => existsSync(p));
    }

    if (!executablePath) {
      // Graceful skip: visual inspector is optional, never crash the build pipeline
      console.warn(`[VISUAL INSPECTOR] No Chrome binary found. Skipping visual audit. Searched: ${candidatePaths.length} paths. Set PUPPETEER_EXECUTABLE_PATH or install chromium to enable.`);
      return null;
    }

    browser = await puppeteer.launch({
      args: isServerless ? chromium.args : ["--no-sandbox", "--disable-setuid-sandbox"],
      defaultViewport: profile === 'mobile' ? { width: 390, height: 844, isMobile: true } : 
                      profile === 'tablet' ? { width: 768, height: 1024 } : 
                      { width: 1280, height: 720 },
      executablePath,
      headless: true,
    });

    const page = await browser.newPage();

    // Phase 12.1 — tsx/esbuild injects a __name(fn, "anon") helper around every
    // arrow function. When we ship a closure to page.evaluate the browser side
    // has no __name → ReferenceError. Polyfill it before any navigation runs.
    await page.evaluateOnNewDocument(() => {
      // @ts-ignore
      if (typeof (window as any).__name !== 'function') {
        (window as any).__name = (fn: any) => fn;
      }
    });

    // 1. Device Emulation
    if (profile === 'mobile') {
      await page.emulate(KnownDevices['iPhone 13']);
    } else if (profile === 'tablet') {
      await page.emulate(KnownDevices['iPad Air']);
    }

    // 2. Hardware Throttling Simulation
    if (throttling) {
      const client = await page.target().createCDPSession();
      await client.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: 150, // 3G-ish
        downloadThroughput: 1.6 * 1024 * 1024 / 8, 
        uploadThroughput: 750 * 1024 / 8,
      });
      await client.send('Emulation.setCPUThrottlingRate', { rate: 4 }); // 4x slowdown
    }

    await page.goto(targetUrl, { waitUntil: "networkidle2", timeout: 45000 });
    
    const visualMap = await page.evaluate(() => {
      const elements: any[] = [];
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const issues: { type: string; message: string; severity: 'low' | 'high' }[] = [];
      const pageText = document.body.innerText || "";
      const title = document.title || "";

      // 0. Sovereign Error Detection 
      const errorKeywords = ["Vite Error", "React Error", "Unhandled Runtime Error", "Failed to compile", "TypeError", "is not defined"];
      for (const kw of errorKeywords) {
        if (pageText.includes(kw)) {
          issues.push({ type: 'FRAMEWORK_ERROR', message: `Neural scan detected framework failure: "${kw}" found on page.`, severity: 'high' });
        }
      }
      if (title.includes("404") || pageText.includes("Not Found")) {
        issues.push({ type: 'STATUS_ERROR', message: 'Visual Audit: Target returned 403/404.', severity: 'high' });
      }
      
      // 1. Layout Integrity: Horizontal Overflow detection
      if (document.documentElement.scrollWidth > window.innerWidth) {
        issues.push({ 
          type: 'LAYOUT_INTEGRITY', 
          message: `Viewport breach detected: document body is ${document.documentElement.scrollWidth}px (Viewport: ${window.innerWidth}px)`,
          severity: 'high'
        });
      }

      const all = document.querySelectorAll('div, section, article, nav, header, footer, button, p, h1, h2, h3, a, input, select, textarea');
      
      const getContrastRatio = (c1: string, c2: string) => {
        // Simplified contrast calc for visual audit
        const getLuminance = (rgb: number[]) => {
          const a = rgb.map(v => {
            v /= 255;
            return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
          });
          return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
        };
        const parseRGB = (c: string) => (c.match(/\d+/g) || []).map(Number);
        const l1 = getLuminance(parseRGB(c1));
        const l2 = getLuminance(parseRGB(c2));
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      };

      all.forEach((el: any) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const isHidden = style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0';
        
        if (isHidden) return;
        
        // 2. Contrast Scan (Surgical Logic)
        if (['P', 'H1', 'H2', 'H3', 'A', 'BUTTON', 'SPAN', 'LABEL'].includes(el.tagName)) {
          const fg = style.color;
          const bg = style.backgroundColor === 'rgba(0, 0, 0, 0)' ? 'rgb(255, 255, 255)' : style.backgroundColor;
          const contrast = getContrastRatio(fg, bg);
          if (contrast < 4.5 && rect.width > 0 && rect.height > 0) {
            issues.push({ 
              type: 'CONTRAST_DEFECT', 
              message: `Low contrast ratio (${contrast.toFixed(2)}:1) on <${el.tagName}> "${el.innerText?.slice(0, 20)}"`,
              severity: 'low'
            });
          }
        }

        // 3. Touch Target Audit
        if (['BUTTON', 'A', 'INPUT'].includes(el.tagName)) {
          if (rect.width < 32 || rect.height < 32) {
            issues.push({ 
              type: 'TOUCH_TARGET', 
              message: `Small hit area mapped on <${el.tagName}>: ${rect.width.toFixed(0)}x${rect.height.toFixed(0)}px`,
              severity: 'low'
            });
          }
        }

        elements.push({ tag: el.tagName, id: el.id, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
      });

      return { viewport, elements, issues, auditPassed: issues.filter(i => i.severity === 'high').length === 0 };
    });

    await page.screenshot({ path: fullPath });
    await fs.writeFile(jsonPath, JSON.stringify(visualMap, null, 2));
    return { filename, issues: visualMap.issues };
  } catch (error) {
    console.error(`[VISUAL INSPECTOR ERROR] ${error}`);
    return null;
  } finally { if (browser) await browser.close(); }
}
