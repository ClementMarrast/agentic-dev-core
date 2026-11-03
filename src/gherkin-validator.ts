/**
 * Validateur de conformité Gherkin pour la QA Gate (Gemini 3.8 Flash)
 */

export interface GherkinScenario {
  title: string;
  given: string[];
  when: string[];
  then: string[];
}

export function parseGherkinScenarios(body: string): GherkinScenario[] {
  const scenarios: GherkinScenario[] = [];
  const lines = body.split("\n");

  let currentScenario: GherkinScenario | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // Détection d'un titre de scénario (ex: "### Scénario 1 : ...", "- [ ] **Scénario 1 :** ...", "- **Scénario 1 : ...**")
    const scenarioMatch = trimmed.match(
      /^(?:###|- \[[ xX]\]|-|\*)\s*(?:\*\*)?(?:Scénario|Scenario)\s*\d*\s*[:\-]\s*(.*?)(?:\*\*)?$/i
    );
    if (scenarioMatch) {
      if (currentScenario) {
        scenarios.push(currentScenario);
      }
      currentScenario = {
        title: scenarioMatch[1].replace(/\*\*$/g, "").trim(),
        given: [],
        when: [],
        then: []
      };
      continue;
    }

    if (!currentScenario) continue;

    // Détection Étant donné / Given
    if (/^[•\-\*]\s*(?:\*\*)?(?:Étant donné|Etant donne|Given)(?:\*\*)?(?:\s|:|$)/iu.test(trimmed)) {
      currentScenario.given.push(
        trimmed.replace(/^[•\-\*]\s*(?:\*\*)?(?:Étant donné|Etant donne|Given)(?:\*\*)?\s*:?\s*/iu, "").trim()
      );
    }
    // Détection Quand / When
    else if (/^[•\-\*]\s*(?:\*\*)?(?:Quand|Lorsque|When)(?:\*\*)?(?:\s|:|$)/iu.test(trimmed)) {
      currentScenario.when.push(
        trimmed.replace(/^[•\-\*]\s*(?:\*\*)?(?:Quand|Lorsque|When)(?:\*\*)?\s*:?\s*/iu, "").trim()
      );
    }
    // Détection Alors / Then
    else if (/^[•\-\*]\s*(?:\*\*)?(?:Alors|Then)(?:\*\*)?(?:\s|:|$)/iu.test(trimmed)) {
      currentScenario.then.push(
        trimmed.replace(/^[•\-\*]\s*(?:\*\*)?(?:Alors|Then)(?:\*\*)?\s*:?\s*/iu, "").trim()
      );
    }
    // Détection Et / And
    else if (/^[•\-\*]\s*(?:\*\*)?(?:Et|And)(?:\*\*)?(?:\s|:|$)/iu.test(trimmed)) {
      const content = trimmed.replace(/^[•\-\*]\s*(?:\*\*)?(?:Et|And)(?:\*\*)?\s*:?\s*/iu, "").trim();
      if (currentScenario.then.length > 0) {
        currentScenario.then.push(content);
      } else if (currentScenario.when.length > 0) {
        currentScenario.when.push(content);
      } else if (currentScenario.given.length > 0) {
        currentScenario.given.push(content);
      }
    }
  }

  if (currentScenario) {
    scenarios.push(currentScenario);
  }

  return scenarios;
}

export function validateGherkinCoverage(scenarios: GherkinScenario[]): { valid: boolean; report: string } {
  if (scenarios.length === 0) {
    return {
      valid: true,
      report: "Aucun bloc explicite Gherkin requis pour ce ticket (spécification standard)."
    };
  }

  const issues: string[] = [];
  for (const sc of scenarios) {
    if (sc.given.length === 0 && sc.when.length === 0 && sc.then.length === 0) {
      issues.push(`Scénario "${sc.title}" ne contient pas d'étapes Given/When/Then valides.`);
    }
  }

  if (issues.length > 0) {
    return {
      valid: false,
      report: `Erreur de conformité Gherkin:\n${issues.map((msg) => `- ${msg}`).join("\n")}`
    };
  }

  return {
    valid: true,
    report: `Conformité Gherkin validée avec succès (${scenarios.length} scénario(s) inspecté(s)).`
  };
}
