import fs from "fs/promises";
import path from "path";
import { SANDBOX_BASE } from "../config/backendConstants.js";
import { updateBlueprint } from "./blueprintService.js";

interface ScaffoldOptions {
  template: "react-vite" | "node-express" | "python" | "static";
  projectName?: string;
  withTailwind?: boolean;
}

/**
 * Sovereign Scaffolding Service v2 — Tailwind v4 + production-grade baseline.
 *
 * Changes from v1:
 *  - Tailwind v4 with @tailwindcss/vite (no postcss.config.js, no tailwind.config.js)
 *  - src/index.css uses "@import 'tailwindcss'" (not @tailwind directives)
 *  - vite.config.ts now imports tailwindcss from "@tailwindcss/vite"
 *  - No strictPort:true — let portService handle conflicts cleanly
 *  - App.tsx scaffold has real structure with Tailwind v4 classes
 */
export async function scaffoldProject(sessionId: string, options: ScaffoldOptions) {
  const sandboxPath = path.join(SANDBOX_BASE, sessionId);
  await fs.mkdir(sandboxPath, { recursive: true });

  const files: Record<string, string> = {};
  const projectName = options.projectName || "Nexus Project";

  if (options.template === "react-vite") {
    files["package.json"] = JSON.stringify({
      name: (options.projectName || "nexus-project").toLowerCase().replace(/\s+/g, "-"),
      version: "0.0.0",
      private: true,
      type: "module",
      scripts: {
        dev: "vite --host 0.0.0.0",
        build: "tsc && vite build",
        preview: "vite preview"
      },
      dependencies: {
        react: "^18.3.1",
        "react-dom": "^18.3.1",
        "framer-motion": "^11.3.19",
        "lucide-react": "^0.363.0",
        "clsx": "^2.1.0",
        "tailwind-merge": "^2.2.2"
      },
      devDependencies: {
        "@types/react": "^18.2.67",
        "@types/react-dom": "^18.2.22",
        "@vitejs/plugin-react": "^4.2.1",
        "typescript": "~5.4.0",
        "vite": "^6.2.0",
        "tailwindcss": "^4.0.0",
        "@tailwindcss/vite": "^4.0.0"
      }
    }, null, 2);

    files["index.html"] = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/vite.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${projectName}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>`;

    // Tailwind v4: uses @tailwindcss/vite plugin — no postcss.config.js needed
    files["vite.config.ts"] = `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '0.0.0.0',
    port: Number(process.env.PORT) || 3001,
    allowedHosts: true,
    hmr: { clientPort: 443 }
  }
});`;

    files["tsconfig.json"] = JSON.stringify({
      compilerOptions: {
        target: "ES2020",
        useDefineForClassFields: true,
        lib: ["ES2020", "DOM", "DOM.Iterable"],
        module: "ESNext",
        skipLibCheck: true,
        moduleResolution: "bundler",
        allowImportingTsExtensions: true,
        resolveJsonModule: true,
        isolatedModules: true,
        noEmit: true,
        jsx: "react-jsx",
        strict: false,
        esModuleInterop: true,
        allowSyntheticDefaultImports: true
      },
      include: ["src"]
    }, null, 2);

    files["src/main.tsx"] = `import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);`;

    // Scaffold App.tsx with a real, visually complete starting point
    files["src/App.tsx"] = `import React from 'react';
import { motion } from 'framer-motion';
import { Sparkles, Zap, Shield, Rocket } from 'lucide-react';

const features = [
  { icon: Sparkles, label: 'AI-Native',   desc: 'Built with Nexus Sovereign IDE' },
  { icon: Zap,      label: 'Fast',        desc: 'Vite + React 18 hot reload'    },
  { icon: Shield,   label: 'Secure',      desc: 'Sandboxed execution'           },
  { icon: Rocket,   label: 'Deployable',  desc: 'One-click publish ready'       },
];

export default function App() {
  return (
    <div className="min-h-screen bg-[#030306] text-white font-sans">
      <div className="max-w-5xl mx-auto px-6 py-16">
        <motion.header
          initial={{ opacity: 0, y: -16 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center mb-12"
        >
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#d4af37]/10 border border-[#d4af37]/30 text-[#d4af37] text-xs font-bold tracking-widest uppercase mb-4">
            <span className="w-1.5 h-1.5 rounded-full bg-[#d4af37] animate-pulse" />
            Live · Sovereign Build
          </div>
          <h1 className="text-5xl md:text-6xl font-extrabold bg-gradient-to-br from-[#d4af37] via-yellow-200 to-[#d4af37] bg-clip-text text-transparent mb-4">
            ${projectName.replace(/[`$]/g, '')}
          </h1>
          <p className="text-[#a0a0b0] text-lg max-w-2xl mx-auto">
            Edit <code className="px-1.5 py-0.5 rounded bg-white/5 text-[#00f2ff] text-sm">src/App.tsx</code> and the page hot-reloads instantly.
          </p>
        </motion.header>

        <motion.div
          initial="hidden" animate="show"
          variants={{ show: { transition: { staggerChildren: 0.08 } } }}
          className="grid grid-cols-1 md:grid-cols-2 gap-4"
        >
          {features.map(({ icon: Icon, label, desc }) => (
            <motion.div
              key={label}
              variants={{ hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0 } }}
              className="group p-6 rounded-2xl bg-[#0a0a0f] border border-[#1a1a2e] hover:border-[#d4af37]/40 transition-all"
            >
              <div className="flex items-start gap-4">
                <div className="p-2.5 rounded-lg bg-[#d4af37]/10 text-[#d4af37] group-hover:scale-110 transition-transform">
                  <Icon size={20} />
                </div>
                <div>
                  <div className="text-base font-bold mb-1">{label}</div>
                  <div className="text-sm text-[#a0a0b0]">{desc}</div>
                </div>
              </div>
            </motion.div>
          ))}
        </motion.div>

        <motion.footer
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.6 }}
          className="mt-16 text-center text-xs text-[#a0a0b0]/40 tracking-widest uppercase"
        >
          Generated by Nexus AI · Sovereign Protocol v8
        </motion.footer>
      </div>
    </div>
  );
}`;

    // Tailwind v4: only @import — no @tailwind directives, no postcss.config.js
    files["src/index.css"] = `@import "tailwindcss";

:root {
  --nexus-gold: #d4af37;
  --nexus-dark: #030306;
  --nexus-panel: #0a0a0f;
  --nexus-border: #1a1a2e;
  --nexus-text: #e0e0e0;
  --nexus-muted: #a0a0b0;
  --nexus-accent: #00f2ff;
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: var(--nexus-dark);
  color: var(--nexus-text);
  -webkit-font-smoothing: antialiased;
}

::selection {
  background: rgba(212, 175, 55, 0.3);
  color: white;
}

.nexus-card {
  background: var(--nexus-panel);
  border: 1px solid var(--nexus-border);
  border-radius: 1rem;
}

.nexus-btn {
  padding: 0.5rem 1rem;
  background: var(--nexus-gold);
  color: #000;
  font-weight: 600;
  border-radius: 0.5rem;
  border: none;
  cursor: pointer;
  transition: all 0.15s;
}
.nexus-btn:hover { background: #c49f27; }
.nexus-btn:active { transform: scale(0.95); }`;

    files[".nexus/workflow.json"] = JSON.stringify({
      version: "1.0",
      protocol: "EXECUTE_WORKFLOW",
      install: "npm install",
      run: "npm run dev",
      port_strategy: "intelligent",
      preferred_port: 3001,
      auto_open_preview: true
    }, null, 2);

    files[".gitignore"] = `node_modules/
dist/
.DS_Store
*.log
.env
.env.local
.nexus/snapshots/
.nexus/cache/`;
  }

  if (options.template === "node-express") {
    files["package.json"] = JSON.stringify({
      name: (options.projectName || "nexus-api").toLowerCase().replace(/\s+/g, "-"),
      version: "0.0.0",
      private: true,
      type: "module",
      scripts: {
        dev: "tsx --watch src/index.ts",
        start: "node dist/index.js",
        build: "tsc"
      },
      dependencies: {
        express: "^4.19.2",
        cors: "^2.8.5"
      },
      devDependencies: {
        tsx: "^4.7.1",
        typescript: "~5.4.0",
        "@types/express": "^4.17.21",
        "@types/cors": "^2.8.17",
        "@types/node": "^22.0.0"
      }
    }, null, 2);

    files["src/index.ts"] = `import express from 'express';
import cors from 'cors';

const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ok', project: '${projectName}', time: new Date().toISOString() });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(\`🚀 ${projectName} API running at http://0.0.0.0:\${PORT}\`);
});`;

    files["tsconfig.json"] = JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        outDir: "dist",
        strict: false,
        esModuleInterop: true,
        skipLibCheck: true
      },
      include: ["src"]
    }, null, 2);

    files[".gitignore"] = `node_modules/\ndist/\n.env\n*.log`;
  }

  if (options.template === "static") {
    files["index.html"] = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${projectName}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { min-height: 100vh; display: flex; align-items: center; justify-content: center;
           background: #030306; color: #e0e0e0; font-family: system-ui, sans-serif; }
    h1 { font-size: 3rem; font-weight: 800; color: #d4af37; text-align: center; }
    p  { color: #a0a0b0; text-align: center; margin-top: 1rem; }
  </style>
</head>
<body>
  <div>
    <h1>${projectName}</h1>
    <p>Edit <code>index.html</code> to get started.</p>
  </div>
</body>
</html>`;
  }

  const blueprint = {
    title: options.projectName || "Sovereign Project",
    phase: "initialization",
    files: Object.keys(files).reduce((acc, f) => {
      acc[f] = { purpose: "System Scaffold", status: "created", size: files[f].length };
      return acc;
    }, {} as any)
  };

  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(sandboxPath, relPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content);
  }

  await updateBlueprint(blueprint, sessionId);
  return blueprint;
}
