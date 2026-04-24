import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const SANDBOX_BASE = path.resolve(process.cwd(), "sandbox", "projects");
export const NEXUS_MD_PATH = path.resolve(process.cwd(), "Nexus.md");
export const BLUEPRINT_FILE = ".nexus_blueprint.json";
