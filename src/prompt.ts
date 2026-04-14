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
 * Ask for a password with masked input (shows "*" per character).
 * Falls back to plain echo if stdin isn't a TTY (e.g. piped input in CI).
 */
export async function askPassword(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    return ask(question);
  }

  process.stdout.write(`${question}: `);

  return new Promise<string>((resolve, reject) => {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let buf = "";
    let settled = false;

    // Always restore terminal state on exit, success or failure.
    const cleanup = () => {
      if (settled) return;
      settled = true;
      try {
        stdin.removeListener("data", onData);
        stdin.removeListener("error", onError);
        stdin.setRawMode(false);
        stdin.pause();
      } catch {
        // Best-effort; don't mask the underlying completion.
      }
    };

    const onData = (data: string) => {
      try {
        for (const ch of data) {
          // Enter — done
          if (ch === "\r" || ch === "\n") {
            process.stdout.write("\n");
            cleanup();
            resolve(buf);
            return;
          }
          // Ctrl-C — abort
          if (ch === "\u0003") {
            process.stdout.write("\n");
            cleanup();
            process.exit(130);
          }
          // Backspace / DEL
          if (ch === "\u0008" || ch === "\u007f") {
            if (buf.length > 0) {
              buf = buf.slice(0, -1);
              process.stdout.write("\b \b");
            }
            continue;
          }
          // Printable
          if (ch >= " ") {
            buf += ch;
            process.stdout.write("*");
          }
        }
      } catch (err) {
        cleanup();
        reject(err);
      }
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    stdin.on("data", onData);
    stdin.on("error", onError);
  });
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
