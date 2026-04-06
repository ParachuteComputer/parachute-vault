/**
 * Simple interactive prompts for CLI setup.
 */

/**
 * Ask a yes/no question. Returns true for yes.
 */
export async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  process.stdout.write(`${question} ${hint} `);

  for await (const line of console) {
    const answer = line.trim().toLowerCase();
    if (answer === "") return defaultYes;
    if (answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
    process.stdout.write(`  Please answer y or n: `);
  }
  return defaultYes;
}

/**
 * Ask for a text input. Returns the trimmed answer, or defaultValue if empty.
 */
export async function ask(question: string, defaultValue = ""): Promise<string> {
  const hint = defaultValue ? ` (${defaultValue})` : "";
  process.stdout.write(`${question}${hint}: `);

  for await (const line of console) {
    const answer = line.trim();
    return answer || defaultValue;
  }
  return defaultValue;
}

/**
 * Ask user to pick from options. Returns the chosen value.
 */
export async function choose(question: string, options: { label: string; value: string; description?: string }[]): Promise<string> {
  console.log(question);
  for (let i = 0; i < options.length; i++) {
    const desc = options[i].description ? ` — ${options[i].description}` : "";
    console.log(`  ${i + 1}) ${options[i].label}${desc}`);
  }
  process.stdout.write(`  Choice [1]: `);

  for await (const line of console) {
    const answer = line.trim();
    if (answer === "") return options[0].value;
    const idx = parseInt(answer, 10) - 1;
    if (idx >= 0 && idx < options.length) return options[idx].value;
    process.stdout.write(`  Please enter 1-${options.length}: `);
  }
  return options[0].value;
}
