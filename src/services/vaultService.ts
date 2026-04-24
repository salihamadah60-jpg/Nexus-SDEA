import fs from "fs/promises";
import path from "path";

const DNA_PATH = path.join(process.cwd(), "dna.json");

interface DNA {
  system_protocols: {
    knowledge_vault: {
      patterns: Array<{
        intent: string;
        response: string;
        confidence: number;
        usage_count: number;
      }>;
      atomic_skills: Record<string, string>;
    };
  };
  lessons_learned: Array<any>;
}

export async function lookupPattern(query: string): Promise<{ response: string; confidence: number } | null> {
  try {
    const dna: DNA = JSON.parse(await fs.readFile(DNA_PATH, "utf-8"));
    const patterns = dna.system_protocols.knowledge_vault.patterns || [];
    
    // Simple keyword matching for "semantic" search simulation
    const queryLower = query.toLowerCase();
    
    let bestMatch: any = null;
    let highestScore = 0;

    for (const p of patterns) {
      if (!p.intent) continue;
      
      const keywords = p.intent.toLowerCase().split(/\s+/);
      let matches = 0;
      for (const kw of keywords) {
        if (queryLower.includes(kw)) matches++;
      }
      
      const score = matches / keywords.length;
      if (score > highestScore) {
        highestScore = score;
        bestMatch = p;
      }
    }

    if (bestMatch && highestScore >= 0.85) {
      console.log(`🧬 DNA Match Found: ${bestMatch.intent} (Score: ${highestScore.toFixed(2)})`);
      return { response: bestMatch.response, confidence: highestScore };
    }
  } catch (err) {
    console.error("Vault lookup error:", err);
  }
  return null;
}

export async function injectLesson(topic: string, lesson: string, success: boolean, intent?: string, response?: string) {
  try {
    const content = await fs.readFile(DNA_PATH, "utf-8");
    const dna: DNA = JSON.parse(content);
    
    if (!dna.lessons_learned) dna.lessons_learned = [];
    
    dna.lessons_learned.push({
      topic,
      lesson,
      implemented: success,
      timestamp: new Date().toISOString()
    });

    // Limit lessons to last 20
    if (dna.lessons_learned.length > 20) {
      dna.lessons_learned = dna.lessons_learned.slice(-20);
    }

    // Phase B/C: If successful and we have an intent/response, inject into vault
    if (success && intent && response) {
      if (!dna.system_protocols.knowledge_vault.patterns) {
        dna.system_protocols.knowledge_vault.patterns = [];
      }
      
      const existing = dna.system_protocols.knowledge_vault.patterns.find(p => p.intent === intent);
      if (existing) {
        existing.usage_count = (existing.usage_count || 0) + 1;
        existing.confidence = Math.min(1.0, existing.confidence + 0.05);
      } else {
        dna.system_protocols.knowledge_vault.patterns.push({
          intent,
          response,
          confidence: 0.85,
          usage_count: 1
        });
      }
    }

    await fs.writeFile(DNA_PATH, JSON.stringify(dna, null, 2));
    console.log(`🧬 DNA Lesson Injected: ${topic}`);
  } catch (err) {
    console.error("Vault injection error:", err);
  }
}

export async function getSkillSet(): Promise<Record<string, string>> {
  try {
    const dna: DNA = JSON.parse(await fs.readFile(DNA_PATH, "utf-8"));
    return dna.system_protocols.knowledge_vault.atomic_skills || {};
  } catch {
    return {};
  }
}
