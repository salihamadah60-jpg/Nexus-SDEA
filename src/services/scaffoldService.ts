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
 * Sovereign Scaffolding Service
 * Responsible for initial project structure and baseline integrity.
 */
export async function scaffoldProject(sessionId: string, options: ScaffoldOptions) {
  const sandboxPath = path.join(SANDBOX_BASE, sessionId);
  await fs.mkdir(sandboxPath, { recursive: true });

  const files: Record<string, string> = {};

  if (options.template === "react-vite") {
    files["package.json"] = JSON.stringify({
      name: options.projectName || "nexus-project",
      version: "0.0.0",
      private: true,
      type: "module",
      scripts: {
        dev: "vite --host 0.0.0.0",
        build: "tsc && vite build",
        preview: "vite preview"
      },
      dependencies: {
        react: "18.3.1",
        "react-dom": "18.3.1",
        "framer-motion": "11.3.19",
        "lucide-react": "0.363.0",
        "clsx": "2.1.0",
        "tailwind-merge": "2.2.2"
      },
      devDependencies: {
        "@types/react": "^18.2.67",
        "@types/react-dom": "^18.2.22",
        "@vitejs/plugin-react": "^4.2.1",
        "typescript": "~5.2.2",
        "vite": "^5.2.0",
        "tailwindcss": "^3.4.1",
        "autoprefixer": "^10.4.18",
        "postcss": "^8.4.35"
      }
    }, null, 2);

    files["index.html"] = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/vite.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Nexus Sovereign IDE</title>
  </head>
  <body class="bg-black text-white">
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>`;

    files["vite.config.ts"] = `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: Number(process.env.PORT) || 3001,
    strictPort: true,
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

    const projectName = options.projectName || "Nexus Project";
    files["src/App.tsx"] = `import React from 'react';
import { motion } from 'framer-motion';
import { Sparkles, Zap, Shield, Rocket } from 'lucide-react';

const features = [
  { icon: Sparkles, label: 'AI-Native', desc: 'Built with Nexus Sovereign IDE' },
  { icon: Zap,      label: 'Fast',      desc: 'Vite + React 18 hot reload' },
  { icon: Shield,   label: 'Secure',    desc: 'Sandboxed execution by default' },
  { icon: Rocket,   label: 'Deployable',desc: 'One-click publish ready' },
];

export default function App() {
  return (
    <div className="min-h-screen bg-[#030306] text-white font-sans">
      <div className="max-w-5xl mx-auto px-6 py-16">
        <motion.header
          initial={{ opacity: 0, y: -16 }} animate={{ opacity: 1, y: 0 }}
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
            Your application is live. Edit <code className="px-1.5 py-0.5 rounded bg-white/5 text-[#00f2ff] text-sm">src/App.tsx</code> and the page will hot-reload instantly.
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
          Generated by Nexus AI Sovereign Protocol
        </motion.footer>
      </div>
    </div>
  );
}`;

    files["postcss.config.js"] = `export default {
  plugins: { tailwindcss: {}, autoprefixer: {} },
};
`;

    files["tailwind.config.js"] = `/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx,ts,tsx}"],
  theme: { extend: {} },
  plugins: [],
};
`;

    files["src/index.css"] = `@tailwind base;
@tailwind components;
@tailwind utilities;

body {
  @apply bg-[#030306] text-[#e0e0e0] antialiased selection:bg-[#d4af37]/30 selection:text-white;
}

@layer components {
  .nexus-card { @apply bg-[#0a0a0f] border border-[#1a1a2e] shadow-xl; }
  .nexus-btn { @apply px-4 py-2 bg-[#d4af37] text-black font-semibold rounded hover:bg-[#c49f27] transition-all active:scale-95; }
}`;

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

  // Phase 2: Atomic Planning Phase
  const blueprint = {
    title: options.projectName || "Sovereign Project",
    phase: "initialization",
    files: Object.keys(files).reduce((acc, f) => {
      acc[f] = { purpose: "System Scaffold", status: "created", size: files[f].length };
      return acc;
    }, {} as any)
  };

  // Write all files
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(sandboxPath, relPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content);
  }

  // Update blueprint
  await updateBlueprint(blueprint, sessionId);

  return blueprint;
}
